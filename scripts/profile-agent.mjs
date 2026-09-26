// Controlled local harness benchmark: no inference, renderer, or native TeX latency claims.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ResumeAgent } from '../electron/core/agent.ts';
import { WorkspaceStore } from '../electron/core/workspace.ts';
import { buildFingerprint } from '../electron/core/build-provenance.ts';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const samples = [];
for (let i = 0; i < 5; i++) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-agent-profile-'));
  try {
    const workspace = new WorkspaceStore(root);
    const project = {
      id: 'profile',
      name: 'Synthetic',
      revision: 0,
      mainFile: 'main.tex',
      runtime: {
        engine: 'tectonic',
        version: '1',
        bundle: 'test',
        id: 'a'.repeat(64),
        platform: 'darwin-arm64',
      },
      files: [
        {
          path: 'main.tex',
          content:
            '\\documentclass{article}\n\\begin{document}\nBuilt accessible tools.\n\\end{document}',
        },
      ],
    };
    const pdf = new Uint8Array(Buffer.from('%PDF-1.4\nsynthetic'));
    const assets = new Map();
    const version = await workspace.checkpoint(
      project,
      pdf,
      'Baseline',
      false,
      buildFingerprint(project, assets),
    );
    const counts = { inference: 0, compile: 0, render: 0, inspect: 0 };
    const stages = { setup: 0, inference: 0, compile: 0, render: 0, inspect: 0, review: 0 };
    const measured = async (stage, ms, value) => {
      const start = performance.now();
      await delay(ms);
      stages[stage] += performance.now() - start;
      return value;
    };
    const agent = new ResumeAgent({
      workspace,
      assets: async () => assets,
      model: async () =>
        measured('setup', 10, {
          complete: async (request) => {
            counts.inference++;
            const review = !!request.schema.properties.approved;
            const patches = !!request.schema.properties.edits?.items.anyOf;
            return measured(
              review ? 'review' : 'inference',
              50,
              review
                ? { approved: true, issues: [], message: 'Checked.' }
                : {
                    message: 'Updated the wording.',
                    needsInput: false,
                    edits: [
                      patches
                        ? { path: 'main.tex', search: 'accessible', replacement: 'inclusive' }
                        : {
                            path: 'main.tex',
                            content: project.files[0].content.replace('accessible', 'inclusive'),
                          },
                    ],
                  },
            );
          },
        }),
      compile: async (p) => {
        counts.compile++;
        return measured('compile', 20, {
          projectId: p.id,
          revision: p.revision,
          status: 'success',
          pdf,
          diagnostics: [],
          log: '',
          durationMs: 20,
          buildFingerprint: buildFingerprint(p, assets),
        });
      },
      render: async () => {
        counts.render++;
        return measured('render', 20, {
          pages: [{ page: 1, text: 'Text', dataUrl: 'data:image/png;base64,AA==' }],
          notes: [],
        });
      },
      inspect: async () => {
        counts.inspect++;
        return measured('inspect', 1, { pageCount: 1 });
      },
      cancelBuild: async () => {},
      progress: () => {},
    });
    const start = performance.now();
    const result = await agent.run({
      runId: 'profile-run',
      project,
      message: 'Replace accessible with inclusive.',
      annotationIds: [],
      pdfVersionId: version.id,
    });
    if (result.status !== 'complete') throw new Error(result.message);
    samples.push({ totalMs: performance.now() - start, counts, stages });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
const result = {
  kind: 'controlled-local-fixture',
  sourceHashes: Object.fromEntries(
    await Promise.all(
      [
        'electron/core/agent.ts',
        'electron/core/ai-edits.ts',
        'electron/core/ai-provider.ts',
        'scripts/profile-agent.mjs',
      ].map(async (file) => [
        file,
        createHash('sha256')
          .update(await fs.readFile(file))
          .digest('hex'),
      ]),
    ),
  ),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  recordedAt: new Date().toISOString(),
  node: process.version,
  assumptions:
    'Five warm-baseline runs. Fixed mock setup 10ms, inference/review 50ms, compile/render 20ms, metadata 1ms. Synthetic PDF. Excludes live provider and actual TeX/PDF renderer latency.',
  samples,
};
const output = process.argv[2];
if (output) await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
