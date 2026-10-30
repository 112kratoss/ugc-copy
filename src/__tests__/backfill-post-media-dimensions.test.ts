// @vitest-environment node
import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  BATCH_SIZE,
  createStorageIo,
  main,
  parseMode,
  planRow,
  readImageSize,
  readObjectBytes,
  runBackfill,
} from '../../scripts/backfills/backfill-post-media-dimensions.mjs';

type MediaRow = {
  id: string;
  post_id: string;
  media_kind: 'image' | 'video';
  storage_path: string | null;
  external_url: string | null;
  preview_storage_path: string | null;
  sort_order: number;
  width: number | null;
  height: number | null;
  source_unavailable_at: string | null;
};
type PostRow = { id: string; user_id: string | null; generation_id: string | null; deleted_generation_id?: string | null };
type GenerationRow = { id: string; preview_width: number | null; preview_height: number | null };
type Location = { bucket: string; path: string };

let png: Buffer;
let jpegTurned: Buffer;
let webpPoster: Buffer;

beforeAll(async () => {
  png = await sharp({ create: { width: 30, height: 40, channels: 3, background: '#808080' } }).png().toBuffer();
  // Stored 1200x800 with EXIF orientation 6: shown, and laid out, 800x1200.
  const noise = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: '#000000', noise: { type: 'gaussian', mean: 128, sigma: 60 } },
  }).png().toBuffer();
  jpegTurned = await sharp(noise).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer();
  webpPoster = await sharp(noise).resize({ width: 720 }).webp({ quality: 72 }).toBuffer();
});

function mediaRow(overrides: Partial<MediaRow> & { id: string; post_id: string }): MediaRow {
  return {
    media_kind: 'image',
    storage_path: `posts/${overrides.post_id}/0/cover.png`,
    external_url: null,
    preview_storage_path: null,
    sort_order: 0,
    width: null,
    height: null,
    source_unavailable_at: null,
    ...overrides,
  };
}

/** The script's PostgREST calls over in-memory rows, answering as PostgREST does. */
function createFakeClient(state: { media: MediaRow[]; posts: PostRow[]; generations: GenerationRow[] }) {
  const updates: Array<{ id: string; values: Record<string, unknown> }> = [];

  const mediaQuery = () => {
    let missingSizeOnly = false;
    let afterId: string | null = null;
    let limit = Number.POSITIVE_INFINITY;
    let head = false;
    let values: Record<string, unknown> | null = null;
    const equals: Record<string, unknown> = {};
    const matching = () => state.media
      .filter((row) => !missingSizeOnly || row.width === null || row.height === null)
      .filter((row) => afterId === null || row.id > afterId)
      .filter((row) => Object.entries(equals).every(([column, value]) => (row as Record<string, unknown>)[column] === value))
      .sort((left, right) => left.id.localeCompare(right.id));

    const query = {
      select(_columns?: string, options?: { head?: boolean }) {
        head = Boolean(options?.head);
        return query;
      },
      or(filter: string) {
        expect(filter).toBe('width.is.null,height.is.null');
        missingSizeOnly = true;
        return query;
      },
      gt(column: string, value: string) {
        expect(column).toBe('id');
        afterId = value;
        return query;
      },
      eq(column: string, value: unknown) {
        equals[column] = value;
        return query;
      },
      order(column: string) {
        expect(column).toBe('id');
        return query;
      },
      limit(count: number) {
        limit = count;
        return query;
      },
      update(next: Record<string, unknown>) {
        values = next;
        return query;
      },
      then(resolve: (result: unknown) => unknown) {
        if (values) {
          const written = matching();
          for (const row of written) {
            Object.assign(row, values);
            updates.push({ id: row.id, values });
          }
          return Promise.resolve(resolve({ data: written.map((row) => ({ id: row.id })), error: null }));
        }
        if (head) return Promise.resolve(resolve({ data: null, count: matching().length, error: null }));
        const rows = matching().slice(0, limit).map((row) => {
          const post = state.posts.find((candidate) => candidate.id === row.post_id);
          return { ...row, posts: post ? { user_id: post.user_id, generation_id: post.generation_id, deleted_generation_id: post.deleted_generation_id ?? null } : null };
        });
        return Promise.resolve(resolve({ data: rows, error: null }));
      },
    };
    return query;
  };

  const client = {
    from(table: string) {
      if (table === 'post_media') return mediaQuery();
      if (table === 'generations') {
        return {
          select() {
            return {
              in: async (_column: string, ids: string[]) => ({
                data: state.generations.filter((generation) => ids.includes(generation.id)),
                error: null,
              }),
            };
          },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };
  return { client, updates };
}

/** Storage reads over a map of objects, honouring a range the way Storage does. */
function createFakeIo(objects: Map<string, Buffer | Error>, onRead?: (location: Location) => void) {
  const readObject = vi.fn(async (location: Location, options: { maxBytes: number; range: boolean }) => {
    onRead?.(location);
    const object = objects.get(`${location.bucket}/${location.path}`);
    if (!object) throw new Error('storage answered HTTP 404');
    if (object instanceof Error) throw object;
    return options.range
      ? { bytes: object.subarray(0, options.maxBytes), complete: object.length <= options.maxBytes }
      : { bytes: object, complete: true };
  });
  return { readObject };
}

function createLogger() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
}

describe('backfill-post-media-dimensions', () => {
  it('refuses to run without exactly one mode, before reading anything', async () => {
    expect(parseMode(['--dry-run'])).toBe('dry-run');
    expect(parseMode(['--apply'])).toBe('apply');
    expect(() => parseMode([])).toThrow('nothing was read or written');
    expect(() => parseMode(['--dry-run', '--apply'])).toThrow('not both');
    expect(() => parseMode(['--aply'])).toThrow('Unknown argument --aply');

    const createSupabase = vi.fn();
    const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key' };
    for (const argv of [[], ['--dry-run', '--apply'], ['--apply', '--limit=1']]) {
      const logger = createLogger();
      await expect(main(argv, { env, createSupabase, logger })).resolves.toBe(2);
      expect(logger.lines.join('\n')).toContain('Usage:');
    }
    const missingKey = createLogger();
    await expect(main(['--apply'], { env: { NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL }, createSupabase, logger: missingKey }))
      .resolves.toBe(2);
    expect(createSupabase).not.toHaveBeenCalled();
  });

  it('reads the displayed size from a whole image or from the head of one', async () => {
    await expect(readImageSize(png)).resolves.toEqual({ width: 30, height: 40 });
    // EXIF orientation applied, as the browsers and expo-image draw it.
    await expect(readImageSize(jpegTurned)).resolves.toEqual({ width: 800, height: 1200 });
    await expect(readImageSize(jpegTurned.subarray(0, 4096))).resolves.toEqual({ width: 800, height: 1200 });
    // sharp reads no partial WebP, which is why a head read falls back to the whole file.
    await expect(readImageSize(webpPoster.subarray(0, 512))).resolves.toBeNull();
    await expect(readImageSize(webpPoster)).resolves.toMatchObject({ width: 720 });
    await expect(readImageSize(Buffer.from('not an image'))).resolves.toBeNull();
  });

  it('plans each row from database fields alone', () => {
    const generationPost = { user_id: 'user-1', generation_id: 'gen-1' };
    const plainPost = { user_id: 'user-1', generation_id: null };
    const sized = { preview_width: 720, preview_height: 1280 };

    expect(planRow({ ...mediaRow({ id: 'a', post_id: 'p1' }), posts: plainPost }, null)).toEqual({
      sources: [{ type: 'file', location: { bucket: 'showcase_media', path: 'posts/p1/0/cover.png' }, maxBytes: expect.any(Number) }],
      reason: null,
    });
    expect(planRow({ ...mediaRow({ id: 'b', post_id: 'p1', storage_path: 'private-posts/p1/x/cover.jpg' }), posts: plainPost }, null))
      .toMatchObject({ sources: [{ type: 'file', location: { bucket: 'post_media', path: 'private-posts/p1/x/cover.jpg' } }] });
    // Another post's file, or a path that climbs out of this one, is never read.
    for (const storagePath of ['posts/p2/0/cover.png', 'posts/p1/../p2/cover.png', 'posts/p1/0/%2e%2e/cover.png']) {
      expect(planRow({ ...mediaRow({ id: 'c', post_id: 'p1', storage_path: storagePath }), posts: plainPost }, null))
        .toEqual({ sources: [], reason: 'path-outside-post-prefix' });
    }
    // The June gallery rows kept the post's output address: read it only as the creator's own storage.
    expect(planRow({
      ...mediaRow({ id: 'd', post_id: 'p1', storage_path: null, external_url: 'generated_images/user-1/out.png' }),
      posts: generationPost,
    }, sized)).toMatchObject({
      sources: [
        { type: 'file', location: { bucket: 'generated_images', path: 'user-1/out.png' } },
        { type: 'generation', size: { width: 720, height: 1280 } },
      ],
    });
    expect(planRow({
      ...mediaRow({
        id: 'e',
        post_id: 'p1',
        storage_path: null,
        external_url: 'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/out.png?token=t',
      }),
      posts: plainPost,
    }, null)).toMatchObject({ sources: [{ type: 'file', location: { bucket: 'generated_images', path: 'user-1/out.png' } }] });
    for (const externalUrl of [
      'generated_images/user-2/out.png',
      'https://project.supabase.co/storage/v1/object/public/showcase_media/showcase/gen-9/out.png',
    ]) {
      expect(planRow({ ...mediaRow({ id: 'f', post_id: 'p1', storage_path: null, external_url: externalUrl }), posts: plainPost }, null))
        .toEqual({ sources: [], reason: 'unreadable-address' });
    }
    // A provider's address is not fetched; the generation's recorded size stands in for it.
    const remote = mediaRow({ id: 'g', post_id: 'p1', storage_path: null, external_url: 'https://provider.example/out.png' });
    expect(planRow({ ...remote, posts: plainPost }, null)).toEqual({ sources: [], reason: 'remote-url' });
    expect(planRow({ ...remote, posts: generationPost }, sized))
      .toEqual({ sources: [{ type: 'generation', size: { width: 720, height: 1280 } }], reason: null });

    const video = mediaRow({
      id: 'h',
      post_id: 'p1',
      media_kind: 'video',
      storage_path: 'showcase/gen-1/clip.mp4',
      preview_storage_path: 'showcase/gen-1/clip.preview.abc.webp',
    });
    expect(planRow({ ...video, posts: generationPost }, sized)).toMatchObject({
      sources: [
        { type: 'generation', size: { width: 720, height: 1280 } },
        { type: 'poster', location: { bucket: 'showcase_media', path: 'showcase/gen-1/clip.preview.abc.webp' } },
      ],
    });
    // Only the cover is the generation's output; a later item is an upload of its own.
    expect(planRow({ ...video, sort_order: 1, preview_storage_path: null, posts: generationPost }, sized))
      .toEqual({ sources: [], reason: 'video-without-poster' });
    expect(planRow({ ...video, source_unavailable_at: '2026-09-08T00:00:00Z', posts: generationPost }, sized))
      .toEqual({ sources: [], reason: 'source-unavailable' });

    // A post whose creation was deleted keeps its cover under the creation's
    // folder, and records that creation.
    const deletedCreationPost = { user_id: 'user-1', generation_id: null, deleted_generation_id: 'gen-1' };
    expect(planRow({ ...mediaRow({ id: 'i', post_id: 'p1', storage_path: 'showcase/gen-1/cover.png' }), posts: deletedCreationPost }, null))
      .toMatchObject({ sources: [{ type: 'file', location: { bucket: 'showcase_media', path: 'showcase/gen-1/cover.png' } }] });
    expect(planRow({ ...mediaRow({ id: 'j', post_id: 'p1', storage_path: 'showcase/gen-2/cover.png' }), posts: deletedCreationPost }, null))
      .toEqual({ sources: [], reason: 'path-outside-post-prefix' });
  });

  it('a dry run reports and leaves every row as it was', async () => {
    const state = {
      posts: [
        { id: 'p1', user_id: 'user-1', generation_id: 'gen-1' },
        { id: 'p2', user_id: 'user-1', generation_id: null },
      ],
      generations: [{ id: 'gen-1', preview_width: 720, preview_height: 1280 }],
      media: [
        // A legacy row: the June gallery backfill kept the post's signed output URL.
        mediaRow({
          id: 'm1',
          post_id: 'p1',
          storage_path: null,
          external_url: 'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/out.png?token=SECRET-TOKEN',
        }),
        mediaRow({ id: 'm2', post_id: 'p2', media_kind: 'video', storage_path: 'posts/p2/0/clip.mp4' }),
        mediaRow({ id: 'm3', post_id: 'p2', sort_order: 1, width: 640, height: 480 }),
      ],
    };
    const before = structuredClone(state.media);
    const { client, updates } = createFakeClient(state);
    const io = createFakeIo(new Map());
    const logger = createLogger();

    const result = await runBackfill({ supabase: client, mode: 'dry-run', io, logger });

    expect(updates).toEqual([]);
    expect(io.readObject).not.toHaveBeenCalled();
    expect(state.media).toEqual(before);
    expect(result).toMatchObject({ mode: 'dry-run', counts: { total: 2, image: 1, video: 1 }, rows: 2, updated: 0 });
    const output = logger.lines.join('\n');
    expect(output).toContain('post_media rows without a usable size: 2 (image 1, video 1)');
    expect(output).toContain('m1  post p1  image  external_url https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/out.png?…');
    expect(output).toContain('m2  post p2  video  storage_path posts/p2/0/clip.mp4');
    expect(output).toContain('image: file 1');
    expect(output).toContain('nothing to read from: 1 (video-without-poster 1)');
    expect(output).toContain('Dry run: nothing was written.');
    expect(output).not.toContain('SECRET-TOKEN');
  });

  it('applies in batches of 100, sizing only the rows that have none, and a second run finds nothing', async () => {
    const media = Array.from({ length: 150 }, (_, index) => mediaRow({
      id: `m${String(index).padStart(3, '0')}`,
      post_id: `p${index}`,
    }));
    media.push(mediaRow({ id: 'sized', post_id: 'p0', sort_order: 1, width: 640, height: 480 }));
    const state = {
      media,
      posts: media.map((row) => ({ id: row.post_id, user_id: 'user-1', generation_id: null })),
      generations: [],
    };
    const { client, updates } = createFakeClient(state);
    const io = createFakeIo(new Map(media.map((row) => [`showcase_media/${row.storage_path}`, png])));
    const logger = createLogger();

    const result = await runBackfill({ supabase: client, mode: 'apply', io, logger });

    expect(BATCH_SIZE).toBe(100);
    expect(logger.lines).toContain('batch 1: 100 rows · updated 100 · skipped 0 · failed 0');
    expect(logger.lines).toContain('batch 2: 50 rows · updated 50 · skipped 0 · failed 0');
    expect(result).toMatchObject({ rows: 150, updated: 150, skipped: 0, failed: 0 });
    expect(updates).toHaveLength(150);
    expect(updates.every((update) => update.values.width === 30 && update.values.height === 40)).toBe(true);
    expect(state.media.find((row) => row.id === 'sized')).toMatchObject({ width: 640, height: 480 });
    expect(updates.map((update) => update.id)).not.toContain('sized');

    const again = createLogger();
    const second = await runBackfill({ supabase: client, mode: 'apply', io, logger: again });
    expect(second).toMatchObject({ counts: { total: 0 }, rows: 0, updated: 0 });
    expect(again.lines.some((line) => line.startsWith('batch '))).toBe(false);
    expect(updates).toHaveLength(150);
  });

  it('never writes over a size that arrived meanwhile, and counts what it cannot size', async () => {
    const state = {
      posts: [
        { id: 'p1', user_id: 'user-1', generation_id: null },
        { id: 'p2', user_id: 'user-1', generation_id: 'gen-2' },
      ],
      generations: [{ id: 'gen-2', preview_width: 720, preview_height: 1280 }],
      media: [
        mediaRow({ id: 'raced', post_id: 'p1', storage_path: 'posts/p1/0/raced.png' }),
        mediaRow({ id: 'gone', post_id: 'p1', sort_order: 1, storage_path: 'posts/p1/1/gone.png' }),
        mediaRow({ id: 'webp', post_id: 'p1', sort_order: 2, storage_path: 'posts/p1/2/poster.webp' }),
        mediaRow({ id: 'silent', post_id: 'p1', sort_order: 3, media_kind: 'video', storage_path: 'posts/p1/3/clip.mp4' }),
        mediaRow({ id: 'creation', post_id: 'p2', media_kind: 'video', storage_path: 'showcase/gen-2/clip.mp4' }),
      ],
    };
    const { client, updates } = createFakeClient(state);
    const io = createFakeIo(new Map([
      ['showcase_media/posts/p1/0/raced.png', png],
      ['showcase_media/posts/p1/2/poster.webp', webpPoster],
    ]), (location) => {
      // The preview sweep measures this row between the read and the write.
      if (location.path === 'posts/p1/0/raced.png') Object.assign(state.media[0], { width: 1080, height: 1350 });
    });
    const logger = createLogger();

    const result = await runBackfill({ supabase: client, mode: 'apply', io, logger });

    expect(result).toMatchObject({ rows: 5, updated: 2, skipped: 2, failed: 1 });
    expect(state.media.find((row) => row.id === 'raced')).toMatchObject({ width: 1080, height: 1350 });
    // A WebP's head is unreadable, so the whole (small) file is read instead.
    expect(state.media.find((row) => row.id === 'webp')).toMatchObject({ width: 720 });
    expect(io.readObject).toHaveBeenCalledWith({ bucket: 'showcase_media', path: 'posts/p1/2/poster.webp' }, expect.objectContaining({ range: false }));
    // A video is never downloaded: its generation's recorded preview size stands in.
    expect(state.media.find((row) => row.id === 'creation')).toMatchObject({ width: 720, height: 1280 });
    expect(io.readObject).not.toHaveBeenCalledWith(expect.objectContaining({ path: 'showcase/gen-2/clip.mp4' }), expect.anything());
    expect(state.media.find((row) => row.id === 'silent')).toMatchObject({ width: null, height: null });
    expect(updates.map((update) => update.id).sort()).toEqual(['creation', 'webp']);
    expect(logger.lines).toContain(
      'batch 1: 5 rows · updated 2 · skipped 2 (sized-meanwhile 1, video-without-poster 1) · failed 1 (file: storage answered HTTP 404 1)',
    );
  });

  it('reads only the head of an object, whether or not the server honours the range', async () => {
    const body = (bytes: Buffer) => new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 1000) controller.enqueue(bytes.subarray(offset, offset + 1000));
        controller.close();
      },
    });
    const object = Buffer.alloc(10_000, 7);
    const ranged = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('range')).toBe('bytes=0-4095');
      return new Response(body(object.subarray(0, 4096)), { status: 206, headers: { 'content-range': 'bytes 0-4095/10000' } });
    });
    await expect(readObjectBytes('https://storage.example/o', { maxBytes: 4096, range: true, fetchImpl: ranged }))
      .resolves.toMatchObject({ complete: false, bytes: expect.objectContaining({ length: 4096 }) });

    const ignoresRange = vi.fn(async () => new Response(body(object), { status: 200 }));
    await expect(readObjectBytes('https://storage.example/o', { maxBytes: 4096, range: true, fetchImpl: ignoresRange }))
      .resolves.toMatchObject({ complete: false, bytes: expect.objectContaining({ length: 4096 }) });

    const small = vi.fn(async () => new Response(body(object.subarray(0, 100)), {
      status: 206,
      headers: { 'content-range': 'bytes 0-99/100' },
    }));
    await expect(readObjectBytes('https://storage.example/o', { maxBytes: 4096, range: true, fetchImpl: small }))
      .resolves.toMatchObject({ complete: true, bytes: expect.objectContaining({ length: 100 }) });

    const tooLarge = vi.fn(async () => new Response(body(object), { status: 200 }));
    await expect(readObjectBytes('https://storage.example/o', { maxBytes: 4096, range: false, fetchImpl: tooLarge }))
      .rejects.toThrow('larger than 4096 bytes');

    const missing = vi.fn(async () => new Response('nope', { status: 404 }));
    await expect(readObjectBytes('https://storage.example/o?token=SECRET', { maxBytes: 4096, range: true, fetchImpl: missing }))
      .rejects.toThrow(/^storage answered HTTP 404$/);
  });

  it('reads the public bucket by its public URL and the private ones by a signed URL', async () => {
    const getPublicUrl = vi.fn((path: string) => ({ data: { publicUrl: `https://cdn.example/${path}` } }));
    const createSignedUrl = vi.fn(async (path: string) => ({ data: { signedUrl: `https://signed.example/${path}?token=t` }, error: null }));
    const supabase = { storage: { from: vi.fn(() => ({ getPublicUrl, createSignedUrl })) } };
    const fetchImpl = vi.fn<(url: string | URL | Request) => Promise<Response>>(
      async () => new Response(new Uint8Array(png), { status: 200 }),
    );
    const io = createStorageIo(supabase, fetchImpl);

    await io.readObject({ bucket: 'showcase_media', path: 'posts/p1/0/a.png' }, { maxBytes: 4096, range: true });
    await io.readObject({ bucket: 'post_media', path: 'private-posts/p1/x/a.png' }, { maxBytes: 4096, range: true });

    expect(getPublicUrl).toHaveBeenCalledWith('posts/p1/0/a.png');
    expect(createSignedUrl).toHaveBeenCalledWith('private-posts/p1/x/a.png', expect.any(Number));
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://cdn.example/posts/p1/0/a.png',
      'https://signed.example/private-posts/p1/x/a.png?token=t',
    ]);
  });
});
