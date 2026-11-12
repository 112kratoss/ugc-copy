import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { searchSuggestQuery } from '@/lib/search-suggest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  SEARCH_TYPEAHEAD_DEBOUNCE_MS,
  SEARCH_TYPEAHEAD_HEADINGS,
  SEARCH_TYPEAHEAD_MAX_COMPLETIONS,
  SEARCH_TYPEAHEAD_MAX_CREATORS,
  SEARCH_TYPEAHEAD_MAX_ENTITIES,
  SEARCH_TYPEAHEAD_SECTION_IDS,
  isSearchTypeaheadShown,
  moveSearchTypeaheadHighlight,
  parseSearchSuggestResponse,
  searchTypeaheadAction,
  searchTypeaheadQuery,
  searchTypeaheadRowLabel,
  searchTypeaheadRows,
  searchTypeaheadSections,
  searchTypeaheadStatus,
  type SearchSuggestResponse,
} from '../../ugc-mobile/lib/public-search-policy/search-typeahead';

const contract = mobileApiContract.endpoints.suggestSearch;

const answer: SearchSuggestResponse = {
  query: 'lum',
  normalizedQuery: 'lum',
  creators: [
    { id: 'c1', username: 'luma-studio', displayName: 'Luma Studio', avatarUrl: null, isFollowing: true },
    { id: 'c2', username: 'lumen', displayName: 'lumen', avatarUrl: 'https://cdn.example.test/a.png', isFollowing: false },
  ],
  entities: [{ kind: 'model', key: 'luma-ray-2', label: 'Luma Ray 2', postCount: 14, postCountCapped: false }],
  completions: [{ text: 'luminous' }, { text: 'lumen glow' }],
};

describe('search typeahead: the answer', () => {
  it('reads the contract’s answers as they are', () => {
    expect(parseSearchSuggestResponse(contract.response)).toEqual(contract.response);
    for (const variant of [contract.responseVariants.lastWordOfSeveral, contract.responseVariants.typedAsHandle, contract.responseVariants.switchedOff]) {
      expect(parseSearchSuggestResponse(variant.response)).toEqual(variant.response);
    }
    // A server from before entities sends none: read as none.
    expect(parseSearchSuggestResponse(contract.responseVariants.beforeEntities.response)).toEqual({
      ...contract.responseVariants.beforeEntities.response,
      entities: [],
    });
  });

  it('reads anything that is not an answer as nothing, never as an error', () => {
    for (const notOne of [
      null, undefined, '', 'ok', 7, [], {},
      { error: 'Failed to load search suggestions.' },
      { error: 'Too many requests', code: 'RATE_LIMITED', retryAfterSeconds: 12 },
      { creators: [] },
      { completions: [] },
      // Full search's answer, which a careless route match could hand a suggest request.
      { query: 'lu', type: 'top', creators: { items: [], nextCursor: null }, posts: { items: [] }, recipes: { items: [] } },
    ]) {
      expect(parseSearchSuggestResponse(notOne), JSON.stringify(notOne)).toBeNull();
    }
  });

  it('leaves out a row that is not whole, and holds each list to its cap', () => {
    const read = parseSearchSuggestResponse({
      query: 'lu',
      normalizedQuery: 'lu',
      creators: [
        { id: 'c1', username: 'luna', displayName: 'Luna', avatarUrl: null, isFollowing: false },
        { id: '', username: 'nobody', displayName: 'Nobody' },
        { id: 'c3', username: '', displayName: 'No handle' },
        'luna',
        null,
        ...Array.from({ length: 20 }, (_, index) => ({ id: `x${index}`, username: `luna-${index}`, displayName: `Luna ${index}`, avatarUrl: '', isFollowing: 'yes' })),
      ],
      entities: [
        { kind: 'creator', key: 'a', label: 'A', postCount: 1 },
        { kind: 'tool', key: 'lumen-forge', label: 'Lumen Forge', postCount: 3.9, postCountCapped: 'no' },
        { kind: 'model', key: 'm', label: 'M' },
        ...Array.from({ length: 9 }, (_, index) => ({ kind: 'tool', key: `t${index}`, label: `T${index}`, postCount: index, postCountCapped: false })),
      ],
      completions: [{ text: 'lunar' }, { text: '' }, 'lunar', {}, ...Array.from({ length: 20 }, (_, index) => ({ text: `lu${index}` }))],
    });
    expect(read?.creators).toHaveLength(SEARCH_TYPEAHEAD_MAX_CREATORS);
    expect(read?.creators[0]).toEqual({ id: 'c1', username: 'luna', displayName: 'Luna', avatarUrl: null, isFollowing: false });
    // An empty avatar is none, and only `true` is a follow.
    expect(read?.creators[1]).toEqual({ id: 'x0', username: 'luna-0', displayName: 'Luna 0', avatarUrl: null, isFollowing: false });
    expect(read?.entities).toHaveLength(SEARCH_TYPEAHEAD_MAX_ENTITIES);
    expect(read?.entities[0]).toEqual({ kind: 'tool', key: 'lumen-forge', label: 'Lumen Forge', postCount: 3, postCountCapped: false });
    expect(read?.completions).toHaveLength(SEARCH_TYPEAHEAD_MAX_COMPLETIONS);
    expect(read?.completions[0]).toEqual({ text: 'lunar' });
  });

  it('holds the caps the contract states', () => {
    expect(contract.limits).toMatchObject({
      maxCreators: SEARCH_TYPEAHEAD_MAX_CREATORS,
      maxEntities: SEARCH_TYPEAHEAD_MAX_ENTITIES,
      maxCompletions: SEARCH_TYPEAHEAD_MAX_COMPLETIONS,
    });
  });
});

describe('search typeahead: when to ask', () => {
  it('waits a short pause, shorter than full search’s', () => {
    expect(SEARCH_TYPEAHEAD_DEBOUNCE_MS).toBeGreaterThanOrEqual(120);
    expect(SEARCH_TYPEAHEAD_DEBOUNCE_MS).toBeLessThanOrEqual(150);
    expect(readFileSync(join(process.cwd(), 'src/app/search/SearchClient.tsx'), 'utf8')).toContain('const SEARCH_DEBOUNCE_MS = 300;');
  });

  it('asks about the text as the server reads it, and about nothing for an empty box', () => {
    expect(searchTypeaheadQuery('  Lu  ')).toBe('Lu');
    expect(searchTypeaheadQuery('cinematic \t  po')).toBe('cinematic po');
    expect(searchTypeaheadQuery('Ｌｕ')).toBe('Lu');
    expect(searchTypeaheadQuery('l')).toBe('l');
    expect(searchTypeaheadQuery('🔥')).toBe('🔥');
    // A handle keeps its @: it says what the person wants.
    expect(searchTypeaheadQuery('@lu')).toBe('@lu');
    expect(searchTypeaheadQuery('@ lu')).toBe('@ lu');
    for (const nothing of [null, undefined, '', '   ', '\t\n', '@', '@@', ' @ ', '\u0000', '@\u0000']) {
      expect(searchTypeaheadQuery(nothing), JSON.stringify(nothing)).toBeNull();
    }
    // Control characters are not text.
    expect(searchTypeaheadQuery('lu\u0000na')).toBe('luna');
    expect(searchTypeaheadQuery('po\u001brt\u007f')).toBe('port');
    // Past a hundred characters the text is cut where the server's own reading cuts it.
    expect(Array.from(searchTypeaheadQuery('a'.repeat(140)) ?? '')).toHaveLength(100);
  });

  it('asks only what the server will answer: the two agree on what is nothing', () => {
    for (const typed of ['l', '@lu', '@ lu', ' Lu ', '🔥', 'lu\u0000na', '', ' ', '@', '@\u0000', 'cinematic po', 'a'.repeat(100)]) {
      const asked = searchTypeaheadQuery(typed);
      const read = searchSuggestQuery(asked ?? typed);
      expect(read.ok, JSON.stringify(typed)).toBe(asked !== null);
    }
  });
});

describe('search typeahead: what is drawn', () => {
  it('draws creators, then models and tools, then completions', () => {
    expect([...SEARCH_TYPEAHEAD_SECTION_IDS]).toEqual(['creators', 'entities', 'completions']);
    const sections = searchTypeaheadSections(answer, 'lum');
    expect(sections.map((section) => section.id)).toEqual(['creators', 'entities', 'completions']);
    expect(sections.map((section) => section.heading)).toEqual([
      SEARCH_TYPEAHEAD_HEADINGS.creators, SEARCH_TYPEAHEAD_HEADINGS.entities, SEARCH_TYPEAHEAD_HEADINGS.completions,
    ]);
    expect(SEARCH_TYPEAHEAD_HEADINGS).toEqual({ creators: 'Creators', entities: 'Models and tools', completions: 'Suggested searches' });
    expect(searchTypeaheadRows(sections).map((row) => row.key)).toEqual([
      'creator:c1', 'creator:c2', 'entity:model:luma-ray-2', 'completion:luminous', 'completion:lumen glow',
    ]);
  });

  it('leaves out a section with no row, and draws nothing for no answer or an empty box', () => {
    expect(searchTypeaheadSections({ ...answer, creators: [], entities: [] }, 'lum').map((section) => section.id)).toEqual(['completions']);
    expect(searchTypeaheadSections({ ...answer, creators: [], entities: [], completions: [] }, 'lum')).toEqual([]);
    expect(searchTypeaheadSections(null, 'lum')).toEqual([]);
    expect(searchTypeaheadSections(answer, null)).toEqual([]);
  });

  it('draws no model or tool under three characters, whatever an answer carries', () => {
    expect(searchTypeaheadSections(answer, 'lu').map((section) => section.id)).toEqual(['creators', 'completions']);
    expect(searchTypeaheadSections(answer, 'lum').map((section) => section.id)).toContain('entities');
    // One emoji is one character.
    expect(searchTypeaheadSections(answer, '🔥🔥').map((section) => section.id)).not.toContain('entities');
    expect(contract.limits.minEntityQueryLength).toBe(3);
  });

  it('draws people alone for a query typed as a handle', () => {
    expect(searchTypeaheadSections(answer, '@lum').map((section) => section.id)).toEqual(['creators']);
  });

  it('does not offer back what the box already holds, or the same completion twice', () => {
    const sections = searchTypeaheadSections({
      ...answer,
      creators: [],
      entities: [],
      completions: [{ text: 'Luminous' }, { text: 'luminous glow' }, { text: 'LUMINOUS  GLOW' }, { text: 'lumen' }],
    }, 'luminous');
    expect(searchTypeaheadRows(sections).map((row) => row.kind === 'completion' && row.text)).toEqual(['luminous glow', 'lumen']);
  });
});

describe('search typeahead: when the list is shown', () => {
  const shown = { focused: true, query: 'lum', answerQuery: 'lum', closedQuery: null, rowCount: 3 };

  it('is shown for an answer to what the box holds now, while the box has the focus', () => {
    expect(isSearchTypeaheadShown(shown)).toBe(true);
  });

  it('is nothing for a stale answer, an empty one, an empty box or a box without the focus', () => {
    // The answer in hand is for what was typed before: not this text's.
    expect(isSearchTypeaheadShown({ ...shown, query: 'lumi' })).toBe(false);
    expect(isSearchTypeaheadShown({ ...shown, answerQuery: null })).toBe(false);
    // A failed, rate-limited or switched-off request leaves no row.
    expect(isSearchTypeaheadShown({ ...shown, rowCount: 0 })).toBe(false);
    expect(isSearchTypeaheadShown({ ...shown, query: null, answerQuery: null })).toBe(false);
    expect(isSearchTypeaheadShown({ ...shown, focused: false })).toBe(false);
  });

  it('stays closed once closed or committed for this text, and opens again when the text changes', () => {
    expect(isSearchTypeaheadShown({ ...shown, closedQuery: 'lum' })).toBe(false);
    // The person typed on: the close was for the earlier text.
    expect(isSearchTypeaheadShown({ ...shown, query: 'lumi', answerQuery: 'lumi', closedQuery: 'lum' })).toBe(true);
  });
});

describe('search typeahead: what a row does', () => {
  const rows = searchTypeaheadRows(searchTypeaheadSections(answer, 'lum'));

  it('opens a creator’s profile, Posts narrowed to an entity, or a search for a completion', () => {
    expect(searchTypeaheadAction(rows[0])).toEqual({ type: 'creator', username: 'luma-studio' });
    expect(searchTypeaheadAction(rows[2])).toEqual({ type: 'entity', entity: answer.entities[0], madeWith: 'model:luma-ray-2' });
    expect(searchTypeaheadAction(rows[3])).toEqual({ type: 'search', query: 'luminous' });
  });

  it('says each row in words', () => {
    expect(searchTypeaheadRowLabel(rows[0])).toBe('Luma Studio, @luma-studio, following. Open profile');
    // A creator with no name of their own is not said twice.
    expect(searchTypeaheadRowLabel(rows[1])).toBe('@lumen. Open profile');
    expect(searchTypeaheadRowLabel(rows[2])).toBe('Luma Ray 2, model, 14 posts. Show posts made with it');
    expect(searchTypeaheadRowLabel(rows[3])).toBe('Search for luminous');
  });

  it('announces how many suggestions there are, and nothing for none', () => {
    expect(searchTypeaheadStatus(5)).toBe('5 suggestions');
    expect(searchTypeaheadStatus(1)).toBe('1 suggestion');
    expect(searchTypeaheadStatus(0)).toBe('');
  });
});

describe('search typeahead: the keys', () => {
  it('walks the rows from the box and back to it', () => {
    // From the box: Down is the first row, Up the last.
    expect(moveSearchTypeaheadHighlight(null, 'ArrowDown', 4)).toBe(0);
    expect(moveSearchTypeaheadHighlight(null, 'ArrowUp', 4)).toBe(3);
    expect(moveSearchTypeaheadHighlight(0, 'ArrowDown', 4)).toBe(1);
    expect(moveSearchTypeaheadHighlight(2, 'ArrowUp', 4)).toBe(1);
    // Past either end the highlight is back in the box: Enter searches what is typed.
    expect(moveSearchTypeaheadHighlight(3, 'ArrowDown', 4)).toBeNull();
    expect(moveSearchTypeaheadHighlight(0, 'ArrowUp', 4)).toBeNull();
  });

  it('takes Home and End only while a row is highlighted: otherwise they are the caret’s', () => {
    expect(moveSearchTypeaheadHighlight(2, 'Home', 4)).toBe(0);
    expect(moveSearchTypeaheadHighlight(1, 'End', 4)).toBe(3);
    expect(moveSearchTypeaheadHighlight(null, 'Home', 4)).toBeNull();
    expect(moveSearchTypeaheadHighlight(null, 'End', 4)).toBeNull();
  });

  it('never points past the rows there are', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End'] as const) {
      expect(moveSearchTypeaheadHighlight(null, key, 0)).toBeNull();
      expect(moveSearchTypeaheadHighlight(2, key, 0)).toBeNull();
    }
    // A highlight left over from a longer list starts again from the box.
    expect(moveSearchTypeaheadHighlight(9, 'ArrowDown', 3)).toBe(0);
    expect(moveSearchTypeaheadHighlight(9, 'ArrowUp', 3)).toBe(2);
  });
});

describe('search typeahead: the shared module', () => {
  it('is free of React Native, Expo and Node imports, and of \\p{…}', () => {
    const source = readFileSync(join(process.cwd(), 'ugc-mobile/lib/public-search-policy/search-typeahead.ts'), 'utf8');
    const imports = Array.from(source.matchAll(/from '([^']+)'/g), (match) => match[1]);
    expect(imports).toEqual(['./public-search-policy']);
    expect(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toMatch(/\\p\{/);
  });
});
