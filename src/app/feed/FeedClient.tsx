'use client';

import { Loader2, PenLine } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '@/components/AuthProvider';
import { useOptimisticPostSave } from '@/components/useOptimisticPostSave';
import { publishNavigationStart } from '@/components/navigation-progress-state';
import FeedMediaLightbox from '@/app/feed/FeedMediaLightbox';
import FeedPostCard, { type FeedDetailContext } from '@/app/feed/FeedPostCard';
import WindowedFeedList from '@/app/feed/WindowedFeedList';
import SkeletonLoader from '@/components/SkeletonLoader';
import { FEED_CHIPS, FEED_PAGE_SIZE, getFeedChip, type FeedChipId } from '@/lib/post-feed-chips';
import {
    blockCreatorAfterConfirmation,
    reportCreatorAfterConfirmation,
    reportPostAfterConfirmation,
    type FeedSafetyOutcome,
} from '@/lib/feed-safety-actions';
import { buildPostFeedCards } from '@/lib/post-feed-presentation';
import {
    getShowcaseFeedSessionId,
    getShowcaseRecommendation,
    QualifiedImpressionBoundary,
    sendShowcaseFeedEvent,
    sendShowcaseResourceOpenEvent,
    type ShowcaseFeedbackAction,
} from '@/app/showcase/ShowcaseFeedInteraction';
import { buildShowcaseDetailPath, getCurrentInternalPath } from '@/lib/share';
import { REMIX_UNLOCK_REQUIRED_CODE, requestShowcaseRemix, ShowcaseRemixRequestError } from '@/lib/showcase-remix-client';
import { useMediaQuery } from '@/lib/use-media-query';
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
// A lane left and come back to within this long shows what it showed, as the
// app's per-lane query cache does; after it the lane loads afresh.
const LANE_CACHE_TTL_MS = 5 * 60_000;

type LaneCacheEntry = {
    items: ShowcaseFeedItem[];
    nextOffset: number | null;
    nextCursor: string | null;
    feedSessionId: string | null;
    cachedAt: number;
};

type FeedbackNotice = { tone: 'success' | 'error'; message: string } | null;

type HiddenFromLane = { postIds: Set<string>; creatorIds: Set<string> };

/** A post the viewer removed this visit: not interested, hidden, reported or blocked. */
function isHiddenFromLane(hidden: HiddenFromLane, item: ShowcaseFeedItem) {
    return hidden.postIds.has(item.id) || Boolean(item.creator.id && hidden.creatorIds.has(item.creator.id));
}

/**
 * What the card menu removed this visit, per viewer as the lane snapshots are
 * kept. Module state, not the feed's: opening a post unmounts the feed, and
 * the page one it comes back to would draw again a post a signed-out viewer
 * was told was gone "for this visit". A page load starts a new visit.
 */
const removedThisVisit = new Map<string, HiddenFromLane>();

function getRemovedThisVisit(viewerId: string | null): HiddenFromLane {
    // The server renders the feed for every visitor; only a browser has a
    // visit, and a server-wide map would keep one entry per viewer for good.
    if (typeof window === 'undefined') return { postIds: new Set(), creatorIds: new Set() };
    const key = viewerId ?? 'signed-out';
    let removed = removedThisVisit.get(key);
    if (!removed) {
        removed = { postIds: new Set(), creatorIds: new Set() };
        removedThisVisit.set(key, removed);
    }
    return removed;
}

/** Test helper: each case starts a new visit. */
export function forgetFeedRemovalsForTests() {
    removedThisVisit.clear();
}

function emptyFeedPage(): ShowcaseFeedPage {
    return { items: [], pageInfo: { hasMore: false, nextOffset: 0, nextCursor: null } as ShowcaseFeedPage['pageInfo'] };
}

/**
 * A snapshot's page with its save set put back on the posts: `isSaved` rides
 * on the item, so a save made before navigating away would come back undone.
 */
function feedFromSnapshot(snapshot: ShowcaseClientSnapshot): ShowcaseFeedPage {
    const savedItemIds = new Set(snapshot.savedItemIds);
    return {
        ...snapshot.feed,
        items: snapshot.feed.items.map((item) => ({ ...item, isSaved: savedItemIds.has(item.id) })),
    };
}

/** Keeps `?chip=` in step with the lane, so a reload or Back lands on it. */
function writeLaneToUrl(laneId: FeedChipId) {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (laneId === 'for-you') url.searchParams.delete('chip'); else url.searchParams.set('chip', laneId);
    window.history.replaceState(window.history.state, '', url);
}

/** The lane `?chip=` names, For you when it names none. */
function readLaneFromUrl(): FeedChipId {
    return getFeedChip(new URLSearchParams(window.location.search).get('chip')).id;
}

/** The post page's way back, to the lane the post was opened from. */
function withLaneInReturnTo(context: FeedDetailContext, laneId: FeedChipId): FeedDetailContext {
    const url = new URL(context.returnTo, 'https://return.invalid');
    if (laneId === 'for-you') url.searchParams.delete('chip'); else url.searchParams.set('chip', laneId);
    const returnTo = `${url.pathname}${url.search}${url.hash}`;
    return returnTo === context.returnTo ? context : { ...context, returnTo };
}

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
    /**
     * Page one from the server, or null when its loader failed: the lane then
     * starts empty and fetches page one itself, with its own Retry.
     */
    initialFeed: ShowcaseFeedPage | null;
    initialChipId: FeedChipId;
    /**
     * The page could not read `?chip=` (the static signed-out `/`), so it
     * rendered `initialChipId`; the lane the address names is switched to
     * after mount, from its snapshot when there is one.
     */
    laneFromUrl?: boolean;
    /**
     * `page` (default) renders the standalone /feed page: own header, page
     * gutters, Share CTA. `embedded` drops the header and gutters so the feed
     * can sit inside another page's column (the home dashboard) while keeping
     * the lane chips and infinite scroll.
     */
    variant?: 'page' | 'embedded';
    detailContext?: FeedDetailContext;
    /** One bounded server-inlined cover for the anonymous home LCP. */
    initialPriorityPreview?: {
        postId: string;
        mediaId: string;
        dataUrl: string;
    } | null;
}

function toggleInSet(current: Set<string>, id: string) {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
}

export default function FeedClient({
    initialFeed,
    initialChipId,
    laneFromUrl = false,
    variant = 'page',
    detailContext = PAGE_DETAIL_CONTEXT,
    initialPriorityPreview = null,
}: FeedClientProps) {
    const router = useRouter();
    const { session, user } = useAuth();
    const accessToken = session?.access_token ?? null;
    const isEmbedded = variant === 'embedded';

    const [chipId, setChipId] = useState<FeedChipId>(initialChipId);
    const viewerId = user?.id ?? null;
    // Posts and creators removed through the card menu. Pages and lanes that
    // arrive afterwards are filtered the same way, for the rest of the visit.
    const removedForViewer = useMemo(() => getRemovedThisVisit(viewerId), [viewerId]);
    // "Back to Home" from a post lands on the lane it was opened from.
    const laneDetailContext = useMemo(() => withLaneInReturnTo(detailContext, chipId), [chipId, detailContext]);

    // Opening a post unmounts this feed, so everything paged in after the server's
    // first page lives only in React state and dies on the way out. Coming back
    // then re-renders page one and immediately re-fetches, losing the reader's
    // place. A session snapshot — the same one the showcase grid keeps — restores
    // what was already loaded instead. One key per lane: `?chip=` brings the
    // reader back to the lane they left, and its snapshot is the one restored.
    const buildLaneCacheKey = useCallback((laneId: FeedChipId) => {
        const chip = getFeedChip(laneId);
        return buildShowcaseClientCacheKey({
            surface: 'home-feed',
            viewerId,
            category: chip.category,
            sort: chip.sort,
            tool: null,
            unlock: chip.unlock,
            resource: 'all',
        });
    }, [viewerId]);
    const cacheKey = useMemo(() => buildLaneCacheKey(chipId), [buildLaneCacheKey, chipId]);
    // Read once: a later read could pick up a snapshot this component just wrote
    // and clobber live state with a stale copy of itself.
    const [restoredFeed] = useState(() => {
        const snapshot = readShowcaseClientSnapshot(buildLaneCacheKey(initialChipId));
        if (!snapshot || snapshot.feed.items.length <= (initialFeed?.items.length ?? 0)) return null;
        return feedFromSnapshot(snapshot);
    });
    // The viewer the feed mounted for: signing in or out elsewhere must not
    // swap the seed, which would reset the lane under the reader.
    const [removedAtMount] = useState(() => getRemovedThisVisit(viewerId));
    const seedFeed = useMemo(() => {
        const feed = restoredFeed ?? initialFeed ?? emptyFeedPage();
        // The server's page one still holds what was removed before this mount.
        const items = feed.items.filter((item) => !isHiddenFromLane(removedAtMount, item));
        return items.length === feed.items.length ? feed : { ...feed, items };
    }, [initialFeed, removedAtMount, restoredFeed]);
    const needsInitialFetch = initialFeed === null && !restoredFeed;

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
    const [switching, setSwitching] = useState(needsInitialFetch);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [feedbackNotice, setFeedbackNotice] = useState<FeedbackNotice>(null);
    const [remixingId, setRemixingId] = useState<string | null>(null);
    // Autoplay the in-view clip where there is no pointer to hover with: a
    // phone's feed used to show posters until a clip was tapped open.
    const touchAutoplay = useMediaQuery('(hover: none)');
    const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
    const [commentsOpenIds, setCommentsOpenIds] = useState<Set<string>>(() => new Set());
    // One lightbox for the whole feed, not one per card: a paginated feed
    // accumulates 50+ cards, and each would otherwise carry its own Escape
    // listener, scroll lock and focus trap.
    const [lightbox, setLightbox] = useState<FeedLightboxState>(null);
    // Hovering the same card repeatedly must not re-issue the prefetch. Keyed
    // by address: the post's way back names the lane it is opened from.
    const prefetchedHrefsRef = useRef<Set<string>>(new Set());
    const requestIdRef = useRef(0);
    const activeRequestRef = useRef<AbortController | null>(null);
    const pendingLoadMoreKeyRef = useRef<string | null>(null);
    // State updates commit after the current event. This ref closes the small
    // gap in which an old IntersectionObserver callback can otherwise abort a
    // lane-replacement request before `switching` reaches the observer effect.
    const pagingBlockedRef = useRef(false);
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    // Lanes left this visit, restored on return instead of refetched.
    const laneCacheRef = useRef(new Map<FeedChipId, LaneCacheEntry>());
    // The last page one of the current lane; a snapshot carries its session.
    const lanePageRef = useRef<ShowcaseFeedPage | null>(initialFeed);
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
    // The lane's posts as last rendered, for the save event the request's
    // answer sends: it arrives after the render that started it.
    const feedItemsForEventsRef = useRef<ShowcaseFeedItem[]>(seedFeed.items);

    const {
        items,
        setItems,
        savedItemIds,
        addSavedItemIds,
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
        // With the way back: a bare /login landed the viewer on /create afterwards.
        onAuthRequired: () => { router.push(`/login?returnUrl=${encodeURIComponent(getCurrentInternalPath('/feed'))}`); },
        onError: (error) => {
            console.error('Failed to save feed post:', error);
            // The notice, not the load alert: that alert's Retry loads a page,
            // and at the end of a lane it reloads the lane from the top.
            setFeedbackNotice({ tone: 'error', message: 'Could not update that save. Try again.' });
        },
        // The ranker hears a save from the Home feed as it does from Explore and
        // the reel. Best effort: the hook never undoes a save for its failure.
        onSuccess: ({ id, isSaved }) => {
            const index = feedItemsForEventsRef.current.findIndex((candidate) => candidate.id === id);
            if (index < 0) return;
            return sendShowcaseFeedEvent({
                item: feedItemsForEventsRef.current[index],
                eventType: isSaved ? 'save' : 'unsave',
                sourceSurface: 'feed',
                accessToken,
                feedSessionId,
                fallbackPosition: index,
            });
        },
        sourceSurface: 'feed',
    });
    useEffect(() => {
        feedItemsForEventsRef.current = items;
    }, [items]);

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
            if (chip.category !== 'all') params.set('category', chip.category);

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

            const visibleItems = page.items.filter((item) => !isHiddenFromLane(removedForViewer, item));
            if (replace) lanePageRef.current = page;
            setItems((current) => (replace
                ? visibleItems
                // The ranker can repeat an item across pages; the id guard keeps
                // React keys unique rather than trusting the page boundary.
                : [...current, ...visibleItems.filter((item) => !current.some((existing) => existing.id === item.id))]));
            addSavedItemIds(visibleItems.filter((item) => item.isSaved).map((item) => item.id));
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
    }, [accessToken, addSavedItemIds, removedForViewer, setItems]);

    useEffect(() => () => {
        requestIdRef.current += 1;
        activeRequestRef.current?.abort();
    }, []);

    useEffect(() => {
        // Keyed on the lane still being empty rather than a one-shot flag: an
        // effect cleanup (strict mode, Fast Refresh) aborts the request in
        // flight, and the re-run has to start it again.
        if (!needsInitialFetch || items.length > 0 || loadError) return;
        // The lane the address names is fetched by the switch after mount.
        if (laneFromUrl && readLaneFromUrl() !== initialChipId) return;
        void fetchPage(initialChipId, 0, true);
        // `items` and `loadError` are read, not reacted to: a token refresh
        // mid-request must not start a second one.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fetchPage, initialChipId, needsInitialFetch]);

    useEffect(() => {
        // An empty list is the transient state mid chip-switch, never a
        // snapshot worth coming back to.
        if (items.length === 0) return;

        pendingFeedSnapshotRef.current = {
            key: cacheKey,
            snapshot: {
                feed: {
                    ...(lanePageRef.current ?? seedFeed),
                    items,
                    feedSessionId,
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
    }, [cacheKey, feedSessionId, flushFeedSnapshot, items, nextCursor, nextOffset, savedItemIds, seedFeed]);

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

    // `snapshot`: the lane as an earlier mount of the feed left it, shown when
    // this mount has no fresher copy of its own.
    const selectChip = useCallback((nextChipId: FeedChipId, snapshot: LaneCacheEntry | null = null) => {
        if (nextChipId === chipId) {
            // The active chip again is the one way to refresh from the top.
            void fetchPage(chipId, 0, true);
            return;
        }
        laneCacheRef.current.set(chipId, { items, nextOffset, nextCursor, feedSessionId, cachedAt: Date.now() });
        setChipId(nextChipId);
        setExpandedIds(new Set());
        setCommentsOpenIds(new Set());
        setLightbox(null);
        setFeedbackNotice(null);
        writeLaneToUrl(nextChipId);

        const cached = laneCacheRef.current.get(nextChipId);
        const kept = cached && cached.items.length > 0 && Date.now() - cached.cachedAt < LANE_CACHE_TTL_MS
            ? cached
            : snapshot;
        if (kept && kept.items.length > 0) {
            // Back to a lane seen minutes ago: show it as it was, no spinner.
            requestIdRef.current += 1;
            activeRequestRef.current?.abort();
            activeRequestRef.current = null;
            pagingBlockedRef.current = false;
            setSwitching(false);
            setLoadingMore(false);
            setLoadError(null);
            // A post removed from another lane since this one was left stays
            // gone. Its saves need no adding back: the saved set is shared by
            // every lane and already holds what this lane's pages brought,
            // while the posts' own flags are as old as the cache and would
            // bring back a save undone since.
            setItems(kept.items.filter((item) => !isHiddenFromLane(removedForViewer, item)));
            setNextOffset(kept.nextOffset);
            setNextCursor(kept.nextCursor);
            setFeedSessionId(kept.feedSessionId);
            return;
        }
        setItems([]);
        setNextOffset(null);
        setNextCursor(null);
        void fetchPage(nextChipId, 0, true);
    }, [chipId, feedSessionId, fetchPage, items, nextCursor, nextOffset, removedForViewer, setItems]);

    // The static `/` renders For you whatever `?chip=` says. Back from a post
    // opened in another lane lands here, so that lane is shown after mount, as
    // it was left when its snapshot is still fresh. Before the first paint: a
    // frame of For you would flash under the lane's chip.
    useLayoutEffect(() => {
        if (!laneFromUrl) return;
        const urlLaneId = readLaneFromUrl();
        if (urlLaneId === initialChipId) return;

        const snapshot = readShowcaseClientSnapshot(buildLaneCacheKey(urlLaneId));
        if (!snapshot || snapshot.feed.items.length === 0) {
            selectChip(urlLaneId);
            return;
        }
        const feed = feedFromSnapshot(snapshot);
        lanePageRef.current = feed;
        addSavedItemIds(feed.items.filter((item) => item.isSaved).map((item) => item.id));
        selectChip(urlLaneId, {
            items: feed.items,
            nextOffset: feed.pageInfo.hasMore ? feed.pageInfo.nextOffset : null,
            nextCursor: feed.pageInfo.hasMore ? feed.pageInfo.nextCursor ?? null : null,
            feedSessionId: getShowcaseFeedSessionId(feed),
            cachedAt: snapshot.cachedAt,
        });
        // Once, on mount: from then on the address follows the lane.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const toggleExpanded = useCallback((id: string) => {
        setExpandedIds((current) => toggleInSet(current, id));
    }, []);

    const toggleComments = useCallback((id: string) => {
        setCommentsOpenIds((current) => toggleInSet(current, id));
    }, []);

    // An open thread reports its count after every page it loads, mostly
    // unchanged. A new items array rebuilds every card and re-renders the
    // whole feed, so it is made only when this post's count moved.
    const applyCommentCount = useCallback((postId: string, commentCount: number) => {
        const nextCount = Math.max(0, commentCount);
        setItems((current) => {
            const index = current.findIndex((item) => item.id === postId);
            if (index < 0 || current[index].commentCount === nextCount) return current;
            const next = [...current];
            next[index] = { ...current[index], commentCount: nextCount };
            return next;
        });
    }, [setItems]);

    // The save hook returns a new toggleSave on every render; the cards get one
    // function that reads the latest through a ref.
    const toggleSaveRef = useRef(toggleSave);
    toggleSaveRef.current = toggleSave;
    const handleToggleSave = useCallback((postId: string) => {
        void toggleSaveRef.current(postId);
    }, []);
    const cardsRef = useRef(cards);
    cardsRef.current = cards;
    // The 'recent' lane is unranked, so its cards carry no deliveryId and
    // sendShowcaseFeedEvent drops the event. That is correct, not a bug to fix:
    // an unranked impression has nothing to attribute the share to.
    const handleShared = useCallback((postId: string, cardIndex: number) => {
        const card = cardsRef.current.find((candidate) => candidate.id === postId);
        if (!card) return;
        void sendShowcaseFeedEvent({
            item: card.item,
            eventType: 'share',
            sourceSurface: 'feed',
            accessToken,
            feedSessionId,
            fallbackPosition: cardIndex,
        }).catch(() => undefined);
    }, [accessToken, feedSessionId]);
    // The recipe chip opens the post at its resources: the ranker hears it once
    // per delivery, as `resource_open`.
    const handleOpenResources = useCallback((postId: string) => {
        const cardIndex = cardsRef.current.findIndex((candidate) => candidate.id === postId);
        if (cardIndex < 0) return;
        sendShowcaseResourceOpenEvent({
            item: cardsRef.current[cardIndex].item,
            sourceSurface: 'feed',
            accessToken,
            feedSessionId,
            fallbackPosition: cardIndex,
        });
    }, [accessToken, feedSessionId]);
    const handleOpenMedia = useCallback((postId: string, mediaIndex: number) => {
        const card = cardsRef.current.find((candidate) => candidate.id === postId);
        if (!card) return;
        setLightbox({
            postId: card.id,
            title: card.title,
            // Sorted to match the card's own carousel, so the index refers to
            // the slide that was clicked.
            mediaItems: (card.item.mediaItems ?? [])
                .slice()
                .sort((left, right) => left.sortOrder - right.sortOrder),
            index: mediaIndex,
        });
    }, []);
    // Every way into a post sends `open`: the card, its title link, a new tab,
    // Read more. The ranker counts it toward the post's usefulness and the
    // viewer's interests; seen-suppression reads impressions only.
    const recordOpen = useCallback((postId: string) => {
        const cardIndex = cardsRef.current.findIndex((candidate) => candidate.id === postId);
        if (cardIndex < 0) return;
        void sendShowcaseFeedEvent({
            item: cardsRef.current[cardIndex].item,
            eventType: 'open',
            sourceSurface: 'feed',
            accessToken,
            feedSessionId,
            fallbackPosition: cardIndex,
        }).catch(() => undefined);
    }, [accessToken, feedSessionId]);
    const handleOpenPost = useCallback((postId: string) => {
        recordOpen(postId);
        // An imperative push raises no link status, so the progress bar has to
        // be told the click happened. Client-side navigation keeps the shell
        // alive; a full document load here made every post click pay for a
        // cold reload out and another one back.
        publishNavigationStart();
        router.push(buildShowcaseDetailPath(postId, laneDetailContext));
    }, [laneDetailContext, recordOpen, router]);
    const handlePrefetchPost = useCallback((postId: string) => {
        const href = buildShowcaseDetailPath(postId, laneDetailContext);
        if (prefetchedHrefsRef.current.has(href)) return;
        prefetchedHrefsRef.current.add(href);
        router.prefetch(href);
    }, [laneDetailContext, router]);
    // Not interested / Hide creator, as the app's card menu and the showcase
    // grid offer: the post (or the creator's posts) leave the lane at once, the
    // ranker hears why, and a failed save puts them back.
    const handleFeedback = useCallback(async (postId: string, action: ShowcaseFeedbackAction) => {
        const target = items.find((candidate) => candidate.id === postId);
        if (!target) return;
        if (action === 'hide_creator' && (!target.creator.id || target.creator.id === user?.id)) return;

        const removed = items
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => (action === 'hide_creator'
                ? item.creator.id === target.creator.id
                : item.id === postId));
        if (removed.length === 0) return;

        const hidden = removedForViewer;
        if (action === 'hide_creator' && target.creator.id) hidden.creatorIds.add(target.creator.id);
        else hidden.postIds.add(postId);
        const removedIds = new Set(removed.map(({ item }) => item.id));
        setFeedbackNotice(null);
        setItems((current) => current.filter((item) => !removedIds.has(item.id)));
        setLightbox((current) => (current && removedIds.has(current.postId) ? null : current));

        const doneMessage = !user
            ? action === 'hide_creator'
                ? `Posts from ${target.creator.name} are hidden for this visit.`
                : 'Post removed for this visit.'
            : action === 'hide_creator'
                ? `Posts from ${target.creator.name} are now hidden.`
                : 'Thanks. We\u2019ll show you fewer posts like that.';
        // Signed out, the server takes feedback only on a post it delivered,
        // and refuses the rest: page one of the static `/` and the Recent lane
        // carry no delivery. The removal stays with this visit; nothing is sent.
        if (!user && !getShowcaseRecommendation(target)?.deliveryId) {
            setFeedbackNotice({ tone: 'success', message: doneMessage });
            return;
        }

        try {
            await sendShowcaseFeedEvent({
                item: target,
                eventType: action,
                sourceSurface: 'feed',
                accessToken,
                feedSessionId,
                fallbackPosition: removed[0].index,
                metadata: { creatorId: target.creator.id },
            });
            setFeedbackNotice({ tone: 'success', message: doneMessage });
        } catch (error) {
            console.error('Failed to save feed feedback:', error);
            if (action === 'hide_creator' && target.creator.id) hidden.creatorIds.delete(target.creator.id);
            else hidden.postIds.delete(postId);
            setItems((current) => {
                const restored = [...current];
                removed.forEach(({ item, index }) => {
                    if (!restored.some((candidate) => candidate.id === item.id)) {
                        restored.splice(Math.min(index, restored.length), 0, item);
                    }
                });
                return restored;
            });
            setFeedbackNotice({
                tone: 'error',
                message: 'We couldn\u2019t save that preference, so the post was restored. Please try again.',
            });
        }
    }, [accessToken, feedSessionId, items, removedForViewer, setItems, user]);
    // Remix starts from the card, as it does in the app and on the showcase
    // grid; the pill used to be a link to the post page, one page short.
    const handleRemix = useCallback(async (postId: string) => {
        if (!user || !accessToken) {
            router.push(`/login?returnUrl=${encodeURIComponent(getCurrentInternalPath(laneDetailContext.returnTo))}`);
            return;
        }
        const cardIndex = cardsRef.current.findIndex((candidate) => candidate.id === postId);
        const card = cardIndex >= 0 ? cardsRef.current[cardIndex] : null;
        setRemixingId(postId);
        setFeedbackNotice(null);
        try {
            const { redirectTo } = await requestShowcaseRemix({ accessToken, postId });
            if (card) {
                void sendShowcaseFeedEvent({
                    item: card.item,
                    eventType: 'remix_start',
                    sourceSurface: 'feed',
                    accessToken,
                    feedSessionId,
                    fallbackPosition: cardIndex,
                    metadata: { redirectTo },
                }).catch(() => undefined);
            }
            publishNavigationStart();
            router.push(redirectTo);
        } catch (error) {
            if (error instanceof ShowcaseRemixRequestError
                && (error.code === REMIX_UNLOCK_REQUIRED_CODE || error.status === 403)) {
                // The creator put the remix behind an unlock; the post page sells it.
                if (card) {
                    sendShowcaseResourceOpenEvent({
                        item: card.item,
                        sourceSurface: 'feed',
                        accessToken,
                        feedSessionId,
                        fallbackPosition: cardIndex,
                    });
                }
                publishNavigationStart();
                router.push(buildShowcaseDetailPath(postId, { ...laneDetailContext, section: 'resources' }));
                return;
            }
            setFeedbackNotice({
                tone: 'error',
                message: error instanceof Error && error.message ? error.message : 'Could not start the remix. Please try again.',
            });
        } finally {
            setRemixingId(null);
        }
    }, [accessToken, feedSessionId, laneDetailContext, router, user]);
    // Report content, Report user and Block user, asked for and sent as
    // Explore's tile and the reel send them (`lib/feed-safety-actions.ts`). The
    // server takes them from registered accounts only, so a signed-out viewer
    // is asked to sign in first, and comes back here.
    const requireAccount = useCallback((): string | null => {
        if (user && accessToken) return accessToken;
        router.push(`/login?returnUrl=${encodeURIComponent(getCurrentInternalPath(laneDetailContext.returnTo))}`);
        return null;
    }, [accessToken, laneDetailContext.returnTo, router, user]);
    const removeFromLane = useCallback((predicate: (item: ShowcaseFeedItem) => boolean) => {
        setItems((current) => current.filter((item) => !predicate(item)));
        setLightbox((current) => {
            const open = current ? cardsRef.current.find((card) => card.id === current.postId)?.item : null;
            return open && predicate(open) ? null : current;
        });
    }, [setItems]);
    const clearNotice = useCallback(() => setFeedbackNotice(null), []);
    const showOutcome = useCallback((outcome: FeedSafetyOutcome) => {
        if (outcome.status === 'cancelled') return;
        setFeedbackNotice({ tone: outcome.status === 'done' ? 'success' : 'error', message: outcome.message });
    }, []);
    const handleReportContent = useCallback(async (postId: string) => {
        const token = requireAccount();
        if (!token) return;
        // The card's delivery, so the ranker hears the report; the unranked
        // 'recent' lane has none to send.
        const deliveryId = cardsRef.current.find((card) => card.id === postId)?.item.recommendation?.deliveryId;
        const outcome = await reportPostAfterConfirmation({
            postId,
            accessToken: token,
            surface: 'feed',
            onSend: clearNotice,
            deliveryId,
        });
        if (outcome.status === 'done') {
            removedForViewer.postIds.add(postId);
            removeFromLane((item) => item.id === postId);
        }
        showOutcome(outcome);
    }, [clearNotice, removeFromLane, removedForViewer, requireAccount, showOutcome]);
    const handleReportUser = useCallback(async (postId: string) => {
        const creatorId = cardsRef.current.find((card) => card.id === postId)?.item.creator.id;
        if (!creatorId || creatorId === user?.id) return;
        const token = requireAccount();
        if (!token) return;
        showOutcome(await reportCreatorAfterConfirmation({ userId: creatorId, accessToken: token, surface: 'feed', onSend: clearNotice }));
    }, [clearNotice, requireAccount, showOutcome, user?.id]);
    const handleBlockUser = useCallback(async (postId: string) => {
        const creator = cardsRef.current.find((card) => card.id === postId)?.item.creator;
        const creatorId = creator?.id;
        if (!creator || !creatorId || creatorId === user?.id) return;
        const token = requireAccount();
        if (!token) return;
        const outcome = await blockCreatorAfterConfirmation({
            userId: creatorId,
            creatorName: creator.name,
            accessToken: token,
            onSend: clearNotice,
        });
        if (outcome.status === 'done') {
            removedForViewer.creatorIds.add(creatorId);
            removeFromLane((item) => item.creator.id === creatorId);
        }
        showOutcome(outcome);
    }, [clearNotice, removeFromLane, removedForViewer, requireAccount, showOutcome, user?.id]);
    const priorityPoster = useMemo(() => (initialPriorityPreview
        ? { mediaId: initialPriorityPreview.mediaId, dataUrl: initialPriorityPreview.dataUrl }
        : null), [initialPriorityPreview]);

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

            {feedbackNotice ? (
                <p
                    role="status"
                    className={`rounded-2xl border px-4 py-3 text-sm ${
                        feedbackNotice.tone === 'error'
                            ? 'border-[rgba(255,124,139,0.34)] bg-[rgba(255,124,139,0.10)] text-[#ff7c8b]'
                            : 'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] text-[var(--ui-text-secondary)]'
                    }`}
                >
                    {feedbackNotice.message}
                </p>
            ) : null}

            {switching ? (
                <p className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--ui-text-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Loading this lane…
                </p>
            ) : cards.length === 0 ? (
                // A lane that failed to load is not an empty one: the alert
                // above says so, with its Retry, and nothing invites a post.
                loadError ? null : (
                    <div className="rounded-[1.5rem] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] px-6 py-16 text-center">
                        <p className="text-lg font-bold text-[var(--ui-text-primary)]">Nothing in this lane yet</p>
                        <p className="mt-2 text-sm text-[var(--ui-text-muted)]">
                            Switch lanes, or share a note, prompt, or creation to start it.
                        </p>
                        <Link
                            href={`/post/new?from=community&returnTo=${encodeURIComponent(laneDetailContext.returnTo)}`}
                            className="ui-focus-ring mt-5 inline-flex min-h-12 items-center rounded-full bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)]"
                        >
                            Share the first post
                        </Link>
                    </div>
                )
            ) : (
                <WindowedFeedList
                    items={cards}
                    getKey={(card) => card.id}
                    // Comment threads own fetched pages, reply expansion and an
                    // unsent draft. Keep an open conversation alive even after
                    // its card scrolls beyond the ordinary 24-card window.
                    pinnedKeys={commentsOpenIds}
                    renderItem={(card, cardIndex) => (
                        <QualifiedImpressionBoundary
                            key={card.id}
                            item={card.item}
                            position={cardIndex}
                            feedSessionId={feedSessionId}
                            accessToken={accessToken}
                            sourceSurface="feed"
                            trackAttention
                        >
                        <FeedPostCard
                            card={card}
                            isSaved={savedItemIds.has(card.id)}
                            saving={savingItemIds.has(card.id)}
                            expanded={expandedIds.has(card.id)}
                            commentsOpen={commentsOpenIds.has(card.id)}
                            accessToken={accessToken}
                            priorityMedia={cardIndex === 0}
                            priorityPoster={card.id === initialPriorityPreview?.postId ? priorityPoster : null}
                            detailContext={laneDetailContext}
                            viewerIsOwner={Boolean(user && card.item.creator.id === user.id)}
                            signedIn={Boolean(user)}
                            remixing={remixingId === card.id}
                            autoPlayMedia={touchAutoplay}
                            cardIndex={cardIndex}
                            onToggleExpanded={toggleExpanded}
                            onToggleComments={toggleComments}
                            onToggleSave={handleToggleSave}
                            onShared={handleShared}
                            onCommentCountChange={applyCommentCount}
                            onOpenMedia={handleOpenMedia}
                            onOpenPost={handleOpenPost}
                            onRecordOpen={recordOpen}
                            onPrefetchPost={handlePrefetchPost}
                            onFeedback={handleFeedback}
                            onRemix={handleRemix}
                            onOpenResources={handleOpenResources}
                            onReportContent={handleReportContent}
                            onReportUser={handleReportUser}
                            onBlockUser={handleBlockUser}
                        />
                        </QualifiedImpressionBoundary>
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

            {!switching && !loadingMore && cards.length > 0 && nextOffset === null && nextCursor === null ? (
                // A personalised lane stops at 60 posts; the bottom used to be silent.
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                    <p className="text-sm font-semibold text-[var(--ui-text-muted)]">You&apos;re all caught up.</p>
                    <button
                        type="button"
                        onClick={() => void fetchPage(chipId, 0, true)}
                        className="ui-focus-ring inline-flex min-h-11 items-center rounded-full border border-[var(--ui-border-default)] px-4 text-xs font-bold text-[var(--ui-text-secondary)] transition hover:text-[var(--ui-text-primary)]"
                    >
                        Refresh this lane
                    </button>
                </div>
            ) : null}

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
