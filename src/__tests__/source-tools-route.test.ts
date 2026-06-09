import { beforeEach, describe, expect, it, vi } from 'vitest';

type QueryResult = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};

const tableResults = vi.hoisted(() => new Map<string, QueryResult>());

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({
    from(table: string) {
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        in() {
          return query;
        },
        order() {
          return query;
        },
        then(resolve: (value: QueryResult) => void) {
          resolve(tableResults.get(table) ?? { data: [], error: null });
        },
      };

      return query;
    },
  }),
}));

describe('/api/source-tools route', () => {
  beforeEach(() => {
    vi.resetModules();
    tableResults.clear();
  });

  it('returns active tools and models from Supabase', async () => {
    tableResults.set('source_tools', {
      data: [
        {
          id: 'tool-1',
          slug: 'higgsfield',
          label: 'Higgsfield',
          supported_media_kinds: ['image', 'video'],
          sort_order: 10,
        },
      ],
      error: null,
    });
    tableResults.set('source_tool_models', {
      data: [
        {
          source_tool_id: 'tool-1',
          slug: 'soul',
          label: 'Soul',
          sort_order: 0,
        },
      ],
      error: null,
    });

    const { GET } = await import('@/app/api/source-tools/route');
    const response = await GET();
    const payload = await response.json();

    expect(payload.tools).toEqual([
      {
        slug: 'higgsfield',
        label: 'Higgsfield',
        supportedMediaKinds: ['image', 'video'],
        models: [{ slug: 'soul', label: 'Soul' }],
      },
    ]);
  });

  it('falls back to bundled tools when the catalog tables are missing', async () => {
    tableResults.set('source_tools', {
      data: null,
      error: { code: '42P01', message: 'relation "public.source_tools" does not exist' },
    });

    const { GET } = await import('@/app/api/source-tools/route');
    const response = await GET();
    const payload = await response.json();

    expect(payload.tools.some((tool: { slug: string }) => tool.slug === 'magicbooklet')).toBe(true);
    expect(payload.tools.some((tool: { slug: string }) => tool.slug === 'higgsfield')).toBe(true);
  });
});
