import { beforeEach, expect, it, vi } from 'vitest';
import {
  repairGenerationPlaybackRendition,
  GENERATION_PLAYBACK_MAX_BYTES,
} from '@/lib/generation-playback-rendition';

const encode = vi.hoisted(() => vi.fn());
vi.mock('@/lib/video-rendition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/video-rendition')>()),
  withVideoInputFile: async (_body: Blob, work: (path: string, bytes: number) => unknown) =>
    work('/tmp/input.mp4', 1024),
  createVideoRenditionFromFile: encode,
}));
import { VideoRenditionSkipped } from '@/lib/video-rendition';
const encoded = Buffer.from('a small encoded video');
beforeEach(() => {
  encode
    .mockReset()
    .mockResolvedValue({
      buffer: encoded,
      bytes: encoded.length,
      width: 610,
      height: 1280,
      durationSeconds: 11.4,
    });
});
function fixture(
  options: {
    source?: string;
    bytes?: number;
    corrupt?: boolean;
    stale?: boolean;
    downloadBytes?: number;
    deleted?: boolean;
  } = {},
) {
  const updates: Record<string, unknown>[] = [];
  const guards: [string, unknown][] = [];
  const storage = {
    download: vi.fn(async (path: string) => ({
      data: new Blob([
        path.includes('/playback/')
          ? options.corrupt
            ? 'bad bytes'
            : encoded
          : Buffer.alloc(options.downloadBytes ?? 1024),
      ]),
      error: null,
    })),
    upload: vi.fn(async () => ({ error: null })),
    remove: vi.fn(async () => ({ error: null })),
  };
  const db = {
    rpc: vi.fn(async () => ({
      data: [
        {
          id: 'generation',
          user_id: 'owner',
          output_url: options.source ?? 'generated_videos/owner/original.mp4',
          source_bytes: options.bytes ?? 1024,
        },
      ],
      error: null,
    })),
    storage: { from: vi.fn(() => storage) },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: options.deleted ? null : { id: 'generation' },
            error: null,
          }),
        }),
      }),
      update: (values: Record<string, unknown>) => {
        updates.push(values);
        const q = {
          eq: (key: string, value: unknown) => {
            guards.push([key, value]);
            return q;
          },
          select: async () => ({ data: options.stale ? [] : [{ id: 'generation' }], error: null }),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ error: null }).then(resolve),
        };
        return q;
      },
    }),
  };
  return { db, updates, guards, storage };
}
it('stores a verified private Blob and publishes only the derivative for the claimed owner, source and lease', async () => {
  const f = fixture();
  expect(await repairGenerationPlaybackRendition(f.db as never)).toEqual({
    attempted: 1,
    completed: 1,
    failed: 0,
  });
  expect(f.db.storage.from).toHaveBeenCalledWith('generated_videos');
  const [path, body] = f.storage.upload.mock.calls[0] as unknown as [string, Blob];
  expect(path).toMatch(/^owner\/playback\/generation\/[a-f0-9]+\.mp4$/);
  expect(body).toBeInstanceOf(Blob);
  expect(Buffer.from(await body.arrayBuffer())).toEqual(encoded);
  expect(f.updates[0]).toMatchObject({
    playback_rendition_status: 'ready',
    playback_rendition_bytes: encoded.length,
    playback_rendition_source: 'generated_videos/owner/original.mp4',
  });
  expect(
    f.updates.every((u) => Object.keys(u).every((k) => k.startsWith('playback_rendition_'))),
  ).toBe(true);
  expect(f.guards).toContainEqual(['output_url', 'generated_videos/owner/original.mp4']);
  expect(f.guards).toContainEqual(['user_id', 'owner']);
  expect(f.guards.some(([k]) => k === 'playback_rendition_locked_by')).toBe(true);
});
it.each([
  { source: 'generated_videos/other/original.mp4' },
  { source: 'https://outside.test/video.mp4' },
  { bytes: 0 },
  { bytes: GENERATION_PLAYBACK_MAX_BYTES + 1 },
])('rejects unowned or oversized sources before download: %j', async (options) => {
  const f = fixture(options);
  expect(await repairGenerationPlaybackRendition(f.db as never)).toMatchObject({ failed: 1 });
  expect(f.storage.download).not.toHaveBeenCalled();
  expect(encode).not.toHaveBeenCalled();
});
it('rechecks actual bytes against storage admission', async () => {
  const f = fixture({ downloadBytes: 2048 });
  expect(await repairGenerationPlaybackRendition(f.db as never)).toMatchObject({ failed: 1 });
  expect(encode).not.toHaveBeenCalled();
});
it('does not publish bytes that fail readback', async () => {
  const f = fixture({ corrupt: true });
  expect(await repairGenerationPlaybackRendition(f.db as never)).toMatchObject({ failed: 1 });
  expect(f.updates.every((u) => u.playback_rendition_status !== 'ready')).toBe(true);
});
it('fails publication when the source or lease changed', async () => {
  const f = fixture({ stale: true });
  expect(await repairGenerationPlaybackRendition(f.db as never)).toMatchObject({ failed: 1 });
  expect(f.guards.filter(([k]) => k === 'playback_rendition_locked_by')).toHaveLength(2);
});
it('removes only its new derivative when the generation was deleted during encoding', async () => {
  const f = fixture({ stale: true, deleted: true });
  expect(await repairGenerationPlaybackRendition(f.db as never)).toMatchObject({ failed: 1 });
  expect(f.storage.remove).toHaveBeenCalledWith([
    expect.stringMatching(/^owner\/playback\/generation\/[a-f0-9]+\.mp4$/),
  ]);
});
it('terminally skips already lean originals without uploading or incrementing the consumed attempt again', async () => {
  encode.mockRejectedValue(new VideoRenditionSkipped('not-smaller', 'Already lean'));
  const f = fixture();
  expect(await repairGenerationPlaybackRendition(f.db as never)).toMatchObject({
    completed: 1,
    failed: 0,
  });
  expect(f.storage.upload).not.toHaveBeenCalled();
  expect(f.updates[0].playback_rendition_status).toBe('skipped');
  expect(f.updates[0]).not.toHaveProperty('playback_rendition_attempt_count');
});
it('degrades only when its migration is absent', async () => {
  const f = fixture();
  f.db.rpc.mockResolvedValueOnce({
    data: null,
    error: { code: 'PGRST202', message: 'Missing claim_generation_playback_rendition' },
  } as never);
  expect(await repairGenerationPlaybackRendition(f.db as never)).toEqual({
    attempted: 0,
    completed: 0,
    failed: 0,
  });
  f.db.rpc.mockResolvedValueOnce({
    data: null,
    error: { code: '42501', message: 'denied' },
  } as never);
  await expect(repairGenerationPlaybackRendition(f.db as never)).rejects.toMatchObject({
    code: '42501',
  });
});
