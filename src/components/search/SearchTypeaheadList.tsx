import { Box, Clock3, Search, Wrench, X } from 'lucide-react';

import { getUserInitials } from '@/lib/profile';

import {
  SEARCH_RECENTS_CLEAR_ACTION_LABEL,
  SEARCH_RECENTS_CLEAR_LABEL,
  searchEntityCountLabel,
  searchEntityKindLabel,
  searchRecentRemoveLabel,
  type SearchThumbnail,
} from '../../../ugc-mobile/lib/public-search-policy/public-search-policy';
import {
  SEARCH_TYPEAHEAD_LIST_LABEL,
  searchTypeaheadRowLabel,
  searchTypeaheadTextRuns,
  type SearchTypeaheadRow,
  type SearchTypeaheadSectionId,
} from '../../../ugc-mobile/lib/public-search-policy/search-typeahead';
import { searchCatalogModelActionLabel, searchCatalogModelLine } from '../../../ugc-mobile/lib/public-search-policy/search-ui-words';
import { SearchRowPicture } from './SearchRowPicture';
import { isSearchTypeaheadCreatorRow } from './search-typeahead-rows';
import { searchTypeaheadOptionId } from './use-search-typeahead';

const NO_ROWS: readonly string[] = [];

/**
 * A row as the list draws it: a typeahead row, and for a search the top bar's
 * start panel offers (search-start-panel.ts), the picture of a post it finds.
 */
export type SearchTypeaheadListRow = SearchTypeaheadRow & { thumbnail?: SearchThumbnail | null };

export interface SearchTypeaheadListSection<Row extends SearchTypeaheadListRow = SearchTypeaheadListRow> {
  id: SearchTypeaheadSectionId;
  heading: string;
  rows: readonly Row[];
}

/** A row's accessible name: the shared one, but for a catalog model with no posts, which opens its creator. */
function typeaheadRowLabel(row: SearchTypeaheadListRow): string {
  if (row.kind === 'entity' && row.entity.catalogModel && isSearchTypeaheadCreatorRow(row.entity)) {
    return searchCatalogModelActionLabel(row.entity.label, row.entity.catalogModel.kind);
  }
  return searchTypeaheadRowLabel(row);
}

const HEADING_TEXT_CLASS = 'text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-500';

const ICON_FRAME_CLASS = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.06]';

/**
 * A query row's text: what the person typed plain, what the row adds heavier
 * (searchTypeaheadTextRuns). The row's accessible name is its whole label, so
 * the runs are drawing only. Two lines before it is cut: a phrase found in
 * posts can be long, and the words it adds are at its end.
 */
function QueryText({ text, query }: { text: string; query: string | null }) {
  return (
    <span className="line-clamp-2 min-w-0 flex-1 break-words text-sm leading-5 text-zinc-300">
      {searchTypeaheadTextRuns(text, query).map((run, index) => (
        <span key={index} className={run.typed ? undefined : 'font-semibold text-white'}>{run.text}</span>
      ))}
    </span>
  );
}

function RowBody({ row, query }: { row: SearchTypeaheadListRow; query: string | null }) {
  if (row.kind === 'creator') {
    const { creator } = row;
    return (
      <>
        {creator.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={creator.avatarUrl} alt="" className="h-9 w-9 shrink-0 rounded-full border border-white/10 object-cover" />
        ) : (
          <span className={`${ICON_FRAME_CLASS} text-xs font-bold text-zinc-200`}>{getUserInitials(creator.displayName)}</span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-white">{creator.displayName}</span>
            {creator.isFollowing ? (
              <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.06] px-2 py-0.5 text-[11px] font-semibold text-zinc-300">
                Following
              </span>
            ) : null}
          </span>
          <span className="block truncate text-xs text-zinc-400">@{creator.username}</span>
        </span>
      </>
    );
  }
  if (row.kind === 'entity') {
    const { entity } = row;
    // A model of the catalog nobody has posted with opens its creator: it says so, never "0 posts".
    const model = isSearchTypeaheadCreatorRow(entity) ? entity.catalogModel ?? null : null;
    return (
      <>
        {/* The name drawn whole: it need not hold what was typed ("sdxl" offers Stability AI). */}
        <SearchRowPicture thumbnail={entity.thumbnail} icon={entity.kind === 'model' ? Box : Wrench} className="h-9 w-9 rounded-lg" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-white">{entity.label}</span>
          <span className="block truncate text-xs text-zinc-400">
            {model ? searchCatalogModelLine(model.kind) : `${searchEntityKindLabel(entity.kind)} · ${searchEntityCountLabel(entity)}`}
          </span>
        </span>
      </>
    );
  }
  // A recent search wears a clock, a suggested one a magnifier, and a search
  // the start panel offers the picture of a post it finds, in the same round frame.
  const Icon = row.recent ? Clock3 : Search;
  return (
    <>
      {row.thumbnail !== undefined ? (
        <SearchRowPicture thumbnail={row.thumbnail} icon={Search} className="h-9 w-9 rounded-full" iconClassName="h-4 w-4 text-zinc-400" />
      ) : (
        <span className={`${ICON_FRAME_CLASS} text-zinc-400`}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
      )}
      <QueryText text={row.text} query={query} />
    </>
  );
}

/**
 * The typeahead's list: a listbox the search box controls (the WAI-ARIA
 * combobox pattern). Its rows are options, never focused: the box keeps the
 * focus and names the highlighted one. A press on a row must not take the
 * focus from the box first, or the list would close under the pointer before
 * the press lands, so the list refuses the focus on mouse down.
 *
 * It is drawn at full strength, always (owner, 2026-11-16: "the search area
 * fades, dimms those are not ideal search ui ux"). The rows of the text before
 * stay on show until this text's answer replaces them in place, and neither
 * the list nor a row is made fainter meanwhile: opacity on the list let the
 * page show through it, and a row dimmed at each letter read as a flicker.
 * What a list still says while it changes, it says to assistive technology
 * (`busy`), and a press on a row that has only just moved is ignored as before
 * (`useSearchTypeahead`'s `press`). It has no entrance and no exit either: a
 * search list is opened many times a visit and mostly from the keyboard, and
 * the ones people know (Google's, YouTube's, Pinterest's) are simply there.
 */
export function SearchTypeaheadList<Row extends SearchTypeaheadListRow = SearchTypeaheadListRow>({
  listId,
  sections,
  query = null,
  activeIndex,
  busy = false,
  settlingRows = NO_ROWS,
  onPick,
  onHighlight,
  onRemoveRecent,
  onClearRecents,
  className = '',
}: {
  listId: string;
  sections: readonly SearchTypeaheadListSection<Row>[];
  /** What the box asks about (searchTypeaheadQuery): the part of a query row it holds is drawn plain. */
  query?: string | null;
  /** The highlighted row, as an index across every section, or null. */
  activeIndex: number | null;
  /**
   * The list is changing or has just changed: its rows are the answer to the
   * text before this one, or a row came to stand in a new place a moment ago,
   * where a press does not count yet. Said to assistive technology only.
   */
  busy?: boolean;
  /**
   * The keys of the rows that came to stand in a new place a moment ago and
   * take no press yet. Marked for a test to read (`data-settling`); drawn as
   * every other row.
   */
  settlingRows?: readonly string[];
  onPick: (row: Row) => void;
  onHighlight: (index: number) => void;
  /** A recent search's row gets a button that forgets it (the top bar's panel). */
  onRemoveRecent?: (query: string) => void;
  /** The recent searches' heading gets "Clear all" (the top bar's panel). */
  onClearRecents?: () => void;
  className?: string;
}) {
  // Where each section's rows start in the one list the arrow keys walk.
  const sectionStarts = sections.map((_, sectionIndex) => (
    sections.slice(0, sectionIndex).reduce((count, earlier) => count + earlier.rows.length, 0)
  ));
  return (
    <div
      id={listId}
      role="listbox"
      aria-label={SEARCH_TYPEAHEAD_LIST_LABEL}
      aria-busy={busy || undefined}
      onMouseDown={(event) => event.preventDefault()}
      className={`search-typeahead-list overflow-y-auto overscroll-contain rounded-3xl border border-white/10 bg-[var(--ui-surface-1)] p-2 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.95)] ${className}`}
    >
      {sections.map((section, sectionIndex) => {
        const headingId = `${listId}-${section.id}`;
        const clearable = section.id === 'recents' && onClearRecents !== undefined;
        return (
          <div key={section.id} role="group" aria-labelledby={headingId} className="py-1">
            {clearable ? (
              // The heading with "Clear all" beside it, as the search page's recent searches have it.
              <div className="flex items-center justify-between gap-2 pl-3">
                <div id={headingId} role="presentation" className={HEADING_TEXT_CLASS}>{section.heading}</div>
                <button
                  type="button"
                  aria-label={SEARCH_RECENTS_CLEAR_ACTION_LABEL}
                  onClick={onClearRecents}
                  className="ui-focus-ring inline-flex min-h-11 shrink-0 items-center rounded-full px-3 text-xs font-semibold text-zinc-400 transition-colors duration-150 hover:text-white"
                >
                  {SEARCH_RECENTS_CLEAR_LABEL}
                </button>
              </div>
            ) : (
              <div id={headingId} role="presentation" className={`px-3 pb-1 pt-2 ${HEADING_TEXT_CLASS}`}>{section.heading}</div>
            )}
            {section.rows.map((row, rowInSection) => {
              const rowIndex = sectionStarts[sectionIndex] + rowInSection;
              const active = rowIndex === activeIndex;
              const settling = settlingRows.includes(row.key);
              const removable = row.kind === 'completion' && row.recent === true && onRemoveRecent !== undefined;
              const option = (
                <div
                  key={row.key}
                  id={searchTypeaheadOptionId(listId, rowIndex)}
                  role="option"
                  aria-selected={active}
                  aria-label={typeaheadRowLabel(row)}
                  data-typeahead-row={row.kind === 'completion' && row.recent ? 'recent' : row.kind}
                  data-settling={settling || undefined}
                  onClick={() => onPick(row)}
                  onMouseMove={() => { if (!active) onHighlight(rowIndex); }}
                  className={`flex min-h-12 min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-2xl px-3 py-1.5 ${active ? 'bg-white/[0.09]' : 'hover:bg-white/[0.05]'}`}
                >
                  <RowBody row={row} query={query} />
                </div>
              );
              if (!removable) return option;
              return (
                // The row and, beside it, the button that forgets it: a second
                // control, so it is the row's sibling and never inside the option.
                <div key={row.key} role="presentation" className="flex items-center gap-1">
                  {option}
                  <button
                    type="button"
                    aria-label={searchRecentRemoveLabel(row.text)}
                    onClick={() => onRemoveRecent(row.text)}
                    className="ui-focus-ring inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors duration-150 hover:bg-white/10 hover:text-white"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
