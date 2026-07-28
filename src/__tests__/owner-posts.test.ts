import { beforeEach, describe, expect, it, vi } from 'vitest';

const postRows = vi.hoisted(() => ({
  value: [
    {
      id: 'post-1',
      user_id: 'user-1',
      generation_id: null,
      visibility: 'private',
      archived_at: null,
      archived_by_user_id: null,
      output_url: null,
      showcase_asset_path: null,
      prompt: null,
      title: 'Editable post',
      description: '',
      body: 'A post made with multiple tools.',
      category: 'image',
      post_format: 'media',
      source_kind: 'external',
      source_tool: 'Higgsfield',
      source_tool_slug: 'higgsfield',
      comment_count: 7,
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    },
  ],
}));

const sourceToolRows = vi.hoisted(() => ({
  value: [
    {
      post_id: 'post-1',
      tool_label: 'Higgsfield',
      tool_slug: 'higgsfield',
      model_label: 'Soul',
      model_slug: 'soul',
      sort_order: 0,
    },
    {
      post_id: 'post-1',
      tool_label: 'Runway',
      tool_slug: 'runway',
      model_label: 'Gen-4',
      model_slug: 'gen-4',
      sort_order: 1,
    },
  ],
}));
const createServiceClientMock = vi.hoisted(() => vi.fn());

function createQuery(table: string) {
  const filters = new Map<string, unknown>();
  let inFilter: { column: string; values: string[] } | null = null;

  const query = {
    select() {
      return query;
    },
    eq(column: string, value: unknown) {
      filters.set(column, value);
      return query;
    },
    in(column: string, values: string[]) {
      inFilter = { column, values };
      return query;
    },
    order() {
      return query;
    },
    async maybeSingle() {
      if (table !== 'posts') {
        return { data: null, error: null };
      }

      const row = postRows.value.find((post) => {
        const idMatches = !filters.has('id') || filters.get('id') === post.id;
        const userMatches = !filters.has('user_id') || filters.get('user_id') === post.user_id;
        return idMatches && userMatches;
      });

      return { data: row ?? null, error: null };
    },
    then(resolve: (value: { data: unknown[]; error: null }) => void) {
      if (table === 'post_resource_bundles') {
        resolve({ data: [], error: null });
        return;
      }

      if (table === 'post_source_tools') {
        const rows = sourceToolRows.value
          .filter((row) => !inFilter || (inFilter.column === 'post_id' && inFilter.values.includes(row.post_id)))
          .sort((a, b) => a.sort_order - b.sort_order);
        resolve({ data: rows, error: null });
        return;
      }

      resolve({ data: [], error: null });
    },
  };

  return query;
}

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => {
    createServiceClientMock();

    return {
      from: (table: string) => createQuery(table),
      storage: {
        from: () => ({
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://cdn.example.test/${path}` },
          }),
        }),
      },
    };
  },
}));

vi.mock('@/lib/post-resource-bundles-server', () => ({
  getPostResourceBundleDetailByPostId: vi.fn(async () => null),
}));

describe('owner posts', () => {
  beforeEach(() => {
    vi.resetModules();
    createServiceClientMock.mockReset();
  });

  it('loads structured source tools for edit prefill', async () => {
    const { getOwnerPostDetail } = await import('@/lib/owner-posts');

    const post = await getOwnerPostDetail('post-1', 'user-1');

    expect(post?.sourceTools).toEqual([
      {
        toolLabel: 'Higgsfield',
        toolSlug: 'higgsfield',
        modelLabel: 'Soul',
        modelSlug: 'soul',
      },
      {
        toolLabel: 'Runway',
        toolSlug: 'runway',
        modelLabel: 'Gen-4',
        modelSlug: 'gen-4',
      },
    ]);
    expect(post?.commentCount).toBe(7);
  });

  it('reuses one admin client while loading owner post detail', async () => {
    const { getOwnerPostDetail } = await import('@/lib/owner-posts');

    const post = await getOwnerPostDetail('post-1', 'user-1');

    expect(post?.id).toBe('post-1');
    expect(createServiceClientMock).toHaveBeenCalledTimes(1);
  });
});
