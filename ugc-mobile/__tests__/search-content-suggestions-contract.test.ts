import { describe, expect, it } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  SEARCH_RELATED_SEARCHES_MAX,
  SEARCH_RELATED_SEARCHES_PARAM,
  readSearchThumbnail,
  searchRelatedSearches,
  searchRelatedSearchesApply,
} from '../lib/public-search-policy/public-search-policy';
import {
  SEARCH_STARTER_ALL_TIME,
  SEARCH_STARTER_HEADINGS,
  SEARCH_STARTER_WEEK_HEADINGS,
  parseSearchStarterResponse,
  searchStarterHeading,
  searchStarterPeriod,
  searchStarterSections,
} from '../lib/public-search-policy/search-starter';
import {
  SEARCH_TYPEAHEAD_CATALOG_PARAM,
  SEARCH_TYPEAHEAD_MAX_COMPLETIONS,
  isSearchTypeaheadEntityOffered,
  parseSearchSuggestResponse,
  searchTypeaheadEntityOpening,
  searchTypeaheadTextRuns,
} from '../lib/public-search-policy/search-typeahead';

// Suggestions and popular lists made from content (2026-11-15): the fields
// the server added, read here by the rules the app's search screen draws by.
// src/__tests__ holds the server to the same fixture.

const suggest = mobileApiContract.endpoints.suggestSearch;
const starter = mobileApiContract.endpoints.searchStarter;
const search = mobileApiContract.endpoints.searchPublicContent;

describe('typeahead: phrases, names and pictures', () => {
  it('reads the contract’s answers as they are, an entity’s picture included', () => {
    expect(parseSearchSuggestResponse(suggest.response)).toEqual(suggest.response);
    for (const variant of [
      suggest.responseVariants.phrasesAndNames,
      suggest.responseVariants.correctedReading,
      suggest.responseVariants.entityWithoutPicture,
    ]) {
      expect(parseSearchSuggestResponse(variant.response)).toEqual(variant.response);
    }
    const [entity] = parseSearchSuggestResponse(suggest.response)!.entities;
    expect(entity.thumbnail).toEqual(suggest.response.entities[0].thumbnail);
    expect(readSearchThumbnail(suggest.response.entities[0].thumbnail)).toEqual(suggest.response.entities[0].thumbnail);
  });

  it('reads an entity of a server from before pictures with no picture, and still draws it', () => {
    const before = suggest.responseVariants.beforePictures.response;
    expect(parseSearchSuggestResponse(before)!.entities)
      .toEqual([{ ...before.entities[0], thumbnail: null, inCatalog: false, catalogModel: null, query: null }]);
    expect(parseSearchSuggestResponse(suggest.responseVariants.entityWithoutPicture.response)!.entities[0].thumbnail).toBeNull();
  });

  it('draws a completion that does not start with what was typed', () => {
    const { query, response } = suggest.responseVariants.phrasesAndNames;
    const texts = response.completions.map((completion) => completion.text);
    expect(texts).toEqual(['portrait', 'portrait photography', 'cinematic portrait']);
    expect(texts.length).toBeLessThanOrEqual(SEARCH_TYPEAHEAD_MAX_COMPLETIONS);
    expect(suggest.limits.maxCompletions).toBe(SEARCH_TYPEAHEAD_MAX_COMPLETIONS);
    // The typed part plain where a word of the row starts with it.
    expect(searchTypeaheadTextRuns('cinematic portrait', query.q)).toEqual([
      { text: 'cinematic ', typed: false }, { text: 'port', typed: true }, { text: 'rait', typed: false },
    ]);
    // A corrected reading does not hold what was typed: drawn whole.
    const corrected = suggest.responseVariants.correctedReading;
    expect(searchTypeaheadTextRuns(corrected.response.completions[0].text, corrected.query.q))
      .toEqual([{ text: 'portrait', typed: false }]);
  });
});

describe('typeahead: the product’s own models', () => {
  const withPosts = suggest.responseVariants.catalogModelWithPosts;
  const asked = suggest.responseVariants.catalogModels;
  const twoLetters = suggest.responseVariants.catalogModelsOfTwoLetters;

  it('names the parameter the server reads, and reads the contract’s answers as they are', () => {
    expect(suggest.catalogParameter).toBe(SEARCH_TYPEAHEAD_CATALOG_PARAM);
    expect(asked.query).toEqual({ q: 'see', [SEARCH_TYPEAHEAD_CATALOG_PARAM]: '1' });
    for (const variant of [withPosts, asked, twoLetters]) {
      expect(parseSearchSuggestResponse(variant.response)).toEqual(variant.response);
    }
    expect(suggest.errors.unknownCatalog.response).toEqual({ error: 'catalog must be 1.' });
  });

  it('is offered "Seedance" for "see" without asking, when it has a post to open', () => {
    const entities = parseSearchSuggestResponse(withPosts.response)!.entities;
    expect(entities.map((entity) => entity.label)).toEqual(['Seedance 2']);
    expect(entities[0]).toMatchObject({ inCatalog: true, postCount: 1, catalogModel: { id: 'seedance-2', kind: 'video' } });
    expect(searchTypeaheadEntityOpening(entities[0], 'mobile')).toEqual({ type: 'posts', madeWith: 'model:seedance-2', query: null });
  });

  it('opens the creator for a catalog model with no posts, where the app has that model', () => {
    const [seedance, older, webOnly] = parseSearchSuggestResponse(asked.response)!.entities;
    expect(searchTypeaheadEntityOpening(seedance, 'mobile').type).toBe('posts');
    expect(searchTypeaheadEntityOpening(older, 'mobile')).toEqual({
      type: 'creator', model: { id: 'seedance-1.5-pro', kind: 'video', web: true, mobile: true },
    });
    // A model on the web alone has nothing to open in the app: its row is not drawn there.
    expect(isSearchTypeaheadEntityOffered(webOnly, 'mobile')).toBe(false);
    expect(isSearchTypeaheadEntityOffered(webOnly, 'web')).toBe(true);
  });

  it('searches the query a row carries when two letters were typed', () => {
    const [entity] = parseSearchSuggestResponse(twoLetters.response)!.entities;
    expect(twoLetters.query.q).toHaveLength(suggest.limits.minCatalogQueryLength);
    expect(searchTypeaheadEntityOpening(entity, 'mobile')).toEqual({ type: 'posts', madeWith: 'model:seedance-2', query: 'seedance-2' });
  });
});

describe('starter: this week’s lists and their pictures', () => {
  it('reads the contract’s answer as it is: pictures on models, tools and searches, and each list’s period', () => {
    const parsed = parseSearchStarterResponse(starter.response)!;
    expect(parsed).toEqual(starter.response);
    expect(parsed.entities.map((entity) => entity.thumbnail?.postId ?? null))
      .toEqual(['55555555-5555-4555-8555-555555555555', null]);
    expect(parsed.searches.map((row) => row.thumbnail?.url ?? null))
      .toEqual(['https://cdn.example.test/previews/cinematic-portrait.webp', null, null]);
    expect(parsed.periods).toEqual({ entities: 'week', creators: 'week', searches: 'all' });
  });

  it('says "this week" only over a list the answer says is this week’s', () => {
    expect(starter.headings).toEqual(SEARCH_STARTER_HEADINGS);
    expect(starter.weekHeadings).toEqual(SEARCH_STARTER_WEEK_HEADINGS);
    const parsed = parseSearchStarterResponse(starter.response)!;
    expect(searchStarterHeading('entities', searchStarterPeriod(parsed, 'entities'))).toBe(starter.weekHeadings.entities);
    expect(searchStarterHeading('creators', searchStarterPeriod(parsed, 'creators'))).toBe(starter.weekHeadings.creators);
    expect(searchStarterHeading('searches', searchStarterPeriod(parsed, 'searches'))).toBe(starter.headings.searches);
    // The sections' own headings are the ones they were: a screen adopts the week's by asking.
    expect(searchStarterSections(parsed).map((section) => section.heading))
      .toEqual([starter.headings.entities, starter.headings.creators, starter.headings.searches]);
  });

  it('reads the answer of a server from before periods and pictures as all-time, with no picture', () => {
    const parsed = parseSearchStarterResponse(starter.responseVariants.beforePeriods.response)!;
    expect(parsed.periods).toEqual(SEARCH_STARTER_ALL_TIME);
    expect(parsed.entities[0].thumbnail).toBeNull();
    expect(parsed.searches).toEqual([{ text: 'portrait', thumbnail: null }]);
    expect(parseSearchStarterResponse(starter.responseVariants.switchedOff.response)!.periods).toEqual(SEARCH_STARTER_ALL_TIME);
  });
});

describe('related searches', () => {
  const pinned = search.relatedSearches;

  it('names the parameter and the cap the server reads', () => {
    expect(pinned.parameter).toBe(SEARCH_RELATED_SEARCHES_PARAM);
    expect(pinned.max).toBe(SEARCH_RELATED_SEARCHES_MAX);
    expect(pinned.query).toEqual({ q: 'portrait', type: 'top', [SEARCH_RELATED_SEARCHES_PARAM]: '1' });
    expect(search.errors.unknownRelatedSearches.response).toEqual({ error: 'relatedSearches must be 1.' });
  });

  it('reads the field an answer gains, and none from an answer without it', () => {
    expect(searchRelatedSearches(pinned.responseFields)).toEqual(pinned.responseFields.relatedSearches);
    expect(searchRelatedSearches(pinned.none.responseFields)).toEqual([]);
    // The answer of a request that did not ask, and of a server from before them.
    expect(searchRelatedSearches(search.response)).toEqual([]);
    for (const variant of Object.values(search.responseVariants)) {
      expect(searchRelatedSearches(variant.response)).toEqual([]);
    }
  });

  it('applies on the first page of a Top or Posts search', () => {
    expect(searchRelatedSearchesApply({ type: 'top', firstPage: true })).toBe(true);
    expect(searchRelatedSearchesApply({ type: 'posts', firstPage: true })).toBe(true);
    expect(searchRelatedSearchesApply({ type: 'posts', firstPage: false })).toBe(false);
    expect(searchRelatedSearchesApply({ type: 'creators', firstPage: true })).toBe(false);
    expect(searchRelatedSearchesApply({ type: 'recipes', firstPage: true })).toBe(false);
  });
});
