import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  MoreHorizontal,
} from 'lucide-react';
import type { ProjectFile } from '../shared/types';

type Directory = { directories: Map<string, Directory>; files: ProjectFile[] };
export function ProjectFiles({
  files,
  active,
  main,
  onSelect,
  onManage,
}: {
  files: ProjectFile[];
  active: string;
  main: string;
  onSelect(path: string): void;
  onManage(path: string): void;
}) {
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const navigation = useRef<HTMLElement>(null);
  const tree = useMemo(() => {
    const root: Directory = { directories: new Map(), files: [] };
    for (const file of files) {
      let node = root;
      for (const part of file.path.split('/').slice(0, -1)) {
        if (!node.directories.has(part))
          node.directories.set(part, { directories: new Map(), files: [] });
        node = node.directories.get(part)!;
      }
      node.files.push(file);
    }
    return root;
  }, [files]);
  useEffect(() => {
    setCollapsed(
      (previous) => new Set([...previous].filter((dir) => !active.startsWith(dir + '/'))),
    );
  }, [active]);
  useEffect(() => {
    navigation.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, collapsed]);
  useEffect(() => {
    const element = navigation.current;
    if (!element?.parentElement) return;
    const observer = new ResizeObserver(() => {
      element.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
    });
    observer.observe(element.parentElement);
    return () => observer.disconnect();
  }, []);
  const render = (node: Directory, prefix = '', depth = 0) => (
    <ul className="file-group">
      {[...node.directories]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, directory]) => {
          const full = prefix + name;
          const closed = collapsed.has(full);
          return (
            <li key={full}>
              <button
                className="file-row directory-row"
                style={{ paddingLeft: 8 + depth * 12 }}
                aria-label={`Folder ${full}`}
                aria-expanded={!closed}
                title={full}
                onClick={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(full)) next.delete(full);
                    else next.add(full);
                    return next;
                  })
                }
              >
                {closed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                {closed ? <Folder size={15} /> : <FolderOpen size={15} />}
                <span>{name}</span>
              </button>
              {!closed && render(directory, full + '/', depth + 1)}
            </li>
          );
        })}
      {node.files.map((file) => (
        <li key={file.path} className="file-entry">
          <button
            className={`file-row ${file.path === active ? 'selected' : ''}`}
            style={{ paddingLeft: 26 + depth * 12 }}
            aria-label={file.path}
            aria-current={file.path === active ? 'page' : undefined}
            title={file.path}
            onClick={() => onSelect(file.path)}
            onContextMenu={(event) => {
              event.preventDefault();
              onManage(file.path);
            }}
          >
            <FileCode2 size={15} />
            <span>{file.path.split('/').pop()}</span>
            {file.path === main && <span className="file-main-dot" title="Main document" />}
          </button>
          <button
            className="icon-button file-actions"
            aria-label={`File actions for ${file.path}`}
            title="Rename or remove file"
            onClick={() => onManage(file.path)}
          >
            <MoreHorizontal size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
  return (
    <nav className="file-tree" aria-label="Project files" ref={navigation}>
      {render(tree)}
    </nav>
  );
}
