import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, default: { ...actual, spawn: spawnMock }, spawn: spawnMock };
});
let root: string;
beforeEach(async () => {
  vi.resetModules();
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  spawnMock.mockReset().mockImplementation(actual.spawn);
  root = await mkdtemp(path.join(os.tmpdir(), 'encoder-limit-test-'));
  vi.stubEnv('TMPDIR', root);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe('encoder limit capability', () => {
  it('coalesces actual capability checks and leaves no calibration workspace', async () => {
    const { mediaEncoderCommand } = await import('@/lib/media-encoder-limit');
    const commands = await Promise.all(Array.from({ length: 5 }, () =>
      mediaEncoderCommand('/encoder with spaces', ['$(must-stay-literal)', 'output.mp4'], 65536)));
    expect(spawnMock).toHaveBeenCalledOnce();
    for (const command of commands) {
      expect(command.executable).toBe('/bin/sh');
      expect(command.args.slice(-3)).toEqual(['/encoder with spaces', '$(must-stay-literal)', 'output.mp4']);
      expect([64, 128]).toContain(Number(command.args[3]));
    }
    expect(await readdir(path.join(root, 'magicbooklet-staging-v1'))).toEqual([]);
  });

  it('fails closed on an unverifiable limit and retries capability on later work', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    spawnMock.mockImplementationOnce(() => actual.spawn(process.execPath, ['-e', 'process.exit(3)']));
    const { mediaEncoderCommand } = await import('@/lib/media-encoder-limit');
    await expect(mediaEncoderCommand('/encoder', [], 4096)).rejects.toThrow('Cannot verify');
    expect(await readdir(path.join(root, 'magicbooklet-staging-v1'))).toEqual([]);
    await expect(mediaEncoderCommand('/encoder', [], 4096)).resolves.toMatchObject({ executable: '/bin/sh' });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it.each([0, -1, 1023, 1536, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid byte budget %s before starting a process', async (budget) => {
    const { mediaEncoderCommand } = await import('@/lib/media-encoder-limit');
    await expect(mediaEncoderCommand('/encoder', [], budget)).rejects.toThrow('whole number of KiB');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
