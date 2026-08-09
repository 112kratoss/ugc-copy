/**
 * Browser instrumentation (F15b).
 *
 * Next.js loads this before any application code in the browser. Keeping it
 * separate from `instrumentation.ts` matters: that file runs in Node and edge
 * runtimes, and importing it here would drag server-only code into the client
 * bundle.
 */

import * as Sentry from '@sentry/nextjs';

import {
  SENTRY_ERROR_SAMPLE_RATE,
  SENTRY_TRACES_SAMPLE_RATE,
  assertSentryConfigured,
  resolveSentryDsn,
  resolveSentryEnvironment,
} from '@/lib/sentry-config';

if (assertSentryConfigured()) {
  Sentry.init({
    dsn: resolveSentryDsn(),
    environment: resolveSentryEnvironment(),
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    sampleRate: SENTRY_ERROR_SAMPLE_RATE,
    enableLogs: false,
    // See the server note: prompts and media URLs must not leave the app in an
    // error payload.
    sendDefaultPii: false,
    // No session replay. It is a paid-tier feature at any useful volume, and
    // the budget constraint recorded in F15b rules out paid services for now.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  });
}

/**
 * Reports client-side navigation errors. Next.js calls this on router
 * transitions; without it, navigation failures never reach Sentry.
 */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
