import { describe, expect, it, vi } from 'vitest';

import { importSharedGenerationInputMedia } from '@/lib/generation-input-media-import';

const CREATOR = 'creator-1';
const VIEWER = 'viewer-1';
const SOURCE_PATH = `generation_inputs/${CREATOR}/gen-9/00-reference_image.jpg`;
const DEST_PATH = `${VIEWER}/remix-imports/gen-9/00-reference_image.jpg`;

type AdminStubOptions = {
  mediaRows?: Array<Record<string, unknown>>;
  generationRow?: Record<string, unknown> | null;
  postRows?: Array<Record<string, unknown>>;
  copyError?: { statusCode?: string; message: string; error?: string } | null;
  signError?: { message: string } | null;
};

function createAdminStub(options: AdminStubOptions = {}) {
  const {
    mediaRows = [{ id: 'media-1', generation_id: 'gen-9', user_id: CREATOR, storage_path: SOURCE_PATH }],
    generationRow = { id: 'gen-9', user_id: CREATOR, is_public: true, share_input_media_for_remix: true },
    postRows = [],
    copyError = null,
    signError = null,
  } = options;

  const copy = vi.fn(async () => ({ data: copyError ? null : { path: DEST_PATH }, error: copyError }));
  const createSignedUrl = vi.fn(async (path: string) => (
    signError
      ? { data: null, error: signError }
      : { data: { signedUrl: `https://project.supabase.co/storage/v1/object/sign/generation_inputs/${path}?token=copy` }, error: null }
  ));
  const from = vi.fn((table: string) => {
    const result = table === 'generation_input_media'
      ? { data: mediaRows, error: null }
      : table === 'posts'
        ? { data: postRows, error: null }
        : { data: generationRow, error: null };
    const query = {
      select: () => query,
      eq: () => query,
      limit: () => query,
      maybeSingle: async () => result,
      then: (resolve: (value: unknown) => void) => resolve(result),
    };
    return query;
  });

  const client = {
    from,
    storage: { from: vi.fn(() => ({ copy, createSignedUrl })) },
  };

  return { client, from, copy, createSignedUrl };
}

function createDependencies(stub: ReturnType<typeof createAdminStub>, overrides: {
  blocked?: boolean | (() => Promise<boolean>);
  recipeItems?: Array<{ storagePath: string | null }>;
} = {}) {
  const blockedOption = overrides.blocked ?? false;
  return {
    createServiceClient: (() => stub.client) as never,
    isUserRelationshipBlocked: vi.fn(async () => {
      if (typeof blockedOption === 'function') return blockedOption();
      return blockedOption;
    }) as never,
    loadGenerationRecipeRemixInputMediaByPostId: vi.fn(async () => (overrides.recipeItems ?? []) as never),
  };
}

describe('importSharedGenerationInputMedia', () => {
  it('imports a freely shared input into the viewer prefix', async () => {
    const stub = createAdminStub();
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(stub.copy).toHaveBeenCalledWith(`${CREATOR}/gen-9/00-reference_image.jpg`, DEST_PATH);
    expect(result).toEqual({
      outcome: 'imported',
      storagePath: `generation_inputs/${DEST_PATH}`,
      signedUrl: expect.stringContaining(DEST_PATH),
    });
  });

  it('accepts the signed-URL form of the same source, even when expired', async () => {
    const stub = createAdminStub();
    const result = await importSharedGenerationInputMedia({
      // The token is never fetched — authorization derives from the path alone.
      source: `https://project.supabase.co/storage/v1/object/sign/${SOURCE_PATH}?token=expired`,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(result.outcome).toBe('imported');
  });

  it('rejects sources outside the durable inputs bucket without touching the database', async () => {
    const stub = createAdminStub();
    const result = await importSharedGenerationInputMedia({
      source: `uploads/${CREATOR}/reference.jpg`,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(result).toEqual({ outcome: 'not-eligible' });
    expect(stub.from).not.toHaveBeenCalled();
  });

  it('is not eligible when the generation no longer shares its inputs', async () => {
    const stub = createAdminStub({
      generationRow: { id: 'gen-9', user_id: CREATOR, is_public: true, share_input_media_for_remix: false },
    });
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(result).toEqual({ outcome: 'not-eligible' });
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it('is not eligible when there is no durable input row for the path', async () => {
    const stub = createAdminStub({ mediaRows: [] });
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(result).toEqual({ outcome: 'not-eligible' });
  });

  it('refuses when the viewer and creator block each other', async () => {
    const stub = createAdminStub();
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub, { blocked: true }),
    });

    expect(result).toEqual({ outcome: 'not-eligible' });
  });

  it('treats a failing block check as blocked', async () => {
    const stub = createAdminStub();
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub, {
        blocked: async () => {
          throw new Error('moderation outage');
        },
      }),
    });

    expect(result).toEqual({ outcome: 'not-eligible' });
  });

  it('authorizes through a purchased recipe when free sharing is off', async () => {
    const stub = createAdminStub({
      generationRow: { id: 'gen-9', user_id: CREATOR, is_public: true, share_input_media_for_remix: false },
      postRows: [{ id: 'post-7' }],
    });
    const dependencies = createDependencies(stub, { recipeItems: [{ storagePath: SOURCE_PATH }] });
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies,
    });

    expect(dependencies.loadGenerationRecipeRemixInputMediaByPostId).toHaveBeenCalledWith({
      postId: 'post-7',
      generationId: 'gen-9',
      viewerUserId: VIEWER,
      adminSupabase: stub.client,
    });
    expect(result.outcome).toBe('imported');
  });

  it('stays ineligible when the recipe grant covers different media', async () => {
    const stub = createAdminStub({
      generationRow: { id: 'gen-9', user_id: CREATOR, is_public: true, share_input_media_for_remix: false },
      postRows: [{ id: 'post-7' }],
    });
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub, {
        recipeItems: [{ storagePath: `generation_inputs/${CREATOR}/gen-9/01-reference_image.jpg` }],
      }),
    });

    expect(result).toEqual({ outcome: 'not-eligible' });
  });

  it('treats an already-existing destination copy as success', async () => {
    const stub = createAdminStub({
      copyError: { statusCode: '409', message: 'The resource already exists', error: 'Duplicate' },
    });
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(result.outcome).toBe('imported');
  });

  it('fails retryably when the copy or signing fails after authorization', async () => {
    const copyFailed = createAdminStub({ copyError: { message: 'service unavailable' } });
    await expect(importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(copyFailed),
    })).resolves.toEqual({ outcome: 'failed' });

    const signFailed = createAdminStub({ signError: { message: 'signing unavailable' } });
    await expect(importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(signFailed),
    })).resolves.toEqual({ outcome: 'failed' });
  });

  it('fails closed on inconsistent ownership between path, row, and generation', async () => {
    const rowMismatch = createAdminStub({
      mediaRows: [{ id: 'media-1', generation_id: 'gen-9', user_id: 'someone-else', storage_path: SOURCE_PATH }],
    });
    await expect(importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(rowMismatch),
    })).resolves.toEqual({ outcome: 'not-eligible' });

    const generationMismatch = createAdminStub({
      generationRow: { id: 'gen-9', user_id: 'someone-else', is_public: true, share_input_media_for_remix: true },
    });
    await expect(importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(generationMismatch),
    })).resolves.toEqual({ outcome: 'not-eligible' });
  });
});
