import { chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReadableStream } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/lib/remote-media-security', () => ({
  openAllowlistedRemoteMedia: fixture.open,
}));
import { STAGING_ROOT_NAME } from '@/lib/staging-workspace';
import { stageAllowlistedRemoteMedia } from '@/lib/staged-remote-media';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'staging-lifecycle-'));
  vi.stubEnv('TMPDIR', directory);
  fixture.open.mockReset().mockImplementation(async () => ({
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('isolated staged bytes'));
        controller.close();
      },
    }),
    contentType: 'image/png',
    contentLength: 21,
    sourceName: 'test.png',
  }));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await chmod(directory, 0o700);
  await chmod(path.join(directory, STAGING_ROOT_NAME), 0o700).catch(() => {});
  await rm(directory, { recursive: true, force: true });
});
const stage = () =>
  stageAllowlistedRemoteMedia({
    url: 'https://fixture.invalid/media',
    kind: 'image',
  });
// Permission failures require an unprivileged POSIX user (local Mac and CI).
const permissionsSupported =
  process.platform !== 'win32' && process.getuid?.() !== 0;

describe('staged remote media lifetime', () => {
  it('keeps bytes available until explicit cleanup and cleans only its own directory', async () => {
    const first = await stage(),
      second = await stage();
    expect(await readFile(first.filePath, 'utf8')).toBe(
      'isolated staged bytes',
    );
    await first.cleanup();
    await expect(readFile(first.filePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(second.filePath, 'utf8')).toBe(
      'isolated staged bytes',
    );
    await first.cleanup();
    await second.cleanup();
    expect(await readdir(path.join(directory, STAGING_ROOT_NAME))).toEqual([]);
  });
  it.skipIf(!permissionsSupported)(
    'allows cleanup to retry after a real permission failure',
    async () => {
      const media = await stage();
      const parent = path.dirname(path.dirname(media.filePath));
      await chmod(parent, 0o500);
      await expect(media.cleanup()).rejects.toMatchObject({
        code: expect.stringMatching(/EACCES|EPERM/),
      });
      await chmod(parent, 0o700);
      await media.cleanup();
      expect(await readdir(path.join(directory, STAGING_ROOT_NAME))).toEqual([]);
    },
  );
  it('concurrent cleanup callers both wait for deletion', async () => {
    const media = await stage();
    const first = media.cleanup();
    await media.cleanup();
    await expect(readFile(media.filePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readdir(path.join(directory, STAGING_ROOT_NAME))).toEqual([]);
    await first;
  });
  it.skipIf(!permissionsSupported)(
    'cancels the opened source when temporary directory creation fails',
    async () => {
      const cancel = vi.fn();
      fixture.open.mockResolvedValue({
        body: new ReadableStream({ cancel }),
        contentType: 'image/png',
        contentLength: null,
        sourceName: 'test.png',
      });
      await chmod(directory, 0o500);
      await expect(stage()).rejects.toMatchObject({
        code: expect.stringMatching(/EACCES|EPERM/),
      });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
  it('removes a partially staged download when the source fails', async () => {
    let pulls = 0;
    fixture.open.mockResolvedValue({
      body: new ReadableStream({
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(Buffer.from('partial media'));
          else controller.error(new Error('interrupted media'));
        },
      }),
      contentType: 'image/png',
      contentLength: null,
      sourceName: 'test.png',
    });
    await expect(stage()).rejects.toThrow('interrupted media');
    expect(await readdir(path.join(directory, STAGING_ROOT_NAME))).toEqual([]);
  });
  it.skipIf(!permissionsSupported)(
    'keeps the staging failure when cancellation also fails',
    async () => {
      fixture.open.mockResolvedValue({
        body: new ReadableStream({
          cancel() {
            throw new Error('cancel failed');
          },
        }),
        contentType: 'image/png',
        contentLength: null,
        sourceName: 'test.png',
      });
      await chmod(directory, 0o500);
      await expect(stage()).rejects.toMatchObject({
        code: expect.stringMatching(/EACCES|EPERM/),
      });
    },
  );
});
