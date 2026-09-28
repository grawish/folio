export type GitIdentity = { name?: string; email?: string };
export type GitAvailability = {
  installed: boolean;
  version?: string;
  identity?: GitIdentity;
  message?: string;
};
export type GitChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
export type GitFileStatus = {
  path: string;
  renamedFrom?: string;
  staged: GitChangeKind | null;
  unstaged: GitChangeKind | null;
  conflicted: boolean;
};
export type GitRepoState = 'clean' | 'merging' | 'reverting';
export type GitRepoStatus = {
  root: string;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  state: GitRepoState;
  files: GitFileStatus[];
};
export type GitCommit = {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  email: string;
  date: string;
  parents: string[];
};
export type GitBranch = {
  name: string;
  current: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
};
export type GitRemote = { name: string; fetchUrl: string; pushUrl: string };
export type GitStash = { index: number; message: string; date: string };
export type GitDiffLine = {
  kind: 'context' | 'added' | 'removed';
  text: string;
  oldLine?: number;
  newLine?: number;
};
export type GitHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: GitDiffLine[];
  patch: string;
};
export type GitDiffFile = {
  path: string;
  oldPath?: string;
  kind: GitChangeKind;
  binary: boolean;
  hunks: GitHunk[];
};
export type GitDiffTarget =
  | { kind: 'unstaged'; path?: string }
  | { kind: 'staged'; path?: string }
  | { kind: 'commit'; hash: string; path?: string }
  | { kind: 'range'; from: string; to: string; path?: string };
export type GitConflictVersions = {
  path: string;
  binary: boolean;
  base?: string;
  ours?: string;
  theirs?: string;
};
export type GitMergeResult = { merged: boolean; fastForward?: boolean; conflicts: string[] };
export type GitOperationProgress = {
  id: string;
  operation: 'clone' | 'fetch' | 'pull' | 'push';
  message: string;
  percent?: number;
  done: boolean;
  error?: string;
};

export interface GitAPI {
  gitAvailability(): Promise<GitAvailability>;
  gitStatus(projectId: string): Promise<GitRepoStatus | null>;
  gitInit(projectId: string): Promise<GitRepoStatus>;
  gitClone(id: string, url: string, directory: string): Promise<string>;
  gitDiff(projectId: string, target: GitDiffTarget): Promise<GitDiffFile[]>;
  gitStage(projectId: string, paths: string[]): Promise<GitRepoStatus>;
  gitUnstage(projectId: string, paths: string[]): Promise<GitRepoStatus>;
  gitApplyPatch(
    projectId: string,
    patch: string,
    options: { cached: boolean; reverse: boolean },
  ): Promise<GitRepoStatus>;
  gitCommit(projectId: string, message: string): Promise<GitRepoStatus>;
  gitLog(projectId: string, options?: { skip?: number; limit?: number }): Promise<GitCommit[]>;
  gitRestoreFiles(projectId: string, hash: string, paths: string[]): Promise<GitRepoStatus>;
  gitRevertCommit(projectId: string, hash: string): Promise<GitMergeResult>;
  gitBranches(projectId: string): Promise<GitBranch[]>;
  gitCreateBranch(projectId: string, name: string, switchTo: boolean): Promise<GitRepoStatus>;
  gitSwitchBranch(projectId: string, name: string): Promise<GitRepoStatus>;
  gitRenameBranch(projectId: string, from: string, to: string): Promise<GitRepoStatus>;
  gitDeleteBranch(projectId: string, name: string, force: boolean): Promise<GitRepoStatus>;
  gitMerge(projectId: string, branch: string): Promise<GitMergeResult>;
  gitMergeContinue(projectId: string): Promise<GitMergeResult>;
  gitMergeAbort(projectId: string): Promise<GitRepoStatus>;
  gitConflict(projectId: string, path: string): Promise<GitConflictVersions>;
  gitResolveConflict(
    projectId: string,
    path: string,
    resolution: { content: string } | { pick: 'ours' | 'theirs' },
  ): Promise<GitRepoStatus>;
  gitStashes(projectId: string): Promise<GitStash[]>;
  gitStashSave(projectId: string, message: string): Promise<GitRepoStatus>;
  gitStashShow(projectId: string, index: number): Promise<GitDiffFile[]>;
  gitStashApply(projectId: string, index: number, pop: boolean): Promise<GitRepoStatus>;
  gitStashDrop(projectId: string, index: number): Promise<GitRepoStatus>;
  gitRemotes(projectId: string): Promise<GitRemote[]>;
  gitAddRemote(projectId: string, name: string, url: string): Promise<GitRemote[]>;
  gitRemoveRemote(projectId: string, name: string): Promise<GitRemote[]>;
  gitFetch(id: string, projectId: string, remote?: string): Promise<void>;
  gitPull(id: string, projectId: string): Promise<GitMergeResult>;
  gitPush(id: string, projectId: string, options?: { setUpstream?: string }): Promise<void>;
  gitCancel(id: string): Promise<void>;
  onGitProgress(callback: (event: GitOperationProgress) => void): () => void;
}
