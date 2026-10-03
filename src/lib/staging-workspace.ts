import 'server-only';

import { constants, type Stats } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, opendir, readdir, rename, rm, rmdir, unlink, statfs, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { flockSync } from 'fs-ext';

export const STAGING_ROOT_NAME = 'magicbooklet-staging-v1';
const MARKER = 'magicbooklet-staging-v1\n';
const NAME = /^item(?:2)?-[a-zA-Z0-9]{6}$/;
// Only this prefix promises root-lock ownership throughout initialization.
const INITIALIZING_NAME = /^item2-[a-zA-Z0-9]{6}$/;
const RECLAIM_LIMIT = 128;
const CAPACITY_VERSION = 'magicbooklet-capacity-v1';
const SEALED = 'complete\n';
const WORKSPACE_HEADROOM = 32 * 1024;

export class StagingCapacityError extends Error {
  readonly code = 'STAGING_CAPACITY';
  constructor(message = 'Insufficient staging capacity; retry later.') {
    super(message);
    this.name = 'StagingCapacityError';
  }
}

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
  // Unknown/network filesystems are neither swept nor admitted.
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
      // Reject unpublished payload reclamation with one metadata read. New
      // item2 initialization is handled separately under the root lock.
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
    if (entries.some((name) => !['media', 'ready', 'lease', 'sealed'].includes(name))) return false;
    // Keep deletion authority intact until all payload bytes are gone. A failed
    // media removal can be retried without losing the lease or ready marker.
    await rm(path.join(directory, 'media'), { recursive: true, force: true });
    await rm(path.join(directory, 'sealed'), { force: true });
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

/** Only item2 allocators publish under the root lock held by the caller. */
async function reclaimInitialization(directory: string): Promise<boolean> {
  let lease: FileHandle | undefined;
  try {
    const before = await lstat(directory);
    if (!privateDirectory(before)) return false;
    const entries = await readdir(directory);
    if (entries.some(name => !['lease', 'ready'].includes(name))) return false;
    if (entries.includes('lease')) {
      lease = await openRegular(path.join(directory, 'lease'));
      try { flockSync(lease.fd, 'exnb'); }
      catch (error) { if (['EAGAIN', 'EWOULDBLOCK'].includes(code(error) ?? '')) return false; throw error; }
      if ((await lease.stat()).size > 128) return false;
      const claim = await lease.readFile('utf8');
      if (!CAPACITY_VERSION.startsWith(claim) && !/^magicbooklet-capacity-v1 [0-9]*\n?$/.test(claim)) return false;
      if (!sameFile(await lease.stat(), await lstat(path.join(directory, 'lease')))) return false;
    }
    if (entries.includes('ready')) {
      const marker = await openRegular(path.join(directory, 'ready'));
      try {
        if ((await marker.stat()).size > MARKER.length || !MARKER.startsWith(await marker.readFile('utf8'))) return false;
      } finally { await marker.close(); }
    }
    if (!sameFile(before, await lstat(directory))) return false;
    // No payload recursion: an unexpected entry racing cleanup makes rmdir fail.
    if (entries.includes('ready')) await unlink(path.join(directory, 'ready'));
    if (entries.includes('lease')) await unlink(path.join(directory, 'lease'));
    await rmdir(directory);
    return true;
  } catch (error) {
    if (code(error) === 'ENOENT') return false;
    throw error;
  } finally { await lease?.close(); }
}

let sweep: { root: string; promise: Promise<number> } | undefined;
/**
 * At most 128 successful reclamations per pass. Preserve unknown and legacy
 * unpublished directories, but do not let them consume the reclamation budget:
 * a persistent prefix must not hide later abandoned workspaces after a restart.
 * Directory enumeration/validation is linear in the namespace, not time-bounded.
 */
export async function reclaimAbandonedStagingWorkspaces(): Promise<number> {
  const root = await rootDirectory();
  if (sweep?.root === root) return sweep.promise;
  const promise = (async () => {
    if (!await localLockFilesystem(root)) return 0;
    return withAdmission(root, async () => {
      const directory = await opendir(root);
      let reclaimed = 0;
      for await (const entry of directory) {
        if (reclaimed >= RECLAIM_LIMIT) break;
        if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
        try {
          const directory = path.join(root, entry.name);
          if (await reclaim(directory, true)
            || (INITIALIZING_NAME.test(entry.name) && await reclaimInitialization(directory))) reclaimed++;
        } catch {
          // Missing permission, unsupported locks or malformed entries do not
          // authorize deletion and must not prevent an otherwise valid import.
        }
      }
      return reclaimed;
    });
  })();
  sweep = { root, promise };
  try { return await promise; }
  finally { if (sweep?.promise === promise) sweep = undefined; }
}

/** Serialize admission on the persistent root inode, never an unlinkable lock file. */
async function withAdmission<T>(root: string, work: () => Promise<T>): Promise<T> {
  if (!await localLockFilesystem(root)) throw new StagingCapacityError('Unsupported staging admission filesystem.');
  const lock = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const deadline = Date.now() + 5_000;
    while (true) {
      try { flockSync(lock.fd, 'exnb'); break; }
      catch (error) {
        if (!['EAGAIN', 'EWOULDBLOCK'].includes(code(error) ?? '')) throw error;
        if (Date.now() >= deadline) throw new StagingCapacityError('Staging admission is busy; retry later.');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    if (!sameFile(await lock.stat(), await lstat(root))) throw new StagingCapacityError('Staging root changed.');
    return await work();
  } finally { await lock.close(); }
}

async function outstandingCapacity(root: string) {
  let reserved = 0;
  let active = 0;
  for await (const entry of await opendir(root)) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    let lease: FileHandle | undefined;
    try {
      lease = await openRegular(path.join(directory, 'lease'));
      try {
        flockSync(lease.fd, 'exnb');
        // A dead writer cannot grow. Its retained bytes are still in statfs.
        continue;
      } catch (error) {
        if (!['EAGAIN', 'EWOULDBLOCK'].includes(code(error) ?? '')) throw error;
      }
      active++;
      const size = (await lease.stat()).size;
      if (size > 128) throw new StagingCapacityError('Invalid active staging reservation.');
      const match = /^(magicbooklet-capacity-v1) ([0-9]+)\n$/.exec(await lease.readFile('utf8'));
      const maximum = match ? Number(match[2]) : NaN;
      if (!Number.isSafeInteger(maximum) || maximum < 0) {
        // Old active writers have no declared limit. Never assume zero growth.
        throw new StagingCapacityError('An active staging writer has no valid reservation.');
      }
      let sealed = false;
      try {
        const marker = await openRegular(path.join(directory, 'sealed'));
        try { sealed = (await marker.stat()).size === SEALED.length && await marker.readFile('utf8') === SEALED; }
        finally { await marker.close(); }
      } catch (error) { if (code(error) !== 'ENOENT') throw error; }
      // In-flight reservations deliberately retain their FULL ceiling. Counting
      // partial bytes again is conservative, and avoids races with truncation or
      // faststart rewrites. Only a closed writer may seal and release growth.
      reserved += (sealed ? 0 : maximum) + WORKSPACE_HEADROOM;
      if (!Number.isSafeInteger(reserved)) throw new StagingCapacityError('Staging reservation overflow.');
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
    } finally { await lease?.close(); }
  }
  return { reserved, active };
}

/** maxBytes is the caller's enforced write ceiling, not an HTTP length hint. */
export async function createStagingWorkspace(maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new StagingCapacityError('Invalid staging byte budget.');
  const root = await rootDirectory();
  await reclaimAbandonedStagingWorkspaces();
  const { directory, lease } = await withAdmission(root, async () => {
    const { reserved, active } = await outstandingCapacity(root);
    const space = await statfs(root);
    const bytes = Math.ceil(maxBytes / space.bsize) * space.bsize;
    const headroom = Math.max(1024 * 1024, Math.min(64 * 1024 * 1024, Math.ceil(space.blocks * space.bsize * 0.01)));
    if (space.bavail * space.bsize < reserved + bytes + headroom + WORKSPACE_HEADROOM
      || (space.files > 0 && space.ffree < 32 + active * 4)) throw new StagingCapacityError();
    const directory = await mkdtemp(path.join(root, 'item2-'));
    let lease: FileHandle | undefined;
    try {
      lease = await open(path.join(directory, 'lease'), 'wx+', 0o600);
      flockSync(lease.fd, 'exnb');
      await lease.writeFile(`${CAPACITY_VERSION} ${bytes}\n`);
      // Publish the claim while admission is locked, before any payload writes.
      const marker = await open(path.join(directory, 'ready'), 'wx', 0o600);
      try { await marker.writeFile(MARKER); }
      finally { await marker.close(); }
      // Publish under the older prefix before releasing admission, so 6R
      // workers count this reservation too. All capacity-aware allocators hold
      // the same root lock; never replace an existing legacy directory.
      for (let attempt = 0; attempt < 16; attempt++) {
        const suffix = attempt === 0 ? path.basename(directory).slice('item2-'.length) : randomBytes(3).toString('hex');
        const published = path.join(root, `item-${suffix}`);
        try { await lstat(published); continue; }
        catch (error) { if (code(error) !== 'ENOENT') throw error; }
        await rename(directory, published);
        return { directory: published, lease };
      }
      throw new StagingCapacityError('Cannot publish staging workspace without a name collision.');
    } catch (error) {
      await lease?.close();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  });
  const identity = await lstat(directory);
  const readerLeaseFd = lease.fd;
  let cleanupPromise: Promise<void> | undefined;
  let released = false;
  let sealPromise: Promise<void> | undefined;
  return {
    directory,
    readerLeaseFd,
    /** Call only after all writes close; the payload must remain immutable. */
    seal() {
      sealPromise ??= withAdmission(root, async () => {
        if (released) throw new StagingCapacityError('Cannot seal a released workspace.');
        const marker = await open(path.join(directory, 'sealed'), 'wx', 0o600);
        try { await marker.writeFile(SEALED); }
        finally { await marker.close(); }
      });
      return sealPromise;
    },
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

/** A leased payload directory for encoders that need filename extensions. */
export async function createMediaScratchWorkspace(maxBytes: number) {
  const workspace = await createStagingWorkspace(maxBytes);
  const mediaDirectory = path.join(workspace.directory, 'media');
  try {
    await mkdir(mediaDirectory, { mode: 0o700 });
    return { ...workspace, mediaDirectory };
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}
