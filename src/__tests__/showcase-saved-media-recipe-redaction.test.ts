import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { ShowcaseFeedPage } from '@/lib/showcase';

// Saved media hydrates posts through the feed's own `resolvePostRowsToFeedItems`.
// These cases run the real hydration and the real feed read against one
// in-memory database: what a viewer saved is compared with what the feed hands
// the same viewer, and checked whole for anything a locked recipe holds. That
// saved media sanitizes on its own, whatever hydration builds, is pinned in
// showcase-saved-media-service.test.ts.

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));

// What an unlock adds from a creation's saved inputs (#587) is counted by one
// read the feed makes for every page it serves. Both reads here get the same
// answer, so a read that skips the count step shows up as a difference.
vi.mock('@/lib/post-resource-bundles-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/post-resource-bundles-server')>()),
  countGenerationRecipeReferenceItemsByPostId: vi.fn(async ({ postIds }: { postIds: readonly string[] }) => (
    new Map(postIds.filter((postId) => postId === 'post-paid').map((postId) => [postId, { reference_image: 2 }]))
  )),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => createFakeSupabase(),
  resolveOwnedStoredMediaUrl: async (_client: unknown, outputUrl: string) => `https://proxy.example.com/${outputUrl}`,
  resolveStoredMediaUrl: async (_client: unknown, outputUrl: string) => `https://proxy.example.com/${outputUrl}`,
}));

function createFakeSupabase(): SupabaseClient {
  return {
    async rpc(name: string, args?: { p_post_ids?: string[] }) {
      if (name === 'get_public_post_resource_bundle_summaries') {
        return {
          data: db.tables.post_resource_bundles.filter((row) => args?.p_post_ids?.includes(row.post_id as string)),
          error: null,
        };
      }
      return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name} in the schema cache` } };
    },
    from(table: string) {
      const rows = db.tables[table];
      if (!rows) throw new Error(`Unexpected table access: ${table}`);
      const predicates: Array<(row: Row) => boolean> = [];
      const sorts: Array<{ column: string; ascending: boolean }> = [];
      let countOnly = false;
      // A read answers with the columns it asked for, as PostgREST does, so the
      // two reads compared below differ wherever their selects do.
      let columns: string[] | null = null;
      let window: [number, number] | null = null;
      const run = () => {
        const matched = rows
          .filter((row) => predicates.every((matches) => matches(row)))
          .sort((left, right) => {
            for (const { column, ascending } of sorts) {
              const order = String(left[column]).localeCompare(String(right[column]));
              if (order !== 0) return ascending ? order : -order;
            }
            return 0;
          });
        if (countOnly) return { data: null, count: matched.length, error: null };
        const page = window ? matched.slice(window[0], window[1] + 1) : matched;
        return {
          data: columns
            ? page.map((row) => Object.fromEntries(columns!.map((column) => [column, row[column] ?? null])))
            : page,
          error: null,
        };
      };
      const query = {
        select(selected?: string, options?: { head?: boolean }) {
          countOnly = options?.head === true;
          columns = selected && selected.trim() !== '*'
            ? selected.split(',').map((column) => column.trim())
            : null;
          return query;
        },
        eq(column: string, value: unknown) {
          predicates.push((row) => row[column] === value);
          return query;
        },
        in(column: string, values: unknown[]) {
          predicates.push((row) => values.includes(row[column]));
          return query;
        },
        is(column: string, value: unknown) {
          predicates.push((row) => (row[column] ?? null) === value);
          return query;
        },
        order(column: string, options?: { ascending?: boolean }) {
          sorts.push({ column, ascending: options?.ascending !== false });
          return query;
        },
        range(from: number, to: number) {
          window = [from, to];
          return Promise.resolve(run());
        },
        then(resolve: (value: ReturnType<typeof run>) => unknown, reject?: (reason: unknown) => unknown) {
          return Promise.resolve(run()).then(resolve, reject);
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
}

const SAVER = 'saver-1';
const CREATOR = 'creator-1';
const BUYER = 'buyer-1';
const CLAIMER = 'claimer-1';

const SAVED_AT: Record<string, string> = {
  'post-paid': '2026-10-29T10:00:00.000Z',
  'post-free': '2026-10-29T09:00:00.000Z',
};

// What each creator keeps behind the unlock: none of it may reach a viewer
// who has not unlocked the recipe, on any surface.
const LOCKED_RECIPE_TEXT = [
  'SECRET_PAID_PROMPT',
  'SECRET_FREE_PROMPT',
  'Golden hour portrait prompt',
  'Hero reference still',
  'Lighting setup',
  'Two softboxes at forty-five degrees',
  'lighting-diagram.pdf',
  'creator-1/files/',
  'creator-1/references/hero.png',
  'application/pdf',
  'image/png',
  'Retouch checklist',
  'Skin pass notes',
  '48213',
  '7340032',
];

function createPost(id: string, generationId: string, prompt: string, overrides: Row = {}): Row {
  return {
    id,
    user_id: CREATOR,
    generation_id: generationId,
    output_url: `generated_images/${CREATOR}/${id}.jpg`,
    showcase_asset_path: null,
    prompt,
    title: `Portrait ${id}`,
    body: '',
    category: 'image',
    creation_mode: null,
    post_format: 'media',
    save_count: 4,
    remix_count: 1,
    comment_count: 5,
    created_at: '2026-10-28T08:00:00.000Z',
    source_kind: 'magicbooklet',
    source_tool: null,
    source_tool_slug: null,
    review_status: 'visible',
    visibility: 'public',
    archived_at: null,
    ...overrides,
  };
}

function seedDatabase() {
  db.tables = {
    posts: [
      createPost('post-paid', 'gen-paid', 'SECRET_PAID_PROMPT'),
      // A motion run is stored as a video with its own creation mode.
      createPost('post-free', 'gen-free', 'SECRET_FREE_PROMPT', {
        category: 'video',
        creation_mode: 'motion',
        comment_count: 3,
      }),
    ],
    profiles: [{ id: CREATOR, username: 'lightsmith', display_name: 'Light Smith', avatar_url: null }],
    post_media: [],
    post_source_tools: [],
    generations: ['gen-paid', 'gen-free'].map((id) => ({
      id,
      user_id: CREATOR,
      model: 'nano-banana-2',
      category: id === 'gen-free' ? 'video' : 'image',
      preview_url: null,
      preview_width: null,
      preview_height: null,
      template_run_id: null,
      template_run_step_id: null,
    })),
    post_resource_bundles: [
      {
        id: 'bundle-paid',
        post_id: 'post-paid',
        title: 'Golden hour portrait recipe',
        access_mode: 'paid',
        price_usd_cents: 1900,
        preview_text: 'Unlock the lighting setup.',
        prompt_text: null,
        notes_markdown: null,
        workflow_share_url: null,
        workflow_snapshot: null,
        attachments: [{
          label: 'lighting-diagram.pdf',
          kind: 'file',
          storagePath: `${CREATOR}/files/lighting-diagram.pdf`,
          contentType: 'application/pdf',
          sizeBytes: 7340032,
        }],
        allow_remix: true,
        resource_sections: [{
          id: 'lighting',
          title: 'Lighting setup',
          kind: 'workflow_step',
          description: 'Two softboxes at forty-five degrees',
        }],
        resource_items: [
          {
            id: 'item-prompt',
            type: 'prompt',
            title: 'Golden hour portrait prompt',
            textContent: 'SECRET_PAID_PROMPT',
            sectionId: 'lighting',
          },
          {
            id: 'item-reference',
            type: 'reference_image',
            title: 'Hero reference still',
            storagePath: `${CREATOR}/references/hero.png`,
            contentType: 'image/png',
            sizeBytes: 48213,
            sectionId: 'lighting',
            remixUse: 'reference_only',
          },
        ],
        sales_count: 1,
        free_unlock_count: 0,
        status: 'published',
      },
      {
        id: 'bundle-free',
        post_id: 'post-free',
        title: 'Retouch recipe',
        access_mode: 'free',
        price_usd_cents: 0,
        preview_text: 'Claim the retouch steps.',
        prompt_text: null,
        notes_markdown: null,
        workflow_share_url: null,
        workflow_snapshot: null,
        attachments: [],
        // The summaries RPC answers true for any recipe on a creation.
        allow_remix: true,
        resource_sections: [],
        resource_items: [{
          id: 'item-note',
          type: 'note',
          title: 'Retouch checklist',
          textContent: 'Skin pass notes',
        }],
        sales_count: 0,
        free_unlock_count: 1,
        status: 'published',
      },
    ],
    post_resource_bundle_purchases: [
      { bundle_id: 'bundle-paid', buyer_user_id: BUYER },
      { bundle_id: 'bundle-free', buyer_user_id: CLAIMER },
    ],
    post_saves: [SAVER, CREATOR, BUYER, CLAIMER].flatMap((userId) => (
      Object.entries(SAVED_AT).map(([postId, savedAt]) => ({ user_id: userId, post_id: postId, created_at: savedAt }))
    )),
    showcase_saves: [],
    user_blocks: [],
  };
}

async function savedMediaFor(userId: string): Promise<ShowcaseFeedPage> {
  const { getSavedMediaFeedForRoute } = await import('@/lib/showcase-saved-media-service');
  const client = createFakeSupabase();
  const result = await getSavedMediaFeedForRoute({
    createAdminSupabase: () => client,
    countryCode: 'IN',
    limit: 24,
    offset: 0,
    userId,
    userSupabase: client,
  });
  if (!result.ok) throw new Error(`Expected a saved-media page, got ${result.status}`);
  return result.body;
}

async function feedItemsFor(viewerUserId: string) {
  const { getShowcaseFeedItemsByPostIds } = await import('@/lib/showcase-feed');
  return getShowcaseFeedItemsByPostIds({ postIds: ['post-paid', 'post-free'], viewerUserId, countryCode: 'IN' });
}

describe('saved media serves a recipe the way the feed does', () => {
  beforeEach(() => {
    seedDatabase();
    // The INR price quote reads the day's rate.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ result: 'success', base_code: 'INR', rates: { INR: 1, USD: 0.012 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gives a saver who has not unlocked a recipe the teaser and none of what it holds', async () => {
    const page = await savedMediaFor(SAVER);
    const served = JSON.stringify(page);

    for (const text of LOCKED_RECIPE_TEXT) {
      expect(served).not.toContain(text);
    }
    const paid = page.items.find((item) => item.id === 'post-paid');
    // The stored reference and the two the creation's inputs add.
    expect(paid?.asset?.itemCounts).toEqual({ prompt: 1, reference_image: 3 });
    expect(paid?.asset?.lockedPreview).toMatchObject({
      itemCounts: { prompt: 1, reference_image: 3 },
      sectionCount: 1,
      sectionPreviews: [],
      attachmentPreviews: [{ label: 'File 1', kind: 'file', contentType: null, sizeBytes: null }],
      itemPreviews: [
        { type: 'prompt', title: 'Prompt', sectionId: null, contentType: null, sizeBytes: null },
        { type: 'reference_image', title: 'Reference image', sectionId: null, contentType: null, sizeBytes: null },
      ],
    });
    expect(paid?.asset).toMatchObject({ viewerHasUnlocked: false, priceQuote: { currency: 'INR' } });
    expect(paid?.canRemix).toBe(false);
  });

  it('keeps a recipe reached through a legacy generation save locked too', async () => {
    db.tables.post_saves = [];
    db.tables.showcase_saves = [{ user_id: SAVER, generation_id: 'gen-paid', created_at: SAVED_AT['post-paid'] }];

    const page = await savedMediaFor(SAVER);

    expect(page.items.map((item) => item.id)).toEqual(['post-paid']);
    const served = JSON.stringify(page);
    for (const text of LOCKED_RECIPE_TEXT) {
      expect(served).not.toContain(text);
    }
  });

  it.each([
    ['a saver who has unlocked neither recipe', SAVER],
    ['the creator', CREATOR],
    ['the buyer of the paid recipe', BUYER],
    ['the claimer of the free recipe', CLAIMER],
  ])('serves %s each saved post exactly as the feed serves it to them', async (_viewer, viewerUserId) => {
    const feedItems = await feedItemsFor(viewerUserId);
    const page = await savedMediaFor(viewerUserId);

    expect(feedItems.map((item) => item.id)).toEqual(['post-paid', 'post-free']);
    expect(page.items).toEqual(feedItems.map((item) => ({ ...item, isSaved: true, savedAt: SAVED_AT[item.id] })));
  });

  it('tells a buyer and a claimer the recipe is theirs, and lets its creator and buyer remix', async () => {
    const [buyerPage, claimerPage, creatorPage] = await Promise.all([
      savedMediaFor(BUYER),
      savedMediaFor(CLAIMER),
      savedMediaFor(CREATOR),
    ]);
    const paidFor = (page: ShowcaseFeedPage) => page.items.find((item) => item.id === 'post-paid');
    const freeFor = (page: ShowcaseFeedPage) => page.items.find((item) => item.id === 'post-free');

    expect(paidFor(buyerPage)?.asset?.viewerHasUnlocked).toBe(true);
    expect(paidFor(buyerPage)?.canRemix).toBe(true);
    expect(freeFor(claimerPage)?.asset?.viewerHasUnlocked).toBe(true);
    expect(paidFor(creatorPage)?.canRemix).toBe(true);
  });
});
