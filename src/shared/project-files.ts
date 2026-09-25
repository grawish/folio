import type { Project, RemovedProjectFile } from './types';

export const sourceExtensions = ['tex', 'sty', 'cls', 'bib', 'txt'];
export function sourceFilename(value: unknown, portable = true): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 240 ||
    /[\x00-\x1f\x7f\\:]/.test(value) ||
    (portable && /[<>"|?*]/.test(value)) ||
    value.split('/').length > 9 ||
    value
      .split('/')
      .some(
        (part) =>
          !part ||
          part.startsWith('.') ||
          (portable &&
            (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))),
      ) ||
    !sourceExtensions.includes(value.split('.').pop()!.toLowerCase())
  )
    throw new Error('Use a relative source filename, such as sections/experience.tex.');
  return value;
}

export function validateRemovedFiles(value: unknown): RemovedProjectFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100)
    throw new Error(
      'Removed files are full (100 copies). Restore or permanently remove a copy before continuing.',
    );
  const ids = new Set<string>();
  const result = value.map((item) => {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !/^[\w-]{1,80}$/.test(item.id) ||
      ids.has(item.id) ||
      typeof item.content !== 'string' ||
      new TextEncoder().encode(item.content).length > 2 * 1024 * 1024 ||
      typeof item.removedAt !== 'string' ||
      item.removedAt.length > 40 ||
      !Number.isFinite(Date.parse(item.removedAt)) ||
      !['removed', 'disk-copy', 'editor-copy'].includes(item.reason)
    )
      throw new Error('A removed source file is invalid.');
    ids.add(item.id);
    return {
      id: item.id,
      path: sourceFilename(item.path, false),
      content: item.content,
      removedAt: item.removedAt,
      reason: item.reason,
    } as RemovedProjectFile;
  });
  if (new TextEncoder().encode(JSON.stringify(result)).length > 10 * 1024 * 1024)
    throw new Error(
      'Removed files exceed 10 MB. Restore or permanently remove a copy before continuing.',
    );
  return result;
}

function unique(project: Project, name: string, excluding?: string) {
  sourceFilename(name);
  const folded = name.normalize('NFC').toLowerCase();
  if (
    project.files.some(
      (file) => file.path !== excluding && file.path.normalize('NFC').toLowerCase() === folded,
    )
  )
    throw new Error('A file with this name already exists.');
  if (
    project.files.some(
      (file) =>
        file.path !== excluding &&
        (file.path
          .normalize('NFC')
          .toLowerCase()
          .startsWith(folded + '/') ||
          folded.startsWith(file.path.normalize('NFC').toLowerCase() + '/')),
    )
  )
    throw new Error('This name conflicts with a project folder or file.');
  const parts = name.split('/');
  for (const file of project.files) {
    if (file.path === excluding) continue;
    const existing = file.path.split('/');
    for (let i = 0; i < Math.min(parts.length, existing.length) - 1; i++) {
      if (parts[i].normalize('NFC').toLowerCase() !== existing[i].normalize('NFC').toLowerCase())
        break;
      if (parts[i] !== existing[i])
        throw new Error('Use the existing folder spelling, including letter case and accents.');
    }
  }
}

export function addSource(project: Project, name: string, content = `% ${name}\n`): Project {
  unique(project, name);
  const files = [...project.files, { path: name, content }];
  if (
    files.length > 100 ||
    new TextEncoder().encode(content).length > 2 * 1024 * 1024 ||
    files.reduce((sum, item) => sum + new TextEncoder().encode(item.content).length, 0) >
      5 * 1024 * 1024
  )
    throw new Error('This file would exceed the project limit of 100 source files or 5 MB.');
  return { ...project, files, revision: project.revision + 1 };
}

export function renameSource(project: Project, from: string, name: string): Project {
  if (!project.files.some((file) => file.path === from))
    throw new Error('This file is no longer in the project.');
  unique(project, name, from);
  if (name === from) return project;
  if (name.normalize('NFC').toLowerCase() === from.normalize('NFC').toLowerCase())
    throw new Error('Use a different name first when changing only letter case or accents.');
  if (project.mainFile === from && !name.endsWith('.tex'))
    throw new Error('The main document must keep its .tex extension.');
  return {
    ...project,
    revision: project.revision + 1,
    mainFile: project.mainFile === from ? name : project.mainFile,
    files: project.files.map((file) => (file.path === from ? { ...file, path: name } : file)),
  };
}

export function removeSource(project: Project, name: string, replacementMain?: string): Project {
  const file = project.files.find((item) => item.path === name);
  if (!file) throw new Error('This file is no longer in the project.');
  const files = project.files.filter((item) => item.path !== name);
  const mainFile = project.mainFile === name ? replacementMain : project.mainFile;
  if (!mainFile || !files.some((item) => item.path === mainFile && item.path.endsWith('.tex')))
    throw new Error('Keep at least one .tex document and choose it as the main document.');
  const removedFiles = validateRemovedFiles([
    ...(project.removedFiles ?? []),
    {
      id: crypto.randomUUID(),
      path: name,
      content: file.content,
      removedAt: new Date().toISOString(),
      reason: 'removed',
    },
  ]);
  return { ...project, files, mainFile, removedFiles, revision: project.revision + 1 };
}

export function restoreSource(project: Project, id: string, name: string): Project {
  const file = project.removedFiles?.find((item) => item.id === id);
  if (!file) throw new Error('This saved copy is no longer available.');
  return {
    ...addSource(project, name, file.content),
    removedFiles: project.removedFiles!.filter((item) => item.id !== id),
  };
}
