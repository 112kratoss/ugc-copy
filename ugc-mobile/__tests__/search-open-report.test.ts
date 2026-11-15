import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import mobileApiOperations from '../../contracts/mobile-api-operations-v1.json';
import {
  SEARCH_ENTRIES,
  SEARCH_ENTRY_PARAM,
  SEARCH_OPENED_PATH,
  SEARCH_OPEN_KINDS,
  SEARCH_OPEN_MAX_POSITION,
  readSearchEntry,
  readSearchOpenBody,
  searchEntryForChosenText,
  searchEntryParams,
  searchOpenBody,
  type SearchOpen,
} from '../lib/public-search-policy/search-open-log';
import { reportSearchOpen } from '../lib/search-open-report';

const contract = mobileApiContract.endpoints.recordSearchOpen;
const open: SearchOpen = {
  query: contract.request.q,
  type: 'posts',
  sort: 'latest',
  entry: 'suggestion',
  kind: 'post',
  id: contract.request.id,
  position: contract.request.position,
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the search log’s names, shared with the server and the web', () => {
  it('are the contract’s: the entry parameter, its values, the route, the kinds and the last place kept', () => {
    const search = mobileApiContract.endpoints.searchPublicContent;
    expect(SEARCH_ENTRY_PARAM).toBe(search.entryParameter);
    expect([...SEARCH_ENTRIES]).toEqual(search.entries);
    expect(SEARCH_OPENED_PATH).toBe(contract.path);
    expect(mobileApiOperations.operations.recordSearchOpen).toEqual({ method: 'POST', path: contract.path, auth: 'optional' });
    expect([...SEARCH_OPEN_KINDS]).toEqual(contract.kinds);
    expect(SEARCH_OPEN_MAX_POSITION).toBe(contract.maxPosition);
  });

  it('build the contract’s request bodies, and the server’s reader takes them back', () => {
    expect(searchOpenBody(open)).toEqual(contract.request);
    expect(searchOpenBody({
      query: contract.entityRequest.q, type: 'top', sort: 'top', entry: null, kind: 'entity',
      id: contract.entityRequest.id, position: contract.entityRequest.position,
    })).toEqual(contract.entityRequest);
    expect(readSearchOpenBody(contract.request)).toEqual({ ok: true, open });
    expect(readSearchOpenBody(contract.entityRequest)).toMatchObject({ ok: true, open: { kind: 'entity', entry: null } });
  });

  it('name an entry in a search request only when there is one', () => {
    expect(searchEntryParams('starter')).toEqual({ entry: 'starter' });
    expect(searchEntryParams(null)).toEqual({});
    expect(readSearchEntry('voice')).toEqual({ ok: false });
  });

  it('say how a row chosen while typing was entered', () => {
    expect(searchEntryForChosenText('nano', 'nano', [])).toBe('typed');
    expect(searchEntryForChosenText('Nano Banana', 'nano', ['nano banana'])).toBe('recent');
    expect(searchEntryForChosenText('nano banana pro', 'nano', ['nano banana'])).toBe('suggestion');
  });

  it('stay free of React Native, Expo and Node imports: the web and the server compile the file too', () => {
    const source = readFileSync(path.resolve(__dirname, '../lib/public-search-policy/search-open-log.ts'), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/gu)].map((match) => match[1]);
    expect(imports).toEqual(['./public-search-policy']);
  });
});

describe('reportSearchOpen (app)', () => {
  it('posts the open through the API client and returns before it settles', async () => {
    let finish: (() => void) | undefined;
    const recordSearchOpen = vi.fn(() => new Promise<unknown>((resolve) => { finish = () => resolve(''); }));
    expect(reportSearchOpen({ recordSearchOpen }, open)).toBeUndefined();
    expect(recordSearchOpen).toHaveBeenCalledTimes(1);
    expect(recordSearchOpen).toHaveBeenCalledWith(contract.request);
    finish?.();
    await settle();
  });

  it('sends nothing the server would refuse', () => {
    const recordSearchOpen = vi.fn(async () => '');
    reportSearchOpen({ recordSearchOpen }, { ...open, id: 'luna-studio' });
    reportSearchOpen({ recordSearchOpen }, { ...open, query: ' ' });
    reportSearchOpen({ recordSearchOpen }, { ...open, position: 0 });
    expect(recordSearchOpen).not.toHaveBeenCalled();
  });

  it('never throws and leaves no unhandled rejection when the request fails or the client throws', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(() => reportSearchOpen({ recordSearchOpen: vi.fn(async () => { throw new Error('offline'); }) }, open)).not.toThrow();
      expect(() => reportSearchOpen({ recordSearchOpen: vi.fn(() => { throw new Error('no client'); }) }, open)).not.toThrow();
      await settle();
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
