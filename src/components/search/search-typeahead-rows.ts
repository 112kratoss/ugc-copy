import { remixToolCreatePath } from '@/lib/remix-tools';

import {
  normalizeSearchHistoryQuery,
  type SearchEntity,
} from '../../../ugc-mobile/lib/public-search-policy/public-search-policy';
import {
  searchTypeaheadEntityOpening,
  type SearchTypeaheadSection,
} from '../../../ugc-mobile/lib/public-search-policy/search-typeahead';

/**
 * The web's reading of a typeahead answer asked with `catalog=1` (2026-11-15),
 * around the shared rules (`search-typeahead.ts`): where a model's or tool's row
 * leads from either of the web's boxes, and a name the answer offers twice.
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

function foldedName(text: string): string {
  return normalizeSearchHistoryQuery(text).toLowerCase();
}

/**
 * The sections with a suggested search left out where it is the name, or the
 * search, of a model or tool row drawn above it. The server leaves both in
 * ("nano banana pro" as a model and as a completion), since a box that draws
 * no model or tool rows (the search page's Top) still wants the completion;
 * a box that draws both shows the name once, as the row that says what it is.
 * A recent search stays: it is the person's own. A section left with no row
 * is left out, and a list with no model or tool is returned as it was.
 */
export function withoutRepeatedEntityNames(sections: readonly SearchTypeaheadSection[]): readonly SearchTypeaheadSection[] {
  const names = new Set<string>();
  for (const section of sections) {
    for (const row of section.rows) {
      if (row.kind !== 'entity') continue;
      names.add(foldedName(row.entity.label));
      if (row.entity.query) names.add(foldedName(row.entity.query));
    }
  }
  if (names.size === 0) return sections;
  return sections
    .map((section) => (section.id !== 'completions' ? section : {
      ...section,
      rows: section.rows.filter((row) => row.kind !== 'completion' || row.recent || !names.has(foldedName(row.text))),
    }))
    .filter((section) => section.rows.length > 0);
}
