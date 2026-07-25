import { describe, expect, it, vi } from 'vitest';

import {
  resolveSourceGenerationId,
  SourceGenerationValidationError,
} from '@/lib/source-generation';

const SOURCE_ID = '0f0e0d0c-0b0a-4901-8807-060504030201';

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
  it('resolves public remix sources without interpolating the user id into a filter', async () => {
    const { calls, supabase } = createSupabaseMock({
      data: {
        id: SOURCE_ID,
        user_id: 'other-user',
        is_public: true,
      },
      error: null,
    });

    await expect(resolveSourceGenerationId(
      supabase as never,
      'user-1',
      ` ${SOURCE_ID} `,
    )).resolves.toBe(SOURCE_ID);

    expect(calls.tables).toEqual(['generations']);
    expect(calls.selects).toEqual(['id, user_id, is_public']);
    expect(calls.eqs).toEqual([{ column: 'id', value: SOURCE_ID }]);
    // The visibility rule lives in code, so no caller-influenced value is ever
    // embedded in a PostgREST `.or()` filter expression.
    expect(calls.ors).toEqual([]);
  });

  it('resolves sources the requesting user owns even when private', async () => {
    const { supabase } = createSupabaseMock({
      data: {
        id: SOURCE_ID,
        user_id: 'user-1',
        is_public: false,
      },
      error: null,
    });

    await expect(resolveSourceGenerationId(
      supabase as never,
      'user-1',
      SOURCE_ID,
    )).resolves.toBe(SOURCE_ID);
  });

  it('rejects private sources owned by someone else', async () => {
    const { supabase } = createSupabaseMock({
      data: {
        id: SOURCE_ID,
        user_id: 'other-user',
        is_public: false,
      },
      error: null,
    });

    await expect(resolveSourceGenerationId(
      supabase as never,
      'user-1',
      SOURCE_ID,
    )).rejects.toMatchObject({
      name: 'SourceGenerationValidationError',
      status: 400,
    });
  });

  it('returns null when no remix source is provided', async () => {
    const { calls, supabase } = createSupabaseMock({ data: null, error: null });

    await expect(resolveSourceGenerationId(supabase as never, 'user-1', '  ')).resolves.toBeNull();

    expect(calls.tables).toEqual([]);
  });

  it('rejects malformed and filter-injection source ids without querying', async () => {
    const { calls, supabase } = createSupabaseMock({ data: null, error: null });

    for (const malicious of [
      'not-a-uuid',
      `${SOURCE_ID},user_id.not.is.null`,
      'x)or(is_public.eq.true',
    ]) {
      await expect(resolveSourceGenerationId(
        supabase as never,
        'user-1',
        malicious,
      )).rejects.toMatchObject({
        name: 'SourceGenerationValidationError',
        status: 400,
      });
    }

    expect(calls.tables).toEqual([]);
  });

  it('throws a validation error when the source is not visible', async () => {
    const { supabase } = createSupabaseMock({ data: null, error: null });

    await expect(resolveSourceGenerationId(
      supabase as never,
      'user-1',
      SOURCE_ID,
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
      SOURCE_ID,
    )).rejects.toBeInstanceOf(SourceGenerationValidationError);

    await expect(resolveSourceGenerationId(
      supabase as never,
      'user-1',
      SOURCE_ID,
    )).rejects.toMatchObject({ status: 500 });
  });
});
