/**
 * The two parts of the Sentry SDK the browser uses, `init` and `captureException`,
 * loaded by `instrumentation-client.ts` through this module rather than through
 * `import('@sentry/nextjs')`.
 *
 * A namespace import keeps every export of the package alive, so the lazy chunk
 * carried session replay, canvas replay and the feedback widget, none of which
 * runs here (replay is sampled at 0, no feedback is shown): 203 KB on the wire and
 * 702 KB of script on every full page load, fetched 30 s after `load` (web static
 * audit, 2026-11-19). Named exports let the bundler keep only what these two reach.
 */
export { captureException, init } from '@sentry/nextjs';
