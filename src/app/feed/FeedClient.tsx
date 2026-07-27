'use client';

import { Loader2, PenLine } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '@/app/components/AuthProvider';
import { useOptimisticPostSave } from '@/app/components/useOptimisticPostSave';
import FeedPostCard from '@/app/feed/FeedPostCard';
import { FEED_CHIPS, FEED_PAGE_SIZE, getFeedChip, type FeedChipId } from '@/lib/post-feed-chips';
import { buildPostFeedCards } from '@/lib/post-feed-presentation';
import { buildShowcaseDetailPath } from '@/lib/share';
import type { ShowcaseFeedItem, ShowcaseFeedPage } from '@/lib/showcase';

interface FeedClientProps {
    initialFeed: ShowcaseFeedPage;
    initialChipId: FeedChipId;
}

function toggleInSet(current: Set<string>, id: string) {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
}

export default function FeedClient({ initialFeed, initialChipId }: FeedClientProps) {
    const { session, user } = useAuth();
    const accessToken = session?.access_token ?? null;

    const [chipId, setChipId] = useState<FeedChipId>(initialChipId);
    const [feedItems, setFeedItems] = useState<ShowcaseFeedItem[]>(initialFeed.items);
    const [nextOffset, setNextOffset] = useState<number | null>(
        initialFeed.pageInfo.hasMore ? initialFeed.pageInfo.nextOffset : null
    );
    const [loadingMore, setLoadingMore] = useState(false);
    const [switching, setSwitching] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
    const [commentsOpenIds, setCommentsOpenIds] = useState<Set<string>>(() => new Set());
    const loadingRef = useRef(false);
    const sentinelRef = useRef<HTMLDivElement | null>(null);

    const {
        items,
        setItems,
        savedItemIds,
        savingItemIds,
        toggleSave,
    } = useOptimisticPostSave<ShowcaseFeedItem>({
        initialItems: feedItems,
        accessToken,
        isSignedIn: Boolean(user),
        onAuthRequired: () => { window.location.href = '/login'; },
        onError: (error) => {
            console.error('Failed to save feed post:', error);
            setLoadError('Could not update that save. Try again.');
        },
        sourceSurface: 'feed',
    });

    const cards = useMemo(() => buildPostFeedCards(items), [items]);

    const fetchPage = useCallback(async (targetChipId: FeedChipId, offset: number, replace: boolean) => {
        if (loadingRef.current) return;
        loadingRef.current = true;
        if (replace) setSwitching(true); else setLoadingMore(true);
        setLoadError(null);

        try {
            const chip = getFeedChip(targetChipId);
            const params = new URLSearchParams({
                limit: String(FEED_PAGE_SIZE),
                offset: String(offset),
                sort: chip.sort,
            });
            if (chip.unlock !== 'all') params.set('unlock', chip.unlock);

            const response = await fetch(
                `/api/showcase/feed?${params.toString()}`,
                accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined
            );
            if (!response.ok) throw new Error(`Feed request failed with ${response.status}`);

            const page = await response.json() as ShowcaseFeedPage;
            setFeedItems((current) => (replace
                ? page.items
                // The ranker can repeat an item across pages; the id guard keeps
                // React keys unique rather than trusting the page boundary.
                : [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))]));
            setNextOffset(page.pageInfo.hasMore ? page.pageInfo.nextOffset : null);
        } catch (error) {
            console.error('Failed to load feed page:', error);
            setLoadError('Could not load more posts. Scroll up — what you have is still here.');
        } finally {
            loadingRef.current = false;
            setLoadingMore(false);
            setSwitching(false);
        }
    }, [accessToken]);

    // `useOptimisticPostSave` snapshots `initialItems`, so replacing the fetched
    // list is what pushes new pages (and lane switches) into the rendered items.
    useEffect(() => {
        setItems(feedItems);
    }, [feedItems, setItems]);

    useEffect(() => {
        const sentinel = sentinelRef.current;
        if (!sentinel || nextOffset === null) return;

        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                void fetchPage(chipId, nextOffset, false);
            }
        }, { rootMargin: '600px 0px' });

        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [chipId, fetchPage, nextOffset]);

    const selectChip = useCallback((nextChipId: FeedChipId) => {
        if (nextChipId === chipId) return;
        setChipId(nextChipId);
        setExpandedIds(new Set());
        setCommentsOpenIds(new Set());
        setNextOffset(null);
        void fetchPage(nextChipId, 0, true);
    }, [chipId, fetchPage]);

    const toggleExpanded = useCallback((id: string) => {
        setExpandedIds((current) => toggleInSet(current, id));
    }, []);

    const toggleComments = useCallback((id: string) => {
        setCommentsOpenIds((current) => toggleInSet(current, id));
    }, []);

    const applyCommentCount = useCallback((postId: string, commentCount: number) => {
        setFeedItems((current) => current.map((item) => (item.id === postId
            ? { ...item, commentCount: Math.max(0, commentCount) }
            : item)));
    }, []);

    return (
        <div className="mx-auto flex w-full max-w-[680px] flex-col gap-5 px-4 pb-24 pt-6 sm:px-6">
            <header className="flex flex-col gap-4">
                <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                        <h1 className="text-3xl font-extrabold tracking-[-0.03em] text-[var(--ui-text-primary)]">
                            Feed
                        </h1>
                        <p className="mt-1 text-sm text-[var(--ui-text-muted)]">
                            Notes, prompts, and creations from the community — newest thinking first.
                        </p>
                    </div>
                    <Link
                        href="/post/new?from=community&returnTo=%2Ffeed"
                        className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full bg-[var(--ui-primary)] px-4 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)]"
                    >
                        <PenLine className="h-4 w-4" aria-hidden="true" />
                        Share a post
                    </Link>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    {FEED_CHIPS.map((chip) => (
                        <button
                            key={chip.id}
                            type="button"
                            onClick={() => selectChip(chip.id)}
                            aria-pressed={chipId === chip.id}
                            className={`ui-focus-ring min-h-10 rounded-full border px-4 text-sm font-bold transition ${
                                chipId === chip.id
                                    ? 'border-[var(--ui-primary-strong)] bg-[var(--ui-primary)] text-[var(--ui-primary-on)]'
                                    : 'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] text-[var(--ui-text-muted)] hover:border-[var(--ui-border-default)] hover:text-[var(--ui-text-primary)]'
                            }`}
                        >
                            {chip.label}
                        </button>
                    ))}
                </div>
            </header>

            {loadError ? (
                <p role="alert" className="rounded-2xl border border-[rgba(255,124,139,0.34)] bg-[rgba(255,124,139,0.10)] px-4 py-3 text-sm text-[#ff7c8b]">
                    {loadError}
                </p>
            ) : null}

            {switching ? (
                <p className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--ui-text-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Loading this lane…
                </p>
            ) : cards.length === 0 ? (
                <div className="rounded-[1.5rem] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] px-6 py-16 text-center">
                    <p className="text-lg font-bold text-[var(--ui-text-primary)]">Nothing in this lane yet</p>
                    <p className="mt-2 text-sm text-[var(--ui-text-muted)]">
                        Switch lanes, or share a note, prompt, or creation to start it.
                    </p>
                </div>
            ) : (
                <div className="flex flex-col gap-4">
                    {cards.map((card) => (
                        <FeedPostCard
                            key={card.id}
                            card={card}
                            isSaved={savedItemIds.has(card.id)}
                            saving={savingItemIds.has(card.id)}
                            expanded={expandedIds.has(card.id)}
                            commentsOpen={commentsOpenIds.has(card.id)}
                            accessToken={accessToken}
                            onToggleExpanded={() => toggleExpanded(card.id)}
                            onToggleComments={() => toggleComments(card.id)}
                            onToggleSave={() => void toggleSave(card.id)}
                            onCommentCountChange={(commentCount) => applyCommentCount(card.id, commentCount)}
                            onOpenMedia={() => {
                                window.location.href = buildShowcaseDetailPath(card.id, {
                                    from: 'community',
                                    returnTo: '/feed',
                                });
                            }}
                        />
                    ))}
                </div>
            )}

            <div ref={sentinelRef} aria-hidden="true" />

            {loadingMore ? (
                <p className="flex items-center justify-center gap-2 py-4 text-sm text-[var(--ui-text-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Loading more posts…
                </p>
            ) : null}
        </div>
    );
}
