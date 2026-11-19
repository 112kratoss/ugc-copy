/**
 * Server runtime instrumentation (F15b).
 *
 * Next calls `register()` once per runtime before anything else runs, and routes
 * uncaught request errors to `onRequestError`. Without the latter, App Router
 * errors are swallowed by the framework's own boundary and never reach Sentry.
 *
 * NODE RUNTIME ONLY, AND THE IMPORTS ARE LAZY. `instrumentation.ts` can be loaded
 * by the edge runtime too, and a top-level `import * as Sentry` also pulled the
 * SDK's bundler-plugin machinery into the server chunks behind the package index,
 * which is why the `@sentry/*` entries exist in `serverExternalPackages`. Next 16
 * runs `src/proxy.ts` on the Node runtime, so its function registers here as well.
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
 *     rejection the SDK would not ignore is reported and does not end the
 *     process, as the SDK's "warn" mode never let it; an exception is reported
 *     as fatal, flushed, and ends the process only when no other handler is
 *     there to decide (Next installs one on its route functions).
 *
 * What that costs, stated plainly:
 *   - The load (0.6–1.1 s, synchronous) now happens on the first error, while
 *     the instance may be serving other requests, and a route handler's 500
 *     waits for it once per instance.
 *   - The SDK records breadcrumbs (console, http, fetch) only from its `init`,
 *     so the error that loads it is reported without any.
 *   - `init` runs inside the triggering request's async context.
 *   - Middleware errors are not captured; server components, route handlers and
 *     the browser all are.
 *
 * The type import below is erased at build time; the value import happens inside
 * the runtime guard.
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

/** Marks the stand-in listeners, so a count of the other `uncaughtException` handlers leaves them out. */
const STAND_IN_MARK = '__magicbookletSentryStandIn';
type ProcessListener = ((...args: never[]) => void) & { [STAND_IN_MARK]?: true; _errorHandler?: boolean };
/**
 * The installed stand-ins, kept on the process rather than in this module, so a
 * second copy of the module in the same process neither installs a second pair
 * nor leaves the first behind when it hands over.
 */
const STAND_INS_KEY = Symbol.for('magicbooklet.sentry.serverStandIns');
type StandIns = { rejection: ProcessListener; exception: ProcessListener };
/**
 * Rejections the SDK's own `OnUnhandledRejection` drops before it logs or reports
 * them (`DEFAULT_IGNORES` in `@sentry/node-core`'s `onunhandledrejection.js`):
 * streams the Vercel AI SDK aborts.
 */
const SDK_IGNORED_REJECTION_NAMES = new Set(['AI_NoOutputGeneratedError', 'AbortError']);

let sentryLoad: Promise<SentryModule | null> | null = null;

/**
 * The SDK, imported and initialised once per instance, on first use. Settles to
 * null when no DSN is configured. A failed import or init is logged and not
 * kept, and the stand-ins stay, so the next error tries again.
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
    // The SDK's own process handlers went in with `init`, in this same
    // synchronous step: the stand-ins step aside so nothing is reported twice.
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
 * Keeps a Vercel function alive until `task` settles, through the request
 * context Vercel puts on the global (what `@vercel/functions`' `waitUntil`
 * reads), without importing anything to get it. Outside Vercel, or outside a
 * request, there is none and this does nothing; it never throws.
 */
function keepAliveUntil(task: Promise<unknown>): void {
  try {
    const requestContext = (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')] as
      | { get?: () => { waitUntil?: (promise: Promise<unknown>) => void } | undefined }
      | undefined;
    requestContext?.get?.()?.waitUntil?.(task.catch(() => undefined));
  } catch {
    // Keeping the function alive is best effort; reporting must never throw.
  }
}

function rejectionName(reason: unknown): string {
  return reason !== null && typeof reason === 'object' && typeof (reason as { name?: unknown }).name === 'string'
    ? (reason as { name: string }).name
    : '';
}

const onUnhandledRejectionBeforeSentry: ProcessListener = (reason: unknown) => {
  if (SDK_IGNORED_REJECTION_NAMES.has(rejectionName(reason))) return;
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
};
onUnhandledRejectionBeforeSentry[STAND_IN_MARK] = true;

const onUncaughtExceptionBeforeSentry: ProcessListener = (error: Error) => {
  // The SDK's default: report as fatal, flush, then end the process, but only
  // when no other handler is there to decide what an uncaught exception means.
  // Counted as the SDK counts: neither the stand-ins nor its own handler nor
  // the one Node attaches for domains is another handler.
  const othersDecide = (process.listeners('uncaughtException') as ProcessListener[]).some((listener) => (
    !listener[STAND_IN_MARK]
    && listener._errorHandler !== true
    && listener.name !== 'domainUncaughtExceptionClear'
  ));
  // Printed only when this handler ends the process, as the SDK's does; a
  // handler that decides otherwise prints it itself (Next's does).
  if (!othersDecide) console.error(error);
  void loadSentry()
    .then(async (Sentry) => {
      if (!Sentry) return;
      Sentry.captureException(error, {
        captureContext: { level: 'fatal' },
        mechanism: { type: 'auto.node.onuncaughtexception', handled: false },
      });
      await Sentry.flush(2_000);
    })
    .finally(() => {
      if (!othersDecide) process.exit(1);
    });
};
onUncaughtExceptionBeforeSentry[STAND_IN_MARK] = true;

function installedStandIns(): StandIns | null {
  return ((globalThis as Record<symbol, unknown>)[STAND_INS_KEY] as StandIns | undefined) ?? null;
}

function installStandInHandlers(): void {
  if (installedStandIns()) return;
  const standIns: StandIns = { rejection: onUnhandledRejectionBeforeSentry, exception: onUncaughtExceptionBeforeSentry };
  (globalThis as Record<symbol, unknown>)[STAND_INS_KEY] = standIns;
  process.on('unhandledRejection', standIns.rejection as never);
  process.on('uncaughtException', standIns.exception as never);
}

function removeStandInHandlers(): void {
  const standIns = installedStandIns();
  if (!standIns) return;
  (globalThis as Record<symbol, unknown>)[STAND_INS_KEY] = undefined;
  process.off('unhandledRejection', standIns.rejection as never);
  process.off('uncaughtException', standIns.exception as never);
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
    return Sentry;
  });
  // Next does not wait for this hook on every path (render errors of server
  // components are reported without waiting), and the SDK sends an event only
  // after its own asynchronous processing: the function is kept alive until the
  // event has been flushed, not just captured.
  keepAliveUntil(capture.then((Sentry) => Sentry?.flush(2_000)));
  await capture;
}
