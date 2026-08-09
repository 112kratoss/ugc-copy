/**
 * Server runtime instrumentation (F15b).
 *
 * Next calls `register()` once per runtime before anything else runs, and routes
 * uncaught request errors to `onRequestError`. Without the latter, App Router
 * errors are swallowed by the framework's own boundary and never reach Sentry.
 *
 * NODE RUNTIME ONLY, AND THE IMPORTS ARE LAZY. `instrumentation.ts` is loaded by
 * the edge runtime too, because middleware lives there. Two reasons to keep the
 * SDK out of it:
 *
 *   1. Middleware runs on *every* request, so its bundle is the one place where
 *      weight is paid unconditionally. `src/proxy.ts` is thin by design — mobile
 *      CORS and client version gating — and an APM SDK is not a proportionate
 *      thing to add to that path.
 *   2. A top-level `import * as Sentry` also pulled the SDK's bundler-plugin
 *      machinery into the server chunks behind the package index, which is why
 *      the `@sentry/*` entries exist in `serverExternalPackages`.
 *
 * The type import below is erased at build time; the value import happens inside
 * the runtime guard.
 *
 * THE COST, STATED PLAINLY: middleware errors are not captured. Server
 * components, route handlers and the browser all are.
 */

import type * as SentryTypes from '@sentry/nextjs';

import {
  SENTRY_ERROR_SAMPLE_RATE,
  SENTRY_TRACES_SAMPLE_RATE,
  assertSentryConfigured,
  resolveSentryDsn,
  resolveSentryEnvironment,
} from '@/lib/sentry-config';

function isNodeRuntime(): boolean {
  return process.env.NEXT_RUNTIME === 'nodejs';
}

export async function register() {
  if (!isNodeRuntime()) return;
  // Warns once per runtime start when production has no DSN, so "configured but
  // reporting nothing" cannot pass unnoticed.
  if (!assertSentryConfigured()) return;

  const Sentry = await import('@sentry/nextjs');

  Sentry.init({
    dsn: resolveSentryDsn(),
    environment: resolveSentryEnvironment(),
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    sampleRate: SENTRY_ERROR_SAMPLE_RATE,
    // The app already has an ops surface for request logs; Sentry is here for
    // exceptions, not as a log sink.
    enableLogs: false,
    // Request bodies here routinely carry prompts, media URLs and payment
    // payloads. None of that belongs in an error tracker. The default is
    // already false — stated so nobody flips it without deciding to.
    sendDefaultPii: false,
  });
}

export async function onRequestError(
  ...args: Parameters<typeof SentryTypes.captureRequestError>
): Promise<void> {
  if (!isNodeRuntime()) return;
  const Sentry = await import('@sentry/nextjs');
  Sentry.captureRequestError(...args);
}
