import { describe, expect, it, vi } from 'vitest';

import {
  clearSearchHistory,
  forgetSearchQuery,
  normalizeSearchHistoryQuery,
  readSearchHistory,
  rememberSearchQuery,
} from '../lib/search-history';

function memoryStorage(seed: string | null = null) {
  let value = seed;
  return {
    getItem: vi.fn(async () => value),
    setItem: vi.fn(async (_key: string, next: string) => { value = next; }),
    removeItem: vi.fn(async () => { value = null; }),
  };
}

describe('mobile search history', () => {
  it('normalizes whitespace and unicode before persistence', () => {
    expect(normalizeSearchHistoryQuery('  product\u00a0\u00a0reveal  ')).toBe('product reveal');
  });

  it('deduplicates case-insensitively and retains the ten latest searches', async () => {
    const storage = memoryStorage(JSON.stringify(['Portrait', 'motion', 'lighting']));
    expect(await rememberSearchQuery(' portrait ', storage)).toEqual(['portrait', 'motion', 'lighting']);
    for (let index = 0; index < 12; index += 1) await rememberSearchQuery(`query ${index}`, storage);
    const stored = await readSearchHistory(storage);
    expect(stored).toHaveLength(10);
    expect(stored[0]).toBe('query 11');
  });

  it('removes a single remembered query case-insensitively', async () => {
    const storage = memoryStorage(JSON.stringify(['portrait', 'motion', 'lighting']));
    expect(await forgetSearchQuery(' Motion ', storage)).toEqual(['portrait', 'lighting']);
    expect(await readSearchHistory(storage)).toEqual(['portrait', 'lighting']);
  });

  it('recovers from corrupt local data and can clear history', async () => {
    const storage = memoryStorage('{not-json');
    await expect(readSearchHistory(storage)).resolves.toEqual([]);
    await clearSearchHistory(storage);
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
  });
});
