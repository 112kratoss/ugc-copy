import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createSeedanceAssetForRoute, getSeedanceAssetForRoute } from '@/lib/seedance-asset-service';

function createAdminSupabaseMock() {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
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
