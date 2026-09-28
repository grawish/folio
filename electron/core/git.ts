import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeId } from './workspace';
import type {
  GitAvailability,
  GitBranch,
  GitChangeKind,
  GitCommit,
  GitConflictVersions,
  GitDiffFile,
  GitDiffLine,
  GitDiffTarget,
  GitFileStatus,
  GitHunk,
  GitMergeResult,
  GitOperationProgress,
  GitRemote,
  GitRepoState,
  GitRepoStatus,
  GitStash,
} from '../../src/shared/git';

type Dependencies = {
  directory(id: string): string | undefined;
  progress(event: GitOperationProgress): void;
};

// External refs (hashes, branch names, remote names/urls) travel as their own
// argv element, never through a shell, so the only risk is git mistaking a
// leading '-' for an option. Free-text (commit/stash messages) has no such risk.
function safeArg(value: unknown, label = 'value'): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 512 ||
    /[\x00-\x1f]/.test(value) ||
    value.startsWith('-')
  )
    throw new Error(`Invalid ${label}.`);
  return value;
}
function safeText(value: unknown, label = 'value', max = 10_000): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x08\x0b-\x1f]/.test(value))
    throw new Error(`Invalid ${label}.`);
  return value;
}
// Repo-relative pathspec. Never absolute, never escapes the worktree; a
// leading '-' is safe here because every path list is passed after `--`.
function gitPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00\n]/.test(value))
    throw new Error('Invalid repository path.');
  const posix = value.replace(/\\/g, '/');
  const segments = posix.split('/');
  if (
    path.posix.isAbsolute(posix) ||
    /^[a-zA-Z]:/.test(value) ||
    segments.some((s) => s === '..') ||
    segments[0] === '.git'
  )
    throw new Error('Use a repository-relative path without parent-directory references.');
  return value;
}
function stashRef(index: unknown): string {
  if (!Number.isSafeInteger(index) || (index as number) < 0) throw new Error('Invalid stash index.');
  return `stash@{${index}}`;
}

function changeKind(letter: string): GitChangeKind | null {
  switch (letter) {
    case '.':
      return null;
    case 'M':
    case 'T':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    default:
      return 'modified';
  }
}

type RunOptions = {
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  allowFailure?: boolean;
  onStderr?: (chunk: string) => void;
};
type RunResult = { code: number; stdout: string; stderr: string };

function run(cwd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    let killedReason: 'cancelled' | 'timeout' | undefined;
    const stop = () => child.kill('SIGKILL');
    const onAbort = () => {
      killedReason = 'cancelled';
      stop();
    };
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            killedReason = 'timeout';
            stop();
          }, timeoutMs)
        : undefined;
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      options.onStderr?.(text);
    });
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.on('close', (code) => {
      cleanup();
      if (killedReason === 'cancelled') return reject(new Error('Operation cancelled.'));
      if (killedReason === 'timeout')
        return reject(
          new Error(`Git operation exceeded the ${Math.ceil(timeoutMs / 1000)}-second time limit.`),
        );
      const result = { code: code ?? -1, stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr };
      if (result.code !== 0 && !options.allowFailure)
        return reject(new Error(stderr.trim() || `git ${args[0]} failed.`));
      resolve(result);
    });
    if (options.input !== undefined) child.stdin.end(options.input, 'utf8');
    else child.stdin.end();
  });
}

function parseProgressLine(line: string): { message: string; percent?: number } | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const withPercent = trimmed.match(/^([A-Za-z][A-Za-z ]*):\s+(\d{1,3})%/);
  if (withPercent) return { message: withPercent[1].trim(), percent: Number(withPercent[2]) };
  const plain = trimmed.match(/^([A-Za-z][A-Za-z ]*):/);
  return { message: plain ? plain[1].trim() : trimmed };
}

// Parses `diff --git` unified output (from `diff`, `diff --cached`, `show`,
// `diff-tree`, or `stash show -p`) into structured files/hunks, keeping each
// hunk's full file header alongside its body so `hunk.patch` alone is
// apply-able via `git apply --cached [-R] -p1`.
function parseDiff(text: string): GitDiffFile[] {
  if (!text) return [];
  const lines = text.split('\n');
  const files: GitDiffFile[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith('diff --git ')) {
      i++;
      continue;
    }
    const gitLine = lines[i].match(/^diff --git a\/(.+) b\/(.+)$/);
    let path_ = gitLine?.[2] ?? '';
    let oldPath: string | undefined;
    let kind: GitChangeKind = 'modified';
    let binary = false;
    const headerLines: string[] = [lines[i]];
    i++;
    while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git ')) {
      const line = lines[i];
      headerLines.push(line);
      if (line.startsWith('new file mode')) kind = 'added';
      else if (line.startsWith('deleted file mode')) kind = 'deleted';
      else if (line.startsWith('rename from ')) {
        kind = 'renamed';
        oldPath = line.slice('rename from '.length);
      } else if (line.startsWith('rename to ')) {
        kind = 'renamed';
        path_ = line.slice('rename to '.length);
      } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') binary = true;
      i++;
    }
    const hunks: GitHunk[] = [];
    while (i < lines.length && lines[i].startsWith('@@')) {
      const headerMatch = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/);
      const header = lines[i];
      const oldStart = headerMatch ? Number(headerMatch[1]) : 0;
      const oldLines = headerMatch ? Number(headerMatch[2] ?? '1') : 0;
      const newStart = headerMatch ? Number(headerMatch[3]) : 0;
      const newLines = headerMatch ? Number(headerMatch[4] ?? '1') : 0;
      const bodyLines: string[] = [header];
      const diffLines: GitDiffLine[] = [];
      let oldCounter = oldStart;
      let newCounter = newStart;
      i++;
      while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git ')) {
        const line = lines[i];
        if (line === '' && i === lines.length - 1) {
          i++;
          continue;
        }
        bodyLines.push(line);
        if (line.startsWith('\\')) {
          i++;
          continue;
        }
        const marker = line[0];
        const text_ = line.slice(1);
        if (marker === ' ') diffLines.push({ kind: 'context', text: text_, oldLine: oldCounter++, newLine: newCounter++ });
        else if (marker === '+') diffLines.push({ kind: 'added', text: text_, newLine: newCounter++ });
        else if (marker === '-') diffLines.push({ kind: 'removed', text: text_, oldLine: oldCounter++ });
        i++;
      }
      const patch = [...headerLines, ...bodyLines].join('\n') + '\n';
      hunks.push({ header, oldStart, oldLines, newStart, newLines, lines: diffLines, patch });
    }
    files.push({ path: path_, oldPath, kind, binary, hunks });
  }
  return files;
}

export class GitService {
  private readonly operations = new Map<string, AbortController>();
  constructor(private readonly deps: Dependencies) {}

  private resolveRoot(projectId: string): string {
    const directory = this.deps.directory(safeId(projectId));
    if (!directory) throw new Error('Save this project before using Git.');
    return directory;
  }
  private async isRepo(root: string): Promise<boolean> {
    const result = await run(root, ['rev-parse', '--git-dir'], { allowFailure: true });
    return result.code === 0;
  }
  private async repoState(root: string): Promise<GitRepoState> {
    const gitPathOf = async (name: string) => {
      const result = await run(root, ['rev-parse', '--git-path', name], { allowFailure: true });
      if (result.code !== 0) return false;
      try {
        await fs.access(path.resolve(root, result.stdout.trim()));
        return true;
      } catch {
        return false;
      }
    };
    if (await gitPathOf('MERGE_HEAD')) return 'merging';
    if (await gitPathOf('REVERT_HEAD')) return 'reverting';
    return 'clean';
  }

  async gitAvailability(): Promise<GitAvailability> {
    let version: string | undefined;
    try {
      const result = await run(process.cwd(), ['--version'], { allowFailure: true });
      if (result.code !== 0) return { installed: false, message: result.stderr.trim() || 'Git is not available.' };
      version = result.stdout.trim().replace(/^git version /, '');
    } catch {
      return { installed: false, message: 'Git is not installed or not on PATH.' };
    }
    const [name, email] = await Promise.all([
      run(process.cwd(), ['config', '--get', 'user.name'], { allowFailure: true }),
      run(process.cwd(), ['config', '--get', 'user.email'], { allowFailure: true }),
    ]);
    const identity =
      name.stdout.trim() || email.stdout.trim()
        ? { name: name.stdout.trim() || undefined, email: email.stdout.trim() || undefined }
        : undefined;
    return { installed: true, version, identity };
  }

  async status(root: string): Promise<GitRepoStatus> {
    const result = await run(root, ['status', '--porcelain=v2', '--branch', '-z']);
    const tokens = result.stdout.split('\0');
    if (tokens[tokens.length - 1] === '') tokens.pop();
    let branch: string | null = null;
    let detached = false;
    let upstream: string | null = null;
    let ahead = 0;
    let behind = 0;
    const files: GitFileStatus[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.startsWith('# ')) {
        const rest = token.slice(2);
        if (rest.startsWith('branch.head ')) {
          const head = rest.slice('branch.head '.length);
          if (head === '(detached)') {
            detached = true;
            branch = null;
          } else branch = head;
        } else if (rest.startsWith('branch.upstream ')) upstream = rest.slice('branch.upstream '.length);
        else if (rest.startsWith('branch.ab ')) {
          const m = rest.match(/\+(\d+) -(\d+)/);
          if (m) {
            ahead = Number(m[1]);
            behind = Number(m[2]);
          }
        }
        continue;
      }
      if (token.startsWith('1 ')) {
        const m = token.match(/^1 (.)(.) \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/);
        if (!m) continue;
        files.push({ path: m[3], staged: changeKind(m[1]), unstaged: changeKind(m[2]), conflicted: false });
      } else if (token.startsWith('2 ')) {
        const m = token.match(/^2 (.)(.) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/);
        if (!m) continue;
        const origPath = tokens[++i];
        files.push({
          path: m[3],
          renamedFrom: origPath,
          staged: changeKind(m[1]),
          unstaged: changeKind(m[2]),
          conflicted: false,
        });
      } else if (token.startsWith('u ')) {
        const m = token.match(/^u (.)(.) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/);
        if (!m) continue;
        files.push({ path: m[3], staged: null, unstaged: null, conflicted: true });
      } else if (token.startsWith('? ')) {
        files.push({ path: token.slice(2), staged: null, unstaged: 'untracked', conflicted: false });
      }
    }
    const state = await this.repoState(root);
    return { root, branch, detached, upstream, ahead, behind, state, files };
  }

  async gitStatus(projectId: string): Promise<GitRepoStatus | null> {
    const root = this.resolveRoot(projectId);
    if (!(await this.isRepo(root))) return null;
    return this.status(root);
  }

  async gitInit(projectId: string): Promise<GitRepoStatus> {
    const root = this.resolveRoot(projectId);
    await run(root, ['init']);
    return this.status(root);
  }

  async gitDiff(projectId: string, target: GitDiffTarget): Promise<GitDiffFile[]> {
    const root = this.resolveRoot(projectId);
    const pathArgs = target.path ? ['--', gitPath(target.path)] : [];
    if (target.kind === 'unstaged') {
      const tracked = await run(root, ['diff', '--no-color', '-M', ...pathArgs]);
      const files = parseDiff(tracked.stdout);
      const status = await this.status(root);
      const untracked = status.files.filter(
        (f) => f.unstaged === 'untracked' && (!target.path || f.path === target.path),
      );
      for (const entry of untracked) {
        const result = await run(root, ['diff', '--no-color', '--no-index', '--', '/dev/null', entry.path], {
          allowFailure: true,
        });
        const parsed = parseDiff(result.stdout);
        for (const file of parsed) file.kind = 'untracked';
        files.push(...parsed);
      }
      return files;
    }
    if (target.kind === 'staged') {
      const result = await run(root, ['diff', '--no-color', '--cached', '-M', ...pathArgs]);
      return parseDiff(result.stdout);
    }
    if (target.kind === 'commit') {
      const result = await run(root, [
        'show',
        '--no-color',
        '--format=',
        '-M',
        safeArg(target.hash, 'commit'),
        ...pathArgs,
      ]);
      return parseDiff(result.stdout);
    }
    const result = await run(root, [
      'diff',
      '--no-color',
      '-M',
      safeArg(target.from, 'revision'),
      safeArg(target.to, 'revision'),
      ...pathArgs,
    ]);
    return parseDiff(result.stdout);
  }

  async gitStage(projectId: string, paths: string[]): Promise<GitRepoStatus> {
    const root = this.resolveRoot(projectId);
    const relative = paths.map((p) => gitPath(p));
    if (relative.length) await run(root, ['add', '--', ...relative]);
    return this.status(root);
  }

  async gitUnstage(projectId: string, paths: string[]): Promise<GitRepoStatus> {
    const root = this.resolveRoot(projectId);
    const relative = paths.map((p) => gitPath(p));
    // `restore --staged` also safely no-ops on paths that are untracked (never
    // staged) or that have no commit yet, so callers never need to branch on kind.
    if (relative.length)
      await run(root, ['restore', '--staged', '--', ...relative], { allowFailure: true });
    return this.status(root);
  }

  async gitApplyPatch(
    projectId: string,
    patch: string,
    options: { cached: boolean; reverse: boolean },
  ): Promise<GitRepoStatus> {
    const root = this.resolveRoot(projectId);
    const args = ['apply', '-p1'];
    if (options.cached) args.push('--cached');
    if (options.reverse) args.push('--reverse');
    args.push('-');
    await run(root, args, { input: safeText(patch, 'patch', 5_000_000) });
    return this.status(root);
  }

  async gitCommit(projectId: string, message: string): Promise<GitRepoStatus> {
    const root = this.resolveRoot(projectId);
    await run(root, ['commit', '-F', '-'], { input: safeText(message, 'commit message', 20_000) });
    return this.status(root);
  }

  async gitLog(
    projectId: string,
    options?: { skip?: number; limit?: number },
  ): Promise<GitCommit[]> {
    const root = this.resolveRoot(projectId);
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 1000);
    const skip = Math.max(options?.skip ?? 0, 0);
    const result = await run(
      root,
      [
        'log',
        `--skip=${skip}`,
        `-n${limit}`,
        '--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%aI%x00%P%x1e',
      ],
      { allowFailure: true },
    );
    if (result.code !== 0) return [];
    return result.stdout
      .split('\x1e')
      .map((record) => record.replace(/^\n/, ''))
      .filter((record) => record.trim().length)
      .map((record) => {
        const [hash, shortHash, subject, author, email, date, parents] = record.split('\x00');
        return {
          hash,
          shortHash,
          subject,
          author,
          email,
          date,
          parents: parents ? parents.split(' ').filter(Boolean) : [],
        };
      });
  }

  async gitRestoreFiles(projectId: string, hash: string, paths: string[]): Promise<GitRepoStatus> {
    const root = this.resolveRoot(projectId);
    const relative = paths.map((p) => gitPath(p));
    if (relative.length)
      await run(root, ['restore', '--source', safeArg(hash, 'commit'), '--', ...relative]);
    return this.status(root);
  }

  async gitRevertCommit(projectId: string, hash: string): Promise<GitMergeResult> {
    const root = this.resolveRoot(projectId);
    const result = await run(root, ['revert', '--no-edit', safeArg(hash, 'commit')], {
      allowFailure: true,
    });
    if (result.code === 0) return { merged: true, conflicts: [] };
    const status = await this.status(root);
    if (status.state !== 'reverting')
      throw new Error(result.stderr.trim() || 'Revert failed.');
    return { merged: false, conflicts: status.files.filter((f) => f.conflicted).map((f) => f.path) };
  }

  async gitBranches(projectId: string): Promise<GitBranch[]> {
    const root = this.resolveRoot(projectId);
    const result = await run(
      root,
      [
        'for-each-ref',
        "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)",
        'refs/heads/',
      ],
      { allowFailure: true },
    );
    if (result.code !== 0) return [];
    return result.stdout
      .split('\n')
      .filter((line) => line.length)
      .map((line) => {
        const [name, head, upstream, track] = line.split('\x00');
        const ahead = track.match(/ahead (\d+)/);
        const behind = track.match(/behind (\d+)/);
        return {
          name,
          current: head === '*',
          upstream: upstream || undefined,
          ahead: ahead ? Number(ahead[1]) : undefined,
          behind: behind ? Number(behind[1]) : undefined,
        };
      });
  }

  async gitCreateBranch(
    projectId: string,
    name: string,
    switchTo: boolean,
  ): Promise<GitRepoStatus> {
    const root = this.resolveRoot(projectId);
    const branchName = safeArg(name, 'branch name');
    await run(root, switchTo ? ['checkout', '-b', branchName] : ['branch', branchName]);
    return this.status(root);
  }

  async gitSwitchBranch(projectId: string, name: string): Promise<GitRepoStatus> {
    const root = this.resolveRoot(projectId);
    await run(root, ['checkout', safeArg(name, 'branch name')]);
    return this.status(root);
  }

  async gitRenameBranch(projectId: string, from: string, to: string): Promise<GitRepoStatus> {
    const root = this.resolveRoot(projectId);
    await run(root, ['branch', '-m', safeArg(from, 'branch name'), safeArg(to, 'branch name')]);
    return this.status(root);
  }

  async gitDeleteBranch(
    projectId: string,
    name: string,
    force: boolean,
  ): Promise<GitRepoStatus> {
    const root = this.resolveRoot(projectId);
    await run(root, ['branch', force ? '-D' : '-d', safeArg(name, 'branch name')]);
    return this.status(root);
  }

  private async mergeConflicts(root: string): Promise<string[]> {
    const status = await this.status(root);
    return status.files.filter((f) => f.conflicted).map((f) => f.path);
  }

  async gitMerge(projectId: string, branch: string): Promise<GitMergeResult> {
    const root = this.resolveRoot(projectId);
    const result = await run(root, ['merge', '--no-edit', safeArg(branch, 'branch name')], {
      allowFailure: true,
    });
    if (result.code === 0)
      return { merged: true, fastForward: /(?:^|\n)Fast-forward/.test(result.stdout), conflicts: [] };
    const conflicts = await this.mergeConflicts(root);
    if (!conflicts.length) throw new Error(result.stderr.trim() || 'Merge failed.');
    return { merged: false, conflicts };
  }

  async gitMergeContinue(projectId: string): Promise<GitMergeResult> {
    const root = this.resolveRoot(projectId);
    const result = await run(root, ['commit', '--no-edit'], { allowFailure: true });
    if (result.code === 0) return { merged: true, conflicts: [] };
    const conflicts = await this.mergeConflicts(root);
    if (conflicts.length) return { merged: false, conflicts };
    throw new Error(result.stderr.trim() || 'Resolve every conflict before continuing.');
  }

  async gitMergeAbort(projectId: string): Promise<GitRepoStatus> {
    const root = this.resolveRoot(projectId);
    const state = await this.repoState(root);
    await run(root, [state === 'reverting' ? 'revert' : 'merge', '--abort']);
    return this.status(root);
  }

  private async showBlob(
    root: string,
    spec: string,
  ): Promise<{ content?: string; binary: boolean } | undefined> {
    const result = await run(root, ['show', spec], { allowFailure: true });
    if (result.code !== 0) return undefined;
    const binary = result.stdout.includes('\0');
    return binary ? { binary: true } : { content: result.stdout, binary: false };
  }

  async gitConflict(projectId: string, filePath: string): Promise<GitConflictVersions> {
    const root = this.resolveRoot(projectId);
    const relative = gitPath(filePath);
    const [base, ours, theirs] = await Promise.all([
      this.showBlob(root, `:1:${relative}`),
      this.showBlob(root, `:2:${relative}`),
      this.showBlob(root, `:3:${relative}`),
    ]);
    const binary = !!(base?.binary || ours?.binary || theirs?.binary);
    return { path: relative, binary, base: base?.content, ours: ours?.content, theirs: theirs?.content };
  }

  async gitResolveConflict(
    projectId: string,
    filePath: string,
    resolution: { content: string } | { pick: 'ours' | 'theirs' },
  ): Promise<GitRepoStatus> {
    const root = this.resolveRoot(projectId);
    const relative = gitPath(filePath);
    if ('pick' in resolution) await run(root, ['checkout', `--${resolution.pick}`, '--', relative]);
    else await fs.writeFile(path.join(root, relative), resolution.content, 'utf8');
    await run(root, ['add', '--', relative]);
    return this.status(root);
  }

  async gitStashes(projectId: string): Promise<GitStash[]> {
    const root = this.resolveRoot(projectId);
    const result = await run(root, ['stash', 'list', '--format=%gd%x00%s%x00%aI%x1e'], {
      allowFailure: true,
    });
    if (result.code !== 0) return [];
    return result.stdout
      .split('\x1e')
      .map((record) => record.replace(/^\n/, ''))
      .filter((record) => record.trim().length)
      .map((record) => {
        const [ref, message, date] = record.split('\x00');
        const index = Number(ref.match(/\{(\d+)\}/)?.[1] ?? 0);
        return { index, message, date };
      });
  }

  async gitStashSave(projectId: string, message: string): Promise<GitRepoStatus> {
    const root = this.resolveRoot(projectId);
    await run(root, ['stash', 'push', '-u', '-m', safeText(message, 'stash message', 1000)]);
    return this.status(root);
  }

  async gitStashShow(projectId: string, index: number): Promise<GitDiffFile[]> {
    const root = this.resolveRoot(projectId);
    const result = await run(root, ['stash', 'show', '-p', '-u', '--no-color', stashRef(index)]);
    return parseDiff(result.stdout);
  }

  async gitStashApply(projectId: string, index: number, pop: boolean): Promise<GitRepoStatus> {
    const root = this.resolveRoot(projectId);
    await run(root, ['stash', pop ? 'pop' : 'apply', stashRef(index)]);
    return this.status(root);
  }

  async gitStashDrop(projectId: string, index: number): Promise<GitRepoStatus> {
    const root = this.resolveRoot(projectId);
    await run(root, ['stash', 'drop', stashRef(index)]);
    return this.status(root);
  }

  async gitRemotes(projectId: string): Promise<GitRemote[]> {
    const root = this.resolveRoot(projectId);
    const result = await run(root, ['remote', '-v'], { allowFailure: true });
    if (result.code !== 0) return [];
    const byName = new Map<string, GitRemote>();
    for (const line of result.stdout.split('\n')) {
      const m = line.match(/^(\S+)\t(\S+) \((fetch|push)\)$/);
      if (!m) continue;
      const remote = byName.get(m[1]) ?? { name: m[1], fetchUrl: '', pushUrl: '' };
      if (m[3] === 'fetch') remote.fetchUrl = m[2];
      else remote.pushUrl = m[2];
      byName.set(m[1], remote);
    }
    return [...byName.values()];
  }

  async gitAddRemote(projectId: string, name: string, url: string): Promise<GitRemote[]> {
    const root = this.resolveRoot(projectId);
    await run(root, ['remote', 'add', safeArg(name, 'remote name'), safeText(url, 'remote URL', 2000)]);
    return this.gitRemotes(projectId);
  }

  async gitRemoveRemote(projectId: string, name: string): Promise<GitRemote[]> {
    const root = this.resolveRoot(projectId);
    await run(root, ['remote', 'remove', safeArg(name, 'remote name')]);
    return this.gitRemotes(projectId);
  }

  private trackOperation(id: string): AbortController {
    if (this.operations.has(id)) throw new Error('An operation with this id is already running.');
    const controller = new AbortController();
    this.operations.set(id, controller);
    return controller;
  }

  private emitProgress(id: string, operation: GitOperationProgress['operation'], line: string) {
    const parsed = parseProgressLine(line.replace(/^remote: /, ''));
    if (!parsed) return;
    this.deps.progress({ id, operation, message: parsed.message, percent: parsed.percent, done: false });
  }

  private async runWithProgress(
    id: string,
    operation: GitOperationProgress['operation'],
    cwd: string,
    args: string[],
  ): Promise<RunResult> {
    const controller = this.trackOperation(id);
    let buffer = '';
    const onStderr = (chunk: string) => {
      buffer += chunk;
      const segments = buffer.split(/\r\n|\r|\n/);
      buffer = segments.pop() ?? '';
      for (const segment of segments) this.emitProgress(id, operation, segment);
    };
    try {
      const result = await run(cwd, args, { signal: controller.signal, timeoutMs: 0, onStderr });
      if (buffer) this.emitProgress(id, operation, buffer);
      this.deps.progress({ id, operation, message: 'Done', done: true });
      return result;
    } catch (error) {
      const message = (error as Error).message;
      this.deps.progress({ id, operation, message, done: true, error: message });
      throw error;
    } finally {
      this.operations.delete(id);
    }
  }

  async gitClone(id: string, url: string, directory: string): Promise<string> {
    safeId(id);
    const target = safeText(directory, 'directory', 4096);
    if (!path.isAbsolute(target)) throw new Error('Choose an absolute directory for the clone.');
    const parent = await fs.realpath(path.dirname(target));
    const resolved = path.join(parent, path.basename(target));
    await this.runWithProgress(id, 'clone', parent, [
      'clone',
      '--progress',
      '--',
      safeText(url, 'repository URL', 2000),
      resolved,
    ]);
    return resolved;
  }

  async gitFetch(id: string, projectId: string, remote?: string): Promise<void> {
    safeId(id);
    const root = this.resolveRoot(projectId);
    const args = ['fetch', '--progress'];
    if (remote) args.push('--', safeArg(remote, 'remote name'));
    await this.runWithProgress(id, 'fetch', root, args);
  }

  async gitPull(id: string, projectId: string): Promise<GitMergeResult> {
    safeId(id);
    const root = this.resolveRoot(projectId);
    try {
      const result = await this.runWithProgress(id, 'pull', root, ['pull', '--progress', '--ff-only']);
      return { merged: true, fastForward: /(?:^|\n)Fast-forward/.test(result.stdout), conflicts: [] };
    } catch (error) {
      // A fetch that succeeds but can't fast-forward leaves the working tree and
      // remote-tracking ref updated with no local changes and no conflicts, so the
      // UI can offer an explicit `gitMerge` against the (now current) upstream.
      if (/not possible to fast-forward/i.test((error as Error).message))
        return { merged: false, conflicts: [] };
      throw error;
    }
  }

  async gitPush(id: string, projectId: string, options?: { setUpstream?: string }): Promise<void> {
    safeId(id);
    const root = this.resolveRoot(projectId);
    const args = ['push', '--progress'];
    if (options?.setUpstream)
      args.push('--set-upstream', 'origin', safeArg(options.setUpstream, 'branch name'));
    await this.runWithProgress(id, 'push', root, args);
  }

  async gitCancel(id: string): Promise<void> {
    this.operations.get(safeId(id))?.abort();
  }
}
