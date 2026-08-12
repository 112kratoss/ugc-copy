'use client';

import { Loader2, PenLine } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '@/app/components/AuthProvider';
import { useOptimisticPostSave } from '@/app/components/useOptimisticPostSave';
import { publishNavigationStart } from '@/app/components/navigation-progress-state';
import FeedMediaLightbox from '@/app/feed/FeedMediaLightbox';
import FeedPostCard, { type FeedDetailContext } from '@/app/feed/FeedPostCard';
import WindowedFeedList from '@/app/feed/WindowedFeedList';
import SkeletonLoader from '@/app/components/SkeletonLoader';
import { FEED_CHIPS, FEED_PAGE_SIZE, getFeedChip, type FeedChipId } from '@/lib/post-feed-chips';
import { buildPostFeedCards } from '@/lib/post-feed-presentation';
import {
    getShowcaseFeedSessionId,
    sendShowcaseFeedEvent,
} from '@/app/showcase/ShowcaseFeedInteraction';
import { buildShowcaseDetailPath } from '@/lib/share';
import type { ShowcaseFeedItem, ShowcaseFeedPage, ShowcaseMediaItem } from '@/lib/showcase';
import {
    buildShowcaseClientCacheKey,
    readShowcaseClientSnapshot,
    writeShowcaseClientSnapshot,
    type ShowcaseClientSnapshot,
} from '@/lib/showcase-client-cache';
import { scheduleIdleDebouncedWork } from '@/lib/schedule-idle-work';

const PAGE_DETAIL_CONTEXT: FeedDetailContext = { from: 'community', returnTo: '/feed' };
const FEED_SNAPSHOT_QUIET_PERIOD_MS = 1_000;
const FEED_SNAPSHOT_IDLE_TIMEOUT_MS = 1_000;

/**
 * The open lightbox, held as a snapshot rather than a lookup by id: switching
 * lanes clears `items` and paging replaces them, either of which would leave a
 * derived lookup resolving to nothing while the viewer is still looking at it.
 */
type FeedLightboxState = {
    postId: string;
    title: string;
    mediaItems: ShowcaseMediaItem[];
    index: number;
} | null;

interface FeedClientProps {
    initialFeed: ShowcaseFeedPage;
    initialChipId: FeedChipId;
    /**
     * `page` (default) renders the standalone /feed page: own header, page
     * gutters, Share CTA. `embedded` drops the header and gutters so the feed
     * can sit inside another page's column (the home dashboard) while keeping
     * the lane chips and infinite scroll.
     */
    variant?: 'page' | 'embedded';
    detailContext?: FeedDetailContext;
}

function toggleInSet(current: Set<string>, id: string) {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
}

export default function FeedClient({
    initialFeed,
    initialChipId,
    variant = 'page',
    detailContext = PAGE_DETAIL_CONTEXT,
}: FeedClientProps) {
    const router = useRouter();
    const { session, user } = useAuth();
    const accessToken = session?.access_token ?? null;
    const isEmbedded = variant === 'embedded';

    const [chipId, setChipId] = useState<FeedChipId>(initialChipId);

    // Opening a post unmounts this feed, so everything paged in after the server's
    // first page lives only in React state and dies on the way out. Coming back
    // then re-renders page one and immediately re-fetches, losing the reader's
    // place. A session snapshot — the same one the showcase grid keeps — restores
    // what was already loaded instead.
    const cacheKey = useMemo(() => {
        const chip = getFeedChip(initialChipId);
        return buildShowcaseClientCacheKey({
            surface: 'home-feed',
            viewerId: user?.id ?? null,
            category: 'all',
            sort: chip.sort,
            tool: null,
            unlock: chip.unlock,
            resource: 'all',
        });
    }, [initialChipId, user?.id]);
    // Read once: a later read could pick up a snapshot this component just wrote
    // and clobber live state with a stale copy of itself.
    const [restoredFeed] = useState(() => {
        const snapshot = readShowcaseClientSnapshot(cacheKey);
        if (!snapshot || snapshot.feed.items.length <= initialFeed.items.length) return null;

        // `isSaved` rides on the item, so a save made before navigating away would
        // come back undone unless the snapshot's save set is reapplied.
        const restoredSavedItemIds = new Set(snapshot.savedItemIds);
        return {
            ...snapshot.feed,
            items: snapshot.feed.items.map((item) => ({
                ...item,
                isSaved: restoredSavedItemIds.has(item.id),
            })),
        };
    });
    const seedFeed = restoredFeed ?? initialFeed;

    const [nextOffset, setNextOffset] = useState<number | null>(
        seedFeed.pageInfo.hasMore ? seedFeed.pageInfo.nextOffset : null
    );
    // Offset alone re-runs the whole ranking for every page loaded outside the
    // server's two-minute session-reuse window, persisting a fresh session and
    // up to 121 rows each time -- three pages could write ~363 rows instead of
    // 121. It is also why items repeated across pages, which the id guard in
    // `fetchPage` was papering over. The cursor continues the ranking that
    // produced page one instead of ranking again.
    const [nextCursor, setNextCursor] = useState<string | null>(
        seedFeed.pageInfo.hasMore ? seedFeed.pageInfo.nextCursor ?? null : null
    );
    const [loadingMore, setLoadingMore] = useState(false);
    // The ranker groups a viewer's events into one session. It arrives on the
    // feed page rather than the item, so it has to be carried forward as pages
    // load or every event after the first page lands in a stale session.
    const [feedSessionId, setFeedSessionId] = useState(() => getShowcaseFeedSessionId(seedFeed));
    const [switching, setSwitching] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
    const [commentsOpenIds, setCommentsOpenIds] = useState<Set<string>>(() => new Set());
    // One lightbox for the whole feed, not one per card: a paginated feed
    // accumulates 50+ cards, and each would otherwise carry its own Escape
    // listener, scroll lock and focus trap.
    const [lightbox, setLightbox] = useState<FeedLightboxState>(null);
    // Hovering the same card repeatedly must not re-issue the prefetch.
    const prefetchedIdsRef = useRef<Set<string>>(new Set());
    const requestIdRef = useRef(0);
    const activeRequestRef = useRef<AbortController | null>(null);
    const pendingLoadMoreKeyRef = useRef<string | null>(null);
    // State updates commit after the current event. This ref closes the small
    // gap in which an old IntersectionObserver callback can otherwise abort a
    // lane-replacement request before `switching` reaches the observer effect.
    const pagingBlockedRef = useRef(false);
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    const pendingFeedSnapshotRef = useRef<{
        key: string;
        snapshot: Omit<ShowcaseClientSnapshot, 'cachedAt'>;
    } | null>(null);
    const flushFeedSnapshot = useCallback(() => {
        const pending = pendingFeedSnapshotRef.current;
        if (!pending) return;
        pendingFeedSnapshotRef.current = null;
        writeShowcaseClientSnapshot(pending.key, pending.snapshot);
    }, []);

    const {
        items,
        setItems,
        savedItemIds,
        savingItemIds,
        toggleSave,
    } = useOptimisticPostSave<ShowcaseFeedItem>({
        // The seed page only, and it never changes identity. The hook resets its
        // optimistic save state whenever `initialItems` does, so later pages go
        // through `setItems` — otherwise loading page 2 would roll back a save the
        // viewer just made on page 1.
        initialItems: seedFeed.items,
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

    const fetchPage = useCallback(async (
        targetChipId: FeedChipId,
        offset: number,
        replace: boolean,
        cursor: string | null = null,
    ) => {
        if (!replace && pagingBlockedRef.current) return;

        // A lane switch always restarts the ranking, so it never carries a
        // cursor forward from the lane it is leaving.
        const continuationCursor = replace ? null : cursor;
        const requestKey = `${targetChipId}:${continuationCursor ?? offset}`;
        if (!replace && pendingLoadMoreKeyRef.current === requestKey) return;

        const requestId = ++requestIdRef.current;
        activeRequestRef.current?.abort();
        const controller = new AbortController();
        activeRequestRef.current = controller;
        pagingBlockedRef.current = true;

        if (!replace) pendingLoadMoreKeyRef.current = requestKey;
        if (replace) setSwitching(true); else setLoadingMore(true);
        setLoadError(null);

        try {
            const chip = getFeedChip(targetChipId);
            const params = new URLSearchParams({
                limit: String(FEED_PAGE_SIZE),
                sort: chip.sort,
            });
            // Either/or, not both: the server zeroes the offset whenever a
            // cursor is present, so sending both only invites confusion when
            // reading a request log. Non-ranked sorts never produce a cursor
            // and keep paging by offset exactly as before.
            if (continuationCursor) {
                params.set('cursor', continuationCursor);
            } else {
                params.set('offset', String(offset));
            }
            if (chip.unlock !== 'all') params.set('unlock', chip.unlock);

            const response = await fetch(
                `/api/showcase/feed?${params.toString()}`,
                {
                    ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
                    signal: controller.signal,
                }
            );
            if (!response.ok) throw new Error(`Feed request failed with ${response.status}`);

            const page = await response.json() as ShowcaseFeedPage;
            if (requestId !== requestIdRef.current) return;

            setItems((current) => (replace
                ? page.items
                // The ranker can repeat an item across pages; the id guard keeps
                // React keys unique rather than trusting the page boundary.
                : [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))]));
            setNextOffset(page.pageInfo.hasMore ? page.pageInfo.nextOffset : null);
            setNextCursor(page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? null : null);
            // A lane switch starts a new session and adopts whatever the page
            // says, including nothing. Paging within a lane keeps the session it
            // already has rather than dropping it for an unranked page.
            const nextFeedSessionId = getShowcaseFeedSessionId(page);
            if (replace || nextFeedSessionId) {
                setFeedSessionId(nextFeedSessionId);
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return;
            if (requestId !== requestIdRef.current) return;

            console.error('Failed to load feed page:', error);
            if (replace) {
                setItems([]);
                setNextOffset(null);
                setNextCursor(null);
                setLoadError('Could not load this lane.');
            } else {
                setLoadError('Could not load more posts. What you already loaded is still here.');
            }
        } finally {
            if (pendingLoadMoreKeyRef.current === requestKey) {
                pendingLoadMoreKeyRef.current = null;
            }
            if (requestId === requestIdRef.current) {
                activeRequestRef.current = null;
                pagingBlockedRef.current = false;
                setLoadingMore(false);
                setSwitching(false);
            }
        }
    }, [accessToken, setItems]);

    useEffect(() => () => {
        requestIdRef.current += 1;
        activeRequestRef.current?.abort();
    }, []);

    useEffect(() => {
        // Only the mount-time chip is restorable, so only it is worth storing;
        // and an empty list is the transient state mid chip-switch, never a
        // snapshot worth coming back to.
        if (chipId !== initialChipId || items.length === 0) return;

        pendingFeedSnapshotRef.current = {
            key: cacheKey,
            snapshot: {
                feed: {
                    ...seedFeed,
                    items,
                    pageInfo: {
                        ...seedFeed.pageInfo,
                        // hasMore keys on either continuation, or restoring a
                        // snapshot whose last page returned a cursor but no offset
                        // would look like the end of the feed.
                        hasMore: nextOffset !== null || nextCursor !== null,
                        nextOffset,
                        nextCursor,
                    },
                },
                renderedItemCount: items.length,
                savedItemIds: [...savedItemIds],
            },
        };
        return scheduleIdleDebouncedWork(
            flushFeedSnapshot,
            FEED_SNAPSHOT_QUIET_PERIOD_MS,
            FEED_SNAPSHOT_IDLE_TIMEOUT_MS,
        );
    }, [cacheKey, chipId, flushFeedSnapshot, initialChipId, items, nextCursor, nextOffset, savedItemIds, seedFeed]);

    useEffect(() => flushFeedSnapshot, [flushFeedSnapshot]);

    useEffect(() => {
        const sentinel = sentinelRef.current;
        // A ranked lane can hand back a cursor and no offset, so either
        // continuation means there is more to load.
        if (
            !sentinel
            || switching
            || loadingMore
            || (nextOffset === null && nextCursor === null)
        ) return;

        const observer = new IntersectionObserver((entries) => {
            if (
                !pagingBlockedRef.current
                && entries.some((entry) => entry.isIntersecting)
            ) {
                void fetchPage(chipId, nextOffset ?? 0, false, nextCursor);
            }
        }, { rootMargin: '600px 0px' });

        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [chipId, fetchPage, loadingMore, nextCursor, nextOffset, switching]);

    const selectChip = useCallback((nextChipId: FeedChipId) => {
        if (nextChipId === chipId) return;
        setChipId(nextChipId);
        setExpandedIds(new Set());
        setCommentsOpenIds(new Set());
        setLightbox(null);
        setItems([]);
        setNextOffset(null);
        setNextCursor(null);
        void fetchPage(nextChipId, 0, true);
    }, [chipId, fetchPage, setItems]);

    const toggleExpanded = useCallback((id: string) => {
        setExpandedIds((current) => toggleInSet(current, id));
    }, []);

    const toggleComments = useCallback((id: string) => {
        setCommentsOpenIds((current) => toggleInSet(current, id));
    }, []);

    const applyCommentCount = useCallback((postId: string, commentCount: number) => {
        setItems((current) => current.map((item) => (item.id === postId
            ? { ...item, commentCount: Math.max(0, commentCount) }
            : item)));
    }, [setItems]);

    const chipRow = (
        <div className="flex flex-wrap items-center gap-2">
            {FEED_CHIPS.map((chip) => (
                <button
                    key={chip.id}
                    type="button"
                    onClick={() => selectChip(chip.id)}
                    aria-pressed={chipId === chip.id}
                    className={`ui-focus-ring min-h-11 rounded-full border px-4 text-sm font-bold transition ${
                        chipId === chip.id
                            ? 'border-[var(--ui-primary-strong)] bg-[var(--ui-primary)] text-[var(--ui-primary-on)]'
                            : 'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] text-[var(--ui-text-muted)] hover:border-[var(--ui-border-default)] hover:text-[var(--ui-text-primary)]'
                    }`}
                >
                    {chip.label}
                </button>
            ))}
        </div>
    );

    return (
        <div
            className={isEmbedded
                ? 'flex w-full flex-col gap-5'
                : 'mx-auto flex w-full max-w-[680px] flex-col gap-5 px-4 pb-24 pt-6 sm:px-6'}
        >
            {isEmbedded ? chipRow : (
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

                    {chipRow}
                </header>
            )}

            {loadError ? (
                <div
                    role="alert"
                    className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[rgba(255,124,139,0.34)] bg-[rgba(255,124,139,0.10)] px-4 py-3 text-sm text-[#ff7c8b]"
                >
                    <span>{loadError}</span>
                    <button
                        type="button"
                        onClick={() => void fetchPage(
                            chipId,
                            nextOffset ?? 0,
                            // Nothing left to continue from means retrying has
                            // to restart the lane rather than page on.
                            nextOffset === null && nextCursor === null,
                            nextCursor,
                        )}
                        className="ui-focus-ring min-h-11 rounded-full border border-current px-4 text-xs font-bold"
                    >
                        Retry
                    </button>
                </div>
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
                <WindowedFeedList
                    items={cards}
                    getKey={(card) => card.id}
                    // Comment threads own fetched pages, reply expansion and an
                    // unsent draft. Keep an open conversation alive even after
                    // its card scrolls beyond the ordinary 24-card window.
                    pinnedKeys={commentsOpenIds}
                    renderItem={(card, cardIndex) => (
                        <FeedPostCard
                            key={card.id}
                            card={card}
                            isSaved={savedItemIds.has(card.id)}
                            saving={savingItemIds.has(card.id)}
                            expanded={expandedIds.has(card.id)}
                            commentsOpen={commentsOpenIds.has(card.id)}
                            accessToken={accessToken}
                            detailContext={detailContext}
                            onToggleExpanded={() => toggleExpanded(card.id)}
                            onToggleComments={() => toggleComments(card.id)}
                            onToggleSave={() => void toggleSave(card.id)}
                            // The 'recent' lane is unranked, so its cards carry no
                            // deliveryId and sendShowcaseFeedEvent drops the event.
                            // That is correct, not a bug to fix: an unranked
                            // impression has nothing to attribute the share to.
                            onShared={() => {
                                void sendShowcaseFeedEvent({
                                    item: card.item,
                                    eventType: 'share',
                                    sourceSurface: 'feed',
                                    accessToken,
                                    feedSessionId,
                                    fallbackPosition: cardIndex,
                                }).catch(() => undefined);
                            }}
                            onCommentCountChange={(commentCount) => applyCommentCount(card.id, commentCount)}
                            onOpenMedia={(mediaIndex) => setLightbox({
                                postId: card.id,
                                title: card.title,
                                // Sorted to match the card's own carousel, so the
                                // index refers to the slide that was clicked.
                                mediaItems: (card.item.mediaItems ?? [])
                                    .slice()
                                    .sort((left, right) => left.sortOrder - right.sortOrder),
                                index: mediaIndex,
                            })}
                            onOpenPost={() => {
                                // An imperative push raises no link status, so the
                                // progress bar has to be told the click happened.
                                publishNavigationStart();
                                // Client-side navigation keeps the shell alive; a full
                                // document load here made every post click pay for a
                                // cold reload out and another one back.
                                router.push(buildShowcaseDetailPath(card.id, detailContext));
                            }}
                            onPrefetchPost={() => {
                                if (prefetchedIdsRef.current.has(card.id)) return;
                                prefetchedIdsRef.current.add(card.id);
                                router.prefetch(buildShowcaseDetailPath(card.id, detailContext));
                            }}
                        />
                    )}
                />
            )}

            {loadingMore ? (
                <div aria-hidden="true" className="flex flex-col gap-3" data-feed-load-more-skeleton="true">
                    {[0, 1].map((placeholder) => (
                        <SkeletonLoader key={placeholder} className="h-64 rounded-[1.5rem]" />
                    ))}
                </div>
            ) : null}

            <div ref={sentinelRef} aria-hidden="true" />

            {loadingMore ? (
                <p className="flex items-center justify-center gap-2 py-4 text-sm text-[var(--ui-text-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Loading more posts…
                </p>
            ) : null}

            {lightbox ? (
                // Keyed so reopening on another post — or another slide of the
                // same one — remounts and reseeds the carousel's initial index.
                <FeedMediaLightbox
                    key={`${lightbox.postId}:${lightbox.index}`}
                    title={lightbox.title}
                    mediaItems={lightbox.mediaItems}
                    initialIndex={lightbox.index}
                    onClose={() => setLightbox(null)}
                />
            ) : null}
        </div>
    );
}
