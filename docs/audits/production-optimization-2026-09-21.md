# Production optimization — 21 September 2026

## Scope

Production was used for bounded read-only SQL, aggregated logs and the existing
performance workflow at one concurrent request / two requests per second for
120 seconds. No synthetic generation, destructive fixtures, statistics reset,
or saturation test was run. This is a diagnostic baseline, not a capacity
certificate. Initial live build: `6d435fb195dfa95f1bcff4a41bf47b277d6c4efd`.
Reviewed checkout: `ee13c22f`.

## Measured findings

1. **Feed continuation has an unindexed session lookup.**
   `recordServedDeliveryFacts` reads a template from `feed_delivery_facts` by
   `session_id` before writing the next served slice. Production has no index
   beginning with that column. A missing-session SELECT with LIMIT 1 scanned
   all 32,946 rows, touched 3,165 shared buffers, and took 1,624.221 ms in one
   bounded EXPLAIN ANALYZE. This is a worst-case lookup probe, not a feed P95.
   The historical normalized application statement has 932 calls and 340.61 ms
   mean execution time; those counters span older releases and are supporting
   history only. Add a narrow non-unique session index. The migration uses a
   two-second lock timeout and 30-second statement timeout so a contended
   deployment fails rather than waiting indefinitely while blocking writers.

2. **Identity admission remains the main recurring signed-in delay.**
   [Production Performance run 35565426410](https://github.com/112kratoss/ugc-copy/actions/runs/35565426410)
   completed 195 requests with zero request errors. All nine signed-out targets
   passed latency/size budgets. The signed-in feed had 15 samples, P50 TTFB
   1,477.9 ms and P95/P99 3,647.8 ms, exceeding the existing budgets. With only
   15 samples the P95/P99 is the maximum, not a stable tail estimate.
   Proxy identity P50 was 674.7 ms (lifecycle 671.8 ms); feed work P50 was
   313.1 ms. A cold JWKS verification reached 775 ms.

   Aggregated preceding-24-hour Supabase edge logs show identity RPC traffic
   arriving through BOM (2,776 requests, origin P50 39 ms), SJC (115 / 284 ms),
   CMH (61 / 280 ms), IAD (49 / 619 ms) and LHR (32 / 427.5 ms). Rate-limit RPCs
   all arrived through BOM (3,362 / 27 ms). These are ingress locations, not
   direct proof of the Vercel execution region, but support a locality problem.
   Vercel documents that middleware is globally deployed regardless of the
   default function region. The installed Next.js Node proxy build writer also
   omits `config.regions` from `functions-config-manifest.json`; simply adding
   that property is not a verified fix. Preserve fresh ban/session/lifecycle
   checks. A follow-up must verify platform-supported placement or move the
   authoritative check to a shared route boundary with complete coverage.

3. **Monitoring did not enforce caching, and warmup skipped later targets.**
   The warmup builder spent two requests on each early target until its cap of
   15, leaving the final authenticated target cold. It now visits every target
   before repetitions. This does not remove cold requests from the measured
   phase or relax latency budgets. Cache-ratio checks now cover surfaces whose
   caching was verified: minimum 80% for home/public feed/legacy and immutable
   catalogs, 50% for the 30-second current revision endpoint. Signed-in feed
   responses must remain MISS/BYPASS. Dynamic Showcase/Marketplace HTML has no
   shared-cache expectation. The baseline recorded home 28 HIT / 2 STALE,
   public feed 29 HIT / 1 STALE, legacy catalog 30 HIT, immutable catalog
   endpoints 14–15 HIT of 15, and current revision 11 HIT / 4 MISS.

4. **No observed queue or database-capacity emergency.**
   Database size was 108,391,571 bytes. Snapshot: 16 sessions, no lock waiters,
   zero cumulative deadlocks. No failed scheduled jobs in the preceding 24
   hours. Completion/import queues contained only succeeded rows; workflow and
   template queues were empty. All nine retained completion jobs from the last
   30 days used `webhook_drain`. Feed facts had no rows older than 31 days.
   This does not prove drain capacity during a burst.

5. **Media needs workload-aware follow-up, not an invented MAU ceiling.**
   Preceding-24-hour Storage logs recorded public GETs: 290 HIT, 32 MISS,
   35 BYPASS; signed GETs: 37 HIT, 122 MISS, 5 BYPASS. Counts include probes,
   errors and heterogeneous assets; they are not a controlled user-session
   experiment or a billing export. Content-Length sums are not billed egress.
   The code already reuses private signed URLs in a bounded, per-instance cache
   (256 entries, 600-second URL expiry, 120-second safety margin), keyed by user,
   object and download mode, with in-flight request deduplication. Measure reuse
   across instances and actual playback downloads before adding another cache;
   preserve expiry, ownership and takedown behavior. No TTL was lengthened here.

## Validation and release

The index is delivered through the normal migration/release workflow, not an
out-of-band production DDL operation. Migration text and clean-schema pgTAP
checks cover the index. Harness self-tests cover fair warmup, invalid ratio
budgets, a cache regression, a healthy cache and an empty sample set.

Both mobile and desktop Lighthouse jobs passed in the baseline workflow. The
load-budget job failed only the authenticated feed latency budgets described
above. PR Quality has passed clean migration replay/pgTAP, mobile checks and
E2E smoke; web validation is still pending at the time of this record.

After release: verify the index is ready/valid, repeat the same bounded SELECT
plan and the production performance workflow. Report query-plan improvement
separately from signed-in first-page latency: the index addresses continuation
pages and cannot fix middleware network latency.

The measured candidate-refresh rewrite was not shipped: although it reduced
join fanout from 98,838 rows to 102, its single measured execution was slower
(656 ms versus 172 ms). Workload noise and full-function costs need study before
claiming a benefit. No Redis, read replica, sharding or worker service is added.

## References

- [Active scaling assessment](../scaling-audit.md)
- [Vercel region behavior](https://vercel.com/docs/functions/configuring-functions/region)
- [PostgREST connection pooling](https://docs.postgrest.org/en/stable/references/connection_pool.html)
