/**
 * Shared Sentry configuration (F15b).
 *
 * One module so the browser, server and edge runtimes cannot drift on sample
 * rates or on which environment reports. Kept free of `server-only` and of any
 * Node import, because `instrumentation-client.ts` pulls it into the browser
 * bundle.
 *
 * BROWSER ONLY, FOR NOW — and the reason is a build guard, not a preference.
 * Adding a root `instrumentation.ts` (the only way to initialise Sentry on the
 * server and to register `onRequestError`) makes Next emit an edge-wrapper
 * chunk containing Turbopack's own path helper, ``U.P = e => `/ROOT/${e}` ``.
 * `scripts/check-ffmpeg-build-artifact.mjs` flags any `/ROOT/` literal outside
 * `/ROOT/node_modules/next/dist`, so the bare template prefix trips it and
 * `npm run build:verify` fails. That guard exists because bundling
 * `ffmpeg-static` inlined `/ROOT/node_modules/ffmpeg-static` and broke every
 * rendition in production, so it is not something to widen casually.
 *
 * Verified by elimination: no instrumentation files → passes; client only →
 * passes; server file present → fails, with or without any Sentry import.
 * **So the blocker is `instrumentation.ts` existing at all, not Sentry.**
 * See F15b in `docs/scaling-audit-2026-08-08.md` for the one-line guard change
 * that would unblock it, and why it needs a human decision.
 *
 * ALSO NOT WIRED THROUGH `withSentryConfig`. That wrapper exists for
 * source-map upload, release tagging and tunnelling; source maps need a
 * `SENTRY_AUTH_TOKEN`, and the wrapper rewrites the bundler config that
 * `outputFileTracingIncludes` uses to force `ffmpeg-static` into the media
 * routes — the same thing `build:verify` guards. Error capture does not depend
 * on it, and until it is added **stack traces arrive minified**.
 */

/**
 * The build-time environment snapshot, and the reason it is written out one
 * literal at a time.
 *
 * Next inlines `NEXT_PUBLIC_*` into the client bundle by **substituting the
 * literal expression** `process.env.NEXT_PUBLIC_FOO`. It is a text
 * substitution, not a runtime lookup: `process.env` itself is an empty shim in
 * the browser. So reading `someEnvVariable.NEXT_PUBLIC_SENTRY_DSN`, where
 * `someEnvVariable` merely *defaults* to `process.env`, never matches the
 * pattern and always reads `undefined` in the browser.
 *
 * This shipped that way once. The instrumentation module was in the production
 * bundle, the DSN was not, `Sentry.init` never ran — and because
 * `resolveSentryEnvironment` had the identical flaw it reported `'unknown'`
 * rather than `'production'`, so `assertSentryConfigured` stayed quiet too.
 * Silent on both levels, which is exactly the failure this file's warning
 * exists to prevent. Caught only by loading the deployed page and finding no
 * Sentry client on it.
 *
 * Keep every entry as a direct `process.env.X` member expression. The
 * functions below still accept an environment argument so tests can inject
 * one; this object is only the default.
 */
const BUILD_ENVIRONMENT: Record<string, string | undefined> = {
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  NEXT_PUBLIC_VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV,
  VERCEL_ENV: process.env.VERCEL_ENV,
  NODE_ENV: process.env.NODE_ENV,
};

/**
 * Reported as the Sentry `environment`. Vercel sets VERCEL_ENV to
 * production/preview/development; NEXT_PUBLIC_VERCEL_ENV is its browser-visible
 * twin. Falling back to NODE_ENV keeps local runs labelled rather than blank.
 */
export function resolveSentryEnvironment(
  environment: Record<string, string | undefined> = BUILD_ENVIRONMENT,
): string {
  return environment.NEXT_PUBLIC_VERCEL_ENV
    ?? environment.VERCEL_ENV
    ?? environment.NODE_ENV
    ?? 'unknown';
}

/**
 * The DSN is public by design — it ships inside the browser bundle — so it is
 * a `NEXT_PUBLIC_` value rather than a secret. It is still read from the
 * environment instead of being hard-coded, so it can be rotated or pointed at
 * a different project without a code change.
 */
export function resolveSentryDsn(
  environment: Record<string, string | undefined> = BUILD_ENVIRONMENT,
): string | undefined {
  const dsn = environment.NEXT_PUBLIC_SENTRY_DSN?.trim();
  return dsn ? dsn : undefined;
}

/**
 * Whether Sentry should initialise at all.
 *
 * An absent DSN disables it silently *by design* — local development and CI
 * must not need a Sentry project, and a build that fails without one would
 * make every contributor's checkout depend on an external account.
 *
 * The dangerous half of that is production: a missing DSN there means the app
 * looks instrumented and reports nothing, which is precisely the silent
 * optimism F15a spent its whole item removing. `assertSentryConfigured()`
 * below is what stops it being silent.
 */
export function isSentryEnabled(
  environment: Record<string, string | undefined> = BUILD_ENVIRONMENT,
): boolean {
  return Boolean(resolveSentryDsn(environment));
}

/**
 * Emits a loud warning when production is running without a DSN.
 *
 * Deliberately a warning and not a throw: error tracking going missing must
 * never be the reason the app stops serving traffic. But it must not be
 * *invisible* either — "monitoring configured but reporting nothing" is the
 * failure mode that only ever surfaces during the incident it was meant to
 * catch.
 */
export function assertSentryConfigured(
  environment: Record<string, string | undefined> = BUILD_ENVIRONMENT,
  // `console.warn` rather than `logBackendWarning`: this module is pulled into
  // the browser bundle by `instrumentation-client.ts`, and the backend logger
  // is a server-side structured sink. Injectable so the test asserts the
  // message without writing to the console.
  // eslint-disable-next-line no-console
  log: (message: string) => void = console.warn,
): boolean {
  const configured = isSentryEnabled(environment);
  const isProduction = resolveSentryEnvironment(environment) === 'production';

  if (!configured && isProduction) {
    log(
      '[sentry] NEXT_PUBLIC_SENTRY_DSN is not set in production — error tracking is OFF. '
      + 'Nothing will be reported to Sentry until it is configured.',
    );
  }

  return configured;
}

/**
 * Traces are sampled at 0 on purpose. This item is scoped to *error tracking*;
 * performance tracing on the free tier would exhaust the quota on the feed's
 * request volume long before it produced a useful signal, and the audit
 * already measures latency from `pg_stat_statements` and the load test rather
 * than from an APM. Raise deliberately, with a quota to spend.
 */
export const SENTRY_TRACES_SAMPLE_RATE = 0;

/** Full error capture. Errors are rare enough that sampling them loses signal. */
export const SENTRY_ERROR_SAMPLE_RATE = 1;
