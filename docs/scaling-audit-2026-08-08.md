# Scaling Audit — 2026-08-08

Date: 2026-08-08
Document type: **living working document** — the findings are dated evidence, the status board is updated as work lands.
Baseline commit: `63b9a3b` · evidence re-verified at `8a69de5` on 2026-08-08 — none of the 45 cited files were touched by the commits in between.

This file is the single source of truth for scaling work. It is written to be **self-contained**: a fresh conversation should be able to open this file, pick one item, and execute it without any other context beyond `CLAUDE.md`.

---

## How to use this file

**Starting a phase in a new conversation:**

1. Open this file and read *Executive verdict*, *How to work an item*, and the phase you are executing.
2. Pick the next item whose status is `TODO` and whose prerequisites are met.
3. Set its status to `IN PROGRESS` before you start.
4. When it lands, set the status to `DONE`, fill in the **Landed** line (PR/commit + date), and add a line to the *Change log* at the bottom.

**Status values:** `TODO` · `IN PROGRESS` · `DONE` · `BLOCKED` · `WONTFIX`

> **Every push to `main` deploys to production.** The Quality workflow runs on push, and a green run auto-triggers `production-release.yml` — the production environment has no required-reviewer gate. Fold status-board and change-log edits into the same commit as the code they describe; a doc-only push costs a full deploy cycle.

**Do not** re-derive the audit. The findings below were each verified against the code at `63b9a3b`. If a file has moved since, re-locate the symbol rather than assuming the finding is stale — but if the code no longer matches the description, say so and mark the item `WONTFIX` with a note rather than inventing a fix.

---

## Executive verdict

The app answers two different capacity questions, and they have different answers. Both are correct; they differ in tense.

**1. Where does the app as deployed first break? ~300–500 mixed MAU**, on Supabase storage egress. The watch surfaces stream full-bitrate source MP4s (avg 7.6 MB, p90 22.5 MB, ~23 Mbps), AI-generated posts are never transcoded at publish, and every media object carries a 300-second cache TTL. Supabase Pro's spend cap is **on by default**, so quota exhaustion degrades storage service rather than producing a bill.

**2. What can the architecture be trusted to handle once media is fixed? ~2,000 MAU safe, ~5,000 as a re-certification gate.** The binding path becomes the personalized feed's write pipeline: up to 121 rows persisted per ranked session against a hard cleanup ceiling of 120,000 delivery facts per day, compounded by the web feed dropping its ranking cursor so long scrolls re-rank and re-persist.

**Plan with these numbers:**

| Workload | Planning limit |
|---|---:|
| Hard line, code unchanged, spend cap on | ~350 MAU |
| Safe mixed target after Phase 0 | 2,000 MAU |
| Re-certification gate | 5,000 MAU |
| After Phase 1, proven by load test | 10,000–25,000 MAU |
| Anonymous, cache-heavy browsing | ~10,000 MAU |
| Active AI-generating users | 800–1,500/month |
| Mixed generations | 300–500/day |
| Simultaneous provider jobs | cap at 50 until tested |

Supabase's 100,000 included Auth MAU is a **billing entitlement, not a capacity claim**. Do not cite it as evidence of application capacity.

---

## Status board

| ID | Finding | Sev | Phase | Status | Landed |
|---|---|---|---|---|---|
| F4 | Spend cap posture + egress monitoring | Critical | 0 | DONE | Cap recorded; weekly dashboard egress read documented as the mechanism (egress is not in the database) — automation noted in F15b, 2026-08-08. **First real reading taken 2026-08-09:** 2.483 GB uncached / 6.112 GB total, 12 MAU → **0.509 GB/MAU**, implying a **491 MAU** ceiling — both inside the verdict's predicted bands. Mostly a pre-Phase-0 measurement; the 20 Aug–20 Sep cycle is the first clean one |
| F1 | Watch surfaces stream full-bitrate source | Critical | 0 | DONE | Mobile pkg 1 + web pkg 2, 2026-08-08 — mobile still needs a store release to reach phones |
| F2 | AI posts skip transcode; sweep 5/hour | Critical | 0 | DONE | Publish-time repair kick + wall-clock sweep budget, pkg 3, 2026-08-08 |
| F3 | Derivative cache TTL — decision #5 resolved | Critical | 0 | DONE | Full pipeline verified; reopened for ranged edge entries and re-closed 2026-08-08 — takedown delete verified working, finite stale-ranged residual recorded and accepted in F3 step 3 |
| F11 | Web `/feed` drops the ranking cursor | Critical | 0 | DONE | Cursor threaded through load-more, retry and snapshot, pkg 4, 2026-08-08 |
| F13 | v2 stats refresh starves past 1,000 rows | High | 0 | DONE | Migration + fact index, pkg 5, 2026-08-08 |
| F7a | Facts for all candidates; unbatched events | High | 0 | DONE | Served-slice facts + batched events, 2026-08-08 — single-transaction insert deferred to F7b |
| F6 | Unthrottled hot GETs incl. full-catalog scan | Medium | 0 | DONE | Limits on all 5 GETs; filtered top-sales scan replaced by RPC unlock filter + ordered streaming, 2026-08-08 |
| F15a | Monitoring truncates silently; biased rates | Medium | 0 | DONE | Truncation flagged (cost + health), attempt-counter denominator landed, 2026-08-08. **DB-side aggregates landed 2026-08-09** (`20260809200000`, `get_backend_cost_aggregates` + `backend-cost-aggregates.ts`): the cost report reads the whole window in one RPC and cannot truncate. The raw-row path is **kept live as the fallback**, which is what preserves the JS unit coverage the audit warned this change would destroy. Health-collector caps are a separate, smaller residual — recorded in the section |
| F10 | Assorted small leaks | Low | 0 | IN PROGRESS | Mobile 404 pkg 1; studio grid + images pkg 2, 2026-08-08. Webhook budget rides pkg 3; two web-perf items stay unassigned |
| F12 | Workflow runs non-durable, non-idempotent | Critical | 1 | IN PROGRESS | Idempotent run creation + durable step queue + cron recovery + pure GET, 2026-08-09 — per-node executor deferred with reasoning |
| F14 | Shared-fate cron; no provider admission control | High | 1 | DONE | **Part one** — cron split + byte admission, 2026-08-09 (ffmpeg wall-clock kill already existed). **Part two's money bug** — ambiguous submissions held, not refunded, **verified live**. **Part two's throughput half** — token bucket, in-flight cap, `Retry-After`, circuit breaker, **verified live**. **Queue-age SLOs** — derived from registry cadence; also closed F12's unmonitored step queue, 2026-08-09 |
| F5 | For-you RPC materializes whole catalog | High | 1 | DONE | LIMIT-first pools + one new index, 2026-08-09. Seeded 200k-post catalog: **445,336 buffers/587 ms → 6,171/8.2 ms**, and now flat in catalog size (+8.9% for 4× the posts). Output verified identical across personalised, anonymous and category branches. **v2 is untouched and is a gate before promotion** |
| F5b | `list_marketplace_resource_bundles` is 47% of RPC time | High | 1 | DONE | **Diagnosis corrected by measurement 2026-08-09**: the ~1,000 blocks are planning plus a ~200-block PostgREST floor, **not** the query. All three corrected items now landed — tool-filtered caching (`v4`), 6-arg shim dropped (`20260809150000`), and the **catalog-scale restructure** (`20260809210000`, `marketplace_bundle_listings`). Seeded to 80,000 bundles: default page **408,080 → 134 buffers** and **6,651 ms → 0.21 ms**, and flat in catalog size (+35% for 80× the posts) against the old path's 155× growth. Output verified identical to the old function across 34 parameter combinations at 1k/20k/80k. Search improved 21× but stays O(catalog) — recorded as a residual. The `SHOWCASE_FEED_CACHE_TAG` coupling is **load-bearing for moderation** — do not remove it |
| F7b | Fact retention + partitioning | High | 1 | DONE | Retention 400→30 (decision #2), `feed_delivery_facts` added to growth reporting, a retention-lag monitor, and the **daily rollup** (`feed_delivery_fact_daily`, 400-day window) — 2026-08-09; the 2026-08-27 deadline is **discharged**. **Monthly partitioning analysed and deliberately deferred**: decision #2's 30-day window makes monthly granularity retain ~60 days to enforce 30, and finer granularity would turn the hottest write path into a per-partition scan. Trigger to revisit recorded |
| F8 | Per-request GoTrue round-trip | Medium | 1 | DONE | `getClaims()` verifies locally via WebCrypto against a cached JWKS — no hand-rolled JWT code, 2026-08-09. Premise verified first: JWKS publishes only ES256 with no symmetric key, in prod *and* local. User rebuilt from verified claims only, preserving the "never read the cookie's user" invariant |
| F9 | Comments scan loop; unindexed top sort | Medium | 1 | DONE | Viewer block set loaded **once** (2 reads per scan, not 2 per batch), scan capped at 10 batches reporting `hasMore`, and `post_comments_toplevel_top_idx` added — `post_comments` had no index reaching `reply_count` at all, 2026-08-09 |
| F15b | Error tracking, PITR, log drain | Medium | 1 | IN PROGRESS | **`track_io_timing` DONE 2026-08-09** — the dashboard has no Postgres config editor; the real mechanism is `ALTER ROLE` on `postgres` **and** `authenticator` (role GUCs apply at login, and PostgREST `SET ROLE`s), applied to production and verified collecting. **The provider-cost ledger is unblocked** — Kie's usage export is **per-task** and its `Task ID` is already stored as `generations.prediction_id`; 26/37 generations joined, failures cost nothing, and app credits == Kie credits 1:1 on images at $0.005/credit (video unverified). **Budget constraint recorded: no additional paid services** — log drain, PITR and paid external monitoring are out of scope, so the RTO is "last daily backup". Error tracking stays open on a free tier but needs owner account creation. Second recipient chosen (`info@magicbooklet.com`) but the watchdog has **no recipient list** — it is a GitHub notification setting, not repo config |
| — | Phase 1 certification load test | — | 1 | TODO | **Phase 1's code tail closed 2026-08-09**, and `track_io_timing` — the harder of its two blockers — was resolved the same day. **One owner action left: a second incident recipient.** F12 and F10 staying IN PROGRESS are recorded deferrals, not prerequisites. Note a measurement debt: IO timing was off for the entry baseline, so certification has no IO "before" unless an idle sample is taken first — see the section |
| — | Phase 2 backlog (unnumbered — see the Phase 2 section) | — | 2 | TODO | |

---

## Baseline, measured 2026-08-08

Production snapshot taken during the audit. Re-measure these when re-certifying.

| Metric | Value |
|---|---|
| Monthly active users | 13 (22 registered, 9 new in 30d) |
| Posts | 34 (6 in last 30d) |
| Generations | 93 total, 47 in last 30d |
| Database size | 61 MB (8 GB included) |
| Storage | 615 MB across 439 objects (100 GB included) |
| Postgres buffer cache hit | 99.97% |
| Feed videos | 12 objects, avg 7.6 MB |
| Feed images | 87 objects, avg 659 KB |
| Generated videos | 29 objects, avg 7.8 MB, p90 22.5 MB, max 33.8 MB |
| Slowest production RPCs | 493 ms and 140 ms mean (at 34 posts) |
| Anonymous load test | 736 req / 30.04 s, 24.5 rps, concurrency 4, 0 failures |
| — home P95 TTFB | 123 ms |
| — feed P95 (`sort=recent`) | 103 ms |
| — showcase P95 | 223 ms |
| — marketplace P95 | 194 ms |

The load test covers **anonymous GETs on `sort=recent` only**. It excludes auth, writes, the personalized feed, generation, uploads and webhooks — i.e. every path identified as binding. It proves the cheap path is cheap; it is not evidence of mixed-workload capacity.

Environment: Supabase Pro, org `kwabcsifvkvelvoyrjel`, project `ildfmhozpibwiopeavfg`, region `ap-south-1`, Postgres 17, Micro compute. Vercel region `bom1`, Fluid compute, one cron every 10 minutes.

### Phase 1 entry baseline — compute, CPU, IO and pool (captured 2026-08-08)

Decision #4's deliverable. Captured before any Phase 1 code, so the certification test has a real "before" to compare against. Re-capture at certification.

**Compute tier: Micro — confirmed by fingerprint, not by API.** `get_project` returns region, status and Postgres version but **no compute size**, so the tier cannot be asserted from the Management API any more than the spend cap can (F4 hit the same wall). The memory settings identify it unambiguously:

| Setting | Value | Note |
|---|---|---|
| `shared_buffers` | 224 MB (28,672 × 8 kB) | Micro's 1 GB RAM allocation |
| `effective_cache_size` | 384 MB | |
| `work_mem` | **2.1 MB** | the number that decides when Phase 1's ranking work spills |
| `maintenance_work_mem` | 32 MB | bounds F7b's partition/index builds |
| `max_connections` | 60 (3 superuser-reserved) | |
| `max_worker_processes` / `max_parallel_workers` / `per_gather` | 6 / 2 / 1 | near-zero parallelism headroom |
| Postgres | 17.6.1.063, `ACTIVE_HEALTHY` | |

**Pool: 47% consumed at idle — the certification gate has ~23 points of headroom, not 70.** 36 `pg_stat_activity` rows, of which 8 are background workers and **28 are client backends against the 60 limit**. At 13 MAU with no meaningful traffic, and essentially all of it idle infrastructure:

| Holder | Conns | State |
|---|---:|---|
| `authenticator` (PostgREST) | 11 | idle |
| `supabase_storage_admin` + storage via pgbouncer | 13 | idle |
| `postgres_exporter`, `pgbouncer`, `supabase_admin`, `mgmt-api` | 4 | 1 active, 3 idle |

0 idle-in-transaction, 0 lock waits, longest transaction 0.0 s. **The Phase 1 certification criterion "connection pool below 70%" must be read against a 47% floor** — the budget for actual request-serving connections is ~14, not ~42. If Phase 1 adds any connection-holding worker (F12's step queue, F14's split queues), this is the ceiling it competes for. Direct-connection work should go through the pooler, not `max_connections`.

**IO: not a constraint today, and not measurable.** Buffer cache hit **99.998%** (369,179,228 hits against 7,348 reads) — the 61 MB database fits entirely inside 224 MB of shared buffers, so there is effectively no read IO to tune. Zero deadlocks; rollback rate 0.21% (22,764 of 10.9 M transactions).

Two gaps worth naming rather than leaving as blanks:
- ~~**`track_io_timing` is `off`**~~ — **turned on 2026-08-09** via `ALTER ROLE` on `postgres` *and* `authenticator` (see F15b for why the earlier `ALTER DATABASE` attempt failed and why both roles are required). `blk_read_time`/`blk_write_time` were 0 when this baseline was captured, so **there is still no IO-latency "before" to compare against** — the certification run will produce the first IO data this project has ever had, which is a floor-less measurement rather than a delta. Capture a short idle sample before the run if a baseline is wanted.
- **`log_temp_files` is `-1`** (off), so spills are invisible in logs. Same reserved-GUC list as `track_io_timing`, so the same `ALTER ROLE` treatment applies — worth doing before certification, given `work_mem` is 2.1 MB.

**Temp spill: 429 GB cumulative, and it is not the app.** 168,411 temp files / 429 GB since project creation (~2.4 GB/day; `stats_reset` is null, so counters run from 2026-02-07). This looks alarming and is not: attributing by `temp_blks_written` shows every top writer is *catalog introspection* — `pg_stat_statements` self-queries, `pg_get_functiondef` walks, dashboard and audit tooling. **Every application RPC reports `temp_blks_written = 0`.** Nothing in the hot path spills at 34 posts. That is a statement about catalog size, not about the queries: with `work_mem` at 2.1 MB, F5's unbounded `eligible AS MATERIALIZED` CTE will spill as soon as the catalog is large enough to matter, and there is no logging configured to notice when it starts.

**CPU: the audit ranked by mean latency and missed the top consumer.** The baseline table above cites "slowest production RPCs — 493 ms and 140 ms mean," which are the two `refresh_*` stats jobs. Ranked by *total* time actually consumed (`pg_stat_statements`), the picture is different:

| RPC | % of RPC time | % of all statement time | Calls | Mean |
|---|---:|---:|---:|---:|
| `list_marketplace_resource_bundles` | **47.3%** | 16.4% | 47,877 | 17.0 ms |
| `refresh_post_feed_engagement_stats` | 7.8% | 2.7% | 263 | 508.7 ms |
| `get_ranked_feed_candidates` | 7.6% | 2.6% | 2,542 | 51.5 ms |
| `check_backend_rate_limit` | 6.6% | 2.3% | 10,519 | 10.7 ms |
| `refresh_post_feed_stats` | 5.6% | 1.9% | 681 | 140.2 ms |
| `record_post_share_event` | 4.3% | 1.5% | 3,859 | 19.3 ms |
| `refresh_user_interest_weights` | 3.4% | 1.2% | 681 | 84.6 ms |

Four consequences for Phase 1, all of them new information:

1. **`list_marketplace_resource_bundles` is the single largest database consumer in production and appears nowhere in this audit.** Nearly half of all RPC time, on volume rather than per-call cost. F5 — a Phase 1 High — targets `get_ranked_feed_candidates` at one sixth of that. This does not make F5 wrong (F5 is about catalog-size *scaling*, and 34 posts hides it), but the marketplace listing needs its own look before certification. Logged as **F5b** in the Phase 1 section.
2. **Connection and session overhead is ~25% of all database time.** `pgbouncer.get_auth` alone is 15.6% (324,055 calls), and the PostgREST `set_config` family adds ~9% across ~1.45 M calls. This is the per-request cost of the stateless model, and it is the strongest quantitative argument for F8 — which the audit files as Medium and "a resilience fix more than a latency one."
3. **`check_backend_rate_limit` is already 6.6% of RPC time**, and F6 just extended it to five more GETs. The doc's own warning that "the limiter is its own load generator under abuse" now has a number attached at 13 MAU.
4. **`SELECT name FROM pg_timezone_names` costs 3.3% of all statement time** — 368 calls at a 442.9 ms mean. That is a known-expensive catalog scan being issued by tooling, not the app. Harmless at this volume, but it is 1.5× the total cost of the entire ranked feed.

---

## How to work an item

Read `CLAUDE.md` first — it carries the commands, layering rules and migration conventions. The audit-specific constraints that are *not* in `CLAUDE.md`:

- **Work sequentially in the primary checkout — one conversation per phase, no worktrees** (owner's working style). The work packages in each phase are commit groupings by file collision and a suggested order, not parallel tracks.
- **Only one local Supabase stack exists** (fixed ports 54321/54322/54323) — a second reason everything stays in one checkout; never run two processes that touch the local database at once.
- **Mobile ships separately.** Merging mobile changes to `main` never reaches phones — that needs a manual `mobile-store-release` dispatch plus store review. Mobile-side work has a multi-week lead time, so **start mobile items first even though they land last**.
- Supabase CLI must be pinned: `npx --yes supabase@2.75.0`. Start with `-x edge-runtime --ignore-health-check`. Use `docker exec` for psql.
- Never run `npm run build` while a dev server is running — they share `.next`.
- Every new migration needs a matching `*-migration.test.ts` asserting its SQL content.
- **Verify an applied migration by *name*, never by its filename version.** `.github/scripts/apply-supabase-migrations.mjs:71` treats a uniquely-named migration as applied when the name matches, because the remote history stamps its own version at apply time: `20260809120000_generation_submission_unknown.sql` is recorded as `20260808221226 / generation_submission_unknown`. Every migration since 2026-08-08 shows the same rewrite with an intact name. Querying `supabase_migrations.schema_migrations` for the filename version returns zero rows and reads exactly like a migration that never applied.

**Definition of done for any item:** `npm test`, `npm run lint`, `npm run typecheck` pass; migrations additionally pass `npx supabase db reset --local` and `npx supabase test db`; the status board above is updated and the change log has an entry — **in the same commit as the code** (every push deploys; see the note at the top).

**And, whenever the change touches a server route or anything it calls: run the built artifact.** Every gate above verifies *source*. A bundler can produce a broken build from correct source — F7b shipped a commit where the minifier turned an object shorthand into an unbound reference, and it passed 3,919 tests, lint, three typechecks, a clean migration replay, 577 pgTAP assertions **and `npm run build` itself**, then 500'd at runtime and failed the release gate twice. `npm run build` succeeding is not the same as the build working:

```bash
lsof -ti:3123 | xargs -r kill -9; OPS_READ_SECRET=localtest PORT=3123 npm start
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer localtest' localhost:3123/api/ops/backend-health
```

Expect a body and a non-500 status (503 `degraded` is normal locally — production env vars are absent). Kill the port first: a stale server on it will serve the *previous* build and make a real fix look ineffective.

**And when a change alters a constant that a database function validates, call that function with the new value.** Nothing else will. The maintenance unit tests mock every RPC, so database-side guards never execute; pgTAP exercises the functions but not with the app's constants; and the two only meet in production. Changing `FEED_FACT_RETENTION_DAYS` to 30 while `FEED_EVENT_RETENTION_DAYS` stayed at 90 violated `prune_feed_personalization_data`'s `event ≤ fact` guard and **aborted the entire hourly feed-maintenance job** — stats refreshes included — for hours, through a green deploy:

```bash
docker exec supabase_db_magicbooklet psql -U postgres -d postgres -c \
  "select public.prune_feed_personalization_data(now(), 30, 2, 5000, 30);"
```

A summary comes back when the constants are legal; an exception when they are not. Where the invariant can be stated in TypeScript, assert it in a unit test as well — `FEED_FACT_RETENTION_DAYS >= FEED_EVENT_RETENTION_DAYS` now is.

**A deploy verifying green does not mean the change is safe.** That release passed its own health check because the cron had not yet run with the new constant; the failure armed itself for the next tick. **After deploying anything a scheduled job touches, check `backend_job_runs` on the next cadence** rather than treating promotion as the end of the change:

```bash
# last run and last error per job
select job_name, max(started_at), (array_agg(status order by started_at desc))[1] from public.backend_job_runs group by job_name;
```

---

## Phase 0 — media and feed-write hygiene

**Goal:** safe at 2,000 MAU, red-line 5,000. **Estimated effort:** ~1 week.

The phase runs **sequentially in the primary checkout** — the packages below are commit groupings by file collision and a suggested order, not parallel tracks:

| Order | Work package | Contents |
|---|---|---|
| 1st | Media delivery — mobile | F1 mobile viewer · F3 mobile upload header (`upload-file.ts:135`) · F10 mobile 404 fallback |
| 2nd | Media delivery — web | F1 web · F3 server constants + backfill · F10 studio grid + unoptimized images |
| 3rd | Publish-time transcode | F2 · riders: F6, F15a, F10 webhook-import budget |
| 4th | Feed write path | F11 (needs no decision) · F7a (needs decision #2 — land F11 alone if it's still open) |
| 5th | Migrations | F13 + missing fact index — migration conventions apply (new file + `*-migration.test.ts` + local replay) |

The mobile package goes **first** because it's the **store-release train**: it merges to `main` immediately but only reaches phones via a manual `mobile-store-release` dispatch plus store review — a multi-week pipeline that should start filling while the web work proceeds. Every mobile-side item in this phase rides that one train. F10's two web-perf leftovers (DOM growth, payload weight) are deliberately unassigned; schedule them opportunistically.

---

### F4 — Spend cap posture and egress monitoring

**Status:** DONE · **Severity:** Critical · **Surface:** dashboard + ops
**Landed:** Cap recorded; weekly dashboard egress read documented as the mechanism (egress is not in the database) — automation noted in F15b, 2026-08-08

**Problem.** Supabase Pro enables the spend cap by default. With it on, exhausting the 250 GB egress quota degrades storage service rather than billing overage — at current media weight that is the literal outage line. Separately, the ops layer (`src/lib/backend-cost-report.ts`) budgets media-read *requests* and storage *growth* but never egress *bytes*, so the one meter that binds first is unmonitored.

**Fix.** No code required for the first half.

1. Open the Supabase dashboard and record the current spend cap setting in this file.
2. Decide posture deliberately. Cap **on** = hard stop, protects against surprise bills, risks mid-month outage. Cap **off** = app stays up, absorbs roughly $35–105/month at 2,000 MAU (cached egress $0.03/GB, uncached $0.09/GB). Recommendation: **off, with billing alerts**, since an outage costs more than the bill at this stage. *This is a business decision — confirm with the owner before changing.*
3. Add measured egress GB to the monthly review and divide by MAU. One real measurement replaces the entire estimation model in this document.

**Verify.** Cap setting recorded below; a calendar reminder or ops task exists for the weekly usage check.

**Record here:** cap setting as of **2026-08-08** = **ON**, and staying on.

**Owner decision (2026-08-08).** The audit recommended off-with-billing-alerts. The owner chose to **leave the cap on**, accepting a mid-month storage degradation as the failure mode rather than an uncapped bill. Recorded as deliberate, not as an oversight.

Two consequences follow, and both are load-bearing for the rest of Phase 0:

1. **The ~350 MAU hard line in the executive verdict is live, not hypothetical.** With the cap on there is no overage to absorb — exhausting the 250 GB egress quota degrades storage service. F1, F2 and F3 are therefore not cost-tuning; they are what moves the outage line.
2. **Egress monitoring becomes the early-warning system.** With no bill to notice, the usage meter is the only signal that arrives before degradation does. Step 3 is mandatory, not opportunistic.

The Supabase Management API does not expose the spend cap — `get_organization` returns plan and opt-in tags only — so this setting cannot be read or asserted from code. It stays a recorded human observation, and should be re-confirmed at every re-certification.

**Where step 3 lands — corrected 2026-08-08.** This paragraph originally routed the egress metric into `backend-cost-report.ts` alongside F15a. That turned out to be impossible, not merely deferred: **egress is not in the database.** `storage.objects.metadata` records bytes *stored*; bytes *served* exist only in Supabase's own usage accounting, which no Data API query and no Management API surface available here exposes. No collector in this repo can produce the number.

**The mechanism is therefore a manual weekly read, and this section is the ops task the Verify line asks for:**

1. Open the Supabase dashboard → project `ildfmhozpibwiopeavfg` → **Reports → Usage** (or Billing → Usage).
2. Read **Storage egress** for the current billing period, and the % of the 250 GB quota consumed.
3. Record it in the table below. Divide by the month's MAU for GB/MAU — one real measurement replaces this document's entire estimation model.
4. **Alarm line:** with the cap ON, egress reaching the quota degrades storage service. At ≥60% mid-month, treat it as an incident-in-waiting: re-check the F1/F3 rendition and cache behavior first, then reconsider decision #1.

| Week of | Egress GB | % of 250 GB | MAU | GB/MAU |
|---|---:|---:|---:|---:|
| **2026-08-09** (cycle 20 Jul – 20 Aug, day ~20 of 31) | **2.483** uncached · **3.629** cached · **6.112** total | 0.99% · 2.4% total | **12** | **0.207** uncached · **0.509** total |

**First real measurement, read from the dashboard 2026-08-09.** Also captured: storage size 0.633 GB, Micro compute 487 hours, disk overage 0 GP3 GB-Hrs, and the page states outright that the org is *"not billed for overages"* — an independent confirmation of the cap-ON posture recorded above, from the billing surface rather than from memory.

**This is the measurement that was supposed to replace the estimation model, so here is what it actually says.** The audit's executive verdict puts today's real figure at *"~0.5–0.7 GB/MAU"* and the hard line at *"~300–500 MAU"*. Measured total egress per MAU is **0.509**, and 250 GB ÷ 0.509 = **491 MAU**. Both headline numbers land inside their predicted bands, from the low end. The estimation model is corroborated, not replaced.

**Three caveats, or this number will be over-read:**

1. **It is mostly a pre-fix measurement.** F1, F2 and F3 landed 2026-08-08 — day 19 of a 31-day cycle — so ~95% of this egress predates the rendition and cache-TTL work. It measures the app the verdict describes as broken, which is exactly why it corroborates the *unfixed* ceiling. **The next full cycle (20 Aug – 20 Sep) is the first clean post-Phase-0 reading, and is the one worth comparing against.**
2. **The cycle is partial.** Straight-lining 6.112 GB over 20 days to 31 gives ~9.5 GB, but MAU accumulates over the period too, so do not divide a projected egress by a mid-cycle MAU.
3. **Uncached and cached are billed separately and only uncached counts toward the headline quota.** The 0.99% figure is the one to watch against the 60% alarm line; the 2.4% total is the capacity-planning number. Both are far below the alarm.

Automating this requires a Management API token with usage scope wired into the watchdog workflow — a small F15b item, noted there. Until then the weekly read is the early-warning system the cap-ON decision depends on.

---

### F1 — Watch surfaces stream the full-bitrate source, never the rendition

**Status:** DONE · **Severity:** Critical · **Surface:** web + mobile
**Landed:** Mobile pkg 1 + web pkg 2, 2026-08-08 — mobile still needs a store release to reach phones

**Problem.** The 720p/≤1.4 Mbps rendition exists and is used by feeds, but every surface where people actually *watch* resolves the raw source instead. This is 80–90% of all egress, and it means ~23 Mbps playback on Indian mobile networks.

**Evidence.**
- `ugc-mobile/app/viewer.tsx:1757` — immersive viewer streams `mediaItem.url`, unmuted, full source.
- `src/app/showcase/ShowcaseMediaCarousel.tsx:114` — detail and reel modes use `activeItem.url`; only feed mode calls `resolveFeedPlaybackUrl`.
- `src/app/showcase/[id]/ShowcaseDetailBody.tsx:334` — passes `mode="detail"`.
- `src/app/feed/FeedMediaLightbox.tsx:178` — passes `mode="reel"`.
- `src/app/profile/OwnerProfileMediaHub.tsx:262` — `HoverVideo` on full `mediaUrl`, never the rendition.

**Fix.** Use `renditionUrl || url` on every playback surface. The helper already exists: `resolveFeedPlaybackUrl` in `src/lib/media-descriptor.ts:65-70`. Keep the full source only for explicit download/remix actions. The `|| url` fallback makes this safe to ship before F2 — posts without a rendition simply behave as they do today.

**Verify.** Play a video on each surface with devtools network open and confirm the request path contains `.feed.<hash>.mp4`. On mobile, confirm via a proxy or by checking the resolved URI in the player config.

**Gotcha.** The web half ships on the next push; the mobile half needs a store release. Do the mobile half first and bundle the other mobile-side items onto the same store train (F3's upload header, F10's 404 fallback).

**Mobile half landed 2026-08-08 (work package 1).** `ugc-mobile/lib/showcase-media.ts` now exposes `getShowcasePlaybackUrl` — renamed from `getShowcaseFeedPlaybackUrl`, since it is no longer feed-only — and `viewer.tsx` resolves through it. Three notes for whoever does the web half:

- **The old policy was explicit, and was overridden deliberately.** `showcase-media.ts` carried the comment *"Only for muted, scroll-by playback. The full viewer must keep using `url`"*, and `showcase-feed-rendition.test.ts` asserted exactly that. Both were rewritten rather than worked around, so no file is left documenting a rule the code no longer follows. Expect the same class of conflict on the web side.
- **There were two full-source paths in the viewer, not one.** Besides the cited `ActiveVideo`, the inactive-slide branch renders `FeedVideoPreview` on `mediaItem.url`. Both now resolve through the helper. Grep for the raw field rather than trusting the cited line alone.
- **The helper had no production callers whatsoever** — only tests. That independently corroborates the finding: the rendition plumbing was built, tested, and then never wired to a watch surface.

**Web half landed 2026-08-08 (work package 2).** `resolveFeedPlaybackUrl` is renamed `resolvePlaybackUrl` for the same reason as its mobile twin, and `ShowcaseMediaCarousel` resolves through it in every mode instead of only in `feed`. The predicted documented-intent conflict did appear, and was handled the same way: the carousel comment claimed *"Detail and reel are the full viewer and keep the source"* and `showcase-media-carousel.test.tsx` asserted it in a test named *"keeps the full viewer on the source in reel and detail modes"*. Both were rewritten, and a companion test now pins the no-rendition fallback so the change cannot silently break posts published before the pipeline existed.

`OwnerProfileMediaHub`'s `HoverVideo` also streamed the full source and now takes a threaded `renditionUrl`. Generations carry no rendition, so that third call site passes nothing and falls back exactly as before.

**Residual worth knowing.** The rendition encodes audio at 64k mono (`video-rendition.ts:22-44`). That is unremarkable under a muted feed row, but the immersive viewer plays unmuted, so this trades some audio quality for the egress win. If it proves audible on real content, the answer is a second higher-bitrate rendition tier for the viewer — not a return to full sources.

---

### F2 — AI-generated posts skip transcoding; the repair sweep does 5 videos/hour

**Status:** DONE · **Severity:** Critical · **Surface:** server
**Landed:** Publish-time repair kick + wall-clock sweep budget, pkg 3, 2026-08-08

**Problem.** Publishing a generation to the showcase copies the raw provider MP4 (~23 Mbps) into the public bucket with no transcode. The only rendition path for these posts is the hourly repair sweep, which processes 5 videos sequentially — roughly 120/day. A burst of posts serves full-bitrate sources for hours or days.

**Evidence.**
- `src/lib/showcase-publish-service.ts:317-322` — `storage.copy()` with no rendition step.
- `src/lib/media-preview-repair.ts:22` — `RENDITION_REPAIR_BATCH_SIZE = 5`, processed sequentially (`:296-303`).
- `src/lib/post-publish-service.ts:407` — the classic path *does* create a rendition inline.
- `src/lib/video-rendition.ts:22-44` — encoder settings: 720×1280 max, CRF 30, 1400k cap, 64k mono audio, `+faststart`, 120 s timeout, discard unless output < 85% of source.

**Fix.** Enqueue rendition work at publish time for generation-sourced posts, reusing the existing repair pipeline rather than transcoding inline (the publish request should stay fast). Raise the sweep batch size with bounded concurrency — but see the gotcha.

**Verify.** Publish a generated video and confirm a `.feed.<hash>.mp4` object appears without waiting for the hourly sweep.

**Gotcha.** Raising sweep concurrency interacts with F14 — the sweep runs inside the shared 300 s cron invocation alongside every other job, and ffmpeg is memory-hungry. Do not raise concurrency past 2–3 until the queues are split in Phase 1.

**Landed 2026-08-08 (work package 3).** Two halves, and the diagnosis sharpened on the way:

- **The gap was one missing call, precisely locatable.** `repairMediaForPost` already exists and is already scheduled after the response by both sibling publish paths — `posts-route-adapter-service.ts:87` for device uploads and `owner-post-route-adapter-service.ts:63` for edits. `showcase-publish-route-adapter-service.ts` scheduled nothing at all. It now does, using the same `after`-seam, the same swallow-everything error posture (the post is already published; the sweep is the backstop) and skipping when the publish produced no post. Generation publishes do create `post_media` rows, so the existing pipeline needed no new machinery.
- **The sweep is now bounded by a wall clock rather than a row count**, and this is a deviation from "raise the batch size with bounded concurrency" worth recording. Concurrency is the thing the gotcha above warns about, so it stayed at one. But a *count* was never bounding the risk it appeared to: at a 120 s ffmpeg timeout, five sequential rows can occupy **600 s of a 300 s invocation**. `RENDITION_REPAIR_TIME_BUDGET_MS` (60 s, checked before each row, so the true worst case is 60 s plus one timeout) bounds it properly, and the row ceiling rose 5 → 12 so short clips no longer queue behind an arbitrary limit. The first row always runs, or a slow queue head would never drain.

**Measured before changing anything:** all six video `post_media` rows in production are `rendition_status = 'ready'` (four from generations, two from device uploads). There is no backlog today — F2 is a burst-and-latency fix, not a repair of existing damage. The publish-time kick is what removes the window; the sweep change is recovery throughput.

---

### F3 — Derivative cache TTL: 300s everywhere — but the short TTL is a documented moderation decision

**Status:** DONE · **Severity:** Critical · **Surface:** server + mobile · **Blocked on:** decision #5 (resolved)
**Landed:** Full pipeline verified; reopened for ranged edge entries and re-closed 2026-08-08 — takedown delete verified working, finite stale-ranged residual recorded and accepted in step 3 below

**Problem.** A single constant sets a 5-minute TTL on every public media write, including content-hashed derivatives that can never change. Returning visitors re-download posters and clips they already have, and the CDN revalidates constantly.

**The constraint the initial audit missed.** The file's own header documents the 300s as deliberate, not an oversight: showcase objects are *"user-generated content that may need to be revoked after a moderation decision. Keep the browser and Next image-cache window short enough that a deleted Storage object cannot remain usable from a year-long client cache"* (`src/lib/showcase-media-cache.ts:1-8`). CDN copies are purged on delete; browser caches cannot be. A long TTL therefore extends how long an already-served viewer can keep replaying taken-down content. Do **not** ship a mechanical "1 year immutable" without resolving that trade — that is **Open decision #5**.

**Evidence.**
- `src/lib/showcase-media-cache.ts:9` — `SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL = '300'` (rationale comment at `:1-8`).
- Applied at: `src/lib/post-media-preview.ts:59` and `:109`, `src/lib/post-media-rendition.ts:83`, `src/lib/post-publish-service.ts:376`, `src/lib/showcase-publish-service.ts:321`, `src/lib/generation-media-preview.ts:90`.
- Client-side upload headers: `src/lib/signed-url-upload.ts:143` (web), `ugc-mobile/lib/upload-file.ts:135` (mobile — the server-side `storage.copy()` inherits this header, so the mobile half must ride the store-release train or device uploads stay on 300s).
- `next.config.ts:143` — `images.minimumCacheTTL` also 300, same rationale.
- Hashed derivative naming: `src/lib/post-media-rendition.ts:31-37` (`.feed.<hash>.mp4`), `src/lib/post-media-preview.ts:18-24` (`.preview.<hash>.webp`).

**Fix — decision #5 resolved 2026-08-08 as the 1-day compromise.** Three things found while implementing changed the shape of the fix from what this section originally prescribed. All three are recorded because each would otherwise be re-derived:

1. **There is no mutable-versus-immutable split to make — one TTL covers the whole bucket.** The original plan assumed originals are mutable and must therefore stay short. They are not. Every public showcase path is written once and never overwritten: initial publish keys on post id and media index (`post-publish-service.ts:254`), edits mint a fresh `randomUUID()` segment (`post-update-service.ts:740`), generation publishes carry a 12-char source-version hash (`showcase-publish-service.ts:316`), and derivatives carry a content hash. A long TTL cannot serve stale bytes anywhere here. Holding originals at 300s would also have bought nothing on the risk side — after F1 a taken-down video replays from its cached *rendition* regardless, so the exposure window is one day either way. One uniform ceiling gives one explainable invariant: **any public showcase object stays replayable for at most one day after takedown.**

2. **`stale-while-revalidate` is unreachable and has been dropped.** `storage-js` builds the header itself — `headers['cache-control'] = ` + `` `max-age=${options.cacheControl}` `` — so `cacheControl` may only carry a seconds count. Passing the recommended directive string would emit the malformed `max-age=public, max-age=86400, stale-while-revalidate=604800`. The shipped value is `max-age=86400`, which is the half that delivers the 288× revalidation cut; SWR was a refinement, not the win. Reaching it would mean bypassing the SDK on every write path — not worth it for Phase 0.

3. **The `.copy()` inheritance chain is real, but not where this section said.** `showcase-publish-service.ts:318` is an `.upload()` that sets `cacheControl` explicitly. The copies that inherit the client's upload header are `post-publish-service.ts:302` and `post-update-service.ts:750`, both `UPLOADS_BUCKET → SHOWCASE_MEDIA_BUCKET` with no cache option. So the client upload headers really do decide the public TTL for every device upload on both web and mobile — the gotcha stands, the line reference does not.

Raise `images.minimumCacheTTL` to match.

**Verify.** Upload a new post, then check the `cache-control` response header on its `.preview.<hash>.webp`.

**Gotcha — this will otherwise look like the fix did nothing.** `cacheControl` is stored as object metadata **at upload time**. Changing the constant only affects newly written objects; existing objects keep their stored TTL until rewritten. Budget a backfill pass over `showcase_media` in the same PR.

**Measured production state, 2026-08-08 — the bucket held three generations of policy, not one.** Querying `storage.objects` for `showcase_media` (99 objects; the 439 in the baseline table counts every bucket):

| Stored `cacheControl` | Objects | Written | What they are |
|---|---:|---|---|
| `max-age=31536000` | 60 | 2026-06-14 → 07-16 | every one a content-hashed derivative |
| `max-age=3600` | 29 | 2026-03-19 → 07-16 | originals, on supabase-js's default |
| `max-age=300` | 10 | 2026-07-29 → 08-06 | written since the constant landed |

Two corrections follow. **"300s everywhere" describes new writes only** — nine in ten stored objects were never at 300s, so the revalidation churn was smaller than the finding implies. And more importantly, **the repo already had immutable derivative caching and deliberately gave it up**: derivatives were written at a full year until the 300s constant landed on 2026-07-29 and applied the moderation rationale to everything. Decision #5 was therefore never "should we cache?" but "how much of that year do we restore?"

That also makes the backfill two-directional, and its larger half is a **safety improvement the audit did not anticipate**: 60 objects move *down* from a year to a day, bounding a takedown exposure that is live in production right now. The remaining 39 move up.

**Backfill mechanism.** A migration — `supabase/migrations/20260808120000_showcase_media_cache_ttl_backfill.sql` — rewriting `storage.objects.metadata->>'cacheControl'`, rather than one of the `backfill:*` scripts. Storage exposes no metadata-only write through supabase-js, so a script would have to download and re-upload all 615 MB purely to change a header, churning every object's version; the paths are write-once, so the bytes and ETags are already correct. This project's migrations already cover the `storage` schema.

**Verified after deploy on 2026-08-08. The first attempt failed and the second succeeded — read this section as a sequence, because the failure is the part worth keeping.**

### Step 1 — the migration alone did not work

What was confirmed working:
- The migration applied in production; all **99** `showcase_media` objects now read `max-age=86400` in `storage.objects.metadata`, replacing the three-way 31536000/3600/300 split.
- The constant change is deployed, so objects written from now on carry the new TTL through the SDK.

What is **not** working, and why:

```
curl -I .../showcase_media/posts/.../1000292264.preview.<hash>.webp
  cf-cache-status: HIT
  cache-control: public, max-age=31536000      <- still the old year
curl -I .../showcase_media/showcase/.../generated_....png
  cf-cache-status: HIT
  cache-control: public, max-age=300           <- still the old five minutes
```

Every object still serves its **previous** header. This is not staleness that will age out: a request with `Cache-Control: no-cache` and a request with a never-seen query string both return `HIT`, so the edge entry cannot be revalidated or bypassed from the client, and the 300s objects are long past any TTL that would have expired them naturally.

**The cause is the mechanism, not the value.** Supabase's Smart CDN purges an object's edge entry when that object is written **through the Storage API**. A migration that updates `storage.objects.metadata` with SQL changes what the origin would say but never tells the CDN anything, so the edge keeps serving whatever it captured. The audit's original instruction — hang the backfill off the existing `backfill:*` scripts — was right for a reason this document previously dismissed: a script re-writing objects through the SDK is not merely a slower way to set metadata, **it is the only way to invalidate the cache**.

Note the direction of the residual risk: the 60 content-hashed derivatives are still advertising a **one-year** TTL, so the takedown-exposure improvement claimed for this item has not landed. That is the pre-existing state, not a regression, but it is not fixed either.

### Step 2 — the SDK-write backfill, and the wrinkle that nearly buried it

`npm run backfill:showcase-media-cache` (`scripts/backfill-showcase-media-cache.ts`) walks the bucket, downloads each object and re-uploads it through `storage.update()` with `cacheControl` from the constant. **The write is the purge**; that is the entire point, and re-uploading identical bytes is the mechanism rather than a clumsy way to set metadata.

**The wrinkle: invalidation is asynchronous, and roughly a minute behind.** The first canary looked like a second failure — the object was rewritten, its bytes and mimetype were provably intact, and it *still* served the old year-long header. Checking again 60 seconds later showed `max-age=86400`. Anyone verifying this immediately after a write will conclude it does not work. It does; wait a minute.

That delay is also why the canary mattered. Running all 99 objects first and then testing would have produced the same misleading result across the whole bucket, with no way to tell a propagation delay from a broken approach.

**Outcome, 2026-08-08:** 99/99 objects rewritten, 0 failures, ~297 MB transferred (not the ~615 MB estimated here earlier — that figure was every bucket; `showcase_media` is 148.6 MB). `npm run backfill:showcase-media-cache -- --verify` then issued a real request per object and reported **99/99 serving `public, max-age=86400`**, replacing the previous three-way 31536000/3600/300 split.

### Step 3 — reopened and re-closed: ranged requests hold their own edge entries

**Phase 0 review found the verify above was incomplete.** Full GETs and ranged GETs hold separate CDN edge entries, and the SDK-write backfill purged only the full ones. `--verify` sent full GETs exclusively, which is why it honestly reported 99/99 green while video playback — which requests with `Range` almost exclusively — was still being served pre-backfill headers. It now probes both shapes per object.

**Measured state (2026-08-08, ranged probes):** full GETs 99/99 at `max-age=86400`; ranged answers **92/99 stale — 60 at `max-age=31536000`, 22 at 3600, 10 at 300** — mirroring the pre-backfill metadata split. One ranged entry serves every range value for an object (a novel range returns the same `age`), so the stale population is one entry per object, not one per range.

**Everything tried against a warm ranged entry, with outcomes:**

| Operation | Effect on the ranged entry |
|---|---|
| `update()` rewrite (the backfill) | none — verified on a scratch object and on live media, where a second rewrite left an entry serving a 7.7-day-old header against a 300s TTL |
| TTL expiry | none observed — entries serve at `age` ≫ `max-age` indefinitely |
| `delete()` | **stops serving within ~30s** — but this *gates* rather than evicts |
| `delete()` then re-upload to the same path | the old ranged variant **resumes serving verbatim** — verified twice on live objects |

**What this means for decision #5, tested rather than assumed:** a real takedown still works. A scratch object was uploaded, its ranged entry warmed, and a Storage-API delete stopped both shapes serving within ~30 seconds — and takedowns never re-upload, so the gate holds. Server-side moderation enforcement is intact, ranged entries included.

**The residual, stated plainly:** browsers range-fetching any of the 60 year-labelled objects are told `max-age=31536000`, so a viewer who fetched before a takedown may replay from their own browser cache for up to a year — on those 60 objects, the 1-day bound decision #5 chose does not hold for ranged fetches. Nothing available to this repo resets a warm ranged entry while its object lives; the purge-ranged remediation built during this investigation was removed after live canaries proved it ineffective. The set is finite (≤92, shrinks only by edge eviction), every object written since the constant landed is correct from first warm, and fresh ranged warms pull the correct header. Escape hatches if the residual ever becomes unacceptable: rotate the affected objects to new content-hashed paths (new URL = new edge entries; requires updating `post_media` storage paths), or a support-level CDN purge from Supabase. Recorded as accepted at current scale.

**Tooling notes.** The script is dry-run by default and requires `--execute --project-ref=<ref>`, matching the other `backfill:*` scripts. `--limit=<n>` exists for the canary. `--verify` writes nothing and reports what the CDN actually serves, because stored metadata provably cannot answer that question — which is the whole lesson of step 1. It deliberately does **not** skip objects whose stored `cacheControl` already matches: the migration made every row match while the edge did not.

**Related.** Supabase's Smart CDN guidance notes that fresh signed tokens create distinct cache keys, which is a second reason to prefer public immutable derivatives over signed URLs for public media.

---

### F11 — Web `/feed` drops the ranking cursor

**Status:** DONE · **Severity:** Critical · **Surface:** web
**Landed:** Cursor threaded through load-more, retry and snapshot, pkg 4, 2026-08-08

**Problem.** Feed pagination sends offset only, so any page loaded outside the server's short session-reuse window re-runs the full ranking RPC and persists a brand-new session (1 `feed_sessions` row + up to 60 `feed_session_items` + up to 60 `feed_delivery_facts` = up to 121 rows). Three pages can write ~363 rows instead of 121. Offset-into-a-fresh-ranking is also why items repeat across pages — the client already dedupes this symptom.

**Evidence.**
- `src/app/feed/FeedClient.tsx:171-175` — request params are `limit`, `offset`, `sort` only; no cursor.
- `src/app/feed/FeedClient.tsx:109` — state keeps `nextOffset` only. The feed session id is carried (`:116`) but for event attribution, not pagination.
- `src/lib/showcase-feed-personalization.ts:84-85` — `FEED_SESSION_REUSE_TTL_MS = 120000`; the bug is invisible for fast scrollers and hits everyone else.
- `src/lib/showcase-feed-personalization.ts:914` — `encodeRankedFeedCursor`, the cursor that should be threaded.
- Correct implementations to copy: `ugc-mobile/lib/showcase-feed-query.ts:139-152` (cursor first, offset fallback), and the showcase web client.

**Fix.** Thread `pageInfo`'s continuation cursor through `/feed` load-more for the ranked lanes (`for-you`, `unlocks`), falling back to offset for non-ranked sorts.

**Verify.** Scroll `/feed` past three pages with more than two minutes elapsed, then confirm in the database that only one `feed_sessions` row was created for the scroll.

**Landed 2026-08-08 (work package 4).** `FeedClient` carries a `nextCursor` beside `nextOffset` and sends `cursor` instead of `offset` whenever the previous page returned one; non-ranked sorts never produce a cursor and page by offset exactly as before. Points worth knowing:

- **The server side already worked** — no change was needed there, though it does not look that way at first. Every `pageInfo` built in `showcase-feed.ts` omits `nextCursor`, which reads like the cursor is never exposed. The ranked path does not build its page there: `buildPage` in `showcase-feed-personalization.ts:205-233` does, and it includes `nextCursor`. `sanitizeShowcaseFeedPage` spreads the page and only maps items, so it survives to the client. Confirm this before concluding the server is at fault.
- **Cursor and offset are sent as either/or.** The route already zeroes the offset when a cursor is present, so sending both changes nothing functionally, but it makes a request log ambiguous about which path served the page.
- **Three call sites needed it, not one.** The intersection sentinel, the retry button, and the `sessionStorage` snapshot. The snapshot matters most: `hasMore` was derived from `nextOffset` alone, so restoring a snapshot whose last page returned only a cursor would have looked like the end of the feed and silently stopped pagination.
- A lane switch deliberately discards the cursor — it is a new ranking, not a continuation.

**Not yet re-measured.** The verification above is a production check and has not been run; the unit tests pin the request shape, not the resulting `feed_sessions` row count.

---

### F13 — v2 stats refresh permanently starves rows past the first 1,000

**Status:** DONE · **Severity:** High · **Surface:** migration
**Landed:** Migration + fact index, pkg 5, 2026-08-08

**Problem.** The v2 aggregation functions select candidates ordered by UUID with a fixed limit, so every hourly run processes the *same* first 1,000 creators/posts. Once there are 1,001 active rows, the remainder never refreshes and their `quality_rate` freezes permanently.

**Evidence.**
- `supabase/migrations/20260728181000_feed_ranking_v2.sql:206-215` — `refresh_creator_feed_stats`: `GROUP BY facts.creator_user_id ORDER BY facts.creator_user_id LIMIT p_limit` (default 1000).
- Same shape in `refresh_post_feed_engagement_stats` (~`:297+`).
- `src/lib/feed-maintenance.ts:5-7` — callers cap at 1000/hour.
- v2 is seeded `status = 'shadow'` (`:1295`); v1 is the active row.

**Fix.** New migration (never edit an applied one). Replace the candidate selection with a starvation-free strategy — either order by `creator_feed_stats.updated_at NULLS FIRST` via a left join, or a dirty-ID queue keyed on new `feed_delivery_facts`. Audit v1's capped refreshes (`refresh_post_feed_stats`, `refresh_user_interest_weights`) for the same pattern. Add the matching `*-migration.test.ts`.

**Also in this PR:** add the missing index on `feed_delivery_facts (creator_user_id, ranked_at)` — this is the single unindexed-foreign-key hit from the Supabase performance advisor, and `refresh_creator_feed_stats` joins on exactly those columns.

**Verify.** `npx supabase db reset --local` then `npx supabase test db`. Seed >1,000 creators locally and confirm two consecutive refresh runs touch disjoint row sets.

**Priority note.** This is an **activation blocker for v2**, not live damage — v2 is still shadow. It must land before v2 is promoted, but it is not degrading production today.

**Landed 2026-08-08 (work package 5).** `20260808130000_feed_ranking_v2_starvation_free_refresh.sql` replaces both v2 functions and adds the index.

- **The v1 audit this item asked for has an answer: v1 was already correct.** `refresh_post_feed_stats` and `refresh_user_interest_weights` both already left-join the table they write and order by `min(...updated_at) ASC NULLS FIRST`. v2 regressed an idiom v1 had. The fix is therefore a port, not an invention — the new candidate CTEs are v1's shape applied to `creator_feed_stats` and `post_feed_stats`.
- **`refresh_post_feed_engagement_stats` writes `post_feed_stats`, not a table of its own name.** The staleness join has to target the table the function actually stamps, or the queue never drains and the fix silently does nothing.
- Both functions are reproduced verbatim from the v2 migration apart from the candidate CTEs, so a diff against `20260728181000` shows only the selection change. A test asserts both advisory locks and both limit guards survived the copy.

**Verified:** `db reset --local` applies cleanly, `supabase test db` stays green at 541 tests, and querying `pg_get_functiondef` in the reset database confirms all four feed refreshes now order by staleness and none orders by key alone.

**Not verified:** the audit's seed-1,000-creators check that two consecutive runs touch disjoint sets. The fixture needs an `auth.users` → `posts` → `feed_session_items` → `feed_delivery_facts` chain, and the structural check above was taken as sufficient for a shadow-mode function. **Run it before promoting v2.**

---

### F7a — Facts are written for all ranked candidates; events are unbatched

**Status:** DONE · **Severity:** High · **Surface:** server + clients
**Landed:** Served-slice facts + batched events, 2026-08-08 — single-transaction insert deferred to F7b

**Problem.** Two compounding write amplifiers. First, a ranked session persists delivery facts for the whole 60-candidate pool while a page serves only 2–12 items; recording only served items would cut this path by roughly 5–30×. Second, a fully-watched reel produces around seven independent API calls (open, impression, dwell, four progress milestones), each re-running auth and a database-backed rate-limit write transaction.

**Evidence.**
- `src/lib/showcase-feed-personalization.ts:509-583` — session + items + facts insert; `:599-609` stamps `served_at`.
- `src/lib/showcase-feed-ranking.ts:9-10` — `SHOWCASE_FEED_CANDIDATE_LIMIT = 300`, `SHOWCASE_FEED_ELIGIBLE_ITEM_LIMIT = 60`.
- `supabase/migrations/20260728180500_*.sql:305-376` — `feed_events_apply_delivery_outcome`, an `AFTER INSERT OR UPDATE` per-row trigger issuing a 20-column update.
- `supabase/migrations/20260621063658_backend_rate_limits.sql:57` — every limited request does a DELETE + UPSERT.
- Prune ceiling: `src/lib/feed-maintenance.ts:8-13` — `FEED_RETENTION_PRUNE_LIMIT 5000`/hour = 120,000/day; `FEED_FACT_RETENTION_DAYS 400`.

**The arithmetic that sets the 5,000 MAU gate:** 5,000 facts/hour × 24 = 120,000/day ÷ 60 facts per session = 2,000 sessions/day. At 20% DAU/MAU and two personalized sessions per active user, that is 5,000 MAU.

**Fix.** Persist facts only when items are actually served or rendered. Batch feed events client-side (10–25 per flush) and process them in one server transaction. Note that F11 compounds this — fixing the cursor reduces session creation, so the two belong in the same PR.

**Verify.** Watch one reel end-to-end and count the resulting API calls and inserted rows; both should drop by roughly an order of magnitude.

**Half one landed 2026-08-08 — facts are written only for the slice actually served.** The event-batching half is still open, so F7a stays IN PROGRESS.

`persistRankedSession` now takes the request's `offset`/`limit` and inserts `feed_delivery_facts` for exactly those positions instead of all 60 candidates. Design notes:

- **`feed_session_items` still persists every ranked candidate** and deliberately so — the cursor pages through them by position, so trimming them to the page would break the F11 continuation that just landed. The amplification being removed is the fact table, which is the one with the 400-day retention and the prune ceiling behind the 5,000 MAU arithmetic.
- **`served_at` is set at insert rather than stamped afterwards.** A fact now exists *because* the delivery was served, so its creation is the serve marker. The old write-once `UPDATE ... WHERE served_at IS NULL` pass is gone.
- **A continuation page mints its own facts**, in `recordServedDeliveryFacts`. Every dimension a fact needs beyond the session item is constant across the session, so it copies them from the session's first fact rather than widening `feed_sessions` with experiment columns just to reach that path. `delivery_id` is the primary key and the upsert ignores duplicates, so re-requesting a cursor page cannot double-write or move `served_at`.
- **Fact writes are swallowed on the continuation path.** They are telemetry; a failure there must never fail a page render.

A regression test ranks 20 candidates, serves 3, and asserts 20 session items against 3 facts — the differential that would have been 20 and 20 before.

**Half two landed 2026-08-08 — events are batched.** The endpoint now accepts `{ events: [...] }` up to 25, and the web client queues telemetry and flushes at 10 events, after 2s, or on `pagehide`/`visibilitychange`.

- **Only telemetry is batched, and finding out why cost a regression.** The first pass queued every event type; four tests failed, and the cause was real rather than cosmetic. `not_interested` optimistically hides a post and **restores it when the event request fails** — batching resolved the send before the server had answered, so the rollback could never fire. `impression`, `open`, `dwell`, `media_progress` and `quick_skip` are queued; everything that changes state the UI reacts to stays synchronous and keeps throwing.
- **State-changing events post a bare event, not a one-item batch.** A batch reports a rejected event *inside a 200*, which would have hidden exactly the failure those callers depend on.
- **The single-event shape is permanent, not deprecated.** Mobile ships on its own store train, so builds sending one event per request stay in the wild indefinitely. The adapter answers them byte-identically and the batch shape is additive; the contract file only pins method, path and auth, so nothing there changed.
- **A malformed event in a batch does not discard the flush.** The client has already released those events from its queue, so there is nothing to retry — valid events are recorded and the response reports the count.

**Not done: the single server transaction.** Events are processed in a loop within the one request, so a flush is one HTTP round trip, one auth check and one rate-limit write instead of seven — which is where the cost was. Making the seven inserts one transaction needs a Postgres function reproducing `recordShowcaseFeedEvent`'s branching (an RPC for media progress, a plain insert, and feedback upserts by type). Worth doing alongside F7b's partitioning rather than on its own.

**Decision resolved 2026-08-08 — 30 days.** The owner delegated the call rather than picking. The reasoning is recorded here so F7b does not relitigate it:

- The stated case for 90 days is a quarter of experiment lookback — but F7b keeps **daily aggregates** for exactly that window. Raw facts are not the lookback mechanism. They are what you need to re-derive a metric under a changed definition, or to debug one specific ranking decision, and both are day-to-week activities.
- The arithmetic already in this document makes 90 days marginal on its own terms: ~60,000 facts/day at 5,000 MAU is 5.4M rows over 90 days, on the order of 5.4–10.8 GiB with indexes, against an **8 GiB included quota** — before any other table is counted. Thirty days lands near 1.8M rows and 1.8–3.6 GiB.
- The error is asymmetric. Lengthening retention later is a configuration change; recovering from an exhausted database quota is an incident. That asymmetry matters more than usual now that decision #1 has left the spend cap on.

F7b partitions monthly, so a 30-day raw window is three partitions deep at any time.

---

### F6 — Unthrottled hot GETs, including a full-catalog scan

**Status:** DONE · **Severity:** Medium · **Surface:** server
**Landed:** Limits on all 5 GETs; filtered top-sales scan replaced by RPC unlock filter + ordered streaming, 2026-08-08

**Problem.** The rate-limit framework covers writes well but leaves expensive reads open. Notably `sort=top-sales` scans *every* public post per call.

**Evidence.** No `enforceBackendRateLimit` in the path for: `/api/showcase/feed` on every sort except `for-you` (`src/lib/showcase-feed-route-adapter-service.ts:109-126` limits `for-you` only); `/api/showcase/posts/[postId]`; the comments GET (`src/lib/post-comments-route-adapter-service.ts:91-93`); `/api/generations` (`src/lib/owner-generations-route-adapter-service.ts:39-62`, the target of the app-wide 30 s poller); `/api/creators/[username]`. The scan: `src/lib/showcase-feed.ts:682-686` — `mustScanAllCandidates` for `top-sales`.

**Fix.** Extend the existing limiter (`src/lib/backend-rate-limit.ts`) to these GETs with generous limits — the salted-IP anonymous keying already exists in `src/lib/showcase-feed-identity.ts:64-66`. Precompute the top-sales ranking into `post_feed_stats` alongside the other windows.

**Verify.** Hammer each endpoint past its limit and confirm a 429.

**Longer term.** Every rejected request currently still costs a Postgres write transaction, which makes the limiter its own load generator under abuse. Moving coarse read-limiting to edge/KV is a Phase 2 item; keep Postgres limits for credits, purchases and business-critical quotas.

**Rate limits landed 2026-08-08 (work package 3). The `top-sales` precompute is NOT done — F6 stays open for it.**

All five cited endpoints are now limited, keyed on the viewer when signed in and otherwise on the salted network hash the feed already derives:

| Endpoint | Scope | Budget / 10 min |
|---|---|---:|
| `/api/showcase/feed` (non-`for-you`) | `showcase-feed:read` | 240 |
| `/api/showcase/posts/[postId]` | `showcase-post:read` | 300 |
| comments GET | `post-comments:read` | 300 |
| `/api/generations` | `owner-generations:read` | 400 |
| `/api/creators/[username]` | `creator-profile:read` | 300 |

Deliberately generous — these stop a script, not normal browsing. `/api/generations` is highest because the studio polls it every 30 s while a generation runs, so a few open tabs must not trip it.

**One real cost, worth stating plainly.** Rate-limit state is service-role only, so throttling a read means building a privileged client on every request. `/api/generations` previously created one lazily and often not at all — a test asserted exactly that, and it had to be rewritten. This is the same trade the `for-you` feed already made, and it is a second reason the Phase 2 edge/KV move matters.

**Scan removal landed 2026-08-08 — F6 is DONE, by a different mechanism than the one this item prescribed.**

The fix text said "precompute the top-sales ranking into `post_feed_stats`". Implementation found the repo had already superseded that idea for the unfiltered case: `list_showcase_top_sales_post_ids` (migration `20260715090000`, predating this audit) serves unfiltered top-sales in index order, and the full-catalog scan only ever ran for **filtered** requests (`unlock`/`resource` set) — plus any database missing the RPC. So the completion extends the existing mechanism rather than adding a second one:

- **The unlock filter moved into the RPC** (`20260808150000_top_sales_unlock_filter.sql`): `with-unlock` is bundle-exists, `free`/`paid` is `access_mode` — pure column predicates on the join the function already makes. The old four-parameter signature is dropped, not overloaded: PostgREST would match a four-argument call against both functions and reject it as ambiguous.
- **The resource filter deliberately stays in JS.** `getPostResourceKinds` is a multi-fallback derivation over the bundle's resource JSON; reimplementing it in SQL would fork business logic. The insight that removes the scan anyway: the old path fetched and hydrated *everything* because it sorted **after** filtering. The RPC returns ids in global sales order, so filtering preserves order and the new path streams id-batches (100 at a time) and stops the moment it holds a page of matches. Worst case — a filter matching nothing — walks what the old scan always walked; the common case reads a batch or two.
- The legacy scan remains only as the fallback for databases that have not applied the migration, and a test pins that path.
- One knowingly accepted behavior nuance: `availableTools` on a filtered page is built from the matches scanned so far rather than the whole catalog — the same page-scoped property the unfiltered RPC path already had.

---

### F15a — Monitoring truncates silently and computes biased failure rates

**Status:** DONE · **Severity:** Medium · **Surface:** server
**Landed:** Truncation flagged (cost + health), attempt-counter denominator landed, 2026-08-08; DB-side aggregates deferred into F15b with reasoning

**Problem.** Monitoring becomes *more optimistic* precisely as traffic grows. Cost and health collectors cap their raw queries with no truncation signal, so past the cap the reports silently describe a sample as if it were the population. Separately, provider failure percentages are computed over a table that only records failures and slow calls, so the rate is structurally wrong.

**Evidence.**
- `src/lib/backend-cost-report.ts:700-709` — five parallel queries each `.limit(QUERY_LIMIT)` (5,000) with no count or truncation flag.
- Health collectors cap generations and provider events at 1,000, completion queue at 200.
- `src/lib/provider-fetch.ts:131-141` — a `provider_fetch` event is persisted **only** when the call failed or exceeded 15 s. Any failure rate over `provider_dependency_events` is therefore an exception-biased population.

**Fix.** Replace raw downloads with database-side time-bucketed aggregates returning total attempts, successes, failures, timeouts, cost, bytes, queue age, retention lag, and an explicit truncation status. Fix the failure-rate denominator by recording total attempt counts (a counter is enough — do not persist every success row).

**Verify.** Force a window with more than 5,000 rows and confirm the report flags truncation rather than under-reporting.

**Partly landed 2026-08-08 — the silence is fixed; the aggregates are not.**

- **Truncation is now explicit.** Each of the five raw queries asks for `QUERY_LIMIT + 1` rows, keeps the first `QUERY_LIMIT`, and reports per-source `{ rows, truncated }` plus a `COST_REPORT_TRUNCATED` warning naming the capped sources. The overflow probe is deliberate: an exact `COUNT` over the window would be exactly the sort of query that gets expensive at the traffic where truncation starts happening, so the report detects the cap without paying to measure past it. Covered by a test that feeds 5,001 rows and asserts both the flag and that totals stay at 5,000.
- **The biased failure rate is labelled rather than computed.** `providerDependencies.recentEvents` counts only failures and slow calls, because `provider-fetch.ts` persists nothing else — so `failedCount / recentEvents` approaches 1 no matter how healthy the provider is. The field now carries `population: 'failures-and-slow-calls'` and a comment saying it is a volume signal, not a denominator. Removing a wrong number costs nothing; producing a right one does not.

**Completed 2026-08-08, second pass:**

2. **The attempt counter exists** (`20260808153000_provider_fetch_attempt_counters.sql` + `provider-fetch-attempts.ts`). One row per (service, hour), incremented in place by every attempt at the single funnel all provider fetches pass through — the audit's "a counter is enough; do not persist every success row", literally. The hot-path cost weighed in the earlier note was accepted as one PK upsert per call, fire-and-forget and swallowed, against calls that are already 100ms+ network operations; contention concentrates on one row per service per hour, which at provider volumes is noise. The cost report reads the counters as `providerDependencies.recentAttempts` / `attemptsByService` — **null, not zero, when the table is unavailable**, because a zero denominator would read as "no attempts" rather than "unknown". `failedCount / recentAttempts` is now a real failure rate. Growth is time-bounded (~24 rows/service/day); deliberately not wired into the retention sweep at that size — fold into F7b if it ever matters.
3. **The health collectors flag truncation** the same way the cost report does: the three 1,000-row recency samples and the 200-row completion queue probe one row past their caps, drop the probe row before any builder sees it, and a `HEALTH_SAMPLE_TRUNCATED` warning names the capped sources.

**~~Still open in F15a~~ — the aggregate layer landed 2026-08-09. Original deferral, kept for the record:**

1. **Database-side time-bucketed aggregates.** The report still downloads raw rows, now with explicit truncation. Deferred into F15b's monitoring build-out rather than done here, for three reasons: the caps *bound* the monitoring cost (≤5 × 5,001 rows per collection — the reads cannot grow past that); the silent-optimism harm this item was filed for is gone, since truncation is flagged and the biased denominator is fixed; and F15b adds a per-task provider-cost ledger to the same file, so building the aggregate layer once, with the ledger's requirements known, avoids rewriting `backend-cost-report.ts` twice. If F15b is descoped, this line item returns to F15a.

**Re-measured 2026-08-09, and it is ~100× away from mattering.** Rows in a 24-hour window against the 5,000 cap:

| Source | Rows / 24h | % of cap |
|---|---:|---:|
| `backend_rate_limits` | 47 | **0.94%** |
| `storage.objects` | 2 | 0.04% |
| `generations` | 0 | 0% |
| `ai_usage_events` | 0 | 0% |
| `provider_dependency_events` | 0 | 0% |

Nothing truncates today, and the busiest source needs roughly **100× current traffic** — order of 1,000–2,000 MAU — before it starts. That is still inside the Phase 1 certification target of 10,000–25,000 MAU, so this is **required before certification**, but it is not urgent now.

**The reason not to do it early is a real cost, not just sequencing.** All five builders are simple group-bys over rows, and they are unit-tested against raw fixtures today. Converting them makes the builders thin adapters and moves the arithmetic into SQL, where those tests no longer reach it — so done carelessly the change *reduces* coverage of the logic while fixing a truncation that is not occurring. Do it with pgTAP coverage for the aggregate function written first, and keep a raw-row path in the tests to compare against, so the SQL is validated against the JS it replaces rather than simply replacing it. Note the F15b ledger that this was originally deferred behind is now itself blocked, so the coupling no longer constrains the timing.

### Landed 2026-08-09 — the aggregate layer, with the coverage warning taken literally

`20260809200000_backend_cost_aggregates.sql` adds `get_backend_cost_aggregates(p_since, p_storage_buckets, p_slow_duration_ms)`, one RPC returning grouped arithmetic for all five sources; `backend-cost-aggregates.ts` is the transport and shape layer; `backend-cost-report.ts` maps it through five `…FromAggregates()` functions that sit next to their raw-row twins.

**The raw-row path was not deleted, and that is the whole design.** It stays live as the fallback for a database without the migration, which is what stops the change from trading a tested JS implementation for an untested SQL one. `sampling.mode` (`'aggregate'` | `'raw-rows'`) says which ran.

**The prescribed guard was built as an actual differential**, not two independent sets of expectations:

| Link | Where | What it pins |
|---|---|---|
| raw rows → aggregate payload | `supabase/tests/database/backend_cost_aggregates.test.sql` (16 assertions) | the SQL |
| aggregate payload → report **==** raw rows → report | `src/__tests__/backend-cost-aggregates.test.ts` | that they agree |

The aggregate payload in the vitest file is the **verbatim output of the function** run against a local Postgres seeded with exactly the rows the same file feeds the raw path — not a hand-computed expectation, so a mismatch means the two implementations genuinely disagree.

**Three things worth carrying:**

1. **Faithfulness beat tidiness in four places, and each would have been a silent behaviour change.** `coalesce(x,'unknown')` matches JS `??`, which catches null but *not* the empty string. `output_url` counts only when non-null **and** non-empty (JS string truthiness) and is deliberately not trimmed, because `' '` is truthy in JS. A null `outcome` becomes `'unknown'`, which is `<> 'success'`, so it counts as a failure — as the JS does. And the failure/timeout breakdowns must **omit** zero-count keys: `count(*) FILTER (...)` grouped by service would emit `{"razorpay": 0}` where the JS emits nothing, because the JS only increments on an actual failure. That last one is the assertion most likely to break under a well-meaning rewrite, and pgTAP pins it.

2. **The rounding hazard turned out not to exist, and it is worth writing down so nobody re-derives it.** The JS rounds after *every* addition (`incrementCost`), while SQL sums then rounds once — which can diverge on fractional values. Every column involved (`generations.cost`, `ai_usage_events.cost`, `backend_rate_limits.request_count`, `provider_dependency_events.duration_ms`) is `integer`, so they cannot. If any becomes `numeric`, the differential test is what catches it.

3. **Policy deliberately did not move into SQL.** The function returns `byScope` and nothing else about scopes; `MEDIA_READ_RATE_LIMIT_SCOPES` stays the single place that knows which scopes are media reads, because it changes whenever a route is added and a migration cannot be edited without a deploy. The migration test asserts no scope literal appears in the SQL. The storage bucket list is the one exception — it has to be a filter — so it is passed in from `GENERATED_STORAGE_BUCKETS`.

**No issue is raised when the aggregate function is absent.** The fallback is exact whenever it does not truncate, so alerting on it would fire on every collection against any database without the migration, local stacks included. `sampling.mode` carries the state as data; `COST_REPORT_TRUNCATED` remains the alarm. State on the payload, alarms only for lost accuracy.

**Verified through the built artifact, not just the source** — the rule this document added after F7b's minifier bug. Running `npm start` against the local stack, `/api/ops/backend-costs` returned `sampling.mode: "aggregate"` and reproduced every figure the tests assert (`recentCreditCost` 48, `failedPaidCount` 1, `completedOutputCount` 2, `mediaReadRequests` 155, `bytesByBucket` 3,072 / 9,000,000). Running the same build against **production** — which does not have the migration — returned `mode: "raw-rows"` with a complete report, so the fallback is exercised too, not merely present.

**Residual, sized rather than left implicit: the health collectors still sample.** `backend-health.ts` caps three recency reads at 1,000 rows, the completion queue at 200, the media pipeline at 500, shell posts at 100 and remix at 25 — all flagged for truncation since 2026-08-08, none aggregated. This was never part of the deferred item (its "≤5 × 5,001 rows per collection" is the cost report's five queries), and the three 1,000-capped sources are the same `generations` / `ai_usage_events` / `provider_dependency_events` that measure **0 rows per 24h** today, so they are further from their caps than the cost report was. It is the same shape of work and should be sized against the certification target rather than assumed done.

**Moved to F4 (no longer an F15a item):**

4. **Measured egress bytes.** Blocked on something the audit did not anticipate: **egress is not in the database at all.** `storage.objects.metadata` gives bytes stored, not bytes served, so no collector in this file can produce it. The figure lives in Supabase's dashboard usage surface; F4 now documents the manual weekly read as the mechanism.

---

### F10 — Assorted small leaks

**Status:** IN PROGRESS · **Severity:** Low
**Landed:** Mobile 404 pkg 1; studio grid + images pkg 2, 2026-08-08. Webhook budget rides pkg 3; the two web-perf items below stay unassigned and are **carried past Phase 0 deliberately** — Phase 0 closed around them (see the change log), they are not a Phase 1 prerequisite.

- **Owner studio grid** *(web package)* — **DONE 2026-08-08.** `CreationMediaFrame` took a `posterSrc` and now uses `preload="none"` with the poster whenever one exists, so a grid of 36 tiles issues no video range requests at all. Two things were needed to make that safe: the tile's load state has to start settled, or the spinner would sit over the poster forever waiting for a `loadedmetadata` that will never fire; and tiles *without* a poster keep `preload="metadata"` rather than rendering black, so the change is strictly an improvement instead of a trade. The poster is the generation's existing `preview_url`, which the API already returns but the page's local `Generation` type had not declared — when it is absent the tile simply behaves as it does today.
- **Unoptimized full-res images** *(web package)* — **DONE 2026-08-08.** The creator cover and avatar are `next/image` now (the avatar renders at 96–112px and was shipping the uploaded original). Detail and reel images route through the existing `OptimizedPreviewImage` rather than a raw `<img>`, which also gets them the host-allowlist fallback that component already encapsulates. It gained optional `onError` and `imageRef` props to do this: the carousel needs the failure signal for its recovery overlay, and needs the element to read `complete`/`naturalWidth`, because a cached image can finish before React attaches `onLoad` and would otherwise strand the frame on its fallback aspect ratio. Note it passes the **source** as `previewSrc`, not the 720px preview — the intent is to resize the original, not to downgrade it.
- **Mobile 404 fallback** *(mobile package — store train)* — **DONE 2026-08-08.** `ugc-mobile/lib/api-client.ts` refetched a feed page to locate one post after a detail 404. Removed outright rather than shrunk, for three reasons found on inspection: it requested 48 items but the server clamps feed `limit` to 24 (`showcase-feed-route-adapter-service.ts:91`), so it never searched what it claimed to; its own regression test named it the *legacy* fallback and existed only because it had to forward auth by hand or become a way around user blocks; and every caller already tolerates failure. A detail 404 is now authoritative.
- **Webhook import budget** *(transcode package)* — **DONE 2026-08-08.** `maxDuration` raised 60 → 300 on `/api/webhooks/kie`. It was the only media-touching route in the app still at 60 s while every sibling — posts, account, all seven crons — was already at 300, and with `PROVIDER_MEDIA_DOWNLOAD_TIMEOUT_MS` also at 60 s the download alone could consume the entire invocation, leaving nothing for the re-upload. Chose the duration raise over an unconditional queue hand-off: the queue is still the fallback for anything that overruns, and F14 is going to restructure these queues in Phase 1 anyway.
- **Web feed DOM growth** *(unassigned — opportunistic)* — `/feed` keeps every loaded card mounted and serializes the whole accumulated feed to `sessionStorage` on change; approaches browser limits around 50–100 cards. Window the list and debounce the snapshot to an idle callback.
- **Payload weight** *(unassigned — opportunistic)* — decoded HTML runs 447–641 KiB with roughly 246 KB of duplicated inline CSS/Flight data from `experimental.inlineCss` (`next.config.ts:107-109`). Add both compressed and decoded budgets, and A/B disabling inlining.

---

## Phase 1 — durability and certification

**Goal:** certify 10,000–25,000 MAU **by load test, not by assertion**. **Estimated effort:** 2–4 weeks. Do not start before Phase 0 lands.

---

### F12 — Workflow runs are non-durable and non-idempotent

**Status:** IN PROGRESS · **Severity:** Critical · **Surface:** server
**Landed:** Idempotent run creation, durable step queue, cron recovery worker and a pure GET — 2026-08-09. The per-node executor is deliberately still open; see *Still open* below.

**Problem.** This is a money bug. Run creation has no idempotency binding, so a timed-out client retry creates a duplicate run that re-charges every node's generation. Per-generation idempotency does not help, because each new run legitimately starts new generations. Progress depends on a process-local map plus client polling, and the cron registry contains **no workflow job** — so a recycled function strands the run with no server-side recovery. A GET can also advance workflow state, meaning polling is not read-only.

**Evidence.**
- `src/lib/workflow-runner.ts:895-907` — plain insert into `workflow_canvas_runs`, no idempotency key or unique constraint.
- `src/lib/workflow-runner.ts:1254-1291` — `monitorWorkflowRun` uses a module-level `activeWorkflowRunMonitors` map and a delay loop.
- `src/lib/backend-jobs.ts:168-264` — the job registry has no workflow entry.

**Fix.** Unique `(canvas_id, idempotency_key)` on run creation. Move execution to a durable step queue: one idempotent job per node and attempt, unique `(run_id, node_id, attempt)`, `SKIP LOCKED` claims, heartbeats, retry timestamps, completion events enqueuing dependents transactionally. Make GET endpoints pure reads. **The in-repo pattern to copy is `generation_completion_jobs`** (`supabase/migrations/20260621111546_generation_completion_jobs.sql` plus `src/lib/generation-completion-jobs.ts`) — it already does claims, backoff, attempt caps and refund-on-exhaustion correctly.

**Landed 2026-08-09** — migration `20260808160000_workflow_run_durability.sql`, plus `workflow-run-jobs.ts`, `workflow-run-jobs-processor.ts` and the `workflow-run-steps` cron job.

**Production context measured before starting, because it changes the urgency and not the diagnosis:** 11 workflow runs exist in total and the last one was **2026-04-02**, four months ago. The feature is effectively dormant. The bug is real and correctly rated Critical for scale, but no damage is accruing today and the migration had essentially no data to carry. That is why the scoping decision below was affordable.

**The early return is the fix, not the unique index.** Worth stating plainly because it is easy to add the constraint and still charge twice. `start_workflow_canvas_run` resolves the key inside one statement (`ON CONFLICT … DO NOTHING`, then read), but `executeWorkflowRun` must also **return before executing the graph** when the RPC reports `reused`. The index only stops a second *row*; the early return is what stops the second *spend*. A test asserts that a replayed key inserts no steps, updates no run and enqueues no job.

Four things found while implementing, each of which would otherwise be re-derived:

1. **The conflict path deliberately is not an upsert.** `supabase-js`'s `.upsert()` sends `resolution=merge-duplicates`, which does `DO UPDATE SET` on every column provided — so a replay would rewrite `graph_snapshot` on a run that may already be mid-flight. The RPC exists partly to get exact conflict semantics that PostgREST cannot express.
2. **The old insert never read its error.** `const runId = runInsert.data?.id as string` left `runId` undefined on failure, and the loop then wrote every step row against a null run. Now it throws. This was a latent second bug, unrelated to idempotency.
3. **A deferral had to become its own verb.** A run still waiting on a provider generation has not failed, so releasing its ticket must not consume the attempt budget — otherwise a slow video generation "retries" itself to exhaustion while nothing is wrong. `defer_workflow_run_step_job` reschedules the same row at the same attempt; only genuine failures go through `finish_…(succeeded => false)`. Deferral is bounded by a 24h run lifetime, after which the queue stops polling and the existing stalled-generation reaper is what closes the underlying task.
4. **Reclaim keys on `coalesce(heartbeat_at, locked_at)`.** Heartbeat alone would strand a worker that died between claiming and its first heartbeat; `locked_at` alone would steal a legitimately long-running node out from under itself.

**The GET is now a pure read, and that removed more than a write.** `getWorkflowRunDetails` used to call `advanceWorkflowRunOnce` whenever the run was processing, so a client poll executed nodes, inserted step rows, ran `syncGenerationStatuses` (which polls the provider **and settles credits**) and updated run status. A refresh could start paid work. It now hydrates from `generations` as the webhook left it, with `syncGenerationState: false` — the fallback poll for missed callbacks moved to the worker, where it belongs. Five existing runner tests were rewritten to drive `advanceWorkflowRunOnce` directly rather than reaching it through a GET, and a new test pins the pure-read contract.

**Post-deploy: a security hole this work introduced, caught by the Supabase advisor and fixed in `20260809100000_workflow_run_start_caller_guard.sql`.** Recorded in full because the shape of it generalises.

`start_workflow_canvas_run` is `SECURITY DEFINER` and granted to `authenticated` (the run route executes it on the caller's client). It took the acting user as a **parameter** and checked only that the canvas belonged to *that parameter* — so a signed-in caller could pass a victim's user id together with the victim's canvas id and the ownership check would pass, because the canvas genuinely does belong to the id supplied.

**The two halves were individually harmless and jointly exploitable.** Called alone, the RPC only inserts an orphan run row — annoying, not dangerous. What made it credit theft was the durable queue landed in the same commit: the caller also controls `p_graph_snapshot`, the forged run is created as `processing` with no live job, `adoptStalledWorkflowRuns` picks it up precisely because that is its job, and the worker calls `advanceWorkflowRunOnce`, which executes nodes as `run.user_id` — charging the victim. The recovery mechanism built to stop runs being lost is what turned a junk row into a paid generation.

The fix binds the acting user to `auth.uid()` whenever a user JWT is present, and leaves `p_user_id` trusted only when `auth.uid()` is NULL (service_role: the cron worker and ops paths). Verified against the local database rather than reasoned about: an attacker call is rejected, the owner's own call still succeeds, the service_role path still works, and zero forged rows exist. A test also asserts the new function is byte-identical to the one it replaces apart from the guard, so the idempotency semantics cannot silently regress through the re-`CREATE`.

**The advisor WARN does not go away, and should not be read as an unfixed finding.** `authenticated_security_definer_function_executable` is structural: it flags *any* `SECURITY DEFINER` function executable by `authenticated` and asks whether that is intentional. It does not inspect whether the function guards itself. Here it is intentional — the run route executes it on the caller's client — and the function now derives identity. Expect this row to persist; treat it as reviewed, not outstanding.

**Follow-up worth doing, noticed while fixing this: the function probably does not need `SECURITY DEFINER` at all.** `workflow_canvas_runs` already has an authenticated INSERT policy and `workflow_canvases` an authenticated SELECT policy, so a `SECURITY INVOKER` version would let RLS be the boundary instead of a hand-written `auth.uid()` comparison — and `service_role` bypasses RLS anyway, so the worker path is unaffected. That removes the WARN *and* the whole class of "must remember to guard." Not done now because the vulnerability is already closed and tested, and a third consecutive deploy for a defense-in-depth refactor sequences badly against F14. Verify the `ON CONFLICT` re-read still works under RLS when doing it.

**Post-deploy exposure check (2026-08-09):** 0 workflow runs created since the deploy, 11 total, newest still 2026-04-02, queue table empty — the vulnerable window was roughly 40 minutes against a dormant feature and nothing was exploited.

**Two lessons worth carrying into the rest of Phase 1**, since F14 and F15b both add privileged server-side machinery:

1. **A `SECURITY DEFINER` function reachable by `authenticated` must derive identity, never accept it.** Taking `p_user_id` as a parameter is safe only while nothing trusts the row it writes. That condition is not stable — here it stopped being true in the same commit.
2. **Run the security advisor after every migration that adds a function or table**, not just at re-certification. This was a one-line WARN in a list otherwise full of pre-existing INFO noise, and it named a live vulnerability in code that had already passed tests, lint, typecheck, pgTAP and a production deploy.

**Still open in F12 — the per-node executor, deferred deliberately with the owner's agreement:**

The queue is per `(run_id, node_id, attempt)` as the audit specifies, and it carries claims, leases, heartbeats, attempt caps, backoff and poison isolation. But a claimed job currently drives a **run-scoped** advance (`advanceWorkflowRunOnce`) rather than executing exactly one node. Both bugs this item was filed for are closed by what landed — the double-charge dies with the idempotency key, and stranding dies with cron-driven adoption of runs that have no live job. What a per-node executor would add on top:

- Poison-**node** isolation, rather than poison-run. One bad node currently fails its run's ticket, not just itself.
- Per-node retry accounting instead of per-run.
- Dependent enqueue driven by each node's terminal state rather than by re-running the run's execution order.

It was scoped out because the existing engine sequences a run as a whole and nodes that launch a generation sit in `processing` awaiting a provider webhook, so a per-node executor is a rewrite of the 1,300-line runner with real regression risk across approval gates and generation polling — against a feature with 11 lifetime runs. **Do it before workflow usage becomes material, and before the Phase 1 certification test exercises workflow fan-out**, or the test will certify a fan-out path that has not been restructured.

---

### F14 — Shared-fate cron and no provider admission control

**Status:** DONE · **Severity:** High · **Surface:** server
**Landed:** **Part one**, apart from queue-age SLOs — cron shared-fate split and byte-based media admission, 2026-08-09; the ffmpeg wall-clock kill already existed. **Part two's money bug is closed** — ambiguous submissions are held rather than refunded, 2026-08-09. Part two's throughput half (token bucket, `Retry-After`, circuit breaker) is still open.

**Problem, part one.** Every due job runs concurrently inside one 300-second function invocation, so one memory-heavy media job can take down completions, push receipts, alerts and retention together. Four completion workers each staging a video up to 250 MB can require ~1 GB of function temp space.

**Evidence.** `src/lib/backend-jobs-route-service.ts:163` — `Promise.all` over all due jobs. `src/lib/generation-completion-jobs.ts:16` — `GENERATION_COMPLETION_CONCURRENCY = 4`. `src/lib/remote-media-security.ts:13-17` — 250 MB video cap.

Recovery ceilings today: generation completion fallback 25 per 10 min (150/hour), video renditions 5/hour, upload reclaim 500/day, interest refresh 1,000/hour. Webhooks are the normal completion path, so 150/hour is a *recovery* ceiling, not total throughput.

**Problem, part two.** Kie admission is per-user only (30 per 10 min); there is no account-wide or per-model limiter. A launch spike hits provider 429s with no queue. There is also an ambiguous-timeout case: task creation has a 30 s timeout and no retry, so Kie can accept a task the app believes failed — the app refunds, then discards the later callback.

**Fix.** Split paid completions, media, notifications and cleanup into independent durable queues with per-item leases, poison-item isolation and queue-age SLOs. Add byte-based admission control on media claims and a hard wall-clock ffmpeg kill. Add a global provider token bucket (start conservative: ~15 submissions per 10 s, ~50 concurrent, per-model caps), `Retry-After` handling, and a circuit breaker. Introduce a `submission_unknown` state that reconciles against the provider before refunding.

**Part one, first half, landed 2026-08-09 — the cron shared-fate split.**

**The constraint that shaped it, which the audit does not mention:** `BACKEND_JOB_DAILY_INVOCATION_BUDGET` was 180/day and the single scheduler already consumed 144, so a second ten-minute cron did not fit. Vercel Pro allows 40 cron entries, so the ceiling was self-imposed rather than a plan limit — and under Fluid compute billing follows CPU time, so a mostly-idle extra cron is close to free. Raised to 456, and the assertion now measures **actual Vercel cron invocations across every entry** (144 + 144 + 24 = 312) instead of only checking the scheduler against the budget, which would have let dedicated crons grow unbounded.

**Only two jobs were isolated, and the selection rule is recorded because it will be asked again.** Isolation costs a cron entry, so `dispatch: 'scheduler'` stays the default and a job earns `dispatch: 'dedicated'` by being able to take the whole invocation down. That is `generation-completions` (four workers each staging a video up to 250 MB, ~1 GB of temp space) and `media-preview-repair` (shells out to ffmpeg). The other nine are bounded and light.

**In-process isolation was considered and rejected as insufficient, not merely weaker.** Replacing `Promise.all` with bounded concurrency and per-job time budgets stops a job monopolising the 300 seconds, but the failure the audit actually describes is memory: an OOM or a hard crash kills every job sharing the invocation regardless of how politely they were scheduled. Only a separate cron entry yields a separate function instance.

- `getDueBackendJobs` now filters to scheduler-dispatched jobs. Dispatching a dedicated job from the scheduler too would put the memory-heavy work straight back into the shared invocation — the job lock would make the duplicate harmless but the isolation pointless. A test asserts neither dedicated job appears on any scheduler tick.
- `vercel.json` is asserted against `BACKEND_JOB_VERCEL_CRONS`, derived from the registry, so the two cannot drift. Drift is an outage in both directions: an entry with no registry job 401s forever, and a dedicated job with no entry never runs at all, precisely because the scheduler has stopped dispatching it.
- The dedicated routes already enforced `isAuthorizedCronRequest`, so no auth change was needed — they were previously invoked in-process by the scheduler rather than over HTTP.
- Deploy note: cron configuration is deployment-scoped and activates on promotion, so there is a brief window where the retiring deployment's schedule may still fire. Job locks already make a double-dispatch harmless.

**Verified in production, 2026-08-09.** `backend_job_runs.started_at` is the proof, because the scheduler stamps every job it dispatches with one shared `startedAtMs` — so a batch sharing a timestamp is one invocation, and a distinct timestamp is a distinct instance:

```
20:01:36   6 jobs, one timestamp        <- pre-promotion, everything in one invocation
20:10:29   4 jobs, one timestamp        <- scheduler batch; both dedicated jobs absent
20:10:44   generation-completions alone <- its own cron, its own instance
```

The scheduler batch dropped from six to four and the media-heavy job moved out. Anyone re-checking this later should use the shared-timestamp signature rather than job presence: presence alone cannot distinguish "ran in its own instance" from "ran inside the scheduler".

**The hard wall-clock ffmpeg kill the audit asks for already exists — nothing to build.** `runFfmpeg` spawns with `{ timeout: RENDITION_TIMEOUT_MS, killSignal: 'SIGKILL' }` (`video-rendition.ts:152-182`). Node's `spawn` timeout is wall-clock from spawn and SIGKILL is uncatchable, so a wedged ffmpeg cannot outlive 120 s. Mark this sub-item satisfied rather than re-implementing it.

**But the per-row worst case is larger than F2 recorded, and the split is what makes it safe.** `createVideoRenditionFromFile` invokes ffmpeg more than once (probe, then transcode), and the 120 s bound is *per spawn*. Two timeouts is 240 s, so with F2's 60 s pre-row budget check the true worst case per invocation is 300 s — exactly the function limit, with no margin. F2's note says "60 s plus one timeout", which assumed a single spawn. This is now survivable precisely because `media-preview-repair` has its own instance: it can burn its whole invocation without touching completions, alerts or retention. Before the split it would have taken them all down.

**Byte-based admission control landed 2026-08-09** — migration `20260809110000_media_rendition_byte_admission.sql` plus `RENDITION_REPAIR_BYTE_BUDGET` (256 MB) and an RPC-backed claim in `media-preview-repair.ts`.

**The size had to come from `storage.objects`, because `post_media` does not record it.** The table has `rendition_bytes` — the *output* size, written after transcoding — and nothing for the source, so the old claim genuinely could not tell twelve short clips from twelve 30 MB ones. `post_media.storage_path` maps to `storage.objects.name` in the `showcase_media` bucket and `metadata->>'size'` carries the count; joining keeps Storage authoritative instead of adding a denormalised column that can drift from the object it describes. Verified on production data first: 6/6 video rows matched, 3.4 MB–32 MB.

**Why the claim had to become an RPC, and why the wall clock was not already enough.** F2's time budget stops the invocation overrunning, but only *after* the bytes are committed to — it aborts mid-batch rather than declining to admit the work. A byte budget has to be applied while selecting. Admitting twelve rows and then discovering they total 2 GB is the bug.

Three behaviours worth knowing, each verified against the local database rather than reasoned about:

- **Admission is a running total in queue order, not a best-fit pack.** With rows of 10/200/10/10 MB and a 100 MB budget, only the first is admitted — the 200 MB row exceeds the running sum and everything behind it waits. Reordering to fill the budget would starve the oldest rows, and the sweep depends on oldest-first to drain.
- **The queue head is always admitted, even when it alone exceeds the budget.** Otherwise a single object larger than the budget would never be selected and would wedge the queue permanently. Its cost is still bounded by the sweep's wall clock and ffmpeg's own SIGKILL timeout.
- **A row whose storage object is missing counts as zero bytes.** It will fail on download without reaching ffmpeg, so it costs no transcode budget; charging it would block the queue behind a phantom cost.

Also found while building the fixture, and worth recording because it constrains any future media test: **`post_media.sort_order` is `CHECK (>= 0 AND < 5)`, so a post holds at most five media items**, and `rendition_status = 'ready'` carries a NOT NULL rendition-path constraint (use `'skipped'` for a terminal state in fixtures).

The claim falls back to the previous count-only query when the RPC is absent, matching the repo's existing missing-RPC idiom, and the app still applies the attempt cap to whatever the RPC returns rather than trusting a database function to enforce a spend cap.

**Still open in F14:** queue-age SLOs, and part two's throughput half — global provider token bucket, `Retry-After` handling, and the circuit breaker. The `submission_unknown` state landed 2026-08-09; see *Part two's money bug, closed* below.

**Part two's money bug, now located exactly (2026-08-09) so the fix does not start from a re-read.** `generation-services.ts:1491` calls `createKieTask` and assigns to `predictionId`; the catch at `:1512` refunds on `if (!predictionId && generationId)`. `createKieTask` uses `PROVIDER_TASK_CREATE_TIMEOUT_MS` (30 s, `provider-fetch.ts:7`) with no retry. So **a timeout leaves `predictionId` undefined and takes the refund branch — which is indistinguishable from a definitive provider rejection**, even though Kie may have accepted the task. The later callback then arrives for a generation already settled as failed, and is discarded.

Three things that make the fix cheaper than it looks:

1. **The ambiguous case is already typed.** `fetchWithProviderTimeout` throws `ExternalServiceTimeoutError` (`provider-fetch.ts:31-40`), so "timed out — outcome unknown" is distinguishable from "provider rejected the request" (a thrown `Error` from the `!response.ok || data.code !== 200` branch) without new plumbing. Only the ambiguous class needs the new state.
2. **A late callback is already addressable.** `buildKieWebhookCallbackUrl({ generationId })` embeds the generation id, so the callback *can* be matched — the problem is purely that the generation was settled as failed before it arrived, not that the app cannot identify it.
3. **The reaper already exists.** `reapStalledGenerations` handles generations left without a provider task. The ambiguous case wants to route into that path with a grace window rather than refunding synchronously, so the new work is a state plus a grace period, not a new recovery mechanism.

The correct posture is **do not refund on an ambiguous submission** — hold, let the callback land or the grace expire, then refund. Refunding early is the branch that loses money twice: once by refunding a task the provider will actually bill, and again by discarding the output the user paid for.

**Caution 1 — the reaper already owns this money decision, and two timers must not both own it.** An ambiguous-timeout generation has no attached provider task, which is *exactly* the shape `reapStalledGenerations` refunds: `loadStalledStartFailureRows` selects on `created_at` older than `STALLED_GENERATION_START_FAILURE_AFTER_MINUTES` (**45 minutes**, `stalled-generation-reaper.ts:37`). So a held generation is already on a 45-minute refund clock the moment it is created. Adding a grace window without reconciling the two gives one credit hold two independent timers and two independent refund paths.

Resolve it deliberately, one of two ways:
- **The grace window *is* the reaper's window.** Add no second timer; the new state only suppresses the synchronous refund and lets the existing 45-minute branch be the single settlement point. Simplest, and the default recommendation.
- **Exclude the new state from the start-failure branch** and give it its own explicitly-owned window. Only worth it if the grace genuinely needs to differ from 45 minutes — and if so, say why in the code.

Either way, one mechanism decides. Note the reaper is not defenceless today: the settlement path already skips on `provider_task_attached` / `already_succeeded` (`:273`), so a callback that lands and attaches a task before the cutoff already saves the generation. That existing guard is the natural seam to build on rather than route around.

**Caution 2 — decide, and record, what a late callback does after a grace-expiry refund.** The grace window shrinks the race; it cannot remove it. A callback can always arrive after the refund has settled. Today that callback is **silently dropped**, which is precisely the behaviour this item exists to fix — so leaving it unaddressed *moves* the money bug rather than closing it: instead of losing money at 30 seconds, it loses it at whatever the grace window is.

The likely-right answer is to **flag it for ops reconciliation** — the generation was refunded, but the provider did the work and will bill for it, so someone needs to see the discrepancy. Alternatives are to re-charge and deliver the output, or to accept the loss and count it. **Whichever is chosen, record the decision and its reasoning here.** An unrecorded choice here reads later as an oversight, and the difference between closing this bug and relocating it is exactly this paragraph.

### Part two's money bug, closed 2026-08-09

Migration `20260809120000_generation_submission_unknown.sql`, plus the hold branch in `settleGenerationStartFailureQuietly`, the reaper's ambiguity reporting, and the webhook's reconciliation record.

**The bug was in seven start paths, not one.** The note above locates `generation-services.ts:1491`/`:1512` (image); the identical `if (!predictionId && generationId)` branch is also in video, motion, catalog, voiceover and sound-effect, plus two template variants. A per-call-site fix would have left six paths broken. The fix went into the **shared settle helper** instead, which all seven already call — so all seven changed behaviour and no call site was touched. Anyone extending this should keep that property: a new start path inherits the hold for free, and only diverges if it stops using the helper.

**"Reconcile against the provider before refunding" is not buildable, and the Fix line above is wrong about it.** Every Kie lookup is keyed on the provider's own task id (`jobs/recordInfo?taskId=`, `veo/record-info?taskId=`), and `createTask` accepts only model input plus `callBackUrl` — no client reference and no idempotency key. In the ambiguous case the task id is precisely what is missing, so there is no outbound channel to reconcile on. **The inbound callback is the reconciliation**: the callback URL embeds our generation id, so a provider that accepted the task tells us. The grace window is "wait to be told", not "wait, then go ask".

**The state is a marker column, not a new `generations.status` value** — `submission_unknown_at`, with the row left `pending`. `status` is read as set membership in at least eight places outside the reaper, and a new value would mean auditing every one. The dangerous one is `ACTIVE_START_STATUSES` (`generation-start-idempotency.ts:10`): dropping out of it would stop a same-key resubmit being deduped as a replay, **charging the user a second time while the first submission may still be accepted**. That is the `6303a95` seam bug's shape exactly — two individually-correct halves, an exploitable composition. Keeping `pending` also means old mobile builds, which lag by a store release, never see a status string they don't know (`ugc-mobile/lib/generation.ts:6` treats anything not `succeeded`/`failed` as still processing).

Two properties fall out of that choice for free, and both are pinned by tests: the credit hold survives, and `client_request_key_hash` is **not** cleared — only `settle_generation_start_failed` clears it — so a same-key resubmit replays the held generation instead of charging twice.

**Caution 1 resolved: option 1. The grace window *is* the reaper's window; there is no second timer.** A held row has exactly the shape `loadStalledStartFailureRows` selects, so it is on the 45-minute clock from creation. A separate timer would give one credit hold two owners: `settle_generation_start_failed` is idempotent so it would not double-refund, but the two would race to write the terminal state with different messages, and which one won would decide whether the discrepancy was recorded. 45 minutes is comfortably beyond Kie's callback latency. **Accepted cost:** a genuinely-rejected submission now holds credits for up to 45 minutes instead of refunding in 30 seconds — strictly better than refunding fast and losing the money twice whenever the provider did accept.

**Caution 2 resolved: flag for ops reconciliation, as a row rather than a log line.** `provider_submission_reconciliations` records generation, user, provider task id and refunded credits when a callback lands after a grace-expiry refund.

- *Re-charge and deliver* was rejected: the user was told the generation failed and watched credits return, so a silent re-debit is a surprise charge that cannot be defended in a support ticket. The defensible version of that instinct is "deliver the output for free", which is a decision to eat the cost — a better-UX variant of accept-the-loss, not a third option. Worth revisiting as an upgrade; not the default.
- *Accept the loss and count it* needs the same telemetry to produce the count, so it stops one small step short of the record.
- A **log line was specifically rejected as insufficient**: it is not queryable against money, and log retention is finite while F15b's log drain is still open. The artifact has to outlive the request.

**The precision that makes the ledger usable:** the webhook reaches this path via `already_settled`, which *also* fires for ordinary duplicate callbacks on generations that succeeded normally. The shape test — refunded **and** marked — lives inside the RPC rather than in the caller, so the invariant is enforced at the write. A ledger full of benign duplicates is one nobody reads.

**A latent bug found and fixed on the way: the reaper was not template-aware.** `loadStalledStartFailureRows` selects any `pending` row with no provider task, including template generations, and settled all of them through `settle_generation_start_failed` — which refunds the hold but never touches `template_run_steps`, stranding the run in `processing`. This was near-unreachable before, because template starts settle synchronously and only reached the reaper when that settlement had itself failed. Holding would have made those rows ordinary. The reaper now routes rows carrying a `template_run_id` to the template settlement RPC.

**Residuals, recorded rather than fixed:**

1. **Only the typed timeout is held.** `ExternalServiceTimeoutError` is the ambiguous class; a post-send `ECONNRESET` is genuinely ambiguous too, but `fetchWithTelemetry` only converts abort-like errors (`provider-fetch.ts:220-233`) and rethrows the rest unchanged. Widening it means a new classifier separating post-send network errors from `ENOTFOUND`/`ECONNREFUSED`, which unambiguously never landed. Scoped out deliberately: the timeout is the dominant case at a 30 s budget.
2. **A timeout that fired before the request left the box is indistinguishable from one that fired after**, so it holds credits for 45 minutes unnecessarily. Conservative in the safe direction.
3. **Template runs still settle synchronously and keep the original bug.** A step's outcome has to be known for the run to progress, and the existing catch (`template-run-service.ts:994`) marks the step failed on any throw — so holding the generation there would leave a failed step against a live credit hold. Making a run await an ambiguous submission is run-durability work, F12's territory, not this item.
4. **The user-facing copy needed its own code.** Timeouts classified as `provider_unavailable` — *"Please retry this step shortly"* — which on the hold path invites a retry that places a second hold while the first submission may still be billed. New code `submission_pending` says credits stay reserved and never says "retry" or "refunded". Note the copy is keyed on a **tag set when the hold is recorded**, not on the error type: the same `ExternalServiceTimeoutError` is refunded on the template path, and keying on shape would promise reserved credits to a user who had already been refunded.

---

### Part two's throughput half, landed 2026-08-09

Migration `20260809130000_provider_admission_control.sql` (two tables, `admit_provider_submission`, `record_provider_submission_outcome`) plus `provider-admission.ts` and the gate in `createKieTask`. **Queue-age SLOs are the only F14 item still open.**

**The `Retry-After` sub-item was already half-built, and the half that existed is not the half that was needed.** `fetchWithProviderRetry` has parsed `Retry-After`, capped it at 10 s and preferred it over backoff since before this audit (`provider-fetch.ts:307`). Submissions never reach it and *must not*: task creation is a non-idempotent POST, so `ProviderRetryPolicy` deliberately clamps it to one attempt — retrying a submission is exactly the double-charge the money-bug fix just closed. So the useful meaning of "handle `Retry-After`" on this path is not "retry later"; it is **"let the provider set how long the circuit stays open"**, which is what landed. An uncapped parse was needed for it, because the 10 s cap exists to stop a caller blocking and nothing blocks here.

**Kie publishes no numeric limits at all.** All 20 files in `model_api_references/` document a 429 response; not one states a request rate or a concurrency cap. Two consequences: the numbers below are *ours*, not the provider's, and the reactive half (429 handling, breaker) carries more weight than bucket tuning, because the real ceiling can only be discovered by hitting it. Raise these from the certification load test, not from a hunch.

| Gate | Setting | Why |
|---|---|---|
| Global bucket | capacity 15, refill 1.5/s | the audit's "~15 per 10 s", with the burst made explicit |
| Per-model bucket | capacity 6, refill 0.6/s | one model cannot drain the account budget |
| In-flight cap | 50, over a 1-hour window | the audit's "~50 concurrent" |
| Breaker | 5 consecutive failures, 60 s open | conservative; a failed probe re-opens at once |

**Six decisions worth not re-deriving:**

1. **One RPC, not three.** Consuming a global token and *then* rejecting on the per-model bucket leaks the global token — budget spent on a submission that never goes out. Both buckets are read first and consumed only once both can pay, which is only expressible in one statement. It also avoids paying three round trips on the slowest thing a user waits on.
2. **A real token bucket, not `check_backend_rate_limit`.** The existing limiter is a fixed window, which admits 2× the limit across a boundary instant — precisely the burst shape that trips a provider rate limit. Reusing it would have looked like the same fix and protected against a different thing.
3. **The gate lives in `createKieTask`, not the seven start call sites** — the same property that made the money-bug fix land in the shared settle helper. A new start path inherits admission for free.
4. **The rejection type is money-critical.** It must never be an `ExternalServiceTimeoutError`, or `settleGenerationStartFailureQuietly` would *hold* the credits for the reaper's 45 minutes. It is a `GenerationServiceError(429, 'provider_busy')`, so the ordinary refund runs — correct because no request was sent and the provider will never bill for it. That also makes `provider_busy`'s existing "please retry shortly" copy honest here, which is the exact opposite of the held case, whose copy must never invite a retry. No new failure code was needed.
5. **The breaker only counts provider fault: timeout, 429, 5xx.** A 4xx is this account's mistake, and a body-level rejection returned under HTTP 200 is how Kie reports a validation error — counting either would let **one user's malformed prompt open the circuit for everybody**. This is the single most dangerous way to get a circuit breaker wrong.
6. **Admission fails open.** The gate protects the provider from us; it is not a correctness boundary. An unreachable table — or a service-role client that cannot be constructed — returns "admitted" and logs, because refusing every generation over a monitoring problem is a self-inflicted outage. The genuine "not admitted" throw sits deliberately outside that fail-open block, or the whole gate would silently disable itself.

**Two liveness traps, both closed and both worth knowing because they fail silently:**

- **A probe must bypass the remaining gates.** If a bucket drained while the circuit was open, it would block the one request whose entire purpose is to discover recovery — and the breaker would never close.
- **A probe that never reports an outcome must be reclaimed.** An instance dying mid-probe would otherwise leave `probe_started_at` set forever and wedge the breaker permanently half-open. Same reasoning as F12's reclaim on `coalesce(heartbeat_at, locked_at)`.

Also: the in-flight count is deliberately **windowed to an hour**. Counting every non-terminal generation would let a handful of permanently stuck rows wedge submissions account-wide; the 45-minute reaper is what clears strays.

**Deliberately not built: a submission queue.** The audit observes "a launch spike hits provider 429s with no queue", but its prescribed fix is admission control, and its enumerated deliverables contain no queue. Queueing a submission means holding a user's credits against work that has not been sent — F12's durability territory and a far larger change. Recorded so the absence reads as a decision rather than an omission.

**Gates:** 3,883 web tests, lint, three typechecks, `build`, `build:verify`, a clean `db reset --local` replay, and 577 pgTAP assertions (up from 560 — the 17 new ones cover bucket refill, the global-token-leak property, and the full open → half-open → closed cycle, which no string assertion can reach).

---

### Queue-age SLOs, landed 2026-08-09 — F14 closes

`backend-queue-age.ts`, wired into `collectBackendHealth` as `health.queueAge`.

**The registry already answered a different question, and the difference is the whole item.** `healthExpectedMaxAgeMinutes` measures *job liveness* — did this job run recently? Queue age asks whether **work is piling up**, and the two diverge exactly where it matters: a job can run perfectly on schedule, every single time, while its backlog grows without bound. **F13 was that shape** — an hourly refresh that permanently starved every row past the first thousand, with liveness green throughout. Nothing in the health surface would have caught it.

**The SLO is derived, not hand-set.** The certification gate asks for "queue age below twice its cadence", so each queue's threshold is computed from its owning job's `cadenceMinutes` in the registry. A hand-set constant would keep asserting the old cadence after a schedule change — the same drift F14 already guarded against by asserting `vercel.json` against this same registry. Two multipliers: **2× is the SLO breach (warning), 4× means the queue is not draining at all (degraded)**, because "slower than intended" and "broken" deserve different responses.

| Queue | Owning job | Cadence | SLO | Not draining |
|---|---|---:|---:|---:|
| `generation_completion_jobs` | `generation-completions` | 10 min | 20 min | 40 min |
| `workflow_run_step_jobs` | `workflow-run-steps` | 10 min | 20 min | 40 min |
| `post_media` renditions | `media-preview-repair` | 60 min | 120 min | 240 min |

**Three findings worth keeping:**

1. **F12's durable queue had no health coverage whatsoever.** `workflow_run_step_jobs` shipped with claims, leases, heartbeats, attempt caps and backoff — and nothing watching it. It is covered now. Worth generalising: the F12 work added a queue and the F14 work added the monitoring, two commits apart, and nothing in either gate would have flagged the gap.
2. **Queue age cannot be derived from the existing samples.** The health collectors read capped samples (200 completion rows, 500 media rows) and filter in JS. That is fine for counts, but the true oldest item falls outside the cap exactly when the queue is deep enough to matter — so a sampled age gets *optimistic* as the backlog grows. This is F15a's finding in a new place, so each queue gets a targeted `order by … limit 1` probe instead.
3. **Age runs from `next_attempt_at`, not `created_at`, on the retry queues.** An item deliberately deferred by backoff is not late. Ageing from creation would report a healthy retry schedule as a permanent breach. The media queue has no such column, so it ages from creation — which is the honest reading there anyway: an unresolved rendition has been serving full-bitrate source video to every viewer since it existed.

**An empty queue reports `null`, never zero,** and an unprobeable queue is flagged `QUEUE_AGE_UNREADABLE` rather than passed as healthy — `ageMinutes: null` alone is ambiguous, since it is also the empty-queue answer, so a separate `readable` flag carries the distinction. Not knowing is not the same as being fine; that is F15a's core finding, and it is easy to reintroduce.

**Gates:** 3,894 web tests (11 new), lint, three typechecks, build, build:verify. Extending the health fixture was itself informative — it had no `maybeSingle` and no `lte`, because until now every health read was a sampled list.

---

### Part two's money bug — verified in production 2026-08-09

Verified after the deploy of `9a4e224` (live `/api/app-version` buildId matches the commit). Every object was confirmed **absent before the push and present after**, so the deploy created them rather than an earlier partial apply:

| Check | Result |
|---|---|
| `generations.submission_unknown_at` | present, `timestamptz` nullable |
| `generations_submission_unknown_idx` | present |
| `mark_generation_submission_unknown` | present |
| `provider_submission_reconciliations` (+ open index, RLS on) | present |
| `record_provider_submission_reconciliation` | present |
| `settle_generation_start_failed` reports the marker | yes — `submission_unknown` is in the deployed body |
| refunded-**and**-marked shape test lives inside the ledger RPC | yes |
| EXECUTE grants on all three functions | `service_role` only (plus owner) — no `authenticated` |
| Held generations / reconciliation rows | 0 / 0 — clean baseline |

`get_advisors` was re-run per F12's standing rule: **no new WARN**. The only WARN is still the pre-existing `start_workflow_canvas_run` row F12 documents as structural-and-reviewed. `provider_submission_reconciliations` shows under the INFO lint `rls_enabled_no_policy`, which is correct and intended — a service-role-only table with RLS on and no policies, matching ~35 sibling internal tables (`admin_credit_adjustments`, `workflow_run_step_jobs`, `provider_fetch_attempt_counters`, …). F12's vulnerability class cannot apply to any of these three functions: all are `SECURITY DEFINER`, none is reachable by `authenticated`.

**The 0/0 baseline is the number to re-read later.** A non-zero `provider_submission_reconciliations` count is the first hard evidence that ambiguous submissions happen in production rather than in theory, and every row is money the provider billed for output that was refunded.

---

### F5 — For-you RPC materializes the whole eligible catalog

**Status:** DONE · **Severity:** High · **Surface:** migration
**Landed:** `20260809140000_feed_ranking_limit_first_pools.sql` — LIMIT-first pools per lane plus `posts_public_visible_owner_recent_idx`, 2026-08-09. v1 only; **v2 is a gate before promotion**.

**Problem.** Both ranking RPCs open with an unbounded `eligible AS MATERIALIZED` CTE over all public visible posts; the per-pool limits apply only afterwards. At 100,000 posts and 2,000 fresh sessions/day this implies on the order of 200 million eligible-row examinations per day before joins and ranking. Production already shows 493 ms and 140 ms mean RPCs at 34 posts.

**Evidence.** `supabase/migrations/20260711064036_feed_personalization_system.sql:765-798` (v1) and `supabase/migrations/20260728181000_feed_ranking_v2.sql:626-661` (v2). Pool limits at `src/lib/showcase-feed-personalization.ts:258-262`.

**Fix.** Index-driven, LIMIT-first pools per lane (recent, trending, following, affinity, exploration), using `posts_public_review_recent_idx`. Cache anonymous and cohort candidate pools.

### Measured 2026-08-09 — this diagnosis holds, unlike F5b's

F5b was measured first and its premise collapsed, so F5 was measured the same way before implementing. **The two items are not the same shape, despite the audit describing them that way.**

`get_ranked_feed_candidates(<real user>, null, 60, now())` in production, returning 32 rows:

| | Buffers | Time |
|---|---:|---:|
| Cold session | 2,310 | 39.8 ms |
| Warm, same session | **269** | 6.0 ms |
| *(F5b's equivalent, for contrast)* | *34* | *7.4 ms* |

**269 buffers of genuine execution to produce 60 candidates from 34 posts** — against F5b's 34. That is the unbounded `eligible AS MATERIALIZED` CTE doing real work, and it is the part that grows with the catalog. So **F5's structural concern is live and its prescribed fix targets the right thing**, where F5b's did not.

Two caveats to carry into the implementation:

1. **Production's 1,549 blocks/call is still ~83% planning.** The same verification trap applies: `shared_blks_hit / calls` will barely move after a correct restructure, because planning dominates the average. Measure execution buffers at a fixed page size against a **locally seeded large catalog**, and treat the production figure as a volume metric.
2. **Parameterise the measurement correctly.** The second argument is `p_category`, not a lane. Passing `'for-you'` there returns 0 rows and looks like a cheap function — an easy way to measure nothing and conclude the ranking is fine. Pass `null` for all categories and a user id that actually has feed history.

Also worth knowing before starting: `get_ranked_feed_candidates` is `plpgsql`, so it is never inlined and its body is planned per session — which is where the other 2,040 buffers go.

### Landed 2026-08-09 — cost is now flat in catalog size

Measured on a seeded local catalog, execution buffers for one 60-candidate page:

| Catalog | Before | After |
|---|---|---|
| 50,000 posts | 111,150 buffers · 138 ms · spills to temp | **5,669 · 6.9 ms** |
| 200,000 posts | 445,336 buffers · 587 ms · spills **and reads from disk** | **6,171 · 8.2 ms** |

**+8.9% for a 4× catalog is the property this item asked for.** The old shape grew 4× across the same step.

**Output is provably unchanged.** The personalised, anonymous and category-filtered calls each return the same 60 posts, in the same positions, with the same `candidate_source` as the previous implementation. A test also asserts the scoring stage is reproduced **verbatim** from `20260711064036` apart from the row source it reads, so ranking cannot drift through the rewrite — a buffer measurement would never have caught that.

**Four things worth not re-deriving:**

1. **Deleting the `MATERIALIZED` keyword does nothing.** Measured: identical 111,150 buffers and an identical plan. Postgres only auto-inlines a CTE referenced **once**, and `eligible` is referenced six times, so the keyword was documenting what would have happened anyway. The one-word fix is a trap.
2. **The rewrite made things *worse* before it made them better — 187,643 buffers at one point.** Two causes, both instructive. The exploration pool's "posts with no stats row" branch anti-joined the whole catalog to return **zero** rows (151,808 buffers); it is now bounded to the newest page, which is sound rather than merely cheap because a post lacks a stats row only until the next refresh. And the per-row `NOT EXISTS` feedback checks became 12,500 index probes inside the following pool, evaluated before any LIMIT could apply.
3. **The fix for that was to invert what gets materialised.** The viewer's two feedback lists are now `AS MATERIALIZED` CTEs. Materialising them is safe precisely where materialising the catalog was not: their size is bounded by one viewer's behaviour, not by how many posts exist. **Materialise the small thing, not the big one.**
4. **One index was genuinely missing, and only one.** Every pre-existing owner-scoped index omits one predicate — `posts_owner_archived_created_idx` has no `visibility`, `posts_public_owner_profile_stats_idx` has no `review_status`. Either omission leaves a filter the index cannot satisfy, so the planner fell back to a bitmap scan, which is unordered and therefore **cannot stop at the LIMIT**: it top-N heapsorted every one of a creator's posts. `posts_public_visible_owner_recent_idx` carries all three, and the following pool dropped from 5,749 buffers to **29**.

**Not covered: `get_ranked_feed_candidates_v2`.** It carries the same unbounded CTE, but it is still seeded `shadow` and serves no traffic, so it was left alone rather than rewritten blind against a fixture built for v1. **This is now a second gate before promoting v2**, alongside F13's seed-1,000-creators disjointness check. Leaving it silent is exactly how F13's starvation bug reached v2 in the first place.

**A fixture caveat for whoever re-measures.** The seed uses 20 creators, so posts-per-creator grows with the catalog; in a real catalog creator count grows too, which makes the following pool's scaling *better* than this fixture suggests, not worse.

---

### F5b — `list_marketplace_resource_bundles` reads ~1,000 buffers per call and is 47% of RPC time

**Status:** DONE — diagnosis corrected by measurement 2026-08-09; all three corrected items landed · **Severity:** High · **Surface:** migration + server
**Landed:** Tool-filtered caching (`v4`) + 6-arg shim drop (`20260809150000`), then the catalog-scale restructure (`20260809210000_marketplace_bundle_listings`), 2026-08-09

**Provenance.** Not in the original audit. Found capturing the decision-#4 CPU baseline, which ranked RPCs by *total* time consumed rather than by mean latency — the axis on which this function is invisible (17 ms looks healthy) and dominant (47.3% of all RPC time, 16.4% of all statement time) at the same time.

**Problem.** The marketplace listing does ~1,000 shared-buffer reads per call to return one page. It is the same defect F5 describes — scan the world, filter and paginate afterwards — but on a path with **19× the call volume** of the ranked feed it sits next to in this phase. It is not slow *today* only because the entire 61 MB database fits in 224 MB of `shared_buffers`, so every one of those reads is a memory hit. That property expires with catalog growth, and when it does this is the first thing to fall over.

**Evidence** (`pg_stat_statements`, production, 2026-08-08):

| Metric | Value | Reading |
|---|---:|---|
| Calls | 47,880 | vs 2,542 for `get_ranked_feed_candidates` |
| Mean / max / stddev | 17.0 / 879.9 / 34.1 ms | variance ≫ mean — already unstable |
| `shared_blks_hit` | 47,990,116 | **1,002 blocks ≈ 7.8 MB per call** |
| `shared_blks_read` | 58 (lifetime) | fully cache-resident — the reason it looks cheap |
| `temp_blks_written` | 0 | does not spill yet at `work_mem` 2.1 MB |
| Rows returned | 1 per call | PostgREST scalar — one JSON document |

- Caller: `src/lib/post-resource-bundles-server.ts:1773`, on a service-role client, with a JS fallback (`getMarketplaceResourceListFallback`) for databases missing the RPC.
- **Two live overloads.** A 6-arg signature is a back-compat shim delegating to the 7-arg one with `p_query => NULL`; the app calls the 7-arg form. Named-argument dispatch keeps this unambiguous today, but it is the same latent PostgREST overload hazard F6 hit and deliberately removed — *"PostgREST would match a four-argument call against both functions and reject it as ambiguous."* Fold the shim's removal into this item unless a caller for it turns up.
- Defined across six migrations, most recently `20260723120000_post_resource_media_scope.sql`; `20260621103236_restrict_backend_owned_rpcs.sql` set its grants.

**Fix.** Same shape as F5: make the row source LIMIT-first and index-driven instead of materialize-then-filter, so per-call buffer traffic scales with page size rather than catalog size. Confirm with `EXPLAIN (ANALYZE, BUFFERS)` that a page costs buffers proportional to `p_limit`. Drop the 6-arg shim in the same migration if nothing calls it.

> ⚠️ **The Fix line above is wrong about today's number, and the measurements below say why. Read this before implementing it.**

### Measured 2026-08-09 — the 1,000 blocks are not the query

`EXPLAIN (ANALYZE, BUFFERS)` against production, at a catalog of **9 published bundles and 32 public posts**:

| Measurement | Result |
|---|---|
| Function scan, cold session | **1,789 buffers, 28.0 ms**, 9 rows |
| Same call, second time in the same session | **34 buffers, 7.4 ms** |
| The 3-table join alone, *execution* | **10 buffers, 0.151 ms** |
| The 3-table join alone, *planning* | **872 buffers, 2.5 ms** |

**Execution is 34 buffers. The rest is planning, and it is paid on most calls.** Production averages 930 blocks/call, which sits between the cold (1,789) and warm (34) figures — so the majority of calls are re-planning rather than reusing a cached plan.

The audit reasoned that this "is not slow today only because the entire 61 MB database fits in `shared_buffers`, so every one of those reads is a memory hit." That is not what is happening. At 9 rows the table is 5 pages; a full scan of the whole catalog costs 10 buffers. **Making the row source LIMIT-first would optimise the 34, not the 930.**

**A control across four other RPCs shows a fixed floor that belongs to no query:**

| RPC | Calls | Blocks/call | Mean |
|---|---:|---:|---:|
| `list_marketplace_resource_bundles` | 53,777 | 930 | 16.4 ms |
| `get_ranked_feed_candidates` | 2,577 | **1,549** | 51.8 ms |
| `check_backend_rate_limit` | 10,611 | **205** | 10.8 ms |
| `record_post_share_event` | 3,863 | **197** | 19.3 ms |

`check_backend_rate_limit` is a DELETE plus an UPSERT on one small table and still costs **205 blocks**. That is the per-call cost of a PostgREST RPC round trip — wrapper, parameter marshalling and planning — and **no rewrite of any function body can remove it**. Note also that `get_ranked_feed_candidates` is *more* expensive per call than the marketplace listing; the marketplace only leads on total because it has 20× the volume, which the audit did say ("on volume rather than per-call cost").

**Two candidate causes were checked and eliminated**, so they are not re-tested later: the jsonb columns are **not** being repeatedly detoasted (TOAST size is 0 bytes; every `workflow_snapshot`, `resource_items` and `resource_sections` value is under 1 KB), and the **catalog is not bloated** (`pg_proc` 1.5 MB / 3,752 rows at 7.7% dead, `pg_class` 336 kB — all healthy, recently autovacuumed).

**The indexes the Fix line would add already exist.** `post_resource_bundles` carries **14** indexes, including `(status, created_at DESC, id DESC)` — an exact match for the default `recent` sort — plus `post_resource_bundles_sales_idx` for `top-sales` and `post_resource_bundles_access_mode_created_idx` for the access filter. The planner picks a sequential scan because at 9 rows that is genuinely correct.

### What is actually true, and what to do about it

Both of these hold at once, and conflating them is what makes the Fix line wrong:

1. **Today's cost is planning plus a fixed PostgREST floor, and is not addressable by rewriting the function.** ~200 blocks is the RPC floor; ~730 more is planning a 3-table join with a per-row `plpgsql` quality predicate and four inline JSON subqueries. The levers are **call volume** and **plan reuse**, not query shape.
2. **The audit's structural concern is still correct for the future.** Execution is 34 blocks *at 9 rows*. The body evaluates `marketplace_resource_bundle_quality_issue` — `plpgsql`, so never inlined — once per candidate row before `ORDER BY … LIMIT`, and the `CASE WHEN p_sort = …` ordering cannot match an index under a generic plan. At a large catalog that execution cost grows with catalog size, exactly as described. It is simply **not what is being measured today**.

**Therefore the verify step in this item is unsound as written.** "Re-read `shared_blks_hit / calls` after deploy" would report ~930 before and ~930 after a perfectly correct restructure, and read as a failed fix — the same trap F3 fell into when a correct metadata backfill changed nothing observable. Measure the restructure with a **seeded large catalog** locally, comparing execution buffers at a fixed page size across catalog sizes; treat the production per-call figure as a *volume and plan-reuse* metric instead.

**Sequenced work, in value order:**

- ~~**Reduce call volume.**~~ **Done 2026-08-09.** Caching now covers **tool-filtered** first pages as well as unfiltered ones (`marketplace-resource-list-base-v4`, key gained a `tool` argument). Search stays uncached on purpose, and the line between them is key-space rather than correctness: tool slugs come from the source-tool catalog and arrive normalised, so entries are bounded, while a free-text query is unbounded and one visitor could mint arbitrarily many. Continuation pages stay uncached for the same reason.
- ~~**Drop the 6-arg shim.**~~ **Done 2026-08-09** (`20260809150000`). Confirmed unreferenced first — the only caller always supplies `p_query`. No latency change expected or observed; this closes the PostgREST ambiguity footgun F6 already hit, nothing more.
- ~~**Restructure for catalog scale.**~~ **Done 2026-08-09** (`20260809210000`). Execution was 34 buffers at 9 published bundles (~3.8/bundle) — a scan with a per-row `plpgsql` quality predicate evaluated before `ORDER BY … LIMIT`, growing with the catalog exactly as F5's did. See the section below.

### Restructure landed 2026-08-09 — measured on a seeded catalog, as this item required

`marketplace_bundle_listings` is a derived table: one row per bundle carrying the precomputed listing gate, the sort keys and the filter flags, maintained by triggers and never written by application code. `list_marketplace_resource_bundles` now filters and sorts entirely on it and fetches the wide bundle row by primary key for the page only.

Three things were O(catalog) and all three are gone from the default path: the per-row `plpgsql` quality predicate, five per-row jsonb containment predicates for the resource filter, and a `CASE WHEN p_sort = …` ordering that no index can serve (so every page sorted the whole filtered catalog).

**Measured by growing a seeded catalog, page size fixed at 24, warm session, second run reported:**

| Catalog (listable) | Old, default page | New, default page | New, `top-sales` | Old search | New search |
|---:|---:|---:|---:|---:|---:|
| 1,000 (796) | 2,625 buf / 81 ms | **99** / 0.21 ms | 122 | 2,625 | 144 |
| 5,000 (3,986) | 13,021 / 408 ms | **99** / 0.19 ms | 122 | 13,021 | 548 |
| 20,000 (15,940) | 84,973 / 1,660 ms | **106** / 0.23 ms | 129 | 84,973 | 2,096 |
| 80,000 (63,754) | 408,080 / 6,651 ms | **134** / 0.21 ms | 142 | 408,080 | 19,009 |

**The old path grew 155× across that range; the new one grew 35%** — and that residual growth is index depth, not catalog scan. At 80,000 bundles the default page is **3,045× fewer buffers and ~31,000× faster**.

**Correctness was established by differential, not by inspection.** The pre-change function was kept under a second name and both were called with the same arguments across 34 parameter combinations — every sort, every access and resource filter, tool filters, offsets, and eight search strings — at 1k, 20k and 80k catalogs. Every one returned an identical id sequence. Two of the resource filters initially compared *vacuously* (both returned zero rows because the seed created no workflow or file bundles); the seed was widened until they returned real pages, because a green comparison over empty results proves nothing.

**Measure it this way, not the way the Verify line says.** Through PostgREST the built app shows ~512 blocks/call at an 800-bundle catalog against the 99 that `EXPLAIN` reports — the difference is the ~200-block PostgREST floor plus planning, exactly as this item established. `shared_blks_hit / calls` will not move meaningfully in production and must not be used to judge this change.

#### The finding that changed the design: a derived column on `post_resource_bundles` breaks moderation

The obvious shape is a `marketplace_listable` column on the bundle. **It was built that way first, and taking a post down failed outright.**

`post_resource_bundles` carries **six** BEFORE/AFTER triggers written for user edits, and a derived-column write goes through all of them. `validate_post_resource_bundle_write()` raises *"Only public posts can publish resource bundles"* whenever `status = 'published'` and the post is not public — so hiding a post fired the recompute, the recompute wrote the bundle, and the write raised. Not a stale listing: **a moderation action that errors**. The others are no better — `capture_post_resource_bundle_revision()` would write a revision row per gate flip, `touch_updated_at_column()` would bump a user-visible `updated_at`, and `protect_sold_post_resource_bundle_content()` guards sold bundles against exactly this kind of write.

The existing `sync_sold_post_resource_bundle_visibility()` only gets away with writing bundles from a posts trigger because it sets `status = 'draft'`, which makes the validation pass — and it only runs for *sold* bundles, so no write happened in this case before. Suppressing six triggers, two of them money and moderation controls, to make room for a cache column is a far larger blast radius than the item warrants. **This surfaced only from seeding the test catalog**; every unit gate was green.

#### Three more things worth carrying

1. **It is triggers on three tables, not two.** The audit predicted `post_resource_bundles` and `posts`. `marketplace_resource_bundle_quality_issue` also takes `p_seller_username` and `p_seller_display_name`, so an incomplete creator profile is a listing gate and `profiles` needs one too. pgTAP asserts that clearing a seller's name delists their bundles.

2. **The trigger WHEN clauses are load-bearing in both directions.** They cannot be narrow, because a missed post column means taken-down content stays listed — this is now a moderation control, strictly worse than the `SHOWCASE_FEED_CACHE_TAG` over-invalidation below. They also cannot be `OLD.* IS DISTINCT FROM NEW.*`, because `posts` carries `save_count` / `comment_count` / `share_count` / `report_count` and `profiles` carries `credits`, all written on hot paths — that would put a `plpgsql` quality predicate on every comment and every generation charge. So both are explicit column lists, the migration test asserts the post list still covers every column the predicate reads, and pgTAP asserts via `xmin` that a comment-count update does not touch the listing row at all.

3. **Search was made worse before it was made better, and only measurement caught it.** Expressing search as a correlated `EXISTS` kept one query shape but ran the subquery per candidate row: search **regressed from 89,390 to 136,937 buffers** at 20,000 bundles. Composing a real join in for the search branch only — so the default path still plans against two tables instead of four — brought it to 2,096. Search is now 21× cheaper than before at 80k but is **still O(catalog)**, because a substring match across three tables plus two jsonb aggregations is not something a btree can serve. **Residual: search needs a trigram or FTS index before certification if it is expected to hold at scale.** It is uncached by design (the key space is unbounded), so it has no cache in front of it.

**One deliberate cost:** `sales_count` is a sort key, so a purchase re-evaluates the quality predicate for that one bundle. That is one `plpgsql` call on a money path that already writes several rows — cheaper than letting `top-sales` order by a stale count.

**The `SHOWCASE_FEED_CACHE_TAG` coupling is load-bearing — checked, and do not "clean it up".** The suspicion above was that it over-invalidates, which it does: the hourly media-repair sweep, profile updates, post reports and account deletion all bust the marketplace listing. But the moderation take-down path (`admin-moderation-service.ts:98`) invalidates **only** the feed tag and never the marketplace one, so that tag is the single thing keeping taken-down content out of the marketplace listing. Removing it to reduce invalidation would open a moderation hole for the length of the revalidate window. Narrowing it means first making every post-visibility path invalidate `MARKETPLACE_RESOURCE_LIST_CACHE_TAG` too — worth doing, but it is a moderation change, not a caching one.

**Carry to F8:** the ~200-block PostgREST RPC floor is quantitative support for F8 beyond its `auth.getUser()` round trip. The baseline already attributes ~25% of all database time to connection and session overhead; this is the same tax measured from the other side.

**~~Verify.~~ Superseded — this step is unsound, see *Measure it this way* above.** ~~Re-read `shared_blks_hit / calls` from `pg_stat_statements` after deploy~~ would report ~930 before and after a correct restructure. The verification that was actually used: seed a catalog locally, grow it (never delete down — a mass delete leaves dead index entries, and a "smaller" catalog measured that way reads *slower* than a larger one, inverting the whole comparison), and compare execution buffers at a fixed page size across sizes.

**Sequencing note.** This lands *after* F12 and F14 — those are correctness and money bugs, this is a scaling bug that is not yet biting. But it should land **before** the certification test, or the test will certify a number that the marketplace path cannot hold once the catalog grows past `shared_buffers`.

**Post-deploy check, still outstanding.** This migration adds a table and four functions, so the standing rule applies: **run `get_advisors` after it deploys.** It was not run here because these changes are not deployed — the local stack is not the surface the advisor reads.

---

### F7b — Fact retention and partitioning

**Status:** DONE — retention, monitoring and daily aggregates landed 2026-08-09; **partitioning analysed and deliberately deferred**, with the trigger to revisit recorded below · **Severity:** High · **Surface:** migration
**Landed:** `FEED_FACT_RETENTION_DAYS` 400 → 30, `feed_delivery_facts` added to growth reporting, a retention-lag monitor, and the `feed_delivery_fact_daily` rollup — `20260809160000` and `20260809180000`, plus `feed-retention-policy.ts` / `feed-retention-lag.ts`.

At 5,000 MAU with 50% personalized use and 400-day retention, roughly 24 million facts accumulate — on the order of 24–48 GiB with indexes, against an 8 GiB included quota. Move to 30–90 day raw retention (see the decision in F7a), keep daily aggregates for the longer experiment window, and partition `feed_events` and `feed_delivery_facts` monthly by `ranked_at`. Add fact-table bytes, growth per day and retention lag to monitoring.

### Measured and landed 2026-08-09

**Production state:** `feed_delivery_facts` 14,983 rows / 14 MB (2026-07-28 → 08-08), `feed_events` 4,403 rows / 4.7 MB, `feed_sessions` 32, `feed_session_items` 1,024.

**The ~1 KB per fact row that this item's GiB projection rests on is now measured, not assumed** — 14 MB across 14,983 rows, dominated by `score_components` jsonb. The projection holds: 24M rows really is ~24 GiB.

**But the "60 facts per session" input is a ceiling production has never reached.** Measured daily, facts run **26–32 per session** across every day since the table existed — because production has ~34 public posts and the candidate pool limit is 60, so a session can never rank more than the catalog. The 5,000 MAU arithmetic is therefore *not* conservative in the way it looks: the per-session figure will **rise** toward the served-slice bound as the catalog grows, rather than staying at today's 26–32. Re-derive the gate from a real catalog before trusting it.

**Landed:**

1. **Retention 400 → 30 days** (decision #2). Constants moved to `feed-retention-policy.ts` — separate from `feed-maintenance.ts` because the sweep is mocked wholesale by its route tests, so a monitor importing the numbers from there breaks whenever someone mocks the module for an unrelated reason. That coupling was found by the change, not designed around.
2. **`feed_delivery_facts` added to `get_operational_table_growth`.** It was the *only* feed table missing — the RPC already covered `feed_events`, `feed_sessions` and `feed_session_items`. The table the entire 5,000 MAU gate is derived from was invisible to growth reporting. `workflow_run_step_jobs` was added at the same time, for the same reason F14 found it unmonitored.
3. **Retention lag** (`get_feed_retention_lag` + `feed-retention-lag.ts`), reported through `health.feedRetentionLag`. This is a different question from growth and it is the one that matters: the prune deletes at most `FEED_RETENTION_PRUNE_LIMIT` (5,000) rows an hour, so once inserts exceed that ceiling the oldest row ages past its window while the table merely looks "large" — indistinguishable from ordinary growth in a row-count budget. **Lag reads 0 at any size while the sweep keeps up**, which no row ceiling can do: at a 30-day window the steady state is ~37k rows today and ~1.8M at 5,000 MAU, so any fixed ceiling either fires constantly at scale or never fires at all.

4. **Daily aggregates — landed 2026-08-09, discharging the 2026-08-27 deadline this item created.** `feed_delivery_fact_daily` plus `refresh_feed_delivery_fact_daily`, rolled up by the existing hourly feed-maintenance job and kept for **400 days** — the window the raw facts used to hold. Decision #2 cut raw retention to 30 days *because* the aggregates would carry the experiment lookback; until they existed that was a promise, and the 30-day window would have begun discarding history on 2026-08-27.

   Grain is the experiment-analysis grain, not the row: one bucket per day per (algorithm version, experiment, variant, candidate source, surface). Three things in it are load-bearing and were each proven against the database rather than assumed:

   - **`UNIQUE NULLS NOT DISTINCT`.** Four of the six grain columns are nullable, and under Postgres's default NULLS-DISTINCT rule every such row is unique — so `ON CONFLICT` would never fire and each hourly run would **append a duplicate bucket instead of updating one**, inflating every metric a little more each hour while looking entirely plausible. Verified directly: two NULL-bearing inserts collapse to one row.
   - **The upsert assigns, it does not accumulate.** The window is re-read in full each run, so `+ excluded` would double-count immediately.
   - **It recomputes a trailing 3-day window rather than appending a finished day**, because facts are *mutated* after insert — `served_at`, `opened_at`, `saved_at` are stamped as outcomes arrive, so a day's bucket is not final when the day ends. A pgTAP test stamps an outcome after the first rollup and asserts the next one picks it up.

   **A correctness bug the fixture caught:** `dwell_ms_max` and `media_progress_max` are `NOT NULL DEFAULT 0`, so the observation counts were originally written as `FILTER (WHERE … IS NOT NULL)` — which counts *every* delivery as an observation and divides by the wrong denominator. They count on `> 0` now. That is the kind of wrong that produces a plausible average for months.

   The rollup runs **before** the prune in the maintenance job. The 3-day window sits well inside the 30-day retention so the order is not load-bearing today, but aggregating before deleting is the invariant that survives either number changing, and getting it backwards would silently drop a day of history rather than fail. The order is asserted in the unit test.

### Still open, with the groundwork done

### ⚠️ Monthly partitioning — analysed 2026-08-09 and **deliberately not implemented**

**Decision #2 moved the ground under this recommendation.** Monthly partitioning was specified while raw retention was **400 days**, where it is obviously right: thirteen partitions, and retention becomes `DROP PARTITION`. At **30 days** it stops working, for three reasons that compound.

**1. Monthly granularity cannot enforce a 30-day window by dropping.** A partition can only be dropped once its *entire* range has expired. The July partition holds Jul 1–31, so on 9 August its Jul 10–31 rows are still live and it cannot be dropped until 31 August. Enforcing a 30-day policy with monthly partitions therefore retains **up to ~60 days of data** — double the storage decision #2 was taken to bound, against the same 8 GiB quota. The alternative is to keep the row-by-row `DELETE` prune anyway, in which case partitioning buys nothing for retention.

**2. Finer granularity lands on the hottest write path in the app.** `apply_feed_delivery_outcome` updates a fact with `WHERE facts.delivery_id = NEW.delivery_fact_id` — **no partition key** — and it fires on *every* feed event (impression, dwell, four media-progress milestones, open, quick skip). Without the partition key in the predicate Postgres must probe every partition, so daily partitions would turn the app's most frequent write into ~30 index lookups. `feed_events` carries `occurred_at` but **not the fact's `ranked_at`**, so fixing the predicate is a schema change to `feed_events` plus an app change to populate it — not a partitioning migration.

**3. The size argument has weakened by an order of magnitude.** This item's own projection assumed 400-day retention and ~24M rows. At 30 days the steady state is **~37k rows today and ~1.8M at 5,000 MAU** — not a size Postgres needs partitioning for. What remains is the prune *rate*: ~60,000 deletions/day at 5,000 MAU against the 120,000/day ceiling, a 2× margin rather than a wall, and now watched by the retention-lag monitor.

**Recommendation: defer.** Revisit when the retention-lag monitor shows the prune approaching its ceiling, or if raw retention is ever lengthened again — the case returns immediately at a longer window. If it is done, the shape is **daily or weekly** partitions plus carrying the fact's `ranked_at` into `feed_events` so the outcome update can prune to one partition. **Not monthly**, which satisfies neither the retention window nor the write path.

The groundwork below stands and is still accurate for whenever that happens:

- **Nothing holds an inbound foreign key to either table.** `feed_events.delivery_fact_id` is a plain `bigint` with **no FK constraint**, and nothing references `feed_events` either. Both tables carry only outbound FKs (to `auth.users`, `posts`, `feed_sessions`, `feed_algorithm_versions`), which partitioned tables support. So the usual hard part — rebuilding inbound FKs against a partitioned parent — does not exist here.
- **The primary keys must absorb the partition key**: `feed_delivery_facts` PK becomes `(delivery_id, ranked_at)` and `feed_events` becomes `(id, occurred_at)`. Check `recordServedDeliveryFacts`'s `ON CONFLICT (delivery_id)` and the `feed_events_apply_delivery_outcome` trigger before switching, since both key on the current single-column PK.
- **`feed_events` has no `ranked_at` column**, so "partition `feed_events` and `feed_delivery_facts` monthly by `ranked_at`" cannot be taken literally. Its time column is `occurred_at`.

Both tables are still small (14 MB and 4.7 MB), so the copy-and-swap itself is seconds — cost was never the obstacle; fit is.

**Daily aggregates are done** — see item 4 above.

---

### F8 — Per-request GoTrue round-trip

**Status:** DONE · **Severity:** Medium · **Surface:** server
**Landed:** `getServerAuthState` verifies locally via `auth.getClaims()`, 2026-08-09.

`getServerAuthState` (`src/lib/supabase-server.ts:81-113`) calls `auth.getUser()` over the network plus a service-role credits read on every authenticated RSC render and API call; middleware does no token work. Verify JWTs locally using Supabase asymmetric signing keys for reads, and keep the hard GoTrue check for sensitive mutations. Colocation makes this a resilience fix more than a latency one.

### Landed 2026-08-09

**No hand-rolled JWT verification was needed — the SDK already does it.** `supabase-js` 2.108.2 ships `auth.getClaims()`, which with asymmetric signing keys verifies the token **locally through WebCrypto against a JWKS it caches**, and only falls back to a `getUser()`-style server call when the project uses a symmetric secret. That fallback is what makes the change safe to ship: if the project were ever moved back to a shared secret, verification degrades to exactly today's round trip rather than silently weakening.

**The premise was verified before building, because it is the kind that quietly fails.** If the project still issued HS256 tokens, `getClaims()` would fall back to a network call and this item would deliver nothing while appearing to — the F5b trap. The JWKS at `/auth/v1/.well-known/jwks.json` publishes **exactly one key, ES256, `use: sig`, and no symmetric (`kty: oct`) key** — in production *and* in the local CLI stack, so local development exercises the same fast path rather than only the fallback.

**The design keeps a security invariant the previous code established.** `getSession()` is a local cookie read with no network, and it carries a full `user` object — but that object is client-controlled and the old implementation deliberately never touched it, a property enforced by a test whose session exposes `get user() { throw }`. Moving verification from GoTrue to a local signature check must not become an excuse to start trusting it, so **the user is rebuilt field by field from verified claims alone**, never spread from the cookie. `created_at` is the one field a JWT does not carry; it is left empty rather than guessed, because no caller reads it and an empty string is visibly absent where a fabricated timestamp would look authoritative. A subject-less token is rejected rather than falling back to the cookie's id — the exact substitution the throwing getter exists to catch.

**"Keep the hard GoTrue check for sensitive mutations" is satisfied structurally, not by a second code path.** The app has **no server actions at all**, and every caller of `getServerAuthState` is a page render or `RouteAuthBoundary` — read paths. Mutations run through API routes using `createUserClient(request)`, which forwards the JWT to Supabase where PostgREST validates the signature itself. There is no mutation trusting this function's output, so there was nothing to carve out.

**Expected shape of the win.** The baseline attributes ~25% of all database time to connection and session overhead, `pgbouncer.get_auth` alone being 15.6% — this removes one auth-server round trip per authenticated render, not that whole figure. The JWKS fetch is per *instance*, not per request; the SDK's own note warns that ephemeral environments (a Lambda destroyed per request) refetch each time, but Vercel Fluid reuses instances, so the amortisation is favourable here. The service-role credits read is untouched and is now the only guaranteed network hop on this path.

---

### F9 — Comments scan loop and unindexed top sort

**Status:** DONE · **Severity:** Medium · **Surface:** server + migration
**Landed:** Viewer block set loaded once, scan capped, `post_comments_toplevel_top_idx` added — 2026-08-09.

`src/lib/post-comments-service.ts:301-345` loops range-reads until enough visible rows accumulate, issuing two `user_blocks` queries per iteration with no iteration cap. The `sort=top` path orders by `reply_count DESC` with no covering index, so it sorts in memory. Hoist the block filter into the query or an RPC, cap iterations, and add a partial index on `(post_id, reply_count DESC, created_at DESC)` for top-level rows.

### Landed 2026-08-09

**The block set is a property of the viewer, not of the batch** — which is why hoisting it works and why the fix is the same inversion F5 applied to the feed. `loadBlockedCreatorIds` issues *two* `user_blocks` queries (blocks are bidirectional), and it was called once per scan iteration inside a `while (true)`. `loadViewerBlockRelationships` now loads the viewer's entire bidirectional list once, so the whole scan costs **two reads however many batches it walks** — pinned by a test that asserts exactly 2 `user_blocks` reads across a multi-batch scan. Its size is bounded by one person's blocking behaviour rather than by how many comments a post has: materialise the small thing.

**A truncated block list falls back rather than filtering wrongly.** Past `VIEWER_BLOCK_RELATIONSHIP_LIMIT` (5,000) the in-memory set would be incomplete, and an incomplete block set **shows a viewer content they blocked** — so that case reverts to the exact per-batch lookup and logs. The fallback flag is tracked explicitly rather than inferred from an empty set, because *empty is the common case* (a viewer who has blocked nobody) and inferring would have put the per-batch queries back on the hot path for almost everyone.

**The cap is a bound, not a truncation.** The scan stops after `POST_COMMENT_MAX_SCAN_ITERATIONS` (10) batches, and when the cap is what stopped it the response reports `hasMore` with the last offset examined — so the client continues rather than being told the conversation ended. A silent stop here would look like a thread that ends early, which is worse than the unbounded walk it replaces.

**`post_comments` had no index reaching `reply_count` at all.** Only `post_comments_toplevel_idx (post_id, created_at DESC) WHERE parent_comment_id IS NULL`, which serves the default recency sort. `post_comments_toplevel_top_idx` covers the full `(post_id, reply_count DESC, created_at DESC, id DESC)` ordering — a partial match on leading columns would still force a sort.

**The index is deliberately not narrowed by status**, and that is the non-obvious part. The listing keeps removed comments that still hold replies (`status = 'active' OR reply_count > 0`) so a conversation does not vanish under a deleted parent. Folding that disjunction into the index predicate would make the index unusable for the half it excluded — Postgres cannot match a partial index against a query predicate broader than its own.

---

### F15b — Error tracking, PITR and log retention

**Status:** BLOCKED — **scoped 2026-08-09; the one code-only item landed under F15a on 2026-08-09, and every remaining item is now an owner action** · **Severity:** Medium · **Surface:** ops

There is no Sentry, PostHog or equivalent anywhere — web, mobile or server. Alerting is an hourly GitHub Actions watchdog email to a single recipient. There is no retained log drain, no PITR, no independent Storage recovery and no defined restore-time objective. Before meaningful paid scale: add error tracking on all three surfaces, five-minute external monitoring, a second incident recipient, retained logs, PITR, media recovery and quarterly restore drills.

Also add a **per-task provider-cost ledger** — the repo records app-credit charges but not Kie credits consumed, effective provider cost, payment fee, or storage/egress allocation per task. Contribution margin per model is unknowable without it, and provider spend is likely the largest total variable cost.

### Scoped 2026-08-09 — what is actually blocking each half

**The per-task provider-cost ledger cannot be populated today, and building the table first would be false progress.** Three inputs were checked and none exists:

- **Kie does not report per-task cost.** The callback payload carries `status` and nothing else the webhook reads; across all 20 files in `model_api_references/` there is no credits-consumed field, no billing endpoint and no account-usage endpoint — only `402 Insufficient account balance` error rows, and prose pointing at `kie.ai/pricing`. This is the same shape as F14's finding that "reconcile against the provider before refunding" was not buildable: the provider simply does not expose it.
- **The model catalog carries no cost field.** Entries have `providerModelMap` and a verification `provider`, nothing priced.
- **The app records only app-credit charges**, which is the sell side, not the buy side.

So the missing piece is **a provider-cost input per model** — someone has to record what each model costs from Kie's pricing page into the catalog, and keep it current. That is an owner/ops data-entry decision, not a schema. Until it exists, a ledger can only restate app credits, which is already known. **Do that first, then the table is trivial.**

### Corrected 2026-08-09 — the input exists, it is just not in the API

The three checks above are each accurate and the conclusion drawn from them was still wrong. "Kie does not report per-task cost" was verified against the **callback payload and the 20 files in `model_api_references/`** — i.e. against the documented API. Nobody looked at the Kie dashboard. It has both halves:

- **`kie.ai/usage` reports actual spend, already broken down per model**, with a date-range picker, a spend/credits toggle, a per-API-key breakdown, and an **Export** button. Read 2026-08-09 for Jul 27 – Aug 9: **total $0.163**, as `nano-banana-2` $0.08 · `gpt-image-2` $0.03 · `seedream-5-lite` $0.028 · `wan27` $0.024 · `chat-gemini-3-flash` $0.001 · `grok-imagine-video` $0 — all on a single key (`ANTIGRAVITY API Key`, last used Aug 7). This is the **buy side**, per model, and it exists today.
- **`kie.ai/pricing` publishes list prices** for all 408 model/modality combinations: credits per generation, our price in USD, the official/Fal price, and the discount. Sampled and verified: `nano-banana-2-lite, 1k` = 4 credits/image = **$0.02**.

**So F15b's ledger is no longer blocked on a non-existent input. It is blocked on wiring an existing one**, which is a much smaller and differently-shaped problem — the same shape as F4's egress, where the number lives in a vendor dashboard rather than in the database.

**But the audit's framing of the input is too simple, and this is the part that would have caused a wrong ledger.** "A per-model provider cost" is not a scalar. Kie prices per model **and modality**, and the billing formula varies:

- video bills **unit price × duration**, and models "with video input" carry a *lower* unit price because the formula becomes `unit × (input + output) duration`;
- resolution is a separate price point (`720p` vs `480p`, `768p` vs `2K`);
- image models price text-to-image, image-to-image, input and output tiers separately;
- some models have per-image surcharges with free allowances (MiniMax H3: first 5 input images free).

A single `cost_usd` column per catalog entry would therefore be **confidently wrong** for every video model. The cost input has to be a per-`providerModelMap`-target rate plus the billing formula, which is exactly the granularity `provider_model_map` already has (`{"text": "...", "image": "...", "reference": "..."}`).

**One cross-check worth keeping:** `generations.model` in production stores a *mix* of app model ids and provider ids (`nano-banana-2` and `wan-2.7-image` alongside `kling-2.6/motion-control` and `bytedance/seedance-2`). Any join on *model name* has to normalise that first — but as it turns out, the ledger does not need to join on model name at all.

### The export settles it — 2026-08-09

The usage export was taken (owner-authorised) for 10 Jul – 9 Aug 2026. **It is per-task, not per-model**, with these columns:

```
API Key | Model | Credits Consumed | Create Time | Task ID
```

`Task ID` is the provider task id — **the same value the app already stores in `generations.prediction_id`**. So the buy side joins to the sell side on a key that exists today, with no schema change and no catalog work. Verified against production over the same window: **26 of 37 generations matched a Kie task by id.**

**Three findings from that join, each of which changes the ledger's design:**

1. **Failed generations cost nothing.** Of 26 matched tasks, **zero** were billed-but-failed; all 11 failed generations are absent from Kie's billing entirely. The "we pay for failures" worry that motivates a lot of margin tracking does not apply here — worth knowing before building anything to measure it.

2. **The 11 Kie tasks with no matching generation are all `gemini-3-flash`** — the prompt-assist path, which writes `ai_usage_events`, not `generations`. **A complete ledger must join both tables**, or it will silently omit every assist call. Cheap in credits (0.05/task) but 30% of task *count*.

3. **App credits charged == Kie credits consumed, 1:1**, on every matched image model — `nano-banana-2` 8/8, `nano-banana-pro` 18/18, `gpt-image-2` 6/6, `grok-imagine-image` 4/4 — with two rounded up (`seedream-5-lite` 6 vs 5.50, `wan-2.7-image` 5 vs 4.80). **1 Kie credit = $0.005 USD**, verified four ways against the pricing page and matching the dashboard's own USD figures exactly (5.50 cr → $0.0275 vs $0.028 shown; 4.80 cr → $0.024 vs $0.024).

**Which means the provider cost is already derivable for most of the existing history**: `provider_cost_usd ≈ generations.cost × $0.005`. The input the audit called non-existent turns out to be *approximately a constant multiple of a column we already store*.

**Do not generalise that to video.** Every model in this window is an image model. Video bills per second, and the app's own charges suggest a different relationship there (`kling-2.6/motion-control` ~81 app credits/run, `bytedance/seedance-2` ~229/run) — none of which appear in this export. **The 1:1 finding is verified for images only**, and a ledger that assumes it holds for video would be wrong in exactly the direction that matters, since video is the expensive half.

**Recommended build order, now that the shape is known:** join `generations.prediction_id` (and the `ai_usage_events` equivalent) to an imported usage export; store `credits_consumed` and a `$0.005` rate rather than a per-model price; and take a second export covering a period with video generations before trusting any video margin.

**Security note from doing this:** the export's `API Key` column contains the **full key in plaintext** (`ANTIGRAVITY (b5b1…6907)`), where the dashboard masks it. Any automation that fetches or stores this file is handling a live credential — treat the file as a secret, and prefer rotating the key after a manual export.

**~~One consequence worth taking:~~ Taken 2026-08-09.** F15a's database-side aggregates were deferred into this item specifically so `backend-cost-report.ts` would not be rewritten twice — "F15b adds a per-task provider-cost ledger to the same file, so building the aggregate layer once, with the ledger's requirements known, avoids rewriting it twice." The ledger is blocked on an input that does not exist, so that coupling dissolved and the aggregate layer was **built on its own and landed under F15a** (`20260809200000`). **Nothing code-shaped remains in F15b.**

### Budget constraint, recorded 2026-08-09 (owner)

> **No additional paid services are possible right now.** Anything that needs a new subscription, a paid add-on or metered third-party spend is **out of scope until that changes** — not deferred on judgement, deferred on budget.

That rules out, explicitly:

| Item | Why it is out | What replaces it for now |
|---|---|---|
| **Retained log drain** | metered per-event spend, plus a destination subscription | Supabase's built-in log retention; accept the window is finite |
| **PITR** | Supabase paid add-on | daily backups only — **so the restore-time objective is "last daily backup", and that should be stated rather than left blank** |
| **Five-minute external monitoring** | paid tier on every provider worth using | the hourly GitHub Actions watchdog already in place, which costs Actions minutes rather than money |

**Error tracking is NOT ruled out** — Sentry and PostHog both have free tiers that cover this traffic comfortably. It needs an account, which only the owner can create.

**One consequence worth stating plainly:** with no PITR and no log drain, the recovery story is *daily backup + finite logs*. That is a legitimate choice at 13 MAU. It is **not** a legitimate choice at the 10,000–25,000 MAU this phase certifies, so it should be revisited as a funded item before that traffic arrives, not after.

**Owner decisions, none of which are code** — each needs an account, a spend approval or a value only the owner has. **This table is the unblock list: supplying these values is what turns F15b from BLOCKED into work.**

| Item | What it needs | Where it goes |
|---|---|---|
| Error tracking | **PARTLY DONE 2026-08-09** — org created by the owner, projects `magicbooklet-web` and `magicbooklet-mobile` created, **browser error tracking shipped** with the DSN set on Vercel production. **Server-side is blocked by `build:verify`** and **mobile is unwired** — both below | — |
| ~~Five-minute external monitoring~~ | **OUT OF SCOPE — paid.** The hourly watchdog stands in | — |
| ~~Second incident recipient~~ | **DONE 2026-08-09** — `magicbooklet` (info@magicbooklet.com) invited as a collaborator, and the watchdog now opens an **incident issue** on failure, which is the only channel that actually reaches a second person. See below | `backend-alert-watchdog.yml` |
| ~~Retained log drain~~ | **OUT OF SCOPE — paid** | — |
| ~~PITR~~ | **OUT OF SCOPE — paid.** Record the RTO as "last daily backup" instead of leaving it undefined | — |
| Media recovery + quarterly restore drills | an ops **process decision** | a runbook in `docs/` |
| F4's egress automation | a Management API token with **usage scope** | the watchdog workflow |
| Per-task provider-cost ledger | **UNBLOCKED 2026-08-09** — the input exists at `kie.ai/usage` (actual per-model spend + Export) and `kie.ai/pricing` (list prices). Needs a **CSV export** and a rate-vs-formula decision per modality, not a missing input | catalog manifest via the guarded release workflow, then the ledger table |
| ~~`track_io_timing`~~ | **DONE 2026-08-09** — `ALTER ROLE` on `postgres` *and* `authenticator`; verified collecting. See below | — |

**~~Two~~ One of these is a certification prerequisite, not a nice-to-have:** the second incident recipient, because a one-hour soak with a single alert address has a single point of failure. `track_io_timing` was the other and is now done.

#### Error tracking — what shipped, and the two halves that did not

**Shipped:** browser error capture via `@sentry/nextjs` 10.69.0 (`src/instrumentation-client.ts` + `src/lib/sentry-config.ts`), DSN on Vercel production, and the Sentry ingest origin added to the report-only CSP's `connect-src` — **derived from the DSN**, so repointing the org cannot leave the CSP behind and quietly fill `/api/security/csp-report` with violations that look like a real finding.

Three settings were chosen rather than defaulted: `tracesSampleRate: 0` (this item is error tracking; APM on a free tier would burn the quota on feed request volume before producing signal, and latency is already measured from `pg_stat_statements`), session replay off (paid at any useful volume — see the budget constraint), and `sendDefaultPii: false` stated explicitly, because request bodies here carry prompts, media URLs and payment payloads.

**A missing DSN disables Sentry rather than failing the build** — local checkouts and CI must not need an external account — **but production warns loudly at startup**, because "instrumented and reporting nothing" is the same silent optimism F15a spent its whole item removing. `src/__tests__/sentry-config.test.ts` pins that, including the empty-string case, which is the usual shape of "someone added the key to Vercel and never pasted the value".

**And the first deploy of it was silently broken, which is worth recording in full because the mechanism is not obvious.** `12107cf` shipped, the buildId matched, the CSP carried the Sentry ingest origin — every signal said configured — and **no Sentry client existed on the page**. Cause: Next inlines `NEXT_PUBLIC_*` into the client bundle by **substituting the literal text** `process.env.NEXT_PUBLIC_SENTRY_DSN`. The config module read it as `environment.NEXT_PUBLIC_SENTRY_DSN`, where `environment` merely *defaulted* to `process.env`, so the literal never appeared, no substitution happened, and `process.env` is an empty shim in the browser.

The CSP still contained the ingest origin because `next.config.ts` runs in Node at build time, where `process.env` is real — **so the one signal that looked like proof of correct wiring was produced by a completely different mechanism from the one that was broken.**

It was silent twice: `resolveSentryEnvironment` had the identical flaw, so it read `'unknown'` instead of `'production'` and the "error tracking is OFF" warning never fired. **Only loading the deployed page and finding no Sentry client caught it** — not the build, not the tests, not the CSP header, not a green pipeline.

Fixed by snapshotting each variable through a direct `process.env.X` member expression (`BUILD_ENVIRONMENT`), verified by building with a DSN and grepping the emitted client chunk for it, and guarded by a test that asserts the source shape, since no unit test can observe bundler substitution.

**Verified end-to-end on `0f39cd5`, not merely re-deployed.** The live page's Sentry client reports `dsn` on the right host, `environment: "production"` (so `NEXT_PUBLIC_VERCEL_ENV` inlines too), `tracesSampleRate: 0`, `sendDefaultPii: false`, `replaysSessionSampleRate: 0` — every setting chosen above, confirmed on the deployed bundle rather than in source. A deliberate test exception then arrived in the issue stream as `MAGICBOOKLET-WEB-1` at Priority High, which exercises the alert path as well as ingestion. **The lesson to keep: for anything whose whole job is to report, the deploy is not the verification — an event arriving is.**

**~~NOT shipped #1~~ — server-side capture: UNBLOCKED AND SHIPPED 2026-08-09, by narrowing the guard rather than relaxing it.**

Initialising Sentry on the server needs a root `instrumentation.ts`. Adding one makes Next emit an edge-wrapper chunk containing Turbopack's own path helper:

```js
U.P = function(e) { return `/ROOT/${e ?? ""}` }
```

`scripts/check-ffmpeg-build-artifact.mjs` flags every `/ROOT/` literal outside `/ROOT/node_modules/next/dist`, so this bare template prefix trips it and `npm run build:verify` fails. **That guard exists because bundling `ffmpeg-static` inlined `/ROOT/node_modules/ffmpeg-static` and broke every rendition in production**, so it is not something to widen casually.

Attributed by elimination rather than guessed:

| Files present | `build:verify` |
|---|---|
| none | passes |
| `instrumentation-client.ts` only | passes |
| `instrumentation.ts` present | **fails** |

**The blocker is `instrumentation.ts` existing at all — not Sentry.** With it present, Sentry *also* inlined `/ROOT/node_modules/@sentry/...` into the server chunks and dragged its bundler-plugin machinery in behind the package index; that half is already solved and the `@sentry/*` entries in `serverExternalPackages` are left in place for when this lands. Making the SDK import lazy and node-runtime-only did **not** clear the edge wrapper, because the chunk is emitted by the instrumentation hook itself.

**Resolved by narrowing, and the distinction matters.** `ALLOWED_INLINED_ROOT_PATH_PATTERN` now also accepts a **bare `/ROOT/` with an empty tail** — not "any `/ROOT/`". The guard's own comment states its purpose: block dependency paths that reach the filesystem, tolerate Next's own inlining. A prefix with nothing after it names no dependency and cannot reach anything; the bug this check exists for was `/ROOT/node_modules/ffmpeg-static`, **which has a tail and is still flagged**. Two regression tests pin exactly that — one asserting the Turbopack constructor is ignored, one asserting `ffmpeg-static` and a `sharp` native path are still caught even with the new allowance in the same source.

Server-side capture now ships: `src/instrumentation.ts` initialises on the Node runtime and registers `onRequestError`, so App Router errors reach Sentry instead of being swallowed by the framework's own boundary.

**Still node-only, deliberately.** `instrumentation.ts` is loaded by the edge runtime too, and middleware runs on *every* request — `src/proxy.ts` is thin by design and an APM SDK is not proportionate on that path. So **middleware errors remain uncaptured**; server components, route handlers and the browser are covered.

**One honest gap in the verification:** the browser half was proven by an event arriving in the issue stream. The server half is proven *wired and deployed* — bundled, `onRequestError` registered, sharing the same config module whose inlining bug is fixed (and on the server `process.env` is real regardless) — but **no server event has been forced**, so it is not proven by arrival the way the browser half is. The first genuine server error will confirm it.

**NOT shipped #2 — source maps.** `withSentryConfig` uploads them, needs a `SENTRY_AUTH_TOKEN` (a real secret, owner-only), and rewrites the bundler config that `outputFileTracingIncludes` uses for `ffmpeg-static` — the same thing `build:verify` guards. **Until it lands, stack traces arrive minified.**

**NOT shipped #3 — mobile.** `magicbooklet-mobile` exists with its own DSN, but `@sentry/react-native` is unwired. Mobile ships on the store-release train (a manual dispatch plus review, multi-week), so nothing wired today reaches a phone this month; and the Expo config plugin changes `expo prebuild`, which CI runs. Worth doing as its own change with its own mobile-CI verification, per this document's "start mobile items first even though they land last".

#### The second recipient is not a config value — checked 2026-08-09

The item reads as "supply a second email address", and it is not that. **`backend-alert-watchdog.yml` has no recipient list at all.** Its own header says so: *"A failing run sends the repo owner GitHub's standard workflow-failure email, which is the alert channel: no third-party monitoring service and no paid add-on involved."* The alert channel is GitHub's built-in notification, which routes to **GitHub accounts**, not to arbitrary addresses. There is nowhere in the repo to put a second address.

### Resolved 2026-08-09 — and the obvious fix would not have worked

The address is `info@magicbooklet.com`, on a second GitHub account (`magicbooklet`), invited as a collaborator. **That alone does not deliver the alert**, which is the part worth recording:

> **GitHub sends *scheduled*-workflow failure notifications to exactly one person — whoever last edited the cron expression.** Not to collaborators, not to watchers, not to other verified addresses on the account.

So "add a second email" and even "add a second collaborator" both look like they solve this item and do not. The two routes that were previously written here — adding a verified address, or adding a second user — are both subject to that rule.

**What actually works, and costs nothing:** the watchdog now **opens a GitHub issue on failure**, which notifies every watcher of the repository. It reuses one open issue rather than filing hourly duplicates, and **closes it on recovery**, so the issue list reads as current state rather than as a log. A mail service would be the alternative and is ruled out by the budget constraint above.

**Verified by drill, not by reading the YAML** — and the first attempt was broken, which is the point of drilling. `PRODUCTION_BASE_URL` was pointed at a 404 path, the workflow dispatched, and the whole lifecycle exercised:

| Drill step | Result |
|---|---|
| Probe fails → issue opened | `#45`, and **no ops payload in the body** |
| Probe fails again → dedup | commented on `#45`, no duplicate filed |
| Probe succeeds → recovery | `#45` closed with a recovery comment |

The variable was restored to `https://magicbooklet.com` afterwards.

**The first drill failed on the alerting step itself**: `gh` died with *"not a git repository"*, because this job deliberately runs **without `actions/checkout`** to keep each billed run short, so `gh` had no remote to infer the repository from. Fixed with `GH_REPO` rather than by adding a checkout, which would have put a clone on every hourly run. Had this not been drilled, the watchdog would have kept passing while its alert channel was dead — an alerting system that only fails when you need it.

**Remaining owner step:** `magicbooklet` must accept the collaborator invite and **watch the repository** (All Activity, or Custom → Issues). Without that, the issue is created and notifies nobody new — the channel exists but the second recipient is not yet on it.

### A public-repository exposure, found while doing this

`112kratoss/ugc-copy` is **public**, and **Actions run logs and step summaries on a public repository are world-readable**. The watchdog was writing up to 4,000 characters of the `/api/ops/backend-alerts` response body into `$GITHUB_STEP_SUMMARY` **every hour** — an endpoint deliberately protected by `OPS_READ_SECRET`, publishing queue depths, failure counts, provider health and degraded-subsystem names to anyone.

The body is no longer printed, in the summary, the log, or the issue. The HTTP status and the `::error` annotation still say which category of failure occurred, which is what an alert needs; the body is read from the authenticated ops dashboard.

**The general point, which outlives this one workflow:** on a public repository, anything a workflow echoes is publication. The owner intends to make the repository private after development, which closes this — but until then, treat every `run:` block as a public surface.

**~~`track_io_timing` is an owner action too, and cannot be done from SQL here.~~ WRONG — corrected and DONE 2026-08-09. It was the wrong statement, not the wrong permission.**

The original attempt was `ALTER DATABASE postgres SET track_io_timing = on`, which silently did nothing and left no `pg_db_role_setting` row. The conclusion drawn — that the GUC's `superuser` context puts it out of reach from SQL — was half right and led to a dead end: the dashboard has **no Postgres configuration editor at all** (Database → Settings carries only password, pooling, SSL, disk, network restrictions and connection logging), so the prescribed remedy did not exist either.

**Supabase's own documentation gives the actual mechanism**: `track_io_timing` is one of the *reserved* configurations that `supautils` lets the `postgres` role modify — **at the `role` level, not the database level**.

```sql
alter role "postgres"      set "track_io_timing" to 'on';
alter role "authenticator" set "track_io_timing" to 'on';
```

**Both roles, and the second one is the point.** Verified on the local stack first: role-level GUCs are applied **at login**, and `SET ROLE` does not re-apply them — `authenticated`'s own `statement_timeout=8s` reads as `0` after `SET ROLE authenticated`, while the login role's `track_io_timing` stays `on`. PostgREST logs in as `authenticator` and then `SET ROLE`s, so **setting this on `postgres` alone would have covered ops and migration traffic and missed every application query in the load test** — the failure mode being a certification run that looks instrumented and silently is not.

**Applied to production 2026-08-09 and confirmed collecting**, which matters because "configured" and "collecting" are different claims:

```
explain (analyze, buffers) select g from generate_series(1,500000) g order by g desc;
  Sort Method: external merge  Disk: 5888kB
  Buffers: shared hit=3, temp read=1591 written=1596
  I/O Timings: temp read=3.481 write=9.957      <-- this line did not exist before
```

The `I/O Timings` line is absent entirely when the setting is off. Incidentally it also demonstrates the `work_mem` 2.1 MB spill the entry baseline warned about, now measurable.

**Revert if it ever proves costly:** `alter role "postgres" reset "track_io_timing";` and the same for `authenticator`. No restart is involved either way; it takes effect on new connections, so existing pooled backends pick it up as they recycle.

**Still worth doing alongside it:** `log_temp_files` is `-1`, so spills stay invisible in logs precisely when they start mattering. It is a `superuser`-context GUC in the same reserved list and takes the same `ALTER ROLE` treatment.

---

### Phase 1 certification test

**Status:** TODO — **Phase 1's code tail is complete as of 2026-08-09; the remaining prerequisites are not code**

**Entry check, recorded 2026-08-09 when the code tail closed.** Every Phase 1 scaling item that could be executed in code has landed: F5, F5b, F7b, F8, F9, F14 and F15a's aggregate layer are DONE. Two things are deliberately **not** blockers, and two things **are**.

**Not blockers, and why:**

- **F12 stays IN PROGRESS by design.** Idempotent run creation, the durable step queue, cron recovery and the pure GET all landed; the per-node executor is a recorded deferral, not an unfinished prerequisite. The durability properties the certification test exercises are the ones that shipped.
- **F10 stays IN PROGRESS by design** — two unassigned web-perf leftovers carried past Phase 0 on this document's own instruction.

**Actual blockers:**

1. ~~**`track_io_timing` must be ON before the run.**~~ **Done 2026-08-09** — set on `postgres` *and* `authenticator` and verified collecting (F15b carries the mechanism and the reason the first attempt failed). Setting it on `postgres` alone would have instrumented ops traffic and missed every PostgREST query, so check both roles still carry it immediately before the run.
2. **A second incident recipient** — still open. A one-hour soak whose only alert path is a single email address has a single point of failure in exactly the window it matters. This is the last owner action gating the run.

**Two more worth setting up first, though the test can run without them:** `log_temp_files` is `-1`, so spills stay invisible in logs precisely when `work_mem` at 2.1 MB starts spilling — same reserved-GUC list, same `ALTER ROLE` fix; and error tracking on all three surfaces would turn "error rate below 1%" from a count into something diagnosable.

**One measurement debt this creates.** `track_io_timing` was off for the whole entry baseline, so certification produces IO-latency numbers with **no "before" to compare them to**. Take a short idle sample after the next deploy and before the run, or the IO figures will be uninterpretable in isolation.

**Read the pool criterion against its floor.** "Connection pool below 70%" sits on a **47% idle floor** (28 of 60 client backends at 13 MAU), so the real budget for request-serving connections is ~14, not ~42 — see *Phase 1 entry baseline*.

Certification, not a smoke test. Use a production-shaped isolated environment with 10k/100k/1M-row fixtures and stepped runs at 5, 10, 25, 50 and 100 origin RPS. Must include: authenticated `for-you` feed **with cursor continuation**, batched feed events, saves/follows/comments/publishing, upload sign and finalize, generation quote and start against a provider stub, webhook bursts and completion draining, workflow fan-out, realistic image and video ingest, and cron overlap with retention cleanup.

Certify only a level that survives a **one-hour soak** with: error rate below 1%; route P95 within SLO; DB CPU and connection pool below 70%; no growing lock or retention backlog; queue age below twice its cadence; provider 429/5xx below 1–2%; no duplicate or orphaned paid generations; and at least 30% remaining headroom.

---

## Phase 2 — when growth demands it

**Trigger:** ~25,000 MAU, or cached-egress overage past ~$100/month.

- CDN offload for `showcase_media` to a dedicated media CDN (Cloudflare R2, Bunny) behind e.g. `media.magicbooklet.com`, with purge/indirection for moderation takedowns.
- Adaptive delivery — 360p/720p/1080p variants with HLS or DASH; original quality only as an explicit download action; lifecycle rules retiring unused originals after 30–90 days.
- Partition all high-volume telemetry; incremental aggregates with dirty-ID queues.
- Edge/KV rate limiting for feed reads and analytics; keep Postgres limits for money paths.
- Keyset pagination across large owner and catalog lists.
- Read replicas or materialized views where measured query load warrants them.
- Multi-provider AI failover and model-level budgets.
- Regional recovery strategy and storage replication.
- Second moderation operator plus triage tooling — `/admin` is deliberately a single master operator today (`src/lib/admin-identity.ts` isolates identity resolution for exactly this change). At community scale the human queue binds before Postgres does.

---

## Cost curve

| Scale | Unfixed | After Phase 0–1 |
|---|---|---|
| 13 MAU (today) | ~$45–50/mo | same |
| 2,000 MAU | cap on: degradation mid-month · cap off: ~$80–150/mo and 23 Mbps playback | ~$60–90/mo |
| 10,000 MAU | ~$500–1,500/mo, egress-dominated | ~$150–350/mo |

Excludes Kie.ai generation spend, which is credit-funded and scales with revenue rather than audience. Video delivery is the largest pure-infrastructure cost either way.

---

## Reconciliation notes

Two independent audits produced different headline numbers. Both were right about different questions; recording why, so the numbers are not re-litigated.

- **"~350 MAU" vs "2,000–5,000 MAU"** — the second figure silently assumes the media fixes have shipped. It models egress at rendition bitrate (~105 MB/user/month), which describes the app *after* F1. Today the watch surfaces stream full sources, so the real figure is ~0.5–0.7 GB/MAU.
- **"Overage is available rather than a hard shutdown"** — only true with the spend cap off. Pro defaults it on. This is F4 and it is the most consequential unknown in both audits.
- **The 5,000 MAU gate is sound.** The prune arithmetic (5,000 facts/hour, 60 facts/session, 400-day retention) was verified independently and reaches the same structural conclusion as the `feed_events` trigger analysis.
- **The 100,000 Auth MAU entitlement is not a capacity claim.** It appears in Supabase's pricing as a billing allowance only.
- Claims verified line-by-line before adoption: F11 (cursor), F12 (workflow durability), F13 (v2 starvation), F14 (shared-fate cron), F15a (monitoring bias). Each carries its evidence above.

---

## Open decisions

| # | Decision | Owner | Needed by | Answer |
|---|---|---|---|---|
| 1 | Spend cap: on (outage risk) or off (bill risk) | owner | immediately | **ON, and staying on** — 2026-08-08. Outage risk accepted over bill risk; consequences in F4. |
| 2 | Raw feed-fact retention: 30 or 90 days | owner | before F7a (F11 does not need it) | **30 days** — 2026-08-08. Owner delegated the call; rationale in F7a. |
| 3 | Confirm Vercel plan is Pro (10-min cron implies it) | — | before F14 | **Pro (`planIteration: plus`), active** — 2026-08-08. Read from the Vercel API team billing record, not inferred from the cron cadence. F14 may assume Pro limits. |
| 4 | Confirm Supabase compute tier and capture CPU/IO/pool baselines | — | before Phase 1 | **Micro, confirmed by memory fingerprint** — 2026-08-08. Full CPU/IO/pool baseline recorded in *Phase 1 entry baseline* above. Headlines: pool floor 47% at idle, `track_io_timing` off so no IO-latency baseline exists, and the top RPC by total time is `list_marketplace_resource_bundles` (47% of RPC time) which this audit never listed → new item **F5b**. |
| 5 | Derivative cache TTL: 1-day compromise vs 1-year immutable — a takedown-exposure trade, see F3's constraint note | owner | before F3 | **1-day compromise** — 2026-08-08. Lands as `max-age=86400`; see F3 for why `stale-while-revalidate` could not come with it. |

---

## Change log

| Date | Change | By |
|---|---|---|
| 2026-08-08 | Initial audit; all items TODO. Baseline commit `63b9a3b`. | Claude Code |
| 2026-08-08 | Pre-work review amendments: F3 reframed against the documented moderation TTL constraint (new decision #5); every-push-deploys warning added; mobile items consolidated onto the store-release train; workflow rewritten for one-conversation-per-phase sequential execution (no worktrees); evidence re-verified at `8a69de5`. | Claude Code |
| 2026-08-08 | Decisions recorded: #1 spend cap **ON and staying on** (owner), #5 derivative TTL **1-day compromise** (owner), #2 raw fact retention **30 days** (owner delegated the call). Work package 1 landed — F1 mobile viewer, F3 mobile upload header, F10 mobile 404 fallback. Corrections to the audit as written: no mutable/immutable TTL split is needed because every public showcase path is write-once; `stale-while-revalidate` is unreachable through supabase-js; the `.copy()` cache-control inheritance lives in `post-publish-service`/`post-update-service`, not `showcase-publish-service`; and the mobile viewer had two full-source paths, not the one cited. | Claude Code |
| 2026-08-08 | **F11 DONE** (ranked feed continues by cursor; three call sites needed it, the `sessionStorage` snapshot being the subtle one). **F13 DONE** (v2 refreshes ported to v1's staleness-ordered candidate selection — the v1 audit this called for found v1 was already correct and v2 had regressed it — plus the missing `feed_delivery_facts` index). | Claude Code |
| 2026-08-08 | **F3 reopened by Phase 0 review and re-closed.** Ranged GETs hold separate edge entries the backfill never purged; `--verify` now probes both shapes and found 92/99 ranged answers stale (60 at a year). Systematic invalidation attempts: rewrite does nothing, TTLs are not honored, delete gates but does not evict — re-uploading resurrects the old variant, so the built remediation was removed as proven ineffective. Takedown enforcement verified intact with a scratch-object delete test (~30s to stop serving, both shapes). Residual — up to a year of browser-side replay on 60 pre-existing objects' ranged fetches — recorded and accepted, with path rotation named as the escape hatch. | Claude Code |
| 2026-08-08 | **Phase 0 wrap-up verification.** Every board row re-verified against the code and git log by a scripted pass — 29/29 checks green across F4, F1, F2, F3, F11, F13, F7a, F6, F15a and F10, with all 12 Phase 0 commits (`073bcbf..9df61dc`) accounted for. Full gate re-run at the wrap-up commit: web tests, lint, all three typechecks, mobile tests and typecheck, `npm run build`, `npm run build:verify`. Deploy promotion confirmed by matching the live `/api/app-version` buildId to HEAD. Phase 0 exits with F10's two web-perf leftovers unassigned (this document's own instruction) and three recorded deferrals: F7a's single-transaction insert → F7b, F15a's aggregate layer and F4's egress automation → F15b, F13's seed-1,000 disjointness check → gate before promoting v2. | Claude Code |
| 2026-08-08 | **Phase 0 closed.** F6 DONE — the filtered top-sales scan is gone: unlock filter moved into `list_showcase_top_sales_post_ids` (four-param signature dropped to avoid PostgREST overload ambiguity), resource-kind filtering stays in JS but streams the RPC's sales-ordered ids and stops at a page, since order-before-filter is what made early termination correct. F15a DONE — provider attempt counters (hourly buckets, PK upsert, fire-and-forget) give `failedCount/recentAttempts` a real denominator, null-not-zero when the table is absent; health collectors now probe-and-flag truncation like the cost report; the DB-side aggregate layer is deferred into F15b with recorded reasoning. F4 DONE — egress turns out not to exist in the database at all, so the documented weekly dashboard read is the mechanism and automation moved to F15b. F10's two web-perf leftovers stay unassigned per this document's own assignment. | Claude Code |
| 2026-08-08 | **F7a DONE** — delivery facts now only for the served slice, and feed telemetry batched into one request per flush. Batching every event type was a regression: `not_interested` restores an optimistically hidden post when its request fails, so only telemetry is queued and state-changing events stay synchronous. **F15a partly done** — truncation is now explicit via an overflow probe rather than a costly COUNT, and the exception-biased provider population is labelled instead of divided by. F15a's aggregates, attempt counter and health collectors remain, and **F4's egress metric is blocked: egress is not in the database at all**, so it needs Supabase's billing surface rather than another collector. | Claude Code |
| 2026-08-08 | **F3 DONE.** `backfill:showcase-media-cache` re-wrote all 99 objects through the Storage API; `--verify` confirms 99/99 now serve `public, max-age=86400`. The SDK-write diagnosis was right, but invalidation lags a write by ~60s, so the first canary looked like a second failure — the canary is what kept that from being misread across the whole bucket. Also corrects the transfer estimate: 148.6 MB in `showcase_media`, ~297 MB round trip, not the ~615 MB quoted earlier (that was every bucket). | Claude Code |
| 2026-08-08 | **F3 reopened after post-deploy verification.** The metadata backfill applied — all 99 objects read `max-age=86400` in `storage.objects` — but every object still *serves* its old header, and neither `no-cache` nor a novel query string can force revalidation. Supabase's Smart CDN only purges an edge entry when the object is written through the Storage API, so a SQL metadata update is invisible to it. The audit's original "hang it off the `backfill:*` scripts" instruction was right for a reason this document had dismissed: re-writing through the SDK is not a slower way to set metadata, it is the only way to invalidate the cache. Needs a `backfill:showcase-media-cache` script. | Claude Code |
| 2026-08-08 | Work package 3, part one — **F2 DONE** (publish-time repair kick; sweep bounded by a 60s wall clock rather than a five-row count, which bounded nothing: five rows at a 120s ffmpeg timeout could occupy 600s of a 300s invocation). **F6 partly done** — read limits on all five cited GETs; the `top-sales` precompute is still open, so F6 stays IN PROGRESS. **F10 webhook budget DONE** — `/api/webhooks/kie` was the only media route left at `maxDuration = 60` while its own download timeout was also 60s. | Claude Code |
| 2026-08-08 | Work package 2 landed — F1 web (carousel every mode, profile hover video), F3 server constants plus a backfill migration over `storage.objects`, F10 studio grid and unoptimized images. **F1 and F3 are now DONE.** Material correction from measuring production: `showcase_media` held three generations of cache policy, not the single 300s the finding described — 60 content-hashed derivatives at a **full year**, 29 originals at supabase-js's default 3600, and only 10 at 300s. The repo had immutable derivative caching until 2026-07-29 and gave it up for moderation, so decision #5 was really about how much of that year to restore, and the backfill moves 60 objects *down* (a live takedown exposure) as well as 39 up. | Claude Code |
| 2026-08-09 | **F8 DONE — the auth round trip is gone, and no JWT code was written.** `supabase-js` 2.108.2 already ships `auth.getClaims()`, which verifies locally through WebCrypto against a cached JWKS when the project uses asymmetric signing keys, and falls back to a `getUser()`-style server call when it does not — so the degradation path is exactly today's behaviour rather than a silent weakening. **The premise was verified before building**, because this is precisely the kind that fails quietly: had the project still issued HS256 tokens, `getClaims()` would have fallen back to the network and the item would have delivered nothing while looking finished (the F5b trap). The JWKS publishes **one key, ES256, and no symmetric key** — in production *and* in the local CLI stack, so local development exercises the same fast path. **A security invariant was kept rather than traded away:** `getSession()` is a local cookie read carrying a client-controlled `user` object, and the old code deliberately never touched it — enforced by a test whose session exposes `get user() { throw }`. The replacement rebuilds the user **field by field from verified claims only**, never spreading the cookie, rejects a subject-less token instead of falling back to the cookie's id, and leaves `created_at` empty rather than fabricating the one field a JWT does not carry. **"Keep the hard check for sensitive mutations" turned out to need no carve-out:** the app has **no server actions**, every caller is a page render or route auth boundary, and mutations go through API routes where PostgREST validates the forwarded JWT itself. Expected win stated honestly — one auth-server round trip per authenticated render, not the baseline's whole 25% session overhead, and the JWKS fetch is per instance (favourable on Fluid, unlike an ephemeral Lambda). Gates: 3,921 tests, lint, three typechecks, build, build:verify. | Claude Code |
| 2026-08-09 | **Incident resolved and verified.** `feed-maintenance` **succeeded at 05:20:30 UTC** after failing at 02:20, 03:20 and 04:20; production is on `a9dd98f`; the clamp is live; `feed_delivery_fact_daily` holds **11 buckets**, so the rollup works end to end; and `feed_delivery_facts` is 14,995 rows with the oldest still 2026-07-28 — **nothing was over-deleted**, which is the clamp's upward direction behaving as intended. **The deadlock broke because migrations apply before the verify step**, so the clamp reached the database during a release whose promotion was still blocked; the next cron tick then succeeded, health cleared, and the same release promoted. Worth keeping as the recovery pattern: when the gate is blocking on production health, the migration channel is still open, and a database-side fix that makes the *currently deployed* code healthy is what unblocks the code fix. Verification was deliberately the **job run**, not the green deploy — the deploy that caused the incident was also green. | Claude Code |
| 2026-08-09 | **F15a's aggregate layer landed — and the raw-row path was kept, which is the whole point.** `20260809200000_backend_cost_aggregates.sql` adds `get_backend_cost_aggregates`, one RPC returning grouped arithmetic for all five cost sources, so the report reads the whole window instead of the first 5,000 rows per source. The pre-existing JS builders **stay live as the fallback** for a database without the migration, which is what stops the change doing the harm this item warned about — "done carelessly the change *reduces* coverage of the logic while fixing a truncation that is not occurring." The prescribed guard was built as a real differential rather than two independent sets of expectations: pgTAP (16 assertions) pins raw rows → aggregate payload, and a vitest test pins aggregate payload → report **==** raw rows → report, with the payload being the **verbatim output of the function** run against a Postgres seeded with exactly the rows the same file feeds the raw path. **Faithfulness beat tidiness in four places**, each of which would otherwise have been a silent behaviour change: `coalesce(x,'unknown')` catches null but not `''` (matching JS `??`); `output_url` counts only when non-empty and is deliberately not trimmed (JS truthiness — `' '` is truthy); a null `outcome` counts as a failure; and the failure/timeout breakdowns must **omit** zero-count keys, because `count(*) FILTER (...)` grouped by service would emit `{"razorpay": 0}` where the JS emits nothing. **A hazard that turned out not to exist, recorded so nobody re-derives it:** the JS rounds after every addition while SQL sums then rounds once — divergent on fractional values, but every column involved is `integer`, so they cannot differ. **Policy deliberately did not move into SQL**: the function returns `byScope` and the media-read scope set stays in TypeScript, asserted by the migration test. **No alert fires when the function is missing** — the fallback is exact unless it truncates, so `sampling.mode` carries the state as data and truncation stays the only alarm. **Verified through the built artifact**, per this document's own post-F7b rule: `npm start` against the local stack returned `mode: "aggregate"` and reproduced every asserted figure, and the same build against production (no migration) returned a complete report in `raw-rows` mode, so the fallback is exercised rather than merely present. **Residual sized, not waved at:** `backend-health.ts` still samples (1,000/500/200/100/25 caps); that was never inside the deferred item, and its three 1,000-capped sources measure 0 rows/24h. Gates: 3,960 tests, lint, three typechecks, build, build:verify, clean `db reset --local`, 619 pgTAP. | Claude Code |
| 2026-08-09 | **F5b DONE — the catalog-scale restructure landed, and the first design of it broke moderation.** `20260809210000_marketplace_bundle_listings` adds a derived table carrying the precomputed listing gate, the sort keys and the filter flags, maintained by trigger; the listing function filters and sorts entirely on it and fetches the wide bundle row by primary key for the page only. Three O(catalog) costs leave the default path: the per-row `plpgsql` quality predicate, five per-row jsonb containment predicates, and a `CASE WHEN p_sort = …` ordering no index can serve. **Measured by growing a seeded catalog at a fixed page size of 24** (never by deleting down — a mass delete leaves dead index entries, and a "smaller" catalog measured that way reads *slower* than a larger one, which inverted the comparison until it was caught): 1,000 / 5,000 / 20,000 / 80,000 bundles give old **2,625 → 13,021 → 84,973 → 408,080** buffers against new **99 → 99 → 106 → 134**. The old path grew **155×**, the new one **35%**; at 80,000 bundles a default page is **3,045× fewer buffers and ~31,000× faster** (6,651 ms → 0.21 ms). Output verified identical to the pre-change function across **34 parameter combinations** at three catalog sizes — and two resource filters initially compared *vacuously* because the seed created no workflow or file bundles, so the seed was widened until they returned real pages. **The finding that changed the design:** a `marketplace_listable` column on `post_resource_bundles` was built first and **taking a post down failed outright** — that table carries six triggers written for user edits, and `validate_post_resource_bundle_write()` raises "Only public posts can publish resource bundles", so the recompute during a take-down raised. Not a stale listing: a moderation action that errors. It surfaced only from seeding the test catalog; every unit gate was green. The existing `sync_sold_post_resource_bundle_visibility()` avoids this only by setting `status = 'draft'`, and only for sold bundles. **Three more:** it is triggers on **three** tables, not the two the audit predicted, because the quality predicate also reads `profiles.username`/`display_name`; the trigger WHEN clauses are load-bearing in both directions (narrow → taken-down content stays listed, `OLD.* IS DISTINCT FROM NEW.*` → a quality predicate on every comment and every credit charge), so both are explicit column lists with a migration test on the post list and a pgTAP `xmin` assertion that a comment-count update does not touch the listing row; and **search was made worse before better** — a correlated `EXISTS` kept one query shape but ran per candidate row and regressed search from 89,390 to **136,937** buffers, fixed to 2,096 by composing a real join into the search branch only. **Residual:** search is 21× cheaper but still O(catalog) and uncached by design; a trigram or FTS index is its own item before certification. **Also outstanding:** `get_advisors` after deploy, per the standing rule — not runnable here because this is not deployed. Gates: 3,960 tests, lint, three typechecks, build, build:verify, clean `db reset --local`, 619 pgTAP. | Claude Code |
| 2026-08-09 | **Two F15b blockers dissolved, and F4 got its first real measurement — all three by looking at a surface nobody had opened.** **`track_io_timing` is ON.** The recorded conclusion — `superuser` context, therefore dashboard-only — was drawn from a failed `ALTER DATABASE postgres SET track_io_timing = on`, and it sent the item to a remedy that does not exist: Database → Settings has **no Postgres configuration editor at all** (password, pooling, SSL, disk, network restrictions, connection logging — that is the whole page). Supabase's own docs give the actual mechanism: `track_io_timing` is a *reserved* config that `supautils` lets the `postgres` role set **at the role level**. Applied as `alter role "postgres"` **and** `alter role "authenticator"` — and the second one is the point: role GUCs apply **at login** and `SET ROLE` does not re-apply them (verified locally — `authenticated`'s own `statement_timeout` reads 0 after `SET ROLE`, while the login role's setting persists), so PostgREST traffic is covered only via `authenticator`. Setting just `postgres` would have instrumented ops and migrations and **silently missed every application query in the certification run**. Confirmed *collecting*, not merely configured: an `EXPLAIN (ANALYZE, BUFFERS)` now emits `I/O Timings: temp read=3.481 write=9.957`, a line that is absent entirely when the setting is off — and which incidentally makes the entry baseline's `work_mem` 2.1 MB spill warning measurable. Reversible with `alter role … reset`, no restart. **The provider-cost ledger is no longer blocked on a non-existent input.** The three checks behind that verdict were accurate but all aimed at the documented API — callback payload and the 20 `model_api_references/` files. The Kie **dashboard** has both halves: `kie.ai/usage` reports **actual spend already broken down per model** (Jul 27–Aug 9: $0.163 total — `nano-banana-2` $0.08, `gpt-image-2` $0.03, `seedream-5-lite` $0.028, `wan27` $0.024 — with a date picker, per-key breakdown and an **Export**), and `kie.ai/pricing` publishes all 408 model/modality list prices. **The audit's framing of the input was also too simple:** Kie prices per model *and modality*, video bills `unit × duration` with a **lower** unit price when there is video input (the formula becomes input+output duration), resolution is its own price point, and some models have free allowances — so a single `cost_usd` per catalog entry would be confidently wrong for every video model. Prices were deliberately **not** scraped in: mis-mapping ~50 provider ids across a 17-page virtualised table is how a wrong number reaches a money path, the catalog is a guarded control plane, and Export is a file download needing the owner. Also found: `generations.model` stores a **mix** of app ids and provider ids, so any buy-vs-sell join must normalise first or it will silently miss the priciest models. **F4's egress table has its first entry** (cycle 20 Jul–20 Aug, read day ~20): 2.483 GB uncached, 3.629 GB cached, 12 MAU → **0.509 GB/MAU total**, implying a **491 MAU** ceiling — the verdict predicted 0.5–0.7 GB/MAU and ~300–500 MAU, so the estimation model is **corroborated, not replaced**. Read with care: ~95% of the cycle predates the 2026-08-08 media fixes, the cycle is partial, and only uncached counts toward the headline quota (0.99% against a 60% alarm line). The billing page also states the org is *"not billed for overages"* — independent confirmation of the cap-ON posture from the billing surface. **Certification now has one owner action left: a second incident recipient.** New debt recorded: IO timing was off for the entire entry baseline, so the run will produce IO numbers with no "before" unless an idle sample is taken first. | Claude Code |
| 2026-08-09 | **The provider-cost ledger is fully unblocked — the join key already existed.** Owner authorised the Kie usage export; it is **per-task**, not per-model: `API Key`, `Model`, `Credits Consumed`, `Create Time`, `Task ID`. **`Task ID` is the value the app already stores as `generations.prediction_id`**, so the buy side joins to the sell side today with no schema change and no catalog work — the opposite of the "record a per-model cost into the catalog first" the item prescribed. Verified against production for 10 Jul – 9 Aug: **26 of 37 generations matched by id**. Three findings, each changing the design: **failed generations cost nothing** (0 of 26 matched tasks were billed-but-failed; all 11 failures are absent from Kie's billing entirely, so the "we pay for failures" concern that motivates margin tracking does not apply); **the 11 unmatched Kie tasks are all `gemini-3-flash`**, the prompt-assist path that writes `ai_usage_events` rather than `generations`, so a complete ledger must join **both** tables or silently omit 30% of task count; and **app credits charged == Kie credits consumed 1:1** on every matched image model (`nano-banana-2` 8/8, `nano-banana-pro` 18/18, `gpt-image-2` 6/6, `grok-imagine-image` 4/4; two rounded up — `seedream-5-lite` 6 vs 5.50, `wan-2.7-image` 5 vs 4.80). **1 Kie credit = $0.005**, verified four ways against the pricing page and matching the dashboard's own USD to the cent (5.50 cr → $0.0275 vs $0.028; 4.80 cr → $0.024 vs $0.024). So provider cost is **already derivable from a column we store**: `≈ generations.cost × $0.005`. **Explicitly not generalised to video** — every model in the window is an image model, video bills per second, and the app's own charges hint at a different relationship (`kling-2.6/motion-control` ~81 credits/run, `bytedance/seedance-2` ~229/run), which is the expensive half and therefore the wrong place to guess. Correcting the note written earlier the same day: the per-modality pricing complexity matters for **forecasting**, not for the ledger, because Kie has already resolved the formula into an actual per-task credit figure. **Security finding:** the export's `API Key` column carries the **full key in plaintext** where the dashboard masks it, so the file is a live credential and any automation around it must treat it as one. **Budget constraint recorded (owner): no additional paid services are possible now** — log drain, PITR and paid external monitoring are out of scope, which makes the recovery story *daily backup + finite logs* and the RTO "last daily backup"; legitimate at 13 MAU, not at the 10,000–25,000 this phase certifies, so it is a funded item to revisit before that traffic, not after. Error tracking stays in scope on a free tier but needs owner account creation. **The second incident recipient turns out not to be a config value at all:** `backend-alert-watchdog.yml` has no recipient list — its alert channel is GitHub's own workflow-failure email, which routes to GitHub accounts, not addresses. Address chosen (`info@magicbooklet.com`, deliberately not the primary mailbox), with the free route (verified email + Actions notifications) and the genuinely-independent route (second GitHub user) both recorded. | Claude Code |
| 2026-08-09 | **Server-side error tracking shipped by narrowing the build guard, not relaxing it — and the browser half was found silently broken first.** Two deploys. `0f39cd5` fixed a bug worth carrying: `12107cf` had shipped Sentry into production **without its DSN**, because Next inlines `NEXT_PUBLIC_*` by substituting the **literal text** `process.env.NEXT_PUBLIC_SENTRY_DSN`, and the module read it as `environment.NEXT_PUBLIC_SENTRY_DSN` where `environment` merely *defaulted* to `process.env` — a shape that never matches, against a `process.env` that is an empty shim in the browser. **Every signal said otherwise**: build green, buildId matched, and the CSP carried the Sentry ingest origin — but that header comes from `next.config.ts` running in **Node** at build time, where `process.env` is real, **so the one thing that looked like proof of correct wiring was produced by a different mechanism than the one that was broken.** Silent twice: `resolveSentryEnvironment` had the identical flaw, returned `'unknown'` instead of `'production'`, so the "error tracking is OFF" warning written for exactly this never fired. Caught only by loading the deployed page and finding no Sentry client. Fixed with a `BUILD_ENVIRONMENT` snapshot of direct `process.env.X` member expressions, verified by building with a DSN and grepping the emitted client chunk, and guarded by a test on the source shape since no unit test can observe bundler substitution. Then **proven by arrival**: the live client reports the right DSN host, `environment: production`, `tracesSampleRate: 0`, `sendDefaultPii: false`, and a deliberate exception landed as `MAGICBOOKLET-WEB-1` at Priority High, exercising the alert path too. `9a4fef0` then unblocked the server half. `check-ffmpeg-build-artifact.mjs` flagged every `/ROOT/` literal, which made a root `instrumentation.ts` impossible — the flagged string is Turbopack's own path constructor ``U.P = e => `/ROOT/${e}` ``, emitted into Next's edge-wrapper template whenever instrumentation exists, **whatever it imports** (attributed by elimination: none passes, client-only passes, server file fails with or without any Sentry import). **Narrowed, not relaxed:** a bare `/ROOT/` with an *empty tail* is now allowed, because the guard's stated purpose is to block dependency paths that reach the filesystem and a prefix with nothing after it names no dependency; the bug it exists for was `/ROOT/node_modules/ffmpeg-static`, which has a tail and is still flagged. Two regression tests pin that, one placing a `sharp` native path alongside the new allowance in the same source so it cannot widen. Server instrumentation is **Node-runtime only by choice** — `instrumentation.ts` is loaded by the edge runtime too and middleware runs on *every* request, so **middleware errors remain uncaptured**. Verified after deploy: buildId matches, all public routes 200, browser client still initialised, and the 09:10 cron tick clean. **One honest gap:** the server half is proven wired and deployed but **not proven by arrival**, because forcing a server error would mean deliberately breaking a production route. **The transferable lesson: for anything whose whole job is to report, the deploy is not the verification — an event arriving is.** | Claude Code |
| 2026-08-09 | **Phase 1's code tail deployed and verified, and error tracking is half-shipped with the other half evidenced rather than forced.** `f5194f0` promoted — **live `/api/app-version` buildId matches HEAD exactly**; both migrations recorded **by name** (`backend_cost_aggregates`, `marketplace_bundle_listings`) with versions rewritten to `20260809074918`/`074922`, which is precisely the rewrite this document warns makes a filename-version check read as "never applied". Backfill covered all 10 bundles, 9 listable — matching the audit's own "9 published bundles". Both new objects exercised in production: the aggregate returned real data (47 rate-limit rows, the exact figure the F15a re-measurement recorded) and the listing returned 9 rows on both `recent` and `top-sales`. **`get_advisors` per the standing rule: no new WARN or ERROR.** `marketplace_bundle_listings` shows only the INFO `rls_enabled_no_policy`, which is the intended locked-down posture (RLS on, no policies, service_role bypasses) and matches ~40 existing tables; the two new SECURITY DEFINER functions do not appear at all, because the REVOKEs from `anon`/`authenticated` did their job. The single WARN is still the pre-existing `start_workflow_canvas_run` row F12 documents as structural-and-reviewed. **`backend_job_runs` checked on the next cadence** — the F7b lesson that a green deploy can arm a failure for the next tick — and the 08:01 UTC tick ran **zero failures**, including `backend-alert-delivery`, which is the job that calls the changed `collectBackendCostReport`. **Sentry:** owner created the org; projects `magicbooklet-web` and `magicbooklet-mobile` created, **browser error tracking shipped** with the DSN on Vercel production and the ingest origin added to the report-only CSP *derived from the DSN* so the two cannot drift. Tracing, replay and PII are all off by decision, not default. **Server-side capture did not ship, and the reason is a post-incident guard rather than a preference:** a root `instrumentation.ts` makes Next emit an edge wrapper containing Turbopack's own ``U.P = e => `/ROOT/${e}` `` helper, which `check-ffmpeg-build-artifact.mjs` flags because its allowlist only permits `/ROOT/node_modules/next/dist`. Attributed by elimination — no instrumentation passes, client-only passes, server file fails **with or without any Sentry import** — so **the blocker is `instrumentation.ts` existing at all, not Sentry**. The fix is one line in `ALLOWED_INLINED_ROOT_PATH_PATTERN`, and it was left for a human because narrowing a guard that exists because bundling `ffmpeg-static` broke every rendition in production changes what production is protected from. Source maps also unshipped (needs `SENTRY_AUTH_TOKEN`), so **stack traces arrive minified**, and mobile stays unwired because it ships on the multi-week store train and its plugin changes `expo prebuild`. | Claude Code |
| 2026-08-09 | **Production incident, self-inflicted and caught by the release gate: decision #2's 30-day facts silently broke every feed-maintenance run.** `prune_feed_personalization_data` enforces `event_retention ≤ fact_retention` — `feed_events.delivery_fact_id` points at facts, so pruning facts first would orphan the events referencing them. Cutting `FEED_FACT_RETENTION_DAYS` to 30 while `FEED_EVENT_RETENTION_DAYS` stayed at **90** violated that guard, and the RPC raised. **The blast radius was the whole job, not just fact retention:** `maintainFeedPersonalization` throws on the first failing RPC, so the post-stats, engagement-stats, creator-stats and interest-weight refreshes stopped too, and nothing pruned at all. It ran failing every hour from the `597d509` deploy until found. **How each safety net behaved, which is the useful part.** The `597d509` deploy passed because feed-maintenance had not yet run with the new value — a deploy can verify healthy and still have armed a failure on the next cron tick. The *next* release (`93b0850`) then failed its gate with a **503**, correctly refusing to promote into a degraded production; the gate caught a consequence of an earlier change, not of the change being deployed. And it surfaced in `backend_job_runs.last_error`, which is where a failing job actually shows. **Why no local gate caught it:** the maintenance unit tests mock the RPC, so the database-side guard never runs, and the two constants only meet it in production. A unit test now asserts `FEED_FACT_RETENTION_DAYS >= FEED_EVENT_RETENTION_DAYS` directly, and the fix was verified by calling the real `prune_feed_personalization_data(now(), 30, 2, 5000, 30)`, which returns a summary instead of raising. **Resolution: events come down to 30 with the facts** — the change decision #2 implied but did not spell out, since facts at 30 are impossible while events sit at 90. | Claude Code |
| 2026-08-09 | **F15a's remaining aggregate item re-measured: ~100× away from mattering, and required before certification rather than now.** Rows per 24-hour window against the 5,000 cap — `backend_rate_limits` **47 (0.94%)**, `storage.objects` 2, and `generations` / `ai_usage_events` / `provider_dependency_events` all **zero**. Nothing truncates today; the busiest source needs roughly 100× current traffic, order of 1,000–2,000 MAU, before it starts — which *is* inside the 10,000–25,000 MAU certification target, so it is a certification prerequisite, not a live problem. **Recorded the real cost of doing it early:** all five builders are simple group-bys that are unit-tested against raw fixtures, so converting them moves the arithmetic into SQL where those tests no longer reach it — done carelessly the change *reduces* logic coverage while fixing a truncation that is not occurring. The recipe is therefore to write pgTAP for the aggregate function first and keep a raw-row path in the tests to compare against, validating the SQL against the JS it replaces. Also noted: the F15b ledger this was originally deferred behind is itself blocked, so that coupling no longer constrains the timing. | Claude Code |
| 2026-08-09 | **F7b's partitioning analysed and deliberately deferred — decision #2 moved the ground under it.** Monthly partitioning was specified while raw retention was 400 days, where it is obviously right. At 30 days it fails three ways. **A partition can only be dropped once its entire range has expired**, so a July partition still holding live Jul 10–31 rows cannot go until 31 August — enforcing a 30-day policy with monthly granularity retains **up to ~60 days**, double the storage decision #2 was taken to bound; keeping the row-by-row DELETE instead means partitioning buys nothing for retention. **Finer granularity lands on the hottest write path:** `apply_feed_delivery_outcome` updates a fact `WHERE delivery_id = NEW.delivery_fact_id` with **no partition key**, and fires on every impression, dwell, media-progress milestone, open and quick skip — so daily partitions would turn the app's most frequent write into ~30 per-partition probes. `feed_events` carries `occurred_at` but **not the fact's `ranked_at`**, so fixing that is a schema-plus-app change, not a partitioning migration. **And the size case has weakened by an order of magnitude:** this item projected ~24M rows at 400-day retention; at 30 days the steady state is ~37k today and ~1.8M at 5,000 MAU, which Postgres does not need partitioning for. What remains is the prune *rate* — ~60,000/day against a 120,000/day ceiling, a 2× margin now watched by the retention-lag monitor. **Deferred with a trigger to revisit** (prune approaching its ceiling, or retention lengthened again), and if done the shape is daily/weekly partitions plus carrying `ranked_at` into `feed_events` — **not monthly**, which satisfies neither the window nor the write path. | Claude Code |
| 2026-08-09 | **F7b's daily aggregates landed, discharging the 2026-08-27 deadline; only partitioning remains.** `feed_delivery_fact_daily` plus `refresh_feed_delivery_fact_daily`, rolled up by the existing hourly feed-maintenance job and kept **400 days** — the window raw facts used to hold. Decision #2 cut raw retention to 30 days *because* aggregates would carry the experiment lookback; until they existed that was a promise with a date on it. Grain is per day per (algorithm version, experiment, variant, candidate source, surface). **Three load-bearing details, each proven rather than assumed.** `UNIQUE NULLS NOT DISTINCT` is essential: four of six grain columns are nullable, and under the default NULLS-DISTINCT rule `ON CONFLICT` would never fire, so every hourly run would **append a duplicate bucket rather than update one** — inflating metrics a little more each hour while looking plausible (verified: two NULL-bearing inserts collapse to one row). The upsert **assigns rather than accumulates**, since the window is re-read in full. And it recomputes a **trailing 3-day window** rather than appending finished days, because facts are mutated after insert as outcomes arrive — a pgTAP test stamps an outcome after the first rollup and asserts the next picks it up. **A correctness bug the fixture caught:** `dwell_ms_max` and `media_progress_max` are `NOT NULL DEFAULT 0`, so the observation counts were first written as `FILTER (WHERE … IS NOT NULL)`, which counts every delivery as an observation and divides by the wrong denominator; they count on `> 0` now. The rollup runs **before** the prune — not load-bearing at a 3-day window inside 30-day retention, but it is the invariant that survives either number changing, and the order is asserted in the unit test. Gates: 3,933 tests, lint, three typechecks, build, build:verify, clean replay, 586 pgTAP assertions, plus the built-artifact check. | Claude Code |
| 2026-08-09 | **F15b scoped — the ledger is blocked on an input nobody has, and most of the rest is not code.** Checked before building anything: **Kie reports no per-task cost** (the callback carries only `status`; across all 20 `model_api_references/` files there is no credits-consumed field, no billing endpoint and no usage endpoint — only `402 Insufficient account balance` rows and prose pointing at `kie.ai/pricing`), **the model catalog carries no cost field** (`providerModelMap` and a verification provider, nothing priced), and **the app records only app-credit charges**, which is the sell side. So a per-task provider-cost ledger can only restate what is already known, and creating the table would be false progress: the missing piece is a **per-model provider cost recorded into the catalog and kept current**, which is an owner data-entry decision. Same shape as F14's "reconcile against the provider" finding — the provider does not expose it. **A useful consequence:** F15a's DB-side aggregates were deferred into F15b *specifically* to avoid rewriting `backend-cost-report.ts` twice once the ledger's requirements were known; since the ledger is blocked on a non-existent input, that coupling dissolves and the aggregate layer is now the one substantial code-only item left. Seven other items (error tracking, external monitoring, second incident recipient, log drain, PITR, media recovery, F4's egress automation) each need an account, a spend approval or an owner-only value. **`track_io_timing` is also an owner action:** `ALTER DATABASE … SET track_io_timing = on` was attempted and silently did nothing — `pg_db_role_setting` shows no entry, because the GUC has `superuser` context and Supabase's `postgres` role is not a superuser. It must come from the dashboard, and it matters **before** the certification test, since without it the load test produces no IO-latency data at all. | Claude Code |
| 2026-08-09 | **F9 DONE — the comments scan is bounded and the top sort is indexed.** The visible-comment scan called `loadBlockedCreatorIds` per batch inside a `while (true)`, and that helper issues **two** `user_blocks` queries because blocks are bidirectional — so an unbounded loop meant two queries per iteration with no ceiling. The block set belongs to the **viewer, not the batch**, so `loadViewerBlockRelationships` loads the whole bidirectional list once and the entire scan costs **two reads however many batches it walks** (pinned by a test asserting exactly 2). Same inversion as F5: materialise the small thing. A list past 5,000 entries falls back to the exact per-batch lookup, because an incomplete set would **show a viewer content they blocked** — and the fallback is an explicit flag, not `size === 0`, since empty is the *common* case and inferring would put the per-batch queries back on the hot path for nearly everyone. The scan now stops after 10 batches and, when the cap is what stopped it, reports `hasMore` with the last offset examined, so the cap is a **bound rather than a silent truncation** — stopping quietly would look like a thread that ends early. **`post_comments` had no index reaching `reply_count` at all**, only the recency one, so `sort=top` sorted in memory; `post_comments_toplevel_top_idx` covers the full `(post_id, reply_count DESC, created_at DESC, id DESC)` key. It is deliberately **not** narrowed by status: the listing keeps removed comments that still hold replies (`status = 'active' OR reply_count > 0`), and folding that disjunction into the index predicate would make the index unusable for the half it excluded. Gates: 3,926 tests, lint, three typechecks, build, build:verify, clean replay, 577 pgTAP — **plus the new built-artifact check**, `npm start` with the ops endpoints curled, which is now standard after the minifier bug below. | Claude Code |
| 2026-08-09 | **F7b's first deploy failed the release gate, twice, on a bug no local gate could see.** The production release refused to promote: `/api/ops/backend-health` returned **500** on the staged deployment, so production stayed on `870e954` and the gate did exactly its job. A re-run of the same commit failed identically, proving it deterministic rather than transient. **The cause is a minifier-only fault.** `normalizeFeedRetentionLagRows` passed its `now` parameter on using object shorthand (`{ …, now }`); the bundler inlined `buildFeedRetentionLagEntry` into it, renamed the enclosing parameter, and left the shorthand's implicit reference pointing at the old name — producing `ReferenceError: now is not defined` **only in the built artifact**. Naming the parameter `asOf` and passing `now: asOf` explicitly removes the shorthand and fixes it. **The lesson generalises, and it is the F12 seam lesson in a new place:** 3,919 unit tests, lint, three typechecks, a clean migration replay, 577 pgTAP assertions and a successful `npm run build` all passed, because every one of them verifies *source* — the fault is introduced by the bundler, so only running the built output finds it. `npm run build` succeeding is not the same as the build working. **Reproduce this class locally with `npm start` against the real build and curl the ops endpoints**, which is how it was found; a stale server on the test port briefly made the fix look ineffective, so kill the port before re-testing. Note the shorthand itself is not broadly unsafe — it appears in nine places across seven files that all work in production, so only the proven-broken one was changed rather than churning working code on a theory. | Claude Code |
| 2026-08-09 | **F7b's retention and monitoring landed; partitioning and aggregates still open.** `FEED_FACT_RETENTION_DAYS` is 400 → **30** (decision #2), `feed_delivery_facts` is added to `get_operational_table_growth`, and a new **retention-lag** monitor ships as `health.feedRetentionLag`. **Measured first:** the ~1 KB per fact row this item's GiB projection rests on is real (14 MB across 14,983 rows, `score_components` dominating), so 24M rows really is ~24 GiB. **But the "60 facts per session" input is a ceiling production has never reached** — measured daily it runs **26–32**, because there are ~34 public posts against a 60-candidate pool limit, so a session cannot rank more than the catalog. The per-session figure will *rise* as the catalog grows rather than stay flat, so the 5,000 MAU gate is not conservative in the way it appears and should be re-derived from a real catalog. **`feed_delivery_facts` was the only feed table missing from growth reporting** — the table the whole gate is derived from was invisible, while `feed_events`, `feed_sessions` and `feed_session_items` were all covered. **Retention lag is a different signal from growth and the one that matters:** the prune is capped at 5,000 rows/hour, so past that ceiling the oldest row ages beyond its window while the table merely looks large; lag reads 0 at any size while the sweep keeps up, which no fixed row budget can do (steady state is ~37k rows today and ~1.8M at 5,000 MAU). Retention constants moved to `feed-retention-policy.ts` because the sweep is mocked wholesale by its route tests — a coupling the change exposed rather than one designed around. **⚠️ Dated obligation:** raw facts are not the lookback mechanism, daily aggregates are, and they are not built; the 30-day window deletes nothing until **2026-08-27**, after which it discards history nothing else retains. **Groundwork recorded for partitioning:** neither table has an *inbound* foreign key (`feed_events.delivery_fact_id` is a plain bigint with no constraint), so the usual hard part does not exist; the PKs must absorb the partition key (`(delivery_id, ranked_at)`, `(id, occurred_at)`), and check `ON CONFLICT (delivery_id)` plus the `feed_events_apply_delivery_outcome` trigger before switching; and **`feed_events` has no `ranked_at`**, so this item's "partition both by `ranked_at`" cannot be taken literally — its column is `occurred_at`. Both tables are still 14 MB and 4.7 MB, so this is the cheapest it will ever be. Gates: 3,919 tests, lint, three typechecks, build, build:verify, clean `db reset --local`, 577 pgTAP. | Claude Code |
| 2026-08-09 | **F5b's first two corrected items landed, and its cache tag turns out to be a moderation control.** Caching now covers **tool-filtered** first pages (`marketplace-resource-list-base-v4`; the key gained a `tool` argument), while search stays uncached — the line between them is key-space, not correctness: tool slugs come from the source-tool catalog and arrive normalised so entries are bounded, whereas a free-text query is unbounded and one visitor could mint arbitrarily many. The **6-arg overload shim is dropped** (`20260809150000`) after confirming nothing calls it, closing the PostgREST ambiguity footgun F6 already hit — with the migration stating outright that no latency change is expected, so it is not later reported as a performance fix that did not materialise. **The important finding is the one that stopped a change:** the `SHOWCASE_FEED_CACHE_TAG` on the marketplace cache genuinely does over-invalidate — the hourly media-repair sweep, profile updates and post reports all bust it — but the moderation take-down path (`admin-moderation-service.ts:98`) invalidates **only** the feed tag and never the marketplace one, so that tag is the single thing keeping taken-down content out of the marketplace listing. Removing it to cut invalidation would have opened a moderation hole for the length of the revalidate window. Narrowing it is a moderation change, not a caching one, and needs every post-visibility path to invalidate the marketplace tag first. **Still open:** the catalog-scale restructure, which is harder than F5's because `marketplace_resource_bundle_quality_issue` reads columns from *both* `post_resource_bundles` and `posts` — so precomputing it cannot be a generated column and needs triggers on two tables. Gates: 3,907 tests, lint, three typechecks, build, build:verify, clean `db reset --local`, 577 pgTAP. | Claude Code |
| 2026-08-09 | **F5 DONE — ranking cost is now flat in catalog size.** `20260809140000` replaces the unbounded `eligible AS MATERIALIZED` CTE with a bounded, index-driven row source per pool, and adds the one index that was genuinely missing. Seeded locally: **50k posts 111,150 buffers/138 ms → 5,669/6.9 ms; 200k posts 445,336/587 ms (spilling and reading from disk) → 6,171/8.2 ms** — **+8.9% for a 4× catalog**, against 4× growth before. Output is provably unchanged: personalised, anonymous and category-filtered calls each return the same 60 posts in the same positions with the same `candidate_source`, and a test asserts the scoring stage is byte-identical to `20260711064036` apart from its row source, because no buffer measurement would catch a ranking drift. **Four findings.** Deleting the `MATERIALIZED` keyword alone does **nothing** (identical 111,150 buffers and plan) — Postgres only auto-inlines a CTE referenced once and this one is referenced six times, so the keyword documented what would happen regardless. The rewrite went **worse before better, to 187,643 buffers**: the exploration pool's unrated branch anti-joined the whole catalog to return *zero* rows (151,808 buffers, now bounded to the newest page), and the per-row feedback `NOT EXISTS` checks became 12,500 index probes inside one pool before any LIMIT could apply. The fix was to **invert what gets materialised** — the viewer's feedback lists are now the materialised CTEs, which is safe exactly where materialising the catalog was not, because their size is bounded by one viewer's behaviour: *materialise the small thing, not the big one*. And exactly one index was missing: every owner-scoped index omits either `visibility` or `review_status`, and either omission forces a bitmap scan, which is unordered and so **cannot stop at the LIMIT** — it top-N heapsorted every post a creator had; the following pool went from 5,749 buffers to **29**. **`get_ranked_feed_candidates_v2` is deliberately untouched** — same defect, but still `shadow` and serving no traffic, so rewriting it blind against a v1 fixture was declined; it is now a **gate before promoting v2** alongside F13's disjointness check, since leaving it silent is how F13's bug reached v2 in the first place. Gates: 3,902 tests, lint, three typechecks, build, build:verify, clean `db reset --local`, 577 pgTAP. | Claude Code |
| 2026-08-09 | **F5 diagnosis confirmed by the same measurement that overturned F5b's — and the two are not the same shape.** The audit describes F5b as "the same defect F5 describes", so F5 was measured before implementing. `get_ranked_feed_candidates` with a real user and `p_category = null` returns 32 rows at **2,310 buffers cold and 269 warm**, against F5b's 34 warm. That 269 is genuine execution — the unbounded `eligible AS MATERIALIZED` CTE doing work that grows with the catalog — so **F5's prescribed LIMIT-first fix targets the right thing, where F5b's could not**. Two things recorded for whoever implements it: production's 1,549 blocks/call is still ~83% planning, so `shared_blks_hit/calls` will barely move after a correct restructure and must not be the verification (seed a large catalog locally and compare execution buffers at a fixed page size); and the second argument is **`p_category`, not a lane** — passing `'for-you'` there returns 0 rows and makes the ranking look cheap, which is an easy way to measure nothing and conclude the item is stale. | Claude Code |
| 2026-08-09 | **F5b diagnosis corrected by measurement — the prescribed fix cannot work, and no code was shipped on a wrong premise.** `EXPLAIN (ANALYZE, BUFFERS)` in production shows the function's **execution costs 34 buffers**; the same call cold costs 1,789, and the 3-table join alone costs **872 buffers to *plan* against 10 to execute**. Production's ~930 blocks/call is therefore planning plus a fixed PostgREST round-trip floor — measured at **205 blocks on `check_backend_rate_limit`, a single-table upsert** — and not the "scan the world, filter afterwards" the item describes. At 9 published bundles a full catalog scan costs 10 buffers, so **making the row source LIMIT-first would optimise the 34, not the 930.** Two candidate causes were eliminated so they are not re-tested: jsonb columns are not repeatedly detoasted (TOAST is 0 bytes, every value under 1 KB) and the catalog is not bloated (`pg_proc` 1.5 MB / 3,752 rows at 7.7% dead). The indexes the fix would add **already exist** — 14 on the table, including an exact `(status, created_at DESC, id DESC)` match for the default sort. Also found: `get_ranked_feed_candidates` is *more* expensive per call (1,549 blocks) and only trails on total because it has 20× less volume. **The item's own verify step is unsound** — re-reading `shared_blks_hit/calls` would report ~930 before and after a correct restructure, reading as a failed fix, which is the trap F3 fell into; the restructure has to be measured against a locally seeded large catalog instead. The audit's structural concern remains valid *for catalog growth* (a `plpgsql` quality predicate runs per candidate row before ORDER BY/LIMIT and is never inlined) — it is simply not what is being measured today. Corrected work order recorded in the section: reduce call volume first (the 60 s `unstable_cache` covers only the unfiltered `offset = 0` page, and its tag set couples it to `SHOWCASE_FEED_CACHE_TAG` so every feed mutation invalidates the marketplace listing), then drop the 6-arg shim, then restructure. **Carried to F8:** the ~200-block PostgREST floor is independent quantitative support for it. | Claude Code |
| 2026-08-09 | **F14 DONE — queue-age SLOs landed, and the admission control deployed and verified.** Admission control verified live at `e70d139` (buildId matches HEAD, both tables present with RLS on, both functions present, advisor shows no new WARN) and **behaviourally smoke-tested against the deployed function** rather than only checked for existence: a capacity-1 scope admitted the first call and returned `rate_limited` on the second, then the throwaway rows were deleted. Queue-age SLOs are `backend-queue-age.ts`, exposed as `health.queueAge`. **The key distinction:** the registry's existing `healthExpectedMaxAgeMinutes` measures *job liveness*, not queue age, and the two diverge exactly where it matters — **F13 was a job that ran on schedule every hour while permanently starving every row past the first thousand**, with liveness green throughout. Thresholds are derived from each queue's owning job cadence (2× = SLO breach/warning, 4× = not draining/degraded) so a schedule change moves them, rather than a constant that silently keeps asserting the old cadence — the drift F14 already guarded against for `vercel.json`. **Three findings:** F12's `workflow_run_step_jobs` shipped with claims, leases and backoff and **no health coverage at all**, now closed; queue age cannot be derived from the existing capped samples because the true oldest row falls outside the cap exactly when the queue is deep, so each queue gets a targeted `order by … limit 1` probe (F15a's finding in a new place); and age runs from `next_attempt_at` on retry queues, since an item deferred by backoff is not late and ageing from creation would report a healthy retry schedule as a permanent breach. An empty queue reports `null` rather than zero, and an unprobeable queue is flagged `QUEUE_AGE_UNREADABLE` instead of passing as healthy — not knowing is not the same as being fine. Gates: 3,894 tests, lint, three typechecks, build, build:verify. | Claude Code |
| 2026-08-09 | **F14 part two's throughput half landed — account-wide provider admission control.** Migration `20260809130000` adds a real token bucket (global + per-model), an in-flight concurrency cap and a cross-instance circuit breaker, decided by a single `admit_provider_submission` RPC and gated inside `createKieTask` so all seven start paths inherit it. **The `Retry-After` sub-item turned out already half-built, in the half that does not help:** `fetchWithProviderRetry` has parsed and honoured `Retry-After` since before the audit, but submissions cannot reach it — a non-idempotent POST is clamped to one attempt on purpose, because retrying a submission is the double-charge this item just closed. Its useful meaning here is "let the provider decide how long the circuit stays open", which needed an *uncapped* parse (the existing 10 s cap exists to stop a caller blocking; nothing blocks here). **The numbers are ours, not Kie's:** all 20 model references document a 429 but none publishes a rate or concurrency limit, so the reactive half matters more than bucket tuning and the load test is what should raise them. **Four decisions recorded in the section:** one RPC rather than three, because consuming a global token and then rejecting on the model bucket leaks it; a real bucket rather than `check_backend_rate_limit`, which is a fixed window and admits 2× across a boundary instant — the exact burst shape that trips a provider limit; the rejection is a `GenerationServiceError(429, 'provider_busy')` and must never be an `ExternalServiceTimeoutError`, or the shared settle helper would hold the credits for 45 minutes instead of refunding them; and the breaker counts **only** timeout/429/5xx, because counting a 4xx or Kie's HTTP-200 validation-rejection shape would let one user's bad prompt open the circuit for everybody. Two silent-liveness traps closed: a probe bypasses the other gates (a drained bucket would otherwise stop the breaker ever closing) and a stale probe is reclaimed (a crashed instance would otherwise wedge it half-open forever) — the same reasoning as F12's lease reclaim. Admission fails open by design, with the genuine rejection thrown outside the fail-open block so the gate cannot silently disable itself. A submission queue was deliberately **not** built: it is not among the audit's deliverables and would hold credits against unsent work. Gates: 3,883 tests, lint, three typechecks, build, build:verify, clean `db reset --local`, 577 pgTAP assertions. F14 now has **only queue-age SLOs open**. | Claude Code |
| 2026-08-09 | **F14's money-bug fix deployed and verified in production.** `9a4e224` promoted (live buildId matches HEAD); the marker column, both indexes, the hold RPC, the `provider_submission_reconciliations` ledger and its RPC were all confirmed **absent before the push and present after**, `settle_generation_start_failed` carries the marker report, and EXECUTE on all three functions is `service_role`-only. `get_advisors` re-run per F12's standing rule: **no new WARN** — the ledger's `rls_enabled_no_policy` is INFO and intended for a service-role-only table, and the lone WARN is still F12's reviewed `start_workflow_canvas_run` row. Baseline recorded as 0 held generations / 0 reconciliation rows; a non-zero ledger count later is the first real evidence ambiguous submissions occur in production. **One verification gotcha worth keeping, now in *How to work an item*:** the release applier matches migrations by **name**, and the remote history stamps its own version at apply time, so `20260809120000_generation_submission_unknown.sql` is recorded as `20260808221226 / generation_submission_unknown`. Checking `schema_migrations` for the filename version returns zero rows and looks exactly like a migration that never applied. | Claude Code |
| 2026-08-09 | **F14 part two's money bug closed — ambiguous submissions are held, not refunded.** Migration `20260809120000` (marker column, `mark_generation_submission_unknown`, the `provider_submission_reconciliations` ledger, and `settle_generation_start_failed` reporting the marker), the hold branch in the shared settle helper, reaper ambiguity reporting, and the webhook reconciliation record. **Three things the located diagnosis did not have.** First, the bug was in **seven start paths, not one** — image, video, motion, catalog, voiceover, sound effect, plus two template variants all carry the identical `!predictionId` branch — so the fix went into the shared settle helper and changed no call site; a per-site edit would have left six paths broken. Second, **"reconcile against the provider before refunding" is not buildable**: every Kie lookup is keyed on the provider's task id and `createTask` accepts no client reference, so in the ambiguous case the key is exactly what is missing. The inbound callback *is* the reconciliation, and the audit's Fix line is wrong about this. Third, the audit calls it a `submission_unknown` *state*, but making it a `generations.status` value would have been the `6303a95` seam bug again — `status` is set-membership-tested in eight places, and dropping out of `ACTIVE_START_STATUSES` would stop a same-key resubmit being deduped, **charging the user twice while the first submission may still be billed**. It is a marker column on a still-`pending` row, so every existing subsystem keeps matching it unchanged. **Both cautions resolved and recorded in the section:** the grace window is the reaper's 45-minute window with no second timer, and a late callback after a grace-expiry refund is flagged for ops as a *row* — a log line was rejected specifically because it is not queryable against money and F15b's log drain is still open. **A latent bug found on the way:** the reaper was not template-aware and settled template rows through the non-template RPC, refunding the hold while leaving `template_run_steps` in `processing` — near-unreachable before, but holding would have made those rows ordinary. Four residuals recorded rather than fixed, the notable one being that template runs keep the original bug because a step's outcome must be known synchronously for the run to progress. Gates: 3,855 tests, lint, three typechecks, build, 560 pgTAP assertions, and a clean `db reset --local` replay. | Claude Code |
| 2026-08-09 | **Session close-out — Phase 1 entry, F12, and F14 part one.** Four deploys, each gate-green and verified live by matching `/api/app-version` to HEAD: `6303a95` F12 (idempotent run creation, durable step queue, cron recovery, pure GET), `48a4e33` the security fix below, `0cd7ee1` the F14 cron split, `1190fb3` F14 byte admission. **The most transferable lesson is the security one:** the hole in `6303a95` passed 3,816 tests, lint, three typechecks, pgTAP *and* a production deploy, because each half was individually correct — the RPC's ownership check was sound, the cron adoption was sound, and only their composition was exploitable. Gates verify parts; nothing verified the seam. The Supabase advisor caught it, which is why "run `get_advisors` after every migration adding a function or table" is now recorded as a standing rule rather than a one-off. Three findings the audit did not have, all from the decision-#4 baseline: `list_marketplace_resource_bundles` is 47% of RPC time (**F5b**, new), the connection pool sits at a **47% floor while idle** so the certification gate's "below 70%" has ~23 points of real headroom, and `track_io_timing` is **off** so no IO-latency baseline exists or can be captured during the load test. Decisions #3 and #4 resolved. Board defect fixed: every per-section status had read TODO while the table said DONE. **Stopped deliberately before F14 part two** — money-path work (refunds, credit settlement, a new generation state) on a long session is the wrong risk profile, and the composition bug above is exactly the failure mode that would recur. Part two's bug is located to the line, with its two cautions recorded, so the next session starts from the doc rather than a re-read. | Claude Code |
| 2026-08-09 | **F14 cron shared-fate split landed.** `generation-completions` and `media-preview-repair` now have their own Vercel cron entries and therefore their own function instances; the other nine jobs stay on the shared scheduler, and `getDueBackendJobs` filters dedicated jobs out so the memory-heavy work cannot re-enter the shared invocation. Two things worth keeping: the audit does not mention that **the invocation budget blocked the obvious fix** — 180/day with the scheduler already using 144, so a second ten-minute cron did not fit until the ceiling was raised to 456 and the assertion changed to measure every cron entry rather than only the scheduler; and **in-process isolation was rejected as insufficient rather than weaker**, because bounded concurrency and time budgets do nothing about an OOM, which is the failure the audit actually describes. `vercel.json` is now asserted against a registry-derived list so the two cannot drift — drift breaks in both directions, since an orphan entry 401s forever and a dedicated job with no entry never runs at all. Selection rule recorded: shared dispatch is the default and a job earns isolation by being able to take the invocation down. F14 stays IN PROGRESS for media admission control, the ffmpeg wall-clock kill, queue-age SLOs, and all of part two. | Claude Code |
| 2026-08-09 | **Security fix on top of F12, found by the Supabase advisor after deploy.** `start_workflow_canvas_run` is `SECURITY DEFINER` and granted to `authenticated`, but took the acting user as a parameter and checked only that the canvas belonged to *that parameter* — so a signed-in caller could pass a victim's user id plus the victim's canvas id and the check passed. Harmless alone (an orphan run row); credit theft in combination with the durable queue landed in the same commit, because the caller also controls `p_graph_snapshot` and `adoptStalledWorkflowRuns` then hands the forged run to a worker that executes it as `run.user_id`. **The recovery mechanism built to stop runs being lost is what turned a junk row into a paid generation.** Fixed in `20260809100000` by binding the acting user to `auth.uid()` when a user JWT is present, leaving `p_user_id` trusted only for service_role. Verified against the local database (attacker rejected, owner unaffected, service path intact, zero forged rows), with a test asserting the re-created function is otherwise byte-identical so idempotency cannot regress through the copy. Generalised lesson recorded in F12: a `SECURITY DEFINER` function reachable by `authenticated` must *derive* identity, never accept it — taking it as a parameter is safe only while nothing trusts the row it writes, and that condition stopped being true in the same commit. Run `get_advisors` after every migration that adds a function or table, not only at re-certification. | Claude Code |
| 2026-08-09 | **F12 mostly landed.** Run creation is idempotent (`start_workflow_canvas_run` + a partial unique index on `(canvas_id, idempotency_key)`, key read from the `Idempotency-Key` header or the body), a durable `workflow_run_step_jobs` queue carries claims/leases/heartbeats/attempt caps/backoff modelled on `generation_completion_jobs`, a new `workflow-run-steps` cron job drains it and **adopts runs left unfinished with no live job**, and `getWorkflowRunDetails` is now a pure read. The key insight worth keeping: **the unique index does not stop the double-charge on its own** — `executeWorkflowRun` has to return *before* executing the graph when the RPC reports `reused`, or the second request still spends. Three further findings: the conflict path deliberately is not an upsert, because supabase-js's `merge-duplicates` would rewrite `graph_snapshot` on a run that may be mid-flight; the old insert never read its error, so a failed insert silently wrote every step against a null run; and deferral had to become its own verb, since a run waiting on a provider generation has not failed and charging that wait against the retry cap would exhaust a slow generation for no reason. Making the GET pure removed more than a write — it used to run `syncGenerationStatuses`, which polls the provider *and settles credits*, so a client refresh could start paid work. **Per-node executor deferred** (owner's call): the queue is keyed per node/attempt as specified, but a claimed job drives a run-scoped advance, so poison isolation is per-run rather than per-node. Both bugs the item was filed for are closed. Measured first: 11 lifetime runs, last on 2026-04-02, so nothing is accruing damage. | Claude Code |
| 2026-08-08 | **Phase 1 entry.** Phase 0 re-verified independently against the source (not the change log) before starting: all nine DONE rows check out. Fixed a board defect this pass — **every per-section `**Status:**` line still read TODO** while the board table said DONE, and the `**Landed:**` lines were empty; only the table had been maintained. Sections now carry their real status. F10 stays IN PROGRESS by design, with the carry-past-Phase-0 made explicit in the section so it does not read as an unfinished prerequisite. **Decision #3 resolved: Vercel plan is Pro** (`planIteration: plus`), read from the Vercel team billing API rather than inferred from the 10-minute cron. **Decision #4 resolved and recorded** as a new *Phase 1 entry baseline* section: Micro compute confirmed by memory fingerprint (the Management API exposes no compute size, the same blind spot F4 hit on the spend cap); connection pool sits at a **47% floor while idle**, so the certification gate's "below 70%" has ~23 points of real headroom, not 70; `track_io_timing` is **off**, so no IO-latency baseline exists or can be captured during the load test; and 429 GB of lifetime temp spill attributes entirely to catalog introspection, with every application RPC at zero temp blocks. The baseline also produced a finding the audit did not have: ranking RPCs by *total* time instead of mean shows **`list_marketplace_resource_bundles` is 47% of all RPC time** at ~1,000 shared-buffer reads per call — 19× the feed's call volume, invisible at 17 ms mean, and cheap today only because the whole database fits in `shared_buffers`. Filed as **F5b** (High, Phase 1), sequenced after F12/F14 but before certification. | Claude Code |
