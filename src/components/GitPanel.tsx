import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Download,
  FilePlus2,
  FileX2,
  GitBranch as GitBranchIcon,
  GitCommitHorizontal,
  GitMerge as GitMergeIcon,
  Package,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import type {
  GitAvailability,
  GitBranch,
  GitCommit,
  GitConflictVersions,
  GitDiffFile,
  GitFileStatus,
  GitOperationProgress,
  GitRemote,
  GitRepoStatus,
  GitStash,
} from '../shared/git';
import { errorMessage } from '../error-message';
import { CodeDiff } from './CodeDiff';

const LOG_PAGE = 20;

export function GitPanel({ projectId }: { projectId: string }) {
  const [availability, setAvailability] = useState<GitAvailability | null>(null);
  const [status, setStatus] = useState<GitRepoStatus | null>(null);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [stashes, setStashes] = useState<GitStash[]>([]);
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [log, setLog] = useState<GitCommit[]>([]);
  const [logDone, setLogDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);

  const [diffs, setDiffs] = useState<Record<string, GitDiffFile[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const [commitMessage, setCommitMessage] = useState('');

  const [logDiffs, setLogDiffs] = useState<Record<string, GitDiffFile[]>>({});
  const [openCommit, setOpenCommit] = useState<string | null>(null);

  const [newBranch, setNewBranch] = useState('');
  const [switchOnCreate, setSwitchOnCreate] = useState(true);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState('');

  const [mergeTarget, setMergeTarget] = useState('');
  const [mergeResult, setMergeResult] = useState<{ conflicts: string[] } | null>(null);

  const [conflictPath, setConflictPath] = useState<string | null>(null);
  const [conflictVersions, setConflictVersions] = useState<GitConflictVersions | null>(null);
  const [conflictResult, setConflictResult] = useState('');

  const [stashMessage, setStashMessage] = useState('');
  const [stashDiffs, setStashDiffs] = useState<Record<number, GitDiffFile[]>>({});
  const [openStash, setOpenStash] = useState<number | null>(null);

  const [remoteName, setRemoteName] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [upstreamRemote, setUpstreamRemote] = useState('');
  const [netOp, setNetOp] = useState<GitOperationProgress | null>(null);
  const netOpId = useRef<string | null>(null);
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneDirectory, setCloneDirectory] = useState('');
  const [clonedProjectId, setClonedProjectId] = useState('');

  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (e) {
      setError(errorMessage((e as Error).message));
    } finally {
      setBusy(false);
      setConfirmKey(null);
    }
  };

  const refreshAll = async () => {
    const desktop = window.folio;
    if (!desktop) return;
    const nextStatus = await desktop.gitStatus(projectId);
    setStatus(nextStatus);
    if (nextStatus) {
      const [nextBranches, nextStashes, nextRemotes] = await Promise.all([
        desktop.gitBranches(projectId),
        desktop.gitStashes(projectId),
        desktop.gitRemotes(projectId),
      ]);
      setBranches(nextBranches);
      setStashes(nextStashes);
      setRemotes(nextRemotes);
    } else {
      setBranches([]);
      setStashes([]);
      setRemotes([]);
    }
  };

  const loadLog = async (skip: number) => {
    const desktop = window.folio;
    if (!desktop) return;
    const page = await desktop.gitLog(projectId, { skip, limit: LOG_PAGE });
    setLog((previous) => (skip === 0 ? page : [...previous, ...page]));
    setLogDone(page.length < LOG_PAGE);
  };

  useEffect(() => {
    setStatus(null);
    setBranches([]);
    setStashes([]);
    setRemotes([]);
    setLog([]);
    setLogDone(false);
    setDiffs({});
    setExpanded(null);
    setMergeResult(null);
    setConflictPath(null);
    void act(async () => {
      const desktop = window.folio;
      if (!desktop) return;
      setAvailability(await desktop.gitAvailability());
      await refreshAll();
      await loadLog(0);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    const unsubscribe = window.folio?.onGitProgress((event) => {
      if (event.id === netOpId.current) setNetOp(event);
    });
    return () => unsubscribe?.();
  }, []);

  if (!window.folio)
    return (
      <section className="git-panel" aria-label="Git">
        <p className="settings-hint">Open the desktop app to use Git.</p>
      </section>
    );
  const desktop = window.folio;

  const toggleDiff = (kind: 'staged' | 'unstaged', path: string) => {
    const key = `${kind}:${path}`;
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    if (!diffs[key])
      void act(async () => {
        const files = await desktop.gitDiff(projectId, { kind, path });
        setDiffs((previous) => ({ ...previous, [key]: files }));
      });
  };

  const toggleCommit = (hash: string) => {
    if (openCommit === hash) {
      setOpenCommit(null);
      return;
    }
    setOpenCommit(hash);
    if (!logDiffs[hash])
      void act(async () => {
        const files = await desktop.gitDiff(projectId, { kind: 'commit', hash });
        setLogDiffs((previous) => ({ ...previous, [hash]: files }));
      });
  };

  const toggleStash = (index: number) => {
    if (openStash === index) {
      setOpenStash(null);
      return;
    }
    setOpenStash(index);
    if (!stashDiffs[index])
      void act(async () => {
        const files = await desktop.gitStashShow(projectId, index);
        setStashDiffs((previous) => ({ ...previous, [index]: files }));
      });
  };

  const openConflict = (path: string) =>
    void act(async () => {
      const versions = await desktop.gitConflict(projectId, path);
      setConflictPath(path);
      setConflictVersions(versions);
      setConflictResult(versions.ours ?? versions.theirs ?? versions.base ?? '');
    });

  const resolveConflict = (resolution: { content: string } | { pick: 'ours' | 'theirs' }) =>
    void act(async () => {
      await desktop.gitResolveConflict(projectId, conflictPath!, resolution);
      setConflictPath(null);
      setConflictVersions(null);
      await refreshAll();
    });

  const runNetwork = (
    operation: GitOperationProgress['operation'],
    action: (id: string) => Promise<void>,
  ) => {
    if (netOpId.current) return;
    const id = crypto.randomUUID();
    netOpId.current = id;
    setNetOp({ id, operation, message: 'Starting…', done: false });
    void act(async () => {
      try {
        await action(id);
      } finally {
        netOpId.current = null;
        setNetOp(null);
      }
      await refreshAll();
    });
  };

  const cancelNetwork = () => {
    if (netOpId.current) void desktop.gitCancel(netOpId.current);
  };

  const confirm = (key: string, run: () => void) => {
    if (confirmKey === key) run();
    else setConfirmKey(key);
  };

  if (!availability) return null;

  if (!availability.installed)
    return (
      <section className="git-panel" aria-label="Git">
        <div className="git-setup-notice">
          <CircleAlert size={18} />
          <div>
            <strong>Git isn’t installed</strong>
            <p>
              {availability.message ||
                'Install git from your system package manager or git-scm.com, then reopen this project.'}
            </p>
          </div>
        </div>
      </section>
    );

  if (!availability.identity?.name || !availability.identity?.email)
    return (
      <section className="git-panel" aria-label="Git">
        <div className="git-setup-notice">
          <CircleAlert size={18} />
          <div>
            <strong>Set your Git identity</strong>
            <p>
              Run <code>git config --global user.name "Your Name"</code> and{' '}
              <code>git config --global user.email "you@example.com"</code> in a terminal, then
              reopen this project.
            </p>
          </div>
        </div>
      </section>
    );

  if (!status)
    return (
      <section className="git-panel" aria-label="Git">
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="git-empty-state">
          <p>This project isn’t a Git repository yet.</p>
          <button
            className="button primary small"
            disabled={busy}
            onClick={() => void act(async () => setStatus(await desktop.gitInit(projectId)))}
          >
            Initialize repository
          </button>
        </div>
        <div className="git-clone-form">
          <p className="settings-hint">Or clone a remote repository into a new project folder.</p>
          <label className="field-label" htmlFor="git-clone-url">
            Remote URL
          </label>
          <input
            id="git-clone-url"
            type="text"
            value={cloneUrl}
            placeholder="git@github.com:user/repo.git"
            onChange={(event) => setCloneUrl(event.target.value)}
          />
          <label className="field-label" htmlFor="git-clone-dir">
            Destination folder
          </label>
          <input
            id="git-clone-dir"
            type="text"
            value={cloneDirectory}
            placeholder="/Users/you/Documents/resume-clone"
            onChange={(event) => setCloneDirectory(event.target.value)}
          />
          <button
            className="button secondary small"
            disabled={busy || !!netOp || !cloneUrl.trim() || !cloneDirectory.trim()}
            onClick={() =>
              runNetwork('clone', async (id) => {
                const newProjectId = await desktop.gitClone(
                  id,
                  cloneUrl.trim(),
                  cloneDirectory.trim(),
                );
                setClonedProjectId(newProjectId);
              })
            }
          >
            <Download size={15} /> Clone
          </button>
          {clonedProjectId && (
            <p className="settings-hint">
              Cloned. Open “{clonedProjectId}” from your project list to continue.
            </p>
          )}
          {netOp?.operation === 'clone' && (
            <div className="git-progress" role="status">
              <span>{netOp.message}</span>
              <button className="icon-button" aria-label="Cancel clone" onClick={cancelNetwork}>
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      </section>
    );

  const staged = status.files.filter((f) => f.staged && !f.conflicted);
  const unstaged = status.files.filter(
    (f) => f.unstaged && f.unstaged !== 'untracked' && !f.conflicted,
  );
  const untracked = status.files.filter((f) => f.unstaged === 'untracked' && !f.conflicted);
  const conflicted = status.files.filter((f) => f.conflicted);
  const canPush = !!status.upstream;

  const fileRow = (file: GitFileStatus, kind: 'staged' | 'unstaged') => (
    <div className="git-file-row" key={`${kind}:${file.path}`}>
      <button
        type="button"
        className="git-file-name"
        onClick={() => toggleDiff(kind, file.path)}
        title="View diff"
      >
        {expanded === `${kind}:${file.path}` ? (
          <ChevronDown size={13} />
        ) : (
          <ChevronRight size={13} />
        )}
        <span>{file.renamedFrom ? `${file.renamedFrom} → ${file.path}` : file.path}</span>
        <span
          className={`git-file-kind ${(kind === 'staged' ? file.staged : file.unstaged) ?? ''}`}
        >
          {kind === 'staged' ? file.staged : file.unstaged}
        </span>
      </button>
      <div className="git-file-actions">
        {kind === 'staged' ? (
          <button
            className="icon-button"
            aria-label={`Unstage ${file.path}`}
            title="Unstage"
            disabled={busy}
            onClick={() =>
              void act(async () => setStatus(await desktop.gitUnstage(projectId, [file.path])))
            }
          >
            <ChevronDown size={14} />
          </button>
        ) : (
          <>
            <button
              className="icon-button"
              aria-label={`Stage ${file.path}`}
              title="Stage"
              disabled={busy}
              onClick={() =>
                void act(async () => setStatus(await desktop.gitStage(projectId, [file.path])))
              }
            >
              <Plus size={14} />
            </button>
            {file.unstaged !== 'untracked' && (
              <button
                className="icon-button"
                aria-label={`Discard changes to ${file.path}`}
                title="Discard changes"
                disabled={busy}
                onClick={() =>
                  confirm(
                    `discard:${file.path}`,
                    () =>
                      void act(async () =>
                        setStatus(await desktop.gitRestoreFiles(projectId, 'HEAD', [file.path])),
                      ),
                  )
                }
              >
                {confirmKey === `discard:${file.path}` ? <Check size={14} /> : <Undo2 size={14} />}
              </button>
            )}
          </>
        )}
      </div>
      {expanded === `${kind}:${file.path}` && (
        <CodeDiff
          files={diffs[`${kind}:${file.path}`] ?? []}
          action={{
            label: kind === 'staged' ? 'Unstage hunk' : 'Stage hunk',
            onAction: (hunk) =>
              void act(async () => {
                const next = await desktop.gitApplyPatch(projectId, hunk.patch, {
                  cached: kind === 'unstaged',
                  reverse: kind === 'staged',
                });
                setStatus(next);
                setDiffs((previous) => {
                  const rest = { ...previous };
                  delete rest[`${kind}:${file.path}`];
                  return rest;
                });
              }),
          }}
        />
      )}
    </div>
  );

  return (
    <section className="git-panel" aria-label="Git">
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="git-status-header">
        <span className="git-branch-name">
          <GitBranchIcon size={15} />
          {status.detached
            ? `detached @ ${status.branch ?? '?'}`
            : (status.branch ?? '(no branch)')}
        </span>
        {status.upstream && (
          <span className="git-ahead-behind">
            {status.upstream} {status.ahead > 0 && <span>↑{status.ahead}</span>}
            {status.behind > 0 && <span>↓{status.behind}</span>}
          </span>
        )}
        {status.state !== 'clean' && (
          <span className={`git-state-badge ${status.state}`}>{status.state}</span>
        )}
        <button
          className="icon-button"
          aria-label="Refresh status"
          title="Refresh"
          disabled={busy}
          onClick={() => void act(refreshAll)}
        >
          <RefreshCw size={15} />
        </button>
        {status.state !== 'clean' && (
          <>
            <button
              className="button secondary small"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const result = await desktop.gitMergeContinue(projectId);
                  if (result.conflicts.length) setMergeResult({ conflicts: result.conflicts });
                  await refreshAll();
                  await loadLog(0);
                })
              }
            >
              Continue
            </button>
            <button
              className="button secondary small"
              disabled={busy}
              onClick={() =>
                void act(async () => setStatus(await desktop.gitMergeAbort(projectId)))
              }
            >
              Abort
            </button>
          </>
        )}
      </div>

      {conflicted.length > 0 && (
        <div className="git-section git-conflicts">
          <h4>Conflicts</h4>
          {conflicted.map((file) => (
            <div className="git-file-row" key={file.path}>
              <span className="git-file-name">
                <CircleAlert size={13} />
                {file.path}
              </span>
              <button className="button secondary small" onClick={() => openConflict(file.path)}>
                Resolve
              </button>
            </div>
          ))}
        </div>
      )}

      {conflictPath && conflictVersions && (
        <div className="git-section git-conflict-editor">
          <h4>Resolve {conflictPath}</h4>
          {conflictVersions.binary ? (
            <div className="git-conflict-binary">
              <p>Binary file conflict — choose which version to keep.</p>
              <button
                className="button secondary small"
                onClick={() => resolveConflict({ pick: 'ours' })}
              >
                Use mine
              </button>
              <button
                className="button secondary small"
                onClick={() => resolveConflict({ pick: 'theirs' })}
              >
                Use theirs
              </button>
            </div>
          ) : (
            <>
              <div className="git-conflict-versions">
                <div>
                  <span className="field-label">Base</span>
                  <textarea readOnly value={conflictVersions.base ?? '(no base)'} />
                </div>
                <div>
                  <span className="field-label">Ours</span>
                  <textarea readOnly value={conflictVersions.ours ?? '(deleted)'} />
                </div>
                <div>
                  <span className="field-label">Theirs</span>
                  <textarea readOnly value={conflictVersions.theirs ?? '(deleted)'} />
                </div>
              </div>
              <span className="field-label">Result (editable)</span>
              <textarea
                className="git-conflict-result"
                value={conflictResult}
                onChange={(event) => setConflictResult(event.target.value)}
              />
              <div className="git-conflict-actions">
                <button
                  className="button primary small"
                  onClick={() => resolveConflict({ content: conflictResult })}
                >
                  Save resolution
                </button>
                <button
                  className="button secondary small"
                  onClick={() => resolveConflict({ pick: 'ours' })}
                >
                  Use mine
                </button>
                <button
                  className="button secondary small"
                  onClick={() => resolveConflict({ pick: 'theirs' })}
                >
                  Use theirs
                </button>
                <button
                  className="text-button"
                  onClick={() => {
                    setConflictPath(null);
                    setConflictVersions(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="git-section">
        <h4>Staged changes ({staged.length})</h4>
        {!staged.length ? (
          <p className="git-empty">Nothing staged.</p>
        ) : (
          staged.map((file) => fileRow(file, 'staged'))
        )}
        <textarea
          className="git-commit-message"
          placeholder="Commit message"
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
        />
        <button
          className="button primary small"
          disabled={busy || !staged.length || !commitMessage.trim()}
          onClick={() =>
            void act(async () => {
              setStatus(await desktop.gitCommit(projectId, commitMessage.trim()));
              setCommitMessage('');
              await loadLog(0);
            })
          }
        >
          <GitCommitHorizontal size={15} /> Commit
        </button>
      </div>

      <div className="git-section">
        <h4>Changes ({unstaged.length})</h4>
        {!unstaged.length ? (
          <p className="git-empty">No unstaged changes.</p>
        ) : (
          unstaged.map((file) => fileRow(file, 'unstaged'))
        )}
      </div>

      <div className="git-section">
        <h4>Untracked ({untracked.length})</h4>
        {!untracked.length ? (
          <p className="git-empty">No untracked files.</p>
        ) : (
          untracked.map((file) => (
            <div className="git-file-row" key={file.path}>
              <span className="git-file-name">
                <FilePlus2 size={13} />
                {file.path}
              </span>
              <button
                className="icon-button"
                aria-label={`Stage ${file.path}`}
                title="Stage"
                disabled={busy}
                onClick={() =>
                  void act(async () => setStatus(await desktop.gitStage(projectId, [file.path])))
                }
              >
                <Plus size={14} />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="git-section">
        <h4>History</h4>
        {!log.length ? (
          <p className="git-empty">No commits yet.</p>
        ) : (
          log.map((commit) => (
            <div className="git-log-row" key={commit.hash}>
              <button
                type="button"
                className="git-log-heading"
                onClick={() => toggleCommit(commit.hash)}
              >
                {openCommit === commit.hash ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )}
                <code>{commit.shortHash}</code>
                <span>{commit.subject}</span>
                <small>
                  {commit.author} · {new Date(commit.date).toLocaleString()}
                </small>
              </button>
              <div className="git-file-actions">
                <button
                  className="button secondary small"
                  disabled={busy}
                  title="Restore this commit's files into the working tree"
                  onClick={() =>
                    void act(async () => {
                      const files =
                        logDiffs[commit.hash] ??
                        (await desktop.gitDiff(projectId, { kind: 'commit', hash: commit.hash }));
                      const paths = files.map((f) => f.path);
                      if (paths.length)
                        setStatus(await desktop.gitRestoreFiles(projectId, commit.hash, paths));
                    })
                  }
                >
                  Restore files
                </button>
                <button
                  className="button secondary small"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const result = await desktop.gitRevertCommit(projectId, commit.hash);
                      if (result.conflicts.length) setMergeResult({ conflicts: result.conflicts });
                      await refreshAll();
                      await loadLog(0);
                    })
                  }
                >
                  Revert
                </button>
              </div>
              {openCommit === commit.hash && <CodeDiff files={logDiffs[commit.hash] ?? []} />}
            </div>
          ))
        )}
        {!logDone && (
          <button
            className="button secondary small"
            disabled={busy}
            onClick={() => void act(() => loadLog(log.length))}
          >
            Load more
          </button>
        )}
      </div>

      <div className="git-section">
        <h4>Branches</h4>
        {branches.map((branch) => (
          <div className="git-file-row" key={branch.name}>
            {renaming === branch.name ? (
              <>
                <input
                  type="text"
                  value={renameTo}
                  onChange={(event) => setRenameTo(event.target.value)}
                />
                <button
                  className="button secondary small"
                  disabled={busy || !renameTo.trim()}
                  onClick={() =>
                    void act(async () => {
                      await desktop.gitRenameBranch(projectId, branch.name, renameTo.trim());
                      setRenaming(null);
                      await refreshAll();
                    })
                  }
                >
                  Save
                </button>
                <button className="text-button" onClick={() => setRenaming(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span className="git-file-name">
                  <GitBranchIcon size={13} />
                  {branch.name}
                  {branch.current && ' (current)'}
                  {branch.upstream && ` → ${branch.upstream}`}
                  {(branch.ahead ?? 0) > 0 && ` ↑${branch.ahead}`}
                  {(branch.behind ?? 0) > 0 && ` ↓${branch.behind}`}
                </span>
                <div className="git-file-actions">
                  {!branch.current && (
                    <button
                      className="button secondary small"
                      disabled={busy}
                      onClick={() =>
                        void act(async () =>
                          setStatus(await desktop.gitSwitchBranch(projectId, branch.name)),
                        )
                      }
                    >
                      Switch
                    </button>
                  )}
                  <button
                    className="icon-button"
                    aria-label={`Rename ${branch.name}`}
                    title="Rename"
                    disabled={busy}
                    onClick={() => {
                      setRenaming(branch.name);
                      setRenameTo(branch.name);
                    }}
                  >
                    <FileX2 size={14} />
                  </button>
                  {!branch.current && (
                    <button
                      className="icon-button"
                      aria-label={`Delete ${branch.name}`}
                      title="Delete branch"
                      disabled={busy}
                      onClick={() =>
                        confirm(
                          `delete-branch:${branch.name}`,
                          () =>
                            void act(async () => {
                              await desktop.gitDeleteBranch(projectId, branch.name, true);
                              await refreshAll();
                            }),
                        )
                      }
                    >
                      {confirmKey === `delete-branch:${branch.name}` ? (
                        <Check size={14} />
                      ) : (
                        <Trash2 size={14} />
                      )}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
        <div className="git-inline-form">
          <input
            type="text"
            placeholder="new-branch-name"
            value={newBranch}
            onChange={(event) => setNewBranch(event.target.value)}
          />
          <label className="auto-label">
            <input
              type="checkbox"
              checked={switchOnCreate}
              onChange={(event) => setSwitchOnCreate(event.target.checked)}
            />
            <span>Switch to it</span>
          </label>
          <button
            className="button secondary small"
            disabled={busy || !newBranch.trim()}
            onClick={() =>
              void act(async () => {
                setStatus(
                  await desktop.gitCreateBranch(projectId, newBranch.trim(), switchOnCreate),
                );
                setNewBranch('');
                await refreshAll();
              })
            }
          >
            <Plus size={14} /> Create branch
          </button>
        </div>
      </div>

      <div className="git-section">
        <h4>Merge</h4>
        <div className="git-inline-form">
          <select value={mergeTarget} onChange={(event) => setMergeTarget(event.target.value)}>
            <option value="">Choose a branch…</option>
            {branches
              .filter((b) => !b.current)
              .map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
          </select>
          <button
            className="button secondary small"
            disabled={busy || !mergeTarget}
            onClick={() =>
              void act(async () => {
                const result = await desktop.gitMerge(projectId, mergeTarget);
                setMergeResult({ conflicts: result.conflicts });
                await refreshAll();
                await loadLog(0);
              })
            }
          >
            <GitMergeIcon size={15} /> Merge into current branch
          </button>
        </div>
        {mergeResult && (
          <p className={mergeResult.conflicts.length ? 'error-text' : 'settings-hint'}>
            {mergeResult.conflicts.length
              ? `Conflicts in: ${mergeResult.conflicts.join(', ')}`
              : 'Merged cleanly.'}
          </p>
        )}
      </div>

      <div className="git-section">
        <h4>Stashes</h4>
        {!stashes.length ? (
          <p className="git-empty">No stashes.</p>
        ) : (
          stashes.map((stash) => (
            <div className="git-log-row" key={stash.index}>
              <button
                type="button"
                className="git-log-heading"
                onClick={() => toggleStash(stash.index)}
              >
                {openStash === stash.index ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span>{stash.message}</span>
                <small>{new Date(stash.date).toLocaleString()}</small>
              </button>
              <div className="git-file-actions">
                <button
                  className="button secondary small"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      setStatus(await desktop.gitStashApply(projectId, stash.index, false));
                    })
                  }
                >
                  Apply
                </button>
                <button
                  className="button secondary small"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      setStatus(await desktop.gitStashApply(projectId, stash.index, true));
                      await refreshAll();
                    })
                  }
                >
                  Pop
                </button>
                <button
                  className="icon-button"
                  aria-label={`Drop stash ${stash.index}`}
                  title="Drop"
                  disabled={busy}
                  onClick={() =>
                    confirm(
                      `drop-stash:${stash.index}`,
                      () =>
                        void act(async () => {
                          await desktop.gitStashDrop(projectId, stash.index);
                          await refreshAll();
                        }),
                    )
                  }
                >
                  {confirmKey === `drop-stash:${stash.index}` ? (
                    <Check size={14} />
                  ) : (
                    <Trash2 size={14} />
                  )}
                </button>
              </div>
              {openStash === stash.index && <CodeDiff files={stashDiffs[stash.index] ?? []} />}
            </div>
          ))
        )}
        <div className="git-inline-form">
          <input
            type="text"
            placeholder="Stash message"
            value={stashMessage}
            onChange={(event) => setStashMessage(event.target.value)}
          />
          <button
            className="button secondary small"
            disabled={busy || (!staged.length && !unstaged.length && !untracked.length)}
            onClick={() =>
              void act(async () => {
                setStatus(await desktop.gitStashSave(projectId, stashMessage.trim()));
                setStashMessage('');
                await refreshAll();
              })
            }
          >
            <Package size={14} /> Stash changes
          </button>
        </div>
      </div>

      <div className="git-section">
        <h4>Remotes</h4>
        {!remotes.length ? (
          <p className="git-empty">No remotes.</p>
        ) : (
          remotes.map((remote) => (
            <div className="git-file-row" key={remote.name}>
              <span className="git-file-name">
                {remote.name} <small>{remote.fetchUrl}</small>
              </span>
              <div className="git-file-actions">
                <button
                  className="icon-button"
                  aria-label={`Fetch ${remote.name}`}
                  title="Fetch"
                  disabled={busy || !!netOp}
                  onClick={() =>
                    runNetwork('fetch', (id) => desktop.gitFetch(id, projectId, remote.name))
                  }
                >
                  <Download size={14} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Remove ${remote.name}`}
                  title="Remove"
                  disabled={busy}
                  onClick={() =>
                    confirm(
                      `remove-remote:${remote.name}`,
                      () =>
                        void act(async () => {
                          setRemotes(await desktop.gitRemoveRemote(projectId, remote.name));
                        }),
                    )
                  }
                >
                  {confirmKey === `remove-remote:${remote.name}` ? (
                    <Check size={14} />
                  ) : (
                    <Trash2 size={14} />
                  )}
                </button>
              </div>
            </div>
          ))
        )}
        <div className="git-inline-form">
          <input
            type="text"
            placeholder="origin"
            value={remoteName}
            onChange={(event) => setRemoteName(event.target.value)}
          />
          <input
            type="text"
            placeholder="git@github.com:user/repo.git"
            value={remoteUrl}
            onChange={(event) => setRemoteUrl(event.target.value)}
          />
          <button
            className="button secondary small"
            disabled={busy || !remoteName.trim() || !remoteUrl.trim()}
            onClick={() =>
              void act(async () => {
                setRemotes(
                  await desktop.gitAddRemote(projectId, remoteName.trim(), remoteUrl.trim()),
                );
                setRemoteName('');
                setRemoteUrl('');
              })
            }
          >
            <Plus size={14} /> Add remote
          </button>
        </div>
        <div className="git-network-actions">
          <button
            className="button secondary small"
            disabled={busy || !!netOp || !status.upstream}
            onClick={() =>
              runNetwork('pull', async (id) => {
                const result = await desktop.gitPull(id, projectId);
                if (result.conflicts.length) setMergeResult({ conflicts: result.conflicts });
              })
            }
          >
            <ArrowDownToLine size={15} /> Pull
          </button>
          {canPush ? (
            <button
              className="button secondary small"
              disabled={busy || !!netOp}
              onClick={() => runNetwork('push', (id) => desktop.gitPush(id, projectId))}
            >
              <ArrowUpFromLine size={15} /> Push
            </button>
          ) : (
            <>
              <select
                value={upstreamRemote}
                onChange={(event) => setUpstreamRemote(event.target.value)}
              >
                <option value="">Push to remote…</option>
                {remotes.map((remote) => (
                  <option key={remote.name} value={remote.name}>
                    {remote.name}
                  </option>
                ))}
              </select>
              <button
                className="button secondary small"
                disabled={busy || !!netOp || !upstreamRemote}
                onClick={() =>
                  runNetwork('push', (id) =>
                    desktop.gitPush(id, projectId, { setUpstream: upstreamRemote }),
                  )
                }
              >
                <Upload size={15} /> Push &amp; set upstream
              </button>
            </>
          )}
        </div>
        {netOp && (
          <div className="git-progress" role="status">
            <span>
              {netOp.operation}: {netOp.message}
              {netOp.percent !== undefined && ` (${netOp.percent}%)`}
            </span>
            {!netOp.done && (
              <button className="icon-button" aria-label="Cancel operation" onClick={cancelNetwork}>
                <Ban size={14} />
              </button>
            )}
            {netOp.error && <span className="error-text">{netOp.error}</span>}
          </div>
        )}
      </div>
    </section>
  );
}
