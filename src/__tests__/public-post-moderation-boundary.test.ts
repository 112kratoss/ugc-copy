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

vi.mock('@/lib/server-helpers', () => helperMocks);

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
