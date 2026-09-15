import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generation: null as Record<string, unknown> | null,
  resolveRemixAccess: vi.fn(),
  loadGenerationInputMediaMap: vi.fn(),
  buildLegacyGenerationInputMedia: vi.fn(),
  loadGenerationRecipeRemixInputMediaByPostId: vi.fn(),
}));

const adminClient = {
  from: vi.fn(() => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({ data: mocks.generation, error: null }),
    };
    return builder;
  }),
  storage: {
    from: () => ({
      getPublicUrl: (path: string) => ({ data: { publicUrl: `https://public.example/${path}` } }),
      createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.example/upload' }, error: null }),
    }),
  },
};

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: vi.fn(() => ({})),
  createServiceClient: vi.fn(() => adminClient),
  resolveOwnedStoredMediaUrl: vi.fn(async () => null),
}));
vi.mock('@/lib/server-auth-user', () => ({
  getVerifiedAuthUserResult: vi.fn(async () => ({ data: { user: { id: 'viewer-1' } }, error: null })),
}));
vi.mock('@/lib/backend-rate-limit', () => ({
  REMIX_SOURCE_RATE_LIMIT: { scope: 'remix-source' },
  enforceBackendRateLimit: vi.fn(async () => undefined),
}));
vi.mock('@/lib/remix-access', () => ({
  REMIX_UNLOCK_REQUIRED_CODE: 'REMIX_UNLOCK_REQUIRED',
  REMIX_UNLOCK_REQUIRED_MESSAGE: 'Unlock this post to remix it.',
  resolveRemixAccess: mocks.resolveRemixAccess,
}));
vi.mock('@/lib/generation-input-media', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/generation-input-media')>(),
  loadGenerationInputMediaMap: mocks.loadGenerationInputMediaMap,
  buildLegacyGenerationInputMedia: mocks.buildLegacyGenerationInputMedia,
}));
vi.mock('@/lib/post-resource-bundles-server', () => ({
  loadGenerationRecipeRemixInputMediaByPostId: mocks.loadGenerationRecipeRemixInputMediaByPostId,
}));

import { loadRemixSourceBundle, RemixSourceError } from '@/lib/remix-source-server';

const LOCKED_PROMPT = 'The prompt a buyer pays for';

const EXPOSED_POST = {
  id: 'post-verified',
  user_id: 'creator-1',
  generation_id: 'gen-1',
  category: 'image',
  post_format: 'media',
  source_kind: 'magicbooklet',
  visibility: 'public',
  archived_at: null,
  review_status: 'visible',
};

function request(postId?: string) {
  const query = postId ? `?id=gen-1&postId=${postId}` : '?id=gen-1';
  return new NextRequest(`http://localhost/api/remix-source${query}`);
}

beforeEach(() => {
  mocks.generation = {
    id: 'gen-1',
    user_id: 'creator-1',
    is_public: true,
    share_input_media_for_remix: true,
    output_url: null,
    showcase_asset_path: null,
    category: 'image',
    model: 'nano-banana-2',
    prompt: LOCKED_PROMPT,
    title: 'Recipe',
    workflow_settings: {
      model: 'nano-banana-2',
      referenceImageUrls: ['https://cdn.example/private-face.png'],
    },
  };
  mocks.resolveRemixAccess.mockReset();
  mocks.loadGenerationInputMediaMap.mockReset().mockResolvedValue(new Map());
  mocks.buildLegacyGenerationInputMedia.mockReset().mockResolvedValue([]);
  mocks.loadGenerationRecipeRemixInputMediaByPostId.mockReset().mockResolvedValue([]);
});

describe('loadRemixSourceBundle access', () => {
  it('asks the shared remix gate with the caller’s post id and refuses a locked recipe without its prompt', async () => {
    mocks.resolveRemixAccess.mockResolvedValue({ allowed: false, reason: 'unlock_required' });

    const outcome = await loadRemixSourceBundle(request('post-client'), 'gen-1', { postId: 'post-client' })
      .then((bundle) => bundle, (error: unknown) => error);

    expect(outcome).toBeInstanceOf(RemixSourceError);
    expect(outcome).toMatchObject({
      status: 403,
      code: 'REMIX_UNLOCK_REQUIRED',
      message: 'Unlock this post to remix it.',
    });
    expect(JSON.stringify(outcome)).not.toContain(LOCKED_PROMPT);
    expect(mocks.resolveRemixAccess).toHaveBeenCalledWith(expect.objectContaining({
      viewerUserId: 'viewer-1',
      requestedPostId: 'post-client',
      generation: {
        id: 'gen-1',
        user_id: 'creator-1',
        is_public: true,
        share_input_media_for_remix: true,
      },
    }));
    expect(mocks.loadGenerationInputMediaMap).not.toHaveBeenCalled();
    expect(mocks.loadGenerationRecipeRemixInputMediaByPostId).not.toHaveBeenCalled();
  });

  it('answers not found when the gate refuses, before any media is signed', async () => {
    mocks.resolveRemixAccess.mockResolvedValue({ allowed: false, reason: 'not_found' });

    await expect(loadRemixSourceBundle(request(), 'gen-1')).rejects.toMatchObject({
      status: 404,
      message: 'Remix source not found',
    });
    expect(mocks.loadGenerationInputMediaMap).not.toHaveBeenCalled();
  });

  it('restores the creator’s shared input files for a public remix', async () => {
    mocks.resolveRemixAccess.mockResolvedValue({
      allowed: true,
      basis: 'public',
      post: EXPOSED_POST,
      includeSharedInputMedia: true,
      recipeEntitled: false,
    });

    const bundle = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

    expect(bundle.generation.prompt).toBe(LOCKED_PROMPT);
    expect(mocks.loadGenerationInputMediaMap).toHaveBeenCalledWith(expect.objectContaining({
      generationIds: ['gen-1'],
      urlMode: 'signed',
    }));
    expect(mocks.loadGenerationRecipeRemixInputMediaByPostId).not.toHaveBeenCalled();
  });

  it('keeps unshared input files out of a public remix', async () => {
    mocks.resolveRemixAccess.mockResolvedValue({
      allowed: true,
      basis: 'public',
      post: EXPOSED_POST,
      includeSharedInputMedia: false,
      recipeEntitled: false,
    });

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.workflowSettings).toEqual({ model: 'nano-banana-2' });
    expect(mocks.loadGenerationInputMediaMap).not.toHaveBeenCalled();
    expect(mocks.loadGenerationRecipeRemixInputMediaByPostId).not.toHaveBeenCalled();
  });

  it('restores bought recipe media from the post the gate verified, not the one the caller named', async () => {
    mocks.resolveRemixAccess.mockResolvedValue({
      allowed: true,
      basis: 'unlocked',
      post: EXPOSED_POST,
      includeSharedInputMedia: false,
      recipeEntitled: true,
    });

    await loadRemixSourceBundle(request('post-client'), 'gen-1', { postId: 'post-client' });

    expect(mocks.loadGenerationRecipeRemixInputMediaByPostId).toHaveBeenCalledWith(expect.objectContaining({
      postId: 'post-verified',
      generationId: 'gen-1',
      viewerUserId: 'viewer-1',
    }));
  });

  it('lets the owner restore their own input files', async () => {
    mocks.resolveRemixAccess.mockResolvedValue({
      allowed: true,
      basis: 'owner',
      post: null,
      includeSharedInputMedia: true,
      recipeEntitled: false,
    });

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.workflowSettings).toMatchObject({
      referenceImageUrls: ['https://cdn.example/private-face.png'],
    });
    expect(mocks.loadGenerationInputMediaMap).toHaveBeenCalled();
  });
});
