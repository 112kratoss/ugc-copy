import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { ShowcaseFeedItem } from '@/lib/showcase';
import { createStoredRows, databaseError } from './fixtures/stored-rows';

// Every surface that serves posts hydrates them through the feed's
// `resolvePostRowsToFeedItems`, which learns which posts carry a published
// recipe from one database call. When that call fails, the posts it was asked
// about cannot be told apart from posts without a recipe. A recipe's prompt is
// what it sells, and a post can still store one in `posts.prompt` (written
// before the recipe was added), so each such post must be served as a locked
// recipe: no prompt, and Remix only after an unlock. The server's remix check
// stands on its own and is not exercised here.

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  client: null as unknown as SupabaseClient,
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
  const { client } = createStoredRows({
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
    generations: ['post-paid', 'post-open', 'post-draft'].map((id) => ({
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
    post_media: [],
    post_source_tools: [],
    post_saves: ['post-paid', 'post-open', 'post-draft'].map((postId, index) => ({
      user_id: SAVER,
      post_id: postId,
      created_at: `2026-10-30T0${index}:00:00.000Z`,
    })),
    showcase_saves: [],
    post_resource_bundle_purchases: [],
    user_blocks: [],
  }, {
    get_public_post_resource_bundle_summaries: (args) => (
      state.summariesFail
        ? databaseError('57014', 'canceling statement due to statement timeout')
        : summaries(bundles, args)
    ),
    get_creator_profile_stats: () => null,
  });
  state.client = client;
}

/** Each surface that hydrates through `resolvePostRowsToFeedItems`, as it serves posts. */
const SURFACES: Array<[string, () => Promise<ShowcaseFeedItem[]>]> = [
  ['the feed', async () => {
    const { getShowcaseFeedPage } = await import('@/lib/showcase-feed');
    const page = await getShowcaseFeedPage({ category: 'all', sort: 'recent', offset: 0, limit: 24, bypassCache: true });
    return page.items;
  }],
  ['the post read by id (post API, NSFW reveal)', async () => {
    const { getShowcaseFeedItemById } = await import('@/lib/showcase-feed');
    const items = await Promise.all(['post-paid', 'post-open', 'post-draft'].map((postId) => getShowcaseFeedItemById({ postId })));
    return items.filter((item): item is NonNullable<typeof item> => item !== null);
  }],
  ['the reads by ids (search, the home shelf)', async () => {
    const { getShowcaseFeedItemsByPostIds } = await import('@/lib/showcase-feed');
    return getShowcaseFeedItemsByPostIds({ postIds: ['post-paid', 'post-open', 'post-draft'] });
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
      userSupabase: state.client,
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

describe('recipe summaries that cannot be read', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    state.summariesFail = false;
    seed();
  });

  it.each(SURFACES)('serve a recipe post\'s stored prompt to no one on %s', async (_surface, serve) => {
    state.summariesFail = true;

    const items = await serve();

    expect(JSON.stringify(items)).not.toContain(STORED_PROMPT);
    expect(JSON.stringify(items)).not.toContain('SECRET_STORED_SETUP');
    expect(byId(items, 'post-paid')).toMatchObject({
      prompt: '',
      body: '',
      canRemix: false,
      remixCapability: 'unlock_required',
    });
  });

  it.each(SURFACES)('serve a read recipe as before on %s', async (_surface, serve) => {
    const items = await serve();

    expect(JSON.stringify(items)).not.toContain(STORED_PROMPT);
    expect(JSON.stringify(items)).not.toContain('SECRET_STORED_SETUP');
    expect(byId(items, 'post-paid')).toMatchObject({
      prompt: '',
      body: '',
      canRemix: false,
      remixCapability: 'unlock_required',
      asset: expect.objectContaining({ id: 'bundle-post-paid', accessMode: 'paid' }),
    });
    // No recipe, or one still a draft: the prompt and Remix are everyone's.
    for (const postId of ['post-open', 'post-draft']) {
      expect(byId(items, postId)).toMatchObject({
        prompt: OPEN_PROMPT,
        canRemix: true,
        remixCapability: 'public',
        asset: null,
      });
    }
  });

  it('locks every post the failed read was asked about, since none of them can be told apart', async () => {
    state.summariesFail = true;
    const { resolvePostRowsToFeedItems } = await import('@/lib/showcase-feed');
    const { data: rows } = await state.client
      .from('posts')
      .select('id, output_url, showcase_asset_path, prompt, title, body, category, creation_mode, post_format, save_count, remix_count, comment_count, created_at, user_id, source_kind, source_tool, source_tool_slug, review_status, generation_id');

    const items = await resolvePostRowsToFeedItems(
      rows as unknown as Parameters<typeof resolvePostRowsToFeedItems>[0],
      state.client as Parameters<typeof resolvePostRowsToFeedItems>[1],
    );

    expect(items.map(({ id, prompt, asset, canRemix, remixCapability }) => ({ id, prompt, asset, canRemix, remixCapability })))
      .toEqual(['post-paid', 'post-open', 'post-draft'].map((id) => ({
        id,
        prompt: '',
        asset: null,
        canRemix: false,
        remixCapability: 'unlock_required',
      })));
  });
});
