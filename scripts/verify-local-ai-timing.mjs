// Bounded, read-only verifier for a completed `npm run test:chat` result
// directory (PERF-05 reproducibility). It re-derives the per-message agent
// timing metadata that `electron/core/agent.ts` already records into each
// workspace's `state.json`, deduplicates messages that Save As copies across
// multiple workspace directories, and checks that every recorded timing is
// well formed before emitting a deterministic JSON summary.
//
// This never contacts a provider, reads credentials, or changes chat
// behavior: it only re-validates bytes the chat test already wrote to disk.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KNOWN_STAGES = ['setup', 'inference', 'compile', 'render', 'inspect', 'review'];
const TIMING_KEYS = [...KNOWN_STAGES, 'total'];
const VALID_STATUSES = ['complete', 'error', 'cancelled'];
const VALID_VALIDATIONS = ['compiled', 'visual'];
const SAFE_ID = /^[a-zA-Z0-9_-]{1,100}$/;
// The chat fixture server only ever advertises `fixture-*` model ids (see
// scripts/test-chat.mjs). Anything else would mean this directory captured
// real provider traffic, which PERF-05 explicitly must not be conflated with.
const FIXTURE_MODEL = /^fixture-[a-z0-9-]{1,120}$/i;
const EPSILON = 1e-6;

class LocalAiTimingError extends Error {}

function fail(message) {
  throw new LocalAiTimingError(message);
}

function round(value) {
  return Math.round(value * 1e4) / 1e4;
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function finiteNonNegative(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    fail(`${label} must be a finite non-negative number.`);
  return value;
}

function validateExecution(raw, messageId) {
  if (!raw || typeof raw !== 'object')
    fail(`message ${messageId} has an invalid execution record.`);
  if (!Array.isArray(raw.models) || raw.models.length === 0 || raw.models.length > 12)
    fail(`message ${messageId} execution.models must be a non-empty array of at most 12 entries.`);
  for (const model of raw.models) {
    if (typeof model !== 'string' || !FIXTURE_MODEL.test(model))
      fail(
        `message ${messageId} references model "${model}", which is not a recognized local ` +
          'scripted-provider fixture id; local timing evidence must stay scoped to the fixture.',
      );
  }
  if (raw.escalated !== undefined && typeof raw.escalated !== 'boolean')
    fail(`message ${messageId} execution.escalated must be a boolean.`);
  if (raw.validation !== undefined && !VALID_VALIDATIONS.includes(raw.validation))
    fail(`message ${messageId} execution.validation must be "compiled" or "visual".`);
  if (!raw.timings || typeof raw.timings !== 'object')
    fail(`message ${messageId} is missing execution.timings.`);
  const unknownKeys = Object.keys(raw.timings).filter((key) => !TIMING_KEYS.includes(key));
  if (unknownKeys.length)
    fail(`message ${messageId} has unknown timing stage(s): ${unknownKeys.join(', ')}.`);
  const timings = {};
  for (const key of TIMING_KEYS) {
    if (raw.timings[key] === undefined) continue;
    timings[key] = finiteNonNegative(raw.timings[key], `message ${messageId} timings.${key}`);
  }
  if (timings.total === undefined)
    fail(`message ${messageId} execution.timings.total is required to check stage coverage.`);
  const knownStageMs = KNOWN_STAGES.reduce((sum, key) => sum + (timings[key] ?? 0), 0);
  const uninstrumentedMs = timings.total - knownStageMs;
  if (uninstrumentedMs < -EPSILON)
    fail(
      `message ${messageId} total (${timings.total}ms) understates its recorded stages ` +
        `(${knownStageMs}ms); instrumentation is inconsistent.`,
    );
  return {
    models: [...raw.models].sort(),
    escalated: raw.escalated === true,
    validation: raw.validation,
    timings,
    knownStageMs,
    uninstrumentedMs: Math.max(0, uninstrumentedMs),
  };
}

function validateMessage(raw, workspaceId) {
  if (!raw || typeof raw !== 'object')
    fail(`workspace ${workspaceId} contains a non-object message.`);
  if (typeof raw.id !== 'string' || !SAFE_ID.test(raw.id))
    fail(`workspace ${workspaceId} has a message with an invalid id.`);
  if (typeof raw.createdAt !== 'string' || !raw.createdAt)
    fail(`message ${raw.id} has an invalid createdAt.`);
  if (raw.status !== undefined && !VALID_STATUSES.includes(raw.status))
    fail(`message ${raw.id} has an invalid status "${raw.status}".`);
  return raw;
}

function validateWorkspaceState(raw, workspaceId) {
  if (!raw || typeof raw !== 'object')
    fail(`workspace ${workspaceId} state.json is not an object.`);
  if (raw.schemaVersion !== 1)
    fail(`workspace ${workspaceId} has unsupported schemaVersion ${raw.schemaVersion}.`);
  if (typeof raw.projectId !== 'string' || !SAFE_ID.test(raw.projectId))
    fail(`workspace ${workspaceId} has an invalid projectId.`);
  if (raw.projectId !== workspaceId)
    fail(
      `workspace ${workspaceId} projectId "${raw.projectId}" does not match its directory name.`,
    );
  if (!Array.isArray(raw.messages) || raw.messages.length > 2000)
    fail(`workspace ${workspaceId} has an invalid messages array.`);
  return raw.messages.map((message) => validateMessage(message, workspaceId));
}

// Save As duplicates the full workspace archive (state.json included) into a
// new project id, so the same chat message id and execution payload can
// legitimately appear verbatim under multiple workspace directories. Collapse
// those into a single deterministic record and treat any byte-level
// disagreement between copies of the same message id as damaged fixture data.
function deduplicateMessages(perWorkspaceMessages) {
  const index = new Map();
  for (const { workspaceId, messages } of perWorkspaceMessages) {
    for (const message of messages) {
      const key = canonicalJSON(message);
      const existing = index.get(message.id);
      if (!existing) {
        index.set(message.id, { message, canonicalKey: key, workspaceIds: new Set([workspaceId]) });
        continue;
      }
      if (existing.canonicalKey !== key)
        fail(
          `message ${message.id} differs between copied workspace states ` +
            `${[...existing.workspaceIds].sort()[0]} and ${workspaceId}; copied workspace ` +
            'states must be byte-identical for a shared message.',
        );
      existing.workspaceIds.add(workspaceId);
    }
  }
  return index;
}

function workspaceRelationships(perWorkspaceMessages) {
  const idsByWorkspace = perWorkspaceMessages.map(({ workspaceId, messages }) => [
    workspaceId,
    new Set(messages.map((m) => m.id)),
  ]);
  const relationships = [];
  for (let i = 0; i < idsByWorkspace.length; i++) {
    for (let j = i + 1; j < idsByWorkspace.length; j++) {
      const [aId, a] = idsByWorkspace[i];
      const [bId, b] = idsByWorkspace[j];
      const shared = [...a].filter((id) => b.has(id)).length;
      if (shared === 0) continue;
      const relation =
        shared === a.size && shared === b.size
          ? 'identical'
          : shared === Math.min(a.size, b.size)
            ? 'subset'
            : 'partial-overlap';
      relationships.push({ workspaces: [aId, bId].sort(), sharedMessages: shared, relation });
    }
  }
  return relationships.sort((x, y) =>
    x.workspaces[0] === y.workspaces[0]
      ? x.workspaces[1] < y.workspaces[1]
        ? -1
        : 1
      : x.workspaces[0] < y.workspaces[0]
        ? -1
        : 1,
  );
}

/**
 * Verify a completed `npm run test:chat` result directory and produce a
 * deterministic JSON summary of its recorded AI-journey timings, suitable as
 * PERF-05 release-record evidence. Throws on malformed or inconsistent state.
 */
export async function verifyLocalAiTiming(directory) {
  const root = path.resolve(directory);
  const rootStat = await fs.stat(root).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) fail(`"${directory}" is not a directory.`);
  const workspacesRoot = path.join(root, 'app-data', 'workspaces');
  const workspacesStat = await fs.stat(workspacesRoot).catch(() => null);
  if (!workspacesStat || !workspacesStat.isDirectory())
    fail(
      `"${directory}" does not contain app-data/workspaces; provide a completed ` +
        '`npm run test:chat` result directory.',
    );
  const workspaceIds = (await fs.readdir(workspacesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (workspaceIds.length === 0) fail(`"${directory}" has no saved workspace states.`);

  const perWorkspaceMessages = [];
  const workspaceRecords = [];
  for (const workspaceId of workspaceIds) {
    if (!SAFE_ID.test(workspaceId))
      fail(`workspace directory name "${workspaceId}" is not a valid id.`);
    const statePath = path.join(workspacesRoot, workspaceId, 'state.json');
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(statePath, 'utf8'));
    } catch (error) {
      fail(`workspace ${workspaceId} state.json could not be read or parsed: ${error.message}`);
    }
    const messages = validateWorkspaceState(raw, workspaceId);
    perWorkspaceMessages.push({ workspaceId, messages });
    workspaceRecords.push({
      id: workspaceId,
      messageCount: messages.length,
      executionCount: messages.filter((m) => m.execution).length,
    });
  }

  const deduplicated = deduplicateMessages(perWorkspaceMessages);
  const executions = [];
  for (const { message, workspaceIds: ids } of deduplicated.values()) {
    if (!message.execution) continue;
    const validated = validateExecution(message.execution, message.id);
    executions.push({
      id: message.id,
      createdAt: message.createdAt,
      status: message.status ?? null,
      workspaceIds: [...ids].sort(),
      ...validated,
    });
  }
  if (executions.length === 0)
    fail(`"${directory}" has no recorded AI execution timings across its saved workspaces.`);
  executions.sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
  );

  const stageTotals = Object.fromEntries(
    KNOWN_STAGES.map((stage) => [stage, { count: 0, sumMs: 0 }]),
  );
  let sumTotalMs = 0,
    sumKnownStageMs = 0,
    sumUninstrumentedMs = 0;
  for (const execution of executions) {
    sumTotalMs += execution.timings.total;
    sumKnownStageMs += execution.knownStageMs;
    sumUninstrumentedMs += execution.uninstrumentedMs;
    for (const stage of KNOWN_STAGES) {
      if (execution.timings[stage] === undefined) continue;
      stageTotals[stage].count += 1;
      stageTotals[stage].sumMs += execution.timings[stage];
    }
  }

  return {
    schemaVersion: 1,
    evidenceKind: 'local-scripted-provider-fixture',
    scope:
      'Deduplicated per-message agent timing metadata extracted from a completed `npm run ' +
      'test:chat` result directory. Every model id matched the local scripted-provider fixture ' +
      'pattern; this is not a network or live-provider measurement.',
    sourceDirectory: path.basename(root),
    workspaces: workspaceRecords,
    workspaceRelationships: workspaceRelationships(perWorkspaceMessages),
    executionCount: executions.length,
    executions: executions.map((execution) => ({
      id: execution.id,
      createdAt: execution.createdAt,
      status: execution.status,
      validation: execution.validation ?? null,
      models: execution.models,
      escalated: execution.escalated,
      workspaceIds: execution.workspaceIds,
      timings: execution.timings,
      knownStageMs: round(execution.knownStageMs),
      uninstrumentedMs: round(execution.uninstrumentedMs),
    })),
    stageTotals: Object.fromEntries(
      KNOWN_STAGES.map((stage) => [
        stage,
        { count: stageTotals[stage].count, sumMs: round(stageTotals[stage].sumMs) },
      ]),
    ),
    totals: {
      sumTotalMs: round(sumTotalMs),
      sumKnownStageMs: round(sumKnownStageMs),
      sumUninstrumentedMs: round(sumUninstrumentedMs),
    },
    limits: [
      'Provider responses originate from the deterministic local test-chat fixture server, not ' +
        'a real OpenAI, Anthropic, compatible-endpoint, Codex or Claude account.',
      'Uninstrumented per-execution time is attributed to documented checkpoint/apply work ' +
        'outside the measured setup/inference/compile/render/inspect/review stages, not a ' +
        'separate measured stage.',
      'Deduplication assumes identical message ids carry byte-identical execution payloads ' +
        'across copied workspace states (e.g. Save As); a mismatch is treated as damaged ' +
        'fixture data.',
    ],
  };
}

async function main() {
  const [directoryArg, outputArg, ...extra] = process.argv.slice(2);
  if (!directoryArg || extra.length)
    throw new Error(
      'Usage: node scripts/verify-local-ai-timing.mjs <chat-test-result-directory> [output-file]',
    );
  const summary = await verifyLocalAiTiming(directoryArg);
  const json = JSON.stringify(summary, null, 2) + '\n';
  if (outputArg) await fs.writeFile(path.resolve(outputArg), json);
  console.log(json);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
