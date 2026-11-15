import { remixToolCreatePath } from '@/lib/remix-tools';

import {
  normalizeSearchHistoryQuery,
  type SearchEntity,
} from '../../../ugc-mobile/lib/public-search-policy/public-search-policy';
import { searchTypeaheadEntityOpening } from '../../../ugc-mobile/lib/public-search-policy/search-typeahead';

/**
 * Where a model's or tool's typeahead row leads on the web (2026-11-15), from
 * either of its boxes, around the shared rule (searchTypeaheadEntityOpening):
 * the web's own paths for a creator and for Posts.
 */

/** Where pressing a model's or tool's row leads on the web. */
export type SearchTypeaheadEntityRoute =
  /** Posts for `query`, narrowed to the row by `madeWith`: the search its count was made for. */
  | { type: 'posts'; query: string; madeWith: string }
  /** The creator of the catalog model's kind, the model chosen (`?model=`): nobody has posted with it. */
  | { type: 'creator'; href: string };

/**
 * The shared opening (searchTypeaheadEntityOpening, for the web) as a place to
 * go. A row that carries a `query` (a name the server matched by an alias, a
 * mistake or a word its posts do not hold: "sdxl" offers Stability AI) is
 * searched for that query; any other row for what the box holds.
 */
export function searchTypeaheadEntityRoute(entity: SearchEntity, boxText: string): SearchTypeaheadEntityRoute {
  const opening = searchTypeaheadEntityOpening(entity, 'web');
  if (opening.type === 'creator') {
    return { type: 'creator', href: `${remixToolCreatePath(opening.model.kind)}?model=${encodeURIComponent(opening.model.id)}` };
  }
  return { type: 'posts', query: opening.query ?? normalizeSearchHistoryQuery(boxText), madeWith: opening.madeWith };
}

/** Whether a row opens the creator rather than posts: a catalog model nobody this viewer may see has posted with. */
export function isSearchTypeaheadCreatorRow(entity: SearchEntity): boolean {
  return searchTypeaheadEntityOpening(entity, 'web').type === 'creator';
}
