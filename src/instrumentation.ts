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
 * THE SDK LOADS WITH THE FIRST ERROR, NOT AT STARTUP. Next awaits `register()`
 * before an instance serves its first request, and importing `@sentry/nextjs`
 * there (a large CommonJS graph, read and compiled synchronously) made every
 * fresh instance's first request wait 600–1,100 ms: 160 such requests in twelve
 * hours on 2026-11-19, median about 880 ms (`server_registration_timing`), most
 * of them the first call an app or a browser makes after a quiet spell. Server
 * code uses the SDK only to report errors (tracing is sampled at zero), so an
 * instance now loads it when it first has something to report:
 *
 *   - a request error, through `onRequestError`;
 *   - an unhandled rejection or an uncaught exception, through the stand-in
 *     process handlers `register()` installs. They hand over to the SDK's own
 *     handlers (its default `OnUnhandledRejection` and `OnUncaughtException`
 *     integrations) once it is in, and behave as those do meanwhile: a
 *     rejection is reported and does not end the process, as the SDK's "warn"
 *     mode never let it; an exception is reported, flushed, and ends the
 *     process unless another handler is there to decide.
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

type SentryModule = typeof SentryTypes;

function isNodeRuntime(): boolean {
  return process.env.NEXT_RUNTIME === 'nodejs';
}

let sentryLoad: Promise<SentryModule | null> | null = null;
let standInHandlersInstalled = false;

/**
 * The SDK, imported and initialised once per instance, on first use. Settles to
 * null when no DSN is configured. A failed import or init is logged and not
 * kept, so the next error tries again.
 */
function loadSentry(): Promise<SentryModule | null> {
  sentryLoad ??= (async () => {
    if (!assertSentryConfigured()) return null;
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
    // The SDK's own process handlers are in now; the stand-ins step aside so
    // nothing is reported twice.
    removeStandInHandlers();
    return Sentry;
  })().catch((error: unknown) => {
    sentryLoad = null;
    console.error('[sentry] could not load the server SDK; this error goes unreported', error);
    return null;
  });
  return sentryLoad;
}

/**
 * Keeps a Vercel function alive until `task` settles, as the SDK's own
 * `vercelWaitUntil` does, without importing the SDK to get it. Outside Vercel
 * there is no request context and this does nothing.
 */
function keepAliveUntil(task: Promise<unknown>): void {
  const requestContext = (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')] as
    | { get?: () => { waitUntil?: (promise: Promise<unknown>) => void } | undefined }
    | undefined;
  requestContext?.get?.()?.waitUntil?.(task);
}

function onUnhandledRejectionBeforeSentry(reason: unknown): void {
  // What the SDK's handler prints in its "warn" mode, so the log reads the same
  // whichever handler saw the rejection.
  console.warn(
    'This error originated either by throwing inside of an async function without a catch block, '
    + 'or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason:',
  );
  console.error(reason !== null && typeof reason === 'object' && 'stack' in reason ? reason.stack : reason);
  keepAliveUntil(loadSentry().then(async (Sentry) => {
    if (!Sentry) return;
    Sentry.captureException(reason, {
      captureContext: { extra: { unhandledPromiseRejection: true }, level: 'error' },
      mechanism: { type: 'auto.node.onunhandledrejection', handled: false },
    });
    await Sentry.flush(2_000);
  }));
}

function onUncaughtExceptionBeforeSentry(error: Error): void {
  console.error(error);
  // The SDK's default: report, flush, then end the process, but only when no
  // other handler is there to decide what an uncaught exception means.
  const othersDecide = process.listeners('uncaughtException')
    .some((listener) => listener !== onUncaughtExceptionBeforeSentry);
  void loadSentry()
    .then(async (Sentry) => {
      if (!Sentry) return;
      Sentry.captureException(error, {
        mechanism: { type: 'auto.node.onuncaughtexception', handled: false },
      });
      await Sentry.flush(2_000);
    })
    .finally(() => {
      if (!othersDecide) process.exit(1);
    });
}

function installStandInHandlers(): void {
  if (standInHandlersInstalled) return;
  standInHandlersInstalled = true;
  process.on('unhandledRejection', onUnhandledRejectionBeforeSentry);
  process.on('uncaughtException', onUncaughtExceptionBeforeSentry);
}

function removeStandInHandlers(): void {
  if (!standInHandlersInstalled) return;
  standInHandlersInstalled = false;
  process.off('unhandledRejection', onUnhandledRejectionBeforeSentry);
  process.off('uncaughtException', onUncaughtExceptionBeforeSentry);
}

export async function register() {
  if (!isNodeRuntime()) return;
  const registrationStarted = performance.now();
  try {
    // Warns once per runtime start when production has no DSN, so "configured but
    // reporting nothing" cannot pass unnoticed. No SDK is loaded for it.
    if (!assertSentryConfigured()) return;
    installStandInHandlers();
  } finally {
    if (process.env.VERCEL_ENV === 'production') {
      // This measures this hook only, not platform boot or route imports.
      try {
        console.log(JSON.stringify({
          level: 'info', msg: 'server_registration_timing', ts: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - registrationStarted),
        }));
      } catch { /* Diagnostics must never prevent startup. */ }
    }
  }
}

export async function onRequestError(
  ...args: Parameters<typeof SentryTypes.captureRequestError>
): Promise<void> {
  if (!isNodeRuntime()) return;
  const capture = loadSentry().then((Sentry) => {
    Sentry?.captureRequestError(...args);
  });
  // Next awaits this hook on most paths; the first error on an instance also
  // waits for the SDK to load, so the function is kept alive for it either way.
  keepAliveUntil(capture);
  await capture;
}
