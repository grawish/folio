import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { paperSizes, templateCatalog, templateSource } from '../src/shared/template-catalog';
import { ProjectStore, validateProject } from '../electron/core/project';
import { WorkspaceStore } from '../electron/core/workspace';
import { ProjectImporter } from '../electron/core/project-import';

const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
test('catalog covers the planned styles and every shipped paper preview matches its current source', async () => {
  const ids = templateCatalog.map((template) => template.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['minimal', 'classic', 'compact-technical', 'academic', 'two-column', 'modern'])
    assert.ok(ids.includes(id as (typeof ids)[number]));
  assert.deepEqual(
    (await fs.readdir('resources/templates')).filter((file) => file.endsWith('.tex')).sort(),
    ids.map((id) => id + '.tex').sort(),
  );
  const manifest = JSON.parse(await fs.readFile('public/templates/manifest.json', 'utf8'));
  assert.equal(manifest.variants.length, ids.length * paperSizes.length);
  for (const template of templateCatalog) {
    const source = await fs.readFile(`resources/templates/${template.id}.tex`, 'utf8');
    for (const paper of paperSizes) {
      const variant = manifest.variants.find(
        (entry: { name: string }) => entry.name === `${template.id}-${paper.id}`,
      );
      assert.ok(variant, 'missing preview variant');
      assert.equal(
        variant.sourceHash,
        hash(templateSource(source, paper.id)),
        'regenerate stale preview',
      );
      const png = await fs.readFile(`public/templates/${variant.name}.png`);
      assert.equal(variant.previewHash, hash(png));
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(variant.pageCount, 1);
      assert.ok(
        Math.abs(variant.width - paper.width) < 0.2 &&
          Math.abs(variant.height - paper.height) < 0.2,
      );
      assert.equal(templateSource(templateSource(source, paper.id), 'a4'), source);
      const project = validateProject({
        id: template.id,
        name: template.name,
        mainFile: 'main.tex',
        revision: 0,
        templateId: template.id,
        templateVersion: template.version,
        files: [{ path: 'main.tex', content: templateSource(source, paper.id) }],
      });
      assert.equal(project.templateId, template.id);
      assert.equal(project.templateVersion, template.version);
    }
  }
});

test('template origin/version and Letter source survive save, recovery, versions, Save As and ZIP import', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-template-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'),
    folder = path.join(root, 'saved'),
    copy = path.join(root, 'copy');
  await fs.mkdir(folder);
  await fs.mkdir(copy);
  const content = templateSource(
    await fs.readFile('resources/templates/two-column.tex', 'utf8'),
    'letter',
  );
  const project = validateProject({
    id: 'template-project',
    name: 'Template example',
    mainFile: 'main.tex',
    revision: 0,
    templateId: 'two-column',
    templateVersion: 1,
    files: [{ path: 'main.tex', content }],
  });
  const store = new ProjectStore(data),
    workspace = new WorkspaceStore(data);
  const version = await workspace.checkpoint(project, Buffer.from('%PDF-1.4\nTemplate sample'));
  await store.save(project, folder, false, (id) => workspace.archive(project.id, id));
  const opened = await store.open(folder);
  await store.recover(opened);
  assert.equal((await new ProjectStore(data).loadRecovery())?.templateVersion, 1);
  const duplicate = await store.save(opened, copy, false, (id) =>
    workspace.archive(project.id, id),
  );
  assert.notEqual(duplicate.projectId, project.id);
  assert.equal((await store.open(copy)).templateId, 'two-column');
  const zip = path.join(root, 'template.zip');
  await fs.writeFile(
    zip,
    zipSync({
      'main.tex': strToU8(content),
      'resume.project.json': await fs.readFile(path.join(copy, 'resume.project.json')),
      'resume.folio': await fs.readFile(path.join(copy, 'resume.folio')),
    }),
  );
  const importer = new ProjectImporter(path.join(root, 'import-app')),
    preview = await importer.prepare(zip);
  const importedPath = await importer.finish(preview.token, 'main.tex', root);
  const imported = await store.open(importedPath);
  assert.equal(imported.templateId, 'two-column');
  assert.equal(imported.templateVersion, 1);
  assert.equal(imported.files[0].content, content);
  await workspace.importFrom(imported.id, importedPath);
  const snapshot = await workspace.version(imported.id, version.id);
  assert.equal(snapshot.templateId, 'two-column');
  assert.equal(snapshot.templateVersion, 1);
  assert.equal(snapshot.files[0].content, content);
  assert.equal(
    validateProject({ ...project, templateVersion: 'invalid' }).templateVersion,
    undefined,
  );
  assert.equal(
    validateProject({ ...project, templateVersion: undefined }).templateVersion,
    undefined,
  );
});
