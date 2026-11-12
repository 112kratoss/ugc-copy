import { Box, Search, Wrench } from 'lucide-react';

import { getUserInitials } from '@/lib/profile';

import { searchEntityCountLabel, searchEntityKindLabel } from '../../../ugc-mobile/lib/public-search-policy/public-search-policy';
import {
  SEARCH_TYPEAHEAD_LIST_LABEL,
  searchTypeaheadRowLabel,
  type SearchTypeaheadRow,
  type SearchTypeaheadSection,
} from '../../../ugc-mobile/lib/public-search-policy/search-typeahead';
import { searchTypeaheadOptionId } from './use-search-typeahead';

const ICON_FRAME_CLASS = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.06]';

function RowBody({ row }: { row: SearchTypeaheadRow }) {
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
    const Icon = row.entity.kind === 'model' ? Box : Wrench;
    return (
      <>
        <span className={`${ICON_FRAME_CLASS} text-[var(--ui-primary)]`}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-white">{row.entity.label}</span>
          <span className="block truncate text-xs text-zinc-400">
            {searchEntityKindLabel(row.entity.kind)} · {searchEntityCountLabel(row.entity)}
          </span>
        </span>
      </>
    );
  }
  return (
    <>
      <span className={`${ICON_FRAME_CLASS} text-zinc-400`}>
        <Search className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-zinc-100">{row.text}</span>
    </>
  );
}

/**
 * The typeahead's list: a listbox the search box controls (the WAI-ARIA
 * combobox pattern). Its rows are options, never focused: the box keeps the
 * focus and names the highlighted one. A press on a row must not take the
 * focus from the box first, or the list would close under the pointer before
 * the press lands, so the list refuses the focus on mouse down.
 */
export function SearchTypeaheadList({
  listId,
  sections,
  activeIndex,
  stale = false,
  onPick,
  onHighlight,
  className = '',
}: {
  listId: string;
  sections: readonly SearchTypeaheadSection[];
  /** The highlighted row, as an index across every section, or null. */
  activeIndex: number | null;
  /**
   * The rows are the answer to the text before this one, kept on show until
   * this text's arrives: the list says it is busy, and dims only if the answer
   * is slow (a dim at every letter would be the flicker the keeping avoids).
   * A row still does what it shows.
   */
  stale?: boolean;
  onPick: (row: SearchTypeaheadRow) => void;
  onHighlight: (index: number) => void;
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
      aria-busy={stale || undefined}
      onMouseDown={(event) => event.preventDefault()}
      className={`search-typeahead-list overflow-y-auto overscroll-contain rounded-3xl border border-white/10 bg-[var(--ui-surface-1)] p-2 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.95)] ${stale ? 'opacity-60 transition-opacity delay-300 duration-200' : ''} ${className}`}
    >
      {sections.map((section, sectionIndex) => {
        const headingId = `${listId}-${section.id}`;
        return (
          <div key={section.id} role="group" aria-labelledby={headingId} className="py-1">
            <div id={headingId} role="presentation" className="px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-500">
              {section.heading}
            </div>
            {section.rows.map((row, rowInSection) => {
              const rowIndex = sectionStarts[sectionIndex] + rowInSection;
              const active = rowIndex === activeIndex;
              return (
                <div
                  key={row.key}
                  id={searchTypeaheadOptionId(listId, rowIndex)}
                  role="option"
                  aria-selected={active}
                  aria-label={searchTypeaheadRowLabel(row)}
                  data-typeahead-row={row.kind}
                  onClick={() => onPick(row)}
                  onMouseMove={() => { if (!active) onHighlight(rowIndex); }}
                  className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-2xl px-3 py-1.5 ${active ? 'bg-white/[0.09]' : 'hover:bg-white/[0.05]'}`}
                >
                  <RowBody row={row} />
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
