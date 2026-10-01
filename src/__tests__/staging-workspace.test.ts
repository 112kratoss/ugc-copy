import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  const workspace = await createStagingWorkspace(); workspaces.push(workspace);
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

describe('staging workspace inherited locks', () => {
  it('preserves live owners while sweeping and removes only the explicitly cleaned workspace', async () => {
    const a = await create(), b = await create();
    expect(await reclaimAbandonedStagingWorkspaces()).toBe(0);
    await Promise.all([a.cleanup(), a.cleanup()]);
    await a.cleanup();
    await expect(lstat(a.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(b.directory, 'media'), 'utf8')).toBe('active staged bytes');
  });
  it.each(['allocation', 'publication'])('does not reclaim an incompletely published workspace killed at %s', async (mode) => {
    const abandoned = await killedOwner(mode);
    expect(await reclaimAbandonedStagingWorkspaces()).toBe(0);
    expect((await lstat(abandoned.directory)).isDirectory()).toBe(true);
    await expect(lstat(path.join(abandoned.directory, 'media'))).rejects.toMatchObject({ code: 'ENOENT' });
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
    await expect(createStagingWorkspace()).rejects.toThrow('Unsafe staging');
    expect(await readdir(foreign)).toEqual(['keep']);
  });
});
