import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GenerationModelDescriptor } from '@/lib/generation-model-catalog';
import type { ShowcaseFeedItem, ShowcaseMediaItem } from '@/lib/showcase';

const getShowcaseFeedItemsByPostIdsMock = vi.fn();
const loadReferralProgramTermsMock = vi.fn();
const loadPublishedGenerationModelCatalogMock = vi.fn();
const quotePublishedGenerationModelMock = vi.fn();
const tableResults = new Map<string, unknown>();
const pinsMock = vi.hoisted(() => ({ pins: [] as Array<{ postId: string }>, earn: false }));

vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}));

vi.mock('@/lib/showcase-feed', () => ({
  getShowcaseFeedItemsByPostIds: (options: unknown) => getShowcaseFeedItemsByPostIdsMock(options),
}));

vi.mock('@/lib/referral-route-service', () => ({
  loadReferralProgramTerms: () => loadReferralProgramTermsMock(),
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
      const result = () => tableResults.get(table) ?? { data: null, error: null };
      const builder: Record<string, unknown> = {
        select: () => builder,
        in: () => builder,
        eq: () => builder,
        is: () => builder,
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
    creator: { id: 'user-1', username: 'magicbooklet', name: 'Magicbooklet Team', avatar: null },
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

describe('buildHomeShelfCreationEntries', () => {
  beforeEach(() => {
    vi.resetModules();
    getShowcaseFeedItemsByPostIdsMock.mockReset();
    quotePublishedGenerationModelMock.mockReset();
    loadPublishedGenerationModelCatalogMock.mockReset();
    loadPublishedGenerationModelCatalogMock.mockResolvedValue({ catalog: { models: MODELS } });
    tableResults.clear();
  });

  it('prices each card from the settings its remix opens with', async () => {
    const { buildHomeShelfCreationEntries } = await import('@/lib/home-shelf-server');
    quotePublishedGenerationModelMock.mockResolvedValue({ costCredits: 15 });

    const entries = await buildHomeShelfCreationEntries([{ postId: 'boat' }], {
      getPosts: async () => [post('boat')],
      loadGenerations: async () => [{
        id: 'gen-boat',
        model: 'grok-imagine-video',
        share_input_media_for_remix: false,
        workflow_settings: {
          model: 'grok-imagine-video',
          duration: '6',
          sound: 'false',
          resolution: '480p',
          referenceImageUrls: ['https://cdn.example.test/creator-input.png'],
        },
      }],
      loadWelcomeCredits: async () => 25,
    });

    expect(quotePublishedGenerationModelMock).toHaveBeenCalledWith({
      kind: 'video',
      modelId: 'grok-imagine-video',
      settings: expect.objectContaining({ duration: 6, sound: false, resolution: '480p' }),
    }, { platform: 'web' });
    // The creator's inputs stay theirs unless they shared them for remixing.
    expect(quotePublishedGenerationModelMock.mock.calls[0][0].settings).not.toHaveProperty('referenceImageUrls');
    expect(entries).toHaveLength(1);
    expect(entries[0].creation).toMatchObject({
      id: 'boat',
      modelName: 'Grok Imagine',
      price: { kind: 'credits', credits: 15 },
      fitsWelcomeCredits: true,
    });
    expect(entries[0].post.id).toBe('boat');
  });

  it('names the model the generation stored, under the catalog id the editor uses', async () => {
    const { buildHomeShelfCreationEntries } = await import('@/lib/home-shelf-server');
    quotePublishedGenerationModelMock.mockResolvedValue({ costCredits: 8 });

    const entries = await buildHomeShelfCreationEntries([{ postId: 'still' }], {
      getPosts: async () => [post('still', {
        category: 'image',
        remixTarget: 'image',
        mediaItems: [media({ mediaKind: 'image', feedStreamUrl: null })],
      })],
      // The provider's spelling on the row, the catalog's in the settings.
      loadGenerations: async () => [{
        id: 'gen-still',
        model: 'nano-banana-2/provider',
        share_input_media_for_remix: false,
        workflow_settings: { model: 'nano-banana-2' },
      }],
      loadWelcomeCredits: async () => 25,
    });

    expect(quotePublishedGenerationModelMock.mock.calls[0][0]).toMatchObject({ kind: 'image', modelId: 'nano-banana-2' });
    expect(entries[0].creation.modelName).toBe('Nano Banana 2');
  });

  it('prices motion by clip length without asking the quote', async () => {
    const { buildHomeShelfCreationEntries } = await import('@/lib/home-shelf-server');

    const entries = await buildHomeShelfCreationEntries([{ postId: 'dance' }], {
      getPosts: async () => [post('dance', { category: 'video', creationMode: 'motion', remixTarget: 'motion' })],
      loadGenerations: async () => [{
        id: 'gen-dance',
        model: 'kling-3.0-motion',
        share_input_media_for_remix: false,
        workflow_settings: { model: 'kling-3.0-motion' },
      }],
      loadWelcomeCredits: async () => 25,
    });

    expect(quotePublishedGenerationModelMock).not.toHaveBeenCalled();
    expect(entries[0].creation).toMatchObject({
      tool: 'motion',
      modelName: 'Kling 3.0 Motion',
      price: { kind: 'clip-length' },
      fitsWelcomeCredits: false,
    });
  });

  it('shows no price when the quote refuses, rather than a wrong one', async () => {
    const { buildHomeShelfCreationEntries } = await import('@/lib/home-shelf-server');
    quotePublishedGenerationModelMock.mockRejectedValue(new Error('Some model settings are no longer available.'));

    const entries = await buildHomeShelfCreationEntries([{ postId: 'boat' }], {
      getPosts: async () => [post('boat')],
      loadGenerations: async () => [{
        id: 'gen-boat',
        model: 'grok-imagine-video',
        share_input_media_for_remix: false,
        workflow_settings: { model: 'grok-imagine-video' },
      }],
      loadWelcomeCredits: async () => 25,
    });

    expect(entries[0].creation.price).toBeNull();
    expect(entries[0].creation.fitsWelcomeCredits).toBe(false);
  });

  it('keeps pin order, drops pins that no longer qualify, and reads each post once', async () => {
    const { buildHomeShelfCreationEntries } = await import('@/lib/home-shelf-server');
    quotePublishedGenerationModelMock.mockResolvedValue({ costCredits: 10 });
    const getPosts = vi.fn(async () => [
      post('c'),
      post('a'),
      post('locked', { remixCapability: 'unlock_required' }),
    ]);

    const entries = await buildHomeShelfCreationEntries(
      [{ postId: 'a' }, { postId: 'gone' }, { postId: 'locked' }, { postId: 'c' }, { postId: 'a' }],
      {
        getPosts,
        loadGenerations: async () => [],
        loadWelcomeCredits: async () => null,
      },
    );

    expect(getPosts).toHaveBeenCalledWith(['a', 'gone', 'locked', 'c']);
    expect(entries.map((entry) => entry.creation.id)).toEqual(['a', 'c']);
  });

  it('still builds the shelf when the welcome program cannot be read', async () => {
    const { buildHomeShelfCreationEntries } = await import('@/lib/home-shelf-server');
    quotePublishedGenerationModelMock.mockResolvedValue({ costCredits: 7 });

    const entries = await buildHomeShelfCreationEntries([{ postId: 'boat' }], {
      getPosts: async () => [post('boat')],
      loadGenerations: async () => [{
        id: 'gen-boat',
        model: 'grok-imagine-video',
        share_input_media_for_remix: false,
        workflow_settings: { model: 'grok-imagine-video' },
      }],
      loadWelcomeCredits: async () => { throw new Error('credit_grant_programs is unavailable'); },
    });

    expect(entries[0].creation.price).toEqual({ kind: 'credits', credits: 7 });
    expect(entries[0].creation.fitsWelcomeCredits).toBe(false);
  });
});

describe('loadHomeShelf', () => {
  beforeEach(() => {
    vi.resetModules();
    getShowcaseFeedItemsByPostIdsMock.mockReset();
    quotePublishedGenerationModelMock.mockReset();
    quotePublishedGenerationModelMock.mockResolvedValue({ costCredits: 12 });
    loadPublishedGenerationModelCatalogMock.mockReset();
    loadPublishedGenerationModelCatalogMock.mockResolvedValue({ catalog: { models: MODELS } });
    loadReferralProgramTermsMock.mockReset();
    loadReferralProgramTermsMock.mockResolvedValue({ inviterPercent: 5, inviteeFirstPurchasePercent: 5, attributionWindowDays: 30 });
    tableResults.clear();
    tableResults.set('generations', { data: [], error: null });
    tableResults.set('credit_grant_programs', { data: { amount: 25, enabled: true }, error: null });
    pinsMock.pins = [{ postId: 'a' }, { postId: 'b' }, { postId: 'c' }];
    pinsMock.earn = false;
    getShowcaseFeedItemsByPostIdsMock.mockResolvedValue([post('a'), post('b'), post('c')]);
  });

  it('gives a signed-out viewer the creations and no offers', async () => {
    const { loadHomeShelf } = await import('@/lib/home-shelf-server');

    const items = await loadHomeShelf();

    expect(items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(getShowcaseFeedItemsByPostIdsMock).toHaveBeenCalledWith({ postIds: ['a', 'b', 'c'], viewerUserId: null, countryCode: null });
  });

  it('treats a guest as signed out', async () => {
    const { loadHomeShelf } = await import('@/lib/home-shelf-server');

    const items = await loadHomeShelf({ viewerUserId: 'guest-1', isAnonymous: true });

    expect(items.every((item) => item.kind === 'creation')).toBe(true);
    expect(loadReferralProgramTermsMock).not.toHaveBeenCalled();
  });

  it('asks a member with no posts to post, then to invite', async () => {
    const { loadHomeShelf } = await import('@/lib/home-shelf-server');
    tableResults.set('posts', { count: 0, error: null });

    const items = await loadHomeShelf({ viewerUserId: 'user-2', isAnonymous: false });

    expect(items.map((item) => item.id)).toEqual(['a', 'b', 'post', 'c', 'invite']);
  });

  it('offers a member who has posted only Invite while Earn is switched off', async () => {
    const { loadHomeShelf } = await import('@/lib/home-shelf-server');
    tableResults.set('posts', { count: 3, error: null });

    const items = await loadHomeShelf({ viewerUserId: 'user-2', isAnonymous: false });

    expect(items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'invite']);
  });

  it('keeps the creations when the viewer cannot be read', async () => {
    const { loadHomeShelf } = await import('@/lib/home-shelf-server');
    tableResults.set('posts', { count: null, error: new Error('posts is unavailable') });

    const items = await loadHomeShelf({ viewerUserId: 'user-2', isAnonymous: false });

    expect(items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('renders no shelf when the posts cannot be read', async () => {
    const { loadHomeShelf } = await import('@/lib/home-shelf-server');
    getShowcaseFeedItemsByPostIdsMock.mockRejectedValue(new Error('posts is unavailable'));

    await expect(loadHomeShelf({ viewerUserId: 'user-2', isAnonymous: false })).resolves.toEqual([]);
  });

  it('sends the app each creation with its post', async () => {
    const { loadHomeShelfForApi } = await import('@/lib/home-shelf-server');
    tableResults.set('posts', { count: 0, error: null });

    const items = await loadHomeShelfForApi({ viewerUserId: 'user-2', isAnonymous: false });

    expect(items.map((item) => (item.kind === 'creation' ? item.post.id : item.id))).toEqual(['a', 'b', 'post', 'c', 'invite']);
  });
});
