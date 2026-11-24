import { useCallback, useEffect, useRef } from 'react';

import { POST_VIEWS_MAX_BATCH, type PostViewSurface } from '@/lib/post-views-service';

import { feedEventIdentity } from './feed-event-outbox';

/**
 * The web's views (post view counts, step 2): a post shown large, half on
 * screen for a second while the page is in front, is reported to
 * `POST /api/showcase/views` from a Home card (`feed`), the post page
 * (`post-page`) and the reel (`reel`), for every reader. A web guest's views
 * count only this way: the server ignores a guest's feed impressions, since a
 * feed cookie can be minted for every request, and holds a guest here to 20 of
 * one network per post per day. A signed-in reader's Home card is counted by
 * its impression too; the server keeps one mark per person, post and UTC day,
 * so a view reported twice counts once.
 *
 * Views are sent in batches, as the feed's events are: a batch goes when it
 * holds 25 (the route's limit), 5 s after the last view queued, 30 s after its
 * first at the latest, and whenever the page is hidden or left (`pagehide`,
 * with `keepalive`, so the browser lets it finish after the page has gone). A
 * view carries the reader's bearer token, read when it was queued, and only
 * JSON: the route refuses anything else, so another site's page cannot send
 * views from its visitors' browsers.
 *
 * Every look at a post reports it, and the reporter keeps one a reader, post
 * and UTC day from this page: the server would do nothing with a second, so it
 * is not sent. A send that is not answered for good (the network failed, a
 * 5xx, 401, 408 or 429) lets its views go, the page's last batch's included
 * (a page the back/forward cache brings back hears its answer then), so the
 * next look at the post reports it again; and a look on a new UTC day is that
 * day's view.
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
  window.addEventListener('pagehide', () => { void flushPostViews(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushPostViews();
  });
}

/**
 * Sends every view queued now, one request per token and 25 views, each with
 * `keepalive`, so one sent as the page goes still leaves. A view whose send is
 * not answered for good is let go, for a later look to report again. Never
 * rejects.
 */
export function flushPostViews(): Promise<void> {
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
        chunk.forEach((view) => reportedViewKeys.delete(view.key));
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

/**
 * The newest of an observer callback's entries for one element. A callback
 * carries every change since the last, oldest first: a post scrolled in and
 * out between two of them comes with both, and only the last is where it is.
 */
export function newestEntryFor<Entry extends { target: Element }>(entries: readonly Entry[], target: Element): Entry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].target === target) return entries[index];
  }
  return undefined;
}

/**
 * The band across the middle of the screen, 1% of it tall: an observer with
 * this root margin says whether a post crosses the screen's middle.
 */
export const SCREEN_MIDDLE_ROOT_MARGIN = '-50% 0px -49% 0px';

/**
 * Reports a post's view each time it is looked at for a second, while the
 * page is in front, for a page that shows one post large (the post page). A
 * look is the post on screen, half of it, or across the middle of the screen,
 * which is what a post taller than the screen can show: across the middle, at
 * least half the screen is the post (for a shorter post it says nothing more,
 * since more than half of it is on screen then). Each is watched by an
 * observer of its own, so a post of any height is heard while it is scrolled:
 * an observer speaks only as its thresholds are crossed, and a very tall
 * post's share of itself on screen crosses none.
 *
 * A look ends when the post leaves the screen or the page is hidden; the next
 * one reports again, and the reporter keeps one a reader, post and UTC day. So
 * a view whose send failed is sent by the next look, and a page left open
 * past midnight reports the next day's.
 *
 * `enabled` is false where no view is reported (a post that is not public, the
 * creator's own) and while the session is still being read: a look that
 * qualified meanwhile waits for it, so a signed-in reader's view never goes as
 * a guest's. Returns the ref for the element that is the post: an element
 * drawn afresh (the page's notice for a blocked post and back) is watched
 * afresh.
 */
export function usePostViewOnScreen({
  postId,
  surface,
  accessToken,
  enabled,
}: {
  postId: string;
  surface: PostViewSurface;
  accessToken: string | null;
  enabled: boolean;
}): (element: Element | null) => (() => void) | undefined {
  // What a view is sent with, kept current for the timer below without
  // watching the post again. Written after render, read only by it.
  const contextRef = useRef({ surface, accessToken, enabled });
  useEffect(() => {
    contextRef.current = { surface, accessToken, enabled };
  });
  // The post whose look qualified while views could not be sent yet.
  const heldPostIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || heldPostIdRef.current !== postId) return;
    heldPostIdRef.current = null;
    reportPostView({ postId, surface, accessToken });
  }, [accessToken, enabled, postId, surface]);

  // The element is watched from its ref, which React 19 cleans up when the
  // element goes or the post changes, and calls again for an element drawn
  // afresh. No state: setting it as the post mounts would draw the page that
  // holds it (the post page's whole body) a second time.
  return useCallback((target: Element | null) => {
    if (!target || typeof IntersectionObserver === 'undefined') return undefined;

    let halfOnScreen = false;
    let acrossMiddle = false;
    let lookReported = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const update = () => {
      if (!(halfOnScreen || acrossMiddle) || document.visibilityState === 'hidden') {
        stop();
        lookReported = false;
        return;
      }
      if (lookReported || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        lookReported = true;
        const context = contextRef.current;
        if (context.enabled) {
          reportPostView({ postId, surface: context.surface, accessToken: context.accessToken });
        } else {
          heldPostIdRef.current = postId;
        }
      }, POST_VIEW_QUALIFY_MS);
    };
    const halfObserver = new IntersectionObserver((entries) => {
      const entry = newestEntryFor(entries, target);
      if (!entry) return;
      halfOnScreen = entry.isIntersecting && entry.intersectionRatio >= 0.5;
      update();
    }, { threshold: [0, 0.5] });
    const middleObserver = new IntersectionObserver((entries) => {
      const entry = newestEntryFor(entries, target);
      if (!entry) return;
      acrossMiddle = entry.isIntersecting;
      update();
    }, { rootMargin: SCREEN_MIDDLE_ROOT_MARGIN, threshold: 0 });
    halfObserver.observe(target);
    middleObserver.observe(target);
    document.addEventListener('visibilitychange', update);
    return () => {
      stop();
      halfObserver.disconnect();
      middleObserver.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, [postId]);
}
