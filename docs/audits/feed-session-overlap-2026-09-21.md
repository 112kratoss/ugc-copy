# Feed session lookup overlap — 21 September 2026

## Baseline

Production `6761d58a` (PR #190) passed all nine public targets and both
Lighthouse jobs in run 35627749144. Its 208 reads had zero errors, but the
signed-in feed failed its unchanged 1800 ms TTFB P95 budget: 16 samples,
P50 727.9 ms, P95 2440.9 ms. This remains a bounded regression run, not a
capacity certificate.

The slowest signed-in request started at 16:47:40.579 UTC, Vercel ID
`iad1::bom1::n52gl-1790009260583-021627bacd41`. Supabase logs in the surrounding
16:47:40–16:47:44 UTC window show feed experiment, session and algorithm API
origin times of 335, 312 and 287 ms respectively. These are time-window
correlations, not a shared trace ID, and measure API serving rather than SQL
execution. They do not prove one slow SQL query caused the outlier.

The source serialized algorithm/experiment resolution before looking up a
reusable session. The session's viewer, filters, two-minute creation window and
expiry are known before algorithm resolution. Both viewer-specific lookup
indexes already exist in production.

## Change

Read the newest viewer/filter-matching session concurrently with algorithm and
experiment resolution. Reuse it only when **both** its algorithm version and
experiment assignment match the newly resolved scope. If either differs (or
scope metadata is missing), run the original fully scoped lookup so an older
matching session can still be reused. Empty lookup results continue to create
a fresh session. Common-path query count stays the same; a scope mismatch adds
one bounded read. An inactive-algorithm request with an identity now also makes
that speculative read before returning the existing recent-feed fallback.

Ownership and expiry are checked again before page hydration. Authentication,
rate limiting, feedback, ranking, continuation cursors, delivery writes,
privacy/cache policy and response schema retain their existing behavior.
`algorithm` and `session_reuse` timings now overlap; do not sum them.
`session_reuse_fallback` separately measures a scope-mismatch lookup.

## Validation

- Reproduced the sequential wait with a failing test holding algorithm
  resolution pending while checking whether the session read had started.
- The changed test passes, including matching scope, a newer other algorithm,
  a newer experiment assignment and missing assignment metadata. An active
  experiment with a prior unassigned session falls back to the exact scope and
  retains delivery attribution.
- 106 focused tests across eight suites pass; app and test typechecks, targeted
  ESLint and `git diff --check` pass.
- A read-only production Data API probe alternated serial/overlapped orders in
  an ABBA sequence, 12 samples each, 72 measured GETs. Both variants selected
  the same session in every sample, with three calls per sample. The window
  was anchored to an existing historical session to avoid creating sessions
  or changing expiry. There was no running experiment.
- Probe median for these lookup phases alone: **161.5 ms serial / 151.0 ms
  overlapped**; mean 174.8 / 164.2 ms. Maximum 292 / 351 ms. This modest result
  is noisy and does **not** establish an end-to-end P95 improvement or a fix for
  the 2.44-second request. Fresh protected-release measurements are required.

Raw local probe and results are under ignored
`certification-artifacts/feed-session-overlap-2026-09-21/`. Release and exact-build
production results will be recorded after the required Quality gates.
