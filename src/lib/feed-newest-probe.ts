'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ShowcaseCategory } from '@/lib/showcase';

/** The lanes the newest-post probe names (`GET /api/showcase/feed/newest`). */
export type FeedNewestCategory = 'all' | 'media' | 'text';

/**
 * A lane's page one this old, or older, may have newer posts above it (D2,
 * 2026-10-14). Younger, it is as fresh as a lane kept for coming back to.
 */
export const NEW_POSTS_PROBE_AFTER_MS = 5 * 60_000;

/** The probe's name for a lane's posts: Images and Videos are asked about as media, as the server asks. */
export function feedNewestCategoryFor(category: ShowcaseCategory): FeedNewestCategory {
    return category === 'all' || category === 'text' ? category : 'media';
}

/** When the newest post a lane holds was published, in ms; null for a lane that holds none. */
export function newestCreatedAtOf(items: ReadonlyArray<{ createdAt: string }>): number | null {
    let newest: number | null = null;
    for (const item of items) {
        const createdAt = Date.parse(item.createdAt);
        if (Number.isFinite(createdAt) && (newest === null || createdAt > newest)) newest = createdAt;
    }
    return newest;
}

/**
 * When the newest post of a lane was published, asked with no token: every
 * viewer gets the same answer, cached for 30 seconds, and the probe opens no
 * feed session and records no delivery. Null when it could not be asked, or
 * the lane has no post.
 */
export async function fetchNewestFeedPostPublishedAt(
    category: FeedNewestCategory,
    signal?: AbortSignal,
): Promise<number | null> {
    try {
        const response = await fetch(`/api/showcase/feed/newest?category=${category}`, { signal });
        if (!response.ok) return null;
        const body = await response.json() as { newestPublishedAt?: unknown } | null;
        const publishedAt = typeof body?.newestPublishedAt === 'string' ? Date.parse(body.newestPublishedAt) : NaN;
        return Number.isFinite(publishedAt) ? publishedAt : null;
    } catch {
        return null;
    }
}

export interface NewPostsProbeLane {
    /** Names the lane: another lane hides the pill. */
    key: string;
    category: FeedNewestCategory;
}

/**
 * Whether newer posts exist than the lane the reader holds, asked once each
 * time the tab comes back into view (or the page back from the back/forward
 * cache) when the lane's page one is five minutes old or more. Nothing is
 * fetched into the lane: the pill's tap is the screen's own refresh, and
 * `dismiss` goes with it.
 */
export function useNewPostsProbe({
    lane,
    laneFetchedAt,
    newestKnownAt,
}: {
    /**
     * The lane on screen, or null where there is no pill: the Recent lane, a
     * filter the probe cannot name, a lane loading or holding nothing.
     */
    lane: NewPostsProbeLane | null;
    /**
     * When the lane's page one was fetched. Null for the page the screen
     * opened with: its age counts from when the lane was first seen here.
     */
    laneFetchedAt: number | null;
    /** The newest post the lane holds (`newestCreatedAtOf`). */
    newestKnownAt: number | null;
}): { hasNewer: boolean; dismiss: () => void } {
    const [found, setFound] = useState<{ laneKey: string; laneFetchedAt: number | null; newestAt: number } | null>(null);
    const laneKey = lane?.key ?? null;
    // A lane changed or loaded afresh since the answer came: the answer is not about it.
    const hasNewer = found !== null && found.laneKey === laneKey && found.laneFetchedAt === laneFetchedAt;
    const firstSeenAtRef = useRef(new Map<string, number>());
    // The newest post each lane's pill has offered. A ranked lane need not
    // hold the newest post there is, and the pill would come back for that
    // same post at every return once the reader had taken the lane afresh.
    const offeredAtRef = useRef(new Map<string, number>());
    // What the listeners read when the tab comes back, kept current after
    // each render rather than subscribing them again.
    const latestRef = useRef({ lane, laneFetchedAt, newestKnownAt, hasNewer });

    useEffect(() => {
        latestRef.current = { lane, laneFetchedAt, newestKnownAt, hasNewer };
    });

    useEffect(() => {
        if (laneKey !== null && !firstSeenAtRef.current.has(laneKey)) {
            firstSeenAtRef.current.set(laneKey, Date.now());
        }
    }, [laneKey]);

    useEffect(() => {
        let leftPage = false;
        let probe: AbortController | null = null;

        const ask = async () => {
            const asked = latestRef.current;
            if (!asked.lane || asked.hasNewer || asked.newestKnownAt === null) return;
            const fetchedAt = asked.laneFetchedAt ?? firstSeenAtRef.current.get(asked.lane.key);
            if (fetchedAt === undefined || Date.now() - fetchedAt < NEW_POSTS_PROBE_AFTER_MS) return;

            probe?.abort();
            const controller = new AbortController();
            probe = controller;
            const newestAt = await fetchNewestFeedPostPublishedAt(asked.lane.category, controller.signal);
            if (controller.signal.aborted || newestAt === null) return;

            const current = latestRef.current;
            if (current.lane?.key !== asked.lane.key || current.laneFetchedAt !== asked.laneFetchedAt) return;
            const knownAt = Math.max(
                current.newestKnownAt ?? asked.newestKnownAt,
                offeredAtRef.current.get(asked.lane.key) ?? Number.NEGATIVE_INFINITY,
            );
            if (newestAt <= knownAt) return;
            setFound({ laneKey: asked.lane.key, laneFetchedAt: asked.laneFetchedAt, newestAt });
        };

        const leave = () => {
            leftPage = true;
        };
        // One question per return: a page back from the back/forward cache
        // can say so twice, with pageshow and visibilitychange.
        const comeBack = () => {
            if (!leftPage) return;
            leftPage = false;
            void ask();
        };
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'hidden') leave();
            else comeBack();
        };
        const handlePageShow = (event: PageTransitionEvent) => {
            if (event.persisted) comeBack();
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('pagehide', leave);
        window.addEventListener('pageshow', handlePageShow);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('pagehide', leave);
            window.removeEventListener('pageshow', handlePageShow);
            probe?.abort();
        };
    }, []);

    const dismiss = useCallback(() => {
        if (found) offeredAtRef.current.set(found.laneKey, found.newestAt);
        setFound(null);
    }, [found]);

    return { hasNewer, dismiss };
}
