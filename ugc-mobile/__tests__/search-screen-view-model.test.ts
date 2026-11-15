import { describe, expect, it } from 'vitest';

import type { SearchEntity } from '../lib/public-search-policy/public-search-policy';
import type { SearchStarterResponse } from '../lib/public-search-policy/search-starter';
import {
  searchCreatorFollowOffered,
  searchRelatedSearchChips,
  searchRequestExtras,
  searchStarterShownSections,
  searchTypeaheadEntityRoute,
  searchTypeaheadEntityWords,
} from '../lib/search-screen-view-model';

// The app's search screen around the shared rules (2026-11-15): the start's
// headings by the period each list is of, where a model's or tool's row leads
// in the app, what a search request asks for besides the search, the related
// searches drawn over a Top or Posts answer, and whom Follow is offered for.

const starter: SearchStarterResponse = {
  entities: [{ kind: 'model', key: 'kling-2.6', label: 'Kling 2.6', postCount: 12, postCountCapped: false, thumbnail: null, query: 'kling 2.6' }],
  creators: [{ id: 'c1', username: 'luna', displayName: 'Luna', bio: null, avatarUrl: null, publicPostCount: 4, isFollowing: false }],
  searches: [{ text: 'neon city', thumbnail: null }],
};

describe('the start\'s sections', () => {
  it('say "this week" only of a list the answer says is this week\'s', () => {
    const shown = searchStarterShownSections({ ...starter, periods: { entities: 'week', creators: 'all', searches: 'week' } });
    expect(shown.map((section) => [section.id, section.heading])).toEqual([
      ['entities', 'Popular this week'],
      ['creators', 'Creators to follow'],
      ['searches', 'Popular searches this week'],
    ]);
  });

  it('are all-time for an answer that does not say, and leave out an empty list', () => {
    expect(searchStarterShownSections({ ...starter, creators: [] }).map((section) => section.heading))
      .toEqual(['Popular models and tools', 'Try searching for']);
    expect(searchStarterShownSections(null)).toEqual([]);
  });
});

const seedance: SearchEntity = {
  kind: 'model',
  key: 'seedance-2',
  label: 'Seedance 2',
  postCount: 0,
  postCountCapped: false,
  thumbnail: null,
  inCatalog: true,
  catalogModel: { id: 'seedance-2', kind: 'video', web: true, mobile: true },
  query: null,
};
const kling: SearchEntity = {
  kind: 'model',
  key: 'kling-2.6',
  label: 'Kling 2.6',
  postCount: 12,
  postCountCapped: false,
  thumbnail: null,
  inCatalog: true,
  catalogModel: { id: 'kling-2.6', kind: 'video', web: true, mobile: true },
  query: 'kling',
};

describe('a model\'s or tool\'s row in the typing list', () => {
  it('opens the creator with the model chosen when nobody has posted with it, never an empty Posts page', () => {
    expect(searchTypeaheadEntityRoute(seedance, 'see')).toEqual({ type: 'creator', href: '/create/video?model=seedance-2' });
    const odd = { ...seedance, catalogModel: { id: 'a b/c', kind: 'image' as const, web: false, mobile: true } };
    expect(searchTypeaheadEntityRoute(odd, 'a')).toEqual({ type: 'creator', href: '/create/image?model=a%20b%2Fc' });
  });

  it('opens Posts for the row\'s own search when it carries one, else for what is typed', () => {
    expect(searchTypeaheadEntityRoute(kling, 'klng')).toEqual({ type: 'posts', query: 'kling', madeWith: 'model:kling-2.6' });
    expect(searchTypeaheadEntityRoute({ ...kling, query: null }, '  Kling   2.6 ')).toEqual({ type: 'posts', query: 'Kling 2.6', madeWith: 'model:kling-2.6' });
  });

  it('says "Generate with it" for a model it opens the creator for, never "0 posts"', () => {
    expect(searchTypeaheadEntityWords(seedance)).toEqual({
      detail: 'Video model · Generate with it',
      accessibilityLabel: 'Seedance 2, video model, no posts yet. Open the video creator with it',
    });
    expect(searchTypeaheadEntityWords(kling)).toEqual({
      detail: 'Model · 12 posts',
      accessibilityLabel: 'Kling 2.6, model, 12 posts. Show posts made with it',
    });
  });
});

describe('what a search request asks for besides the search', () => {
  const search = { query: 'neon city', type: 'top' as const, sort: 'top' as const, exact: false, cursor: null, settled: true };

  it('asks for related searches with the first page of Top or Posts only', () => {
    expect(searchRequestExtras(search).relatedSearches).toBe(true);
    expect(searchRequestExtras({ ...search, type: 'posts' }).relatedSearches).toBe(true);
    expect(searchRequestExtras({ ...search, type: 'posts', sort: 'latest' }).relatedSearches).toBe(true);
    expect(searchRequestExtras({ ...search, cursor: 'next' }).relatedSearches).toBe(false);
    expect(searchRequestExtras({ ...search, type: 'creators' }).relatedSearches).toBe(false);
    expect(searchRequestExtras({ ...search, type: 'recipes' }).relatedSearches).toBe(false);
  });

  it('asks for the blended order with every page of a ranked search of two words or more', () => {
    expect(searchRequestExtras(search).blend).toBe(true);
    expect(searchRequestExtras({ ...search, cursor: 'next', type: 'posts' }).blend).toBe(true);
    expect(searchRequestExtras({ ...search, query: 'neon' }).blend).toBe(false);
    expect(searchRequestExtras({ ...search, type: 'posts', sort: 'latest' }).blend).toBe(false);
    expect(searchRequestExtras({ ...search, exact: true }).blend).toBe(false);
    expect(searchRequestExtras({ ...search, query: '@neon city' }).blend).toBe(false);
    expect(searchRequestExtras({ ...search, type: 'creators' }).blend).toBe(false);
  });

  it('asks for the blended order only for a search the person settled on: not a link\'s, not a model\'s or tool\'s row (review of #828, S6)', () => {
    expect(searchRequestExtras({ ...search, settled: false })).toEqual({ relatedSearches: true, blend: false });
    expect(searchRequestExtras({ ...search, type: 'posts', cursor: 'next', settled: false }).blend).toBe(false);
  });

  it('asks for neither with a probe: a search the person never ran spends nothing of theirs', () => {
    expect(searchRequestExtras({ ...search, probe: true })).toEqual({ relatedSearches: false, blend: false });
  });
});

describe('related searches over an answer', () => {
  const searches = Array.from({ length: 8 }, (_, index) => ({ text: `idea ${index + 1}` }));

  it('are drawn over a Top or Posts answer, six at most', () => {
    expect(searchRelatedSearchChips('top', { relatedSearches: searches }).map((chip) => chip.text))
      .toEqual(['idea 1', 'idea 2', 'idea 3', 'idea 4', 'idea 5', 'idea 6']);
    expect(searchRelatedSearchChips('posts', { relatedSearches: searches.slice(0, 2) })).toHaveLength(2);
  });

  it('are nothing on another tab, and nothing for an answer without them', () => {
    expect(searchRelatedSearchChips('creators', { relatedSearches: searches })).toEqual([]);
    expect(searchRelatedSearchChips('top', {})).toEqual([]);
    expect(searchRelatedSearchChips('top', null)).toEqual([]);
  });
});

describe('Follow on a creator row', () => {
  it('is offered for anyone but the viewer themself: a visitor is asked to sign up', () => {
    expect(searchCreatorFollowOffered({ viewerId: 'u1', creatorId: 'c1' })).toBe(true);
    expect(searchCreatorFollowOffered({ viewerId: null, creatorId: 'c1' })).toBe(true);
    expect(searchCreatorFollowOffered({ viewerId: 'c1', creatorId: 'c1' })).toBe(false);
  });
});
