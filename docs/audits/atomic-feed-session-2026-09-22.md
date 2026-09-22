# Atomic feed-session persistence — 22 September 2026

## Measured remaining delay

The session-lookup overlap from PR #191 is live at `20ecf1d5`, following
successful PR/main Quality and protected release 35690822683. Its production
monitor 35691078648 completed 208 reads with no errors; all nine public targets
and both Lighthouse jobs passed. Signed-in responses were all `BYPASS` with
`private, no-store`.

Signed-in TTFB P50/P95 was 741.0/3433.7 ms across 16 responses. The slow request
started at 05:34:30.428 UTC, ID
`iad1::bom1::dqp2f-1790055270431-29651f5b0e18`. Fifteen requests reused a session;
one created a fresh session. Only that fresh path reported candidate retrieval
458.9 ms, hydration 507.0 ms, fallback 424.0 ms and persistence 734.5 ms. The
maximum complete feed service time was 2533.2 ms. The 15 reused-session page
loads were 136.4–227.2 ms. Per-phase aggregates do not by themselves give a
shared request trace, but the fresh-path counts and matching Supabase log
window identify this as the next path to investigate.

The Supabase 05:34:30–05:34:35 UTC window contains two session calls, one session
item call and one delivery-fact call. The existing implementation performs a
session insert, an item insert, and a fact insert in sequence. Production API
origin maxima were 224, 329 and 114 ms for these tables. These are API-serving
measurements, not pure SQL times. The existing request-scoped hydration cache
already skips previously hydrated posts; fallback reads additional inventory.

## Change and invariants

Replace three sequential writes with one bounded service-role RPC, using the
existing tables and constraints. One transaction inserts the session, all 1–60
ranked items and facts only for the requested served slice. A failure anywhere
rolls the entire call back. The app retains the usable unpersisted-page fallback
without a session cursor when the RPC returns an error.

The function uses invoker privileges and denies execution to PUBLIC, anon and
authenticated; only the service role receives an execution grant. It preserves
viewer/anonymous scope, ranking order, algorithm/experiment attribution,
creator, scores, deterministic exploration propensity and served timestamps.
Unserved candidates stay available for continuation but create no exposure
facts. Returned delivery IDs are text to retain bigint precision.

No ranking, feedback, auth, cache, expiry, retention, budget or mobile response
contract changes. The migration must precede the app deployment through the
protected release workflow. The old app keeps working after migration because
its table writes remain supported. No production data fixtures are required.

## Verification

The application regression test failed before the change because persistence
made table writes rather than the single RPC. Tests now cover the successful
cursor/delivery mapping and rollback-result fallback. Database pgTAP covers
permissions, signed-in/anonymous identities, nonzero served offsets, exact
exposure counts, attribution, duplicate-item and fact-write rollback, and input
bounds. The full clean replay and behavior suite must pass CI before release.

Production performance is not yet established for this implementation. Removing
two network dependencies does not guarantee the 1800 ms signed-in P95 budget;
candidate retrieval and hydration remain material. Capacity is not certified.
