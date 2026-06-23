import { describe, expect, it, vi } from 'vitest';

import {
  listOwnerGenerationsForRoute,
  type OwnerGenerationsRouteClient,
} from '@/lib/owner-generations-route-service';

type GenerationStatusRow = {
  id: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  model: string;
  category: string | null;
};

function createStatusClient(rows: GenerationStatusRow[]) {
  const selectedColumns: string[] = [];
  const filters: Array<{ column: string; value: unknown }> = [];
  const nullFilters: string[] = [];
  const ranges: Array<{ from: number; to: number }> = [];

  const from = vi.fn((table: string) => {
    if (table !== 'generations') {
      throw new Error(`Unexpected table: ${table}`);
    }

    return {
      select(columns: string) {
        selectedColumns.push(columns);
        const query = {
          eq(column: string, value: unknown) {
            filters.push({ column, value });
            return query;
          },
          order() {
            return query;
          },
          is(column: string, value: null) {
            if (value === null) {
              nullFilters.push(column);
            }
            return query;
          },
          range(fromIndex: number, toIndex: number) {
            ranges.push({ from: fromIndex, to: toIndex });
            return query;
          },
          then(resolve: (value: { data: GenerationStatusRow[]; error: null }) => void) {
            const lastRange = ranges.at(-1) ?? { from: 0, to: rows.length - 1 };
            resolve({
              data: rows.slice(lastRange.from, lastRange.to + 1),
              error: null,
            });
          },
        };

        return query;
      },
    };
  });

  return {
    selectedColumns,
    filters,
    nullFilters,
    ranges,
    client: { from } as unknown as OwnerGenerationsRouteClient,
  };
}

describe('listOwnerGenerationsForRoute', () => {
  it('returns bounded status pages without creating an admin client', async () => {
    const ownerClient = createStatusClient([
      {
        id: 'gen-1',
        status: 'processing',
        created_at: '2026-06-22T08:00:00.000Z',
        completed_at: null,
        model: 'nano-banana-2',
        category: 'image',
      },
      {
        id: 'gen-2',
        status: 'succeeded',
        created_at: '2026-06-22T07:00:00.000Z',
        completed_at: '2026-06-22T07:01:00.000Z',
        model: 'kling-3.0-video',
        category: 'video',
      },
    ]);
    const getAdminSupabase = vi.fn();

    const payload = await listOwnerGenerationsForRoute({
      userId: 'user-1',
      supabase: ownerClient.client,
      getAdminSupabase,
      searchParams: new URLSearchParams('detail=status&limit=1'),
    });

    expect(ownerClient.selectedColumns).toEqual([
      'id, status, created_at, completed_at, model, category, archived_at',
    ]);
    expect(ownerClient.filters).toContainEqual({ column: 'user_id', value: 'user-1' });
    expect(ownerClient.nullFilters).toEqual(['archived_at']);
    expect(ownerClient.ranges).toEqual([{ from: 0, to: 1 }]);
    expect(getAdminSupabase).not.toHaveBeenCalled();
    expect(payload).toEqual({
      generations: [
        {
          id: 'gen-1',
          status: 'processing',
          created_at: '2026-06-22T08:00:00.000Z',
          completed_at: null,
          category: 'image',
          model: 'nano-banana-2',
        },
      ],
      pagination: {
        limit: 1,
        hasMore: true,
        nextCursor: '1',
      },
    });
  });
});
