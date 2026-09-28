import { useState } from 'react';
import { ChevronDown, ChevronRight, FileDiff } from 'lucide-react';
import type { GitDiffFile, GitHunk } from '../shared/git';

export function CodeDiff({
  files,
  action,
  emptyLabel = 'No changes.',
}: {
  files: GitDiffFile[];
  action?: { label: string; onAction(hunk: GitHunk, file: GitDiffFile): void };
  emptyLabel?: string;
}) {
  const [collapsed, setCollapsed] = useState(new Set<string>());
  if (!files.length) return <p className="code-diff-empty">{emptyLabel}</p>;
  return (
    <div className="code-diff">
      {files.map((file) => {
        const key = file.oldPath ? `${file.oldPath}=>${file.path}` : file.path;
        const closed = collapsed.has(key);
        return (
          <div className="code-diff-file" key={key}>
            <button
              type="button"
              className="code-diff-file-heading"
              onClick={() =>
                setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
              aria-expanded={!closed}
            >
              {closed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <FileDiff size={14} />
              <span>
                {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              </span>
              <span className={`code-diff-kind ${file.kind}`}>{file.kind}</span>
            </button>
            {!closed && (
              <div className="code-diff-body">
                {file.binary ? (
                  <p className="code-diff-binary">Binary file — no line diff available.</p>
                ) : !file.hunks.length ? (
                  <p className="code-diff-binary">No textual changes.</p>
                ) : (
                  file.hunks.map((hunk, index) => (
                    <div className="code-diff-hunk" key={index}>
                      <div className="code-diff-hunk-heading">
                        <span>{hunk.header}</span>
                        {action && (
                          <button
                            type="button"
                            className="button secondary small"
                            onClick={() => action.onAction(hunk, file)}
                          >
                            {action.label}
                          </button>
                        )}
                      </div>
                      <table className="code-diff-lines">
                        <tbody>
                          {hunk.lines.map((line, lineIndex) => (
                            <tr key={lineIndex} className={`code-diff-line ${line.kind}`}>
                              <td className="code-diff-lineno">{line.oldLine ?? ''}</td>
                              <td className="code-diff-lineno">{line.newLine ?? ''}</td>
                              <td className="code-diff-marker">
                                {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ''}
                              </td>
                              <td className="code-diff-text">{line.text}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
