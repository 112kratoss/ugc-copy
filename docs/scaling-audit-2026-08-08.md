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
| F4 | Spend cap posture + egress monitoring | Critical | 0 | DONE | Cap recorded; weekly dashboard egress read documented as the mechanism (egress is not in the database) — automation noted in F15b, 2026-08-08 |
| F1 | Watch surfaces stream full-bitrate source | Critical | 0 | DONE | Mobile pkg 1 + web pkg 2, 2026-08-08 — mobile still needs a store release to reach phones |
| F2 | AI posts skip transcode; sweep 5/hour | Critical | 0 | DONE | Publish-time repair kick + wall-clock sweep budget, pkg 3, 2026-08-08 |
| F3 | Derivative cache TTL — decision #5 resolved | Critical | 0 | DONE | Full pipeline verified; reopened for ranged edge entries and re-closed 2026-08-08 — takedown delete verified working, finite stale-ranged residual recorded and accepted in F3 step 3 |
| F11 | Web `/feed` drops the ranking cursor | Critical | 0 | DONE | Cursor threaded through load-more, retry and snapshot, pkg 4, 2026-08-08 |
| F13 | v2 stats refresh starves past 1,000 rows | High | 0 | DONE | Migration + fact index, pkg 5, 2026-08-08 |
| F7a | Facts for all candidates; unbatched events | High | 0 | DONE | Served-slice facts + batched events, 2026-08-08 — single-transaction insert deferred to F7b |
| F6 | Unthrottled hot GETs incl. full-catalog scan | Medium | 0 | DONE | Limits on all 5 GETs; filtered top-sales scan replaced by RPC unlock filter + ordered streaming, 2026-08-08 |
| F15a | Monitoring truncates silently; biased rates | Medium | 0 | DONE | Truncation flagged (cost + health), attempt-counter denominator landed, 2026-08-08; DB-side aggregates deferred into F15b with reasoning |
| F10 | Assorted small leaks | Low | 0 | IN PROGRESS | Mobile 404 pkg 1; studio grid + images pkg 2, 2026-08-08. Webhook budget rides pkg 3; two web-perf items stay unassigned |
| F12 | Workflow runs non-durable, non-idempotent | Critical | 1 | IN PROGRESS | Idempotent run creation + durable step queue + cron recovery + pure GET, 2026-08-09 — per-node executor deferred with reasoning |
| F14 | Shared-fate cron; no provider admission control | High | 1 | TODO | |
| F5 | For-you RPC materializes whole catalog | High | 1 | TODO | |
| F5b | `list_marketplace_resource_bundles` is 47% of RPC time | High | 1 | TODO | Found by the decision-#4 baseline, not by the original audit |
| F7b | Fact retention + partitioning | High | 1 | TODO | |
| F8 | Per-request GoTrue round-trip | Medium | 1 | TODO | |
| F9 | Comments scan loop; unindexed top sort | Medium | 1 | TODO | |
| F15b | Error tracking, PITR, log drain | Medium | 1 | TODO | |
| — | Phase 1 certification load test | — | 1 | TODO | |
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
- **`track_io_timing` is `off`**, so `blk_read_time` and `blk_write_time` are both 0. There is no IO-latency baseline to capture and none will exist during the load test either. Turning it on is a small F15b item; without it, "IO" during certification can only be inferred from cache-hit ratio and temp-file volume.
- **`log_temp_files` is `-1`** (off), so spills are invisible in logs.

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

**Definition of done for any item:** `npm test`, `npm run lint`, `npm run typecheck` pass; migrations additionally pass `npx supabase db reset --local` and `npx supabase test db`; the status board above is updated and the change log has an entry — **in the same commit as the code** (every push deploys; see the note at the top).

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
| _(first entry after deploy)_ | | | | |

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

**Still open in F15a — one item, deliberately deferred with its reasoning:**

1. **Database-side time-bucketed aggregates.** The report still downloads raw rows, now with explicit truncation. Deferred into F15b's monitoring build-out rather than done here, for three reasons: the caps *bound* the monitoring cost (≤5 × 5,001 rows per collection — the reads cannot grow past that); the silent-optimism harm this item was filed for is gone, since truncation is flagged and the biased denominator is fixed; and F15b adds a per-task provider-cost ledger to the same file, so building the aggregate layer once, with the ledger's requirements known, avoids rewriting `backend-cost-report.ts` twice. If F15b is descoped, this line item returns to F15a.

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

**Still open in F12 — the per-node executor, deferred deliberately with the owner's agreement:**

The queue is per `(run_id, node_id, attempt)` as the audit specifies, and it carries claims, leases, heartbeats, attempt caps, backoff and poison isolation. But a claimed job currently drives a **run-scoped** advance (`advanceWorkflowRunOnce`) rather than executing exactly one node. Both bugs this item was filed for are closed by what landed — the double-charge dies with the idempotency key, and stranding dies with cron-driven adoption of runs that have no live job. What a per-node executor would add on top:

- Poison-**node** isolation, rather than poison-run. One bad node currently fails its run's ticket, not just itself.
- Per-node retry accounting instead of per-run.
- Dependent enqueue driven by each node's terminal state rather than by re-running the run's execution order.

It was scoped out because the existing engine sequences a run as a whole and nodes that launch a generation sit in `processing` awaiting a provider webhook, so a per-node executor is a rewrite of the 1,300-line runner with real regression risk across approval gates and generation polling — against a feature with 11 lifetime runs. **Do it before workflow usage becomes material, and before the Phase 1 certification test exercises workflow fan-out**, or the test will certify a fan-out path that has not been restructured.

---

### F14 — Shared-fate cron and no provider admission control

**Status:** TODO · **Severity:** High · **Surface:** server

**Problem, part one.** Every due job runs concurrently inside one 300-second function invocation, so one memory-heavy media job can take down completions, push receipts, alerts and retention together. Four completion workers each staging a video up to 250 MB can require ~1 GB of function temp space.

**Evidence.** `src/lib/backend-jobs-route-service.ts:163` — `Promise.all` over all due jobs. `src/lib/generation-completion-jobs.ts:16` — `GENERATION_COMPLETION_CONCURRENCY = 4`. `src/lib/remote-media-security.ts:13-17` — 250 MB video cap.

Recovery ceilings today: generation completion fallback 25 per 10 min (150/hour), video renditions 5/hour, upload reclaim 500/day, interest refresh 1,000/hour. Webhooks are the normal completion path, so 150/hour is a *recovery* ceiling, not total throughput.

**Problem, part two.** Kie admission is per-user only (30 per 10 min); there is no account-wide or per-model limiter. A launch spike hits provider 429s with no queue. There is also an ambiguous-timeout case: task creation has a 30 s timeout and no retry, so Kie can accept a task the app believes failed — the app refunds, then discards the later callback.

**Fix.** Split paid completions, media, notifications and cleanup into independent durable queues with per-item leases, poison-item isolation and queue-age SLOs. Add byte-based admission control on media claims and a hard wall-clock ffmpeg kill. Add a global provider token bucket (start conservative: ~15 submissions per 10 s, ~50 concurrent, per-model caps), `Retry-After` handling, and a circuit breaker. Introduce a `submission_unknown` state that reconciles against the provider before refunding.

---

### F5 — For-you RPC materializes the whole eligible catalog

**Status:** TODO · **Severity:** High · **Surface:** migration

**Problem.** Both ranking RPCs open with an unbounded `eligible AS MATERIALIZED` CTE over all public visible posts; the per-pool limits apply only afterwards. At 100,000 posts and 2,000 fresh sessions/day this implies on the order of 200 million eligible-row examinations per day before joins and ranking. Production already shows 493 ms and 140 ms mean RPCs at 34 posts.

**Evidence.** `supabase/migrations/20260711064036_feed_personalization_system.sql:765-798` (v1) and `supabase/migrations/20260728181000_feed_ranking_v2.sql:626-661` (v2). Pool limits at `src/lib/showcase-feed-personalization.ts:258-262`.

**Fix.** Index-driven, LIMIT-first pools per lane (recent, trending, following, affinity, exploration), using `posts_public_review_recent_idx`. Cache anonymous and cohort candidate pools.

---

### F5b — `list_marketplace_resource_bundles` reads ~1,000 buffers per call and is 47% of RPC time

**Status:** TODO · **Severity:** High · **Surface:** migration + server

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

**Verify.** Re-read `shared_blks_hit / calls` from `pg_stat_statements` after deploy; the target is a per-call figure that does not move when the bundle catalog grows. Seed a large bundle catalog locally and confirm the plan does not regress to a full scan.

**Sequencing note.** This lands *after* F12 and F14 — those are correctness and money bugs, this is a scaling bug that is not yet biting. But it should land **before** the certification test, or the test will certify a number that the marketplace path cannot hold once the catalog grows past `shared_buffers`.

---

### F7b — Fact retention and partitioning

**Status:** TODO · **Severity:** High · **Surface:** migration

At 5,000 MAU with 50% personalized use and 400-day retention, roughly 24 million facts accumulate — on the order of 24–48 GiB with indexes, against an 8 GiB included quota. Move to 30–90 day raw retention (see the decision in F7a), keep daily aggregates for the longer experiment window, and partition `feed_events` and `feed_delivery_facts` monthly by `ranked_at`. Add fact-table bytes, growth per day and retention lag to monitoring.

---

### F8 — Per-request GoTrue round-trip

**Status:** TODO · **Severity:** Medium · **Surface:** server

`getServerAuthState` (`src/lib/supabase-server.ts:81-113`) calls `auth.getUser()` over the network plus a service-role credits read on every authenticated RSC render and API call; middleware does no token work. Verify JWTs locally using Supabase asymmetric signing keys for reads, and keep the hard GoTrue check for sensitive mutations. Colocation makes this a resilience fix more than a latency one.

---

### F9 — Comments scan loop and unindexed top sort

**Status:** TODO · **Severity:** Medium · **Surface:** server + migration

`src/lib/post-comments-service.ts:301-345` loops range-reads until enough visible rows accumulate, issuing two `user_blocks` queries per iteration with no iteration cap. The `sort=top` path orders by `reply_count DESC` with no covering index, so it sorts in memory. Hoist the block filter into the query or an RPC, cap iterations, and add a partial index on `(post_id, reply_count DESC, created_at DESC)` for top-level rows.

---

### F15b — Error tracking, PITR and log retention

**Status:** TODO · **Severity:** Medium · **Surface:** ops

There is no Sentry, PostHog or equivalent anywhere — web, mobile or server. Alerting is an hourly GitHub Actions watchdog email to a single recipient. There is no retained log drain, no PITR, no independent Storage recovery and no defined restore-time objective. Before meaningful paid scale: add error tracking on all three surfaces, five-minute external monitoring, a second incident recipient, retained logs, PITR, media recovery and quarterly restore drills.

Also add a **per-task provider-cost ledger** — the repo records app-credit charges but not Kie credits consumed, effective provider cost, payment fee, or storage/egress allocation per task. Contribution margin per model is unknowable without it, and provider spend is likely the largest total variable cost.

---

### Phase 1 certification test

**Status:** TODO

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
| 2026-08-09 | **F12 mostly landed.** Run creation is idempotent (`start_workflow_canvas_run` + a partial unique index on `(canvas_id, idempotency_key)`, key read from the `Idempotency-Key` header or the body), a durable `workflow_run_step_jobs` queue carries claims/leases/heartbeats/attempt caps/backoff modelled on `generation_completion_jobs`, a new `workflow-run-steps` cron job drains it and **adopts runs left unfinished with no live job**, and `getWorkflowRunDetails` is now a pure read. The key insight worth keeping: **the unique index does not stop the double-charge on its own** — `executeWorkflowRun` has to return *before* executing the graph when the RPC reports `reused`, or the second request still spends. Three further findings: the conflict path deliberately is not an upsert, because supabase-js's `merge-duplicates` would rewrite `graph_snapshot` on a run that may be mid-flight; the old insert never read its error, so a failed insert silently wrote every step against a null run; and deferral had to become its own verb, since a run waiting on a provider generation has not failed and charging that wait against the retry cap would exhaust a slow generation for no reason. Making the GET pure removed more than a write — it used to run `syncGenerationStatuses`, which polls the provider *and settles credits*, so a client refresh could start paid work. **Per-node executor deferred** (owner's call): the queue is keyed per node/attempt as specified, but a claimed job drives a run-scoped advance, so poison isolation is per-run rather than per-node. Both bugs the item was filed for are closed. Measured first: 11 lifetime runs, last on 2026-04-02, so nothing is accruing damage. | Claude Code |
| 2026-08-08 | **Phase 1 entry.** Phase 0 re-verified independently against the source (not the change log) before starting: all nine DONE rows check out. Fixed a board defect this pass — **every per-section `**Status:**` line still read TODO** while the board table said DONE, and the `**Landed:**` lines were empty; only the table had been maintained. Sections now carry their real status. F10 stays IN PROGRESS by design, with the carry-past-Phase-0 made explicit in the section so it does not read as an unfinished prerequisite. **Decision #3 resolved: Vercel plan is Pro** (`planIteration: plus`), read from the Vercel team billing API rather than inferred from the 10-minute cron. **Decision #4 resolved and recorded** as a new *Phase 1 entry baseline* section: Micro compute confirmed by memory fingerprint (the Management API exposes no compute size, the same blind spot F4 hit on the spend cap); connection pool sits at a **47% floor while idle**, so the certification gate's "below 70%" has ~23 points of real headroom, not 70; `track_io_timing` is **off**, so no IO-latency baseline exists or can be captured during the load test; and 429 GB of lifetime temp spill attributes entirely to catalog introspection, with every application RPC at zero temp blocks. The baseline also produced a finding the audit did not have: ranking RPCs by *total* time instead of mean shows **`list_marketplace_resource_bundles` is 47% of all RPC time** at ~1,000 shared-buffer reads per call — 19× the feed's call volume, invisible at 17 ms mean, and cheap today only because the whole database fits in `shared_buffers`. Filed as **F5b** (High, Phase 1), sequenced after F12/F14 but before certification. | Claude Code |
