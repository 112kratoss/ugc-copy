import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyPostSocialActivity } from '@/lib/mobile-notifications';

vi.mock('@/lib/mobile-notifications', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/mobile-notifications')>(),
  notifyPostSocialActivity: vi.fn(),
}));

beforeEach(() => { vi.mocked(notifyPostSocialActivity).mockClear(); });

import { resolvePostRemixCapability } from '@/lib/post-resource-bundles';
import {
  remixShowcasePostForRoute,
  type ShowcaseRemixServiceDependencies,
} from '@/lib/showcase-remix-service';

type Row = Record<string, unknown>;

type GenerationQueryOptions = {
  generation?: Row | null;
  generationError?: unknown;
  rpcError?: unknown;
  post?: Row | null;
  bundle?: Row | null;
  bundleError?: unknown;
  purchases?: Row[];
  profiles?: Row[];
};

const PUBLIC_CREATOR_GENERATION = {
  id: 'gen-1',
  user_id: 'creator-1',
  is_public: true,
  share_input_media_for_remix: true,
  category: 'image',
  prompt: 'Create a clean UGC product reveal.',
  workflow_settings: { model: 'nano-banana-2' },
};

/** The generation's post as the remix gate re-reads it. */
const EXPOSED_POST_ROW = {
  id: 'post-1',
  user_id: 'creator-1',
  generation_id: 'gen-1',
  category: 'image',
  post_format: 'media',
  source_kind: 'magicbooklet',
  visibility: 'public',
  archived_at: null,
  review_status: 'visible',
};

const REMIX_RECIPE_BUNDLE = {
  id: 'bundle-1',
  post_id: 'post-1',
  status: 'published',
  allow_remix: true,
};

/**
 * The generations read runs through the SERVICE client on purpose:
 * authenticated clients hold no read grant on prompt/workflow_settings since
 * the 2026-07-26 hardening migration, which is exactly the drift that broke
 * remix in production. This mock models rpc + every read the remix gate makes
 * on one client — the generation, its post, the post's recipe, purchases and
 * linked profiles — applying each `eq` filter, so the tests run the real access
 * decision and fail if a read ever moves back to a user client.
 */
function createServiceClientMock({
  generation = PUBLIC_CREATOR_GENERATION,
  generationError = null,
  rpcError = null,
  post = EXPOSED_POST_ROW,
  bundle = null,
  bundleError = null,
  purchases = [],
  profiles = [],
}: GenerationQueryOptions = {}) {
  const tables: Record<string, Row[]> = {
    generations: generation ? [generation] : [],
    posts: post ? [post] : [],
    post_resource_bundles: bundle ? [bundle] : [],
    post_resource_bundle_purchases: purchases,
    profiles,
  };
  const errors: Record<string, unknown> = {
    generations: generationError,
    post_resource_bundles: bundleError,
  };
  const selectMock = vi.fn();
  const eqMock = vi.fn();
  const maybeSingleMock = vi.fn();
  const fromMock = vi.fn((table: string) => {
    if (!(table in tables)) {
      throw new Error(`Unexpected table: ${table}`);
    }

    const filters: Array<[string, unknown]> = [];
    const outcome = (single: boolean) => {
      if (errors[table]) return { data: null, error: errors[table] };
      const matches = tables[table].filter((row) => filters.every(([column, value]) => row[column] === value));
      return { data: single ? matches[0] ?? null : matches, error: null };
    };
    const builder = {
      select: (columns: string) => {
        selectMock(columns);
        return builder;
      },
      eq: (column: string, value: unknown) => {
        eqMock(column, value);
        filters.push([column, value]);
        return builder;
      },
      maybeSingle: async () => {
        maybeSingleMock(table);
        return outcome(true);
      },
      then: (
        resolve: (value: ReturnType<typeof outcome>) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(outcome(false)).then(resolve, reject),
    };
    return builder;
  });
  const rpcMock = vi.fn(async () => ({
    data: true,
    error: rpcError,
  }));

  return {
    client: { from: fromMock, rpc: rpcMock } as unknown as SupabaseClient,
    eqMock,
    fromMock,
    maybeSingleMock,
    rpcMock,
    selectMock,
  };
}

/**
 * Derived from the real dependency rather than restated as
 * `Record<string, unknown>`: the loose shape does not satisfy the service's
 * declared return type, and hard-coding a literal here would drift the moment
 * the row shape changes.
 */
type RemixPostReference = Awaited<
  ReturnType<ShowcaseRemixServiceDependencies['findPublicPostReferenceByIdOrGenerationId']>
>;

type RemixPostCategory = NonNullable<RemixPostReference>['category'];

function createDependencies(
  post: RemixPostReference = {
    id: 'post-1',
    generation_id: 'gen-1',
    user_id: 'creator-1',
    category: 'image',
    visibility: 'public',
    prompt: 'a prompt',
    source_kind: 'magicbooklet',
  },
) {
  return {
    findPublicPostReferenceByIdOrGenerationId: vi.fn(async () => post),
    isUserRelationshipBlocked: vi.fn(async () => false),
  } satisfies Partial<ShowcaseRemixServiceDependencies>;
}

describe('remixShowcasePostForRoute', () => {
  it('reads the linked generation service-role and returns prefill without counting or notifying', async () => {
    const serviceClient = createServiceClientMock();
    const dependencies = createDependencies();

    const result = await remixShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        redirectTo: '/create-image?remix=gen-1&remixPost=post-1',
        prefill: {
          prompt: 'Create a clean UGC product reveal.',
          settings: { model: 'nano-banana-2' },
        },
      },
    });
    expect(dependencies.findPublicPostReferenceByIdOrGenerationId).toHaveBeenCalledWith(
      'post-1',
      serviceClient.client,
    );
    expect(serviceClient.fromMock).toHaveBeenCalledWith('generations');
    expect(serviceClient.selectMock).toHaveBeenCalledWith(
      'id, user_id, is_public, share_input_media_for_remix, category, model, prompt, workflow_settings',
    );
    expect(serviceClient.eqMock).toHaveBeenCalledWith('id', 'gen-1');
    expect(serviceClient.rpcMock).not.toHaveBeenCalled();
    expect(notifyPostSocialActivity).not.toHaveBeenCalled();
  });

  it.each([
    ['video', '/create-video'],
    ['ugc-ad', '/create-video'],
    ['motion', '/create-motion'],
    ['unknown', '/create-image'],
    [null, '/create-image'],
  ] as Array<[RemixPostCategory, string]>)(
    'maps %s generations to the expected remix creator path', async (category, expectedPath) => {
    const serviceClient = createServiceClientMock({
      generation: { ...PUBLIC_CREATOR_GENERATION, category },
    });
    const dependencies = createDependencies({
      id: 'post-1',
      generation_id: 'gen-1',
      user_id: 'creator-1',
      category,
      visibility: 'public',
      prompt: 'a prompt',
      source_kind: 'magicbooklet',
    });

    const result = await remixShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.body.redirectTo : null).toBe(`${expectedPath}?remix=gen-1&remixPost=post-1`);
  });

  it.each([
    ['by stored category', { category: 'audio', model: 'nano-banana-2' }],
    ['by model when the category is stale', { category: null, model: 'text-to-speech-turbo-2-5' }],
  ] as Array<[string, { category: string | null; model: string }]>)(
    'refuses an audio remix %s instead of routing it to a tool that cannot take it',
    async (_label, generationOverrides) => {
      const serviceClient = createServiceClientMock({
        generation: { ...PUBLIC_CREATOR_GENERATION, ...generationOverrides },
      });
      const dependencies = createDependencies({
        id: 'post-1',
        generation_id: 'gen-1',
        user_id: 'creator-1',
        // The post row carries a showcase category; the audio signal lives on
        // the generation, which is what the guard reads.
        category: 'image',
        visibility: 'public',
        prompt: 'a prompt',
        source_kind: 'magicbooklet',
      });

      const result = await remixShowcasePostForRoute({
        actorUserId: 'user-1',
        referenceId: 'post-1',
        serviceClient: serviceClient.client,
        dependencies,
      });

      expect(result.ok).toBe(false);
      expect(result.ok ? null : result.status).toBe(400);
      expect(result.ok ? null : result.body.error).toBe('Audio creations cannot be remixed yet');
      // A refusal must not inflate the creator's remix count or ping them.
      expect(serviceClient.rpcMock).not.toHaveBeenCalled();
      expect(notifyPostSocialActivity).not.toHaveBeenCalled();
    }
  );

  it('falls back to the post category when the generation row has none', async () => {
    const serviceClient = createServiceClientMock({
      generation: { ...PUBLIC_CREATOR_GENERATION, category: null },
    });
    const dependencies = createDependencies({
      id: 'post-1',
      generation_id: 'gen-1',
      user_id: 'creator-1',
      category: 'video',
      visibility: 'public',
      prompt: 'a prompt',
      source_kind: 'magicbooklet',
    });

    const result = await remixShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result.ok ? result.body.redirectTo : null).toBe('/create-video?remix=gen-1&remixPost=post-1');
  });

  it('rejects private or missing post references before remix mutation work', async () => {
    const serviceClient = createServiceClientMock();
    const dependencies = createDependencies(null);

    const result = await remixShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'missing-post',
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Creation is private or not found' },
    });
    expect(serviceClient.rpcMock).not.toHaveBeenCalled();
    expect(serviceClient.fromMock).not.toHaveBeenCalled();
    expect(notifyPostSocialActivity).not.toHaveBeenCalled();
  });

  it('rejects blocked creator interactions before remix counters, media reads, or notifications', async () => {
    const serviceClient = createServiceClientMock();
    const dependencies = createDependencies();
    dependencies.isUserRelationshipBlocked.mockResolvedValue(true);

    const result = await remixShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Creation is private or not found' },
    });
    expect(serviceClient.rpcMock).not.toHaveBeenCalled();
    expect(serviceClient.fromMock).not.toHaveBeenCalled();
    expect(notifyPostSocialActivity).not.toHaveBeenCalled();
  });

  it('rejects posts that are not backed by a generation before incrementing remix count', async () => {
    const serviceClient = createServiceClientMock();
    const dependencies = createDependencies({
      id: 'post-1',
      generation_id: null,
      user_id: 'creator-1',
      category: 'image',
      visibility: 'public',
      prompt: 'a prompt',
      source_kind: 'magicbooklet',
    });

    const result = await remixShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'Only generation-backed posts can be remixed' },
    });
    expect(serviceClient.rpcMock).not.toHaveBeenCalled();
    expect(serviceClient.fromMock).not.toHaveBeenCalled();
    expect(notifyPostSocialActivity).not.toHaveBeenCalled();
  });

  it('opens the editor without invoking the retired counter', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const serviceClient = createServiceClientMock({
      rpcError: { message: 'rpc unavailable' },
    });
    const dependencies = createDependencies();

    const result = await remixShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result.ok).toBe(true);
    expect(serviceClient.rpcMock).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('rejects missing linked generations without touching the counter or notifying', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const serviceClient = createServiceClientMock({
      generation: null,
      generationError: { message: 'not found' },
    });
    const dependencies = createDependencies();

    const result = await remixShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Linked generation not found' },
    });
    expect(serviceClient.rpcMock).not.toHaveBeenCalled();
    expect(notifyPostSocialActivity).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('allows a cross-user remix of a public generation', async () => {
    const serviceClient = createServiceClientMock();
    const dependencies = createDependencies();

    const result = await remixShowcasePostForRoute({
      actorUserId: 'someone-else',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result.ok).toBe(true);
    expect(serviceClient.rpcMock).not.toHaveBeenCalled();
  });

  it('rejects a cross-user remix once the generation is no longer public', async () => {
    const serviceClient = createServiceClientMock({
      generation: { ...PUBLIC_CREATOR_GENERATION, is_public: false },
    });
    const dependencies = createDependencies();

    const result = await remixShowcasePostForRoute({
      actorUserId: 'someone-else',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Linked generation not found' },
    });
    expect(serviceClient.rpcMock).not.toHaveBeenCalled();
    expect(notifyPostSocialActivity).not.toHaveBeenCalled();
  });

  it('lets the owner remix their own generation even when it is private', async () => {
    const serviceClient = createServiceClientMock({
      generation: { ...PUBLIC_CREATOR_GENERATION, is_public: false },
    });
    const dependencies = createDependencies();

    const result = await remixShowcasePostForRoute({
      actorUserId: 'creator-1',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result.ok).toBe(true);
  });

  it('rejects generations that do not belong to the post creator', async () => {
    const serviceClient = createServiceClientMock({
      generation: { ...PUBLIC_CREATOR_GENERATION, user_id: 'unrelated-user' },
    });
    const dependencies = createDependencies();

    const result = await remixShowcasePostForRoute({
      actorUserId: 'someone-else',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Linked generation not found' },
    });
  });

  it('strips input-media settings for remixers when the creator has not shared them', async () => {
    const serviceClient = createServiceClientMock({
      generation: {
        ...PUBLIC_CREATOR_GENERATION,
        share_input_media_for_remix: false,
        workflow_settings: {
          model: 'nano-banana-2',
          referenceImageUrls: ['https://cdn.example/private-face.png'],
        },
      },
    });
    const dependencies = createDependencies();

    const result = await remixShowcasePostForRoute({
      actorUserId: 'someone-else',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result.ok ? result.body.prefill.settings : null).toEqual({ model: 'nano-banana-2' });
  });

  it('keeps input-media settings when the owner remixes their own generation', async () => {
    const settings = {
      model: 'nano-banana-2',
      referenceImageUrls: ['https://cdn.example/private-face.png'],
    };
    const serviceClient = createServiceClientMock({
      generation: {
        ...PUBLIC_CREATOR_GENERATION,
        share_input_media_for_remix: false,
        workflow_settings: settings,
      },
    });
    const dependencies = createDependencies();

    const result = await remixShowcasePostForRoute({
      actorUserId: 'creator-1',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result.ok ? result.body.prefill.settings : null).toEqual(settings);
  });
});

describe('remixShowcasePostForRoute access gate', () => {
  // Audit A1, counterexample 1: the post surface reported `unlock_required`
  // while this endpoint still returned the original prompt.
  it('refuses the original recipe while the post says remixing needs an unlock', async () => {
    const serviceClient = createServiceClientMock({ bundle: REMIX_RECIPE_BUNDLE });
    expect(resolvePostRemixCapability({
      generationId: 'gen-1',
      postFormat: 'media',
      category: 'image',
      sourceKind: 'magicbooklet',
      resourceBundle: { viewerCanAccess: false, allowRemix: true, items: [] },
    }).capability).toBe('unlock_required');

    const result = await remixShowcasePostForRoute({
      actorUserId: 'someone-else',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      dependencies: createDependencies(),
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      body: { error: 'Unlock this post to remix it.', code: 'REMIX_UNLOCK_REQUIRED' },
    });
    expect(JSON.stringify(result)).not.toContain(PUBLIC_CREATOR_GENERATION.prompt);
  });

  it('opens a remix-enabled recipe for the viewer who bought it', async () => {
    const serviceClient = createServiceClientMock({
      bundle: REMIX_RECIPE_BUNDLE,
      purchases: [{ id: 'purchase-1', bundle_id: 'bundle-1', buyer_user_id: 'someone-else' }],
    });

    const result = await remixShowcasePostForRoute({
      actorUserId: 'someone-else',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      dependencies: createDependencies(),
    });

    expect(result.ok ? result.body.prefill.prompt : null).toBe(PUBLIC_CREATOR_GENERATION.prompt);
  });

  it('lets the creator remix their own remix-enabled recipe without buying it', async () => {
    const serviceClient = createServiceClientMock({ bundle: REMIX_RECIPE_BUNDLE });

    const result = await remixShowcasePostForRoute({
      actorUserId: 'creator-1',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      dependencies: createDependencies(),
    });

    expect(result.ok).toBe(true);
  });

  // Audit A4: the generation's own public flag is a copy of the post's state,
  // so a generation still marked public must not outlive its post's exposure.
  it.each([
    ['made private', { visibility: 'private' }],
    ['archived', { archived_at: '2026-09-15T10:00:00.000Z' }],
    ['hidden by moderation', { review_status: 'hidden' }],
  ])('refuses a still-public generation once its post is %s', async (_label, postOverrides) => {
    const serviceClient = createServiceClientMock({
      post: { ...EXPOSED_POST_ROW, ...postOverrides },
    });

    const result = await remixShowcasePostForRoute({
      actorUserId: 'someone-else',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      dependencies: createDependencies(),
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Linked generation not found' },
    });
  });

  it('fails closed when the recipe unlock cannot be read', async () => {
    const failure = { code: '57014', message: 'canceling statement due to statement timeout' };
    const serviceClient = createServiceClientMock({ bundleError: failure });

    await expect(remixShowcasePostForRoute({
      actorUserId: 'someone-else',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      dependencies: createDependencies(),
    })).rejects.toBe(failure);
  });

  it('treats a private guest creation linked to the viewer as the viewer’s own', async () => {
    const settings = {
      model: 'nano-banana-2',
      referenceImageUrls: ['https://cdn.example/guest-face.png'],
    };
    const serviceClient = createServiceClientMock({
      generation: {
        ...PUBLIC_CREATOR_GENERATION,
        user_id: 'guest-1',
        is_public: false,
        share_input_media_for_remix: false,
        workflow_settings: settings,
      },
      profiles: [{ id: 'guest-1', merged_into_user_id: 'user-1' }],
    });

    const result = await remixShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      dependencies: createDependencies(),
    });

    expect(result.ok ? result.body.prefill.settings : null).toEqual(settings);
  });
});
