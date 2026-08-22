/**
 * Browser instrumentation (F15b).
 *
 * Next.js loads this before any application code in the browser. Keeping it
 * separate from `instrumentation.ts` matters: that file runs in Node and edge
 * runtimes, and importing it here would drag server-only code into the client
 * bundle.
 */

import {
  SENTRY_ERROR_SAMPLE_RATE,
  SENTRY_TRACES_SAMPLE_RATE,
  assertSentryConfigured,
  resolveSentryDsn,
  resolveSentryEnvironment,
} from '@/lib/sentry-config';

type SentryClient = typeof import('@sentry/nextjs');

const MAX_BUFFERED_EXCEPTIONS = 20;
const BACKGROUND_INITIALIZATION_DELAY_MS = 30_000;

let bufferedExceptions: unknown[] = [];
let sentryClientPromise: Promise<SentryClient | null> | null = null;
let earlyListenersAttached = false;

const sentryConfigured = assertSentryConfigured();

function bufferException(exception: unknown) {
  if (!sentryConfigured) return;

  if (bufferedExceptions.length >= MAX_BUFFERED_EXCEPTIONS) {
    bufferedExceptions.shift();
  }
  bufferedExceptions.push(exception);
  void initializeSentryClient();
}

function handleEarlyWindowError(event: ErrorEvent) {
  bufferException(
    event.error
      ?? new Error(event.message || 'Uncaught browser error before Sentry initialization'),
  );
}

function handleEarlyUnhandledRejection(event: PromiseRejectionEvent) {
  bufferException(event.reason ?? new Error('Unhandled promise rejection before Sentry initialization'));
}

function attachEarlyErrorListeners() {
  if (earlyListenersAttached) return;
  earlyListenersAttached = true;
  window.addEventListener('error', handleEarlyWindowError);
  window.addEventListener('unhandledrejection', handleEarlyUnhandledRejection);
}

function detachEarlyErrorListeners() {
  if (!earlyListenersAttached) return;
  earlyListenersAttached = false;
  window.removeEventListener('error', handleEarlyWindowError);
  window.removeEventListener('unhandledrejection', handleEarlyUnhandledRejection);
}

function initializeSentryClient(): Promise<SentryClient | null> {
  if (!sentryConfigured) return Promise.resolve(null);
  if (sentryClientPromise) return sentryClientPromise;

  sentryClientPromise = import('@sentry/nextjs')
    .then((Sentry) => {
      // Event dispatch cannot interleave with this synchronous detach/init
      // sequence, so an exception is always owned by either the small early
      // buffer or Sentry's installed global handlers, never both.
      detachEarlyErrorListeners();
      try {
        Sentry.init({
          dsn: resolveSentryDsn(),
          environment: resolveSentryEnvironment(),
          tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
          sampleRate: SENTRY_ERROR_SAMPLE_RATE,
          enableLogs: false,
          // See the server note: prompts and media URLs must not leave the app
          // in an error payload.
          sendDefaultPii: false,
          // No session replay. It is a paid-tier feature at any useful volume,
          // and the budget constraint recorded in F15b rules it out for now.
          replaysSessionSampleRate: 0,
          replaysOnErrorSampleRate: 0,
        });
      } catch (error) {
        attachEarlyErrorListeners();
        throw error;
      }

      const pendingExceptions = bufferedExceptions;
      bufferedExceptions = [];
      pendingExceptions.forEach((exception) => Sentry.captureException(exception));
      return Sentry;
    })
    .catch((error) => {
      sentryClientPromise = null;
      attachEarlyErrorListeners();
      // Error tracking must never make the application fail. Keep the early
      // listeners available for a later retry and make the degradation loud.
      console.warn(
        '[sentry] Browser SDK initialization failed; buffered errors will be retried.',
        error instanceof Error ? error.message : error,
      );
      return null;
    });

  return sentryClientPromise;
}

function scheduleBackgroundInitialization() {
  window.setTimeout(() => {
    void initializeSentryClient();
  }, BACKGROUND_INITIALIZATION_DELAY_MS);
}

if (sentryConfigured) {
  // Preserve errors that happen during startup without forcing every visitor
  // to download and parse the 500 KB SDK before the page becomes interactive.
  // A real error loads it immediately and flushes this bounded buffer. Healthy
  // sessions warm it only after the critical rendering window has passed.
  attachEarlyErrorListeners();
  if (document.readyState === 'complete') {
    scheduleBackgroundInitialization();
  } else {
    window.addEventListener('load', scheduleBackgroundInitialization, { once: true });
  }
}

/**
 * Next.js calls this hook when a client-side router transition starts. Sentry
 * uses it only for performance tracing, which this project deliberately keeps
 * disabled to preserve the free-tier quota and the browser performance budget.
 * Keep the no-op export so both Next.js and Sentry know the decision is
 * intentional without retaining Sentry's router tracing implementation.
 */
export function onRouterTransitionStart() {
  // Performance tracing is disabled by design.
}
