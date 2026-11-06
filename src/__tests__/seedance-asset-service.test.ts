import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createSeedanceAssetForRoute, getSeedanceAssetForRoute } from '@/lib/seedance-asset-service';

// The conversion reaches ffmpeg and storage: here it answers what each case needs.
const trackConversion = vi.hoisted(() => {
  class ReferenceTrackUnreadableError extends Error {
    constructor(message: string, readonly tooLong = false) {
      super(message);
      this.name = 'ReferenceTrackUnreadableError';
    }
  }
  return {
    ReferenceTrackUnreadableError,
    convertReferenceTrackIfRefused: vi.fn<(params: {
      supabase: unknown;
      userId: string;
      link: string;
      formats: readonly string[];
    }) => Promise<Buffer | null>>(async () => null),
    storeSeedanceAssetTrack: vi.fn<(params: {
      supabase: unknown;
      userId: string;
      wav: Buffer;
    }) => Promise<string>>(async () => ''),
  };
});
vi.mock('@/lib/reference-track-conversion', () => trackConversion);
vi.mock('@/lib/backend-logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/backend-logger')>(),
  logBackendError: vi.fn(),
}));

beforeEach(() => {
  trackConversion.convertReferenceTrackIfRefused.mockReset().mockResolvedValue(null);
  trackConversion.storeSeedanceAssetTrack.mockReset().mockResolvedValue('');
});

function createAdminSupabaseMock(options: { recordError?: { code?: string; message: string } } = {}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  // Every Seedance asset record written (`seedance_prepared_assets`, owner 2026-11-04).
  const records: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      if (table !== 'seedance_prepared_assets') throw new Error(`Unexpected table: ${table}`);
      return {
        async insert(row: Record<string, unknown>) {
          if (options.recordError) return { data: null, error: options.recordError };
          records.push({ table, ...row });
          return { data: null, error: null };
        },
      };
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      return {
        data: {
          allowed: true,
          limit: 60,
          remaining: 59,
          retryAfterSeconds: 0,
          resetAt: '2026-06-22T10:00:00.000Z',
        },
        error: null,
      };
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    rpcCalls,
    records,
  };
}

describe('createSeedanceAssetForRoute', () => {
  it('rate limits, resolves stored media, and creates a provider asset', async () => {
    const admin = createAdminSupabaseMock();
    const resolveStoredMediaUrl = vi.fn(async () => 'https://signed.example.com/uploads/user-1/reference.mp4');
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 200,
        data: {
          assetId: 'asset-123',
          status: 'processing',
        },
      }),
    } as Response));

    const result = await createSeedanceAssetForRoute({
      adminSupabase: admin.client,
      apiKey: 'test-key',
      body: {
        url: 'uploads/user-1/reference.mp4',
        assetType: 'Video',
      },
      fetcher,
      resolveStoredMediaUrl,
      userId: 'user-1',
    });

    expect(result).toMatchObject({
      ok: true,
      body: {
        success: true,
        assetId: 'asset-123',
        assetType: 'Video',
        status: 'processing',
        sourceUrl: 'https://signed.example.com/uploads/user-1/reference.mp4',
      },
    });
    expect(admin.rpcCalls[0]).toMatchObject({
      fn: 'check_backend_rate_limit',
      args: {
        p_scope: 'seedance-assets:create',
        p_subject_key: 'user-1',
      },
    });
    expect(resolveStoredMediaUrl).toHaveBeenCalledWith(
      admin.client,
      'uploads/user-1/reference.mp4',
      'user-1',
    );
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.kie.ai/api/v1/playground/createAsset',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
        body: JSON.stringify({
          assetType: 'Video',
          url: 'https://signed.example.com/uploads/user-1/reference.mp4',
        }),
      })
    );
    // Recorded as the preparer's own file: anyone its remix hands the id to may run it.
    expect(admin.records).toEqual([{
      table: 'seedance_prepared_assets',
      asset_id: 'asset-123',
      owner_user_id: 'user-1',
      source: 'uploads/user-1/reference.mp4',
      recipe_file: null,
      recorded_from: 'prepare',
    }]);
  });

  // An asset id the server cannot say the file of is never handed out (owner, 2026-11-04).
  it('hands out no asset id it could not record', async () => {
    const admin = createAdminSupabaseMock({ recordError: { code: '57014', message: 'statement timeout' } });
    const result = await createSeedanceAssetForRoute({
      adminSupabase: admin.client,
      apiKey: 'test-key',
      body: { url: 'uploads/user-1/reference.mp4', assetType: 'Video' },
      fetcher: vi.fn(async () => ({ ok: true, json: async () => ({ code: 200, data: { assetId: 'asset-123', status: 'processing' } }) } as Response)),
      resolveStoredMediaUrl: vi.fn(async () => 'https://signed.example.com/uploads/user-1/reference.mp4'),
      userId: 'user-1',
    });

    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(JSON.stringify(result)).not.toContain('asset-123');
  });

  it.each([
    'uploads/user-2/private.mp4',
    'uploads/user-1%252fuser-2/private.mp4',
  ])('rejects a foreign or non-canonical storage target before resolving or calling the provider: %s', async (url) => {
    const admin = createAdminSupabaseMock();
    const resolveStoredMediaUrl = vi.fn();
    const fetcher = vi.fn();

    await expect(createSeedanceAssetForRoute({
      adminSupabase: admin.client,
      apiKey: 'test-key',
      body: { url, assetType: 'Video' },
      fetcher,
      resolveStoredMediaUrl,
      userId: 'user-1',
    })).resolves.toMatchObject({
      ok: false,
      status: 400,
      body: { error: 'Asset media must belong to the authenticated user.' },
    });

    expect(resolveStoredMediaUrl).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

// 2026-11-03 re-review: a picture of a person restored from a recipe's copy runs on Seedance 2 only as a
// prepared asset, and the buyer could not prepare the seller's file. It is imported first, with the
// unlock read again (`reuseRecipeFile`), and the asset is prepared from the buyer's own import.
describe('createSeedanceAssetForRoute from a recipe file', () => {
  const COPY = 'post_resource_files/seller-9/generation-references/gen-0/00-reference-image-row-1.png';
  const IMPORTED = 'https://project.supabase.co/storage/v1/object/sign/generation_inputs/user-1/recipe-imports/seller-9/gen-0/00-reference-image-row-1.png?token=fresh';
  const created = () => vi.fn(async () => ({ ok: true, json: async () => ({ code: 200, data: { assetId: 'asset-mine', status: 'processing' } }) } as Response));

  it('prepares the buyer’s own import of a copy their unlock still covers', async () => {
    const admin = createAdminSupabaseMock();
    const fetcher = created();
    const resolveStoredMediaUrl = vi.fn();
    const reuseRecipeFile = vi.fn(async () => ({ outcome: 'imported' as const, storagePath: 'generation_inputs/user-1/recipe-imports/seller-9/gen-0/00-reference-image-row-1.png', signedUrl: IMPORTED }));

    const result = await createSeedanceAssetForRoute({
      adminSupabase: admin.client,
      apiKey: 'test-key',
      body: { url: COPY, assetType: 'Image' },
      fetcher,
      resolveStoredMediaUrl,
      reuseRecipeFile,
      userId: 'user-1',
    });

    expect(reuseRecipeFile).toHaveBeenCalledWith({ source: COPY, viewerUserId: 'user-1' });
    expect(fetcher).toHaveBeenCalledWith('https://api.kie.ai/api/v1/playground/createAsset', expect.objectContaining({
      body: JSON.stringify({ assetType: 'Image', url: IMPORTED }),
    }));
    // The reply names the buyer's import, but a run records the asset under the link its client sends,
    // the copy's own: what a remix of the buyer's run is held to is that record, tested where the run
    // makes it (unified-generation-start-service.test.ts) and where a remix reads it
    // (`preparedSeedanceAssetIdsFor`), never this reply (2026-11-04 re-review).
    expect(result).toMatchObject({ ok: true, body: { assetId: 'asset-mine', sourceUrl: IMPORTED } });
    expect(resolveStoredMediaUrl).not.toHaveBeenCalled();
    // Recorded as the copy it runs, so a start refuses it once the unlock is gone (owner, 2026-11-04).
    expect(admin.records).toEqual([{
      table: 'seedance_prepared_assets',
      asset_id: 'asset-mine',
      owner_user_id: 'user-1',
      source: COPY,
      recipe_file: COPY,
      recorded_from: 'prepare',
    }]);
  });

  it.each([
    ['refuses one the unlock no longer covers', 'not-eligible' as const, 400, 'Asset media must belong to the authenticated user.'],
    ['fails retryably when the unlock cannot be read', 'failed' as const, 500, 'We could not prepare a file from a recipe you unlocked. Please try again.'],
  ])('%s, preparing nothing', async (_, outcome, status, error) => {
    const admin = createAdminSupabaseMock();
    const fetcher = created();

    await expect(createSeedanceAssetForRoute({
      adminSupabase: admin.client,
      apiKey: 'test-key',
      body: { url: COPY, assetType: 'Image' },
      fetcher,
      reuseRecipeFile: vi.fn(async () => ({ outcome })),
      userId: 'user-1',
    })).resolves.toMatchObject({ ok: false, status, body: { error } });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

// Seedance 2 takes only WAV and MP3 tracks: an iPhone `.m4a`, an AAC or Ogg file, or one whose
// extension lies about its bytes is converted before Kie is handed it, as the video start does.
describe('createSeedanceAssetForRoute for an audio track', () => {
  const M4A = 'uploads/user-1/1730000000000-voice-memo.m4a';
  const M4A_SIGNED = 'https://project.supabase.co/storage/v1/object/sign/uploads/user-1/1730000000000-voice-memo.m4a?token=mine';
  const WAV_SIGNED = 'https://project.supabase.co/storage/v1/object/sign/generation_inputs/user-1/seedance-asset-tracks/abc.wav?token=copy';
  const created = () => vi.fn(async () => ({ ok: true, json: async () => ({ code: 200, data: { assetId: 'asset-voice', status: 'processing' } }) } as Response));

  async function prepare(url: string, signed: string, fetcher = created(), assetType = 'Audio') {
    const admin = createAdminSupabaseMock();
    const result = await createSeedanceAssetForRoute({
      adminSupabase: admin.client,
      apiKey: 'test-key',
      body: { url, assetType },
      fetcher,
      resolveStoredMediaUrl: vi.fn(async () => signed),
      userId: 'user-1',
    });
    return { admin, fetcher, result };
  }

  it('sends Kie the stored WAV copy of an .m4a, not the .m4a', async () => {
    const wav = Buffer.from('RIFF....WAVE');
    trackConversion.convertReferenceTrackIfRefused.mockResolvedValue(wav);
    trackConversion.storeSeedanceAssetTrack.mockResolvedValue(WAV_SIGNED);

    const { admin, fetcher, result } = await prepare(M4A, M4A_SIGNED);

    expect(fetcher).toHaveBeenCalledWith('https://api.kie.ai/api/v1/playground/createAsset', expect.objectContaining({
      body: JSON.stringify({ assetType: 'Audio', url: WAV_SIGNED }),
    }));
    expect(trackConversion.convertReferenceTrackIfRefused).toHaveBeenCalledWith({
      supabase: admin.client,
      userId: 'user-1',
      link: M4A_SIGNED,
      formats: ['wav', 'mp3'],
    });
    expect(trackConversion.storeSeedanceAssetTrack).toHaveBeenCalledWith({ supabase: admin.client, userId: 'user-1', wav });
    // The creator keeps their own file's link, and the asset is recorded as the file they named.
    expect(result).toMatchObject({ ok: true, body: { assetId: 'asset-voice', assetType: 'Audio', sourceUrl: M4A_SIGNED } });
    expect(admin.records).toEqual([expect.objectContaining({ asset_id: 'asset-voice', source: M4A, recipe_file: null })]);
  });

  it('sends a track Seedance takes as it is, storing nothing', async () => {
    const mp3 = 'uploads/user-1/1730000000000-song.mp3';
    const mp3Signed = 'https://project.supabase.co/storage/v1/object/sign/uploads/user-1/1730000000000-song.mp3?token=mine';

    const { admin, fetcher, result } = await prepare(mp3, mp3Signed);

    expect(trackConversion.convertReferenceTrackIfRefused).toHaveBeenCalledWith(expect.objectContaining({ link: mp3Signed }));
    expect(trackConversion.storeSeedanceAssetTrack).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith('https://api.kie.ai/api/v1/playground/createAsset', expect.objectContaining({
      body: JSON.stringify({ assetType: 'Audio', url: mp3Signed }),
    }));
    expect(result).toMatchObject({ ok: true, body: { sourceUrl: mp3Signed } });
    expect(admin.records).toEqual([expect.objectContaining({ source: mp3 })]);
  });

  it.each([
    ['a track it cannot convert', false, 'We could not convert this track for Seedance. Add it again as an MP3 or WAV file.'],
    ['a track too long', true, 'This track is too long for Seedance. Use a shorter track.'],
  ])('refuses %s before asking Kie', async (_, tooLong, error) => {
    trackConversion.convertReferenceTrackIfRefused.mockRejectedValue(
      new trackConversion.ReferenceTrackUnreadableError('unreadable', tooLong),
    );

    const { admin, fetcher, result } = await prepare(M4A, M4A_SIGNED);

    expect(result).toEqual({ ok: false, status: 400, body: { error } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(trackConversion.storeSeedanceAssetTrack).not.toHaveBeenCalled();
    expect(admin.records).toEqual([]);
  });

  it.each([
    ['the conversion', () => trackConversion.convertReferenceTrackIfRefused.mockRejectedValue(new Error('ffmpeg could not start'))],
    ['storing the copy', () => {
      trackConversion.convertReferenceTrackIfRefused.mockResolvedValue(Buffer.from('RIFF'));
      trackConversion.storeSeedanceAssetTrack.mockRejectedValue(new Error('The converted track could not be stored'));
    }],
  ])('fails retryably when %s fails for a reason not the track’s', async (_, arrange) => {
    arrange();
    const { logBackendError } = await import('@/lib/backend-logger');

    const { fetcher, result } = await prepare(M4A, M4A_SIGNED);

    expect(result).toEqual({ ok: false, status: 500, body: { error: 'We could not prepare your audio track. Try again in a moment.' } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(logBackendError).toHaveBeenCalledWith('seedance_asset_track_conversion_failed', expect.objectContaining({ error: expect.any(Error) }));
  });

  it.each(['Video', 'Image'])('never converts a %s', async (assetType) => {
    const { fetcher } = await prepare('uploads/user-1/reference.mp4', 'https://signed.example.com/uploads/user-1/reference.mp4', created(), assetType);

    expect(trackConversion.convertReferenceTrackIfRefused).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith('https://api.kie.ai/api/v1/playground/createAsset', expect.objectContaining({
      body: JSON.stringify({ assetType, url: 'https://signed.example.com/uploads/user-1/reference.mp4' }),
    }));
  });
});

// A remix the run's inputs are handed to gets the assets prepared from them
// (owner, 2026-10-29), and reading one back asks Kie, whose answer can carry
// the link the asset was made from: the creator's upload, file name and all.
describe('getSeedanceAssetForRoute', () => {
  it("reads an asset's state back without the link it was prepared from", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 200,
        data: {
          assetId: 'asset-face',
          assetType: 'Image',
          status: 'success',
          url: 'https://project.supabase.co/storage/v1/object/sign/uploads/user-1/1730000000000-passport-scan.jpg?token=read',
        },
      }),
    } as Response));

    const result = await getSeedanceAssetForRoute({ apiKey: 'test-key', assetId: 'asset-face', fetcher });

    expect(result).toMatchObject({
      ok: true,
      body: { success: true, assetId: 'asset-face', assetType: 'Image', status: 'active', sourceUrl: null },
    });
    expect(JSON.stringify(result)).not.toMatch(/uploads\/user-1|passport-scan/);
  });
});
