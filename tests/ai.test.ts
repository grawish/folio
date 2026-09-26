import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  ConnectionStore,
  validateConnection,
  type SecretStorage,
} from '../electron/core/connections';
import { WorkspaceStore, validateAnnotation } from '../electron/core/workspace';
import { ResumeAgent, applyModelEdits, validateRenderedPdf } from '../electron/core/agent';
import { CodexRPC, childEnvironment } from '../electron/core/ai-process';
import { requestClaude, requestCodex, type ModelRequest } from '../electron/core/ai-provider';
import { emptyWorkspace, type AgentProgress } from '../src/shared/ai';
import type { Project } from '../src/shared/types';
import { ProjectStore, fingerprint } from '../electron/core/project';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

const pdf = new Uint8Array(Buffer.from('%PDF-1.4\nfixture'));
const image = 'data:image/png;base64,AA==';
const project = (): Project => ({
  id: 'test-resume',
  name: 'Resume',
  revision: 0,
  mainFile: 'main.tex',
  files: [{ path: 'main.tex', content: 'Original facts' }],
});
const encryptionKey = randomBytes(32);
const storage: SecretStorage = {
  available: () => true,
  encrypt: (value) => {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  },
  decrypt: (value) => {
    const cipher = createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString();
  },
};
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-ai-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('connections protect keys, require explicit selection, survive a failed update, and remove secrets', async (t) => {
  const root = await fixture(t),
    store = new ConnectionStore(root, storage);
  const settings = await store.save({
    name: 'My API',
    kind: 'openai',
    model: 'test-vision-model',
    apiKey: 'only-a-test-secret',
  });
  const connection = settings.connections[0];
  assert.equal(settings.activeId, null);
  assert.equal(connection.hasKey, true);
  assert.ok(!JSON.stringify(settings).includes('only-a-test-secret'));
  assert.ok(
    !(await fs.readFile(path.join(root, 'ai-connections.json'), 'utf8')).includes(
      'only-a-test-secret',
    ),
  );
  await assert.rejects(store.get(), /Choose an AI connection/);
  await store.select(connection.id);
  assert.equal((await store.get()).apiKey, 'only-a-test-secret');
  await assert.rejects(store.save({ ...connection, model: '' }), /model/);
  assert.equal((await store.list()).activeId, connection.id);
  const checked = await store.get();
  await store.verified(connection.id, checked.revision);
  assert.equal((await store.list()).connections[0].vision, 'verified');
  await store.save({ ...connection, model: 'another-model' });
  await assert.rejects(store.verified(connection.id, checked.revision), /changed during/);
  assert.equal((await store.list()).connections[0].vision, 'unknown');
  await store.remove(connection.id);
  assert.equal((await store.list()).activeId, null);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(root, 'ai-connections.json'), 'utf8')).secrets,
    {},
  );
});
test('unavailable encryption and unsafe endpoint URLs fail without storing a key', async (t) => {
  const root = await fixture(t),
    store = new ConnectionStore(root, { ...storage, available: () => false });
  await assert.rejects(
    store.save({ name: 'Test', kind: 'openai', model: 'vision', apiKey: 'secret' }),
    /Protected credential storage/,
  );
  assert.deepEqual((await store.list()).connections, []);
  for (const baseUrl of [
    'http://example.com/v1',
    'https://key:secret@example.com',
    'file:///tmp/api',
    'https://example.com?key=secret',
  ])
    assert.throws(() =>
      validateConnection({ name: 'Custom', kind: 'custom', model: 'vision', baseUrl }),
    );
  assert.equal(
    validateConnection({
      name: 'Local',
      kind: 'custom',
      model: 'vision',
      baseUrl: 'http://127.0.0.1:5000/v1/',
    }).baseUrl,
    'http://127.0.0.1:5000/v1',
  );
  assert.throws(
    () => validateConnection({ name: 'Subscription', kind: 'codex', model: '', apiKey: 'secret' }),
    /own sign-in/,
  );
});
test('workspace serial saves preserve immutable source/PDF versions, notes, drafts and archives', async (t) => {
  const root = await fixture(t),
    store = new WorkspaceStore(root),
    p = project();
  p.removedFiles = [
    {
      id: 'removed-copy',
      path: 'notes.txt',
      content: 'Earlier draft',
      removedAt: new Date().toISOString(),
      reason: 'removed',
    },
  ];
  const version = await store.checkpoint(p, pdf, 'Before change');
  const firstArchive = unzipSync(await store.archive(p.id));
  assert.equal(
    JSON.parse(strFromU8(firstArchive[`versions/${version.id}/source.json`])).removedFiles,
    undefined,
  );
  assert.equal(p.removedFiles.length, 1);
  const state = emptyWorkspace(p.id);
  state.draft = 'Change this area';
  state.annotations.push({
    id: 'note-one',
    versionId: version.id,
    page: 1,
    kind: 'rectangle',
    rect: { x: 0.2, y: 0.3, width: 0.4, height: 0.1 },
    text: 'Make this clearer',
    createdAt: new Date().toISOString(),
  });
  state.attachedNoteIds = ['note-one'];
  state.messages.push({
    id: 'sent-note',
    role: 'user',
    text: 'Apply this feedback',
    createdAt: new Date().toISOString(),
    annotationIds: ['note-one'],
    annotationSnapshot: structuredClone(state.annotations),
  });
  const changed = { ...p, revision: 1, files: [{ path: 'main.tex', content: 'Updated facts' }] };
  await Promise.all([
    store.save(state),
    store.checkpoint(changed, pdf, 'Changed', true),
    store.save({ ...state, draft: 'New draft' }),
  ]);
  const current = await store.load(p.id);
  assert.equal(current.versions.length, 2);
  assert.equal(current.draft, 'New draft');
  assert.equal((await store.version(p.id, version.id)).files[0].content, 'Original facts');
  assert.deepEqual((await store.version(p.id, version.id)).pdf, pdf);
  assert.equal(current.annotations[0].versionId, version.id);
  const directory = path.join(root, 'export');
  await fs.mkdir(directory);
  await store.exportTo(p.id, directory);
  const imported = new WorkspaceStore(path.join(root, 'other'));
  await imported.importFrom('copy-id', directory);
  assert.equal((await imported.load('copy-id')).versions.length, 2);
  assert.equal((await imported.load('copy-id')).draft, 'New draft');
  await store.save({ ...current, annotations: [] });
  assert.equal(
    (await store.load(p.id)).messages[0].annotationSnapshot?.[0].text,
    'Make this clearer',
  );
  await store.clone(p.id, 'branch-id');
  await store.save({ ...(await store.load('branch-id')), draft: 'Independent branch' });
  assert.equal((await store.load(p.id)).draft, 'New draft');
});
test('workspace rejects off-page notes and mismatched archive source before writing state', async (t) => {
  const root = await fixture(t),
    store = new WorkspaceStore(root),
    p = project();
  assert.throws(
    () =>
      validateAnnotation({
        id: 'note',
        versionId: 'v',
        page: 1,
        kind: 'rectangle',
        rect: { x: 0.9, y: 0.2, width: 0.2, height: 0.1 },
        text: '',
        createdAt: '',
      }),
    /outside/,
  );
  const version = await store.checkpoint(p, pdf);
  const archive = unzipSync(await store.archive(p.id));
  const source = JSON.parse(strFromU8(archive[`versions/${version.id}/source.json`]));
  source.files[0].content = 'Tampered';
  archive[`versions/${version.id}/source.json`] = strToU8(JSON.stringify(source));
  const directory = path.join(root, 'import');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'resume.folio'), zipSync(archive));
  const other = new WorkspaceStore(path.join(root, 'fresh'));
  await assert.rejects(other.importFrom(p.id, directory), /does not match/);
  assert.deepEqual(await other.load(p.id), emptyWorkspace(p.id));
});
test('changed PDF bytes create a new immutable version even when source is unchanged', async (t) => {
  const root = await fixture(t),
    store = new WorkspaceStore(root),
    p = project();
  const first = await store.checkpoint(p, pdf);
  const same = await store.checkpoint(p, pdf);
  assert.equal(same.id, first.id);
  const secondPdf = new Uint8Array(Buffer.from('%PDF-1.4\nchanged asset or runtime'));
  const changed = await store.checkpoint(p, secondPdf);
  assert.notEqual(changed.id, first.id);
  assert.deepEqual((await store.version(p.id, first.id)).pdf, pdf);
  await fs.writeFile(
    path.join(root, 'workspaces', p.id, 'versions', changed.id, 'resume.pdf'),
    pdf,
  );
  await assert.rejects(store.version(p.id, changed.id), /damaged/);
});
test('Save As gives the copied project its own stable identity while retaining original registration', async (t) => {
  const root = await fixture(t),
    store = new ProjectStore(root),
    p = project();
  const first = path.join(root, 'first'),
    second = path.join(root, 'second');
  await fs.mkdir(first);
  await fs.mkdir(second);
  await store.save(p, first);
  const saved = await store.save(p, second);
  assert.notEqual(saved.projectId, p.id);
  assert.equal(store.directory(p.id), await fs.realpath(first));
  assert.equal(store.directory(saved.projectId!), await fs.realpath(second));
  assert.equal((await new ProjectStore(root).open(second)).id, saved.projectId);
});
test('AI edits cannot escape the project, collide by case, or apply when facts are missing', () => {
  assert.throws(() =>
    applyModelEdits(project(), {
      message: '',
      needsInput: false,
      edits: [{ path: '../outside.tex', content: 'bad' }],
    }),
  );
  assert.throws(() =>
    applyModelEdits(project(), {
      message: '',
      needsInput: false,
      edits: [{ path: 'MAIN.tex', content: 'bad' }],
    }),
  );
  assert.throws(() =>
    applyModelEdits(project(), {
      message: 'Which year?',
      needsInput: true,
      edits: [{ path: 'main.tex', content: 'Invented' }],
    }),
  );
  const reply = applyModelEdits(project(), { message: 'Which year?', needsInput: true, edits: [] });
  assert.equal(reply.changed, false);
  assert.equal(fingerprint(reply.project), fingerprint(project()));
});
test('render validation requires every numbered page and bounded image data', () => {
  assert.throws(
    () => validateRenderedPdf({ pages: [{ page: 2, text: '', dataUrl: image }], notes: [] }),
    /incomplete/,
  );
  assert.throws(() => validateRenderedPdf({ pages: [], notes: [] }));
  assert.throws(
    () =>
      validateRenderedPdf({
        pages: [{ page: 1, text: '', dataUrl: 'https://example.com/image' }],
        notes: [],
      }),
    /Invalid/,
  );
});

test('agent retries build and visual failures, checks all pages, and commits only a reviewed candidate', async (t) => {
  const workspace = new WorkspaceStore(await fixture(t)),
    calls: ModelRequest[] = [],
    progress: AgentProgress[] = [];
  const edit = (text: string) => ({
    message: 'Updated the wording.',
    needsInput: false,
    edits: [{ path: 'main.tex', content: text }],
  });
  const responses = [
    edit('Broken'),
    edit('Crowded'),
    { approved: false, issues: ['Second page heading overlaps'], message: 'Fix spacing' },
    edit('Readable'),
    { approved: true, issues: [], message: 'Both pages look good' },
  ];
  const builds: string[] = [];
  const agent = new ResumeAgent({
    workspace,
    model: async () => ({
      complete: async (request) => {
        calls.push(request);
        return responses.shift();
      },
    }),
    assets: async () => new Map(),
    compile: async (p) => {
      builds.push(p.files[0].content);
      return {
        projectId: p.id,
        revision: p.revision,
        status: p.files[0].content === 'Broken' ? 'error' : 'success',
        pdf,
        diagnostics:
          p.files[0].content === 'Broken' ? [{ severity: 'error', message: 'Bad TeX' }] : [],
        log: '',
        durationMs: 1,
      };
    },
    cancelBuild: async () => {},
    render: async () => ({
      pages: [
        { page: 1, dataUrl: image, text: 'Page one' },
        { page: 2, dataUrl: image, text: 'Page two' },
      ],
      notes: [],
    }),
    progress: (event) => progress.push(event),
  });
  const result = await agent.run({
    runId: 'run',
    project: project(),
    message: 'Improve spacing',
    annotationIds: [],
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.project?.files[0].content, 'Readable');
  assert.equal(result.version?.verified, true);
  assert.deepEqual(builds, ['Original facts', 'Broken', 'Crowded', 'Readable']);
  assert.ok(calls.some((request) => request.prompt.includes('Second page heading overlaps')));
  for (const request of calls.filter(
    (request) => 'approved' in (request.schema.properties as object),
  ))
    assert.equal(request.images.length, 2);
  assert.equal((await workspace.load(project().id)).versions.length, 2);
  assert.equal(progress.at(-1)?.phase, 'complete');
});
test('agent supplies selected old-version source, pages and crops to the model', async (t) => {
  const workspace = new WorkspaceStore(await fixture(t)),
    p = project();
  const old = await workspace.checkpoint(p, pdf);
  const note = {
    id: 'old-note',
    versionId: old.id,
    page: 1,
    kind: 'highlight' as const,
    rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
    text: 'Shorten this',
    createdAt: '',
  };
  await workspace.save({ ...emptyWorkspace(p.id), annotations: [note] });
  const requests: ModelRequest[] = [];
  const agent = new ResumeAgent({
    workspace,
    model: async () => ({
      complete: async (request) => {
        requests.push(request);
        return { message: 'Which detail should I retain?', needsInput: true, edits: [] };
      },
    }),
    assets: async () => new Map(),
    compile: async (p) => ({
      projectId: p.id,
      revision: p.revision,
      status: 'success',
      pdf,
      durationMs: 0,
      diagnostics: [],
      log: '',
    }),
    cancelBuild: async () => {},
    render: async (_run, _pdf, notes) => ({
      pages: [{ page: 1, text: 'Current page', dataUrl: image }],
      notes: notes.map((n) => ({ annotationId: n.id, page: n.page, dataUrl: image })),
    }),
    progress: () => {},
  });
  const result = await agent.run({
    runId: 'run',
    project: { ...p, files: [{ path: 'main.tex', content: 'Newer source' }] },
    message: 'Apply my note',
    annotationIds: [note.id],
  });
  assert.equal(result.status, 'needs-input');
  assert.equal(result.project, undefined);
  // Only the anchored historical page and crop are needed before a clarification.
  assert.equal(requests[0].images.length, 2);
  assert.ok(requests[0].prompt.includes('Original facts'));
  assert.ok(requests[0].prompt.includes('Earlier PDF version'));
});
test('cancelling an in-flight model call returns no edits and stops the build', async (t) => {
  const workspace = new WorkspaceStore(await fixture(t));
  let started!: () => void,
    cancelledBuild = false;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const agent = new ResumeAgent({
    workspace,
    model: async () => ({
      complete: (_request, signal) =>
        new Promise((_resolve, reject) => {
          started();
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }),
    }),
    assets: async () => new Map(),
    compile: async (p) => ({
      projectId: p.id,
      revision: p.revision,
      status: 'success',
      pdf,
      diagnostics: [],
      log: '',
      durationMs: 0,
    }),
    cancelBuild: async () => {
      cancelledBuild = true;
    },
    render: async () => ({ pages: [{ page: 1, text: '', dataUrl: image }], notes: [] }),
    progress: () => {},
  });
  const pending = agent.run({
    runId: 'cancel-me',
    project: project(),
    message: 'Update',
    annotationIds: [],
  });
  await began;
  await agent.cancel('cancel-me');
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.project, undefined);
  assert.equal(cancelledBuild, true);
});
test('native command environment excludes host API credentials', () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'never-inherit';
  try {
    assert.equal(childEnvironment().OPENAI_API_KEY, undefined);
    assert.equal(childEnvironment().ANTHROPIC_API_KEY, undefined);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
test('Codex protocol initializes, uses a read-only ephemeral thread, and accepts structured image output', async (t) => {
  const root = await fixture(t),
    executable = path.join(root, 'codex-fixture');
  await fs.writeFile(
    executable,
    `#!${process.execPath}\nconst fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync('calls.jsonl',line+'\\n');if(!m.id)return;let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};if(m.method==='config/read')result={config:{mcp_servers:{inherited:{enabled:true}}}};if(m.method==='thread/start')result={thread:{id:'thread'}};if(m.method==='mcpServerStatus/list')result={data:[{runtimeStatus:'disabled',tools:{}}],nextCursor:null};if(m.method==='turn/start')result={turn:{id:'turn'}};console.log(JSON.stringify({id:m.id,result}));if(m.method==='turn/start'){console.log(JSON.stringify({method:'item/completed',params:{threadId:'thread',item:{type:'agentMessage',text:'{"color":"red"}'}}}));console.log(JSON.stringify({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}}));}});`,
    { mode: 0o700 },
  );
  const rpc = new CodexRPC(executable, root, new AbortController().signal);
  try {
    await rpc.initialize();
    const result = await requestCodex(
      rpc,
      validateConnection({ name: 'Codex', kind: 'codex', model: '' }),
      { system: 'Check', prompt: 'Color?', images: [image], schema: { type: 'object' } },
      new AbortController().signal,
    );
    assert.deepEqual(result, { color: 'red' });
    const calls = (await fs.readFile(path.join(root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const thread = calls.find((c) => c.method === 'thread/start').params;
    assert.equal(thread.ephemeral, true);
    assert.equal(thread.sandbox, 'read-only');
    assert.equal(thread.config.features.shell_tool, false);
    assert.equal(thread.config.mcp_servers.inherited.enabled, false);
    assert.equal(calls.find((c) => c.method === 'turn/start').params.input[1].type, 'image');
  } finally {
    rpc.close();
  }
});
test('Claude subscription adapter uses the official print protocol with customizations and tools disabled', async (t) => {
  const root = await fixture(t),
    executable = path.join(root, 'claude-fixture');
  await fs.writeFile(
    executable,
    `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]==='auth'){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));process.exit(0);}fs.writeFileSync('args.json',JSON.stringify(process.argv.slice(2)));let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{fs.writeFileSync('input.json',data);console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{color:'red'}}));});`,
    { mode: 0o700 },
  );
  const result = await requestClaude(
    executable,
    root,
    validateConnection({ name: 'Claude', kind: 'claude-code', model: '' }),
    { system: 'Check', prompt: 'Color?', images: [image], schema: { type: 'object' } },
    new AbortController().signal,
  );
  assert.deepEqual(result, { color: 'red' });
  const args = JSON.parse(await fs.readFile(path.join(root, 'args.json'), 'utf8'));
  assert.ok(args.includes('--safe-mode'));
  assert.ok(!args.includes('--bare'));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  const input = JSON.parse(await fs.readFile(path.join(root, 'input.json'), 'utf8'));
  assert.equal(input.message.content[1].source.type, 'base64');
});
test('Codex refuses to start inference when an inherited tool remains enabled', async () => {
  const calls: string[] = [];
  const rpc = Object.assign(Object.create(CodexRPC.prototype), {
    cwd: '/tmp',
    request: async (method: string) => {
      calls.push(method);
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'config/read') return { config: { mcp_servers: { inherited: {} } } };
      if (method === 'thread/start') return { thread: { id: 'test-thread' } };
      if (method === 'mcpServerStatus/list')
        return { data: [{ runtimeStatus: 'connected', tools: { unexpected: {} } }] };
      throw new Error('Inference must not run.');
    },
  }) as CodexRPC;
  await assert.rejects(
    requestCodex(
      rpc,
      validateConnection({ name: 'Codex', kind: 'codex', model: '' }),
      { system: 'Check', prompt: 'Color?', images: [image], schema: { type: 'object' } },
      new AbortController().signal,
    ),
    /disable inherited tools/,
  );
  assert.ok(!calls.includes('turn/start'));
});
