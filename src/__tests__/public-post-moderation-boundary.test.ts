import { beforeEach, describe, expect, it, vi } from 'vitest';

type PostRow = {
  id: string;
  generation_id: string | null;
  visibility: 'public' | 'unlisted' | 'private';
  archived_at: string | null;
  review_status: 'visible' | 'flagged' | 'hidden';
  category: 'image';
  prompt: string | null;
  source_kind: 'magicbooklet';
  user_id: string;
};

const helperMocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  resolveStoredMediaUrl: vi.fn(),
}));
const detailMocks = vi.hoisted(() => ({
  getPostResourceBundleDetailByPostId: vi.fn(),
  loadPostMediaItemsMap: vi.fn(),
}));

vi.mock('@/lib/server-helpers', () => helperMocks);
// The detail read's own neighbours, so it can be read to the end.
vi.mock('@/lib/post-resource-bundles-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/post-resource-bundles-server')>()),
  getPostResourceBundleDetailByPostId: detailMocks.getPostResourceBundleDetailByPostId,
}));
vi.mock('@/lib/post-media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/post-media')>()),
  loadPostMediaItemsMap: detailMocks.loadPostMediaItemsMap,
}));

import {
  getPostReferenceForShowcaseId,
  getPublicPostDetail,
} from '@/lib/public-posts';
import { findPublicPostReferenceByIdOrGenerationId } from '@/lib/posts-server';

function createServiceClientMock(posts: PostRow[]) {
  const filters: Array<{ column: string; value: unknown; operation: 'eq' | 'in' | 'is' }> = [];

  return {
    filters,
    from(table: string) {
      if (table !== 'posts') {
        throw new Error(`Unexpected table access: ${table}`);
      }

      return {
        select() {
          const localFilters: typeof filters = [];
          const query = {
            eq(column: string, value: unknown) {
              localFilters.push({ column, value, operation: 'eq' });
              filters.push({ column, value, operation: 'eq' });
              return query;
            },
            is(column: string, value: unknown) {
              localFilters.push({ column, value, operation: 'is' });
              filters.push({ column, value, operation: 'is' });
              return query;
            },
            in(column: string, values: unknown[]) {
              localFilters.push({ column, value: values, operation: 'in' });
              filters.push({ column, value: values, operation: 'in' });
              return query;
            },
            async maybeSingle() {
              const rows = posts.filter((row) => localFilters.every((filter) => {
                const actual = (row as unknown as Record<string, unknown>)[filter.column] ?? null;
                if (filter.operation === 'in') {
                  return (filter.value as unknown[]).includes(actual);
                }
                return actual === filter.value;
              }));
              return { data: rows[0] ?? null, error: null };
            },
          };

          return query;
        },
      };
    },
  };
}

describe('public post moderation boundary', () => {
  beforeEach(() => {
    helperMocks.createServiceClient.mockReset();
  });

  it.each(['flagged', 'hidden'] as const)(
    'does not resolve a %s post through detail, redirect, or interaction lookups',
    async (reviewStatus) => {
      const mock = createServiceClientMock([{
        id: 'post-1',
        generation_id: 'gen-1',
        visibility: 'public',
        archived_at: null,
        review_status: reviewStatus,
        category: 'image',
        prompt: 'Ordinary prompt',
        source_kind: 'magicbooklet',
        user_id: 'user-1',
      }]);
      helperMocks.createServiceClient.mockReturnValue(mock);

      await expect(getPublicPostDetail('post-1')).resolves.toBeNull();
      await expect(getPostReferenceForShowcaseId('post-1')).resolves.toBeNull();
      await expect(findPublicPostReferenceByIdOrGenerationId('post-1')).resolves.toBeNull();

      expect(mock.filters).toContainEqual({
        column: 'review_status',
        value: 'visible',
        operation: 'eq',
      });
    },
  );
});

describe('public post detail read', () => {
  function postRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'post-1',
      user_id: 'user-1',
      generation_id: null,
      visibility: 'public',
      output_url: null,
      showcase_asset_path: null,
      prompt: null,
      title: 'Dance loop',
      description: null,
      body: null,
      category: 'video',
      creation_mode: null,
      save_count: 0,
      remix_count: 0,
      share_count: 0,
      share_visit_count: 0,
      comment_count: 0,
      source_kind: 'magicbooklet',
      source_tool: null,
      review_status: 'visible',
      is_nsfw: false,
      created_at: '2026-10-01T00:00:00.000Z',
      post_format: 'media',
      ...overrides,
    };
  }

  /**
   * Answers the post row, and the post's creation when one is given, with only
   * the columns its read asks for, as PostgREST does. The creator read finds
   * nothing.
   */
  function useClientFor(row: Record<string, unknown>, generation: Record<string, unknown> | null = null) {
    const client = {
      from(table: string) {
        let columns: string[] = [];
        const query = {
          select: (selected: string) => {
            columns = selected.split(',').map((column) => column.trim());
            return query;
          },
          eq: () => query,
          is: () => query,
          in: () => query,
          maybeSingle: async () => ({
            data: table === 'posts'
              ? row
              : table === 'generations' && generation
                ? Object.fromEntries(columns.map((column) => [column, generation[column] ?? null]))
                : null,
            error: null,
          }),
        };
        return query;
      },
    };
    helperMocks.createServiceClient.mockReturnValue(client);
  }

  beforeEach(() => {
    helperMocks.createServiceClient.mockReset();
    detailMocks.getPostResourceBundleDetailByPostId.mockReset().mockResolvedValue(null);
    detailMocks.loadPostMediaItemsMap.mockReset().mockResolvedValue(new Map([[
      'post-1',
      [{ id: 'media-1', url: 'https://cdn.example.com/dance.mp4', mediaKind: 'video', sortOrder: 0 }],
    ]]));
  });

  it('says a motion post is one, which its category alone cannot', async () => {
    useClientFor(postRow({ creation_mode: 'motion' }));
    await expect(getPublicPostDetail('post-1')).resolves.toMatchObject({
      category: 'video',
      creationMode: 'motion',
    });

    useClientFor(postRow());
    await expect(getPublicPostDetail('post-1')).resolves.toMatchObject({ creationMode: null });
  });

  it('hands the row\'s NSFW flag to the recipe read, which then need not read posts again', async () => {
    useClientFor(postRow());
    await getPublicPostDetail('post-1', { viewerUserId: 'viewer-1', countryCode: 'IN' });
    expect(detailMocks.getPostResourceBundleDetailByPostId).toHaveBeenCalledWith('post-1', {
      viewerUserId: 'viewer-1',
      countryCode: 'IN',
      isNsfw: false,
    });

    useClientFor(postRow({ is_nsfw: true }));
    await expect(getPublicPostDetail('post-1')).resolves.toMatchObject({ isNsfw: true, nsfwRevealed: false });
    expect(detailMocks.getPostResourceBundleDetailByPostId).toHaveBeenLastCalledWith('post-1', expect.objectContaining({
      isNsfw: true,
    }));
  });

  // A template's recipe and model are its author's: Studio shows the result's
  // model as `template-workflow`, and the post page said the real one to anyone.
  it.each([
    ['its run', { template_run_id: 'run-1', template_run_step_id: null }],
    ['its step', { template_run_id: null, template_run_step_id: 'step-1' }],
  ])("names a template result's model as Studio does when the creation records %s, and offers no Remix", async (_label, link) => {
    useClientFor(
      postRow({ generation_id: 'gen-1', category: 'image' }),
      { model: 'nano-banana-pro', ...link },
    );

    const detail = await getPublicPostDetail('post-1');

    expect(detail).toMatchObject({
      model: 'template-workflow',
      canRemix: false,
      remixCapability: 'none',
      remixTarget: null,
    });
    expect(JSON.stringify(detail)).not.toContain('nano-banana-pro');
  });

  it("keeps an ordinary creation's model and Remix", async () => {
    useClientFor(
      postRow({ generation_id: 'gen-1', category: 'image' }),
      { model: 'nano-banana-pro', template_run_id: null, template_run_step_id: null },
    );

    await expect(getPublicPostDetail('post-1')).resolves.toMatchObject({
      model: 'nano-banana-pro',
      canRemix: true,
      remixCapability: 'public',
      remixTarget: 'image',
    });
  });
});
