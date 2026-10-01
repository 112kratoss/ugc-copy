import 'server-only';

import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, readdir, rm, rmdir, unlink, statfs, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { flockSync } from 'fs-ext';

export const STAGING_ROOT_NAME = 'magicbooklet-staging-v1';
const MARKER = 'magicbooklet-staging-v1\n';
const NAME = /^item-[a-zA-Z0-9]{6}$/;
const RECLAIM_LIMIT = 128;
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const privateDirectory = (stat: Stats) => stat.isDirectory()
  && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;

async function rootDirectory() {
  const root = path.join(tmpdir(), STAGING_ROOT_NAME);
  try { await mkdir(root, { mode: 0o700 }); }
  catch (error) { if (code(error) !== 'EEXIST') throw error; }
  if (!privateDirectory(await lstat(root))) throw new Error('Unsafe staging workspace root.');
  return root;
}

async function localLockFilesystem(root: string) {
  const { type } = await statfs(root);
  // Only local filesystems whose inherited flock semantics are supported here.
  // Unknown/network filesystems can still stage; they are never swept.
  return process.platform === 'linux'
    ? [0x01021994, 0x794c7630, 0xef53].includes(type) // tmpfs, overlayfs, ext4
    : process.platform === 'darwin' && type === 0x1a; // APFS
}

/** Open without following a link, and retain the descriptor for identity checks. */
async function openRegular(file: string) {
  const handle = await open(file, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) {
      throw new Error('Unsafe staging workspace file.');
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function reclaim(directory: string, requireMarker: boolean): Promise<boolean> {
  let lease: FileHandle | undefined;
  try {
    if (requireMarker) {
      // Incomplete allocations can persist indefinitely. Reject them with one
      // metadata read instead of opening/locking every lease on each scan.
      // This is only a fast rejection; authority is rechecked under the lock.
      let marker: Stats;
      try { marker = await lstat(path.join(directory, 'ready')); }
      catch (error) { if (code(error) === 'ENOENT') return false; throw error; }
      if (!marker.isFile() || marker.size !== Buffer.byteLength(MARKER)) return false;
    }
    const before = await lstat(directory);
    if (!privateDirectory(before)) return false;
    lease = await openRegular(path.join(directory, 'lease'));
    // Never unlock this description explicitly. A child may share an owner's
    // description; reclamation always opens a separate one and closes it.
    try { flockSync(lease.fd, 'exnb'); }
    catch (error) { if (['EAGAIN', 'EWOULDBLOCK'].includes(code(error) ?? '')) return false; throw error; }
    if (!sameFile(before, await lstat(directory))
      || !sameFile(await lease.stat(), await lstat(path.join(directory, 'lease')))) return false;
    if (requireMarker) {
      const marker = await openRegular(path.join(directory, 'ready'));
      try {
        if ((await marker.stat()).size !== Buffer.byteLength(MARKER)
          || (await marker.readFile('utf8')) !== MARKER) return false;
      } finally { await marker.close(); }
    }
    const entries = await readdir(directory);
    if (entries.some((name) => !['media', 'ready', 'lease'].includes(name))) return false;
    // Keep deletion authority intact until all payload bytes are gone. A failed
    // media removal can be retried without losing the lease or ready marker.
    await rm(path.join(directory, 'media'), { recursive: true, force: true });
    await rm(path.join(directory, 'ready'), { force: true });
    await unlink(path.join(directory, 'lease'));
    await rmdir(directory);
    return true;
  } catch (error) {
    if (code(error) === 'ENOENT') {
      try { await lstat(directory); return false; }
      catch (missing) { if (code(missing) === 'ENOENT') return true; throw missing; }
    }
    throw error;
  } finally { await lease?.close(); }
}

let sweep: { root: string; promise: Promise<number> } | undefined;
/**
 * At most 128 successful reclamations per pass. Preserve unknown, legacy and
 * unpublished directories, but do not let them consume the reclamation budget:
 * a persistent prefix must not hide later abandoned workspaces after a restart.
 * Directory enumeration/validation is linear in the namespace, not time-bounded.
 */
export async function reclaimAbandonedStagingWorkspaces(): Promise<number> {
  const root = await rootDirectory();
  if (sweep?.root === root) return sweep.promise;
  const promise = (async () => {
    if (!await localLockFilesystem(root)) return 0;
    const directory = await opendir(root);
    let reclaimed = 0;
    for await (const entry of directory) {
        if (reclaimed >= RECLAIM_LIMIT) break;
        if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
        try {
          if (await reclaim(path.join(root, entry.name), true)) reclaimed++;
        } catch {
          // Missing permission, unsupported locks or malformed entries do not
          // authorize deletion and must not prevent an otherwise valid import.
        }
    }
    return reclaimed;
  })();
  sweep = { root, promise };
  try { return await promise; }
  finally { if (sweep?.promise === promise) sweep = undefined; }
}

export async function createStagingWorkspace() {
  const root = await rootDirectory();
  await reclaimAbandonedStagingWorkspaces();
  const directory = await mkdtemp(path.join(root, 'item-'));
  let lease: FileHandle | undefined;
  try {
    lease = await open(path.join(directory, 'lease'), 'wx+', 0o600);
    flockSync(lease.fd, 'exnb');
    // Publish only after acquiring the lease; no media is written before this.
    const marker = await open(path.join(directory, 'ready'), 'wx', 0o600);
    try { await marker.writeFile(MARKER); }
    finally { await marker.close(); }
  } catch (error) {
    await lease?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const identity = await lstat(directory);
  const readerLeaseFd = lease.fd;
  let cleanupPromise: Promise<void> | undefined;
  let released = false;
  return {
    directory,
    readerLeaseFd,
    async cleanup() {
      cleanupPromise ??= (async () => {
        if (!released) {
          await lease.close();
          released = true;
        }
        // Even explicit owner cleanup must not remove a live child's source.
        if (!await reclaim(directory, false)) {
          // A prior attempt may have removed the lease, then failed to remove
          // the empty directory (for example, its parent lost write permission).
          // Only this original owner can finish that exact empty inode.
          if (sameFile(identity, await lstat(directory)) && (await readdir(directory)).length === 0) {
            await rmdir(directory);
            return;
          }
          throw Object.assign(new Error('Staging workspace still has an active reader.'), { code: 'EBUSY' });
        }
      })().catch((error: unknown) => { cleanupPromise = undefined; throw error; });
      await cleanupPromise;
    },
  };
}
