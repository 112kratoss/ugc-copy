import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createSeedanceAssetForRoute } from '@/lib/seedance-asset-service';

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
    expect(resolveStoredMediaUrl).toHaveBeenCalledWith(admin.client, 'uploads/user-1/reference.mp4');
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
});
