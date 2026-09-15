import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generation: null as Record<string, unknown> | null,
  selectedColumns: [] as string[],
  resolveRemixAccess: vi.fn(),
  loadGenerationInputMediaMap: vi.fn(),
  buildLegacyGenerationInputMedia: vi.fn(),
  loadGenerationRecipeRemixInputMediaByPostId: vi.fn(),
}));

const adminClient = {
  from: vi.fn(() => {
    const builder = {
      select: (columns: string) => {
        mocks.selectedColumns.push(columns);
        return builder;
      },
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

import { buildCatalogInputMediaCandidates } from '@/lib/catalog-input-media-candidates';
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
  mocks.selectedColumns.length = 0;
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

// Audit, additional risk: a motion model onboarded through the generic catalog
// path is stored the catalog's way. The record is a 'video' generation marked
// by creation_mode, its inputs are slots, and its durable rows took the plain
// reference roles. Remix only knew the legacy motion shape, so it restored the
// character image as a video reference and the motion creator got nothing.
describe('remixing a motion generation made through the catalog', () => {
  const OWNER_ACCESS = { allowed: true, basis: 'owner', post: null, includeSharedInputMedia: true, recipeEntitled: false };
  const CATALOG_INPUTS = [
    { slot: 'characterImage', kind: 'image', label: 'Character image', storagePath: 'uploads/creator-1/hero.png' },
    { slot: 'referenceVideo', kind: 'video', label: 'Reference video', storagePath: 'uploads/creator-1/moves.mp4', durationSeconds: 8 },
  ] as const;

  function catalogMotionGeneration() {
    return {
      id: 'gen-1',
      user_id: 'creator-1',
      is_public: true,
      share_input_media_for_remix: true,
      output_url: null,
      showcase_asset_path: null,
      category: 'video',
      creation_mode: 'motion',
      model: 'kling-2.6',
      prompt: 'Dance like the clip',
      title: 'Dance',
      // What startCatalogGeneration writes: settings at the top level and the
      // inputs as slots, with no legacy characterImage or referenceVideo keys.
      workflow_settings: {
        model: 'kling-2.6',
        catalogRevision: 'rev-1',
        resolution: '720p',
        characterOrientation: 'video',
        duration: 8,
        inputs: CATALOG_INPUTS,
      },
    };
  }

  /** Durable rows as the catalog path persisted them before motion slots had motion roles. */
  const ROWS_WITH_REFERENCE_ROLES = [
    {
      id: 'row-0',
      generationId: 'gen-1',
      mediaType: 'image',
      role: 'reference_image',
      label: 'Character image',
      url: 'https://signed.example/hero.png',
      storagePath: 'generation_inputs/creator-1/gen-1/00-reference_image.png',
      sourceGenerationId: null,
      sortOrder: 0,
      metadata: { slot: 'characterImage', displayName: 'Character image', sourceStoragePath: 'uploads/creator-1/hero.png' },
    },
    {
      id: 'row-1',
      generationId: 'gen-1',
      mediaType: 'video',
      role: 'reference_video',
      label: 'Reference video',
      url: 'https://signed.example/moves.mp4',
      storagePath: 'generation_inputs/creator-1/gen-1/01-reference_video.mp4',
      sourceGenerationId: null,
      sortOrder: 1,
      metadata: { slot: 'referenceVideo', durationSeconds: 8, sourceStoragePath: 'uploads/creator-1/moves.mp4' },
    },
  ];

  beforeEach(() => {
    mocks.generation = catalogMotionGeneration();
    mocks.resolveRemixAccess.mockResolvedValue(OWNER_ACCESS);
  });

  it('restores its durable inputs into the motion creator, reading the slot where the role is generic', async () => {
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', ROWS_WITH_REFERENCE_ROLES]]));

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(mocks.selectedColumns.join(' ')).toContain('creation_mode');
    expect(bundle.inputs.video).toBeUndefined();
    expect(bundle.inputs.motion).toEqual({
      characterImage: expect.objectContaining({ kind: 'image', url: 'https://signed.example/hero.png' }),
      referenceVideo: expect.objectContaining({ kind: 'video', url: 'https://signed.example/moves.mp4' }),
    });
    // The fixture has no output, which is its own issue; neither input is one.
    expect(bundle.restoreIssues.filter((issue) => issue.startsWith('motion-') || issue.startsWith('video-'))).toEqual([]);
  });

  // The round trip for a generation started now: the rows the catalog start
  // keeps, read back the way loadGenerationInputMediaMap returns them, restore
  // into the motion creator.
  it('restores what a new catalog motion start keeps', async () => {
    const candidates = buildCatalogInputMediaCandidates(
      'motion',
      CATALOG_INPUTS.map((input) => ({ ...input, url: `https://provider.example/${input.slot}` })),
    );
    expect(candidates.map((candidate) => candidate.role)).toEqual(['character_image', 'motion_reference_video']);
    const rows = candidates.map((candidate, index) => ({
      id: `row-${index}`,
      generationId: 'gen-1',
      mediaType: candidate.mediaType,
      role: candidate.role,
      label: candidate.label ?? '',
      url: `https://signed.example/durable-${index}`,
      storagePath: `generation_inputs/creator-1/gen-1/0${index}-${candidate.role}`,
      sourceGenerationId: candidate.sourceGenerationId ?? null,
      sortOrder: candidate.sortOrder ?? index,
      metadata: { ...candidate.metadata, sourceStoragePath: candidate.sourceStoragePath ?? null },
    }));
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', rows]]));

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputs.video).toBeUndefined();
    expect(bundle.inputs.motion).toEqual({
      characterImage: expect.objectContaining({ kind: 'image', label: 'Character image', url: 'https://signed.example/durable-0' }),
      referenceVideo: expect.objectContaining({ kind: 'video', label: 'Reference video', url: 'https://signed.example/durable-1' }),
    });
  });

  it('restores from its own input slots when no durable copy was made', async () => {
    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputs.video).toBeUndefined();
    expect(bundle.inputs.motion).toEqual({
      characterImage: expect.objectContaining({ kind: 'image', storagePath: 'uploads/creator-1/hero.png', url: 'https://signed.example/upload' }),
      referenceVideo: expect.objectContaining({ kind: 'video', storagePath: 'uploads/creator-1/moves.mp4', url: 'https://signed.example/upload' }),
    });
  });
});
