import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResumeAgent, applyModelEdits } from '../electron/core/agent';
import { buildFingerprint } from '../electron/core/build-provenance';
import {
  classifyTask,
  resolveModel,
  validateSelection,
  modelEffort,
} from '../electron/core/ai-routing';
import { ConnectionStore, validateConnection } from '../electron/core/connections';
import { WorkspaceStore } from '../electron/core/workspace';
import { ProviderService, requestAPI, type ModelRequest } from '../electron/core/ai-provider';
import {
  emptyWorkspace,
  type AIConnection,
  type AgentInput,
  type PdfInspection,
} from '../src/shared/ai';
import type { Project, BuildResult } from '../src/shared/types';

const image = 'data:image/png;base64,AA==';
const pdf = new Uint8Array(Buffer.from('%PDF-1.4\nfixture'));
const source =
  '\\documentclass{article}\n\\begin{document}\nBuilt accessible tools.\n\\end{document}';
const project = (): Project => ({
  id: 'fast-project',
  name: 'Synthetic',
  mainFile: 'main.tex',
  revision: 0,
  runtime: {
    engine: 'tectonic',
    version: '1',
    bundle: 'fixture',
    id: 'a'.repeat(64),
    platform: 'darwin-arm64',
  },
  files: [{ path: 'main.tex', content: source }],
});
const edit = (search = 'accessible', replacement = 'inclusive') => ({
  message: 'Updated the wording.',
  needsInput: false,
  edits: [{ path: 'main.tex', search, replacement }],
});
const review = { approved: true, issues: [], message: 'All pages are readable.' };
const secretStorage = {
  available: () => true,
  encrypt: (value: string) => Buffer.from(value),
  decrypt: (value: Buffer) => value.toString(),
};
async function root(t: { after(fn: () => Promise<void>): void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-fast-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('routing distinguishes narrow text, source questions and risky requests', () => {
  assert.equal(classifyTask('Replace accessible with inclusive.', 0), 'text');
  assert.equal(classifyTask('Fix the typo in my job title.', 0), 'text');
  assert.equal(classifyTask('Explain what this command does.', 0), 'question');
  for (const request of [
    'Fit this on one page',
    'Improve spacing',
    'Rewrite my resume',
    'Fix the compile error',
    'Make it better',
  ])
    assert.equal(classifyTask(request, 0), 'visual');
  assert.equal(classifyTask('Fix a typo.', 1), 'visual');
  assert.throws(() => validateSelection({ mode: 'manual', model: '' }));
});

test('Auto is provider scoped, manual selection is fixed, and unknown efforts are omitted', () => {
  for (const kind of ['codex', 'claude-code', 'openai', 'anthropic', 'custom'] as const) {
    const profile = validateConnection({
      kind,
      name: 'Fixture',
      model: 'capable',
      baseUrl: 'https://fixture.invalid/v1',
    });
    const models = [
      { id: 'gpt-6-luna', name: 'Luna', images: true },
      { id: 'claude-haiku-4-5', name: 'Haiku', images: true },
    ];
    const fast = resolveModel(profile, { mode: 'auto' }, models, false);
    assert.equal(
      fast.id,
      kind === 'custom'
        ? 'capable'
        : kind === 'claude-code'
          ? 'haiku'
          : kind === 'anthropic'
            ? 'claude-haiku-4-5'
            : 'gpt-6-luna',
    );
    assert.equal(resolveModel(profile, { mode: 'auto' }, models, true).id, 'capable');
    assert.equal(
      resolveModel(profile, { mode: 'manual', model: 'chosen' }, models, true).id,
      'chosen',
    );
    assert.equal(resolveModel(profile, { mode: 'default' }, models, false).id, 'capable');
    assert.equal(
      resolveModel(profile, { mode: 'auto' }, [], false).id,
      kind === 'claude-code' ? 'haiku' : 'capable',
    );
    assert.equal(
      resolveModel(
        { ...profile, autoModels: { fast: 'local-fast' } },
        { mode: 'auto' },
        models,
        false,
      ).id,
      'local-fast',
    );
  }
  assert.equal(modelEffort({ id: 'unknown', name: 'unknown' }, 'low'), undefined);
  assert.equal(modelEffort({ id: 'known', name: 'known', efforts: ['medium'] }, 'high'), 'medium');
});

test('patches apply atomically against original offsets and reject ambiguity, overlap and unsafe paths', () => {
  const p = project();
  const next = applyModelEdits(p, {
    ...edit(),
    edits: [edit().edits[0], { path: 'main.tex', search: 'tools', replacement: 'software' }],
  });
  assert.match(next.project.files[0].content, /inclusive software/);
  assert.equal(next.narrow, true);
  assert.equal(p.files[0].content, source);
  for (const invalid of [
    { ...edit(), edits: [{ path: '../escape.tex', search: 'a', replacement: 'b' }] },
    edit('not present'),
    {
      ...edit(),
      edits: [
        edit().edits[0],
        { path: 'main.tex', search: 'accessible tools', replacement: 'software' },
      ],
    },
    { ...edit(), edits: [edit().edits[0], { path: 'main.tex', content: 'Overwrite' }] },
    { ...edit(), edits: [{ path: 'MAIN.tex', content: 'Collision' }] },
    { ...edit(), needsInput: true },
  ])
    assert.throws(() => applyModelEdits(p, invalid));
  assert.throws(
    () =>
      applyModelEdits(
        { ...p, files: [{ path: 'main.tex', content: source + '\naccessible' }] },
        edit(),
      ),
    /exactly once/,
  );
  assert.equal(applyModelEdits(p, edit('article', 'report')).narrow, false);
  assert.equal(applyModelEdits(p, edit('accessible', '\\Huge inclusive')).narrow, false);
  assert.equal(applyModelEdits(p, edit('accessible', 'x'.repeat(201))).narrow, false);
  assert.equal(
    applyModelEdits(p, { ...edit(), edits: [{ path: 'new.tex', content: 'New file' }] }).narrow,
    false,
  );
});

async function agentFixture(
  t: { after(fn: () => Promise<void>): void },
  options: {
    responses?: unknown[];
    baseline?: boolean;
    provenance?: boolean;
    pageCount?: number;
    overflow?: boolean;
    failBuild?: boolean;
    automatic?: boolean;
    inspect?: () => Promise<PdfInspection>;
    compile?: () => Promise<void>;
  } = {},
) {
  const workspace = new WorkspaceStore(await root(t)),
    p = project(),
    assets = new Map<string, Buffer>();
  const version =
    options.baseline === false
      ? undefined
      : await workspace.checkpoint(
          p,
          pdf,
          'Baseline',
          false,
          options.provenance === false ? undefined : buildFingerprint(p, assets),
        );
  const state = emptyWorkspace(p.id);
  state.messages.push({
    id: 'sent',
    role: 'user',
    runId: 'run',
    text: 'Replace accessible with inclusive.',
    annotationIds: [],
    createdAt: '',
  });
  await workspace.save(state);
  const calls: ModelRequest[] = [],
    builds: Project[] = [],
    routes: { capable: boolean; effort: string }[] = [];
  let renderCount = 0,
    inspections = 0;
  const responses = options.responses?.slice() ?? [edit(), review];
  const agent = new ResumeAgent({
    workspace,
    assets: async () => assets,
    model: async () => ({
      automatic: options.automatic ?? true,
      route: (capable, effort) => {
        routes.push({ capable, effort });
        return { id: capable ? 'capable' : 'fast', name: 'Fixture' };
      },
      complete: async (request) => {
        calls.push(request);
        return responses.shift();
      },
    }),
    compile: async (current) => {
      builds.push(current);
      await options.compile?.();
      return {
        projectId: current.id,
        revision: current.revision,
        status: options.failBuild && builds.length === 1 ? 'error' : 'success',
        pdf,
        diagnostics: [],
        log: options.overflow ? 'Overfull \\hbox' : '',
        durationMs: 1,
        buildFingerprint: buildFingerprint(current, assets),
      } as BuildResult;
    },
    cancelBuild: async () => {},
    inspect: async () => {
      inspections++;
      return options.inspect
        ? options.inspect()
        : { pageCount: inspections === 1 ? 1 : (options.pageCount ?? 1) };
    },
    render: async () => {
      renderCount++;
      return { pages: [{ page: 1, dataUrl: image, text: 'Text' }], notes: [] };
    },
    progress: () => {},
  });
  const input: AgentInput = {
    runId: 'run',
    project: p,
    message: 'Replace accessible with inclusive.',
    annotationIds: [],
    pdfVersionId: version?.id,
  };
  return {
    agent,
    input,
    workspace,
    calls,
    builds,
    routes,
    counts: () => ({ renderCount, inspections }),
  };
}

test('narrow edits use one inference, one compile, no rasterization and retain accurate History metadata', async (t) => {
  const f = await agentFixture(t);
  const result = await f.agent.run(f.input);
  assert.equal(result.status, 'complete');
  assert.equal(f.calls.length, 1);
  assert.equal(f.builds.length, 1);
  assert.equal(f.counts().renderCount, 0);
  assert.equal(result.version?.verified, false);
  assert.equal(result.execution?.validation, 'compiled');
  assert.deepEqual(result.execution?.models, ['fast']);
  assert.deepEqual(JSON.parse(f.calls[0].prompt).conversation, []);
  assert.ok(result.execution!.timings.total! > 0);
  assert.equal((await f.workspace.load(f.input.project.id)).versions.length, 2);
});

test('pagination, overflow, broad edits and missing build provenance force visual review', async (t) => {
  for (const options of [
    { pageCount: 2 },
    { overflow: true },
    { provenance: false },
    { baseline: false },
    {
      responses: [
        {
          ...edit(),
          edits: [{ path: 'main.tex', content: source.replace('accessible', 'inclusive') }],
        },
        review,
      ],
    },
  ]) {
    const f = await agentFixture(t, options);
    const result = await f.agent.run(f.input);
    assert.equal(result.status, 'complete');
    assert.equal(result.version?.verified, true);
    assert.equal(result.execution?.validation, 'visual');
    assert.equal(f.calls.length, 2);
    assert.equal(f.counts().renderCount, 1);
  }
});

test('answers and clarification requests avoid compilation and rendering without a baseline', async (t) => {
  for (const needsInput of [false, true]) {
    const f = await agentFixture(t, {
      baseline: false,
      responses: [{ message: 'Please provide the year.', needsInput, edits: [] }],
    });
    const result = await f.agent.run({ ...f.input, message: 'Explain this source.' });
    assert.equal(result.status, needsInput ? 'needs-input' : 'complete');
    assert.equal(result.project, undefined);
    assert.equal(f.builds.length, 0);
    assert.equal(f.counts().renderCount, 0);
  }
});

test('invalid patches escalate once and repairs remain bounded', async (t) => {
  const f = await agentFixture(t, { responses: [edit('absent'), edit(), review] });
  const result = await f.agent.run(f.input);
  assert.equal(result.status, 'complete');
  assert.equal(result.execution?.escalated, true);
  assert.equal(f.routes[1].capable, true);
  assert.equal(f.routes[1].effort, 'high');
  const failing = await agentFixture(t, {
    responses: [edit('absent'), edit('absent'), edit('absent')],
  });
  const failure = await failing.agent.run(failing.input);
  assert.equal(failure.status, 'error');
  assert.equal(failure.project, undefined);
  assert.equal(failing.calls.length, 3);
  assert.equal(failing.builds.length, 0);
});

test('a failed candidate build escalates and passes diagnostics into the repair', async (t) => {
  const f = await agentFixture(t, {
    failBuild: true,
    responses: [edit(), edit('inclusive', 'usable'), review],
  });
  const result = await f.agent.run(f.input);
  assert.equal(result.status, 'complete');
  assert.equal(result.execution?.escalated, true);
  assert.ok(JSON.parse(f.calls[1].prompt).feedback.buildErrors);
  assert.equal(result.version?.verified, true);
});

test('build identity covers assets and exact compiler identity', () => {
  const p = project(),
    assets = new Map([['logo.png', Buffer.from('one')]]);
  const before = buildFingerprint(p, assets);
  assert.notEqual(before, buildFingerprint(p, new Map([['logo.png', Buffer.from('two')]])));
  assert.notEqual(
    before,
    buildFingerprint({ ...p, runtime: { ...p.runtime!, id: 'b'.repeat(64) } }, assets),
  );
  assert.equal(buildFingerprint({ ...p, runtime: undefined }, assets), undefined);
  assert.equal(
    buildFingerprint(
      { ...p, runtime: { engine: 'tectonic', version: '1', bundle: 'test' } },
      assets,
    ),
    undefined,
  );
});

test('connection migration preserves old manual defaults; new connections start in Auto', async (t) => {
  const directory = await root(t),
    store = new ConnectionStore(directory, secretStorage);
  const saved = await store.save({
    name: 'Custom',
    kind: 'custom',
    model: 'original',
    baseUrl: 'http://127.0.0.1:1',
  });
  const id = saved.connections[0].id;
  assert.equal(saved.connections[0].selection?.mode, 'auto');
  await store.selectModel(id, { mode: 'manual', model: 'picked' });
  assert.equal(
    (await new ConnectionStore(directory, secretStorage).list()).connections[0].selection?.model,
    'picked',
  );
  const disk = JSON.parse(await fs.readFile(path.join(directory, 'ai-connections.json'), 'utf8'));
  delete disk.connections[0].selection;
  await fs.writeFile(path.join(directory, 'ai-connections.json'), JSON.stringify(disk));
  assert.equal((await store.list()).connections[0].selection?.mode, 'default');
});

test('catalogs cache discovery, preserve configured models on failure, and credentials stay captured', async (t) => {
  const directory = await root(t),
    store = new ConnectionStore(directory, secretStorage);
  const saved = await store.save({
    name: 'API',
    kind: 'openai',
    model: 'gpt-6-sol',
    apiKey: 'fixture-one',
  });
  const id = saved.connections[0].id,
    service = new ProviderService(store, path.join(directory, 'requests'));
  t.after(() => service.close());
  const requests: { url: string; options?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    requests.push({ url, options });
    return url.endsWith('/models')
      ? Response.json({ data: [{ id: 'gpt-6-luna' }, { id: 'gpt-6-sol' }] })
      : Response.json({
          status: 'completed',
          model: 'gpt-6-luna',
          output_text: '{"message":"ok"}',
        });
  });
  await service.catalog(id);
  await service.catalog(id);
  assert.equal(requests.length, 1);
  const model = await service.model(id, { mode: 'auto' });
  model.route!(false, 'low', false);
  await store.save({ ...saved.connections[0], apiKey: 'fixture-two' });
  await model.complete(
    { system: '', prompt: '', images: [], schema: {} },
    new AbortController().signal,
  );
  assert.equal(
    new Headers(requests.at(-1)!.options!.headers).get('Authorization'),
    'Bearer fixture-one',
  );
  const body = JSON.parse(requests.at(-1)!.options!.body as string);
  assert.equal(body.model, 'gpt-6-luna');
  assert.deepEqual(body.reasoning, { effort: 'low' });
  t.mock.method(globalThis, 'fetch', async () => new Response('Unavailable', { status: 503 }));
  await service.invalidate();
  const fallback = await service.catalog(id);
  assert.match(fallback.warning!, /unavailable/);
  assert.ok(fallback.models.some((m) => m.id === 'gpt-6-sol'));
});

test('provider errors do not become Auto model changes or edit retries', async (t) => {
  const f = await agentFixture(t);
  let calls = 0;
  f.agent.dependencies.model = async () => ({
    automatic: true,
    complete: async () => {
      calls++;
      throw new Error('Usage limit reached.');
    },
  });
  const result = await f.agent.run(f.input);
  assert.equal(result.status, 'error');
  assert.equal(calls, 1);
  assert.equal(result.execution?.escalated, false);
});

test('cancellation during metadata validation never creates or applies a candidate version', async (t) => {
  let release!: () => void, inspected!: () => void;
  const entered = new Promise<void>((resolve) => {
    inspected = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await agentFixture(t, {
    inspect: async () => {
      inspected();
      await wait;
      return { pageCount: 1 };
    },
  });
  const running = f.agent.run(f.input);
  await entered;
  const stopped = f.agent.cancel('run');
  release();
  await stopped;
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.project, undefined);
  assert.equal((await f.workspace.load(f.input.project.id)).versions.length, 1);
});

test('effort parameters are translated for all three API formats and omitted when unknown', async (t) => {
  for (const format of ['responses', 'chat-completions', 'anthropic'] as const) {
    let body: any;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
      body = JSON.parse(options.body as string);
      return Response.json(
        format === 'responses'
          ? { output_text: '{}' }
          : format === 'anthropic'
            ? { content: [{ type: 'text', text: '{}' }] }
            : { choices: [{ finish_reason: 'stop', message: { content: '{}' } }] },
      );
    });
    const profile: AIConnection = {
      ...validateConnection({
        name: 'Fixture',
        kind: 'custom',
        model: 'test',
        format,
        baseUrl: 'https://fixture.invalid',
      }),
    };
    await requestAPI(
      { profile },
      { system: '', prompt: '', images: [], schema: {}, effort: 'low', maxOutputTokens: 2000 },
      new AbortController().signal,
    );
    assert.equal(
      format === 'responses'
        ? body.reasoning.effort
        : format === 'anthropic'
          ? body.output_config.effort
          : body.reasoning_effort,
      'low',
    );
    await requestAPI(
      { profile },
      { system: '', prompt: '', images: [], schema: {} },
      new AbortController().signal,
    );
    assert.equal(body.reasoning ?? body.output_config ?? body.reasoning_effort, undefined);
  }
});

test('Codex reuses a process, starts isolated threads, caches run setup and closes on cancellation', async (t) => {
  const directory = await root(t),
    executable = path.join(directory, 'codex-fixture'),
    trace = path.join(directory, 'trace.jsonl');
  await fs.writeFile(
    executable,
    `#!${process.execPath}\nconst fs=require('node:fs');const trace=${JSON.stringify(trace)};fs.appendFileSync(trace,JSON.stringify({event:'spawn',pid:process.pid})+'\\n');let n=0;require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(trace,line+'\\n');if(!m.id)return;let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};if(m.method==='config/read')result={config:{mcp_servers:{}}};if(m.method==='model/list')result={data:[{model:'gpt-6-luna',displayName:'Luna',inputModalities:['text','image'],supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};if(m.method==='thread/start')result={thread:{id:'thread-'+(++n),model:'gpt-6-luna'}};if(m.method==='mcpServerStatus/list')result={data:[],nextCursor:null};if(m.method==='turn/start')result={turn:{id:'turn-'+n}};console.log(JSON.stringify({id:m.id,result}));if(m.method==='turn/start'&&m.params.input[0].text!=='hold'){console.log(JSON.stringify({method:'item/completed',params:{threadId:m.params.threadId,item:{type:'agentMessage',text:'{"message":"ok"}'}}}));console.log(JSON.stringify({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'turn-'+n,status:'completed'}}}));}});`,
    { mode: 0o700 },
  );
  const store = new ConnectionStore(directory, secretStorage);
  const saved = await store.save({ name: 'Codex', kind: 'codex', model: 'gpt-6-luna', executable });
  const service = new ProviderService(store, path.join(directory, 'sessions'));
  t.after(() => service.close());
  const signal = new AbortController();
  const model = await service.model(saved.connections[0].id, { mode: 'auto' }, signal.signal);
  model.route!(false, 'low', false);
  const request = { system: 'Fixture', prompt: 'Go', images: [], schema: {} };
  await model.complete(request, signal.signal);
  await model.complete(request, signal.signal);
  const calls = (await fs.readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  assert.equal(calls.filter((c) => c.event === 'spawn').length, 1);
  assert.equal(calls.filter((c) => c.method === 'account/read').length, 1);
  const threads = calls.filter((c) => c.method === 'thread/start');
  assert.equal(threads.length, 2);
  assert.ok(
    threads.every(
      (t) =>
        t.params.ephemeral &&
        t.params.sandbox === 'read-only' &&
        t.params.config.features.shell_tool === false,
    ),
  );
  assert.equal(calls.filter((c) => c.method === 'mcpServerStatus/list').length, 2);
  assert.equal(calls.find((c) => c.method === 'turn/start').params.effort, 'low');
  const held = model.complete({ ...request, prompt: 'hold' }, signal.signal);
  await new Promise((resolve) => setTimeout(resolve, 30));
  signal.abort();
  await assert.rejects(held);
  await model.close!();
  assert.deepEqual(await fs.readdir(path.join(directory, 'sessions')), []);
  const again = await service.model(saved.connections[0].id, { mode: 'default' });
  await again.complete(request, new AbortController().signal);
  await service.close();
  assert.deepEqual(await fs.readdir(path.join(directory, 'sessions')), []);
});

test('image support is specific to the chosen model and manual choice never silently changes', async (t) => {
  const directory = await root(t),
    store = new ConnectionStore(directory, secretStorage);
  const saved = await store.save({
    name: 'API',
    kind: 'custom',
    format: 'anthropic',
    baseUrl: 'https://fixture.invalid/v1',
    model: 'vision',
    autoModels: { fast: 'text-only', capable: 'vision' },
  });
  const service = new ProviderService(store, path.join(directory, 'requests'));
  t.after(() => service.close());
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      data: [
        { id: 'text-only', capabilities: { image_input: { supported: false } } },
        { id: 'vision', capabilities: { image_input: { supported: true } } },
      ],
    }),
  );
  const id = saved.connections[0].id;
  const auto = await service.model(id, { mode: 'auto' });
  assert.equal(auto.route!(false, 'low', false).id, 'text-only');
  assert.equal(auto.route!(false, 'low', true).id, 'vision');
  const manual = await service.model(id, { mode: 'manual', model: 'text-only' });
  assert.throws(() => manual.route!(true, 'medium', true), /cannot read PDF images/);
  assert.equal(manual.route!(true, 'high', false).id, 'text-only');
});

test('cancellation interrupts model discovery without waiting for the discovery timeout', async (t) => {
  const directory = await root(t),
    store = new ConnectionStore(directory, secretStorage);
  const saved = await store.save({
    name: 'API',
    kind: 'custom',
    baseUrl: 'https://fixture.invalid/v1',
    model: 'fixture',
  });
  const service = new ProviderService(store, path.join(directory, 'requests'));
  t.after(() => service.close());
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options: RequestInit) =>
      new Promise((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
        entered();
      }),
  );
  const signal = new AbortController();
  const pending = service.model(saved.connections[0].id, { mode: 'auto' }, signal.signal);
  await started;
  signal.abort();
  await assert.rejects(pending);
});

test('render cache reuses exact PDF/annotation content and is cleared when changing projects', async (t) => {
  const f = await agentFixture(t, { responses: [edit(), review, edit(), review, edit(), review] });
  const visualInput = { ...f.input, message: 'Review the PDF and improve wording.' };
  assert.equal((await f.agent.run(visualInput)).status, 'complete');
  const first = f.counts().renderCount;
  assert.equal((await f.agent.run({ ...visualInput, runId: 'run-2' })).status, 'complete');
  assert.equal(f.counts().renderCount, first);
  const other = { ...project(), id: 'another-project' };
  assert.equal(
    (await f.agent.run({ ...visualInput, runId: 'run-3', project: other, pdfVersionId: undefined }))
      .status,
    'complete',
  );
  assert.ok(f.counts().renderCount > first);
});
