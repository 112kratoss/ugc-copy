# Scaling Audit — 2026-08-08

Date: 2026-08-08
Document type: **living working document** — the findings are dated evidence, the status board is updated as work lands.
Baseline commit: `63b9a3b` (main)

This file is the single source of truth for scaling work. It is written to be **self-contained**: a fresh conversation should be able to open this file, pick one item, and execute it without any other context beyond `CLAUDE.md`.

---

## How to use this file

**Starting a phase in a new conversation:**

1. Open this file and read *Executive verdict*, *How to work an item*, and the phase you are executing.
2. Pick the next item whose status is `TODO` and whose prerequisites are met.
3. Set its status to `IN PROGRESS` before you start.
4. When it lands, set the status to `DONE`, fill in the **Landed** line (PR/commit + date), and add a line to the *Change log* at the bottom.

**Status values:** `TODO` · `IN PROGRESS` · `DONE` · `BLOCKED` · `WONTFIX`

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
| F4 | Spend cap posture + egress monitoring | Critical | 0 | TODO | |
| F1 | Watch surfaces stream full-bitrate source | Critical | 0 | TODO | |
| F2 | AI posts skip transcode; sweep 5/hour | Critical | 0 | TODO | |
| F3 | Immutable media cached for 300s | Critical | 0 | TODO | |
| F11 | Web `/feed` drops the ranking cursor | Critical | 0 | TODO | |
| F13 | v2 stats refresh starves past 1,000 rows | High | 0 | TODO | |
| F7a | Facts for all candidates; unbatched events | High | 0 | TODO | |
| F6 | Unthrottled hot GETs incl. full-catalog scan | Medium | 0 | TODO | |
| F15a | Monitoring truncates silently; biased rates | Medium | 0 | TODO | |
| F10 | Assorted small leaks | Low | 0 | TODO | |
| F12 | Workflow runs non-durable, non-idempotent | Critical | 1 | TODO | |
| F14 | Shared-fate cron; no provider admission control | High | 1 | TODO | |
| F5 | For-you RPC materializes whole catalog | High | 1 | TODO | |
| F7b | Fact retention + partitioning | High | 1 | TODO | |
| F8 | Per-request GoTrue round-trip | Medium | 1 | TODO | |
| F9 | Comments scan loop; unindexed top sort | Medium | 1 | TODO | |
| F15b | Error tracking, PITR, log drain | Medium | 1 | TODO | |
| — | Phase 1 certification load test | — | 1 | TODO | |
| F16+ | Phase 2 items | — | 2 | TODO | |

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

---

## How to work an item

Read `CLAUDE.md` first — it carries the commands, layering rules and migration conventions. The audit-specific constraints that are *not* in `CLAUDE.md`:

- **Only one local Supabase stack exists**, on fixed ports 54321/54322/54323. Any worktree running `supabase db reset --local` or `supabase test db` contends with every other one. **Do all migration work in one checkout at a time.**
- **Worktrees are the right unit for concurrent PRs, not for phases.** Phases are sequential. Cap concurrency at ~3 PRs, and pin migration work to a single checkout.
- **Mobile ships separately.** Merging mobile changes to `main` never reaches phones — that needs a manual `mobile-store-release` dispatch plus store review. Mobile-side work has a multi-week lead time, so **start mobile items first even though they land last**.
- Supabase CLI must be pinned: `npx --yes supabase@2.75.0`. Start with `-x edge-runtime --ignore-health-check`. Use `docker exec` for psql.
- Never run `npm run build` while a dev server is running — they share `.next`.
- Every new migration needs a matching `*-migration.test.ts` asserting its SQL content.

**Definition of done for any item:** `npm test`, `npm run lint`, `npm run typecheck` pass; migrations additionally pass `npx supabase db reset --local` and `npx supabase test db`; the status board above is updated; the change log has an entry.

---

## Phase 0 — media and feed-write hygiene

**Goal:** safe at 2,000 MAU, red-line 5,000. **Estimated effort:** ~1 week.

Suggested PR grouping (grouped by file collision, not by ID):

| PR | Contents | Where |
|---|---|---|
| 1. Media delivery — web | F1 web, F3, F10 studio grid | worktree |
| 2. Media delivery — mobile | F1 mobile viewer | worktree, **start first** |
| 3. Publish-time transcode | F2, with F6 and F15a as riders | worktree |
| 4. Feed write path | F11, F7a | worktree |
| 5. Migrations | F13, missing fact index | **primary checkout only** |

---

### F4 — Spend cap posture and egress monitoring

**Status:** TODO · **Severity:** Critical · **Surface:** dashboard + ops
**Landed:**

**Problem.** Supabase Pro enables the spend cap by default. With it on, exhausting the 250 GB egress quota degrades storage service rather than billing overage — at current media weight that is the literal outage line. Separately, the ops layer (`src/lib/backend-cost-report.ts`) budgets media-read *requests* and storage *growth* but never egress *bytes*, so the one meter that binds first is unmonitored.

**Fix.** No code required for the first half.

1. Open the Supabase dashboard and record the current spend cap setting in this file.
2. Decide posture deliberately. Cap **on** = hard stop, protects against surprise bills, risks mid-month outage. Cap **off** = app stays up, absorbs roughly $35–105/month at 2,000 MAU (cached egress $0.03/GB, uncached $0.09/GB). Recommendation: **off, with billing alerts**, since an outage costs more than the bill at this stage. *This is a business decision — confirm with the owner before changing.*
3. Add measured egress GB to the monthly review and divide by MAU. One real measurement replaces the entire estimation model in this document.

**Verify.** Cap setting recorded below; a calendar reminder or ops task exists for the weekly usage check.

**Record here:** cap setting as of ____________ = ____________

---

### F1 — Watch surfaces stream the full-bitrate source, never the rendition

**Status:** TODO · **Severity:** Critical · **Surface:** web + mobile
**Landed:**

**Problem.** The 720p/≤1.4 Mbps rendition exists and is used by feeds, but every surface where people actually *watch* resolves the raw source instead. This is 80–90% of all egress, and it means ~23 Mbps playback on Indian mobile networks.

**Evidence.**
- `ugc-mobile/app/viewer.tsx:1757` — immersive viewer streams `mediaItem.url`, unmuted, full source.
- `src/app/showcase/ShowcaseMediaCarousel.tsx:114` — detail and reel modes use `activeItem.url`; only feed mode calls `resolveFeedPlaybackUrl`.
- `src/app/showcase/[id]/ShowcaseDetailBody.tsx:334` — passes `mode="detail"`.
- `src/app/feed/FeedMediaLightbox.tsx:178` — passes `mode="reel"`.
- `src/app/profile/OwnerProfileMediaHub.tsx:262` — `HoverVideo` on full `mediaUrl`, never the rendition.

**Fix.** Use `renditionUrl || url` on every playback surface. The helper already exists: `resolveFeedPlaybackUrl` in `src/lib/media-descriptor.ts:65-70`. Keep the full source only for explicit download/remix actions. The `|| url` fallback makes this safe to ship before F2 — posts without a rendition simply behave as they do today.

**Verify.** Play a video on each surface with devtools network open and confirm the request path contains `.feed.<hash>.mp4`. On mobile, confirm via a proxy or by checking the resolved URI in the player config.

**Gotcha.** Split into two PRs: web ships in the next release, mobile needs a store release. Start the mobile half first.

---

### F2 — AI-generated posts skip transcoding; the repair sweep does 5 videos/hour

**Status:** TODO · **Severity:** Critical · **Surface:** server
**Landed:**

**Problem.** Publishing a generation to the showcase copies the raw provider MP4 (~23 Mbps) into the public bucket with no transcode. The only rendition path for these posts is the hourly repair sweep, which processes 5 videos sequentially — roughly 120/day. A burst of posts serves full-bitrate sources for hours or days.

**Evidence.**
- `src/lib/showcase-publish-service.ts:317-322` — `storage.copy()` with no rendition step.
- `src/lib/media-preview-repair.ts:22` — `RENDITION_REPAIR_BATCH_SIZE = 5`, processed sequentially (`:296-303`).
- `src/lib/post-publish-service.ts:407` — the classic path *does* create a rendition inline.
- `src/lib/video-rendition.ts:22-44` — encoder settings: 720×1280 max, CRF 30, 1400k cap, 64k mono audio, `+faststart`, 120 s timeout, discard unless output < 85% of source.

**Fix.** Enqueue rendition work at publish time for generation-sourced posts, reusing the existing repair pipeline rather than transcoding inline (the publish request should stay fast). Raise the sweep batch size with bounded concurrency — but see the gotcha.

**Verify.** Publish a generated video and confirm a `.feed.<hash>.mp4` object appears without waiting for the hourly sweep.

**Gotcha.** Raising sweep concurrency interacts with F14 — the sweep runs inside the shared 300 s cron invocation alongside every other job, and ffmpeg is memory-hungry. Do not raise concurrency past 2–3 until the queues are split in Phase 1.

---

### F3 — Immutable, content-hashed media is cached for 300 seconds

**Status:** TODO · **Severity:** Critical · **Surface:** server
**Landed:**

**Problem.** A single constant sets a 5-minute TTL on every public media write, including derivatives whose filenames embed a content hash and therefore can never change. Returning visitors re-download posters and clips they already have, and the CDN revalidates constantly.

**Evidence.**
- `src/lib/showcase-media-cache.ts:10` — `SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL = '300'`.
- Applied at: `src/lib/post-media-preview.ts:59` and `:109`, `src/lib/post-media-rendition.ts:83`, `src/lib/post-publish-service.ts:376`, `src/lib/showcase-publish-service.ts:321`, `src/lib/generation-media-preview.ts:90`.
- Client-side upload headers: `src/lib/signed-url-upload.ts:143`, `ugc-mobile/lib/upload-file.ts:135`.
- `next.config.ts:143` — `images.minimumCacheTTL` also 300.
- Hashed derivative naming: `src/lib/post-media-rendition.ts:31-37` (`.feed.<hash>.mp4`), `src/lib/post-media-preview.ts:18-24` (`.preview.<hash>.webp`).

**Fix.** Split the constant. Use `public, max-age=31536000, immutable` for content-hashed derivatives; keep a short TTL only for mutable originals. Raise `images.minimumCacheTTL` correspondingly.

**Verify.** Upload a new post, then check the `cache-control` response header on its `.preview.<hash>.webp`.

**Gotcha — this will otherwise look like the fix did nothing.** `cacheControl` is stored as object metadata **at upload time**. Changing the constant only affects newly written objects; the existing 439 objects keep `max-age=300` until rewritten. Budget a backfill pass over `showcase_media` in the same PR — the repo already has `backfill:*` scripts for media/preview work that are the natural place to hang it.

**Related.** Supabase's Smart CDN guidance notes that fresh signed tokens create distinct cache keys, which is a second reason to prefer public immutable derivatives over signed URLs for public media.

---

### F11 — Web `/feed` drops the ranking cursor

**Status:** TODO · **Severity:** Critical · **Surface:** web
**Landed:**

**Problem.** Feed pagination sends offset only, so any page loaded outside the server's short session-reuse window re-runs the full ranking RPC and persists a brand-new session (1 `feed_sessions` row + up to 60 `feed_session_items` + up to 60 `feed_delivery_facts` = up to 121 rows). Three pages can write ~363 rows instead of 121. Offset-into-a-fresh-ranking is also why items repeat across pages — the client already dedupes this symptom.

**Evidence.**
- `src/app/feed/FeedClient.tsx:171-175` — request params are `limit`, `offset`, `sort` only; no cursor.
- `src/app/feed/FeedClient.tsx:109` — state keeps `nextOffset` only. The feed session id is carried (`:116`) but for event attribution, not pagination.
- `src/lib/showcase-feed-personalization.ts:84-85` — `FEED_SESSION_REUSE_TTL_MS = 120000`; the bug is invisible for fast scrollers and hits everyone else.
- `src/lib/showcase-feed-personalization.ts:914` — `encodeRankedFeedCursor`, the cursor that should be threaded.
- Correct implementations to copy: `ugc-mobile/lib/showcase-feed-query.ts:139-152` (cursor first, offset fallback), and the showcase web client.

**Fix.** Thread `pageInfo`'s continuation cursor through `/feed` load-more for the ranked lanes (`for-you`, `unlocks`), falling back to offset for non-ranked sorts.

**Verify.** Scroll `/feed` past three pages with more than two minutes elapsed, then confirm in the database that only one `feed_sessions` row was created for the scroll.

---

### F13 — v2 stats refresh permanently starves rows past the first 1,000

**Status:** TODO · **Severity:** High · **Surface:** migration
**Landed:**

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

---

### F7a — Facts are written for all ranked candidates; events are unbatched

**Status:** TODO · **Severity:** High · **Surface:** server + clients
**Landed:**

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

**Decision needed before implementing:** raw fact retention of 30 vs 90 days. Ninety days gives a full quarter of experiment lookback; thirty cuts storage roughly threefold. This shapes the partition and aggregate design in F7b. **Owner's call.**

---

### F6 — Unthrottled hot GETs, including a full-catalog scan

**Status:** TODO · **Severity:** Medium · **Surface:** server
**Landed:**

**Problem.** The rate-limit framework covers writes well but leaves expensive reads open. Notably `sort=top-sales` scans *every* public post per call.

**Evidence.** No `enforceBackendRateLimit` in the path for: `/api/showcase/feed` on every sort except `for-you` (`src/lib/showcase-feed-route-adapter-service.ts:109-126` limits `for-you` only); `/api/showcase/posts/[postId]`; the comments GET (`src/lib/post-comments-route-adapter-service.ts:91-93`); `/api/generations` (`src/lib/owner-generations-route-adapter-service.ts:39-62`, the target of the app-wide 30 s poller); `/api/creators/[username]`. The scan: `src/lib/showcase-feed.ts:682-686` — `mustScanAllCandidates` for `top-sales`.

**Fix.** Extend the existing limiter (`src/lib/backend-rate-limit.ts`) to these GETs with generous limits — the salted-IP anonymous keying already exists in `src/lib/showcase-feed-identity.ts:64-66`. Precompute the top-sales ranking into `post_feed_stats` alongside the other windows.

**Verify.** Hammer each endpoint past its limit and confirm a 429.

**Longer term.** Every rejected request currently still costs a Postgres write transaction, which makes the limiter its own load generator under abuse. Moving coarse read-limiting to edge/KV is a Phase 2 item; keep Postgres limits for credits, purchases and business-critical quotas.

---

### F15a — Monitoring truncates silently and computes biased failure rates

**Status:** TODO · **Severity:** Medium · **Surface:** server
**Landed:**

**Problem.** Monitoring becomes *more optimistic* precisely as traffic grows. Cost and health collectors cap their raw queries with no truncation signal, so past the cap the reports silently describe a sample as if it were the population. Separately, provider failure percentages are computed over a table that only records failures and slow calls, so the rate is structurally wrong.

**Evidence.**
- `src/lib/backend-cost-report.ts:700-709` — five parallel queries each `.limit(QUERY_LIMIT)` (5,000) with no count or truncation flag.
- Health collectors cap generations and provider events at 1,000, completion queue at 200.
- `src/lib/provider-fetch.ts:131-141` — a `provider_fetch` event is persisted **only** when the call failed or exceeded 15 s. Any failure rate over `provider_dependency_events` is therefore an exception-biased population.

**Fix.** Replace raw downloads with database-side time-bucketed aggregates returning total attempts, successes, failures, timeouts, cost, bytes, queue age, retention lag, and an explicit truncation status. Fix the failure-rate denominator by recording total attempt counts (a counter is enough — do not persist every success row).

**Verify.** Force a window with more than 5,000 rows and confirm the report flags truncation rather than under-reporting.

---

### F10 — Assorted small leaks

**Status:** TODO · **Severity:** Low
**Landed:**

- **Owner studio grid** — `src/app/creations/CreationMediaFrame.tsx:117-128`: 36 `<video preload="metadata">` tiles with `src` always attached and no viewport gating, against *signed* URLs which cache poorly (uncached egress is 3× cached). Use posters plus `preload="none"`.
- **Unoptimized full-res images** — `src/app/creators/[username]/page.tsx:84-104` renders cover and avatar as raw eager `<img>` at full source; detail/reel images bypass `next/image` at `ShowcaseMediaCarousel.tsx:489-514`.
- **Mobile 404 fallback** — `ugc-mobile/lib/api-client.ts:611-613` refetches a 48-item feed to locate one post.
- **Webhook import budget** — the finished-video download and re-upload runs via `after()` inside `/api/webhooks/kie`, whose `maxDuration` is 60 s, with a 60 s fetch timeout. Large videos always fall through to the 10-minute cron. Raise the duration or hand off to the queue unconditionally.
- **Web feed DOM growth** — `/feed` keeps every loaded card mounted and serializes the whole accumulated feed to `sessionStorage` on change; approaches browser limits around 50–100 cards. Window the list and debounce the snapshot to an idle callback.
- **Payload weight** — decoded HTML runs 447–641 KiB with roughly 246 KB of duplicated inline CSS/Flight data from `experimental.inlineCss` (`next.config.ts:107-109`). Add both compressed and decoded budgets, and A/B disabling inlining.

---

## Phase 1 — durability and certification

**Goal:** certify 10,000–25,000 MAU **by load test, not by assertion**. **Estimated effort:** 2–4 weeks. Do not start before Phase 0 lands.

---

### F12 — Workflow runs are non-durable and non-idempotent

**Status:** TODO · **Severity:** Critical · **Surface:** server

**Problem.** This is a money bug. Run creation has no idempotency binding, so a timed-out client retry creates a duplicate run that re-charges every node's generation. Per-generation idempotency does not help, because each new run legitimately starts new generations. Progress depends on a process-local map plus client polling, and the cron registry contains **no workflow job** — so a recycled function strands the run with no server-side recovery. A GET can also advance workflow state, meaning polling is not read-only.

**Evidence.**
- `src/lib/workflow-runner.ts:895-907` — plain insert into `workflow_canvas_runs`, no idempotency key or unique constraint.
- `src/lib/workflow-runner.ts:1254-1291` — `monitorWorkflowRun` uses a module-level `activeWorkflowRunMonitors` map and a delay loop.
- `src/lib/backend-jobs.ts:168-264` — the job registry has no workflow entry.

**Fix.** Unique `(canvas_id, idempotency_key)` on run creation. Move execution to a durable step queue: one idempotent job per node and attempt, unique `(run_id, node_id, attempt)`, `SKIP LOCKED` claims, heartbeats, retry timestamps, completion events enqueuing dependents transactionally. Make GET endpoints pure reads. **The in-repo pattern to copy is `generation_completion_jobs`** (`supabase/migrations/20260621111546_generation_completion_jobs.sql` plus `src/lib/generation-completion-jobs.ts`) — it already does claims, backoff, attempt caps and refund-on-exhaustion correctly.

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
| 1 | Spend cap: on (outage risk) or off (bill risk) | owner | immediately | |
| 2 | Raw feed-fact retention: 30 or 90 days | owner | before F7a | |
| 3 | Confirm Vercel plan is Pro (10-min cron implies it) | — | before F14 | |
| 4 | Confirm Supabase compute tier and capture CPU/IO/pool baselines | — | before Phase 1 | |

---

## Change log

| Date | Change | By |
|---|---|---|
| 2026-08-08 | Initial audit; all items TODO. Baseline commit `63b9a3b`. | Claude Code |
