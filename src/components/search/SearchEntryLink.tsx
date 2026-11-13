import Link from 'next/link';
import { Search } from 'lucide-react';

import { SEARCH_PLACEHOLDER } from '../../../ugc-mobile/lib/public-search-policy/public-search-policy';

/**
 * A way into search drawn as a search field, for a page whose top bar has only
 * a magnifier at this width (below 1024px the bar's field folds into a
 * button): Explore, as Instagram's, Pinterest's and Reddit's explore pages open
 * on a search bar (search UX audit 2026-11-13, finding 11). It is a link, not
 * a field: the search page opens with the focus in its own box (an empty search
 * there takes the focus), so nothing typed here is lost.
 */
export function SearchEntryLink({ className = '' }: { className?: string }) {
  return (
    <Link
      href="/search"
      prefetch={false}
      data-search-entry=""
      className={`ui-focus-ring flex min-h-12 items-center gap-3 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-4 text-sm text-[var(--ui-text-faint)] transition hover:border-[var(--ui-border-strong)] hover:bg-[var(--ui-surface-3)] ${className}`}
    >
      <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{SEARCH_PLACEHOLDER}</span>
    </Link>
  );
}
