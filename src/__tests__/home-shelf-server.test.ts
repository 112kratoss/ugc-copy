import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GenerationModelDescriptor } from '@/lib/generation-model-catalog';
import type { ShowcaseFeedItem, ShowcaseMediaItem } from '@/lib/showcase';

const getShowcaseFeedItemsByPostIdsMock = vi.fn();
const loadReferralProgramTermsMock = vi.fn();
const loadPublishedGenerationModelCatalogMock = vi.fn();
const quotePublishedGenerationModelMock = vi.fn();
const loadViewerRelationsMock = vi.fn();
const unstableCacheOptions = vi.hoisted(() => [] as Array<{ tags?: string[] }>);
const tableResults = new Map<string, unknown>();
const tableReads: string[] = [];
const pinsMock = vi.hoisted(() => ({ pins: [] as Array<{ postId: string }>, earn: false }));

vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown, _keys: string[], options: { tags?: string[] }) => {
    unstableCacheOptions.push(options);
    return fn;
  },
}));

vi.mock('@/lib/showcase-feed', () => ({
  getShowcaseFeedItemsByPostIds: (options: unknown) => getShowcaseFeedItemsByPostIdsMock(options),
}));

vi.mock('@/lib/referral-route-service', () => ({
  loadReferralProgramTerms: () => loadReferralProgramTermsMock(),
}));

vi.mock('@/lib/showcase-feed-personalization', () => ({
  loadViewerRelations: (options: unknown) => loadViewerRelationsMock(options),
}));

vi.mock('@/lib/generation-model-catalog-store', () => ({
  loadPublishedGenerationModelCatalog: (options: unknown) => loadPublishedGenerationModelCatalogMock(options),
  quotePublishedGenerationModel: (input: unknown, options: unknown) => quotePublishedGenerationModelMock(input, options),
}));

vi.mock('@/lib/home-shelf-lineup', () => ({
  get HOME_SHELF_PINS() { return pinsMock.pins; },
  get HOME_SHELF_EARN_CARD_ENABLED() { return pinsMock.earn; },
}));

/**
 * A stand-in for the service client: each table answers what the test put in
 * `tableResults`, whatever filters the loader chains onto it.
 */
vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      tableReads.push(table);
      const result = () => tableResults.get(table) ?? { data: null, error: null };
      const builder: Record<string, unknown> = {
        select: () => builder,
        in: () => builder,
        eq: () => builder,
        is: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve(result()),
        then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => (
          Promise.resolve(result()).then(resolve, reject)
        ),
      };
      return builder;
    },
  }),
}));

function media(overrides: Partial<ShowcaseMediaItem> = {}): ShowcaseMediaItem {
  return {
    id: 'media-1',
    url: 'https://cdn.example.test/source.mp4',
    previewUrl: 'https://cdn.example.test/poster.webp',
    feedStreamUrl: 'https://cdn.example.test/stream.mp4',
    mediaKind: 'video',
    contentType: 'video/mp4',
    originalName: null,
    width: 720,
    height: 1280,
    durationSeconds: 6,
    sortOrder: 0,
    ...overrides,
  };
}

function post(id: string, overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id,
    mediaUrl: null,
    mediaKind: 'video',
    mediaItems: [media()],
    model: 'Fallback model name',
    title: `Creation ${id}`,
    prompt: '',
    body: '',
    category: 'video',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-10-25T00:00:00.000Z',
    creator: { id: `creator-${id}`, username: 'magicbooklet', name: 'Magicbooklet Team', avatar: null },
    sourceKind: 'magicbooklet',
    sourceTool: null,
    generationId: `gen-${id}`,
    asset: null,
    canRemix: true,
    remixCapability: 'public',
    remixTarget: 'video',
    ...overrides,
  } as ShowcaseFeedItem;
}

function generation(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `gen-${id}`,
    model: 'grok-imagine-video',
    share_input_media_for_remix: false,
    workflow_settings: { model: 'grok-imagine-video' },
    ...overrides,
  };
}

function descriptor(id: string, kind: 'image' | 'video' | 'motion', displayName: string): GenerationModelDescriptor {
  return {
    id,
    kind,
    displayName,
    controls: [
      { key: 'duration', type: 'integer', label: 'Duration', min: 1, max: 15, step: 1, defaultValue: 5 },
      { key: 'sound', type: 'boolean', label: 'Sound', defaultValue: false },
      { key: 'resolution', type: 'choice', label: 'Resolution', options: [], defaultValue: '480p' },
    ],
  } as unknown as GenerationModelDescriptor;
}

const MODELS = [
  descriptor('grok-imagine-video', 'video', 'Grok Imagine'),
  descriptor('nano-banana-2', 'image', 'Nano Banana 2'),
  descriptor('kling-3.0-motion', 'motion', 'Kling 3.0 Motion'),
];
const BOTH_CATALOGS = async () => ({ web: MODELS, mobile: MODELS });

/** The feed's read of a viewer's relations, as `loadViewerRelations` answers it. */
function relations(overrides: Partial<Record<'blockedCreatorIds' | 'hiddenCreatorIds' | 'hiddenPostIds' | 'reportedPostIds', string[]>> = {}) {
  return {
    viewerUserId: 'user-2',
    followingCreatorIds: new Set<string>(),
    blockedCreatorIds: new Set(overrides.blockedCreatorIds ?? []),
    hiddenCreatorIds: new Set(overrides.hiddenCreatorIds ?? []),
    hiddenPostIds: new Set(overrides.hiddenPostIds ?? []),
    reportedPostIds: new Set(overrides.reportedPostIds ?? []),
  };
}

describe('buildHomeShelfCreations', () => {
  beforeEach(() => {
    vi.resetModules();
    quotePublishedGenerationModelMock.mockReset();
    tableResults.clear();
  });

  it('prices each card from the settings its remix opens with', async () => {
    const { buildHomeShelfCreations } = await import('@/lib/home-shelf-server');
    quotePublishedGenerationModelMock.mockResolvedValue({ costCredits: 15 });

    const creations = await buildHomeShelfCreations([{ postId: 'boat' }], {
      getPosts: async () => [post('boat')],
      loadGenerations: async () => [generation('boat', {
        workflow_settings: {
          model: 'grok-imagine-video',
          duration: 6,
          sound: false,
          resolution: '480p',
          referenceImageUrls: ['https://cdn.example.test/creator-input.png'],
          // Some generations keep a copy under `settings`: one that says the same is no conflict.
          settings: { duration: 6, resolution: '480p' },
        },
      })],
      loadCatalogs: BOTH_CATALOGS,
      loadWelcomeCredits: async () => 25,
    });

    expect(quotePublishedGenerationModelMock).toHaveBeenCalledWith({
      kind: 'video',
      modelId: 'grok-imagine-video',
      settings: expect.objectContaining({ duration: 6, sound: false, resolution: '480p' }),
    }, { platform: 'web' });
    // The creator's inputs stay theirs: the remix opens without them.
    expect(quotePublishedGenerationModelMock.mock.calls[0][0].settings).not.toHaveProperty('referenceImageUrls');
    expect(creations).toHaveLength(1);
    expect(creations[0]).toMatchObject({
      id: 'boat',
      modelName: 'Grok Imagine',
      price: { kind: 'credits', credits: 15 },
      fitsWelcomeCredits: true,
    });
    expect(creations[0].post.id).toBe('boat');
  });

  it('prices motion by clip length without asking the quote', async () => {
    const { buildHomeShelfCreations } = await import('@/lib/home-shelf-server');

    const creations = await buildHomeShelfCreations([{ postId: 'dance' }], {
      getPosts: async () => [post('dance', { category: 'video', creationMode: 'motion', remixTarget: 'motion' })],
      loadGenerations: async () => [generation('dance', { model: 'kling-3.0', workflow_settings: { model: 'kling-3.0-motion' } })],
      loadCatalogs: BOTH_CATALOGS,
      loadWelcomeCredits: async () => 25,
    });

    expect(quotePublishedGenerationModelMock).not.toHaveBeenCalled();
    expect(creations[0]).toMatchObject({
      tool: 'motion',
      modelName: 'Kling 3.0 Motion',
      price: { kind: 'clip-length' },
      fitsWelcomeCredits: false,
      makeHref: '/create-motion?remix=gen-dance&remixPost=dance',
    });
  });

  it.each([
    ['a number stored as text, which the app opens at the default', { duration: '10' }],
    ['a boolean stored as text, which the web would send on as text', { sound: 'true' }],
    ['a copy under settings that says otherwise, which the app reads first', { duration: 6, settings: { duration: 10 } }],
    ['a value only under settings, which the web never reads', { settings: { duration: 10 } }],
  ])('shows no price for %s', async (_case, values) => {
    const { buildHomeShelfCreations } = await import('@/lib/home-shelf-server');
    quotePublishedGenerationModelMock.mockResolvedValue({ costCredits: 15 });

    const creations = await buildHomeShelfCreations([{ postId: 'boat' }], {
      getPosts: async () => [post('boat')],
      loadGenerations: async () => [generation('boat', {
        workflow_settings: { model: 'grok-imagine-video', ...values },
      })],
      loadCatalogs: BOTH_CATALOGS,
      loadWelcomeCredits: async () => 25,
    });

    expect(quotePublishedGenerationModelMock).not.toHaveBeenCalled();
    expect(creations[0]).toMatchObject({ modelName: 'Grok Imagine', price: null, fitsWelcomeCredits: false });
  });

  it('shows no price when the creator shared their inputs, which the editor prices', async () => {
    const { buildHomeShelfCreations } = await import('@/lib/home-shelf-server');
    quotePublishedGenerationModelMock.mockResolvedValue({ costCredits: 7 });

    const creations = await buildHomeShelfCreations([{ postId: 'boat' }], {
      getPosts: async () => [post('boat')],
      loadGenerations: async () => [generation('boat', { share_input_media_for_remix: true })],
      loadCatalogs: BOTH_CATALOGS,
      loadWelcomeCredits: async () => 25,
    });

    expect(quotePublishedGenerationModelMock).not.toHaveBeenCalled();
    expect(creations[0]).toMatchObject({ price: null, fitsWelcomeCredits: false });
  });

  // A recipe whose remix switch is on hands the creation's inputs to whoever unlocks it
  // (`loadGenerationRecipeRemixInputMediaByPostId`), and a free recipe is unlocked by the Remix
  // tap itself: the editor opens with them and prices them, so the card shows none (PR 3b,
  // where publishing from the creators shares the recipe by default).
  it.each([
    ['a free recipe', 'free'],
    ['a paid recipe', 'paid'],
  ] as const)('shows no price when %s hands the creation’s inputs to remixers', async (_case, accessMode) => {
    const { buildHomeShelfCreations } = await import('@/lib/home-shelf-server');
    quotePublishedGenerationModelMock.mockResolvedValue({ costCredits: 7 });
    const asset = { id: 'bundle-boat', postId: 'boat', title: 'Recipe', accessMode, priceUsdCents: accessMode === 'paid' ? 900 : 0, previewText: '', allowRemix: true };

    const creations = await buildHomeShelfCreations([{ postId: 'boat' }], {
      getPosts: async () => [post('boat', { asset } as Partial<ShowcaseFeedItem>)],
      loadGenerations: async () => [generation('boat')],
      loadCatalogs: BOTH_CATALOGS,
      loadWelcomeCredits: async () => 25,
    });

    expect(quotePublishedGenerationModelMock).not.toHaveBeenCalled();
    expect(creations[0]).toMatchObject({ price: null, fitsWelcomeCredits: false });
  });

  it('still prices a post whose recipe keeps the creation’s inputs to itself', async () => {
    const { buildHomeShelfCreations } = await import('@/lib/home-shelf-server');
    quotePublishedGenerationModelMock.mockResolvedValue({ costCredits: 7 });
    const asset = { id: 'bundle-boat', postId: 'boat', title: 'Recipe', accessMode: 'free', priceUsdCents: 0, previewText: '', allowRemix: false };

    const creations = await buildHomeShelfCreations([{ postId: 'boat' }], {
      getPosts: async () => [post('boat', { asset } as Partial<ShowcaseFeedItem>)],
      loadGenerations: async () => [generation('boat')],
      loadCatalogs: BOTH_CATALOGS,
      loadWelcomeCredits: async () => 25,
    });

    expect(creations[0]).toMatchObject({ price: { kind: 'credits', credits: 7 } });
  });

  it('leaves out a post with no saved recipe, whose editor would open on its default model', async () => {
    const { buildHomeShelfCreations } = await import('@/lib/home-shelf-server');

    const creations = await buildHomeShelfCreations([{ postId: 'template' }], {
      getPosts: async () => [post('template')],
      // Template outputs are saved with empty settings; the row's model column is the provider's.
      loadGenerations: async () => [generation('template', { model: 'seedance-2-fast', workflow_settings: {} })],
      loadCatalogs: BOTH_CATALOGS,
      loadWelcomeCredits: async () => 25,
    });

    expect(creations).toEqual([]);
  });

  it('leaves out a model either client cannot run', async () => {
    const { buildHomeShelfCreations } = await import('@/lib/home-shelf-server');
    quotePublishedGenerationModelMock.mockResolvedValue({ costCredits: 10 });
    const loadGenerations = async () => [generation('boat')];

    const webOnly = await buildHomeShelfCreations([{ postId: 'boat' }], {
      getPosts: async () => [post('boat')],
      loadGenerations,
      loadCatalogs: async () => ({ web: MODELS, mobile: MODELS.filter((model) => model.id !== 'grok-imagine-video') }),
      loadWelcomeCredits: async () => 25,
    });
    const retired = await buildHomeShelfCreations([{ postId: 'boat' }], {
      getPosts: async () => [post('boat')],
      loadGenerations,
      loadCatalogs: async () => ({ web: [], mobile: [] }),
      loadWelcomeCredits: async () => 25,
    });

    expect(webOnly).toEqual([]);
    expect(retired).toEqual([]);
  });

  it('shows no price when the quote refuses, rather than a wrong one', async () => {
    const { buildHomeShelfCreations } = await import('@/lib/home-shelf-server');
    quotePublishedGenerationModelMock.mockRejectedValue(new Error('Some model settings are no longer available.'));

    const creations = await buildHomeShelfCreations([{ postId: 'boat' }], {
      getPosts: async () => [post('boat')],
      loadGenerations: async () => [generation('boat')],
      loadCatalogs: BOTH_CATALOGS,
      loadWelcomeCredits: async () => 25,
    });

    expect(creations[0].price).toBeNull();
    expect(creations[0].fitsWelcomeCredits).toBe(false);
  });

  it('keeps pin order, drops pins that no longer qualify, and reads each post once', async () => {
    const { buildHomeShelfCreations } = await import('@/lib/home-shelf-server');
    quotePublishedGenerationModelMock.mockResolvedValue({ costCredits: 10 });
    const getPosts = vi.fn(async () => [
      post('c'),
      post('a'),
      post('locked', { remixCapability: 'unlock_required' }),
    ]);

    const creations = await buildHomeShelfCreations(
      [{ postId: 'a' }, { postId: 'gone' }, { postId: 'locked' }, { postId: 'c' }, { postId: 'a' }],
      {
        getPosts,
        loadGenerations: async () => [generation('a'), generation('c'), generation('locked')],
        loadCatalogs: BOTH_CATALOGS,
        loadWelcomeCredits: async () => null,
      },
    );

    expect(getPosts).toHaveBeenCalledWith(['a', 'gone', 'locked', 'c']);
    expect(creations.map((creation) => creation.id)).toEqual(['a', 'c']);
  });

  it('still builds the shelf when the welcome program cannot be read', async () => {
    const { buildHomeShelfCreations } = await import('@/lib/home-shelf-server');
    quotePublishedGenerationModelMock.mockResolvedValue({ costCredits: 7 });

    const creations = await buildHomeShelfCreations([{ postId: 'boat' }], {
      getPosts: async () => [post('boat')],
      loadGenerations: async () => [generation('boat')],
      loadCatalogs: BOTH_CATALOGS,
      loadWelcomeCredits: async () => { throw new Error('credit_grant_programs is unavailable'); },
    });

    expect(creations[0].price).toEqual({ kind: 'credits', credits: 7 });
    expect(creations[0].fitsWelcomeCredits).toBe(false);
  });
});

describe('loadHomeShelf', () => {
  beforeEach(() => {
    vi.resetModules();
    unstableCacheOptions.length = 0;
    getShowcaseFeedItemsByPostIdsMock.mockReset();
    quotePublishedGenerationModelMock.mockReset();
    quotePublishedGenerationModelMock.mockResolvedValue({ costCredits: 12 });
    loadPublishedGenerationModelCatalogMock.mockReset();
    loadPublishedGenerationModelCatalogMock.mockResolvedValue({ catalog: { models: MODELS } });
    loadReferralProgramTermsMock.mockReset();
    loadReferralProgramTermsMock.mockResolvedValue({ inviterPercent: 5, inviteeFirstPurchasePercent: 5, attributionWindowDays: 30 });
    loadViewerRelationsMock.mockReset();
    loadViewerRelationsMock.mockResolvedValue(relations());
    tableResults.clear();
    tableReads.length = 0;
    tableResults.set('generations', { data: [generation('a'), generation('b'), generation('c')], error: null });
    tableResults.set('credit_grant_programs', { data: { amount: 25, enabled: true }, error: null });
    pinsMock.pins = [{ postId: 'a' }, { postId: 'b' }, { postId: 'c' }];
    pinsMock.earn = false;
    getShowcaseFeedItemsByPostIdsMock.mockResolvedValue([post('a'), post('b'), post('c')]);
  });

  it('gives a signed-out viewer the creations and no offers, with no full posts', async () => {
    const { loadHomeShelf } = await import('@/lib/home-shelf-server');

    const items = await loadHomeShelf();

    expect(items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(items.every((item) => !('post' in item))).toBe(true);
    expect(getShowcaseFeedItemsByPostIdsMock).toHaveBeenCalledWith({ postIds: ['a', 'b', 'c'], viewerUserId: null, countryCode: null });
    expect(loadViewerRelationsMock).not.toHaveBeenCalled();
  });

  it("drops a take-down with the feed's own cache tag", async () => {
    await import('@/lib/home-shelf-server');

    expect(unstableCacheOptions[0]?.tags).toEqual(expect.arrayContaining(['showcase-feed:v3']));
  });

  it('treats a guest as signed out for offers, but still keeps its blocks and feed choices', async () => {
    const { loadHomeShelf } = await import('@/lib/home-shelf-server');

    const items = await loadHomeShelf({ viewerUserId: 'guest-1', isAnonymous: true });

    expect(items.every((item) => item.kind === 'creation')).toBe(true);
    expect(loadReferralProgramTermsMock).not.toHaveBeenCalled();
    expect(loadViewerRelationsMock).toHaveBeenCalledWith(expect.objectContaining({ viewerUserId: 'guest-1' }));
  });

  // The creators' "Start from a post" (owner, 2026-10-28): the creations a member's shelf holds,
  // filtered for them as Home's is, with none of the offers, which the canvas never draws.
  it('gives the creators a member\'s creations with their posts, and reads no offers for them', async () => {
    const { loadHomeShelfCreationsWithPosts } = await import('@/lib/home-shelf-server');
    loadViewerRelationsMock.mockResolvedValue(relations({ hiddenPostIds: ['b'] }));
    pinsMock.pins = [{ postId: 'a' }, { postId: 'b' }, { postId: 'c' }, { postId: 'd' }];
    getShowcaseFeedItemsByPostIdsMock.mockResolvedValue([post('a'), post('b'), post('c'), post('d')]);
    tableResults.set('generations', { data: [generation('a'), generation('b'), generation('c'), generation('d')], error: null });

    const creations = await loadHomeShelfCreationsWithPosts({ viewerUserId: 'user-2', isAnonymous: false });

    expect(creations.map((creation) => creation.id)).toEqual(['a', 'c', 'd']);
    expect(creations.every((creation) => creation.kind === 'creation' && creation.post.id === creation.id)).toBe(true);
    expect(loadReferralProgramTermsMock).not.toHaveBeenCalled();
    expect(tableReads).not.toContain('posts');
  });

  it('asks a member with no public post to post, then to invite', async () => {
    const { loadHomeShelf } = await import('@/lib/home-shelf-server');
    tableResults.set('posts', { data: [], error: null });

    const items = await loadHomeShelf({ viewerUserId: 'user-2', isAnonymous: false });

    expect(items.map((item) => item.id)).toEqual(['a', 'b', 'post', 'c', 'invite']);
  });

  it('offers a member who has posted only Invite while Earn is switched off', async () => {
    const { loadHomeShelf } = await import('@/lib/home-shelf-server');
    tableResults.set('posts', { data: [{ id: 'their-post' }], error: null });

    const items = await loadHomeShelf({ viewerUserId: 'user-2', isAnonymous: false });

    expect(items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'invite']);
  });

  it('keeps the creations when the offers cannot be read', async () => {
    const { loadHomeShelf } = await import('@/lib/home-shelf-server');
    tableResults.set('posts', { data: null, error: new Error('posts is unavailable') });

    const items = await loadHomeShelf({ viewerUserId: 'user-2', isAnonymous: false });

    expect(items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it("leaves out a creator the member blocked, and shows no shelf it would leave too short", async () => {
    const { loadHomeShelf } = await import('@/lib/home-shelf-server');
    tableResults.set('posts', { data: [], error: null });
    loadViewerRelationsMock.mockResolvedValue(relations({ blockedCreatorIds: ['creator-b'] }));

    const items = await loadHomeShelf({ viewerUserId: 'user-2', isAnonymous: false });

    expect(items).toEqual([]);
  });

  it('leaves out what the feed leaves out for the viewer, then fills the row from the pins after the sixth', async () => {
    const { loadHomeShelf } = await import('@/lib/home-shelf-server');
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    pinsMock.pins = ids.map((postId) => ({ postId }));
    getShowcaseFeedItemsByPostIdsMock.mockResolvedValue(ids.map((id) => post(id)));
    tableResults.set('generations', { data: ids.map((id) => generation(id)), error: null });
    tableResults.set('posts', { data: [{ id: 'their-post' }], error: null });
    loadViewerRelationsMock.mockResolvedValue(relations({
      blockedCreatorIds: ['creator-a'],
      hiddenCreatorIds: ['creator-b'],
      hiddenPostIds: ['c'],
      reportedPostIds: ['d'],
    }));

    const items = await loadHomeShelf({ viewerUserId: 'user-2', isAnonymous: false });

    expect(loadViewerRelationsMock).toHaveBeenCalledWith(expect.objectContaining({
      viewerUserId: 'user-2',
      items: expect.arrayContaining([expect.objectContaining({ id: 'g' })]),
    }));
    expect(items.map((item) => item.id)).toEqual(['e', 'f', 'g', 'invite']);
  });

  it('shows nothing when the viewer cannot be checked, as the feed does', async () => {
    const { loadHomeShelf } = await import('@/lib/home-shelf-server');
    tableResults.set('posts', { data: [], error: null });
    loadViewerRelationsMock.mockResolvedValue(null);

    await expect(loadHomeShelf({ viewerUserId: 'user-2', isAnonymous: false })).resolves.toEqual([]);
  });

  it("fails the app's read instead of answering an empty shelf the edge and the app would keep", async () => {
    const { HomeShelfUnavailableError, loadHomeShelfForApi } = await import('@/lib/home-shelf-server');
    tableResults.set('posts', { data: [], error: null });
    loadViewerRelationsMock.mockResolvedValue(null);

    await expect(loadHomeShelfForApi({ viewerUserId: 'user-2', isAnonymous: false }))
      .rejects.toBeInstanceOf(HomeShelfUnavailableError);

    getShowcaseFeedItemsByPostIdsMock.mockRejectedValue(new Error('posts is unavailable'));
    await expect(loadHomeShelfForApi({ viewerUserId: null, isAnonymous: false }))
      .rejects.toBeInstanceOf(HomeShelfUnavailableError);
  });

  it("reads no member's offers when there is no shelf to put them in", async () => {
    const { loadHomeShelf } = await import('@/lib/home-shelf-server');
    getShowcaseFeedItemsByPostIdsMock.mockResolvedValue([post('a'), post('b')]);

    const items = await loadHomeShelf({ viewerUserId: 'user-2', isAnonymous: false });

    expect(items).toEqual([]);
    expect(tableReads).not.toContain('posts');
    expect(loadReferralProgramTermsMock).not.toHaveBeenCalled();
    expect(loadViewerRelationsMock).not.toHaveBeenCalled();
  });

  it('renders no shelf when the posts cannot be read', async () => {
    const { loadHomeShelf } = await import('@/lib/home-shelf-server');
    getShowcaseFeedItemsByPostIdsMock.mockRejectedValue(new Error('posts is unavailable'));

    await expect(loadHomeShelf({ viewerUserId: 'user-2', isAnonymous: false })).resolves.toEqual([]);
  });

  it('sends the app each creation with its post', async () => {
    const { loadHomeShelfForApi } = await import('@/lib/home-shelf-server');
    tableResults.set('posts', { data: [], error: null });

    const items = await loadHomeShelfForApi({ viewerUserId: 'user-2', isAnonymous: false });

    expect(items.map((item) => (item.kind === 'creation' ? item.post.id : item.id))).toEqual(['a', 'b', 'post', 'c', 'invite']);
  });
});
