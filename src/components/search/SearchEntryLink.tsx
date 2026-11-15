'use client';

import Link from 'next/link';
import { Search } from 'lucide-react';
import { useState } from 'react';

import { SearchEntrancePart, SearchEntranceStandIn } from '@/components/search/SearchEntrancePart';
import { isPlainPress, isSearchPageShown, markSearchEntrance } from '@/components/search/search-entrance';

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
  // Named for search's entrance only when it can pair: drawn while the search
  // page is (the field shrinks back into it), or once pressed (a press draws
  // it named before the navigation it starts). Explore draws the bar in its
  // loading state and again in its page, and the two copies, named at rest,
  // paired as the page swapped in: a close with nothing to close, its words
  // blinking (review of #817).
  const [named, setNamed] = useState(isSearchPageShown);
  const origin = named ? 'entry' : null;
  return (
    // The skin is an element of its own, under the magnifier and the words,
    // so each travels by itself and only the plain skin is ever stretched.
    <Link
      href="/search"
      prefetch={false}
      data-search-entry=""
      onClick={(event) => {
        if (!isPlainPress(event)) return;
        markSearchEntrance('entry');
        setNamed(true);
      }}
      className={`group ui-focus-ring relative isolate flex min-h-12 items-center gap-3 rounded-full border border-transparent px-4 text-sm text-[var(--ui-text-faint)] ${className}`}
    >
      <SearchEntrancePart origin={origin} part="capsule" side="control">
        <span aria-hidden="true" className="pointer-events-none absolute -inset-px -z-10 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] transition group-hover:border-[var(--ui-border-strong)] group-hover:bg-[var(--ui-surface-3)]" />
      </SearchEntrancePart>
      <SearchEntrancePart origin={origin} part="icon" side="control">
        <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
      </SearchEntrancePart>
      <SearchEntrancePart origin={origin} part="text" side="control">
        <span>{SEARCH_PLACEHOLDER}</span>
      </SearchEntrancePart>
      {/* No clear button: the field's travels into the bar's end and goes. */}
      <SearchEntranceStandIn origin={origin} part="clear" className="inset-y-0 right-0 w-11" />
    </Link>
  );
}
