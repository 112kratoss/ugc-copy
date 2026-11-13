import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  NO_PUBLIC_SEARCH_FILTERS,
  PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH,
  PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH,
  appliedPublicSearchFilters,
  decodePublicSearchCursor,
  encodePublicSearchCursor,
  normalizePublicSearchQuery,
  publicSearchCursorFilterMark,
  publicSearchQueryLength,
  normalizeCreatorSearchQuery as serverCreatorQuery,
} from '@/lib/public-search';
import { stripShowcaseViewerState } from '@/lib/share';

import {
  NO_SEARCH_FILTERS,
  SEARCH_FAILED_TITLE,
  SEARCH_FIELD_LABEL,
  SEARCH_IDLE_BODY,
  SEARCH_IDLE_TITLE,
  SEARCH_PLACEHOLDER,
  SEARCH_RECENTS_CLEAR_LABEL,
  SEARCH_SORT_OPTIONS,
  SEARCH_TABS,
  SEARCH_TOP_SECTION_SIZES,
  searchBusyBody,
  searchCreatorCardLabel,
  searchDocumentTitle,
  searchFailedLine,
  searchHistoryQueryFor,
  searchPostCardLabel,
  searchRecipeCardLabel,
  searchSaysNoResults,
  searchSeeAllLabel,
  searchTabRuns,
  searchTopSectionHasMore,
  SEARCH_FAILED_BODY,
  SEARCH_OFFLINE_BODY,
  SEARCH_FILTER_PARAMS,
  SEARCH_FILTER_SWITCHES,
  SEARCH_HISTORY_LIMIT,
  hasSearchFilters,
  isSearchFilterSwitchOn,
  normalizeCreatorSearchQuery,
  normalizeSearchHistoryQuery,
  parseSearchEntityId,
  parseSearchHistory,
  readSearchFilterParams,
  searchCorrectionNotice,
  searchEntityCountLabel,
  searchEntityId,
  searchFilterKey,
  searchFilterParams,
  searchHistoryWith,
  searchHistoryWithout,
  searchQueryLength,
  toggleSearchFilterSwitch,
  type SearchFilters,
} from '../../ugc-mobile/lib/public-search-policy/public-search-policy';

// The rules the web's search page and the app's overlay share
// (ugc-mobile/lib/public-search-policy), read here as the web reads them, and
// held to the server's own where the two must agree.

const reader = (query: string) => {
  const params = new URLSearchParams(query);
  return (name: string) => params.get(name);
};

describe('the shared search rules, read by the web (ugc-mobile/lib/public-search-policy)', () => {
  describe('queries', () => {
    it('normalizes and counts a query as the server does', () => {
      for (const value of [
        '  product  reveal  ', '@@Jane  Doe', 'Ｋling ２.６', '\u{1F600}\u{1F600}', 'x'.repeat(140),
        // Past the limit in characters, and in UTF-16 units only: both are cut at a hundred characters.
        '\u{1F600}'.repeat(120), '\u{1F600}'.repeat(80), `${'x'.repeat(99)}\u{1F600}\u{1F600}`,
      ]) {
        expect(normalizeSearchHistoryQuery(value), value).toBe(normalizePublicSearchQuery(value));
        expect(normalizeCreatorSearchQuery(value), value).toBe(serverCreatorQuery(value));
        expect(searchQueryLength(value), value).toBe(publicSearchQueryLength(value));
      }
    });
  });

  describe('recent searches', () => {
    it('reads back only queries, normalized, at most the limit, and never throws', () => {
      expect(parseSearchHistory(JSON.stringify(['  Kling  portrait ', 7, null, 'x', 'neon']))).toEqual(['Kling portrait', 'neon']);
      expect(parseSearchHistory(JSON.stringify(Array.from({ length: 30 }, (_, index) => `query ${index}`)))).toHaveLength(SEARCH_HISTORY_LIMIT);
      for (const raw of [null, undefined, '', 'not json', '{"a":1}', '"text"']) expect(parseSearchHistory(raw), String(raw)).toEqual([]);
    });

    it('puts a search first, drops the steps of typing it, and keeps ten', () => {
      expect(searchHistoryWith(['po', 'POR', 'portrait', 'motion'], 'port')).toEqual(['port', 'portrait', 'motion']);
      expect(searchHistoryWith(['Portrait', 'motion'], ' portrait ')).toEqual(['portrait', 'motion']);
      expect(searchHistoryWith(Array.from({ length: 10 }, (_, index) => `query ${index}`), 'newest')).toHaveLength(10);
      // Too short to keep: the caller leaves its list as it is.
      expect(searchHistoryWith(['motion'], ' a ')).toBeNull();
    });

    it('removes one search whatever its case', () => {
      expect(searchHistoryWithout(['portrait', 'Motion', 'lighting'], ' MOTION ')).toEqual(['portrait', 'lighting']);
    });
  });

  describe('entities', () => {
    it('names an entity by kind and key, and reads only an id that could be one', () => {
      expect(searchEntityId({ kind: 'model', key: 'kling-2.6' })).toBe('model:kling-2.6');
      expect(parseSearchEntityId('model:kling-2.6')).toEqual({ kind: 'model', key: 'kling-2.6' });
      expect(parseSearchEntityId('tool:topaz-labs')).toEqual({ kind: 'tool', key: 'topaz-labs' });
      // A key in another script is a key.
      expect(parseSearchEntityId('tool:可灵')).toEqual({ kind: 'tool', key: '可灵' });
      for (const value of [
        null, undefined, '', 'kling-2.6', 'model:', 'creator:luna', 'model:Kling-2.6', 'model:kling 2.6',
        'model:a:b', 'model:a/b', 'model:a?b', 'model:a&b', 'model:a%20b', `model:${'k'.repeat(81)}`,
      ]) {
        expect(parseSearchEntityId(value), String(value)).toBeNull();
      }
    });

    it('counts posts in words, with a plus past the cap', () => {
      expect(searchEntityCountLabel({ postCount: 1, postCountCapped: false })).toBe('1 post');
      expect(searchEntityCountLabel({ postCount: 14, postCountCapped: false })).toBe('14 posts');
      expect(searchEntityCountLabel({ postCount: 1000, postCountCapped: false })).toBe('1,000 posts');
      expect(searchEntityCountLabel({ postCount: 1000, postCountCapped: true })).toBe('1,000+ posts');
    });
  });

  describe('filters', () => {
    const all: SearchFilters = { madeWith: 'model:kling-2.6', mediaKind: 'video', hasRecipe: true, following: true };

    it('names only what is on, and reads back what it wrote', () => {
      expect(searchFilterParams(NO_SEARCH_FILTERS, false)).toEqual({});
      expect(searchFilterParams(all, true)).toEqual({
        madeWith: 'model:kling-2.6', kind: 'video', recipe: '1', following: '1', exact: '1',
      });
      const written = new URLSearchParams(searchFilterParams(all, true)).toString();
      expect(readSearchFilterParams(reader(written))).toEqual({ ok: true, filters: all, exact: true });
      expect(readSearchFilterParams(reader(''))).toEqual({ ok: true, filters: NO_SEARCH_FILTERS, exact: false });
    });

    it('refuses a value it does not know by its parameter, never reading it as off', () => {
      expect(readSearchFilterParams(reader('kind=audio'))).toEqual({ ok: false, parameter: 'mediaKind' });
      expect(readSearchFilterParams(reader('kind='))).toEqual({ ok: false, parameter: 'mediaKind' });
      expect(readSearchFilterParams(reader('madeWith=kling'))).toEqual({ ok: false, parameter: 'madeWith' });
      expect(readSearchFilterParams(reader('recipe=0'))).toEqual({ ok: false, parameter: 'hasRecipe' });
      expect(readSearchFilterParams(reader('following=true'))).toEqual({ ok: false, parameter: 'following' });
      expect(readSearchFilterParams(reader('exact='))).toEqual({ ok: false, parameter: 'exact' });
    });

    it('uses no parameter a post’s way back to the search would drop', () => {
      // A post opened from a search carries the search's address as returnTo,
      // cleaned of the viewer's own state: a filter named like one of those
      // parameters would be lost on the way back.
      const address = `/search?q=portrait&type=posts&${new URLSearchParams(searchFilterParams(all, true)).toString()}`;
      expect(stripShowcaseViewerState(address)).toBe(address);
      expect(Object.values(SEARCH_FILTER_PARAMS)).not.toContain('media');
    });

    it('tells every set of filters and reading apart in one string, empty for none', () => {
      expect(searchFilterKey(NO_SEARCH_FILTERS, false)).toBe('');
      const sets: Array<[SearchFilters, boolean]> = [
        [NO_SEARCH_FILTERS, true],
        [{ ...NO_SEARCH_FILTERS, mediaKind: 'image' }, false],
        [{ ...NO_SEARCH_FILTERS, mediaKind: 'video' }, false],
        [{ ...NO_SEARCH_FILTERS, hasRecipe: true }, false],
        [{ ...NO_SEARCH_FILTERS, following: true }, false],
        [{ ...NO_SEARCH_FILTERS, madeWith: 'model:kling-2.6' }, false],
        [{ ...NO_SEARCH_FILTERS, madeWith: 'tool:kling-2.6' }, false],
        [all, false],
        [all, true],
      ];
      const keys = sets.map(([filters, exact]) => searchFilterKey(filters, exact));
      expect(new Set(keys).size).toBe(sets.length);
      expect(new Set(sets.map(([filters, exact]) => publicSearchCursorFilterMark(filters, exact))).size).toBe(sets.length);
    });

    it('draws four switches, Images and Videos one choice', () => {
      expect(SEARCH_FILTER_SWITCHES.map((item) => item.label)).toEqual(['Images', 'Videos', 'Has recipe', 'Following']);
      const video = toggleSearchFilterSwitch(NO_SEARCH_FILTERS, 'video');
      expect(video.mediaKind).toBe('video');
      expect(isSearchFilterSwitchOn(video, 'video')).toBe(true);
      expect(isSearchFilterSwitchOn(video, 'image')).toBe(false);
      expect(toggleSearchFilterSwitch(video, 'image').mediaKind).toBe('image');
      expect(toggleSearchFilterSwitch(video, 'video').mediaKind).toBeNull();
      expect(toggleSearchFilterSwitch(NO_SEARCH_FILTERS, 'recipe').hasRecipe).toBe(true);
      expect(toggleSearchFilterSwitch(NO_SEARCH_FILTERS, 'following').following).toBe(true);
      expect(hasSearchFilters(NO_SEARCH_FILTERS)).toBe(false);
      expect(hasSearchFilters(video)).toBe(true);
      // The switches leave the made-with filter alone.
      expect(toggleSearchFilterSwitch(all, 'recipe').madeWith).toBe('model:kling-2.6');
    });
  });

  describe('the corrected reading', () => {
    it('says what the tab in front was read as, and nothing where it was read as typed', () => {
      expect(searchCorrectionNotice({ posts: 'portrait', recipes: null }, 'posts')).toBe('Showing results for “portrait”');
      expect(searchCorrectionNotice({ posts: 'portrait', recipes: null }, 'top')).toBe('Showing results for “portrait”');
      expect(searchCorrectionNotice({ posts: null, recipes: 'portraits' }, 'top')).toBe('Showing results for “portraits”');
      expect(searchCorrectionNotice({ posts: 'portrait', recipes: 'portrait' }, 'top')).toBe('Showing results for “portrait”');
      expect(searchCorrectionNotice({ posts: 'portrait', recipes: 'portraits' }, 'top'))
        .toBe('Showing posts for “portrait” and recipes for “portraits”');
      // A tab says only what it draws.
      expect(searchCorrectionNotice({ posts: 'portrait', recipes: 'portraits' }, 'recipes')).toBe('Showing results for “portraits”');
      expect(searchCorrectionNotice({ posts: 'portrait', recipes: null }, 'recipes')).toBeNull();
      expect(searchCorrectionNotice({ posts: 'portrait', recipes: 'portraits' }, 'creators')).toBeNull();
      expect(searchCorrectionNotice({ posts: null, recipes: null }, 'top')).toBeNull();
      // An answer from before the reading was reported.
      expect(searchCorrectionNotice(undefined, 'top')).toBeNull();
    });
  });
});

describe('what the server makes of filters', () => {
  const asked: SearchFilters = { madeWith: 'model:kling-2.6', mediaKind: 'video', hasRecipe: true, following: true };

  it('narrows Posts alone, and leaves "following" out for a viewer who follows nobody', () => {
    expect(appliedPublicSearchFilters('posts', asked, true)).toEqual(asked);
    expect(appliedPublicSearchFilters('posts', asked, false)).toEqual({ ...asked, following: false });
    for (const type of ['top', 'creators', 'recipes'] as const) {
      expect(appliedPublicSearchFilters(type, asked, true), type).toEqual(NO_PUBLIC_SEARCH_FILTERS);
    }
  });

  it('marks a posts cursor with its filters and reading, and reads the mark back', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(publicSearchCursorFilterMark(NO_PUBLIC_SEARCH_FILTERS, false)).toBeUndefined();
    const mark = publicSearchCursorFilterMark(asked, false);
    expect(mark).toMatch(/^[0-9a-f]{8}$/);
    // The same search, the same mark: a cursor issued by one instance pages on another.
    expect(publicSearchCursorFilterMark({ ...asked }, false)).toBe(mark);

    const cursor = encodePublicSearchCursor({ version: 1, type: 'posts', score: 4.5, id, filters: mark });
    expect(decodePublicSearchCursor(cursor, 'posts')).toEqual({ version: 1, type: 'posts', score: 4.5, id, filters: mark });
    const latest = encodePublicSearchCursor({
      version: 1, type: 'posts', sort: 'latest', createdAt: '2026-11-12T10:00:00.123456+00:00', id, filters: mark,
    });
    expect(decodePublicSearchCursor(latest, 'posts', 'latest')?.filters).toBe(mark);
    // A cursor from before filters has none, and still reads.
    expect(decodePublicSearchCursor(encodePublicSearchCursor({ version: 1, type: 'posts', score: 4.5, id }), 'posts'))
      .toEqual({ version: 1, type: 'posts', score: 4.5, id });
  });

  it('refuses a mark that is not one, and a mark on a cursor that pages nothing filtered', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const forged = (fields: Record<string, unknown>) => Buffer.from(JSON.stringify(fields), 'utf8').toString('base64url');
    for (const mark of ['kind=video', 'DEADBEEF', 'deadbee', 'deadbeef0', 12345678, null, {}]) {
      expect(decodePublicSearchCursor(forged({ v: 1, t: 'posts', s: 4.5, i: id, f: mark }), 'posts'), String(mark)).toBeNull();
    }
    expect(decodePublicSearchCursor(forged({ v: 1, t: 'creators', s: 4.5, i: id, f: 'deadbeef' }), 'creators')).toBeNull();
    expect(decodePublicSearchCursor(forged({ v: 1, t: 'recipes', o: 24, f: 'deadbeef' }), 'recipes')).toBeNull();
  });
});

// The words both clients show, said once in the shared module (search UX
// audit, 2026-11-13, finding 10) and asserted here as the web reads them;
// ugc-mobile/__tests__/public-search-policy.test.ts holds the app's side.
describe('the words both search clients show', () => {
  it('names every field, state and control in one set of words, none of them the product\'s name', async () => {
    const policy = await import('../../ugc-mobile/lib/public-search-policy/public-search-policy');
    for (const [name, value] of Object.entries(policy)) {
      // The prose spellings; the lowercase `magicbooklet` of a storage key is an address, not the name.
      if (typeof value === 'string') expect(value, name).not.toMatch(/Magic ?[Bb]ooklet/);
    }
    // Plain "Search": no product name, so no question of how the app's wordmark is spelled.
    expect(SEARCH_PLACEHOLDER).toBe('Search');
    expect(SEARCH_FIELD_LABEL).toBe('Search creators, posts, and recipes');
    expect(SEARCH_IDLE_TITLE).toBe('Find creators, posts and recipes');
    expect(SEARCH_IDLE_BODY).toBe('Try a creator’s name, a model, or an idea like “neon portrait”.');
    // An invitation, never a rule about how much to type.
    expect(`${SEARCH_IDLE_TITLE} ${SEARCH_IDLE_BODY}`).not.toMatch(/character/i);
    expect(SEARCH_RECENTS_CLEAR_LABEL).toBe('Clear all');
    expect(SEARCH_TABS.map((tab) => tab.label)).toEqual(['Top', 'Creators', 'Posts', 'Recipes']);
    // The order is not a second "Top"; the parameter's values do not change.
    expect(SEARCH_SORT_OPTIONS).toEqual([{ value: 'top', label: 'Best match' }, { value: 'latest', label: 'Latest' }]);
    expect(searchSeeAllLabel('posts')).toBe('See all posts');
    expect(searchDocumentTitle('nano')).toBe('nano · Search');
    expect(searchDocumentTitle('  nano  ')).toBe('nano · Search');
    expect(searchDocumentTitle('')).toBe('Search');
    // From the two characters a search starts at, on the server and the page alike (review of #784).
    expect(searchDocumentTitle('a')).toBe('Search');
    expect(searchDocumentTitle('@j')).toBe('Search');
    expect(searchDocumentTitle('na')).toBe('na · Search');
    const page = readFileSync(join(__dirname, '../app/search/page.tsx'), 'utf8');
    expect(page).toContain('title: searchDocumentTitle(opening.query)');
  });

  it('says a failure once: the title what happened, the body what to do', () => {
    for (const body of [SEARCH_FAILED_BODY, SEARCH_OFFLINE_BODY, searchBusyBody(9), searchBusyBody(null)]) {
      expect(body.toLowerCase()).not.toContain('load');
      expect(body.toLowerCase()).not.toContain('try again');
    }
    expect(SEARCH_FAILED_TITLE).toBe('Search did not load');
    expect(searchBusyBody(9)).toBe('Too many searches at once. Wait 9 s.');
    expect(searchFailedLine(SEARCH_OFFLINE_BODY)).toBe('Search did not load. Check your connection.');
  });

  it('names a result card in words', () => {
    // Everything the card shows a sighted person, nothing less (review of #784).
    expect(searchPostCardLabel({ title: 'Mahabali', creatorName: 'Sassy23b', saveCount: 1, commentCount: 4 }))
      .toBe('Open post Mahabali by Sassy23b, 1 save, 4 comments');
    expect(searchRecipeCardLabel({ title: 'Neon grade', sellerName: 'Luna', price: '10 credits', summary: 'Lighting,\n lens and grade' }))
      .toBe('Open recipe Neon grade by Luna, 10 credits. Lighting, lens and grade');
    expect(searchRecipeCardLabel({ title: 'Neon grade', sellerName: 'Luna', price: 'Free', summary: '' }))
      .toBe('Open recipe Neon grade by Luna, Free');
    expect(searchCreatorCardLabel({ displayName: 'Luna', username: 'luna', isFollowing: true, publicPostCount: 12, bio: 'Films and stills' }))
      .toBe("Open Luna's profile, @luna, following, 12 posts. Films and stills");
    expect(searchCreatorCardLabel({ displayName: 'Luna', username: 'luna', isFollowing: false, publicPostCount: 1, bio: null }))
      .toBe("Open Luna's profile, @luna, 1 post");
  });

  // A shared word written into a client's own code, as a string, a template
  // or JSX text, comments aside (they may quote the words they explain).
  const holdsCopy = (source: string, word: string) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .includes(word);

  it('finds a copy however it is written, and ignores one in a comment (the scan\'s own control)', () => {
    expect(holdsCopy("placeholder='Search did not load'", 'Search did not load')).toBe(true);
    expect(holdsCopy('<p>\n  Search did not load\n</p>', 'Search did not load')).toBe(true);
    expect(holdsCopy('title={`Search did not load`}', 'Search did not load')).toBe(true);
    expect(holdsCopy('// Search did not load is the shared title', 'Search did not load')).toBe(false);
    expect(holdsCopy('/* Search did not load */', 'Search did not load')).toBe(false);
    expect(holdsCopy("href='https://x.test'", 'x.test')).toBe(true);
  });

  it('holds no copy of a shared word in the web clients', () => {
    const root = join(__dirname, '..');
    const files = {
      'app/search/SearchClient.tsx': 'SEARCH_IDLE_TITLE',
      'components/search/SearchField.tsx': 'SEARCH_FIELD_LABEL',
      'components/AppShellSearch.tsx': 'SEARCH_PLACEHOLDER',
    };
    for (const [file, sharedName] of Object.entries(files)) {
      const source = readFileSync(join(root, file), 'utf8');
      // The scan reads the file it means to: each takes its words from the shared module.
      expect(source, file).toContain('ugc-mobile/lib/public-search-policy/public-search-policy');
      expect(holdsCopy(source, sharedName), `${file}: ${sharedName}`).toBe(true);
      for (const word of ['Search Magic Booklet', 'Search Magicbooklet', 'Search creators, posts, and recipes', 'Search did not load', 'Clear all', 'Clear search', 'Best match', 'characters.']) {
        expect(holdsCopy(source, word), `${file}: ${word}`).toBe(false);
      }
    }
  });
});

describe('when a tab is searched, and when a search says it found nothing', () => {
  it('searches Top and Creators from two characters, Posts and Recipes from three: the server\'s minimums', () => {
    expect(PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH).toBe(2);
    expect(PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH).toBe(3);
    for (const type of ['top', 'creators'] as const) {
      expect(searchTabRuns(type, 1)).toBe(false);
      expect(searchTabRuns(type, 2)).toBe(true);
    }
    for (const type of ['posts', 'recipes'] as const) {
      expect(searchTabRuns(type, 2)).toBe(false);
      expect(searchTabRuns(type, 3)).toBe(true);
    }
  });

  it('never gives a verdict on half a word', () => {
    expect(searchSaysNoResults(2)).toBe(false);
    expect(searchSaysNoResults(3)).toBe(true);
  });

  it('reads a full Top section as one with more on its tab, at the server\'s own sizes', () => {
    const service = readFileSync(join(__dirname, '../lib/public-search-service.ts'), 'utf8');
    for (const section of ['creators', 'posts', 'recipes'] as const) {
      expect(service).toContain(`SEARCH_TOP_SECTION_SIZES.${section}`);
      expect(searchTopSectionHasMore(section, SEARCH_TOP_SECTION_SIZES[section])).toBe(true);
      expect(searchTopSectionHasMore(section, SEARCH_TOP_SECTION_SIZES[section] - 1)).toBe(false);
    }
  });
});

describe('the query a search is kept under among the recent ones', () => {
  // The typed query, unless what the person committed to or opened was shown
  // under the corrected spelling and found something.
  const answer = (correctedQuery: { posts: string | null; recipes: string | null } | undefined, posts: number, recipes: number) => ({
    correctedQuery,
    posts: { items: Array.from({ length: posts }) },
    recipes: { items: Array.from({ length: recipes }) },
  });
  const keep = (
    type: 'top' | 'creators' | 'posts' | 'recipes',
    found: ReturnType<typeof answer> | null,
    extra: { exact?: boolean; opened?: 'creator' | 'post' | 'recipe' } = {},
  ) => searchHistoryQueryFor({ query: 'portriat', type, answer: found, exact: extra.exact ?? false, opened: extra.opened ?? null });

  it('keeps the reading of the section a commit leads with, when that section found something', () => {
    const both = answer({ posts: 'portrait', recipes: 'portraits' }, 3, 2);
    expect(keep('top', both)).toBe('portrait');
    expect(keep('posts', both)).toBe('portrait');
    expect(keep('recipes', both)).toBe('portraits');
    // Top with no posts leads with its recipes.
    expect(keep('top', answer({ posts: 'portrait', recipes: 'portraits' }, 0, 2))).toBe('portraits');
  });

  it('never lets another section\'s correction stand in for a section read as typed (review of #784)', () => {
    // Posts read as typed and shown; only the recipes were corrected.
    expect(keep('top', answer({ posts: null, recipes: 'portraits' }, 4, 2))).toBe('portriat');
  });

  it('keeps the typed query when the corrected section found nothing (review of #784)', () => {
    expect(keep('top', answer({ posts: 'portrait', recipes: null }, 0, 0))).toBe('portriat');
    expect(keep('posts', answer({ posts: 'portrait', recipes: null }, 0, 0))).toBe('portriat');
  });

  it('follows what was opened: a creator keeps the typed query that finds them again (review of #784)', () => {
    const both = answer({ posts: 'portrait', recipes: 'portraits' }, 3, 2);
    expect(keep('top', both, { opened: 'creator' })).toBe('portriat');
    expect(keep('top', both, { opened: 'post' })).toBe('portrait');
    expect(keep('top', both, { opened: 'recipe' })).toBe('portraits');
    expect(keep('top', answer({ posts: null, recipes: 'portraits' }, 3, 2), { opened: 'post' })).toBe('portriat');
  });

  it('keeps the typed query when asked for as typed, on Creators, and with no answer or no correction', () => {
    const both = answer({ posts: 'portrait', recipes: 'portraits' }, 3, 2);
    expect(keep('top', both, { exact: true })).toBe('portriat');
    expect(keep('creators', both)).toBe('portriat');
    expect(keep('top', null)).toBe('portriat');
    expect(keep('top', answer(undefined, 3, 2))).toBe('portriat');
    expect(keep('top', answer({ posts: null, recipes: null }, 3, 2))).toBe('portriat');
  });
});
