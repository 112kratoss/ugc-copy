/**
 * The app's search screen around the search clients' shared rules
 * (`lib/public-search-policy/`), as of 2026-11-15: the start's headings by the
 * period each of its lists is of, where a model's or tool's row of the typing
 * list leads in the app, what a search request asks for besides the search,
 * the related searches drawn over an answer, and whom Follow is offered for on
 * a creator row. Pure, so each rule is a vitest case
 * (`__tests__/search-screen-view-model.test.ts`).
 */
import {
  normalizeSearchHistoryQuery,
  searchEntityActionLabel,
  searchEntityCountLabel,
  searchEntityKindLabel,
  searchRelatedSearches,
  searchRelatedSearchesApply,
  type SearchEntity,
  type SearchRelatedSearch,
  type SearchTabId,
} from './public-search-policy/public-search-policy';
import { searchBlendApplies } from './public-search-policy/search-blend';
import {
  searchStarterHeading,
  searchStarterPeriod,
  searchStarterSections,
  type SearchStarterResponse,
  type SearchStarterSection,
} from './public-search-policy/search-starter';
import { searchTypeaheadEntityOpening } from './public-search-policy/search-typeahead';
import { searchCatalogModelActionLabel, searchCatalogModelLine } from './public-search-policy/search-ui-words';

/**
 * The start's sections, each titled for the period its list is of: "Popular
 * this week" only where the answer says the list is this week's (`periods`),
 * the all-time heading otherwise and for an answer that does not say.
 */
export function searchStarterShownSections(answer: SearchStarterResponse | null | undefined): SearchStarterSection[] {
  return searchStarterSections(answer).map((section) => ({
    ...section,
    heading: searchStarterHeading(section.id, searchStarterPeriod(answer, section.id)),
  }));
}

/** Where pressing a model's or tool's row of the typing list leads in the app. */
export type SearchTypeaheadEntityRoute =
  /** Posts for `query`, narrowed to the row by `madeWith`: the search its count was made for. */
  | { type: 'posts'; query: string; madeWith: string }
  /** The creator of the catalog model's kind, the model chosen (`?model=`): nobody has posted with it. */
  | { type: 'creator'; href: string };

/**
 * The shared opening (searchTypeaheadEntityOpening, for the app) as a place to
 * go. A row that carries its own search (`query`: a name the server matched by
 * an alias, a mistake, two letters or a word its posts do not hold; "sdxl"
 * offers Stability AI) is searched for that; any other row for what the box
 * holds. A catalog model nobody has posted with opens its creator with it
 * chosen (`app/create/[tool].tsx` reads `model`), never an empty Posts page.
 */
export function searchTypeaheadEntityRoute(entity: SearchEntity, boxText: string): SearchTypeaheadEntityRoute {
  const opening = searchTypeaheadEntityOpening(entity, 'mobile');
  if (opening.type === 'creator') {
    return { type: 'creator', href: `/create/${opening.model.kind}?model=${encodeURIComponent(opening.model.id)}` };
  }
  return { type: 'posts', query: opening.query ?? normalizeSearchHistoryQuery(boxText), madeWith: opening.madeWith };
}

/**
 * What a model's or tool's row of the typing list says under its name, and to
 * a screen reader. A row that opens the creator says what it does there
 * ("Video model · Generate with it"), never "0 posts"; any other says what it
 * is and how many posts it opens, as a result's row does.
 */
export function searchTypeaheadEntityWords(entity: SearchEntity): { detail: string; accessibilityLabel: string } {
  const opening = searchTypeaheadEntityOpening(entity, 'mobile');
  if (opening.type === 'creator') {
    return {
      detail: searchCatalogModelLine(opening.model.kind),
      accessibilityLabel: searchCatalogModelActionLabel(entity.label, opening.model.kind),
    };
  }
  return {
    detail: `${searchEntityKindLabel(entity.kind)} · ${searchEntityCountLabel(entity)}`,
    accessibilityLabel: searchEntityActionLabel(entity),
  };
}

/**
 * What a search request asks for besides the search (the shared rules):
 *
 *   - `relatedSearches`: with the first page of a Top or Posts search
 *     (searchRelatedSearchesApply).
 *   - `blend`: the blended Posts order, with every page of a ranked Top or
 *     Posts search of two words or more, not a handle, not read as typed,
 *     that the person settled on (searchBlendApplies). `settled` is the
 *     screen's, by how the search was entered (searchEntrySettles): a link's
 *     search and a model's or tool's row are asked in the word order until
 *     the person commits them (review of #828, S6).
 *
 * Neither for a probe: a search the app asks for itself (an empty tab asking
 * Top what the other tabs hold) spends nothing of the viewer's own, and a
 * meaning lookup counts against their forty a day.
 */
export function searchRequestExtras(search: {
  query: string;
  type: SearchTabId;
  sort: string;
  exact: boolean;
  cursor: string | null;
  /** The person settled on this search (searchEntrySettles). */
  settled: boolean;
  probe?: boolean;
}): { relatedSearches: boolean; blend: boolean } {
  if (search.probe) return { relatedSearches: false, blend: false };
  return {
    relatedSearches: searchRelatedSearchesApply({ type: search.type, firstPage: search.cursor === null }),
    blend: searchBlendApplies({ query: search.query, type: search.type, sort: search.sort, exact: search.exact, settled: search.settled }),
  };
}

const NO_RELATED_SEARCHES: readonly SearchRelatedSearch[] = Object.freeze([]);

/**
 * The related searches drawn over an answer, as chips that search their text:
 * on Top and Posts only, six at most (searchRelatedSearches), none for an
 * answer without them.
 */
export function searchRelatedSearchChips(type: SearchTabId, answer: unknown): readonly SearchRelatedSearch[] {
  if (type !== 'top' && type !== 'posts') return NO_RELATED_SEARCHES;
  const searches = searchRelatedSearches(answer);
  return searches.length ? searches : NO_RELATED_SEARCHES;
}

/**
 * Whether a creator row offers Follow: for anyone but the viewer themself. A
 * visitor and a guest are offered it too, and asked to sign up when they press
 * it, as the creator page asks them.
 */
export function searchCreatorFollowOffered({ viewerId, creatorId }: { viewerId: string | null; creatorId: string }): boolean {
  return viewerId !== creatorId;
}
