import Link from 'next/link';

import { getUserInitials } from '@/lib/profile';

import { SearchFollowButton, type SearchFollowCreator } from './SearchFollowButton';

type CreatorRow = SearchFollowCreator & {
  avatarUrl: string | null;
  bio?: string | null;
  publicPostCount?: number;
};

/**
 * A creator as search draws one: a card that opens the profile, with Follow
 * beside it. Until 2026-11-15 the card held only the state ("Following") and
 * Follow lived on the profile; the owner's search benchmark asked for Follow
 * on the list itself, as the app's and Pinterest's, X's and Instagram's
 * searches have it.
 *
 * The profile's link fills the card (its `::after`) and the button sits above
 * it, beside the link and never inside it: a press on Follow opens nothing,
 * and the search log counts only a press on the link (`data-search-result`,
 * which a result carries and a start-screen row does not). The card draws the
 * link's focus ring, as a creator tool card does (`.search-row-card` in
 * globals.css). No button on the viewer's own card: nobody follows themself.
 *
 * `min-w-0`: a grid item is otherwise as wide as its longest unbroken line,
 * and a bio cut to one line with Follow beside it pushed a phone's results
 * past the screen's edge.
 */
export function CreatorSearchResult({
  creator,
  label,
  viewerId = null,
  onFollowChange,
  variant = 'result',
}: {
  creator: CreatorRow;
  /** What the link says to a screen reader, in place of its text run together. */
  label?: string;
  /** The signed-in account, whose own card offers no Follow. */
  viewerId?: string | null;
  onFollowChange?: (creatorId: string, following: boolean) => void;
  /** A search result (counted when opened, its post count shown), or a start-screen row. */
  variant?: 'result' | 'starter';
}) {
  const result = variant === 'result';
  const postCount = result && typeof creator.publicPostCount === 'number'
    ? `${creator.publicPostCount} ${creator.publicPostCount === 1 ? 'post' : 'posts'}`
    : null;
  return (
    <div
      className={`search-row-card relative flex min-w-0 items-center rounded-2xl border border-white/8 bg-white/[0.035] transition-[background-color,border-color,scale] duration-150 ease-out hover:border-white/15 hover:bg-white/[0.065] motion-safe:has-[>a:active]:scale-[0.985] ${result ? 'min-h-20 gap-3 p-3 sm:gap-4' : 'min-h-16 gap-3 py-2 pl-3 pr-2'}`}
    >
      <Link
        href={`/creators/${encodeURIComponent(creator.username)}`}
        // A start-screen row is not a result: the search log counts results opened, never ideas.
        {...(result ? { 'data-search-result': 'creator', 'data-search-result-id': creator.id } : { prefetch: false })}
        aria-label={label}
        className={`flex min-w-0 flex-1 items-center outline-none after:absolute after:inset-0 after:rounded-2xl ${result ? 'gap-3 sm:gap-4' : 'gap-3'}`}
      >
        {creator.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={creator.avatarUrl}
            alt=""
            loading={result ? undefined : 'lazy'}
            className={`shrink-0 rounded-full border border-white/10 object-cover ${result ? 'h-13 w-13' : 'h-10 w-10'}`}
          />
        ) : (
          // The initials stand in for a picture, which says nothing to a screen reader either.
          <span
            aria-hidden="true"
            className={`flex shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] font-bold text-zinc-200 ${result ? 'h-13 w-13 text-sm' : 'h-10 w-10 text-xs'}`}
          >
            {getUserInitials(creator.displayName)}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-white">{creator.displayName}</span>
          <span className="mt-0.5 block truncate text-xs text-zinc-400">
            @{creator.username}
            {/* The dot is drawing: the link's name says the two apart with a comma. */}
            {postCount ? <><span aria-hidden="true"> · </span>{postCount}</> : null}
          </span>
          {result && creator.bio ? <span className="mt-1 block truncate text-xs text-zinc-400">{creator.bio}</span> : null}
        </span>
      </Link>
      {creator.id !== viewerId ? (
        <SearchFollowButton creator={creator} onChange={onFollowChange} className="relative z-10" />
      ) : null}
    </div>
  );
}
