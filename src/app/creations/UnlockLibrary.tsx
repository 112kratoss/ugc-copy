'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Archive, ArrowRight, BadgeCheck, Loader2, PackageOpen, Sparkles } from 'lucide-react';

import StudioCard, { STUDIO_GRID_CLASS, StudioChip, StudioKindBadge } from '@/app/creations/StudioCard';
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
      <StudioChip tone="amber" icon={<Archive className="h-3 w-3" />}>
        Creator removed the post — yours to keep
      </StudioChip>
    );
  }

  if (item.retired) {
    return (
      <StudioChip tone="muted" icon={<Archive className="h-3 w-3" />}>
        No longer sold — yours to keep
      </StudioChip>
    );
  }

  if (item.hasNewerRevision) {
    return (
      <StudioChip tone="emerald" icon={<Sparkles className="h-3 w-3" />}>
        Creator added an update
      </StudioChip>
    );
  }

  return null;
}

/**
 * The unlocked post's media, or the package mark when there is none — also
 * when the URL no longer resolves, which is exactly the tombstoned and
 * delisted case: the creator's media can be gone while the unlock stays.
 */
function UnlockMedia({ src }: { src: string | null }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || failedSrc === src) {
    return (
      <div className="flex aspect-[4/5] w-full items-center justify-center bg-black/60">
        <PackageOpen className="h-8 w-8 text-zinc-600" />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailedSrc(src)}
      className="aspect-[4/5] w-full object-cover"
    />
  );
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

      <ul className={STUDIO_GRID_CLASS}>
        {items.map((item) => (
          <StudioCard
            key={item.unlockId}
            as="li"
            density="compact"
            // Not /showcase/:id -- that route only serves public, unarchived,
            // moderation-clean posts, so it 404s exactly the tombstoned and
            // delisted purchases this library exists to keep reachable. The
            // /unlocks route checks entitlement and bounces back to the public
            // page when the post is still publicly readable.
            href={`/unlocks/${item.unlockId}`}
            media={<UnlockMedia src={item.post?.mediaUrl ?? null} />}
            badge={(
              <StudioKindBadge tone="emerald" icon={<BadgeCheck className="h-3.5 w-3.5" />}>
                Unlocked
              </StudioKindBadge>
            )}
            chips={(
              <>
                <StudioChip tone={item.purchasePriceUsdCents > 0 ? 'emerald' : 'sky'}>
                  {item.purchasePriceUsdCents > 0
                    ? `${item.purchasePriceUsdCents} tokens (${formatUsdCents(item.purchasePriceUsdCents)})`
                    : 'Free'}
                </StudioChip>
                <UnlockStateBadge item={item} />
              </>
            )}
            title={item.title}
            subtitle={`by ${item.creator.displayName}`}
            summary={item.previewText || undefined}
            meta={[{ label: 'Unlocked', value: formatPurchaseDate(item.purchasedAt) }]}
          />
        ))}
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
