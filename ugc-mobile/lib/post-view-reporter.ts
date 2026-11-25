/**
 * The app's views (post view counts, step 3; plan:
 * docs/plans/post-view-counts-2026-11-23.md). A post shown large outside the
 * feed, half of it on screen for a second while the app is in front, is
 * reported to `POST /api/showcase/views` through `api.recordPostViews`: the
 * post page (`post-page`) and a reel opened from a profile, Saved, search, a
 * link or Explore (`reel`). Home's cards and a reel opened on the feed send
 * nothing: their impressions are counted by the server already (the
 * `feed_events` trigger), and a view reported both ways would count once
 * anyway, since the server keeps one mark per person, post and UTC day.
 *
 * Modelled on the web's `src/app/showcase/post-view-reporter.ts`:
 *
 * - Views go in batches: at 25 (the route's limit), 5 s after the last view
 *   queued, 30 s after the batch's first at the latest, and whenever the app
 *   leaves the foreground (`lib/auth.tsx` flushes it beside the feed's events).
 * - A view is reported once a reader, post and UTC day from this run of the
 *   app: the server would do nothing with a second.
 * - A send that is not answered for good (offline, a 5xx, 401, 408 or 429)
 *   lets its views go, so the next look at the post reports it again; a look
 *   on a new UTC day is that day's view.
 * - A view goes under the identity that saw it. The API client puts the
 *   session's token on a request as it leaves, so a view queued before a
 *   sign-in or a sign-out is let go rather than counted for someone else.
 *
 * Nothing is kept on disk: a view lost to a killed app is a look's worth, and
 * the next look reports it.
 */

/** Where a view was seen: the surfaces the route takes from the app. */
export type PostViewSurface = 'post-page' | 'reel';

/** The most views one request carries (`recordPostViews.maxViews` in the contract). */
export const POST_VIEWS_MAX_BATCH = 25;
/** The quiet a batch waits for before it goes. */
export const POST_VIEW_FLUSH_DELAY_MS = 5_000;
/** The longest the first view of a batch waits. */
export const POST_VIEW_MAX_WAIT_MS = 30_000;
/** The views remembered as reported, oldest forgotten first. */
const REPORTED_VIEW_MEMORY_LIMIT = 2_000;

export type PostViewRequestBody = { views: Array<{ postId: string; surface: PostViewSurface }> };

type QueuedPostView = {
  postId: string;
  surface: PostViewSurface;
  /** The identity (`identityUserId`) the post was seen by. */
  identity: string;
  /** Whose view of which post on which UTC day: what is reported once. */
  key: string;
  queuedAt: number;
};

type Timer = ReturnType<typeof setTimeout>;

export interface PostViewReporterDependencies {
  /** Sends one batch: `api.recordPostViews`, which answers 204. */
  send: (body: PostViewRequestBody) => Promise<unknown>;
  /** The identity the API client is signed in as now, or null with no session. */
  currentIdentity: () => string | null;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

/** The UTC day a moment falls on, as the server counts a view's day. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function failureStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

/**
 * A refusal a resend would not change (a malformed batch, a body too large):
 * the views stay reported. Anything else, the network included, lets them go.
 */
export function isSettledPostViewFailure(error: unknown): boolean {
  const status = failureStatus(error);
  return status !== null && status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
}

export function createPostViewReporter({
  send,
  currentIdentity,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: PostViewReporterDependencies) {
  let pending: QueuedPostView[] = [];
  const reported = new Set<string>();
  let timer: Timer | null = null;

  const remember = (key: string) => {
    reported.add(key);
    if (reported.size <= REPORTED_VIEW_MEMORY_LIMIT) return;
    const oldest = reported.values().next().value;
    if (oldest !== undefined) reported.delete(oldest);
  };

  /**
   * Sends every view queued now, 25 to a request, those of the identity
   * signed in now; a view of another identity, or whose send is not answered
   * for good, is let go for a later look. Never rejects.
   */
  const flush = (): Promise<void> => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const queued = pending;
    pending = [];
    if (queued.length === 0) return Promise.resolve();

    const identity = currentIdentity();
    const sendable: QueuedPostView[] = [];
    for (const view of queued) {
      if (view.identity === identity) sendable.push(view);
      else reported.delete(view.key);
    }

    const requests: Array<Promise<void>> = [];
    for (let index = 0; index < sendable.length; index += POST_VIEWS_MAX_BATCH) {
      const chunk = sendable.slice(index, index + POST_VIEWS_MAX_BATCH);
      const letGo = (error: unknown) => {
        if (isSettledPostViewFailure(error)) return;
        chunk.forEach((view) => reported.delete(view.key));
      };
      requests.push(
        Promise.resolve()
          .then(() => send({ views: chunk.map(({ postId, surface }) => ({ postId, surface })) }))
          .then(() => undefined, letGo),
      );
    }
    return Promise.all(requests).then(() => undefined);
  };

  /**
   * A post was seen, half of it on screen for a second, by `identity`. Queued
   * for the next batch, unless that reader reported the post already today.
   * Answers whether it was queued.
   */
  const report = ({ postId, surface, identity }: { postId: string; surface: PostViewSurface; identity: string }): boolean => {
    if (!postId || !identity) return false;
    const at = now();
    const key = `${identity}:${postId}:${utcDay(at)}`;
    if (reported.has(key)) return false;
    remember(key);
    pending.push({ postId, surface, identity, key, queuedAt: at });

    if (pending.length >= POST_VIEWS_MAX_BATCH) {
      void flush();
      return true;
    }
    // Each view starts the quiet again, up to the longest the oldest may wait.
    if (timer !== null) clearTimer(timer);
    const oldestQueuedAt = pending[0]?.queuedAt ?? at;
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, Math.max(0, Math.min(POST_VIEW_FLUSH_DELAY_MS, oldestQueuedAt + POST_VIEW_MAX_WAIT_MS - at)));
    return true;
  };

  const reset = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    pending = [];
    reported.clear();
  };

  return { report, flush, reset, pendingCount: () => pending.length };
}

export type PostViewReporter = ReturnType<typeof createPostViewReporter>;

// The app's one reporter, configured with the API client by `lib/auth.tsx`.
let runtime: Pick<PostViewReporterDependencies, 'send' | 'currentIdentity'> | null = null;
let appReporter: PostViewReporter | null = null;

function getAppReporter(): PostViewReporter | null {
  if (!runtime) return null;
  if (!appReporter) {
    appReporter = createPostViewReporter({
      // Read at send time, so a client the auth provider made anew is used.
      send: (body) => (runtime ? runtime.send(body) : Promise.resolve()),
      currentIdentity: () => runtime?.currentIdentity() ?? null,
    });
  }
  return appReporter;
}

/** Hands the reporter the API client's send and the identity it is signed in as. */
export function configurePostViewReporter(next: Pick<PostViewReporterDependencies, 'send' | 'currentIdentity'>) {
  runtime = next;
}

/** Queues a view with the app's reporter; nothing before the auth provider configured it. */
export function reportPostView(view: { postId: string; surface: PostViewSurface; identity: string }): boolean {
  return getAppReporter()?.report(view) ?? false;
}

/** Sends the app's queued views now: the app is leaving the foreground. Never rejects. */
export function flushPostViews(): Promise<void> {
  return getAppReporter()?.flush() ?? Promise.resolve();
}

export function resetPostViewReporterForTests() {
  appReporter?.reset();
  appReporter = null;
  runtime = null;
}
