import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs, { chmod, lstat, mkdir, mkdtemp, open, opendir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { flockSync } from 'fs-ext';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStagingWorkspace, reclaimAbandonedStagingWorkspaces, STAGING_ROOT_NAME } from '@/lib/staging-workspace';

let root: string;
const workspaces: Awaited<ReturnType<typeof createStagingWorkspace>>[] = [];
const children: ChildProcess[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'staging-lock-test-'));
  vi.stubEnv('TMPDIR', root);
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    }
  }
  await chmod(path.join(root, STAGING_ROOT_NAME), 0o700).catch(() => {});
  for (const workspace of workspaces.splice(0)) await workspace.cleanup().catch(() => {});
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function create() {
  const workspace = await createStagingWorkspace(1024); workspaces.push(workspace);
  await writeFile(path.join(workspace.directory, 'media'), 'active staged bytes');
  return workspace;
}
async function killedOwner(mode?: string) {
  const child = fork(path.resolve('src/__tests__/staging-workspace-worker.ts'), mode ? [mode] : [], {
    execArgv: ['--conditions=react-server', '--import', 'tsx'],
    env: { ...process.env, TMPDIR: root, TSX_TSCONFIG_PATH: path.resolve('tsconfig.scripts.json') }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  children.push(child);
  const [message] = await once(child, 'message') as [{ directory: string; file: string }];
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  return message;
}

async function manyOwners(count: number) {
  const child = fork(path.resolve('src/__tests__/staging-workspace-worker.ts'), ['many', String(count)], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, TMPDIR: root, TSX_TSCONFIG_PATH: path.resolve('tsconfig.scripts.json') },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  children.push(child);
  await once(child, 'message');
  const directories: string[] = [];
  for await (const entry of await opendir(path.join(root, STAGING_ROOT_NAME))) {
    directories.push(path.join(root, STAGING_ROOT_NAME, entry.name));
  }
  expect(directories).toHaveLength(count);
  return { child, directories };
}

async function freshProcessSweep() {
  const child = fork(path.resolve('src/__tests__/staging-workspace-worker.ts'), ['sweep'], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, TMPDIR: root, TSX_TSCONFIG_PATH: path.resolve('tsconfig.scripts.json') },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  children.push(child);
  const exit = once(child, 'exit');
  const [message] = await once(child, 'message') as [{ reclaimed: number }];
  expect((await exit)[0]).toBe(0);
  return message.reclaimed;
}

describe('staging workspace inherited locks', () => {
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])('rejects invalid reservation %s before allocation', async (budget) => {
    await expect(createStagingWorkspace(budget)).rejects.toMatchObject({ code: 'STAGING_CAPACITY' });
    expect(await readdir(root)).toEqual([]);
  });

  it.each(['', 'foreign', 'magicbooklet-capacity-v1 -1\n'])('fails closed around an active unknown reservation %j', async (claim) => {
    const active = await create();
    await writeFile(path.join(active.directory, 'lease'), claim);
    await expect(createStagingWorkspace(1024)).rejects.toMatchObject({ code: 'STAGING_CAPACITY' });
    expect(await readFile(path.join(active.directory, 'media'), 'utf8')).toBe('active staged bytes');
    expect(await reclaimAbandonedStagingWorkspaces()).toBe(0);
  });

  it('publishes completed allocations under the prefix understood by older capacity-aware workers', async () => {
    const workspace = await create();
    expect(path.basename(workspace.directory)).toMatch(/^item-[a-zA-Z0-9]{6}$/);
    expect(await readdir(path.join(root, STAGING_ROOT_NAME))).toEqual([path.basename(workspace.directory)]);
  });

  it('does not replace an existing workspace when the publication name collides', async () => {
    const existing = await create();
    const original = fs.mkdtemp;
    const allocate = vi.spyOn(fs, 'mkdtemp').mockImplementationOnce(async (...args) => {
      const created = String(await original(...args));
      const collision = existing.directory.replace('/item-', '/item2-');
      await rename(created, collision);
      return collision;
    });
    syncBuiltinESMExports();
    try {
      const next = await create();
      expect(next.directory).not.toBe(existing.directory);
      expect(await readFile(path.join(existing.directory, 'media'), 'utf8')).toBe('active staged bytes');
      expect(await reclaimAbandonedStagingWorkspaces()).toBe(0);
    } finally { allocate.mockRestore(); syncBuiltinESMExports(); }
  });

  it('seals a completed source idempotently and preserves its bytes and reader lease', async () => {
    const active = await create();
    await Promise.all([active.seal(), active.seal()]);
    expect(await readFile(path.join(active.directory, 'sealed'), 'utf8')).toBe('complete\n');
    expect(await reclaimAbandonedStagingWorkspaces()).toBe(0);
    expect(await readFile(path.join(active.directory, 'media'), 'utf8')).toBe('active staged bytes');
    await active.cleanup();
    expect(await readdir(path.join(root, STAGING_ROOT_NAME))).toEqual([]);
  });

  it('a fresh process reaches dead owners behind 128 unpublished entries in real directory order', async () => {
    const { child, directories } = await manyOwners(130);
    for (const directory of directories.slice(0, 128)) await unlink(path.join(directory, 'ready'));
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    // These represent older allocators that did not hold the root admission
    // lock. Keep their unidentified initialization metadata outside authority.
    for (let i = 0; i < 128; i++) {
      const legacy = path.join(path.dirname(directories[i]), path.basename(directories[i]).replace('item2-', 'item-'));
      if (legacy !== directories[i]) await rename(directories[i], legacy);
      directories[i] = legacy;
    }
    expect(await freshProcessSweep()).toBe(2);
    expect(await freshProcessSweep()).toBe(0);
    for (const directory of directories.slice(0, 128)) expect((await lstat(directory)).isDirectory()).toBe(true);
    for (const directory of directories.slice(128)) await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('caps successful reclamation while fresh processes make progress through larger abandoned sets', async () => {
    const { child } = await manyOwners(140);
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    expect(await freshProcessSweep()).toBe(128);
    expect(await freshProcessSweep()).toBe(12);
    expect(await readdir(path.join(root, STAGING_ROOT_NAME))).toEqual([]);
  }, 30_000);

  it('preserves 128 locked entries while a fresh process reclaims later dead owners', async () => {
    const { child, directories } = await manyOwners(130);
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    const leases: Awaited<ReturnType<typeof open>>[] = [];
    try {
      for (const directory of directories.slice(0, 128)) {
        const lease = await open(path.join(directory, 'lease'), 'r+'); leases.push(lease);
        flockSync(lease.fd, 'exnb');
        await writeFile(path.join(directory, 'media'), 'protected bytes');
      }
      expect(await freshProcessSweep()).toBe(2);
      for (const directory of directories.slice(0, 128)) {
        expect(await readFile(path.join(directory, 'media'), 'utf8')).toBe('protected bytes');
      }
    } finally { for (const lease of leases) await lease.close(); }
    expect(await freshProcessSweep()).toBe(128);
    expect(await readdir(path.join(root, STAGING_ROOT_NAME))).toEqual([]);
  }, 30_000);

  it('preserves live owners while sweeping and removes only the explicitly cleaned workspace', async () => {
    const a = await create(), b = await create();
    expect(await reclaimAbandonedStagingWorkspaces()).toBe(0);
    await Promise.all([a.cleanup(), a.cleanup()]);
    await a.cleanup();
    await expect(lstat(a.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(b.directory, 'media'), 'utf8')).toBe('active staged bytes');
  });
  it.each(['allocation', 'publication', 'lease-open', 'lease-write', 'ready-open', 'ready-write', 'lease-partial', 'ready-partial'])('reclaims initialization metadata after an allocator dies at %s', async (mode) => {
    const abandoned = await killedOwner(mode);
    expect(await reclaimAbandonedStagingWorkspaces()).toBe(1);
    await expect(lstat(abandoned.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('waits for a live allocator to release the root lock before reclaiming its empty directory', async () => {
    const child = fork(path.resolve('src/__tests__/staging-workspace-worker.ts'), ['allocation'], {
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, TMPDIR: root, TSX_TSCONFIG_PATH: path.resolve('tsconfig.scripts.json') },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    children.push(child);
    const [allocated] = await once(child, 'message');
    let finished = false;
    const sweep = reclaimAbandonedStagingWorkspaces().then(count => { finished = true; return count; });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(finished).toBe(false);
    expect(await readdir(allocated.directory)).toEqual([]);
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    expect(await sweep).toBe(1);
    await expect(lstat(allocated.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves an unpublished metadata-only workspace while an inherited child holds its lease', async () => {
    const workspace = await createStagingWorkspace(1024); workspaces.push(workspace);
    const reader = fork(path.resolve('src/__tests__/staging-workspace-worker.ts'), ['hold-lease'], {
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, TSX_TSCONFIG_PATH: path.resolve('tsconfig.scripts.json') },
      stdio: ['ignore', 'ignore', 'inherit', workspace.readerLeaseFd, 'ipc'],
    });
    children.push(reader); await once(reader, 'message');
    // Model an inherited reader even in initialization-only state. Production
    // starts readers after publication, but a held lease always wins.
    const initializing = workspace.directory.replace('/item-', '/item2-');
    await rename(workspace.directory, initializing);
    await unlink(path.join(initializing, 'ready'));
    await workspace.cleanup();
    expect(await reclaimAbandonedStagingWorkspaces()).toBe(0);
    expect(await readdir(initializing)).toEqual(['lease']);
    const exit = once(reader, 'exit'); reader.kill('SIGKILL'); await exit;
    await expect.poll(() => reclaimAbandonedStagingWorkspaces(), { timeout: 3000 }).toBe(1);
  });

  it.each(['lease', 'ready', 'foreign'])('preserves unknown initialization metadata in %s', async name => {
    const abandoned = await killedOwner('publication');
    await writeFile(path.join(abandoned.directory, name), 'foreign');
    expect(await reclaimAbandonedStagingWorkspaces()).toBe(0);
    expect(await readFile(path.join(abandoned.directory, name), 'utf8')).toBe('foreign');
  });

  it('reclaims a killed owner when a fresh staging operation starts', async () => {
    const abandoned = await killedOwner();
    const active = await create();
    await expect(lstat(abandoned.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(active.directory, 'media'), 'utf8')).toBe('active staged bytes');
  });
  it('refuses explicit cleanup and sweeping while a real child holds the inherited descriptor', async () => {
    const workspace = await create();
    const reader = fork(path.resolve('src/__tests__/staging-workspace-worker.ts'),
      ['reader', path.join(workspace.directory, 'media')], {
        execArgv: ['--conditions=react-server', '--import', 'tsx'],
        env: { ...process.env, TSX_TSCONFIG_PATH: path.resolve('tsconfig.scripts.json') },
        stdio: ['ignore', 'ignore', 'inherit', workspace.readerLeaseFd, 'ipc'],
      });
    children.push(reader);
    await once(reader, 'message');
    const read = once(reader, 'message');
    await expect(workspace.cleanup()).rejects.toMatchObject({ code: 'EBUSY' });
    expect(await reclaimAbandonedStagingWorkspaces()).toBe(0);
    expect((await read)[0]).toEqual({ bytes: 'active staged bytes' });
    const exit = once(reader, 'exit'); reader.kill('SIGKILL'); await exit;
    await workspace.cleanup();
    await expect(lstat(workspace.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('coalesces simultaneous sweeps without touching an active workspace', async () => {
    const active = await create();
    const abandoned = await killedOwner();
    await Promise.all(Array.from({ length: 12 }, () => reclaimAbandonedStagingWorkspaces()));
    await expect(lstat(abandoned.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(active.directory, 'media'), 'utf8')).toBe('active staged bytes');
  });
  it('allows competing processes to reclaim a dead owner without deleting a live workspace', async () => {
    const active = await create();
    const abandoned = await killedOwner();
    await Promise.all(Array.from({ length: 4 }, async () => {
      const worker = fork(path.resolve('src/__tests__/staging-workspace-worker.ts'), ['sweep'], {
        execArgv: ['--import', 'tsx'],
        env: { ...process.env, TMPDIR: root, TSX_TSCONFIG_PATH: path.resolve('tsconfig.scripts.json') },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      children.push(worker);
      const exit = once(worker, 'exit');
      const [message] = await once(worker, 'message');
      expect(message.reclaimed).toBeGreaterThanOrEqual(0);
      expect((await exit)[0]).toBe(0);
    }));
    await expect(lstat(abandoned.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(active.directory, 'media'), 'utf8')).toBe('active staged bytes');
  });
  it.each(['missing', 'invalid', 'symlink'])('preserves an abandoned directory with a %s publication marker', async (mode) => {
    const abandoned = await killedOwner();
    const marker = path.join(abandoned.directory, 'ready');
    await unlink(marker);
    if (mode === 'invalid') await writeFile(marker, 'foreign');
    if (mode === 'symlink') await symlink(abandoned.file, marker);
    await reclaimAbandonedStagingWorkspaces();
    expect(await readFile(abandoned.file, 'utf8')).toBe('worker staged bytes');
  });
  it('does not follow a directory or lease symlink and preserves legacy files', async () => {
    const abandoned = await killedOwner();
    await unlink(path.join(abandoned.directory, 'lease'));
    await symlink(abandoned.file, path.join(abandoned.directory, 'lease'));
    const foreign = path.join(root, 'remote-media-legacy');
    await mkdir(foreign); await writeFile(path.join(foreign, 'media'), 'legacy');
    await symlink(foreign, path.join(root, STAGING_ROOT_NAME, 'item-AAAAAA'));
    await reclaimAbandonedStagingWorkspaces();
    expect(await readFile(abandoned.file, 'utf8')).toBe('worker staged bytes');
    expect(await readFile(path.join(foreign, 'media'), 'utf8')).toBe('legacy');
  });
  it.skipIf(process.getuid?.() === 0)('retains lease authority after a partial deletion fails, then retries', async () => {
    const workspace = await create();
    const media = path.join(workspace.directory, 'media');
    await unlink(media); await mkdir(media); await writeFile(path.join(media, 'bytes'), 'retained');
    await chmod(media, 0o500);
    try {
      await expect(workspace.cleanup()).rejects.toMatchObject({ code: expect.stringMatching(/EACCES|EPERM/) });
      expect((await lstat(path.join(workspace.directory, 'lease'))).isFile()).toBe(true);
      expect((await lstat(path.join(workspace.directory, 'ready'))).isFile()).toBe(true);
    } finally { await chmod(media, 0o700); }
    await workspace.cleanup();
    await expect(lstat(workspace.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not count a missing marker as successful reclamation', async () => {
    const abandoned = await killedOwner();
    await unlink(path.join(abandoned.directory, 'ready'));
    expect(await reclaimAbandonedStagingWorkspaces()).toBe(0);
    expect(await readFile(abandoned.file, 'utf8')).toBe('worker staged bytes');
  });
  it('rejects a symlink replacing the shared root', async () => {
    const foreign = path.join(root, 'foreign'); await mkdir(foreign);
    await writeFile(path.join(foreign, 'keep'), 'foreign');
    await symlink(foreign, path.join(root, STAGING_ROOT_NAME));
    await expect(createStagingWorkspace(1024)).rejects.toThrow('Unsafe staging');
    expect(await readdir(foreign)).toEqual(['keep']);
  });
});
