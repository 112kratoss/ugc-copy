import Link from 'next/link';

import type { CreatorSearchResult as CreatorResult } from '@/lib/public-search';
import { getUserInitials } from '@/lib/profile';

export function CreatorSearchResult({ creator }: { creator: CreatorResult }) {
  return (
    <Link
      href={`/creators/${encodeURIComponent(creator.username)}`}
      className="ui-focus-ring flex min-h-20 items-center gap-4 rounded-[22px] border border-white/8 bg-white/[0.035] p-3 transition hover:border-white/15 hover:bg-white/[0.065]"
    >
      {creator.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={creator.avatarUrl}
          alt=""
          className="h-13 w-13 shrink-0 rounded-full border border-white/10 object-cover"
        />
      ) : (
        <span className="flex h-13 w-13 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-sm font-bold text-zinc-200">
          {getUserInitials(creator.displayName)}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-white">{creator.displayName}</span>
        <span className="mt-0.5 block truncate text-xs text-zinc-400">@{creator.username}</span>
        {creator.bio ? <span className="mt-1 block truncate text-xs text-zinc-500">{creator.bio}</span> : null}
      </span>
      <span className="shrink-0 text-xs text-zinc-500">
        {creator.publicPostCount} {creator.publicPostCount === 1 ? 'post' : 'posts'}
      </span>
    </Link>
  );
}
