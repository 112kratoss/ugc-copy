import { useEffect, useRef, useState, type RefObject } from 'react';

import { POST_VIEWS_MAX_BATCH, type PostViewSurface } from '@/lib/post-views-service';

import { feedEventIdentity } from './feed-event-outbox';

/**
 * The web's views (post view counts, step 2): a post shown large, half on
 * screen for a second, is reported to `POST /api/showcase/views` from a Home
 * card (`feed`), the post page (`post-page`) and the reel (`reel`), for every
 * reader. A web guest's views count only this way: the server ignores a guest's
 * feed impressions, since a feed cookie can be minted for every request, and
 * holds a guest here to 20 of one network per post per day. A signed-in
 * reader's Home card is counted by its impression too; the server keeps one
 * mark per person, post and UTC day, so a view reported twice counts once.
 *
 * Views are sent in batches, as the feed's events are: a batch goes when it
 * holds 25 (the route's limit), 5 s after the last view queued, 30 s after its
 * first at the latest, and whenever the page is hidden or left (`pagehide`,
 * with `keepalive`, so the browser lets it finish after the page has gone). A
 * view carries the reader's bearer token, read when it was queued, and only
 * JSON: the route refuses anything else, so another site's page cannot send
 * views from its visitors' browsers.
 *
 * Each reader reports a post once a UTC day from this page: the server would
 * do nothing with a second report, so it is not sent. A send that is not
 * answered for good (the network failed, a 5xx, 401, 408 or 429) lets its
 * views go, for a later look at the same post to report again.
 */

/** The quiet a batch waits for before it goes. */
export const POST_VIEW_FLUSH_DELAY_MS = 5_000;
/** The longest the first view of a batch waits. */
export const POST_VIEW_MAX_WAIT_MS = 30_000;
/** How long a post is on screen, half of it, before it counts as seen: the feed's qualified impression. */
export const POST_VIEW_QUALIFY_MS = 1_000;
/** The views remembered as reported, oldest forgotten first. */
const REPORTED_VIEW_MEMORY_LIMIT = 2_000;

type QueuedPostView = {
  postId: string;
  surface: PostViewSurface;
  accessToken: string | null;
  /** Whose view of which post on which UTC day: what is reported once. */
  key: string;
  queuedAt: number;
};

let pendingViews: QueuedPostView[] = [];
const reportedViewKeys = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let unloadFlushBound = false;

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function rememberReported(key: string) {
  reportedViewKeys.add(key);
  if (reportedViewKeys.size <= REPORTED_VIEW_MEMORY_LIMIT) return;
  const oldest = reportedViewKeys.values().next().value;
  if (oldest !== undefined) reportedViewKeys.delete(oldest);
}

/** Answered for good: recorded (204), or refused in a way a resend would not change. */
function isSettledPostViewResponse(status: number): boolean {
  return (status >= 200 && status < 300)
    || (status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429);
}

function postViews(accessToken: string | null, views: QueuedPostView[]): Promise<Response> {
  return fetch('/api/showcase/views', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ views: views.map(({ postId, surface }) => ({ postId, surface })) }),
    // The last batch often goes as the page does; without this the browser
    // cancels it.
    keepalive: true,
  });
}

function bindUnloadFlush() {
  if (unloadFlushBound || typeof window === 'undefined') return;
  unloadFlushBound = true;
  // pagehide rather than unload: it fires for the back/forward cache too.
  window.addEventListener('pagehide', () => { void flushPostViews({ unloading: true }); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushPostViews();
  });
}

/**
 * Sends every view queued now, one request per token and 25 views. With
 * `unloading` the page is going away: the requests still leave, with
 * `keepalive`, but their answers are never heard. Never rejects.
 */
export function flushPostViews({ unloading = false }: { unloading?: boolean } = {}): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const queued = pendingViews;
  pendingViews = [];
  if (queued.length === 0 || typeof fetch !== 'function') return Promise.resolve();

  // One request carries one Authorization header, and a reader can sign in or
  // out while views wait, so each goes with the token it was queued under.
  const byToken = new Map<string, QueuedPostView[]>();
  for (const view of queued) {
    const bucket = byToken.get(view.accessToken ?? '');
    if (bucket) bucket.push(view);
    else byToken.set(view.accessToken ?? '', [view]);
  }

  const requests: Array<Promise<void>> = [];
  for (const bucket of byToken.values()) {
    for (let index = 0; index < bucket.length; index += POST_VIEWS_MAX_BATCH) {
      const chunk = bucket.slice(index, index + POST_VIEWS_MAX_BATCH);
      const letGo = () => {
        if (!unloading) chunk.forEach((view) => reportedViewKeys.delete(view.key));
      };
      requests.push(
        postViews(chunk[0].accessToken, chunk)
          .then((response) => {
            if (!isSettledPostViewResponse(response.status)) letGo();
          }, letGo),
      );
    }
  }
  return Promise.all(requests).then(() => undefined);
}

/**
 * A post was seen: half of it on screen for a second, on one of the surfaces
 * that count. Queued for the next batch, unless this reader reported the post
 * already today from this page.
 */
export function reportPostView({
  postId,
  surface,
  accessToken = null,
}: {
  postId: string;
  surface: PostViewSurface;
  accessToken?: string | null;
}) {
  if (typeof window === 'undefined' || !postId) return;
  const now = Date.now();
  const key = `${feedEventIdentity(accessToken) ?? 'unread'}:${postId}:${utcDay(now)}`;
  if (reportedViewKeys.has(key)) return;
  rememberReported(key);
  pendingViews.push({ postId, surface, accessToken, key, queuedAt: now });
  bindUnloadFlush();

  if (pendingViews.length >= POST_VIEWS_MAX_BATCH) {
    void flushPostViews();
    return;
  }
  // Each view starts the quiet again, up to the longest the oldest may wait.
  if (flushTimer !== null) clearTimeout(flushTimer);
  const oldestQueuedAt = pendingViews[0]?.queuedAt ?? now;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPostViews();
  }, Math.max(0, Math.min(POST_VIEW_FLUSH_DELAY_MS, oldestQueuedAt + POST_VIEW_MAX_WAIT_MS - now)));
}

/** The queue and its memory are module state: a test starts from none. */
export function resetPostViewReporterForTests() {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pendingViews = [];
  reportedViewKeys.clear();
}

type OnScreenEntry = Pick<IntersectionObserverEntry, 'isIntersecting' | 'intersectionRatio' | 'intersectionRect' | 'rootBounds'>;

/**
 * Half the post on screen, as the feed's qualified impression asks of a card:
 * half of the element. A post taller than two screens (a long text post on a
 * phone) can never show half of itself, so for it half the screen is enough.
 */
export function isPostHalfOnScreen(entry: OnScreenEntry): boolean {
  if (!entry.isIntersecting) return false;
  if (entry.intersectionRatio >= 0.5) return true;
  const screenHeight = entry.rootBounds?.height ?? (typeof window === 'undefined' ? 0 : window.innerHeight);
  return screenHeight > 0 && entry.intersectionRect.height >= screenHeight / 2;
}

/**
 * Every 5% of the element: the half-the-screen rule of a tall post is met
 * between two of them, and the callback has to run near it.
 */
const ON_SCREEN_THRESHOLDS = Array.from({ length: 21 }, (_, step) => step / 20);

/**
 * Reports a post's view once it has been half on screen for a second, while
 * the page is in front, for a page that shows one post large (the post page).
 * `enabled` is false where no view is reported (a post that is not public, the
 * creator's own) and while the session is still being read: a view that
 * qualified meanwhile waits for it, so a signed-in reader's view never goes as
 * a guest's. One report per post a mount.
 */
export function usePostViewOnScreen(
  targetRef: RefObject<Element | null>,
  {
    postId,
    surface,
    accessToken,
    enabled,
  }: {
    postId: string;
    surface: PostViewSurface;
    accessToken: string | null;
    enabled: boolean;
  },
) {
  const [seenPostId, setSeenPostId] = useState<string | null>(null);
  const reportedPostIdRef = useRef<string | null>(null);

  useEffect(() => {
    const target = targetRef.current;
    if (!target || seenPostId === postId || typeof IntersectionObserver === 'undefined') return;

    let halfOnScreen = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const update = () => {
      if (!halfOnScreen || document.visibilityState === 'hidden') {
        stop();
        return;
      }
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        setSeenPostId(postId);
      }, POST_VIEW_QUALIFY_MS);
    };
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === target) ?? entries.at(-1);
      if (!entry) return;
      halfOnScreen = isPostHalfOnScreen(entry);
      update();
    }, { threshold: ON_SCREEN_THRESHOLDS });
    observer.observe(target);
    document.addEventListener('visibilitychange', update);
    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, [postId, seenPostId, targetRef]);

  useEffect(() => {
    if (!enabled || seenPostId !== postId || reportedPostIdRef.current === postId) return;
    reportedPostIdRef.current = postId;
    reportPostView({ postId, surface, accessToken });
  }, [accessToken, enabled, postId, seenPostId, surface]);
}
