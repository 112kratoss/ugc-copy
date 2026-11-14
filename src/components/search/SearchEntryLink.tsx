'use client';

import Link from 'next/link';
import { Search } from 'lucide-react';

import { SearchEntrancePart, SearchEntranceStandIn } from '@/components/search/SearchEntrancePart';
import { isPlainPress, markSearchEntrance } from '@/components/search/search-entrance';

import { SEARCH_PLACEHOLDER } from '../../../ugc-mobile/lib/public-search-policy/public-search-policy';

/**
 * A way into search drawn as a search field, for a page whose top bar has only
 * a magnifier at this width (below 1024px the bar's field folds into a
 * button): Explore, as Instagram's, Pinterest's and Reddit's explore pages open
 * on a search bar (search UX audit 2026-11-13, finding 11). It is a link, not
 * a field: the search page opens with the focus in its own box (an empty search
 * there takes the focus), so nothing typed here is lost. That box grows out of
 * this bar, its magnifier and words travelling with it (search-entrance.ts).
 */
export function SearchEntryLink({ className = '' }: { className?: string }) {
  return (
    // The skin is an element of its own, under the magnifier and the words,
    // so each travels by itself and only the plain skin is ever stretched.
    <Link
      href="/search"
      prefetch={false}
      data-search-entry=""
      onClick={(event) => {
        if (isPlainPress(event)) markSearchEntrance('entry');
      }}
      className={`group ui-focus-ring relative isolate flex min-h-12 items-center gap-3 rounded-full border border-transparent px-4 text-sm text-[var(--ui-text-faint)] ${className}`}
    >
      <SearchEntrancePart origin="entry" part="capsule" side="control">
        <span aria-hidden="true" className="pointer-events-none absolute -inset-px -z-10 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] transition group-hover:border-[var(--ui-border-strong)] group-hover:bg-[var(--ui-surface-3)]" />
      </SearchEntrancePart>
      <SearchEntrancePart origin="entry" part="icon" side="control">
        <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
      </SearchEntrancePart>
      <SearchEntrancePart origin="entry" part="text" side="control">
        <span>{SEARCH_PLACEHOLDER}</span>
      </SearchEntrancePart>
      {/* No clear button: the field's travels into the bar's end and goes. */}
      <SearchEntranceStandIn origin="entry" part="clear" className="inset-y-0 right-0 w-11" />
    </Link>
  );
}
