import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  clearSearchHistory,
  forgetSearchQuery,
  normalizeCreatorSearchQuery,
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

  it('drops the entries a new query extends, so the steps of typing it never crowd it out', async () => {
    const storage = memoryStorage(JSON.stringify(['po', 'POR', 'portrait', 'motion']));
    // "portrait" is longer than "port", not a step towards it, so it stays.
    expect(await rememberSearchQuery('port', storage)).toEqual(['port', 'portrait', 'motion']);
    expect(await readSearchHistory(storage)).toEqual(['port', 'portrait', 'motion']);
  });

  it('counts a handle without its leading @, the rule the server applies before its length checks', () => {
    expect(normalizeCreatorSearchQuery('@j')).toBe('j');
    expect(normalizeCreatorSearchQuery('  @@Jane\u00a0\u00a0Doe ')).toBe('Jane Doe');
    expect(normalizeCreatorSearchQuery('jane@doe')).toBe('jane@doe');
    expect(normalizeCreatorSearchQuery(null)).toBe('');
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

  it('never rejects a clear, so a sign-out cannot fail over recent searches', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const storage = memoryStorage(JSON.stringify(['portrait']));
    storage.removeItem.mockRejectedValueOnce(new Error('Storage unavailable'));

    await expect(clearSearchHistory(storage)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Could not clear recent searches', expect.any(Error));
    warn.mockRestore();
  });

  it('is cleared everywhere the saved home feed is: sign-out, ended sessions and account deletion', () => {
    // One device can pass between accounts, so each one's searches leave with it.
    const auth = readFileSync(path.resolve(__dirname, '../lib/auth.tsx'), 'utf8');
    const count = (needle: string) => auth.split(needle).length - 1;

    expect(count('clearPersistedHomeFeed()')).toBeGreaterThan(0);
    expect(count('clearSearchHistory()')).toBe(count('clearPersistedHomeFeed()'));
  });
});
