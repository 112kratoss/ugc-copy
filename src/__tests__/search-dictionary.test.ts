import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { rebuildSearchDictionary } from '@/lib/search-dictionary';

vi.mock('server-only', () => ({}));

function clientAnswering(answer: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async () => answer);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe('rebuildSearchDictionary', () => {
  it('calls rebuild_search_terms and returns the counts of its one row', async () => {
    const { client, rpc } = clientAnswering({ data: [{ added: 12, removed: 3 }], error: null });

    await expect(rebuildSearchDictionary(client)).resolves.toEqual({ added: 12, removed: 3 });
    expect(rpc).toHaveBeenCalledWith('rebuild_search_terms');
  });

  it('accepts zero counts', async () => {
    const { client } = clientAnswering({ data: [{ added: 0, removed: 0 }], error: null });

    await expect(rebuildSearchDictionary(client)).resolves.toEqual({ added: 0, removed: 0 });
  });

  it('throws the RPC error', async () => {
    const error = new Error('permission denied for function rebuild_search_terms');
    const { client } = clientAnswering({ data: null, error });

    await expect(rebuildSearchDictionary(client)).rejects.toBe(error);
  });

  it.each([
    ['no data', null],
    ['no row', []],
    ['a negative count', [{ added: -1, removed: 0 }]],
    ['a fractional count', [{ added: 1.5, removed: 0 }]],
    ['a string count', [{ added: '1', removed: 0 }]],
    ['a missing field', [{ added: 1 }]],
  ])('throws on a malformed answer: %s', async (_label, data) => {
    const { client } = clientAnswering({ data, error: null });

    await expect(rebuildSearchDictionary(client)).rejects.toThrow(/unexpected answer/);
  });
});
