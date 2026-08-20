import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { createShowcasePreviewForRoute } from '@/lib/showcase-preview-service';

function createClient({
  allowed = true,
  generation = {
    user_id: 'user-1',
    output_url: 'generated_images/user-1/preview.png',
    showcase_asset_path: null as string | null,
    is_public: true,
  } as Record<string, unknown> | null,
  fetchError = null as Error | null,
  signedUrl = 'https://signed.example.com/preview.png',
  signError = null as Error | null,
} = {}) {
  const rpc = vi.fn(async () => ({
    data: {
      allowed,
      limit: 240,
      remaining: allowed ? 239 : 0,
      retryAfterSeconds: allowed ? 0 : 12,
      resetAt: '2026-06-22T06:30:00.000Z',
    },
    error: null,
  }));
  const single = vi.fn(async () => ({ data: generation, error: fetchError }));
  const eq = vi.fn(() => ({ single }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  const createSignedUrl = vi.fn(async () => ({
    data: signError ? null : { signedUrl },
    error: signError,
  }));
  const getPublicUrl = vi.fn((path: string) => ({
    data: { publicUrl: `https://public.example.com/${path}` },
  }));
  const storageFrom = vi.fn(() => ({ createSignedUrl, getPublicUrl }));

  return {
    client: {
      rpc,
      from,
      storage: { from: storageFrom },
    } as unknown as SupabaseClient,
    createSignedUrl,
    eq,
    from,
    getPublicUrl,
    rpc,
    select,
    single,
    storageFrom,
  };
}

describe('createShowcasePreviewForRoute', () => {
  it('rate limits before generation lookup or Storage work', async () => {
    const client = createClient({ allowed: false });

    const result = await createShowcasePreviewForRoute({
      generationId: 'generation-1',
      serviceClient: client.client,
      viewerUserId: 'viewer-1',
    });

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('rateLimitError');
    expect(client.from).not.toHaveBeenCalled();
    expect(client.storageFrom).not.toHaveBeenCalled();
  });

  it('signs stored media for public generations after lookup', async () => {
    const client = createClient();

    const result = await createShowcasePreviewForRoute({
      generationId: 'generation-1',
      serviceClient: client.client,
      viewerUserId: 'viewer-1',
    });

    expect(client.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'showcase-preview:read-url',
      p_subject_key: 'viewer-1',
      p_limit: 240,
      p_window_seconds: 600,
    });
    expect(client.from).toHaveBeenCalledWith('generations');
    expect(client.select).toHaveBeenCalledWith('user_id, output_url, showcase_asset_path, is_public');
    expect(client.eq).toHaveBeenCalledWith('id', 'generation-1');
    expect(client.storageFrom).toHaveBeenCalledWith('generated_images');
    expect(client.createSignedUrl).toHaveBeenCalledWith('user-1/preview.png', 3600);
    expect(result).toEqual({
      ok: true,
      body: { url: 'https://signed.example.com/preview.png' },
    });
  });

  it('uses durable public showcase assets without creating signed URLs', async () => {
    const client = createClient({
      generation: {
        user_id: 'user-1',
        output_url: 'generated_images/user-1/original.png',
        showcase_asset_path: 'showcase/generation-1/post-1.png',
        is_public: true,
      },
    });

    const result = await createShowcasePreviewForRoute({
      generationId: 'generation-1',
      serviceClient: client.client,
      viewerUserId: 'viewer-1',
    });

    expect(client.storageFrom).toHaveBeenCalledWith('showcase_media');
    expect(client.getPublicUrl).toHaveBeenCalledWith('showcase/generation-1/post-1.png');
    expect(client.createSignedUrl).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      body: { url: 'https://public.example.com/showcase/generation-1/post-1.png' },
    });
  });

  it('returns provider HTTP media without Storage signing', async () => {
    const client = createClient({
      generation: {
        user_id: 'user-1',
        output_url: 'https://provider.example.com/output.png',
        showcase_asset_path: null,
        is_public: true,
      },
    });

    const result = await createShowcasePreviewForRoute({
      generationId: 'generation-1',
      serviceClient: client.client,
      viewerUserId: 'viewer-1',
    });

    expect(result).toEqual({
      ok: true,
      body: { url: 'https://provider.example.com/output.png' },
    });
    expect(client.storageFrom).not.toHaveBeenCalled();
  });

  it.each([
    [null, 404, 'Generation not found'],
    [{ user_id: 'user-1', output_url: 'generated_images/user-1/preview.png', showcase_asset_path: null, is_public: false }, 403, 'Generation is private'],
    [{ user_id: 'user-1', output_url: null, showcase_asset_path: null, is_public: true }, 404, 'No media available'],
    [{ user_id: 'user-1', output_url: 'not-a-stored-path', showcase_asset_path: null, is_public: true }, 400, 'Invalid media path'],
  ])('returns stable validation failures for unavailable preview media', async (generation, status, error) => {
    const client = createClient({ generation });

    await expect(createShowcasePreviewForRoute({
      generationId: 'generation-1',
      serviceClient: client.client,
      viewerUserId: 'viewer-1',
    })).resolves.toEqual({
      ok: false,
      status,
      body: { error },
    });
  });

  it('returns a stable failure when Storage cannot sign preview media', async () => {
    const client = createClient({ signError: new Error('storage outage') });

    await expect(createShowcasePreviewForRoute({
      generationId: 'generation-1',
      serviceClient: client.client,
      viewerUserId: 'viewer-1',
    })).resolves.toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to generate preview URL' },
    });
  });

  it.each([
    'generated_images/user-2/private.png',
    'generated_images/user-1%252f..%252fuser-2/private.png',
    'https://project.supabase.co/storage/v1/object/sign/generated_images/user-2/private.png?token=stolen',
  ])('refuses to sign or return storage outside the generation owner scope: %s', async (outputUrl) => {
    const client = createClient({
      generation: {
        user_id: 'user-1',
        output_url: outputUrl,
        showcase_asset_path: null,
        is_public: true,
      },
    });

    await expect(createShowcasePreviewForRoute({
      generationId: 'generation-1',
      serviceClient: client.client,
      viewerUserId: 'viewer-1',
    })).resolves.toEqual({
      ok: false,
      status: 400,
      body: { error: 'Invalid media path' },
    });
    expect(client.storageFrom).not.toHaveBeenCalled();
  });

  it('rejects a public derivative outside the exact generation prefix', async () => {
    const client = createClient({
      generation: {
        user_id: 'user-1',
        output_url: 'generated_images/user-1/original.png',
        showcase_asset_path: 'showcase/generation-2/private.png',
        is_public: true,
      },
    });

    await expect(createShowcasePreviewForRoute({
      generationId: 'generation-1',
      serviceClient: client.client,
      viewerUserId: 'viewer-1',
    })).resolves.toEqual({
      ok: false,
      status: 400,
      body: { error: 'Invalid media path' },
    });
    expect(client.storageFrom).not.toHaveBeenCalled();
  });
});
