import { describe, expect, it, vi } from 'vitest';

import {
  resolveSourceGenerationId,
  SourceGenerationValidationError,
} from '@/lib/source-generation';

function createSupabaseMock(result: {
  data: Record<string, unknown> | null;
  error: Error | null;
}) {
  const calls = {
    tables: [] as string[],
    selects: [] as string[],
    eqs: [] as Array<{ column: string; value: unknown }>,
    ors: [] as string[],
  };
  const query = {
    select(columns: string) {
      calls.selects.push(columns);
      return query;
    },
    eq(column: string, value: unknown) {
      calls.eqs.push({ column, value });
      return query;
    },
    or(filter: string) {
      calls.ors.push(filter);
      return query;
    },
    maybeSingle: vi.fn(async () => result),
  };

  return {
    calls,
    supabase: {
      from: vi.fn((table: string) => {
        calls.tables.push(table);
        return query;
      }),
    },
  };
}

describe('source generation validation', () => {
  it('filters remix source lookups to generations the user owns or public generations', async () => {
    const { calls, supabase } = createSupabaseMock({
      data: {
        id: 'source-1',
        user_id: 'other-user',
        is_public: true,
      },
      error: null,
    });

    await expect(resolveSourceGenerationId(
      supabase as never,
      'user-1',
      ' source-1 ',
    )).resolves.toBe('source-1');

    expect(calls.tables).toEqual(['generations']);
    expect(calls.selects).toEqual(['id, user_id, is_public']);
    expect(calls.eqs).toEqual([{ column: 'id', value: 'source-1' }]);
    expect(calls.ors).toEqual(['user_id.eq.user-1,is_public.eq.true']);
  });

  it('returns null when no remix source is provided', async () => {
    const { calls, supabase } = createSupabaseMock({ data: null, error: null });

    await expect(resolveSourceGenerationId(supabase as never, 'user-1', '  ')).resolves.toBeNull();

    expect(calls.tables).toEqual([]);
  });

  it('throws a validation error when the source is not visible', async () => {
    const { supabase } = createSupabaseMock({ data: null, error: null });

    await expect(resolveSourceGenerationId(
      supabase as never,
      'user-1',
      'source-1',
    )).rejects.toMatchObject({
      name: 'SourceGenerationValidationError',
      status: 400,
    });
  });

  it('turns database failures into a 500 validation error', async () => {
    const { supabase } = createSupabaseMock({ data: null, error: new Error('database down') });

    await expect(resolveSourceGenerationId(
      supabase as never,
      'user-1',
      'source-1',
    )).rejects.toBeInstanceOf(SourceGenerationValidationError);

    await expect(resolveSourceGenerationId(
      supabase as never,
      'user-1',
      'source-1',
    )).rejects.toMatchObject({ status: 500 });
  });
});
