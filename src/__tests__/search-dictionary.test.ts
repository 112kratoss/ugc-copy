import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { rebuildSearchDictionary } from '@/lib/search-dictionary';

vi.mock('server-only', () => ({}));

type Answer = { data: unknown; error: unknown };

const PHRASES: Answer = { data: [{ phrases: 3854, subjects: 6535 }], error: null };

/** A client that answers each of the job's two functions by name. */
function clientAnswering(terms: Answer, phrases: Answer = PHRASES) {
  const rpc = vi.fn(async (name: string) => (name === 'rebuild_search_terms' ? terms : phrases));
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe('rebuildSearchDictionary', () => {
  it('calls rebuild_search_terms, then rebuild_search_phrases, and returns the counts of each one’s row', async () => {
    const { client, rpc } = clientAnswering({ data: [{ added: 12, removed: 3 }], error: null });

    await expect(rebuildSearchDictionary(client)).resolves.toEqual({ added: 12, removed: 3, phrases: 3854, subjects: 6535 });
    // Two calls, in this order: each has the statement timeout to itself.
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['rebuild_search_terms', 'rebuild_search_phrases']);
  });

  it('accepts zero counts', async () => {
    const { client } = clientAnswering(
      { data: [{ added: 0, removed: 0 }], error: null },
      { data: [{ phrases: 0, subjects: 0 }], error: null },
    );

    await expect(rebuildSearchDictionary(client)).resolves.toEqual({ added: 0, removed: 0, phrases: 0, subjects: 0 });
  });

  it('reads a single row answered as an object, as PostgREST may', async () => {
    const { client } = clientAnswering(
      { data: { added: 1, removed: 2 }, error: null },
      { data: { phrases: 3, subjects: 4 }, error: null },
    );

    await expect(rebuildSearchDictionary(client)).resolves.toEqual({ added: 1, removed: 2, phrases: 3, subjects: 4 });
  });

  it('throws the dictionary’s RPC error, and does not go on to the phrases', async () => {
    const error = new Error('permission denied for function rebuild_search_terms');
    const { client, rpc } = clientAnswering({ data: null, error });

    await expect(rebuildSearchDictionary(client)).rejects.toBe(error);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('throws the phrases’ RPC error, after the dictionary was rebuilt: the run fails where it is seen', async () => {
    const error = new Error('function public.rebuild_search_phrases() does not exist');
    const { client, rpc } = clientAnswering({ data: [{ added: 1, removed: 0 }], error: null }, { data: null, error });

    await expect(rebuildSearchDictionary(client)).rejects.toBe(error);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['no data', null],
    ['no row', []],
    ['a negative count', [{ added: -1, removed: 0 }]],
    ['a fractional count', [{ added: 1.5, removed: 0 }]],
    ['a string count', [{ added: '1', removed: 0 }]],
    ['a missing field', [{ added: 1 }]],
  ])('throws on a malformed dictionary answer: %s', async (_label, data) => {
    const { client } = clientAnswering({ data, error: null });

    await expect(rebuildSearchDictionary(client)).rejects.toThrow('rebuild_search_terms returned an unexpected answer.');
  });

  it.each([
    ['no data', null],
    ['no row', []],
    ['a negative count', [{ phrases: -1, subjects: 0 }]],
    ['a fractional count', [{ phrases: 1.5, subjects: 0 }]],
    ['a string count', [{ phrases: '1', subjects: 0 }]],
    ['a missing field', [{ phrases: 1 }]],
  ])('throws on a malformed phrases answer: %s', async (_label, data) => {
    const { client } = clientAnswering({ data: [{ added: 0, removed: 0 }], error: null }, { data, error: null });

    await expect(rebuildSearchDictionary(client)).rejects.toThrow('rebuild_search_phrases returned an unexpected answer.');
  });
});
