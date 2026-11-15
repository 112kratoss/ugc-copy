import { describe, expect, it } from 'vitest';

import {
  SEARCH_START_PANEL_MAX_ENTITIES,
  SEARCH_START_PANEL_MAX_SEARCHES,
  searchStartPanelEntry,
  searchStartPanelSections,
} from '@/components/search/search-start-panel';

import { searchTypeaheadAction, searchTypeaheadRowLabel } from '../../ugc-mobile/lib/public-search-policy/search-typeahead';
import type { SearchStarterResponse } from '../../ugc-mobile/lib/public-search-policy/search-starter';

// What the top bar's field offers before anything is typed: the search page's
// start screen as rows of the list the field already opens while typing.

const thumbnail = (n: number) => ({ postId: `p${n}`, url: `https://cdn.example/p${n}.webp`, thumbhash: null, width: 900, height: 1200, mediaKind: 'image' as const });
const entity = (key: string, label: string, postCount: number) => ({
  kind: 'model' as const, key, label, postCount, postCountCapped: false, thumbnail: thumbnail(postCount), query: label.toLowerCase(),
});

const STARTER: SearchStarterResponse = {
  entities: [
    entity('nano-banana-pro', 'Nano Banana Pro', 200),
    entity('kling-2.6', 'Kling 2.6', 64),
    entity('seedance-2', 'Seedance 2', 31),
    entity('seedream-5', 'Seedream 5', 20),
    entity('veo-3', 'Veo 3', 9),
  ],
  creators: [{ id: 'c1', username: 'luna', displayName: 'Luna', bio: null, avatarUrl: null, publicPostCount: 3, isFollowing: false }],
  searches: [
    { text: 'portrait', thumbnail: thumbnail(1) },
    { text: 'Neon Harbor', thumbnail: null },
    { text: 'anime' },
    { text: 'product photo', thumbnail: thumbnail(4) },
    { text: 'cinematic night city', thumbnail: thumbnail(5) },
    { text: 'one too many', thumbnail: null },
  ],
  periods: { entities: 'week', creators: 'all', searches: 'all' },
};

describe('the top bar’s start panel', () => {
  it('offers nothing with no recent search and no starter', () => {
    expect(searchStartPanelSections({ recents: [], starter: null })).toEqual([]);
  });

  it('offers the recent searches alone until the starter lands: the newest three, each as the typing list keys it', () => {
    const sections = searchStartPanelSections({ recents: ['Neon Harbor', 'glowing lumen', 'neon  harbor', 'lumen city', 'fourth'], starter: null });
    expect(sections.map((section) => [section.id, section.heading])).toEqual([['recents', 'Recent searches']]);
    expect(sections[0].rows).toEqual([
      { kind: 'completion', key: 'recent:neon harbor', text: 'Neon Harbor', recent: true },
      { kind: 'completion', key: 'recent:glowing lumen', text: 'glowing lumen', recent: true },
      { kind: 'completion', key: 'recent:lumen city', text: 'lumen city', recent: true },
    ]);
    // Named as the search page names them.
    expect(searchTypeaheadRowLabel(sections[0].rows[0])).toBe('Search again for Neon Harbor');
  });

  it('draws the starter under them in its own order and headings, without its creators, each list capped for a dropdown', () => {
    const sections = searchStartPanelSections({ recents: ['Neon Harbor'], starter: STARTER });
    // "this week" only where the answer says so.
    expect(sections.map((section) => [section.id, section.heading])).toEqual([
      ['recents', 'Recent searches'],
      ['entities', 'Popular this week'],
      ['completions', 'Try searching for'],
    ]);
    const [, entities, searches] = sections;
    expect(entities.rows).toHaveLength(SEARCH_START_PANEL_MAX_ENTITIES);
    expect(entities.rows.map((row) => row.key)).toEqual([
      'start-entity:model:nano-banana-pro', 'start-entity:model:kling-2.6', 'start-entity:model:seedance-2', 'start-entity:model:seedream-5',
    ]);
    expect(searchTypeaheadRowLabel(entities.rows[0])).toBe('Nano Banana Pro, model, 200 posts. Show posts made with it');
    // A search the person made themselves is offered once, as theirs; a picture where the starter has one, null where not.
    expect(searches.rows).toHaveLength(SEARCH_START_PANEL_MAX_SEARCHES);
    expect(searches.rows.map((row) => [row.kind === 'completion' ? row.text : null, row.thumbnail?.postId ?? null, row.starter])).toEqual([
      ['portrait', 'p1', true],
      ['anime', null, true],
      ['product photo', 'p4', true],
      ['cinematic night city', 'p5', true],
    ]);
    expect(searchTypeaheadRowLabel(searches.rows[0])).toBe('Search for portrait');
    expect(searchTypeaheadAction(searches.rows[0])).toEqual({ type: 'search', query: 'portrait' });
  });

  it('says how a chosen search was entered: the starter’s as starter, a recent as recent, a suggestion as before', () => {
    const [recents, , searches] = searchStartPanelSections({ recents: ['Neon Harbor'], starter: STARTER });
    expect(searchStartPanelEntry(searches.rows[0], 'portrait', '', ['Neon Harbor'])).toBe('starter');
    expect(searchStartPanelEntry(recents.rows[0], 'Neon Harbor', '', ['Neon Harbor'])).toBe('recent');
    expect(searchStartPanelEntry({ kind: 'completion', key: 'completion:luminous', text: 'luminous' }, 'luminous', 'lum', [])).toBe('suggestion');
    expect(searchStartPanelEntry(null, 'lum', 'lum', [])).toBe('typed');
  });
});
