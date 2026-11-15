import {
  normalizeSearchHistoryQuery,
  searchEntityId,
  type SearchThumbnail,
} from '../../../ugc-mobile/lib/public-search-policy/public-search-policy';
import { searchEntryForChosenText, type SearchEntry } from '../../../ugc-mobile/lib/public-search-policy/search-open-log';
import {
  searchStarterHeading,
  searchStarterPeriod,
  searchStarterSections,
  type SearchStarterResponse,
} from '../../../ugc-mobile/lib/public-search-policy/search-starter';
import {
  SEARCH_TYPEAHEAD_HEADINGS,
  SEARCH_TYPEAHEAD_MAX_ENTITIES,
  SEARCH_TYPEAHEAD_MAX_RECENTS,
  type SearchTypeaheadRow,
  type SearchTypeaheadSection,
} from '../../../ugc-mobile/lib/public-search-policy/search-typeahead';

/**
 * What the top bar's field offers before anything is typed (owner,
 * 2026-11-16: "we still dont see anything when i click on the searchbar"):
 * the search page's start screen, in the shape of the list the field already
 * opens while a person types, so the panel that opens on a click is the one
 * the first letter goes on to fill.
 *
 *   - Recent searches: this browser's newest, as many as the typing list
 *     offers (SEARCH_TYPEAHEAD_MAX_RECENTS), each removable;
 *   - the starter's models and tools, with their pictures, under the heading
 *     the search page gives them ("Popular this week" only when the answer
 *     says so);
 *   - the starter's searches, with their pictures, under theirs.
 *
 * The starter's creators are left out: a creator's row there carries a Follow
 * button, and a list whose rows are chosen from the field has no place for a
 * second control in a row. They stay on the search page.
 *
 * The sections and headings are the starter's own (searchStarterSections,
 * searchStarterHeading); a row is a typeahead row, so it is drawn, named and
 * walked with the keys as one (SearchTypeaheadList, useSearchTypeahead).
 */

/** The most models and tools, and the most searches, the panel draws: a dropdown, not the page. */
export const SEARCH_START_PANEL_MAX_ENTITIES = SEARCH_TYPEAHEAD_MAX_ENTITIES;
export const SEARCH_START_PANEL_MAX_SEARCHES = 4;

/**
 * A row of the panel: a typeahead row, and for a search the starter offers,
 * the picture of a post it finds and the mark that says where it came from.
 */
export type SearchStartPanelRow = SearchTypeaheadRow & {
  /** A starter search's picture: null where it has none (the magnifier is drawn in its frame). */
  thumbnail?: SearchThumbnail | null;
  /** The starter offered it: its search is logged as entered from the starter. */
  starter?: true;
};

export type SearchStartPanelSection = Omit<SearchTypeaheadSection, 'rows'> & { rows: SearchStartPanelRow[] };

const fold = (text: string) => normalizeSearchHistoryQuery(text).toLowerCase();

export function searchStartPanelSections(input: {
  /** This browser's recent searches, most recent first. */
  recents: readonly string[];
  /** The starter's answer, or null while there is none. */
  starter: SearchStarterResponse | null;
}): SearchStartPanelSection[] {
  const recentRows: SearchStartPanelRow[] = [];
  const offered = new Set<string>();
  for (const recent of input.recents) {
    const text = normalizeSearchHistoryQuery(recent);
    const folded = text.toLowerCase();
    if (!text || offered.has(folded)) continue;
    offered.add(folded);
    // The typing list's key for the same search: a recent that the first letter keeps is the same row.
    recentRows.push({ kind: 'completion', key: `recent:${folded}`, text, recent: true });
    if (recentRows.length === SEARCH_TYPEAHEAD_MAX_RECENTS) break;
  }

  const sections: SearchStartPanelSection[] = [];
  if (recentRows.length) sections.push({ id: 'recents', heading: SEARCH_TYPEAHEAD_HEADINGS.recents, rows: recentRows });
  for (const section of searchStarterSections(input.starter)) {
    const heading = searchStarterHeading(section.id, searchStarterPeriod(input.starter, section.id));
    if (section.id === 'entities') {
      sections.push({
        id: 'entities',
        heading,
        rows: section.entities.slice(0, SEARCH_START_PANEL_MAX_ENTITIES)
          .map((entity) => ({ kind: 'entity' as const, key: `start-entity:${searchEntityId(entity)}`, entity })),
      });
    } else if (section.id === 'searches') {
      const rows: SearchStartPanelRow[] = [];
      for (const search of section.searches) {
        const folded = fold(search.text);
        // A search the person made themselves is offered once, as theirs.
        if (!folded || offered.has(folded)) continue;
        offered.add(folded);
        rows.push({ kind: 'completion', key: `start-search:${folded}`, text: search.text, thumbnail: search.thumbnail ?? null, starter: true });
        if (rows.length === SEARCH_START_PANEL_MAX_SEARCHES) break;
      }
      if (rows.length) sections.push({ id: 'completions', heading, rows });
    }
  }
  return sections;
}

/**
 * How a search chosen from the top bar's list was entered, for the search log
 * (search-open-log.ts): `starter` for a search the starter offered, else what
 * the typing list says of a chosen text (`recent`, `suggestion`, `typed`).
 */
export function searchStartPanelEntry(row: SearchStartPanelRow | null, chosen: string, typed: string, recents: readonly string[]): SearchEntry {
  return row?.starter ? 'starter' : searchEntryForChosenText(chosen, typed, recents);
}
