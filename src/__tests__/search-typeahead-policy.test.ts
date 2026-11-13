import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { searchSuggestQuery } from '@/lib/search-suggest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  SEARCH_TYPEAHEAD_ANNOUNCE_PAUSE_MS,
  SEARCH_TYPEAHEAD_DEBOUNCE_MS,
  SEARCH_TYPEAHEAD_HEADINGS,
  SEARCH_TYPEAHEAD_KEPT_ANSWERS,
  SEARCH_TYPEAHEAD_KEPT_ANSWER_MS,
  SEARCH_TYPEAHEAD_MAX_COMPLETIONS,
  SEARCH_TYPEAHEAD_MAX_CREATORS,
  SEARCH_TYPEAHEAD_MAX_ENTITIES,
  SEARCH_TYPEAHEAD_MAX_RECENTS,
  SEARCH_TYPEAHEAD_PRESS_SETTLE_MS,
  SEARCH_TYPEAHEAD_SECTION_IDS,
  isSearchTypeaheadPressAccepted,
  isSearchTypeaheadShown,
  moveSearchTypeaheadHighlight,
  parseSearchSuggestResponse,
  placeSearchTypeaheadRows,
  searchTypeaheadUnsettledRows,
  searchTypeaheadAction,
  searchTypeaheadDrawn,
  searchTypeaheadMatchingRecents,
  searchTypeaheadTextRuns,
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
    expect([...SEARCH_TYPEAHEAD_SECTION_IDS]).toEqual(['recents', 'creators', 'entities', 'completions']);
    const sections = searchTypeaheadSections(answer, 'lum');
    expect(sections.map((section) => section.id)).toEqual(['creators', 'entities', 'completions']);
    expect(sections.map((section) => section.heading)).toEqual([
      SEARCH_TYPEAHEAD_HEADINGS.creators, SEARCH_TYPEAHEAD_HEADINGS.entities, SEARCH_TYPEAHEAD_HEADINGS.completions,
    ]);
    expect(SEARCH_TYPEAHEAD_HEADINGS).toEqual({
      recents: 'Recent searches', creators: 'Creators', entities: 'Models and tools', completions: 'Suggested searches',
    });
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

describe('search typeahead: what is drawn while an answer is on its way', () => {
  const kinds = (sections: ReturnType<typeof searchTypeaheadSections>) => (
    searchTypeaheadRows(sections).map((row) => row.key)
  );

  it('draws this text’s own answer as it is, not stale', () => {
    expect(searchTypeaheadDrawn({ query: 'lum', response: answer }, 'lum'))
      .toEqual({ sections: searchTypeaheadSections(answer, 'lum'), stale: false });
  });

  it('keeps the answer to the text before on show, stale, until this text’s arrives', () => {
    // "lum" then "luma": the list does not go and come back at the letter.
    const drawn = searchTypeaheadDrawn({ query: 'lum', response: answer }, 'luma');
    expect(drawn.stale).toBe(true);
    expect(kinds(drawn.sections)).toEqual([
      'creator:c1', 'creator:c2', 'entity:model:luma-ray-2', 'completion:luminous', 'completion:lumen glow',
    ]);
    // And for a letter deleted, which no kept answer covers.
    expect(searchTypeaheadDrawn({ query: 'lum', response: answer }, 'lu').stale).toBe(true);
  });

  it('keeps a stale creator and completion as they are, and an entity only while the text still names it', () => {
    // A creator opens that creator and a completion searches its own words,
    // whatever the box holds; an entity narrows a search for the box's text.
    const typedOn = searchTypeaheadDrawn({ query: 'lum', response: answer }, 'lumi');
    expect(kinds(typedOn.sections)).toEqual(['creator:c1', 'creator:c2', 'completion:luminous', 'completion:lumen glow']);
    // Every word typed begins a word of its name or key, in any order.
    expect(kinds(searchTypeaheadDrawn({ query: 'lum', response: answer }, 'luma ra').sections)).toContain('entity:model:luma-ray-2');
    expect(kinds(searchTypeaheadDrawn({ query: 'lum', response: answer }, 'ray lum').sections)).toContain('entity:model:luma-ray-2');
    expect(kinds(searchTypeaheadDrawn({ query: 'lum', response: answer }, 'luma x').sections)).not.toContain('entity:model:luma-ray-2');
    // The rules of any drawn answer still hold for a stale one: nothing but
    // creators for a handle, no entity under three characters, no completion
    // that is what the box already holds.
    expect(kinds(searchTypeaheadDrawn({ query: 'lum', response: answer }, '@lum').sections)).toEqual(['creator:c1', 'creator:c2']);
    expect(kinds(searchTypeaheadDrawn({ query: 'lum', response: answer }, 'lu').sections)).not.toContain('entity:model:luma-ray-2');
    expect(kinds(searchTypeaheadDrawn({ query: 'lum', response: answer }, 'luminous').sections)).not.toContain('completion:luminous');
  });

  it('draws nothing for an emptied box, no answer, or an answer that failed', () => {
    const nothing = { sections: [], stale: false };
    expect(searchTypeaheadDrawn({ query: 'lum', response: answer }, null)).toEqual(nothing);
    expect(searchTypeaheadDrawn(null, 'lum')).toEqual(nothing);
    // This text's own answer says there is nothing: the list before it goes.
    expect(searchTypeaheadDrawn({ query: 'lum', response: null }, 'lum')).toEqual(nothing);
    expect(searchTypeaheadDrawn({ query: 'lum', response: { ...answer, creators: [], entities: [], completions: [] } }, 'lum'))
      .toEqual(nothing);
    // A failure for the text before is not kept on show either.
    expect(searchTypeaheadDrawn({ query: 'lum', response: null }, 'lumi')).toEqual(nothing);
    // A stale answer with no row left for this text is nothing, and not busy.
    expect(searchTypeaheadDrawn({ query: 'lum', response: { ...answer, creators: [], completions: [] } }, 'lumi')).toEqual(nothing);
  });

  it('keeps an answer to draw again for half a minute at most, and says a count once per pause', () => {
    expect(SEARCH_TYPEAHEAD_KEPT_ANSWER_MS).toBe(30_000);
    expect(SEARCH_TYPEAHEAD_KEPT_ANSWERS).toBe(30);
    // Longer than the pause a request waits for: a count is not said at every letter.
    expect(SEARCH_TYPEAHEAD_ANNOUNCE_PAUSE_MS).toBeGreaterThan(SEARCH_TYPEAHEAD_DEBOUNCE_MS);
  });
});

describe('search typeahead: when the list is shown', () => {
  const shown = { focused: true, query: 'lum', closedQuery: null, rowCount: 3 };

  it('is shown for rows to draw, while the box has the focus', () => {
    expect(isSearchTypeaheadShown(shown)).toBe(true);
  });

  it('is nothing with no row, an empty box or a box without the focus', () => {
    // A failed, rate-limited or switched-off request leaves no row.
    expect(isSearchTypeaheadShown({ ...shown, rowCount: 0 })).toBe(false);
    expect(isSearchTypeaheadShown({ ...shown, query: null })).toBe(false);
    expect(isSearchTypeaheadShown({ ...shown, focused: false })).toBe(false);
  });

  it('stays closed once closed or committed for this text, and opens again when the text changes', () => {
    expect(isSearchTypeaheadShown({ ...shown, closedQuery: 'lum' })).toBe(false);
    // The person typed on: the close was for the earlier text.
    expect(isSearchTypeaheadShown({ ...shown, query: 'lumi', closedQuery: 'lum' })).toBe(true);
  });
});

describe('search typeahead: when a press on a row counts', () => {
  const T = 1_800_000_000_000;
  const SETTLE = SEARCH_TYPEAHEAD_PRESS_SETTLE_MS;
  const rowsOf = (response: SearchSuggestResponse, query: string) => (
    searchTypeaheadRows(searchTypeaheadDrawn({ query: 'lum', response }, query).sections)
  );
  // "lum": two creators, the model, two completions. "lumi", its answer on its way: the model is gone.
  const before = rowsOf(answer, 'lum');
  const typedOn = rowsOf(answer, 'lumi');

  it('counts a press on any row of a list that has just come on show: nothing of it was there to be aimed at', () => {
    const placement = placeSearchTypeaheadRows(null, before, T);
    for (const row of before) expect(isSearchTypeaheadPressAccepted(placement, row.key, T), row.key).toBe(true);
  });

  it('does not count a press on a row that has only just come to stand where it is, and counts it once the row has stood', () => {
    const shown = placeSearchTypeaheadRows(null, before, T);
    // A letter later the model is taken away, and the completions under it move up into its place.
    const moved = placeSearchTypeaheadRows(shown, typedOn, T + 1000);
    // The creators stand where they stood: a press on one counts at once.
    expect(isSearchTypeaheadPressAccepted(moved, 'creator:c1', T + 1000)).toBe(true);
    expect(isSearchTypeaheadPressAccepted(moved, 'creator:c2', T + 1001)).toBe(true);
    // "luminous" now stands where the model stood: a press there was aimed at the model.
    expect(moved.get('completion:luminous')).toEqual({ index: 2, since: T + 1000 });
    expect(isSearchTypeaheadPressAccepted(moved, 'completion:luminous', T + 1000)).toBe(false);
    expect(isSearchTypeaheadPressAccepted(moved, 'completion:luminous', T + 1000 + SETTLE - 1)).toBe(false);
    expect(isSearchTypeaheadPressAccepted(moved, 'completion:luminous', T + 1000 + SETTLE)).toBe(true);
    expect(isSearchTypeaheadPressAccepted(moved, 'completion:lumen glow', T + 1000 + SETTLE - 1)).toBe(false);
  });

  it('does not count a press on a row an answer has just put there, nor on the rows it pushed down', () => {
    const stale = placeSearchTypeaheadRows(placeSearchTypeaheadRows(null, before, T), typedOn, T + 1000);
    // The answer lands with the model back above the completions.
    const landed = placeSearchTypeaheadRows(stale, before, T + 1200);
    expect(isSearchTypeaheadPressAccepted(landed, 'entity:model:luma-ray-2', T + 1200 + SETTLE - 1)).toBe(false);
    expect(isSearchTypeaheadPressAccepted(landed, 'completion:luminous', T + 1200 + SETTLE - 1)).toBe(false);
    expect(isSearchTypeaheadPressAccepted(landed, 'creator:c1', T + 1200)).toBe(true);
    expect(isSearchTypeaheadPressAccepted(landed, 'entity:model:luma-ray-2', T + 1200 + SETTLE)).toBe(true);
  });

  it('keeps the time a row has stood through a draw that leaves it in place', () => {
    const shown = placeSearchTypeaheadRows(null, before, T);
    const moved = placeSearchTypeaheadRows(shown, typedOn, T + 1000);
    // The same rows drawn again (this text's answer lands with the rows the list already had).
    const again = placeSearchTypeaheadRows(moved, typedOn, T + 1100);
    expect(again.get('completion:luminous')).toEqual({ index: 2, since: T + 1000 });
    expect(isSearchTypeaheadPressAccepted(again, 'completion:luminous', T + 1000 + SETTLE)).toBe(true);
  });

  describe('the rows drawn as not taking a press yet', () => {
    const keys = (rows: readonly { key: string }[]) => rows.map((row) => row.key);
    const settledList = (rows: readonly { key: string }[]) => ({ order: keys(rows), unsettled: [] as string[] });

    it('marks none for an answer that leaves the rows where they were', () => {
      expect(searchTypeaheadUnsettledRows(settledList(before), keys(before))).toEqual([]);
      expect(searchTypeaheadUnsettledRows(settledList(typedOn), keys(typedOn))).toEqual([]);
    });

    it('marks only the rows a change moved or brought, and never one that stayed', () => {
      // The model goes: the completions under it move up. The creators above it stay.
      expect(searchTypeaheadUnsettledRows(settledList(before), keys(typedOn)))
        .toEqual(['completion:luminous', 'completion:lumen glow']);
      // The model comes back: it is new, and the completions move down again.
      expect(searchTypeaheadUnsettledRows(settledList(typedOn), keys(before)))
        .toEqual(['entity:model:luma-ray-2', 'completion:luminous', 'completion:lumen glow']);
      // Rows taken from the end move nothing.
      expect(searchTypeaheadUnsettledRows(settledList(before), keys(before).slice(0, 3))).toEqual([]);
      // Rows added at the end are the only ones marked.
      expect(searchTypeaheadUnsettledRows(settledList(before.slice(0, 3)), keys(before)))
        .toEqual(['completion:luminous', 'completion:lumen glow']);
    });

    it('keeps a row marked through a change that leaves it in place before it has stood', () => {
      const stillMarked = { order: keys(typedOn), unsettled: ['completion:luminous', 'completion:lumen glow'] };
      // The last completion goes: "luminous" stays where a change put it a moment ago.
      expect(searchTypeaheadUnsettledRows(stillMarked, keys(typedOn).slice(0, 3))).toEqual(['completion:luminous']);
    });

    it('marks exactly the rows the press rule refuses, at each change of a list that had stood', () => {
      const lists = [before, typedOn, before.slice(0, 3), [...before].reverse(), before.slice(1), before];
      for (const from of lists) {
        for (const to of lists) {
          const stood = placeSearchTypeaheadRows(null, from, T);
          const changed = placeSearchTypeaheadRows(stood, to, T + 1000);
          const refused = to.filter((row) => !isSearchTypeaheadPressAccepted(changed, row.key, T + 1000)).map((row) => row.key);
          expect(searchTypeaheadUnsettledRows(settledList(from), keys(to))).toEqual(refused);
        }
      }
    });
  });

  it('counts no press on a row that is not drawn, or with no list', () => {
    const moved = placeSearchTypeaheadRows(placeSearchTypeaheadRows(null, before, T), typedOn, T + 1000);
    expect(isSearchTypeaheadPressAccepted(moved, 'entity:model:luma-ray-2', T + 5000)).toBe(false);
    expect(isSearchTypeaheadPressAccepted(null, 'creator:c1', T + 5000)).toBe(false);
    // About a person's reaction time: long enough to stop a press on its way, too short to notice.
    expect(SETTLE).toBeGreaterThanOrEqual(200);
    expect(SETTLE).toBeLessThanOrEqual(300);
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

describe('search typeahead: recent searches, and what a box offers', () => {
  const history = ['neon harbor', 'Luminous', 'glowing lumen', 'lum', 'portrait', 'lumen city', 'lumberjack', 'a lumen'];

  it('offers the recent searches the text begins, as a whole or at a word, most recent first, three at most', () => {
    expect(SEARCH_TYPEAHEAD_MAX_RECENTS).toBe(3);
    // "lum" itself is what the box holds: not offered back.
    expect(searchTypeaheadMatchingRecents(history, 'lum')).toEqual(['Luminous', 'glowing lumen', 'lumen city']);
    expect(searchTypeaheadMatchingRecents(['neon harbor', 'glowing lumen', 'a lumen'], 'lum')).toEqual(['glowing lumen', 'a lumen']);
    // Inside a word is not a beginning.
    expect(searchTypeaheadMatchingRecents(['neon harbor', 'portrait', 'anime'], 'a')).toEqual(['anime']);
    expect(searchTypeaheadMatchingRecents(['illuminate'], 'lum')).toEqual([]);
    // Several words typed: from a word on.
    expect(searchTypeaheadMatchingRecents(['a neon harbor at dusk'], 'neon h')).toEqual(['a neon harbor at dusk']);
    expect(searchTypeaheadMatchingRecents(['Neon  Harbor', 'neon harbor'], 'NEON h')).toEqual(['Neon Harbor']);
    expect(searchTypeaheadMatchingRecents(history, null)).toEqual([]);
    expect(searchTypeaheadMatchingRecents([], 'lum')).toEqual([]);
  });

  it('puts the matching recent searches first, as query rows, and does not offer a completion twice', () => {
    const sections = searchTypeaheadSections(answer, 'lum', { recents: ['luminous', 'portrait'] });
    expect(sections.map((section) => section.id)).toEqual(['recents', 'creators', 'entities', 'completions']);
    const rows = searchTypeaheadRows(sections);
    expect(rows[0]).toEqual({ kind: 'completion', key: 'recent:luminous', text: 'luminous', recent: true });
    expect(rows.filter((row) => row.kind === 'completion').map((row) => row.key)).toEqual(['recent:luminous', 'completion:lumen glow']);
    expect(searchTypeaheadAction(rows[0])).toEqual({ type: 'search', query: 'luminous' });
    expect(searchTypeaheadRowLabel(rows[0])).toBe('Search again for luminous');
  });

  it('offers only what changes the query where the box is over its own results: recent searches and completions', () => {
    const sections = searchTypeaheadSections(answer, 'lum', { recents: ['lumen city'], offer: 'query' });
    expect(sections.map((section) => section.id)).toEqual(['recents', 'completions']);
    // Nothing left to offer: no section, so no list.
    expect(searchTypeaheadSections({ ...answer, completions: [] }, 'lum', { offer: 'query' })).toEqual([]);
  });

  it('draws the matching recent searches with or without an answer, and never as stale', () => {
    const options = { recents: ['lumen city'] };
    expect(searchTypeaheadDrawn(null, 'lum', options).sections.map((section) => section.id)).toEqual(['recents']);
    expect(searchTypeaheadDrawn(null, 'lum', options).stale).toBe(false);
    expect(searchTypeaheadDrawn({ query: 'lum', response: null }, 'lum', options).sections.map((section) => section.id)).toEqual(['recents']);
    // An earlier text's answer kept on show is stale; the recent searches beside it are this text's.
    const typedOn = searchTypeaheadDrawn({ query: 'lum', response: answer }, 'lume', options);
    expect(typedOn.stale).toBe(true);
    expect(typedOn.sections[0].id).toBe('recents');
    // An earlier answer that adds nothing the box offers leaves a list that is not stale.
    const queryOnly = searchTypeaheadDrawn({ query: 'lum', response: { ...answer, completions: [] } }, 'lume', { ...options, offer: 'query' });
    expect(queryOnly).toEqual({ sections: [expect.objectContaining({ id: 'recents' })], stale: false });
    expect(searchTypeaheadDrawn(null, null, options)).toEqual({ sections: [], stale: false });
  });
});

describe('search typeahead: which part of a row is drawn heavier', () => {
  it('draws what was typed plain and what the row adds heavier, ignoring case', () => {
    expect(searchTypeaheadTextRuns('luminous', 'lum')).toEqual([{ text: 'lum', typed: true }, { text: 'inous', typed: false }]);
    expect(searchTypeaheadTextRuns('Glowing Lumen', 'lum')).toEqual([
      { text: 'Glowing ', typed: false }, { text: 'Lum', typed: true }, { text: 'en', typed: false },
    ]);
    expect(searchTypeaheadTextRuns('portrait', 'portrait')).toEqual([{ text: 'portrait', typed: true }]);
    // Typed with spaces as the server reads them.
    expect(searchTypeaheadTextRuns('neon harbor', '  neon   h')).toEqual([{ text: 'neon h', typed: true }, { text: 'arbor', typed: false }]);
  });

  it('draws the whole row heavier where it does not hold the text, or where lower case moves its letters', () => {
    expect(searchTypeaheadTextRuns('portrait', 'lum')).toEqual([{ text: 'portrait', typed: false }]);
    // Inside a word is not where it was typed; a later word's start is.
    expect(searchTypeaheadTextRuns('illuminated lumen', 'lum')).toEqual([{ text: 'illuminated ', typed: false }, { text: 'lum', typed: true }, { text: 'en', typed: false }]);
    expect(searchTypeaheadTextRuns('illuminate', 'lum')).toEqual([{ text: 'illuminate', typed: false }]);
    expect(searchTypeaheadTextRuns('portrait', null)).toEqual([{ text: 'portrait', typed: false }]);
    // "İ" lower-cases to two characters: the places found would not be the text's own.
    expect(searchTypeaheadTextRuns('İstanbul night', 'night')).toEqual([{ text: 'İstanbul night', typed: false }]);
    expect(searchTypeaheadTextRuns('', 'lum')).toEqual([]);
  });
});
