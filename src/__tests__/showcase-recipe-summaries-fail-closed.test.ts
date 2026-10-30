import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { ShowcaseFeedItem } from '@/lib/showcase';
import { createStoredRows, databaseError } from './fixtures/stored-rows';

// Every surface below hydrates posts through the feed's
// `resolvePostRowsToFeedItems`, which learns which posts carry a published
// recipe from one database call. A recipe's prompt is what it sells, and a post
// can still store one in `posts.prompt` (written before the recipe was added).
// So when that call fails, each post with a published recipe is served as a
// locked recipe (no prompt, Remix only after an unlock) and every other post as
// it always is; when not even that can be read, nothing is served. The web
// post page reads its recipe on its own (post-resource-bundles-server tests),
// and the server's remix check stands on its own; neither is exercised here.

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  client: null as unknown as SupabaseClient,
  userClient: null as unknown as SupabaseClient,
  tables: {} as Record<string, unknown>,
  summariesFail: false,
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => state.client,
  resolveOwnedStoredMediaUrl: async (_client: unknown, path: string) => `https://media.example.com/${path}`,
  resolveStoredMediaUrl: async (_client: unknown, path: string) => `https://media.example.com/${path}`,
}));

// What an unlock adds from a creation's inputs (#587) is counted by a read of
// its own, which has nothing to do with whether the recipe could be read.
vi.mock('@/lib/post-resource-bundles-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/post-resource-bundles-server')>()),
  countGenerationRecipeReferenceItemsByPostId: vi.fn(async () => new Map()),
}));

const CREATOR = 'creator-1';
const SAVER = 'saver-1';
const POST_IDS = ['post-paid', 'post-open', 'post-draft'];
const STORED_PROMPT = 'SECRET_STORED_PROMPT';
// The setup text an older composer wrote into a paid recipe post's body.
const STORED_SETUP = 'Saved generation setup\nSECRET_STORED_SETUP';
const OPEN_PROMPT = 'A prompt its creator shows everyone';

function post(id: string, prompt: string, createdAt: string, body: string | null = null): Row {
  return {
    id,
    user_id: CREATOR,
    generation_id: `gen-${id}`,
    output_url: `generated_images/${CREATOR}/${id}.jpg`,
    showcase_asset_path: null,
    prompt,
    title: `Portrait ${id}`,
    description: null,
    body,
    category: 'image',
    creation_mode: null,
    post_format: 'media',
    save_count: 0,
    remix_count: 0,
    comment_count: 0,
    created_at: createdAt,
    source_kind: 'magicbooklet',
    source_tool: null,
    source_tool_slug: null,
    review_status: 'visible',
    visibility: 'public',
    archived_at: null,
    is_nsfw: false,
  };
}

function bundle(postId: string, status: 'published' | 'draft'): Row {
  return {
    id: `bundle-${postId}`,
    post_id: postId,
    title: 'Golden hour portrait recipe',
    access_mode: 'paid',
    price_usd_cents: 1900,
    preview_text: 'Unlock the prompt.',
    prompt_text: null,
    notes_markdown: null,
    workflow_share_url: null,
    workflow_snapshot: null,
    attachments: [],
    allow_remix: true,
    resource_sections: [],
    resource_items: [{ id: 'item-prompt', type: 'prompt', title: 'Prompt', textContent: STORED_PROMPT }],
    sales_count: 0,
    free_unlock_count: 0,
    status,
  };
}

/** The summaries call as the database answers it: a draft's details are masked. */
function summaries(bundles: Row[], args: Row) {
  const postIds = (args.p_post_ids ?? []) as string[];
  return bundles
    .filter((row) => postIds.includes(row.post_id as string))
    .map((row) => (
      row.status === 'published'
        ? { ...row }
        : Object.fromEntries(Object.keys(row).map((column) => [
            column,
            column === 'post_id' || column === 'status' ? row[column] : null,
          ]))
    ));
}

function seed() {
  const bundles = [bundle('post-paid', 'published'), bundle('post-draft', 'draft')];
  const saves = POST_IDS.map((postId, index) => ({
    user_id: SAVER,
    post_id: postId,
    created_at: `2026-10-30T0${index}:00:00.000Z`,
  }));
  state.tables = {
    posts: [
      // Its prompt was stored before the paid recipe that now sells it.
      post('post-paid', STORED_PROMPT, '2026-10-29T10:00:00.000Z', STORED_SETUP),
      post('post-open', OPEN_PROMPT, '2026-10-29T09:00:00.000Z'),
      // A recipe still being written: nothing is for sale yet.
      post('post-draft', OPEN_PROMPT, '2026-10-29T08:00:00.000Z'),
    ],
    profiles: [{
      id: CREATOR,
      username: 'lightsmith',
      display_name: 'Light Smith',
      bio: null,
      avatar_url: null,
      cover_url: null,
      website_url: null,
      twitter_handle: null,
      instagram_handle: null,
      tiktok_handle: null,
      location: null,
      identity_state: 'active',
    }],
    generations: POST_IDS.map((id) => ({
      id: `gen-${id}`,
      user_id: CREATOR,
      model: 'nano-banana-2',
      category: 'image',
      preview_url: null,
      preview_width: null,
      preview_height: null,
      template_run_id: null,
      template_run_step_id: null,
    })),
    post_resource_bundles: bundles,
    post_media: [],
    post_source_tools: [],
    post_saves: saves,
    showcase_saves: [],
    post_resource_bundle_purchases: [],
    user_blocks: [],
  };
  state.client = createStoredRows(state.tables as Parameters<typeof createStoredRows>[0], {
    get_public_post_resource_bundle_summaries: (args) => (
      state.summariesFail
        ? databaseError('XX000', 'temporary database failure')
        : summaries(bundles, args)
    ),
    get_creator_profile_stats: () => null,
  }).client;
  // Saved media reads the saves as the viewer and everything else with the
  // service client; the viewer's client has nothing else to answer with.
  state.userClient = createStoredRows({ post_saves: saves, showcase_saves: [] }).client;
}

/** Each surface that hydrates through `resolvePostRowsToFeedItems`, as it serves posts. */
const SURFACES: Array<[string, () => Promise<ShowcaseFeedItem[]>]> = [
  ['the Recent feed', async () => {
    const { getShowcaseFeedPage } = await import('@/lib/showcase-feed');
    const page = await getShowcaseFeedPage({ category: 'all', sort: 'recent', offset: 0, limit: 24, bypassCache: true });
    return page.items;
  }],
  ['the post read by id (post API)', async () => {
    const { getShowcaseFeedItemById } = await import('@/lib/showcase-feed');
    const items = await Promise.all(POST_IDS.map((postId) => getShowcaseFeedItemById({ postId })));
    return items.filter((item): item is NonNullable<typeof item> => item !== null);
  }],
  ['the reads by ids (search, the home shelf)', async () => {
    const { getShowcaseFeedItemsByPostIds } = await import('@/lib/showcase-feed');
    return getShowcaseFeedItemsByPostIds({ postIds: POST_IDS });
  }],
  ['the creator page', async () => {
    const { getCreatorProfilePageData } = await import('@/lib/creator-profile');
    return (await getCreatorProfilePageData('lightsmith'))?.items ?? [];
  }],
  ['saved media', async () => {
    const { getSavedMediaFeedForRoute } = await import('@/lib/showcase-saved-media-service');
    const result = await getSavedMediaFeedForRoute({
      createAdminSupabase: () => state.client,
      limit: 24,
      offset: 0,
      userId: SAVER,
      userSupabase: state.userClient,
    });
    if (!result.ok) throw new Error(`Expected a saved-media page, got ${result.status}`);
    return result.body.items;
  }],
];

function byId(items: ShowcaseFeedItem[], postId: string) {
  const item = items.find((candidate) => candidate.id === postId);
  if (!item) throw new Error(`${postId} was not served`);
  return item;
}

const LOCKED = { prompt: '', body: '', canRemix: false, remixCapability: 'unlock_required', asset: null };
// No recipe, or one still a draft: the prompt and Remix are everyone's.
const OPEN = { prompt: OPEN_PROMPT, canRemix: true, remixCapability: 'public', asset: null };

describe('recipe summaries that cannot be read', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    state.summariesFail = false;
    seed();
  });

  it.each(SURFACES)('serve a read recipe as before on %s', async (_surface, serve) => {
    const items = await serve();

    expect(JSON.stringify(items)).not.toContain(STORED_PROMPT);
    expect(JSON.stringify(items)).not.toContain('SECRET_STORED_SETUP');
    expect(byId(items, 'post-paid')).toMatchObject({
      ...LOCKED,
      asset: expect.objectContaining({ id: 'bundle-post-paid', accessMode: 'paid' }),
    });
    expect(byId(items, 'post-open')).toMatchObject(OPEN);
    expect(byId(items, 'post-draft')).toMatchObject(OPEN);
  });

  it.each(SURFACES)('lock only the posts with a published recipe on %s', async (_surface, serve) => {
    state.summariesFail = true;

    const items = await serve();

    expect(JSON.stringify(items)).not.toContain(STORED_PROMPT);
    expect(JSON.stringify(items)).not.toContain('SECRET_STORED_SETUP');
    expect(byId(items, 'post-paid')).toMatchObject(LOCKED);
    expect(byId(items, 'post-open')).toMatchObject(OPEN);
    expect(byId(items, 'post-draft')).toMatchObject(OPEN);
  });

  it.each(SURFACES)('serve nothing on %s when not even which recipes are published can be read', async (_surface, serve) => {
    state.summariesFail = true;
    state.tables.post_resource_bundles = databaseError('XX000', 'temporary presence query failure');

    await expect(serve()).rejects.toThrow();
  });

  it('keeps a locked post locked when a hydration cache serves it again, as For you does', async () => {
    state.summariesFail = true;
    const { resolvePostRowsToFeedItems } = await import('@/lib/showcase-feed');
    const { data: rows } = await state.client.from('posts').select('*');
    type PostRows = Parameters<typeof resolvePostRowsToFeedItems>[0];
    const rowsById = new Map(((rows ?? []) as PostRows).map((row) => [row.id, row]));
    const hydrationCache: Parameters<typeof resolvePostRowsToFeedItems>[2] = new Map();

    const first = await resolvePostRowsToFeedItems(
      ['post-paid', 'post-open'].map((id) => rowsById.get(id)!),
      state.client as Parameters<typeof resolvePostRowsToFeedItems>[1],
      hydrationCache,
    );
    const second = await resolvePostRowsToFeedItems(
      ['post-paid', 'post-draft'].map((id) => rowsById.get(id)!),
      state.client as Parameters<typeof resolvePostRowsToFeedItems>[1],
      hydrationCache,
    );

    expect(byId(first, 'post-paid')).toMatchObject(LOCKED);
    expect(byId(second, 'post-paid')).toMatchObject(LOCKED);
    expect(byId(second, 'post-draft')).toMatchObject(OPEN);
  });

  it('lets a creator remix their own post whose recipe could not be read, and no one else', async () => {
    state.summariesFail = true;
    const { getShowcaseFeedItemById } = await import('@/lib/showcase-feed');

    const forCreator = await getShowcaseFeedItemById({ postId: 'post-paid', viewerUserId: CREATOR });
    const forSaver = await getShowcaseFeedItemById({ postId: 'post-paid', viewerUserId: SAVER });

    expect(forCreator).toMatchObject({ prompt: '', canRemix: true, remixCapability: 'public' });
    expect(forSaver).toMatchObject(LOCKED);
  });
});
