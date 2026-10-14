import type { InfiniteData } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { MagicbookletApiClient } from './api-client';
import { subscribeToAppForeground } from './app-foreground';
import type { ShowcaseFeedResponse } from './types';

/**
 * A lane fetched less than five minutes ago is not asked about: the reader has
 * only just seen it (product decision D2, 2026-10-14).
 */
export const NEW_POSTS_PROBE_MIN_LANE_AGE_MS = 5 * 60 * 1000;

/** The lanes `GET /api/showcase/feed/newest` can name. */
export type NewPostsProbeCategory = 'media' | 'text' | 'all';

/**
 * The probe's lane for a feed's `category`. Image and video are asked about
 * as media, the smallest lane the server can name that holds them both; a
 * feed with no category is every post.
 */
export function newPostsProbeCategory(category: string | null | undefined): NewPostsProbeCategory {
  if (category === 'text') return 'text';
  if (category === 'media' || category === 'image' || category === 'video') return 'media';
  return 'all';
}

/** The newest post a lane holds, by `createdAt`: what the probe's answer is compared with. */
export function newestFeedPostIn(data: InfiniteData<ShowcaseFeedResponse> | undefined): {
  postId: string | null;
  publishedAt: string | null;
} {
  let newest: { postId: string | null; publishedAt: string | null; time: number } = {
    postId: null,
    publishedAt: null,
    time: Number.NEGATIVE_INFINITY,
  };
  for (const page of data?.pages ?? []) {
    for (const item of page.items) {
      const time = publishedTime(item.createdAt);
      if (time > newest.time) newest = { postId: item.id, publishedAt: item.createdAt, time };
    }
  }
  return { postId: newest.postId, publishedAt: newest.publishedAt };
}

function publishedTime(value: string | null | undefined) {
  if (!value) return Number.NaN;
  // The feed passes Postgres's microseconds through; read to the millisecond,
  // which is all the probe's answer carries and all every engine parses.
  return Date.parse(value.replace(/(\.\d{3})\d+/, '$1'));
}

/**
 * Whether the server has a post newer than the newest the lane holds, asked
 * when the app comes back to the foreground: the "New posts" pill's question
 * (product decision D2). A ranked lane is never refetched under the reader on
 * return; the pill offers the refresh instead, and nothing is fetched into the
 * lane until it is tapped.
 *
 * It asks `GET /api/showcase/feed/newest` at most once per return, only while
 * `enabled`, only when the lane was fetched five minutes ago or more, and not
 * while the pill is already up. The answer is dropped if the lane was fetched
 * again in the meantime, and `hasNewer` belongs to the lane's fetch: a refresh
 * (`laneFetchedAt` changes) or another lane takes it down. A lane that holds
 * no dated post asks nothing, since there is nothing to compare with. A failed
 * probe shows nothing.
 */
export function useNewPostsProbe({
  api,
  category,
  enabled,
  laneFetchedAt,
  newestKnownPublishedAt,
  newestKnownPostId = null,
}: {
  api: Pick<MagicbookletApiClient, 'getShowcaseFeedNewest'>;
  category: NewPostsProbeCategory;
  /** A ranked lane on the screen in front. The Recent lane is unranked and keeps its own refetch. */
  enabled: boolean;
  /** When the lane's pages were fetched: React Query's `dataUpdatedAt`, 0 before the first. */
  laneFetchedAt: number;
  /** The newest `createdAt` among the posts the lane holds (`newestFeedPostIn`). */
  newestKnownPublishedAt: string | null | undefined;
  /** That post's id: the server's newest being the same post is never "newer". */
  newestKnownPostId?: string | null;
}) {
  const laneKey = `${category}:${laneFetchedAt}`;
  // The fetch the pill was raised for. Kept rather than a boolean so a new
  // fetch or another lane takes the pill down without an effect to reset it.
  const [newerFor, setNewerFor] = useState<string | null>(null);
  const latest = useRef({ api, category, laneFetchedAt, laneKey, newerFor, newestKnownPostId, newestKnownPublishedAt });
  useEffect(() => {
    latest.current = { api, category, laneFetchedAt, laneKey, newerFor, newestKnownPostId, newestKnownPublishedAt };
  });

  useEffect(() => {
    if (!enabled) return undefined;
    let probing = false;
    return subscribeToAppForeground((foreground) => {
      if (!foreground || probing) return;
      const asked = latest.current;
      if (asked.laneFetchedAt <= 0 || Date.now() - asked.laneFetchedAt < NEW_POSTS_PROBE_MIN_LANE_AGE_MS) return;
      if (asked.newerFor === asked.laneKey) return;
      if (!Number.isFinite(publishedTime(asked.newestKnownPublishedAt))) return;
      probing = true;
      void asked.api.getShowcaseFeedNewest({ category: asked.category })
        .catch(() => null)
        .then((answer) => {
          probing = false;
          const current = latest.current;
          if (!answer || current.laneKey !== asked.laneKey) return;
          if (answer.newestPostId && answer.newestPostId === current.newestKnownPostId) return;
          if (publishedTime(answer.newestPublishedAt) > publishedTime(current.newestKnownPublishedAt)) {
            setNewerFor(asked.laneKey);
          }
        });
    });
  }, [enabled]);

  const dismiss = useCallback(() => setNewerFor(null), []);

  return { hasNewer: enabled && newerFor === laneKey, dismiss };
}
