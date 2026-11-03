import type { QueryClient } from '@tanstack/react-query';

import type { CreatorProfileResponse, ShowcaseCreator, ShowcaseFeedItem } from './types';

/**
 * A creator's page, between the tap that opens it and its first read.
 *
 * The read used to start only once the page had mounted, and the page drew a
 * skeleton until it landed: on the iPhone simulator (2026-11-03) a creator
 * opened from a reel had slid in by about +400 ms and showed its skeleton until
 * +1100–1750 ms, its banner a beat after that. Now the read starts as the
 * finger lands on the creator's avatar or handle (`prepareCreatorProfile`), and
 * the page draws who they are from its first frame (`creatorProfileOpening`).
 *
 * Nothing here imports the query or the API client: the reel's chrome and the
 * feed cards only say that a finger landed, and the read itself is installed
 * once, at the root (`ZoomPostPreparer`), as the zoom's preparer is.
 */

let preparer: ((username: string) => void) | null = null;

/**
 * Installs what `prepareCreatorProfile` runs. Returns the way to take it out,
 * which leaves alone a preparer installed after it.
 */
export function setCreatorProfilePreparer(next: (username: string) => void) {
  preparer = next;
  return () => {
    if (preparer === next) preparer = null;
  };
}

/**
 * A finger has landed on a creator's avatar or handle: their page's first read
 * starts now, rather than once the page has mounted.
 *
 * On a touch only, never as a reel slide comes into view. The read is not free
 * on the server: every GET of `/api/creators/[username]` counts against the
 * reader's `creator-profile:read` limit (300 in 10 minutes) through
 * `check_backend_rate_limit`, which upserts a row of `backend_rate_limits`, the
 * table the app's usage is counted from. A read for every slide shown would
 * spend the limit, and the count, on pages nobody opened (checked 2026-11-03:
 * the route writes nothing else, no view count and no ranking state).
 */
export function prepareCreatorProfile(username: string | null | undefined) {
  const handle = username?.trim();
  if (handle) preparer?.(handle);
}

/**
 * Every cache that holds showcase posts, as `refreshUnlockedBundleCaches`
 * (`lib/unlock-cache.ts`) lists them: the lanes of Home and Explore, the Saved
 * list, a reel's own source, and an opened post. A creator's grid is left out:
 * its posts are all theirs, and a grid under the handle the page is routed
 * with is the page's own data.
 */
const POST_CACHES = [['showcase-feed'], ['profile-saved-media'], ['immersive-preview-source'], ['showcase-post']] as const;

/**
 * Who a creator is, as the latest post of theirs the app holds names them, for
 * their page to draw before its own read has landed. The post just tapped is
 * among them: a reel reads its posts from these caches, and Home and Explore
 * draw their cards from them.
 *
 * Returned as the page's profile with what a post does not carry left empty
 * (bio, cover, links, location), so the header draws nothing it does not know
 * and the read fills those in. Both a post and the page name the creator by the
 * server's one rule (`getCreatorDisplayName`) and the same avatar column, so the
 * name and the picture do not change as the read lands. Null when no post of
 * theirs is held: the page then draws its skeleton, as before.
 *
 * Matched on the handle exactly as the page is routed, and only on a post that
 * names the creator's id: a handle routed in another spelling (a typed link)
 * finds nothing rather than a guess.
 */
export function creatorProfileOpening(
  queryClient: Pick<QueryClient, 'getQueryCache'>,
  username: string,
): CreatorProfileResponse['profile'] | null {
  const handle = username.trim();
  if (!handle) return null;
  const cache = queryClient.getQueryCache();
  // The most recently read first: a creator who has changed their name or
  // picture is drawn as their latest post shows them.
  const queries = POST_CACHES
    .flatMap((queryKey) => cache.findAll({ queryKey }))
    .sort((left, right) => right.state.dataUpdatedAt - left.state.dataUpdatedAt);
  for (const query of queries) {
    for (const post of postsIn(query.state.data)) {
      const creator = post?.creator;
      if (creator?.id && creator.username?.trim() === handle && creator.name?.trim()) {
        return openingProfile({ ...creator, id: creator.id }, handle);
      }
    }
  }
  return null;
}

function openingProfile(creator: ShowcaseCreator & { id: string }, handle: string): CreatorProfileResponse['profile'] {
  return {
    id: creator.id,
    username: handle,
    displayName: creator.name.trim(),
    avatarUrl: creator.avatar ?? null,
    bio: null,
    coverUrl: null,
    websiteUrl: null,
    twitterHandle: null,
    instagramHandle: null,
    tiktokHandle: null,
    location: null,
  };
}

/** The posts in one cache entry: a lane's pages, a reel's source, or one post, bare or in its response. */
function postsIn(data: unknown): Array<ShowcaseFeedItem | null | undefined> {
  if (!data || typeof data !== 'object') return [];
  const entry = data as { pages?: unknown; items?: unknown; showcaseItems?: unknown; item?: unknown; creator?: unknown };
  if (Array.isArray(entry.pages)) return entry.pages.flatMap(postsIn);
  if (Array.isArray(entry.items)) return entry.items as ShowcaseFeedItem[];
  if (Array.isArray(entry.showcaseItems)) return entry.showcaseItems as ShowcaseFeedItem[];
  if (entry.item && typeof entry.item === 'object') return [entry.item as ShowcaseFeedItem];
  return entry.creator ? [data as ShowcaseFeedItem] : [];
}
