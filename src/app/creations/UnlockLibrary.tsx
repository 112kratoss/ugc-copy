'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Archive, ArrowRight, BadgeCheck, Loader2, PackageOpen, Sparkles } from 'lucide-react';

import { formatUsdCents } from '@/lib/post-resource-bundles';
import { supabase } from '@/lib/supabase';

type UnlockItem = {
  unlockId: string;
  bundleId: string | null;
  postId: string | null;
  title: string;
  previewText: string;
  accessMode: 'free' | 'paid';
  priceUsdCents: number;
  purchasedAt: string;
  purchasePriceUsdCents: number;
  hasNewerRevision: boolean;
  retired: boolean;
  tombstoned: boolean;
  post: {
    title: string;
    mediaUrl: string | null;
  } | null;
  creator: {
    username: string | null;
    displayName: string;
  };
};

type UnlockPage = {
  items: UnlockItem[];
  pageInfo: {
    total: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
};

function formatPurchaseDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * A creator can delist or delete a post after someone unlocked it, so this list
 * is the only place a buyer is guaranteed to find what they paid for. Both
 * states are labelled rather than hidden — an unexplained missing item reads as
 * a bug, and the point of the tombstone is that nothing was actually lost.
 */
function UnlockStateBadge({ item }: { item: UnlockItem }) {
  if (item.tombstoned) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/25 bg-amber-300/10 px-2.5 py-1 text-[11px] font-semibold text-amber-200">
        <Archive className="h-3 w-3" />
        Creator removed the post — yours to keep
      </span>
    );
  }

  if (item.retired) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300/20 bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-zinc-300">
        <Archive className="h-3 w-3" />
        No longer sold — yours to keep
      </span>
    );
  }

  if (item.hasNewerRevision) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300/25 bg-emerald-300/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-200">
        <Sparkles className="h-3 w-3" />
        Creator added an update
      </span>
    );
  }

  return null;
}

export default function UnlockLibrary() {
  const [items, setItems] = useState<UnlockItem[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(async (offset: number) => {
    const { data: { session } } = await supabase.auth.getSession();
    const response = await fetch(`/api/me/unlocks?offset=${offset}`, {
      headers: session?.access_token
        ? { Authorization: `Bearer ${session.access_token}` }
        : undefined,
    });

    if (!response.ok) {
      throw new Error('Failed to load your unlocks.');
    }

    return await response.json() as UnlockPage;
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const page = await loadPage(0);
        if (cancelled) return;
        setItems(page.items);
        setTotal(page.pageInfo.total);
        setNextOffset(page.pageInfo.nextOffset);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load your unlocks.');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadPage]);

  const loadMore = async () => {
    if (nextOffset === null || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const page = await loadPage(nextOffset);
      setItems((current) => [...current, ...page.items]);
      setNextOffset(page.pageInfo.nextOffset);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load more unlocks.');
    } finally {
      setIsLoadingMore(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-zinc-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading your unlocks...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-red-400/20 bg-red-500/5 px-4 py-6 text-sm text-red-200">
        {error}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-3xl border border-white/8 bg-zinc-900/40 px-6 py-14 text-center">
        <PackageOpen className="mx-auto h-8 w-8 text-zinc-600" />
        <h3 className="mt-4 text-base font-semibold text-white">No unlocks yet</h3>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-zinc-400">
          When you unlock a creator&apos;s prompt, workflow, or reference files, it lands here — and
          stays here, even if they later change or remove the post.
        </p>
        <Link
          href="/marketplace"
          className="mt-6 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-black transition hover:bg-zinc-200"
        >
          Browse unlocks
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-sm text-zinc-500">
        {total} {total === 1 ? 'unlock' : 'unlocks'} · yours permanently
      </div>

      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => {
          // Not /showcase/:id -- that route only serves public, unarchived,
          // moderation-clean posts, so it 404s exactly the tombstoned and
          // delisted purchases this library exists to keep reachable. The
          // /unlocks route checks entitlement and bounces back to the public
          // page when the post is still publicly readable.
          const href = `/unlocks/${item.unlockId}`;
          const card = (
            <div className="flex h-full flex-col gap-3 rounded-2xl border border-white/8 bg-zinc-900/50 p-4 transition hover:border-white/16 hover:bg-zinc-900/70">
              <div className="flex items-start gap-3">
                {item.post?.mediaUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.post.mediaUrl}
                    alt=""
                    className="h-14 w-14 flex-shrink-0 rounded-xl object-cover"
                  />
                ) : (
                  <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-xl border border-white/8 bg-white/[0.03]">
                    <PackageOpen className="h-5 w-5 text-zinc-600" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-semibold text-white">{item.title}</h3>
                  <p className="mt-0.5 truncate text-xs text-zinc-500">
                    by {item.creator.displayName}
                  </p>
                </div>
              </div>

              {item.previewText ? (
                <p className="line-clamp-2 text-xs leading-5 text-zinc-400">{item.previewText}</p>
              ) : null}

              <div className="mt-auto space-y-2">
                <UnlockStateBadge item={item} />
                <div className="flex items-center justify-between text-[11px] text-zinc-500">
                  <span className="inline-flex items-center gap-1">
                    <BadgeCheck className="h-3 w-3 text-emerald-300/70" />
                    {item.purchasePriceUsdCents > 0
                      ? `${item.purchasePriceUsdCents} tokens (${formatUsdCents(item.purchasePriceUsdCents)})`
                      : 'Free'}
                  </span>
                  <span>{formatPurchaseDate(item.purchasedAt)}</span>
                </div>
              </div>
            </div>
          );

          return (
            <li key={item.unlockId}>
              <Link href={href} className="block h-full">{card}</Link>
            </li>
          );
        })}
      </ul>

      {nextOffset !== null ? (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            onClick={loadMore}
            disabled={isLoadingMore}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-zinc-900/60 px-5 py-2.5 text-sm font-semibold text-zinc-200 transition hover:border-white/20 hover:bg-zinc-800 disabled:opacity-60"
          >
            {isLoadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Load more
          </button>
        </div>
      ) : null}
    </div>
  );
}
