# Bounded feed-page hydration — 21 September 2026

## Finding

On production build `59d6ff6b`, the bounded performance run completed 192 reads
without errors. Signed-in feed TTFB P50/P95 was 912.4/1,866.6 ms (14 samples);
P95 exceeded the unchanged 1,800 ms budget. Identity admission stayed below
95 ms, while session-page work reached 1,214.7 ms.

Persisted pagination read up to 24 ranked rows for a 12-item page and hydrated
all of them before selecting the first 12 plus one lookahead. Hydration loads
posts, profiles, resource summaries, source tools, media and generation metadata.
Those supporting reads already run concurrently; increasing concurrency is not
the fix. The relevant session and feedback indexes exist. Production's last
20 sessions had 370/370 visible post positions among their first 24 positions.

## Change

Hydrate only enough ranked rows to fill the remaining page plus one lookahead.
If visibility, deletion, filtering or viewer feedback removes any candidates,
consume the rest of the scan batch and subsequent batches at the existing full
batch size. Preserve cursor positions, lookahead, feedback checks, bounded
scan limits and continuation delivery writes. No cross-request data cache,
authorization change, migration or mobile contract change is introduced.

The tradeoff is one additional hydration round trip for a batch with removed
candidates. After a gap is found, subsequent batches stay at full size. The
common intact-session path loads fewer rows across every supporting query.

Add separate monitor timings for session-item reads, hydration and feedback,
plus profiles, bundles, media, tools and generation metadata within hydration.
The existing timing opt-in and phase accumulation rules remain in effect.

## Verification

A new test fails on the old implementation (24 hydrated IDs versus 13 needed).
Regression tests cover page sizes 1/12/24 and filling across hidden/deleted
posts without duplicates or skipped cursor positions. The focused feed suites
pass 59 tests; app/test typechecking and changed-file ESLint pass.

A read-only local harness invoked the actual hydration and persisted-page
functions against production data, refusing database mutations. All six
before/after page samples returned the same 12 IDs, lookahead flag and cursor
(hash recorded without user IDs in the evidence). The sampled session contained
19 posts: hydration dropped from 19 to 13. Warm full-page samples were
555/526 ms before and 521/514 ms after; process-cold samples were 2,818/913 ms,
with a variable generation-metadata request dominating the old cold result.
These few observations from a developer machine do not establish a production
P95 improvement. Post-release monitoring must decide whether the live budget
is met; the finer timings identify any remaining tail.

Raw local evidence is in ignored
`certification-artifacts/feed-page-latency-2026-09-21/`. The post-release result
and exact deployed SHA will be recorded in the release PR.
