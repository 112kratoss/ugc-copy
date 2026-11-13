import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SEARCH_STARTER_CREATOR_LIMIT,
  SEARCH_STARTER_ENTITY_LIMIT,
  SEARCH_STARTER_RATE_LIMIT,
  SEARCH_STARTER_SEARCH_LIMIT,
} from '@/lib/search-starter';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  SEARCH_STARTER_EMPTY_RESPONSE,
  SEARCH_STARTER_HEADINGS,
  SEARCH_STARTER_MAX_CREATORS,
  SEARCH_STARTER_MAX_ENTITIES,
  SEARCH_STARTER_MAX_SEARCHES,
  SEARCH_STARTER_SECTION_IDS,
  isSearchStarterEmpty,
  parseSearchStarterResponse,
  searchStarterCreatorAction,
  searchStarterEntityAction,
  searchStarterSearchAction,
  searchStarterSections,
} from '../../ugc-mobile/lib/public-search-policy/search-starter';
import { searchEntityId } from '../../ugc-mobile/lib/public-search-policy/public-search-policy';

const contract = mobileApiContract.endpoints.searchStarter;

describe('search starter shared rules', () => {
  it('hold the server to the caps and words the contract pins', () => {
    expect(SEARCH_STARTER_ENTITY_LIMIT).toBe(SEARCH_STARTER_MAX_ENTITIES);
    expect(SEARCH_STARTER_CREATOR_LIMIT).toBe(SEARCH_STARTER_MAX_CREATORS);
    expect(SEARCH_STARTER_SEARCH_LIMIT).toBe(SEARCH_STARTER_MAX_SEARCHES);
    expect(contract.limits).toEqual({
      maxEntities: SEARCH_STARTER_MAX_ENTITIES,
      maxCreators: SEARCH_STARTER_MAX_CREATORS,
      maxSearches: SEARCH_STARTER_MAX_SEARCHES,
    });
    expect(contract.rateLimit).toEqual(SEARCH_STARTER_RATE_LIMIT);
    expect(contract.headings).toEqual(SEARCH_STARTER_HEADINGS);
    expect(SEARCH_STARTER_EMPTY_RESPONSE).toEqual(contract.responseVariants.switchedOff.response);
  });

  it('read the contract’s answer as it is', () => {
    expect(parseSearchStarterResponse(contract.response)).toEqual(contract.response);
  });

  it.each([
    ['nothing', null],
    ['a list', []],
    ['a failure’s body', { error: 'Failed to load search starter.' }],
    ['a rate limit’s body', { code: 'RATE_LIMITED', retryAfterSeconds: 4 }],
    ['the typeahead’s answer', { query: 'lu', normalizedQuery: 'lu', creators: [], entities: [], completions: [] }],
  ])('read %s as no answer, except the typeahead’s, which is another route’s and has no searches', (_name, body) => {
    const parsed = parseSearchStarterResponse(body);
    if (body && !Array.isArray(body) && 'completions' in body) {
      // A body with any of the lists is read for what it has: here, nothing.
      expect(isSearchStarterEmpty(parsed)).toBe(true);
    } else {
      expect(parsed).toBeNull();
    }
  });

  it('leave out a row that is not whole, and cut each list at its cap', () => {
    const parsed = parseSearchStarterResponse({
      entities: [
        { kind: 'model', key: 'veo-3.1', label: 'Veo 3.1', postCount: 12.7, postCountCapped: 'yes', query: ' veo 3 1 ' },
        { kind: 'person', key: 'x', label: 'X', postCount: 1, query: 'x' },
        { kind: 'tool', key: '', label: 'Empty', postCount: 1, query: 'empty' },
        // No query: nothing to search, so no row (a client never falls back to the name).
        { kind: 'tool', key: 'no-query', label: 'No query', postCount: 1 },
        { kind: 'tool', key: 'blank-query', label: 'Blank query', postCount: 1, query: '   ' },
        ...Array.from({ length: 10 }, (_, index) => ({ kind: 'tool', key: `t-${index}`, label: `T ${index}`, postCount: 1, query: `t ${index}` })),
      ],
      creators: [
        { id: 'c-1', username: 'ada', displayName: 'Ada', bio: '', avatarUrl: '', publicPostCount: -3 },
        { id: 'c-2', username: '', displayName: 'No handle' },
        ...Array.from({ length: 10 }, (_, index) => ({ id: `c-${index + 3}`, username: `u${index}`, displayName: `U ${index}` })),
      ],
      searches: [{ text: '  anime ' }, { text: '   ' }, { text: 7 }, ...Array.from({ length: 10 }, (_, index) => ({ text: `s ${index}` }))],
    })!;
    expect(parsed.entities[0]).toEqual({ kind: 'model', key: 'veo-3.1', label: 'Veo 3.1', postCount: 12, postCountCapped: false, query: 'veo 3 1' });
    expect(parsed.entities.map((entity) => entity.key)).not.toContain('no-query');
    expect(parsed.entities.map((entity) => entity.key)).not.toContain('blank-query');
    expect(parsed.entities).toHaveLength(SEARCH_STARTER_MAX_ENTITIES);
    expect(parsed.creators[0]).toEqual({
      id: 'c-1', username: 'ada', displayName: 'Ada', bio: null, avatarUrl: null, publicPostCount: 0, isFollowing: false,
    });
    expect(parsed.creators.map((creator) => creator.username)).not.toContain('');
    expect(parsed.creators).toHaveLength(SEARCH_STARTER_MAX_CREATORS);
    expect(parsed.searches[0]).toEqual({ text: 'anime' });
    expect(parsed.searches).toHaveLength(SEARCH_STARTER_MAX_SEARCHES);
  });

  it('read a missing list as empty', () => {
    expect(parseSearchStarterResponse({ searches: [{ text: 'anime' }] }))
      .toEqual({ entities: [], creators: [], searches: [{ text: 'anime' }] });
  });

  it('draw the sections a answer fills, in order, under their headings', () => {
    expect(SEARCH_STARTER_SECTION_IDS).toEqual(['entities', 'creators', 'searches']);
    const sections = searchStarterSections(parseSearchStarterResponse(contract.response));
    expect(sections.map((section) => [section.id, section.heading])).toEqual([
      ['entities', 'Popular models and tools'],
      ['creators', 'Creators to follow'],
      ['searches', 'Try searching for'],
    ]);
    expect(searchStarterSections({ entities: [], creators: [], searches: [{ text: 'anime' }] }).map((section) => section.id))
      .toEqual(['searches']);
    expect(searchStarterSections(null)).toEqual([]);
    expect(isSearchStarterEmpty(SEARCH_STARTER_EMPTY_RESPONSE)).toBe(true);
    expect(isSearchStarterEmpty(null)).toBe(true);
    expect(isSearchStarterEmpty(parseSearchStarterResponse(contract.response))).toBe(false);
  });

  it('say what a row does: an entity searches the query it was counted for on Posts narrowed to it, a creator opens their page, a search searches', () => {
    const [entity] = contract.response.entities as Parameters<typeof searchStarterEntityAction>[0][];
    expect(searchStarterEntityAction(entity)).toEqual({
      type: 'entity',
      entity,
      query: entity.query,
      madeWith: searchEntityId(entity),
    });
    // Never its name: "Nano Banana Pro" is drawn, "nano banana pro" is searched.
    expect(entity.label).not.toBe(entity.query);
    expect(searchStarterEntityAction(entity)).toMatchObject({ madeWith: 'model:nano-banana-pro' });
    const [creator] = parseSearchStarterResponse(contract.response)!.creators;
    expect(searchStarterCreatorAction(creator)).toEqual({ type: 'creator', username: 'luna-studio' });
    expect(searchStarterSearchAction({ text: 'anime' })).toEqual({ type: 'search', query: 'anime' });
  });

  it('stay free of React Native, Expo, Node and \\p{…}', () => {
    const source = readFileSync(join(process.cwd(), 'ugc-mobile/lib/public-search-policy/search-starter.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"](?:react-native|expo[^'"]*|node:[^'"]*|react)['"]/);
    expect(source.replace(/^\s*(?:\/\*\*|\*).*$/gm, '')).not.toMatch(/\\p\{/);
  });
});
