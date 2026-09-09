import { beforeEach, expect, it, vi } from 'vitest';
import { repairPostMediaTeasers, TEASER_REPAIR_MAX_BYTES } from '@/lib/post-media-teaser-repair';

const encode = vi.hoisted(() => vi.fn());
vi.mock('@/lib/video-rendition', () => ({
  TEASER_SECONDS: 8,
  withVideoInputFile: async (_body: Blob, work: (path: string) => unknown) => work('/tmp/fixture.mp4'),
  createVideoTeaserFromFile: encode,
}));
const bytes = Buffer.from('encoded video bytes');
beforeEach(() => { encode.mockReset().mockResolvedValue({ buffer: bytes, bytes: bytes.length, durationSeconds: 8, width: 720, height: 405 }); });

function fixture(options: { path?: string; generationId?: string | null; sourceBytes?: number; corrupt?: boolean; stale?: boolean; downloadError?: boolean } = {}) {
  const updates: Record<string, unknown>[] = [];
  const guards: [string, unknown][] = [];
  const storage = {
    download: vi.fn().mockImplementation(async () => ({
      data: new Blob([options.corrupt ? 'wrong stored bytes' : bytes]),
      error: options.downloadError ? new Error('Download failed') : null,
    })),
    upload: vi.fn().mockResolvedValue({ error: null }),
  };
  const db = {
    rpc: vi.fn().mockResolvedValue({ data: [{ id: 'media', post_id: 'post', generation_id: options.generationId ?? null,
      rendition_storage_path: options.path ?? 'posts/post/clip.feed.mp4',
      source_bytes: options.sourceBytes ?? 1024 }], error: null }),
    storage: { from: vi.fn(() => storage) },
    from: () => ({ update: (values: Record<string, unknown>) => {
      updates.push(values);
      const chain = {
        eq: (key: string, value: unknown) => { guards.push([key, value]); return chain; },
        is: (key: string, value: unknown) => { guards.push([key, value]); return chain; },
        select: async () => ({ data: options.stale ? [] : [{ id: 'media' }], error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
      };
      return chain;
    } }),
  };
  return { db, storage, updates, guards };
}

it('publishes verified Blob bytes from the existing rendition without changing full playback', async () => {
  const f = fixture();
  await expect(repairPostMediaTeasers(f.db as never)).resolves.toEqual({ attempted: 1, completed: 1, failed: 0 });
  expect(f.storage.download.mock.calls[0][0]).toBe('posts/post/clip.feed.mp4');
  const body = f.storage.upload.mock.calls[0][1] as Blob;
  expect(body).toBeInstanceOf(Blob);
  expect(Buffer.from(await body.arrayBuffer())).toEqual(bytes);
  expect(f.updates[0]).toMatchObject({ teaser_bytes: bytes.length, teaser_locked_at: null });
  expect(Object.keys(f.updates[0]).every(key => key.startsWith('teaser_'))).toBe(true);
  expect(f.guards).toContainEqual(['rendition_storage_path', 'posts/post/clip.feed.mp4']);
  expect(f.guards).toContainEqual(['teaser_storage_path', null]);
  expect(f.guards.some(([key, value]) => key === 'teaser_locked_by' && String(value).startsWith('media-teaser:'))).toBe(true);
});

it('admits a rendition filed under the linked generation, which is where creation-published posts keep theirs', async () => {
  const f = fixture({ path: 'showcase/gen-1/clip.feed.mp4', generationId: 'gen-1' });
  await expect(repairPostMediaTeasers(f.db as never)).resolves.toEqual({ attempted: 1, completed: 1, failed: 0 });
  expect(f.storage.download.mock.calls[0][0]).toBe('showcase/gen-1/clip.feed.mp4');
  expect(f.updates[0].teaser_storage_path).toMatch(/^showcase\/gen-1\/clip\.feed\.teaser\./);
});

it.each([
  { path: 'posts/another-post/clip.mp4' },
  // A showcase prefix is only admissible when it is the linked generation's own.
  { path: 'showcase/gen-2/clip.feed.mp4', generationId: 'gen-1' },
  { path: 'showcase/gen-1/clip.feed.mp4', generationId: null },
  { sourceBytes: TEASER_REPAIR_MAX_BYTES + 1 },
  { sourceBytes: 0 },
])('rejects inadmissible input before storage: %j', async options => {
  const f = fixture(options);
  await expect(repairPostMediaTeasers(f.db as never)).resolves.toMatchObject({ completed: 0, failed: 1 });
  expect(f.db.storage.from).not.toHaveBeenCalled();
  expect(encode).not.toHaveBeenCalled();
});

it.each([{ corrupt: true }, { downloadError: true }])('does not publish invalid stored bytes: %j', async options => {
  const f = fixture(options);
  await expect(repairPostMediaTeasers(f.db as never)).resolves.toMatchObject({ completed: 0, failed: 1 });
  expect(f.updates.every(update => !('teaser_storage_path' in update))).toBe(true);
  expect(f.updates.at(-1)).toMatchObject({ teaser_locked_at: null });
});

it('treats a changed source or lost lease as failure and releases only its own lease', async () => {
  const f = fixture({ stale: true });
  await expect(repairPostMediaTeasers(f.db as never)).resolves.toMatchObject({ completed: 0, failed: 1 });
  expect(f.updates.at(-1)).toMatchObject({ teaser_locked_by: null });
  expect(f.guards.filter(([key]) => key === 'teaser_locked_by')).toHaveLength(2);
});

it('rejects a teaser longer than the preview cap before upload', async () => {
  encode.mockResolvedValue({ buffer: bytes, bytes: bytes.length, durationSeconds: 37, width: 720, height: 405 });
  const f = fixture();
  await expect(repairPostMediaTeasers(f.db as never)).resolves.toMatchObject({ failed: 1 });
  expect(f.storage.upload).not.toHaveBeenCalled();
});

it('degrades on an unapplied migration but surfaces unrelated database failures', async () => {
  const f = fixture();
  f.db.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Missing claim_post_media_teaser_repair' } } as never);
  await expect(repairPostMediaTeasers(f.db as never)).resolves.toEqual({ attempted: 0, completed: 0, failed: 0 });
  const error = { code: '42501', message: 'permission denied' };
  f.db.rpc.mockResolvedValueOnce({ data: null, error } as never);
  await expect(repairPostMediaTeasers(f.db as never)).rejects.toEqual(error);
});
