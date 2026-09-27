import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const storeName = '.folio-build-jobs-v1';
const jobName =
  /^(job|removing)-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const ownerName = 'owner.json';
const ownerKeys = ['schema', 'id', 'pid', 'storeDevice', 'storeInode', 'jobDevice', 'jobInode'];
type Owner = {
  schema: 'folio-build-job-1';
  id: string;
  pid: number;
  storeDevice: string;
  storeInode: string;
  jobDevice: string;
  jobInode: string;
};
export type BuildCleanup = {
  removed: number;
  active: number;
  unrecognized: number;
  failed: number;
};

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const sameFile = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) =>
  a.dev === b.dev && a.ino === b.ino;
const owned = (stat: { uid: bigint }) => !process.getuid || stat.uid === BigInt(process.getuid());
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission errors and other uncertainty must retain the job. Reused live
    // PIDs also retain old jobs; guessing that a process is unrelated is unsafe.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};
async function directory(folder: string) {
  const stat = await fs.lstat(folder, { bigint: true });
  if (!stat.isDirectory() || !owned(stat)) throw new Error('Unrecognized build directory.');
  return stat;
}
async function store(root: string, create: boolean) {
  if (create) await fs.mkdir(root, { recursive: true });
  const base = await fs.realpath(root);
  const folder = path.join(base, storeName);
  if (create)
    await fs.mkdir(folder, { mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
  const identity = await directory(folder);
  return { folder, identity };
}

async function inspect(folder: string, name: string) {
  const match = jobName.exec(name);
  if (!match) throw new Error('Unrecognized build name.');
  const root = await directory(folder);
  const job = path.join(folder, name);
  const identity = await directory(job);
  const names = await fs.readdir(job);
  if (!names.includes(ownerName) || names.some((entry) => entry !== ownerName && entry !== 'files'))
    throw new Error('Unrecognized build contents.');
  const ownerPath = path.join(job, ownerName);
  const file = await fs.open(
    ownerPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let owner: Owner;
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || !owned(info) || info.nlink !== 1n || info.size > 2048n)
      throw new Error('Unrecognized build owner.');
    // A fixed buffer also bounds a file that grows after fstat.
    const bytes = Buffer.alloc(2049);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 2048) throw new Error('Unrecognized build owner.');
    owner = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) as Owner;
    if (
      !owner ||
      typeof owner !== 'object' ||
      Array.isArray(owner) ||
      Object.keys(owner).length !== ownerKeys.length ||
      ownerKeys.some((key) => !(key in owner)) ||
      owner.schema !== 'folio-build-job-1' ||
      owner.id !== match[2] ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 2 ||
      owner.pid > 2_147_483_647 ||
      owner.storeDevice !== root.dev.toString() ||
      owner.storeInode !== root.ino.toString() ||
      owner.jobDevice !== identity.dev.toString() ||
      owner.jobInode !== identity.ino.toString()
    )
      throw new Error('Unrecognized build owner.');
    if (!sameFile(info, await fs.lstat(ownerPath, { bigint: true })))
      throw new Error('Build ownership changed.');
  } finally {
    await file.close();
  }
  if (names.includes('files')) await directory(path.join(job, 'files'));
  if (!sameFile(root, await directory(folder)) || !sameFile(identity, await directory(job)))
    throw new Error('Build directory changed.');
  return { job, identity, owner };
}

async function remove(folder: string, name: string, expected?: Owner) {
  const initial = await inspect(folder, name);
  if (
    expected ? JSON.stringify(initial.owner) !== JSON.stringify(expected) : alive(initial.owner.pid)
  )
    return false;
  let claimed = name;
  if (name.startsWith('job-')) {
    claimed = `removing-${initial.owner.id}`;
    try {
      await fs.lstat(path.join(folder, claimed));
      throw new Error('Build cleanup destination already exists.');
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await fs.rename(initial.job, path.join(folder, claimed));
  }
  // Retain any replacement instead of recursively deleting an unchecked path.
  // The ownership record lives above the compiler's writable files directory.
  const current = await inspect(folder, claimed);
  if (
    !sameFile(initial.identity, current.identity) ||
    JSON.stringify(initial.owner) !== JSON.stringify(current.owner) ||
    (!expected && alive(current.owner.pid))
  )
    throw new Error('Build changed before cleanup.');
  await fs.rm(path.join(current.job, 'files'), { recursive: true, force: true });
  await fs.unlink(path.join(current.job, ownerName));
  // Never recursively remove the owner folder: an unexpected newly added file
  // must survive even if it arrived after the contents check.
  await fs.rmdir(current.job);
  return true;
}

export async function cleanupBuildWorkspaces(root: string): Promise<BuildCleanup> {
  const result: BuildCleanup = { removed: 0, active: 0, unrecognized: 0, failed: 0 };
  let workspace;
  try {
    workspace = await store(root, false);
  } catch (error) {
    if (missing(error)) return result;
    throw error;
  }
  const entries = await fs.opendir(workspace.folder);
  for await (const entry of entries) {
    if (!entry.isDirectory() || !jobName.test(entry.name)) {
      result.unrecognized++;
      continue;
    }
    try {
      if (entry.name.startsWith('removing-')) {
        const folder = path.join(workspace.folder, entry.name);
        await directory(folder);
        if ((await fs.readdir(folder)).length === 0) {
          // A crash after unlinking the record can leave an empty removal
          // folder. rmdir is atomic and refuses any newly added contents.
          await fs.rmdir(folder);
          result.removed++;
          continue;
        }
      }
      const checked = await inspect(workspace.folder, entry.name);
      if (alive(checked.owner.pid)) {
        result.active++;
        continue;
      }
      if (await remove(workspace.folder, entry.name)) result.removed++;
      else result.active++;
    } catch (error) {
      // Another cleanup may already have finished this job. Unknown or changed
      // data is left intact for review rather than making compilation fail.
      if (!missing(error)) result.failed++;
    }
  }
  return result;
}

export class BuildWorkspaces {
  readonly recovery: Promise<BuildCleanup>;
  constructor(readonly root: string) {
    // Start on app/compiler initialization, independently of runtime readiness.
    // Compilation waits for this scan; editing and saving do not.
    this.recovery = cleanupBuildWorkspaces(root).catch(() => ({
      removed: 0,
      active: 0,
      unrecognized: 0,
      failed: 1,
    }));
  }
  async create() {
    await this.recovery;
    const workspace = await store(this.root, true);
    const id = randomUUID();
    const name = `job-${id}`;
    const job = path.join(workspace.folder, name);
    await fs.mkdir(job, { mode: 0o700 });
    const identity = await directory(job);
    const owner: Owner = {
      schema: 'folio-build-job-1',
      id,
      pid: process.pid,
      storeDevice: workspace.identity.dev.toString(),
      storeInode: workspace.identity.ino.toString(),
      jobDevice: identity.dev.toString(),
      jobInode: identity.ino.toString(),
    };
    const files = path.join(job, 'files');
    try {
      // Finish the ownership record before allowing any source to be staged.
      await fs.writeFile(path.join(job, ownerName), JSON.stringify(owner) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      await fs.mkdir(files, { mode: 0o700 });
    } catch (error) {
      // A valid record lets us clear a failed allocation immediately. A torn
      // record remains unrecognized; no source has been staged at that point.
      await remove(workspace.folder, name, owner).catch(() => {});
      throw error;
    }
    return { path: files, release: () => remove(workspace.folder, name, owner) };
  }
}
