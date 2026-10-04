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
import { collectReferenceMediaCandidates, collectSubjectImageCandidates } from '@/lib/generation-input-media';
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

// Audit, additional risk: keeping a generation's inputs fails one item at a
// time, and each failure is only logged. A generation that kept some of its
// inputs restored as though it had kept them all, so a remix showed half a
// recipe with nothing to say the rest was missing.
describe('a recipe whose inputs were only partly kept', () => {
  const OWNER_ACCESS = { allowed: true, basis: 'owner', post: null, includeSharedInputMedia: true, recipeEntitled: false };
  const KEPT_IMAGE = {
    id: 'row-0',
    generationId: 'gen-1',
    mediaType: 'image',
    role: 'reference_image',
    label: 'Girl',
    url: 'https://signed.example/girl.png',
    storagePath: 'generation_inputs/creator-1/gen-1/00-reference_image.png',
    sourceGenerationId: null,
    sortOrder: 0,
    metadata: { handle: '@girl', displayName: 'Girl', sourceStoragePath: 'uploads/creator-1/girl.png' },
  };
  /** What the recipe itself says it used, read without signing anything. */
  const DECLARED_IMAGE = { ...KEPT_IMAGE, id: 'legacy-0', url: null, storagePath: 'uploads/creator-1/girl.png', metadata: { legacy: true } };
  const DECLARED_CLIP = {
    id: 'legacy-1',
    generationId: 'gen-1',
    mediaType: 'video',
    role: 'reference_video',
    label: 'Clip',
    url: null,
    storagePath: null,
    sourceGenerationId: null,
    sortOrder: 1,
    metadata: { legacy: true, sourceUrl: 'https://cdn.example/clip.mp4' },
  };

  beforeEach(() => {
    mocks.resolveRemixAccess.mockResolvedValue(OWNER_ACCESS);
    mocks.generation = {
      ...mocks.generation,
      category: 'video',
      model: 'seedance-2',
      workflow_settings: { model: 'seedance-2', referenceMode: 'elements' },
    };
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', [KEPT_IMAGE]]]));
  });

  it('says some media could not be restored when the recipe used more than was kept', async () => {
    mocks.buildLegacyGenerationInputMedia.mockResolvedValue([DECLARED_IMAGE, DECLARED_CLIP]);

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputs.video?.elements).toEqual([expect.objectContaining({ handle: '@girl', url: 'https://signed.example/girl.png' })]);
    expect(bundle.restoreIssues).toContain('input-media-not-kept:video');
    expect(mocks.buildLegacyGenerationInputMedia).toHaveBeenCalledWith(expect.objectContaining({ generationId: 'gen-1', urlMode: 'none' }));
  });

  it('adds nothing when everything the recipe used was kept', async () => {
    mocks.buildLegacyGenerationInputMedia.mockResolvedValue([DECLARED_IMAGE]);

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.restoreIssues.filter((issue) => issue.startsWith('input-media-not-kept'))).toEqual([]);
  });
});

// A Seedance run sends its reference clip to the provider as a plain URL, and
// that URL is all the recipe records of it. Reported from a live post: the
// remix opened with the three reference images and no sign that a clip existed.
describe('a recipe with a reference clip sent as a plain URL', () => {
  const OWNER_ACCESS = { allowed: true, basis: 'owner', post: null, includeSharedInputMedia: true, recipeEntitled: false };
  const KEPT_IMAGE = {
    id: 'row-0',
    generationId: 'gen-1',
    mediaType: 'image',
    role: 'reference_image',
    label: 'Ali',
    url: 'https://signed.example/ali.png',
    storagePath: 'generation_inputs/creator-1/gen-1/00-reference_image.png',
    sourceGenerationId: null,
    sortOrder: 0,
    metadata: { id: 'imageReferences-1', handle: '@ali', displayName: 'Ali', sourceStoragePath: 'uploads/creator-1/ali.png' },
  };

  beforeEach(async () => {
    // The recipe is read by the real builder here: what it declares is the point.
    const actual = await vi.importActual<typeof import('@/lib/generation-input-media')>('@/lib/generation-input-media');
    mocks.buildLegacyGenerationInputMedia.mockImplementation(actual.buildLegacyGenerationInputMedia);
    mocks.resolveRemixAccess.mockResolvedValue(OWNER_ACCESS);
    mocks.generation = {
      ...mocks.generation,
      category: 'video',
      model: 'seedance-2',
      prompt: 'Change the first person in the reference video to @ali',
      workflow_settings: {
        model: 'seedance-2',
        referenceMode: 'references',
        elements: [{ id: 'imageReferences-1', displayName: 'Ali', handle: '@ali', storagePath: 'uploads/creator-1/ali.png', sourceGenerationId: null }],
        referenceVideoUrls: [
          'https://project.supabase.co/storage/v1/object/sign/uploads/creator-1/dance.mp4?token=expired',
        ],
      },
    };
  });

  it('says a clip is missing when only the images were kept', async () => {
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', [KEPT_IMAGE]]]));

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputs.video?.referenceVideos).toEqual([]);
    expect(bundle.restoreIssues).toContain('input-media-not-kept:video');
  });

  // The round trip for a run started now: the row the video start keeps for the
  // clip, read back the way loadGenerationInputMediaMap returns it.
  it('restores the clip beside the images once the run keeps it', async () => {
    const [clip] = collectReferenceMediaCandidates({
      mediaType: 'video',
      sources: ['https://project.supabase.co/storage/v1/object/sign/uploads/creator-1/dance.mp4?token=read'],
      resolvedUrls: ['https://project.supabase.co/storage/v1/object/sign/uploads/creator-1/dance.mp4?token=provider'],
      descriptors: [{ kind: 'video', label: 'Dance clip', storagePath: 'uploads/creator-1/dance.mp4', sourceGenerationId: null, durationSeconds: 9.4 }],
    });
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', [KEPT_IMAGE, {
      id: 'row-1',
      generationId: 'gen-1',
      mediaType: clip.mediaType,
      role: clip.role,
      label: clip.label ?? '',
      url: 'https://signed.example/dance.mp4',
      storagePath: 'generation_inputs/creator-1/gen-1/01-reference_video.mp4',
      sourceGenerationId: clip.sourceGenerationId ?? null,
      sortOrder: 1,
      metadata: { ...clip.metadata, sourceStoragePath: clip.sourceStoragePath ?? null },
    }]]]));

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputs.video?.elements).toEqual([expect.objectContaining({ handle: '@ali', url: 'https://signed.example/ali.png' })]);
    // With its length: a Seedance remix cannot be quoted without it.
    expect(bundle.inputs.video?.referenceVideos).toEqual([{
      kind: 'video',
      label: 'Dance clip',
      storagePath: 'generation_inputs/creator-1/gen-1/01-reference_video.mp4',
      sourceGenerationId: null,
      url: 'https://signed.example/dance.mp4',
      durationSeconds: 9.4,
    }]);
    expect(bundle.restoreIssues.filter((issue) => issue.startsWith('input-media-not-kept'))).toEqual([]);
  });
});

// A Kling O3 run takes named subjects: two to four pictures of one person or
// product, under an @handle the prompt mentions. A run kept nothing of them, so
// a remix of it restored the prompt and no subject (2026-10-03).
describe('a Kling O3 run with named subjects', () => {
  const OWNER_ACCESS = { allowed: true, basis: 'owner', post: null, includeSharedInputMedia: true, recipeEntitled: false };
  const PUBLIC_ACCESS = { allowed: true, basis: 'public', post: EXPOSED_POST, includeSharedInputMedia: false, recipeEntitled: false };
  // Neither handle is the one its subject's name would give.
  const DECLARED_SUBJECTS = [
    {
      handle: '@lead',
      displayName: 'Hero creator',
      images: [{ storagePath: 'uploads/creator-1/hero-front.png' }, { storagePath: 'uploads/creator-1/hero-side.png' }],
    },
    {
      handle: '@bottle',
      displayName: 'Serum bottle',
      images: [{ storagePath: 'uploads/creator-1/bottle-front.png' }, { storagePath: 'uploads/creator-1/bottle-side.png' }],
    },
  ];

  // The round trip for a run started now: the rows the video start keeps for
  // its subjects, read back the way loadGenerationInputMediaMap returns them.
  const KEPT_PICTURES = collectSubjectImageCandidates({
    subjects: DECLARED_SUBJECTS.map((subject) => ({
      ...subject,
      images: subject.images.map((image) => ({ url: image.storagePath, storagePath: image.storagePath })),
      imageUrls: subject.images.map((image) => `https://provider.example/${image.storagePath}`),
    })),
  }).map((candidate, sortOrder) => ({
    id: `row-${sortOrder}`,
    generationId: 'gen-1',
    mediaType: candidate.mediaType,
    role: candidate.role,
    label: candidate.label ?? '',
    url: `https://signed.example/kept-${sortOrder}.png`,
    storagePath: `generation_inputs/creator-1/gen-1/0${sortOrder}-${candidate.role}.png`,
    sourceGenerationId: candidate.sourceGenerationId ?? null,
    sortOrder,
    metadata: { ...candidate.metadata, sourceStoragePath: candidate.sourceStoragePath ?? null },
  }));
  const RESTORED_SUBJECTS = [
    {
      handle: '@lead',
      displayName: 'Hero creator',
      images: [0, 1].map((sortOrder) => ({
        kind: 'image',
        label: 'Hero creator',
        storagePath: `generation_inputs/creator-1/gen-1/0${sortOrder}-subject_image.png`,
        sourceGenerationId: null,
        url: `https://signed.example/kept-${sortOrder}.png`,
      })),
    },
    {
      handle: '@bottle',
      displayName: 'Serum bottle',
      images: [2, 3].map((sortOrder) => ({
        kind: 'image',
        label: 'Serum bottle',
        storagePath: `generation_inputs/creator-1/gen-1/0${sortOrder}-subject_image.png`,
        sourceGenerationId: null,
        url: `https://signed.example/kept-${sortOrder}.png`,
      })),
    },
  ];

  beforeEach(async () => {
    // The recipe is read by the real builder here: what it declares is the point.
    const actual = await vi.importActual<typeof import('@/lib/generation-input-media')>('@/lib/generation-input-media');
    mocks.buildLegacyGenerationInputMedia.mockImplementation(actual.buildLegacyGenerationInputMedia);
    mocks.resolveRemixAccess.mockResolvedValue(OWNER_ACCESS);
    mocks.generation = {
      ...mocks.generation,
      category: 'video',
      model: 'kling-o3',
      prompt: '@lead lifts @bottle and smiles at the camera.',
      workflow_settings: { model: 'kling-o3', referenceMode: 'elements', klingSubjects: DECLARED_SUBJECTS },
    };
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', KEPT_PICTURES]]));
  });

  it('restores each subject with its handle, its name and its pictures, in the order the run used them', async () => {
    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputs.video?.subjects).toEqual(RESTORED_SUBJECTS);
    // A subject's pictures are one identity, not four references: they are not
    // handed to a creator that would attach them as plain reference images.
    expect(bundle.inputs.video?.elements).toEqual([]);
    expect(bundle.restoreIssues.filter((issue) => issue.startsWith('input-media-not-kept') || issue.startsWith('video-subject'))).toEqual([]);
  });

  it('says some media is missing when the run kept fewer pictures than its subjects had', async () => {
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', KEPT_PICTURES.slice(0, 3)]]));

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputs.video?.subjects?.map((subject) => [subject.handle, subject.images.length])).toEqual([
      ['@lead', 2],
      ['@bottle', 1],
    ]);
    expect(bundle.restoreIssues).toContain('input-media-not-kept:image');
  });

  it('names the subject whose picture has no link to hand over', async () => {
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', [
      ...KEPT_PICTURES.slice(0, 3),
      { ...KEPT_PICTURES[3], url: null },
    ]]]));

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputs.video?.subjects?.[1].images.map((image) => image.url)).toEqual(['https://signed.example/kept-2.png', null]);
    expect(bundle.restoreIssues).toContain('video-subject:Serum bottle');
    expect(bundle.restoreIssues).not.toContain('video-subject:Hero creator');
  });

  // No copy of the pictures was made (keeping them failed outright): the owner's
  // remix reads them from where the run's settings say they were staged.
  it('restores the subjects from the run’s settings when no copy of their pictures was kept', async () => {
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map());

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputs.video?.subjects).toEqual(DECLARED_SUBJECTS.map((subject) => ({
      handle: subject.handle,
      displayName: subject.displayName,
      images: subject.images.map((image) => ({
        kind: 'image',
        label: subject.displayName,
        storagePath: image.storagePath,
        sourceGenerationId: null,
        url: 'https://signed.example/upload',
      })),
    })));
  });

  it('restores no subject for a run that recorded none', async () => {
    // A run made before subjects were kept: its prompt mentions them and nothing else does.
    mocks.generation = { ...mocks.generation, workflow_settings: { model: 'kling-o3', referenceMode: 'elements' } };
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map());

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.generation.prompt).toBe('@lead lifts @bottle and smiles at the camera.');
    expect(bundle.inputs.video?.subjects).toEqual([]);
    expect(bundle.restoreIssues.filter((issue) => issue.startsWith('input-media-not-kept') || issue.startsWith('video-subject'))).toEqual([]);
  });

  it('keeps the subjects out of a remix the creator did not share the run’s inputs with', async () => {
    mocks.resolveRemixAccess.mockResolvedValue(PUBLIC_ACCESS);

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.generation.prompt).toBe('@lead lifts @bottle and smiles at the camera.');
    expect(bundle.inputs.video).toBeUndefined();
    expect(bundle.workflowSettings).toEqual({ model: 'kling-o3', referenceMode: 'elements' });
    expect(JSON.stringify(bundle)).not.toMatch(/hero-front|subject_image|Hero creator/);
    expect(mocks.loadGenerationInputMediaMap).not.toHaveBeenCalled();
  });

  it('restores the subjects of a bought recipe from the post the gate verified, with the settings still stripped', async () => {
    mocks.resolveRemixAccess.mockResolvedValue({ ...PUBLIC_ACCESS, basis: 'unlocked', recipeEntitled: true });
    mocks.loadGenerationRecipeRemixInputMediaByPostId.mockResolvedValue(KEPT_PICTURES);

    const bundle = await loadRemixSourceBundle(request('post-client'), 'gen-1', { postId: 'post-client' });

    expect(mocks.loadGenerationRecipeRemixInputMediaByPostId).toHaveBeenCalledWith(expect.objectContaining({
      postId: 'post-verified',
      generationId: 'gen-1',
      viewerUserId: 'viewer-1',
    }));
    expect(bundle.inputs.video?.subjects).toEqual(RESTORED_SUBJECTS);
    expect(bundle.workflowSettings).toEqual({ model: 'kling-o3', referenceMode: 'elements' });
    expect(mocks.loadGenerationInputMediaMap).not.toHaveBeenCalled();
  });
});
