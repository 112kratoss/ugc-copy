import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The reel's locked card, and every feed card, tease a recipe from the feed's
 * summary of it, which counted the items the creator stored alone. A creation
 * recipe whose creator shares the creation's inputs (the stored switch) hands
 * them over with the unlock, so 6487f689's card said "Recipe includes 1
 * prompt." while its post page (PR #582) and its unlock said a prompt, three
 * pictures and a clip (recipe reading review B3).
 */

type Row = Record<string, unknown>;

const state: {
  storedSwitch: boolean;
  generationIsPublic: boolean;
  sourceReadError: unknown;
  summaryRead: Promise<void> | null;
  sourceSelects: string[];
} = {
  storedSwitch: true,
  generationIsPublic: true,
  sourceReadError: null,
  summaryRead: null,
  sourceSelects: [],
};

const storedItems = [{ id: 'prompt-1', type: 'prompt', title: 'Prompt', textContent: 'The prompt behind it.' }];

function summaryRow(postId: string): Row {
  return {
    id: `bundle-${postId}`,
    post_id: postId,
    title: 'Launch hook recipe',
    access_mode: 'free',
    price_usd_cents: 0,
    preview_text: 'The prompt behind it.',
    prompt_text: null,
    notes_markdown: null,
    workflow_share_url: null,
    workflow_snapshot: null,
    attachments: [],
    // The summary reports every published creation recipe as including its
    // Remix, whatever the creator's stored switch says (2026-10-27).
    allow_remix: true,
    resource_sections: [],
    resource_items: storedItems,
    sales_count: 0,
    free_unlock_count: 0,
    status: 'published',
  };
}

function inputRow(id: string, mediaType: 'image' | 'video', sortOrder: number): Row {
  return {
    id,
    generation_id: 'gen-1',
    user_id: 'creator-1',
    media_type: mediaType,
    role: mediaType === 'video' ? 'reference_video' : 'reference_image',
    label: `Private name of ${id}`,
    storage_path: `generation_inputs/creator-1/gen-1/${id}.${mediaType === 'video' ? 'mp4' : 'png'}`,
    source_generation_id: null,
    sort_order: sortOrder,
    metadata: {},
  };
}

/** The recipe as the creation-inputs read nests it: its post, generation and inputs. */
function creationInputSource(): Row {
  return {
    ...summaryRow('post-1'),
    allow_remix: state.storedSwitch,
    post: {
      id: 'post-1',
      user_id: 'creator-1',
      generation_id: 'gen-1',
      category: 'image',
      visibility: 'public',
      archived_at: null,
      review_status: 'visible',
      source_kind: 'magicbooklet',
      generation: {
        id: 'gen-1',
        user_id: 'creator-1',
        is_public: state.generationIsPublic,
        category: 'image',
        workflow_settings: { model: 'nano-banana-2' },
        inputs: [
          inputRow('image-1', 'image', 0),
          inputRow('image-2', 'image', 1),
          inputRow('image-3', 'image', 2),
          inputRow('video-1', 'video', 3),
        ],
      },
    },
  };
}

function createAdminClient() {
  return {
    async rpc(name: string, args: { p_post_ids: string[] }) {
      if (name !== 'get_public_post_resource_bundle_summaries') throw new Error(`Unexpected rpc: ${name}`);
      if (state.summaryRead) await state.summaryRead;
      return { data: args.p_post_ids.filter((id) => id === 'post-1').map(summaryRow), error: null };
    },
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let selected = '';
      const query = {
        select(columns: string) {
          selected = columns;
          if (table === 'post_resource_bundles') state.sourceSelects.push(columns);
          return query;
        },
        in(column: string, values: unknown[]) {
          filters.push((row) => values.includes(row[column]));
          return query;
        },
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
          return query;
        },
        order() {
          return query;
        },
        abortSignal() {
          return query;
        },
        then(resolve: (value: { data: Row[] | null; error: unknown }) => void, reject?: (reason: unknown) => void) {
          let rows: Row[] = [];
          if (table === 'profiles') {
            rows = [{ id: 'creator-1', username: 'maya-creates', display_name: 'Maya R', avatar_url: null }];
          } else if (table === 'post_resource_bundles' && selected.includes('post:posts')) {
            if (state.sourceReadError) {
              Promise.resolve({ data: null, error: state.sourceReadError }).then(resolve, reject);
              return;
            }
            rows = [creationInputSource()];
          } else if (table !== 'post_source_tools') {
            throw new Error(`Unexpected table: ${table}`);
          }
          Promise.resolve({ data: rows.filter((row) => filters.every((filter) => filter(row))), error: null })
            .then(resolve, reject);
        },
      };
      return query;
    },
  };
}

vi.mock('@/lib/post-media', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/post-media')>(),
  loadPostMediaItemsMap: vi.fn(async (_client: unknown, postIds: string[]) => new Map(postIds.map((postId) => [postId, [{
    id: `media-${postId}`,
    mediaKey: `media-${postId}`,
    url: `https://media.example.com/${postId}.jpg`,
    previewUrl: `https://media.example.com/${postId}-preview.jpg`,
    mediaKind: 'image',
  }]]))),
}));

vi.mock('@/lib/generation-preview-info', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/generation-preview-info')>(),
  loadGenerationPreviewInfoMap: vi.fn(async () => new Map()),
}));

vi.mock('@/lib/nsfw-content-server', () => ({
  loadNsfwPostIds: vi.fn(async () => new Set()),
  hasNsfwReveal: vi.fn(async () => false),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => createAdminClient(),
  resolveOwnedStoredMediaUrl: vi.fn(async () => null),
}));

function postRow(id: string) {
  return {
    id,
    output_url: null,
    showcase_asset_path: null,
    prompt: null,
    title: 'A launch hook',
    body: null,
    category: 'image' as const,
    post_format: 'media' as const,
    save_count: 0,
    remix_count: 0,
    created_at: '2026-10-29T00:00:00.000Z',
    user_id: 'creator-1',
    source_kind: 'magicbooklet' as const,
    source_tool: null,
    source_tool_slug: null,
    review_status: 'visible',
    generation_id: id === 'post-1' ? 'gen-1' : null,
  };
}

async function loadFeedItems(postIds = ['post-1']) {
  const { resolvePostRowsToFeedItems } = await import('@/lib/showcase-feed');
  return resolvePostRowsToFeedItems(postIds.map(postRow), createAdminClient() as never);
}

describe('a feed card for a recipe whose creator shares the creation’s inputs', () => {
  beforeEach(() => {
    vi.resetModules();
    state.storedSwitch = true;
    state.generationIsPublic = true;
    state.sourceReadError = null;
    state.summaryRead = null;
    state.sourceSelects = [];
  });

  it('counts what the unlock adds, as the post page does', async () => {
    const { formatPostResourceBundleCountSummary } = await import('@/lib/post-resource-bundles');

    const [item] = await loadFeedItems();

    expect(item.asset?.lockedPreview?.itemCounts).toEqual({ prompt: 1, reference_image: 3, reference_video: 1 });
    expect(item.asset?.itemCounts).toEqual({ prompt: 1, reference_image: 3, reference_video: 1 });
    expect(item.asset?.resourceKinds).toEqual(['prompt', 'files', 'remix']);
    // The reel's locked card: "Recipe includes …".
    expect(formatPostResourceBundleCountSummary(item.asset?.lockedPreview ?? null))
      .toBe('1 prompt, 3 reference images, 1 reference video');
    // How many, never which.
    const sent = JSON.stringify(item);
    expect(sent).not.toContain('generation_inputs');
    expect(sent).not.toContain('Private name');
    expect(sent).not.toMatch(/image-[123]|video-1/);
  });

  it('counts none when the creator keeps them, though the Remix still comes with the recipe', async () => {
    state.storedSwitch = false;

    const [item] = await loadFeedItems();

    expect(item.asset?.lockedPreview?.itemCounts).toEqual({ prompt: 1 });
    expect(item.asset?.resourceKinds).toEqual(['prompt', 'remix']);
  });

  it('counts none once the generation is no longer public, as a buyer’s unlock then holds them back', async () => {
    state.generationIsPublic = false;

    const [item] = await loadFeedItems();

    expect(item.asset?.lockedPreview?.itemCounts).toEqual({ prompt: 1 });
  });

  it('keeps the stored counts when the inputs cannot be read', async () => {
    state.sourceReadError = { code: '57014', message: 'canceling statement due to statement timeout' };

    const [item] = await loadFeedItems();

    expect(item.asset?.lockedPreview?.itemCounts).toEqual({ prompt: 1 });
    expect(item.asset?.resourceKinds).toEqual(['prompt', 'remix']);
  });

  it('reads the page’s inputs in one request, started beside the summaries', async () => {
    let releaseSummaries!: () => void;
    state.summaryRead = new Promise((resolve) => {
      releaseSummaries = resolve;
    });

    const pending = loadFeedItems(['post-1', 'post-2', 'post-3']);
    await vi.waitFor(() => expect(state.sourceSelects).toHaveLength(1));
    releaseSummaries();
    const items = await pending;

    expect(state.sourceSelects).toHaveLength(1);
    expect(items.find((item) => item.id === 'post-1')?.asset?.itemCounts)
      .toEqual({ prompt: 1, reference_image: 3, reference_video: 1 });
  });
});
