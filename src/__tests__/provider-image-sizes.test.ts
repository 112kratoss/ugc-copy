import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type BackendLogRecord, setBackendLogSink } from '@/lib/backend-logger';
import {
  logProviderImageSizesOverLimit,
  lookupImageSizes,
} from '@/lib/provider-image-sizes';

const MB = 1024 * 1024;
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const SUPABASE = 'https://project.supabase.co';
const MEDIA_HOST = 'tempfile.aiquickdraw.com';

type ReservationRow = {
  user_id: string;
  bucket_id: string;
  storage_path: string;
  actual_bytes: number | null;
  finalization_status: string;
};

type Filter = ['eq' | 'in', string, unknown];

/**
 * A service client holding upload reservations and storage objects. It records each
 * reservation read and each object's metadata read, which is all the lookups ask of it.
 */
function createClient({
  reservations = [],
  objects = {},
  reservationError = null,
}: {
  reservations?: ReservationRow[];
  objects?: Record<string, number>;
  reservationError?: { message: string } | null;
} = {}) {
  const reservationReads: Array<{ columns: string; filters: Filter[] }> = [];
  const infoReads: string[] = [];
  const matches = (row: ReservationRow, filters: Filter[]) => filters.every(([kind, column, value]) => {
    const cell = (row as Record<string, unknown>)[column];
    return kind === 'eq' ? cell === value : (value as unknown[]).includes(cell);
  });
  const client = {
    rpc: vi.fn(),
    from: vi.fn((table: string) => {
      if (table !== 'upload_byte_reservations') throw new Error(`unexpected table ${table}`);
      const read = { columns: '', filters: [] as Filter[] };
      reservationReads.push(read);
      const builder = {
        select(columns: string) {
          read.columns = columns;
          return builder;
        },
        eq(column: string, value: unknown) {
          read.filters.push(['eq', column, value]);
          return builder;
        },
        in(column: string, values: unknown[]) {
          read.filters.push(['in', column, values]);
          return builder;
        },
        then<T>(resolve: (value: { data: unknown; error: unknown }) => T, reject?: (reason: unknown) => T) {
          const result = reservationError
            ? { data: null, error: reservationError }
            : { data: reservations.filter((row) => matches(row, read.filters)), error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    }),
    storage: {
      from: vi.fn((bucket: string) => ({
        info: vi.fn(async (path: string) => {
          infoReads.push(`${bucket}/${path}`);
          const size = objects[`${bucket}/${path}`];
          return size === undefined
            ? { data: null, error: { message: 'Object not found', statusCode: '404' } }
            : { data: { id: 'object-id', size, contentType: 'image/png' }, error: null };
        }),
      })),
    },
  };
  return { client, reservationReads, infoReads };
}

function upload(path: string, actualBytes: number | null, status = 'finalized', bucket = 'uploads'): ReservationRow {
  return {
    user_id: USER_ID,
    bucket_id: bucket,
    storage_path: path,
    actual_bytes: actualBytes,
    finalization_status: status,
  };
}

function signed(bucket: string, path: string): string {
  return `${SUPABASE}/storage/v1/object/sign/${bucket}/${path}?token=signed-token`;
}

function headResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

const publicDns = vi.fn(async () => [{ address: '104.18.1.1', family: 4 }]);

describe('image size lookups', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE);
    vi.stubEnv('MEDIA_IMPORT_HOST_ALLOWLIST', MEDIA_HOST);
    publicDns.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads every upload of a run in one reservation read, and nothing else for them', async () => {
    const { client, reservationReads, infoReads } = createClient({
      reservations: [
        upload(`${USER_ID}/a.png`, 3 * MB),
        upload(`${USER_ID}/b.png`, 12 * MB),
        upload(`${USER_ID}/run-1/staging/face/c.png`, 7 * MB, 'consumed', 'template_inputs'),
      ],
    });
    const fetcher = vi.fn();

    const sizes = await lookupImageSizes([
      `uploads/${USER_ID}/a.png`,
      signed('uploads', `${USER_ID}/b.png`),
      `template_inputs/${USER_ID}/run-1/staging/face/c.png`,
    ], { supabase: client as never, userId: USER_ID }, { fetcher });

    expect([...sizes.values()]).toEqual([3 * MB, 12 * MB, 7 * MB]);
    expect(reservationReads).toHaveLength(1);
    expect(reservationReads[0].filters).toEqual(expect.arrayContaining([
      ['eq', 'user_id', USER_ID],
      ['in', 'bucket_id', expect.arrayContaining(['uploads', 'template_inputs'])],
      ['in', 'storage_path', expect.arrayContaining([`${USER_ID}/a.png`, `${USER_ID}/b.png`])],
    ]));
    expect(infoReads).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads storage metadata for an upload its reservation cannot vouch for', async () => {
    const { client, infoReads } = createClient({
      reservations: [
        // Never finalized: the size the client declared is not trusted.
        upload(`${USER_ID}/declared.png`, null, 'issued'),
        // Reclaimed: the object is gone, so its old size says nothing.
        upload(`${USER_ID}/reclaimed.png`, 12 * MB, 'deleted'),
      ],
      objects: { [`uploads/${USER_ID}/declared.png`]: 11 * MB, [`uploads/${USER_ID}/legacy.png`]: 2 * MB },
    });

    const sizes = await lookupImageSizes([
      `uploads/${USER_ID}/declared.png`,
      `uploads/${USER_ID}/reclaimed.png`,
      `uploads/${USER_ID}/legacy.png`,
    ], { supabase: client as never, userId: USER_ID });

    expect(Object.fromEntries(sizes)).toEqual({
      [`uploads/${USER_ID}/declared.png`]: 11 * MB,
      [`uploads/${USER_ID}/reclaimed.png`]: null,
      [`uploads/${USER_ID}/legacy.png`]: 2 * MB,
    });
    expect(infoReads.sort()).toEqual([
      `uploads/${USER_ID}/declared.png`,
      `uploads/${USER_ID}/legacy.png`,
      `uploads/${USER_ID}/reclaimed.png`,
    ]);
  });

  it('falls back to storage metadata when the reservation read fails', async () => {
    const { client, infoReads } = createClient({
      reservationError: { message: 'statement timeout' },
      objects: { [`uploads/${USER_ID}/a.png`]: 4 * MB },
    });

    const sizes = await lookupImageSizes([`uploads/${USER_ID}/a.png`], { supabase: client as never, userId: USER_ID });

    expect(sizes.get(`uploads/${USER_ID}/a.png`)).toBe(4 * MB);
    expect(infoReads).toEqual([`uploads/${USER_ID}/a.png`]);
  });

  it('reads a generated or remix-imported picture’s size from storage metadata', async () => {
    const generated = signed('generated_images', `${USER_ID}/generated_task-1.png`);
    const imported = signed('generation_inputs', `${USER_ID}/remix-imports/generation-9/look.png`);
    const { client, reservationReads, infoReads } = createClient({
      objects: {
        [`generated_images/${USER_ID}/generated_task-1.png`]: 9 * MB,
        [`generation_inputs/${USER_ID}/remix-imports/generation-9/look.png`]: 15 * MB,
      },
    });

    const sizes = await lookupImageSizes([generated, imported], { supabase: client as never, userId: USER_ID });

    expect(sizes.get(generated)).toBe(9 * MB);
    expect(sizes.get(imported)).toBe(15 * MB);
    expect(reservationReads).toEqual([]);
    expect(infoReads.sort()).toEqual([
      `generated_images/${USER_ID}/generated_task-1.png`,
      `generation_inputs/${USER_ID}/remix-imports/generation-9/look.png`,
    ]);
  });

  it('sizes a template’s own asset only for a run of that template', async () => {
    const asset = 'template_assets/template-1/version-2/fixed-node/hero.png';
    const objects = { [asset]: 12 * MB };

    const inScope = createClient({ objects });
    const sized = await lookupImageSizes([asset], {
      supabase: inScope.client as never,
      userId: USER_ID,
      templateAssetScope: { templateId: 'template-1', templateVersionId: 'version-2' },
    });
    expect(sized.get(asset)).toBe(12 * MB);

    const outOfScope = createClient({ objects });
    const unsized = await lookupImageSizes([asset], {
      supabase: outOfScope.client as never,
      userId: USER_ID,
      templateAssetScope: { templateId: 'template-1', templateVersionId: 'version-3' },
    });
    expect(unsized.get(asset)).toBeNull();
    expect(outOfScope.infoReads).toEqual([]);
  });

  it('never reads another account’s object by its path', async () => {
    const { client, reservationReads, infoReads } = createClient({
      objects: { [`generation_inputs/${OTHER_USER_ID}/look.png`]: 30 * MB },
    });
    const fetcher = vi.fn();

    const sizes = await lookupImageSizes(
      [`generation_inputs/${OTHER_USER_ID}/look.png`],
      { supabase: client as never, userId: USER_ID },
      { fetcher },
    );

    expect(sizes.get(`generation_inputs/${OTHER_USER_ID}/look.png`)).toBeNull();
    expect(reservationReads).toEqual([]);
    expect(infoReads).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('asks storage for a shared picture’s size with the link the caller was given', async () => {
    const shared = signed('generation_inputs', `${OTHER_USER_ID}/look.png`);
    const { client, infoReads } = createClient();
    const fetcher = vi.fn(async () => headResponse(200, { 'content-length': String(13 * MB) }));

    const sizes = await lookupImageSizes([shared], { supabase: client as never, userId: USER_ID }, { fetcher });

    expect(sizes.get(shared)).toBe(13 * MB);
    expect(infoReads).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual([shared, expect.objectContaining({ method: 'HEAD', redirect: 'manual' })]);
  });

  it('sends a remote picture a HEAD, never a download', async () => {
    const remote = `https://${MEDIA_HOST}/outputs/look.png`;
    const { client } = createClient();
    const fetcher = vi.fn(async () => headResponse(200, { 'content-length': String(21 * MB), 'content-type': 'image/png' }));

    const sizes = await lookupImageSizes([remote, remote], { supabase: client as never, userId: USER_ID }, {
      fetcher,
      lookupHost: publicDns,
    });

    expect(sizes.get(remote)).toBe(21 * MB);
    // Looked up once, however often the run sends it.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual([remote, expect.objectContaining({ method: 'HEAD', redirect: 'manual' })]);
    expect(publicDns).toHaveBeenCalledWith(MEDIA_HOST);
  });

  it('follows a redirect only to another host it may ask', async () => {
    const remote = `https://${MEDIA_HOST}/outputs/look.png`;
    const { client } = createClient();

    const allowed = vi.fn()
      .mockResolvedValueOnce(headResponse(302, { location: `${SUPABASE}/storage/v1/object/sign/generated_images/x.png?token=t` }))
      .mockResolvedValueOnce(headResponse(200, { 'content-length': String(5 * MB) }));
    const followed = await lookupImageSizes([remote], { supabase: client as never, userId: USER_ID }, {
      fetcher: allowed,
      lookupHost: publicDns,
    });
    expect(followed.get(remote)).toBe(5 * MB);
    expect(allowed).toHaveBeenCalledTimes(2);

    const elsewhere = vi.fn().mockResolvedValueOnce(headResponse(302, { location: 'https://attacker.test/look.png' }));
    const refused = await lookupImageSizes([remote], { supabase: client as never, userId: USER_ID }, {
      fetcher: elsewhere,
      lookupHost: publicDns,
    });
    expect(refused.get(remote)).toBeNull();
    expect(elsewhere).toHaveBeenCalledTimes(1);
  });

  it('asks no host outside the media allowlist, and none that resolves to a private address', async () => {
    const { client } = createClient();
    const fetcher = vi.fn();

    const unlisted = await lookupImageSizes(['https://cdn.example.org/look.png', 'http://tempfile.aiquickdraw.com/a.png'], {
      supabase: client as never,
      userId: USER_ID,
    }, { fetcher, lookupHost: publicDns });
    expect([...unlisted.values()]).toEqual([null, null]);

    const rebound = await lookupImageSizes([`https://${MEDIA_HOST}/look.png`], {
      supabase: client as never,
      userId: USER_ID,
    }, { fetcher, lookupHost: async () => [{ address: '10.0.0.7', family: 4 }] });
    expect(rebound.get(`https://${MEDIA_HOST}/look.png`)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('leaves a size unknown when the answer does not give one', async () => {
    const remote = `https://${MEDIA_HOST}/outputs/look.png`;
    const { client } = createClient();

    for (const fetcher of [
      vi.fn(async () => headResponse(200)),
      vi.fn(async () => headResponse(405)),
      vi.fn(async () => headResponse(200, { 'content-length': 'many' })),
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    ]) {
      const sizes = await lookupImageSizes([remote], { supabase: client as never, userId: USER_ID }, {
        fetcher,
        lookupHost: publicDns,
      });
      expect(sizes.get(remote)).toBeNull();
    }
  });

  it('gives up on a host that does not answer in time', async () => {
    const remote = `https://${MEDIA_HOST}/outputs/look.png`;
    const { client } = createClient();
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));

    const sizes = await lookupImageSizes([remote], { supabase: client as never, userId: USER_ID }, {
      fetcher,
      lookupHost: publicDns,
      timeoutMs: 20,
    });

    expect(sizes.get(remote)).toBeNull();
  });

  it('gives up on storage that does not answer in time, and keeps what did answer', async () => {
    const stalled = signed('generated_images', `${USER_ID}/stalled.png`);
    const answered = `uploads/${USER_ID}/a.png`;
    const { client } = createClient({ reservations: [upload(`${USER_ID}/a.png`, 3 * MB)] });
    const stallingClient = {
      ...client,
      storage: { from: () => ({ info: () => new Promise(() => undefined) }) },
    };

    const sizes = await lookupImageSizes([stalled, answered], {
      supabase: stallingClient as never,
      userId: USER_ID,
    }, { timeoutMs: 20 });

    expect(sizes.get(stalled)).toBeNull();
    expect(sizes.get(answered)).toBe(3 * MB);
  });

  it('never throws, and leaves a size unknown, when storage misbehaves', async () => {
    const brokenClient = {
      from: () => {
        throw new TypeError('from is not configured');
      },
      storage: {
        from: () => ({
          info: async () => {
            throw new Error('storage unavailable');
          },
        }),
      },
    };

    const sizes = await lookupImageSizes(
      [`uploads/${USER_ID}/a.png`, signed('generated_images', `${USER_ID}/b.png`)],
      { supabase: brokenClient as never, userId: USER_ID },
    );

    expect([...sizes.values()]).toEqual([null, null]);
  });

  it('looks nothing up for a prepared asset or a link it cannot read', async () => {
    const { client, reservationReads, infoReads } = createClient();
    const fetcher = vi.fn();

    const sizes = await lookupImageSizes(['asset://asset-20260404242101-76djj', 'asset-123', ''], {
      supabase: client as never,
      userId: USER_ID,
    }, { fetcher });

    expect([...sizes.values()]).toEqual([null, null, null]);
    expect(reservationReads).toEqual([]);
    expect(infoReads).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('the provider image size log', () => {
  let records: BackendLogRecord[] = [];
  let restoreSink: () => void = () => undefined;

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE);
    vi.stubEnv('MEDIA_IMPORT_HOST_ALLOWLIST', MEDIA_HOST);
    records = [];
    restoreSink = setBackendLogSink((record) => {
      records.push(record);
    });
  });

  afterEach(() => {
    restoreSink();
    vi.unstubAllEnvs();
  });

  const overLimitLogs = () => records.filter((record) => record.msg === 'generation_input_image_over_provider_limit');

  const qwenRequest = {
    model: 'qwen3/image-to-image',
    input: { prompt: 'Swap the label', image_urls: [`uploads/${USER_ID}/a.png`, `uploads/${USER_ID}/b.png`] },
  };

  // Kie's docs state the limits, and no run has shown that Kie refuses a picture over one,
  // so a start is never stopped for a size: it logs the picture and goes on.
  it('logs a picture over its model’s limit, and lets the start go on', async () => {
    const { client } = createClient({
      reservations: [upload(`${USER_ID}/a.png`, 2 * MB), upload(`${USER_ID}/b.png`, 13_002_342)],
    });

    await expect(logProviderImageSizesOverLimit({
      supabase: client as never,
      userId: USER_ID,
      modelId: 'qwen3',
      request: qwenRequest,
    })).resolves.toBeUndefined();

    expect(overLimitLogs()).toEqual([
      expect.objectContaining({
        level: 'warn',
        userId: USER_ID,
        model: 'qwen3',
        providerModel: 'qwen3/image-to-image',
        detail: 'Qwen Image 3.0 takes reference images up to 10 MB; Reference 2 is 12.4 MB.',
      }),
    ]);
  });

  it('logs nothing for pictures at the limit or of unknown size', async () => {
    const atLimit = createClient({
      reservations: [upload(`${USER_ID}/a.png`, 10 * MB), upload(`${USER_ID}/b.png`, 10 * MB)],
    });
    await logProviderImageSizesOverLimit({
      supabase: atLimit.client as never,
      userId: USER_ID,
      modelId: 'qwen3',
      request: qwenRequest,
    });

    const unknown = createClient();
    await logProviderImageSizesOverLimit({
      supabase: unknown.client as never,
      userId: USER_ID,
      modelId: 'qwen3',
      request: qwenRequest,
    });

    expect(overLimitLogs()).toEqual([]);
  });

  it('holds Ideogram Character’s references to their total', async () => {
    const { client } = createClient({
      reservations: [upload(`${USER_ID}/a.png`, 10 * MB + 1)],
    });

    await logProviderImageSizesOverLimit({
      supabase: client as never,
      userId: USER_ID,
      modelId: 'ideogram-character',
      request: { model: 'ideogram/character', input: { reference_image_urls: [`uploads/${USER_ID}/a.png`] } },
    });

    expect(overLimitLogs().map((record) => record.detail)).toEqual([
      'Ideogram Character takes up to 10 MB of reference images in total; yours come to 10.1 MB.',
    ]);
  });

  it('looks nothing up for a model with no limit', async () => {
    const { client } = createClient({ reservations: [upload(`${USER_ID}/a.png`, 40 * MB)] });
    const fetcher = vi.fn();

    await expect(logProviderImageSizesOverLimit({
      supabase: client as never,
      userId: USER_ID,
      modelId: 'gpt-image-2',
      request: { model: 'gpt-image-2-image-to-image', input: { input_urls: [`uploads/${USER_ID}/a.png`] } },
    }, { fetcher })).resolves.toBeUndefined();

    expect(client.from).not.toHaveBeenCalled();
    expect(client.storage.from).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(overLimitLogs()).toEqual([]);
  });

  it('leaves a request it cannot build to the start that builds it', async () => {
    const { client } = createClient();

    await expect(logProviderImageSizesOverLimit({
      supabase: client as never,
      userId: USER_ID,
      modelId: 'qwen3',
      request: () => {
        throw new Error('Input slot imageReferences is required.');
      },
    })).resolves.toBeUndefined();
    expect(client.from).not.toHaveBeenCalled();
  });
});
