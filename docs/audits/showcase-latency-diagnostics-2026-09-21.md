# Public Showcase latency diagnostics — 21 September 2026

Production build `3273a91e` passes the signed-in feed budgets (15 reads, TTFB
P50/P95 803.9/1041.8 ms). Performance run 35610802650 still fails public Showcase
HTML: 16 successful responses, TTFB P95 2701.3 ms and total P95 3452.4 ms.
Both Lighthouse jobs pass. This is bounded regression evidence, not capacity.

## Captured slow paths

Vercel request `d6jdz-1790000142727-c7d1eb3264ef` at 14:15:42.727 UTC finished
in 3.4 seconds. It was cold (404 ms startup), with 1.78-second execution and
three Data Cache hits (172/173/22 ms). There were no database or poster-origin
requests in that invocation. A nearby hot request took 161 ms to execute.
The platform durations are not necessarily disjoint; do not add them together
or attribute the complete delay to the reported 404 ms startup.

A separate 30-request probe from Mumbai's edge had zero errors, TTFB P50/P95
256.7/520.7 ms and total P50/P95 310.1/1014.9 ms. Its maximum total was 2598.6 ms.
That request (`h5wlj-1790005928238-2df1f02f22e1`, 15:52:08.238 UTC) was hot but
missed the feed Data Cache. Algorithm loading, candidate retrieval and post
hydration formed a sequential chain; supporting hydration queries already ran
concurrently. Execution took 2.13 seconds. Supabase origin times ranged from
94 to 592 ms; those are API-serving durations, not isolated SQL execution times.
The second probe is a different vantage point and does not replace the CI result.

## Diagnostic change

- Time the Node server registration hook, including the Sentry import/init.
  This excludes platform boot, module loading before the hook and rendering.
- Time successful public page data readiness: feed, tool catalog and poster.
  This ends before React rendering/stream completion, which Vercel measures.
- Time actual identityless feed-cache refills and their existing internal phases.
  Logs inside the cached callback run only on refill, not on hits.
- Log only the first load per scope/instance and subsequent loads of at least
  500 ms, capped at 20 records per scope per minute per instance. Production only.
  This is a per-instance bound, not a global fleet limit.
- Retain the five slowest requests per target in monitor JSON, with wall-clock
  start, allowlisted Vercel request ID, status, cache status and timings.

Logs contain fixed labels and durations, without users, media URLs, cookies,
credentials or query strings. No request-header access was added to the page.
No authorization, TTL, ranking, concurrency, response or budget changes.
Changing a cached callback's source changes Next's cache identity, so its first
post-deployment call can require a refill even though the explicit key is stable.

The diagnostics are not a latency fix. Correlate a new exact-build monitor's
outliers with Vercel startup/execution and these logs before changing behavior.
Local raw evidence is under ignored
`certification-artifacts/public-showcase-latency-2026-09-21/`.
