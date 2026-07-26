import { describe, expect, it, vi } from 'vitest';

import {
  buildStorageTarget,
  inferMediaTarget,
  isPrivateOrSpecialIp,
  parseGenerationIdArgument,
  runBackfill,
} from '../../scripts/backfill-legacy-temp-media.mjs';

const IMAGE_GENERATION = {
  id: '24f5537e-f5db-4a26-8db3-c3d89f3ed261',
  user_id: '28677503-bfbe-4e99-9105-b8f0c7e0e507',
  prediction_id: '582fa1827ca37b5d621536962040a8cd',
  output_url: 'https://tempfile.aiquickdraw.com/image-format-converter/example.jpg',
  model: 'nano-banana-2',
  category: 'image',
  created_at: '2026-03-29T04:07:55.000Z',
};

const VIDEO_GENERATION = {
  ...IMAGE_GENERATION,
  id: '058a82f8-b08a-418f-a420-561a501dae02',
  prediction_id: 'fefea6ed79feb9b382ec90574de23981',
  output_url: 'https://tempfile.aiquickdraw.com/result/example.mp4',
  model: 'kling-2.6/motion-control',
  category: 'motion',
};

const JPEG_BYTES = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x02, 0x03, 0xff, 0xd9,
]);
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

function isoMediaBytes(brand: string) {
  const bytes = Buffer.alloc(20);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.write('ftyp', 4, 'ascii');
  bytes.write(brand, 8, 'ascii');
  bytes.writeUInt32BE(0, 12);
  bytes.write(brand === 'qt  ' ? 'qt  ' : 'mp42', 16, 'ascii');
  return bytes;
}

function mediaBlob(bytes: BlobPart, contentType: string) {
  return new Blob([bytes], { type: contentType });
}

function objectKey(extension: string, bucket = 'generated_images') {
  return `${bucket}/${IMAGE_GENERATION.user_id}/generated_${IMAGE_GENERATION.prediction_id}.${extension}`;
}

function mediaResponse(bytes: Uint8Array, contentType: string) {
  return new Response(Uint8Array.from(bytes), {
    status: 200,
    headers: {
      'content-length': String(bytes.byteLength),
      'content-type': contentType,
    },
  });
}

type QueryResult = {
  count?: number | null;
  data?: unknown;
  error: null | { message: string };
};

type StoredObject = {
  blob: Blob;
  info?: { size: number; contentType: string };
  infoError?: Record<string, unknown>;
};

function createSupabaseMock({
  generationRows = [IMAGE_GENERATION],
  posts = [{
    id: 'post-1',
    user_id: IMAGE_GENERATION.user_id,
    output_url: IMAGE_GENERATION.output_url,
  }],
  objects = {},
  missingObjectError = {
    status: 404,
    statusCode: '404',
    message: 'Object not found',
  },
  referenceCounts = { generations: 0, posts: 0 },
  rpcData = {
    status: 'relinked',
    generation_id: IMAGE_GENERATION.id,
    generation_changed: true,
    posts_changed: 1,
    output_url: objectKey('jpg'),
  },
  rpcError = null,
  uploadError = null,
}: {
  generationRows?: Array<typeof IMAGE_GENERATION>;
  posts?: Array<{ id: string; user_id: string; output_url: string | null }>;
  objects?: Record<string, StoredObject>;
  missingObjectError?: Record<string, unknown>;
  referenceCounts?: { generations: number | null; posts: number | null };
  rpcData?: unknown;
  rpcError?: null | { message: string };
  uploadError?: null | { message: string; status?: number };
} = {}) {
  const storedObjects = new Map(Object.entries(objects));
  const upload = vi.fn(async (
    bucket: string,
    filePath: string,
    body: BlobPart,
    options: { contentType: string },
  ) => {
    if (uploadError) return { data: null, error: uploadError };
    const blob = mediaBlob(body, options.contentType);
    storedObjects.set(`${bucket}/${filePath}`, {
      blob,
      info: { size: blob.size, contentType: options.contentType },
    });
    return { data: { path: filePath }, error: null };
  });
  const remove = vi.fn().mockResolvedValue({ data: [], error: null });
  const info = vi.fn(async (bucket: string, filePath: string) => {
    const stored = storedObjects.get(`${bucket}/${filePath}`);
    if (!stored) return { data: null, error: missingObjectError };
    if (stored.infoError) return { data: null, error: stored.infoError };
    return {
      data: stored.info ?? {
        size: stored.blob.size,
        contentType: stored.blob.type,
      },
      error: null,
    };
  });
  const download = vi.fn(async (bucket: string, filePath: string) => {
    const stored = storedObjects.get(`${bucket}/${filePath}`);
    return stored
      ? { data: stored.blob, error: null }
      : { data: null, error: missingObjectError };
  });
  const rpc = vi.fn().mockResolvedValue({ data: rpcData, error: rpcError });

  class QueryBuilder implements PromiseLike<QueryResult> {
    action: 'select' | null = null;
    filters: Record<string, unknown> = {};
    selectOptions: { count?: string; head?: boolean } | undefined;

    constructor(readonly table: string) {}

    select(_columns: string, options?: { count?: string; head?: boolean }) {
      this.action = 'select';
      this.selectOptions = options;
      return this;
    }

    eq(column: string, value: unknown) {
      this.filters[column] = value;
      return this;
    }

    like(column: string, value: unknown) {
      this.filters[column] = value;
      return this;
    }

    order() {
      return this;
    }

    range() {
      return this.execute();
    }

    execute(): Promise<QueryResult> {
      if (this.action !== 'select') {
        throw new Error(`Unexpected query: ${this.table}/${this.action}`);
      }
      if (this.selectOptions?.head) {
        const count = this.table === 'generations'
          ? referenceCounts.generations
          : referenceCounts.posts;
        return Promise.resolve({ count, data: null, error: null });
      }
      if (this.table === 'generations') {
        return Promise.resolve({ data: generationRows, error: null });
      }
      if (this.table === 'posts') {
        return Promise.resolve({ data: posts, error: null });
      }
      throw new Error(`Unexpected table: ${this.table}`);
    }

    then<TResult1 = QueryResult, TResult2 = never>(
      onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return this.execute().then(onfulfilled, onrejected);
    }
  }

  return {
    client: {
      from: (table: string) => new QueryBuilder(table),
      rpc,
      storage: {
        from: (bucket: string) => ({
          download: (filePath: string) => download(bucket, filePath),
          info: (filePath: string) => info(bucket, filePath),
          remove: (filePaths: string[]) => remove(bucket, filePaths),
          upload: (
            filePath: string,
            body: BlobPart,
            options: { contentType: string },
          ) => upload(bucket, filePath, body, options),
        }),
      },
    },
    download,
    info,
    remove,
    rpc,
    upload,
  };
}

function logger() {
  return {
    error: vi.fn(),
    log: vi.fn(),
  };
}

const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];

describe('legacy temporary media backfill', () => {
  it('parses and validates an optional generation id filter', () => {
    const id = '24F5537E-F5DB-4A26-8DB3-C3D89F3ED261';
    expect(parseGenerationIdArgument([`--generation-id=${id}`])).toBe(id.toLowerCase());
    expect(parseGenerationIdArgument(['--generation-id', id])).toBe(id.toLowerCase());
    expect(parseGenerationIdArgument([])).toBeNull();
    expect(() => parseGenerationIdArgument(['--generation-id=not-a-uuid'])).toThrow(/canonical UUID/);
    expect(() => parseGenerationIdArgument([
      `--generation-id=${id}`,
      '--generation-id',
      id,
    ])).toThrow(/only be supplied once/);
  });

  it('builds owner-scoped targets and rejects unsafe or cross-kind inputs', () => {
    expect(buildStorageTarget(IMAGE_GENERATION)).toMatchObject({
      bucket: 'generated_images',
      extension: 'jpg',
      filePath: `${IMAGE_GENERATION.user_id}/generated_${IMAGE_GENERATION.prediction_id}.jpg`,
    });
    expect(buildStorageTarget(VIDEO_GENERATION)).toMatchObject({
      bucket: 'generated_videos',
      extension: 'mp4',
      kind: 'video',
    });
    expect(buildStorageTarget({ ...IMAGE_GENERATION, user_id: '../other-user' })).toBeNull();
    expect(buildStorageTarget({ ...IMAGE_GENERATION, prediction_id: 'task/id' })).toBeNull();
    expect(inferMediaTarget(IMAGE_GENERATION, 'text/html')).toBeNull();
    expect(inferMediaTarget(IMAGE_GENERATION, 'video/mp4')).toBeNull();
    expect(inferMediaTarget(VIDEO_GENERATION, 'image/jpeg')).toBeNull();
  });

  it('classifies private, reserved, and public DNS addresses fail-closed', () => {
    expect(isPrivateOrSpecialIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrSpecialIp('10.1.2.3')).toBe(true);
    expect(isPrivateOrSpecialIp('198.51.100.4')).toBe(true);
    expect(isPrivateOrSpecialIp('203.0.113.8')).toBe(true);
    expect(isPrivateOrSpecialIp('::1')).toBe(true);
    expect(isPrivateOrSpecialIp('8.8.8.8')).toBe(false);
    expect(isPrivateOrSpecialIp('2606:4700:4700::1111')).toBe(false);
  });

  it('reuses an exact durable object and relinks through the atomic RPC', async () => {
    const durablePath = objectKey('jpg');
    const supabase = createSupabaseMock({
      objects: {
        [durablePath]: { blob: mediaBlob(JPEG_BYTES, 'image/jpeg') },
      },
    });
    const fetcher = vi.fn(() => {
      throw new Error('fetch must not run when an exact object exists');
    });

    const result = await runBackfill({
      supabase: supabase.client as never,
      dryRun: false,
      fetcher: fetcher as never,
      logger: logger(),
    });

    expect(result).toMatchObject({ migrated: 1, failed: 0, skipped: 0, exitCode: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(supabase.upload).not.toHaveBeenCalled();
    expect(supabase.rpc).toHaveBeenCalledWith('relink_legacy_generation_media', {
      p_generation_id: IMAGE_GENERATION.id,
      p_expected_output_url: IMAGE_GENERATION.output_url,
      p_new_output_url: durablePath,
    });
  });

  it('recovers a valid alternate-extension deterministic object', async () => {
    const durablePath = objectKey('png');
    const supabase = createSupabaseMock({
      objects: {
        [durablePath]: { blob: mediaBlob(PNG_BYTES, 'image/png') },
      },
      rpcData: {
        status: 'relinked',
        generation_id: IMAGE_GENERATION.id,
        generation_changed: true,
        posts_changed: 1,
        output_url: durablePath,
      },
    });
    const fetcher = vi.fn();

    const result = await runBackfill({
      supabase: supabase.client as never,
      dryRun: false,
      fetcher,
      logger: logger(),
    });

    expect(result).toMatchObject({ migrated: 1, failed: 0, exitCode: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(supabase.rpc).toHaveBeenCalledWith(
      'relink_legacy_generation_media',
      expect.objectContaining({ p_new_output_url: durablePath }),
    );
  });

  it('fails when multiple deterministic media objects exist', async () => {
    const supabase = createSupabaseMock({
      objects: {
        [objectKey('jpg')]: { blob: mediaBlob(JPEG_BYTES, 'image/jpeg') },
        [objectKey('png')]: { blob: mediaBlob(PNG_BYTES, 'image/png') },
      },
    });
    const fetcher = vi.fn();

    const result = await runBackfill({
      supabase: supabase.client as never,
      dryRun: true,
      fetcher,
      logger: logger(),
    });

    expect(result).toMatchObject({ migrated: 0, failed: 1, exitCode: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed when the source and durable object are missing', async () => {
    const supabase = createSupabaseMock();
    const fetcher = vi.fn().mockResolvedValue(new Response('gone', { status: 404 }));

    const result = await runBackfill({
      supabase: supabase.client as never,
      dryRun: true,
      fetcher,
      lookup: publicLookup,
      logger: logger(),
    });

    expect(result).toMatchObject({ migrated: 0, failed: 1, skipped: 0, exitCode: 1 });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.upload).not.toHaveBeenCalled();
    expect(supabase.remove).not.toHaveBeenCalled();
  });

  it('fails a targeted run when the generation is no longer a candidate', async () => {
    const supabase = createSupabaseMock({ generationRows: [] });
    const result = await runBackfill({
      supabase: supabase.client as never,
      dryRun: true,
      generationId: IMAGE_GENERATION.id,
      logger: logger(),
    });

    expect(result).toMatchObject({ selected: 0, migrated: 0, failed: 1, exitCode: 1 });
  });

  it('refuses incompatible or size-mismatched deterministic objects', async () => {
    const jpegBlob = mediaBlob(JPEG_BYTES, 'image/jpeg');
    const incompatible = createSupabaseMock({
      objects: {
        [objectKey('jpg')]: {
          blob: jpegBlob,
          info: { size: 0, contentType: 'text/html' },
        },
      },
    });
    const sizeMismatch = createSupabaseMock({
      objects: {
        [objectKey('jpg')]: {
          blob: jpegBlob,
          info: { size: jpegBlob.size + 1, contentType: 'image/jpeg' },
        },
      },
    });
    const fetcher = vi.fn();

    for (const supabase of [incompatible, sizeMismatch]) {
      const result = await runBackfill({
        supabase: supabase.client as never,
        dryRun: true,
        fetcher,
        logger: logger(),
      });
      expect(result).toMatchObject({ migrated: 0, failed: 1, exitCode: 1 });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('only treats explicit storage not-found errors as absence', async () => {
    const supabase = createSupabaseMock({
      missingObjectError: { status: 400, message: 'Malformed storage request' },
    });
    const fetcher = vi.fn();

    const result = await runBackfill({
      supabase: supabase.client as never,
      dryRun: true,
      fetcher,
      logger: logger(),
    });

    expect(result).toMatchObject({ migrated: 0, failed: 1, exitCode: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires a declared allowed MIME type and valid complete media bytes', async () => {
    const cases = [
      new Response(JPEG_BYTES, {
        status: 200,
        headers: { 'content-length': String(JPEG_BYTES.byteLength) },
      }),
      mediaResponse(new TextEncoder().encode('<html>'), 'image/jpeg'),
      mediaResponse(JPEG_BYTES.subarray(0, 6), 'image/jpeg'),
      mediaResponse(isoMediaBytes('isom'), 'video/mp4'),
    ];

    for (const [index, response] of cases.entries()) {
      const generationRows = index === cases.length - 1 ? [IMAGE_GENERATION] : undefined;
      const supabase = createSupabaseMock({ generationRows });
      const result = await runBackfill({
        supabase: supabase.client as never,
        dryRun: true,
        fetcher: vi.fn().mockResolvedValue(response),
        lookup: publicLookup,
        logger: logger(),
      });
      expect(result).toMatchObject({ migrated: 0, failed: 1, exitCode: 1 });
      expect(supabase.upload).not.toHaveBeenCalled();
      expect(supabase.rpc).not.toHaveBeenCalled();
    }
  });

  it('distinguishes MP4 and QuickTime signatures', async () => {
    const quickTimeAsMp4 = createSupabaseMock({ generationRows: [VIDEO_GENERATION] });
    const mp4AsQuickTime = createSupabaseMock({
      generationRows: [{ ...VIDEO_GENERATION, output_url: VIDEO_GENERATION.output_url.replace('.mp4', '.mov') }],
    });

    const first = await runBackfill({
      supabase: quickTimeAsMp4.client as never,
      dryRun: true,
      fetcher: vi.fn().mockResolvedValue(mediaResponse(isoMediaBytes('qt  '), 'video/mp4')),
      lookup: publicLookup,
      logger: logger(),
    });
    const second = await runBackfill({
      supabase: mp4AsQuickTime.client as never,
      dryRun: true,
      fetcher: vi.fn().mockResolvedValue(mediaResponse(isoMediaBytes('isom'), 'video/quicktime')),
      lookup: publicLookup,
      logger: logger(),
    });

    expect(first).toMatchObject({ migrated: 0, failed: 1 });
    expect(second).toMatchObject({ migrated: 0, failed: 1 });
  });

  it('accepts valid MP4 and QuickTime streams with or without a length header', async () => {
    const cases = [
      { extension: 'mp4', contentType: 'video/mp4', brand: 'isom', declareLength: true },
      { extension: 'mp4', contentType: 'video/mp4', brand: 'M4V ', declareLength: false },
      { extension: 'mov', contentType: 'video/quicktime', brand: 'qt  ', declareLength: false },
    ];

    for (const testCase of cases) {
      const generation = {
        ...VIDEO_GENERATION,
        output_url: `https://tempfile.aiquickdraw.com/result/example.${testCase.extension}`,
      };
      const supabase = createSupabaseMock({
        generationRows: [generation],
        posts: [{
          id: `post-${testCase.extension}`,
          user_id: generation.user_id,
          output_url: generation.output_url,
        }],
      });
      const bytes = isoMediaBytes(testCase.brand);
      const headers: Record<string, string> = { 'content-type': testCase.contentType };
      if (testCase.declareLength) headers['content-length'] = String(bytes.byteLength);

      const result = await runBackfill({
        supabase: supabase.client as never,
        dryRun: true,
        fetcher: vi.fn().mockResolvedValue(new Response(bytes, { status: 200, headers })),
        lookup: publicLookup,
        logger: logger(),
      });

      expect(result).toMatchObject({ migrated: 1, failed: 0, exitCode: 0 });
      expect(supabase.upload).not.toHaveBeenCalled();
      expect(supabase.rpc).not.toHaveBeenCalled();
    }
  });

  it('blocks private DNS before the request and on redirect hops', async () => {
    const initialSupabase = createSupabaseMock();
    const initialFetcher = vi.fn();
    const initialResult = await runBackfill({
      supabase: initialSupabase.client as never,
      dryRun: true,
      fetcher: initialFetcher,
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      logger: logger(),
    });

    const redirectSupabase = createSupabaseMock();
    const redirectFetcher = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'https://file.aiquickdraw.com/result.jpg' },
    }));
    const redirectResult = await runBackfill({
      supabase: redirectSupabase.client as never,
      dryRun: true,
      fetcher: redirectFetcher,
      lookup: async (hostname: string) => [{
        address: hostname === 'tempfile.aiquickdraw.com' ? '8.8.8.8' : '127.0.0.1',
        family: 4,
      }],
      logger: logger(),
    });

    expect(initialResult).toMatchObject({ migrated: 0, failed: 1 });
    expect(initialFetcher).not.toHaveBeenCalled();
    expect(redirectResult).toMatchObject({ migrated: 0, failed: 1 });
    expect(redirectFetcher).toHaveBeenCalledTimes(1);
  });

  it('fully validates a dry-run stream and performs no writes', async () => {
    const supabase = createSupabaseMock();
    const fetcher = vi.fn().mockResolvedValue(mediaResponse(JPEG_BYTES, 'image/jpeg'));

    const result = await runBackfill({
      supabase: supabase.client as never,
      dryRun: true,
      fetcher,
      lookup: publicLookup,
      logger: logger(),
    });

    expect(result).toMatchObject({ migrated: 1, failed: 0, exitCode: 0 });
    expect(supabase.upload).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.remove).not.toHaveBeenCalled();
    expect(supabase.info).toHaveBeenCalledTimes(4);
  });

  it('detects a cross-owner linked post before uploading', async () => {
    const supabase = createSupabaseMock({
      posts: [{
        id: 'post-cross-owner',
        user_id: '4e881a7d-3ef4-4be9-9cbc-941c4e2c37c4',
        output_url: IMAGE_GENERATION.output_url,
      }],
    });

    const result = await runBackfill({
      supabase: supabase.client as never,
      dryRun: false,
      fetcher: vi.fn().mockResolvedValue(mediaResponse(JPEG_BYTES, 'image/jpeg')),
      lookup: publicLookup,
      logger: logger(),
    });

    expect(result).toMatchObject({ migrated: 0, failed: 1, exitCode: 1 });
    expect(supabase.upload).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('retains a new deterministic object when an RPC response is malformed', async () => {
    const testLogger = logger();
    const supabase = createSupabaseMock({
      rpcData: { status: 'relinked' },
      referenceCounts: { generations: null, posts: 0 },
    });

    const result = await runBackfill({
      supabase: supabase.client as never,
      dryRun: false,
      fetcher: vi.fn().mockResolvedValue(mediaResponse(JPEG_BYTES, 'image/jpeg')),
      lookup: publicLookup,
      logger: testLogger,
    });

    expect(result).toMatchObject({ migrated: 0, failed: 1, exitCode: 1 });
    expect(supabase.upload).toHaveBeenCalledTimes(1);
    expect(supabase.remove).not.toHaveBeenCalled();
    expect(testLogger.error).toHaveBeenCalledWith(expect.stringContaining(
      'retained uploaded media because cleanup safety could not be verified',
    ));
  });
});
