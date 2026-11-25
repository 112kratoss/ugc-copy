/**
 * The app's views (post view counts, step 3; plan:
 * docs/plans/post-view-counts-2026-11-23.md). A post looked at, half of it on
 * screen for a second while the app is in front, is reported to
 * `POST /api/showcase/views` through `api.recordPostViews`: Home's cards
 * (`feed`), the post page (`post-page`) and every slide of a reel (`reel`),
 * as the web reports them. A feed's impression of the same post is counted as
 * its view too; the server keeps one mark a person, post and UTC day, so the
 * two count once (review of #929: an impression alone missed Explore's reel,
 * Home's Recent chip and an expired feed session).
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
 * - A view goes under the identity that saw it, and only with that session's
 *   token: the sender reads the token for that identity and sends it itself
 *   (`send`'s `identity`), so a sign-in or a sign-out while a batch waits for
 *   its token never counts it for someone else. A sign-in or a sign-out sends
 *   the leaving identity's views at once with its own token
 *   (`flushIdentity`); a view of another identity found at a batch is let go.
 * - A view seen while the session is unknown (a cold start still reading it,
 *   or a device whose guest sign-in failed and is being tried again) is held
 *   and reported under the next identity the device has, the same person's.
 *
 * Nothing is kept on disk: a view lost to a killed app is a look's worth, and
 * the next look reports it.
 */

/** Where a view was seen: the surfaces the route takes from the app. */
export type PostViewSurface = 'feed' | 'post-page' | 'reel';

/** The most views one request carries (`recordPostViews.maxViews` in the contract). */
export const POST_VIEWS_MAX_BATCH = 25;
/** The quiet a batch waits for before it goes. */
export const POST_VIEW_FLUSH_DELAY_MS = 5_000;
/** The longest the first view of a batch waits. */
export const POST_VIEW_MAX_WAIT_MS = 30_000;
/** The views remembered as reported, oldest forgotten first. */
const REPORTED_VIEW_MEMORY_LIMIT = 2_000;
/** The views held for an identity to come, oldest dropped first. */
const HELD_VIEWS_LIMIT = 100;

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

type HeldPostView = {
  postId: string;
  surface: PostViewSurface;
  heldAt: number;
};

type Timer = ReturnType<typeof setTimeout>;

/** How one batch is to be sent. */
export interface PostViewSendOptions {
  /** The identity every view of the batch was seen by. */
  identity: string;
  /**
   * The token to send it with, given only for an identity a sign-in or a
   * sign-out is leaving (its session's own). Without it the sender reads the
   * session's token and sends only while that session is `identity`'s,
   * rejecting otherwise, which lets the views go.
   */
  accessToken?: string;
}

export interface PostViewReporterDependencies {
  /** Sends one batch: `api.recordPostViews`, which answers 204. */
  send: (body: PostViewRequestBody, options: PostViewSendOptions) => Promise<unknown>;
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
  let held: HeldPostView[] = [];
  const reported = new Set<string>();
  let timer: Timer | null = null;

  const remember = (key: string) => {
    reported.add(key);
    if (reported.size <= REPORTED_VIEW_MEMORY_LIMIT) return;
    const oldest = reported.values().next().value;
    if (oldest !== undefined) reported.delete(oldest);
  };

  const cancelTimer = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  /** Sends `views`, all seen by `identity`, 25 to a request; a send not answered for good lets its views go. */
  const sendViews = (views: QueuedPostView[], options: PostViewSendOptions): Promise<void> => {
    const requests: Array<Promise<void>> = [];
    for (let index = 0; index < views.length; index += POST_VIEWS_MAX_BATCH) {
      const chunk = views.slice(index, index + POST_VIEWS_MAX_BATCH);
      const letGo = (error: unknown) => {
        if (isSettledPostViewFailure(error)) return;
        chunk.forEach((view) => reported.delete(view.key));
      };
      requests.push(
        Promise.resolve()
          .then(() => send({ views: chunk.map(({ postId, surface }) => ({ postId, surface })) }, options))
          .then(() => undefined, letGo),
      );
    }
    return Promise.all(requests).then(() => undefined);
  };

  /**
   * Sends every view queued now, those of the identity signed in now; a view
   * of another identity, or whose send is not answered for good, is let go
   * for a later look. Held views go first to the identity signed in now, if
   * there is one. Never rejects.
   */
  const flush = (): Promise<void> => {
    adoptHeldViews();
    cancelTimer();
    const queued = pending;
    pending = [];
    if (queued.length === 0) return Promise.resolve();

    const identity = currentIdentity();
    const sendable: QueuedPostView[] = [];
    for (const view of queued) {
      if (identity && view.identity === identity) sendable.push(view);
      else reported.delete(view.key);
    }
    return identity && sendable.length > 0 ? sendViews(sendable, { identity }) : Promise.resolve();
  };

  /**
   * A sign-in or a sign-out is leaving `identity`: its queued views go now,
   * with that session's own token, rather than being let go at the next batch
   * as another identity's. Never rejects.
   */
  const flushIdentity = ({ identity, accessToken }: { identity: string; accessToken: string }): Promise<void> => {
    const leaving = pending.filter((view) => view.identity === identity);
    if (leaving.length === 0) return Promise.resolve();
    pending = pending.filter((view) => view.identity !== identity);
    if (pending.length === 0) cancelTimer();
    return sendViews(leaving, { identity, accessToken });
  };

  const queue = (postId: string, surface: PostViewSurface, identity: string, at: number): boolean => {
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

  /**
   * The views held while the session was unknown, queued under the identity
   * signed in now: the same person's, now that the device has one. Nothing
   * while there is still none.
   */
  function adoptHeldViews() {
    if (held.length === 0) return;
    const identity = currentIdentity();
    if (!identity) return;
    const views = held;
    held = [];
    const at = now();
    for (const view of views) queue(view.postId, view.surface, identity, at);
  }

  /**
   * A post was seen, half of it on screen for a second, by `identity`, or
   * while the session is unknown (null). Queued for the next batch, unless
   * that reader reported the post already today, or held for the identity to
   * come. Answers whether it was queued or held.
   */
  const report = ({ postId, surface, identity }: { postId: string; surface: PostViewSurface; identity: string | null }): boolean => {
    if (!postId) return false;
    const at = now();
    if (!identity) {
      const day = utcDay(at);
      if (held.some((view) => view.postId === postId && utcDay(view.heldAt) === day)) return false;
      held.push({ postId, surface, heldAt: at });
      if (held.length > HELD_VIEWS_LIMIT) held = held.slice(held.length - HELD_VIEWS_LIMIT);
      return true;
    }
    adoptHeldViews();
    return queue(postId, surface, identity, at);
  };

  const reset = () => {
    cancelTimer();
    pending = [];
    held = [];
    reported.clear();
  };

  return { report, flush, flushIdentity, adoptHeldViews, reset, pendingCount: () => pending.length };
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
      send: (body, options) => (runtime ? runtime.send(body, options) : Promise.resolve()),
      currentIdentity: () => runtime?.currentIdentity() ?? null,
    });
  }
  return appReporter;
}

/**
 * Hands the reporter the API client's send and the identity it is signed in
 * as: the auth provider calls it again whenever its session changes, which is
 * when views held for an identity are reported under it.
 */
export function configurePostViewReporter(next: Pick<PostViewReporterDependencies, 'send' | 'currentIdentity'>) {
  runtime = next;
  appReporter?.adoptHeldViews();
}

/** Queues a view with the app's reporter; nothing before the auth provider configured it. */
export function reportPostView(view: { postId: string; surface: PostViewSurface; identity: string | null }): boolean {
  return getAppReporter()?.report(view) ?? false;
}

/** Sends the app's queued views now: the app is leaving the foreground. Never rejects. */
export function flushPostViews(): Promise<void> {
  return getAppReporter()?.flush() ?? Promise.resolve();
}

/**
 * Sends the views of an identity a sign-in or a sign-out is leaving, with
 * that session's own token, while the token still answers. Never rejects.
 */
export function flushPostViewsOfLeavingIdentity(leaving: { identity: string; accessToken: string }): Promise<void> {
  return getAppReporter()?.flushIdentity(leaving) ?? Promise.resolve();
}

export function resetPostViewReporterForTests() {
  appReporter?.reset();
  appReporter = null;
  runtime = null;
}
