# Feed algorithm v3 — what we take from X's For You algorithm

_Status 2026-10-12: shipped in #442 (`2f832f85`) and v3 activated in production at 04:26 UTC; v1 baseline recorded in the ops runbook's history. Continued by `feed-algorithm-v4-industry-parity-2026-10-12.md`._

_Date: 2026-10-11. Design and implementation contract. Inputs: `docs/research/x-algorithm-analysis-2026-10-11.md` (X, commit cb45b55) and `docs/research/magicbooklet-feed-ranking-analysis-2026-10-11.md` (ours, at 31634288). Production was read once, read-only, on 2026-10-11: v1 `active` since 2026-07-11, v2 `shadow` since 2026-07-28, no experiment ever created; 39 posts from 4 creators, 7 follows, ~16 weekly viewers, 5,154 impressions / 875 quick skips / 9 saves / 51 remix starts in 30 days, 0 embeddings._

## 1. Decision

Ship `for-you-rules` **v3** as a new `shadow` version plus the operational path to turn it on. v3 = v2's machinery (facts-based rates, strict unseen-first, UCB, capped creator prior) + the X mechanisms that transfer to a Postgres/TypeScript feed with thousands of interactions + three live-ranker bug fixes. No learned model: at this volume smoothed rates beat anything trainable (X analysis §7, §10).

What X does that we adopt, in X's form → ours:

| # | X mechanism (value) | Ours (v3) |
|---|---|---|
| 1 | Author-diversity decay `0.75·0.5^k + 0.25` (vm-ranker) | Same multiplier on the ranked list, k = same-creator posts ranked above. Hard caps stay as a backstop (`max_creator_per_20` 2 → 3). |
| 2 | Out-of-network ×0.75 | `×out_of_network_multiplier` (0.75) when the viewer does not follow the creator. |
| 3 | Net-negative sink: `score<0 → (score+N)/T·0.001`, else `score+0.001` | Same offset before any multiplier, so a multiplier can never lift a net-negative post above a net-positive one. Only applied when a multiplier is configured, so v1/v2 scores are unchanged. |
| 4 | One Thompson-sampled cold-start slot per request lifted to rank 16/35: post ≤2 h, <200 views, `Beta(0.75+likes, 49.25+views−likes)`, top-2 by θ then higher score | One slot per ranking lifted to rank 6/60 (first page): post ≤168 h, author <60 rendered deliveries in 30 d, `θ~Beta(7.5+m, 42.5+r−m)` over the post's rendered/meaningful counts, top-2 by θ then higher score. Seeded from `feed_sessions.random_seed` (written, never read until now) so a session is reproducible. |
| 5 | Cold candidate source (≤2 h, <8 likes, <500 views, 200 slots) | `cold` pool: ≤168 h old, author <60 rendered in 30 d, 50 slots, label `cold`, reason "New from the community". |
| 6 | Popular posts ranked by projected 24 h views, λ=ln2/8 h, ≤5 per author | Trending pool ordered by `meaningful_rate_24h × ln(1+projected_24h_renders)/ln(101)`, ≤5 per author. |
| 7 | Seen and served handled separately (served ≤10 min for pagination) | `served_recently` = a delivery fact for this viewer in the last 6 h → `×served_penalty` (0.5). Seen (qualified impression, 14 d) keeps v2's hard tier. |
| 8 | Visibility separate from ranking; severity order; first drop wins; not-evaluated → drop; 26 recommendation-only rules for non-followers | `src/lib/feed-visibility.ts`: ordered rules, level `home` for followed creators and `recommendations` for everyone else, reason codes, fail closed. Blocks move **before** ranking and persistence. Cheap global rules also move into the SQL predicate. |
| 9 | Report/hide propensities dominate (report −234 vs like 0.5) | `negative_feedback_risk` weight −0.80 → **−2.5**, and the dead `report` event term is replaced by `post_reports` in the 7-day window. A viewer's own report writes a `feed_user_post_feedback` row (hard exclusion). Recommendation-only drops: post risk > 0.12, creator smoothed negative rate > 0.08 (agatha-style rate per author). |
| 10 | Bounded sources (48 h windows) | `max_age_days` 365 bounds every pool — cost, not freshness (X's 48 h cutoff is explicitly not borrowed: the catalog is 39 posts). This closes v2's "unbounded `eligible` CTE" promotion gate. |
| 11 | Params in config, production defaults mirrored in code, kill switches | Everything above is a key in the version row's JSON with TypeScript defaults that reproduce v1/v2 exactly; parity tests pin TS defaults to the seeded rows; `seen_lookback_days=0`, `author_decay=1`, `out_of_network_multiplier=1`, `cold_start_slot_rank=0` are kill switches. |
| 12 | Operability (feature switches, A/B history) | `npm run ops:feed-algorithm -- list | scorecard | activate | experiment start|stop`, backed by service-role-only RPCs. Today no code path can activate a version or create an experiment. |

Live-ranker fixes shipped alongside (affect v1 the moment the migration applies):

- **v1 stats windows collapse to ~2 days**: `refresh_post_feed_stats` counts only events with `session_item_id IS NOT NULL`; sessions are pruned 2 d after expiry and the trigger nulls that column. Switch to `delivery_fact_id IS NOT NULL` (the interest refresh already did, `20261005170739`).
- **`creator_quality` is 0 for authors with no stats row and 0.15 for everyone else** — a penalty on new authors. v3 uses `LEAST(cap, COALESCE(rate, creator_prior_mean))`.
- **Blocks apply after ranking and after facts are written**, consuming session slots and shortening pages. v3 excludes blocked creators in SQL and in the visibility stage.

Not adopted, and why: Phoenix (needs ~10¹¹ samples), SimClusters (needs a dense graph), DPP over multimodal embeddings (our embeddings table is empty — Phase 2 of `feed_algorithm_v2.md`), Thunder/Kafka (Postgres does this), ads blending, X's absolute weights (they encode X's base rates), the 48 h hard cutoff, weight perturbation and like-scaled holdouts (no traffic to measure them). Deferred follow-ups are in §6.

## 2. Contract — SQL (one migration, stamped with `date -u +%Y%m%d%H%M%S`)

File: `supabase/migrations/<stamp>_feed_ranking_v3_x_adoption.sql`. Never literal ranking weights in SQL (the v1 `ORDER BY` duplication is the anti-pattern). All functions `SECURITY INVOKER`, `SET search_path = public, pg_temp`, bounds checked with `RAISE EXCEPTION` like v2.

1. `ALTER TABLE public.creator_feed_stats ADD COLUMN negative_feedback_count bigint NOT NULL DEFAULT 0 CHECK (negative_feedback_count >= 0), ADD COLUMN negative_feedback_rate double precision NOT NULL DEFAULT 0 CHECK (negative_feedback_rate BETWEEN 0 AND 1 AND negative_feedback_rate <> 'NaN')`. Re-create `refresh_creator_feed_stats` (copy the body from `20260808130000_feed_ranking_v2_starvation_free_refresh.sql`) so it also fills them: `negatives = count(facts with not_interested_at or hid_creator_at) + 2 × post_reports on the creator's posts in the window (status <> 'dismissed')`; `rate = (negatives + 0.2) / (rendered + 20)`.
2. Re-create `refresh_post_feed_stats` (body from `20260711064036_feed_personalization_system.sql:1311-1518`) with every `session_item_id IS NOT NULL` predicate replaced by `delivery_fact_id IS NOT NULL`. Nothing else changes.
3. `get_ranked_feed_candidates_v3(...)`: v2's parameters (`20260728181000_feed_ranking_v2.sql:542-555`) plus
   `p_cold_limit integer DEFAULT 50`, `p_cold_max_age_hours integer DEFAULT 168`, `p_cold_impression_threshold integer DEFAULT 60`, `p_max_age_days integer DEFAULT 365`, `p_served_lookback_hours integer DEFAULT 6`, `p_trending_per_author_cap integer DEFAULT 5`, `p_creator_prior_mean double precision DEFAULT 0.15`.
   Bounds: limits 0–500, hours 0–8760, days 1–3650, cap 1–50, prior 0–1.
   **RETURNS TABLE** = v2's 16 columns (same names, same order) **plus**
   `served_recently boolean, is_following boolean, author_rendered_30d bigint, post_rendered_30d bigint, post_meaningful_30d bigint, post_age_hours double precision, reports_7d bigint, sources text[]`.
   - `eligible` adds: `p.created_at >= p_as_of - make_interval(days => p_max_age_days)`, `p.is_nsfw = false`, `p.user_id IS DISTINCT FROM p_viewer_user_id`, `NOT EXISTS user_blocks` in either direction, `NOT EXISTS post_reports WHERE reporter_user_id = viewer AND post_id = p.id`. Keep v2's feedback predicates and `seen` join.
   - `served AS MATERIALIZED`: `feed_delivery_facts` with `served_at >= p_as_of - make_interval(hours => p_served_lookback_hours)` for the viewer (user id, or anonymous hash when signed out), `GROUP BY post_id`. Needs an index: check `feed_delivery_facts_viewer_ranked_idx` covers `(viewer_user_id, served_at)`; add a partial index on `(anonymous_key_hash, served_at DESC) WHERE anonymous_key_hash IS NOT NULL` if none exists.
   - Pools and dedup priority: `following` 1, `cold` 2, `affinity` 3, `trending` 4, `fresh` 5, `exploration` 6. Every pool orders by `seen_recently ASC` first (as v2). `cold`: `created_at >= p_as_of − cold_max_age_hours AND COALESCE(author_rendered_30d, 0) < p_cold_impression_threshold`, newest first. `trending`: `ROW_NUMBER() OVER (PARTITION BY creator_id ORDER BY velocity DESC) <= p_trending_per_author_cap`, where `velocity = meaningful_engagement_rate_24h × LEAST(1, ln(1 + projected) / ln(101))`, `projected = rendered_24h × (1 − exp(−λ·24)) / (1 − exp(−λ·GREATEST(age_hours, 0.5)))`, `λ = ln(2)/8`.
   - Dedup returns **all** sources: `array_agg(DISTINCT source ORDER BY priority)` → `sources`; `candidate_source` = the first.
   - Features: v2's, except `negative_feedback_risk = LEAST(1, (not_interested_7d + hide_creator_7d + 2·reports_7d + 0.2) / (rendered_7d + 20))` with `reports_7d` from `post_reports` (`created_at` in the 7-day window, `status <> 'dismissed'`); `creator_quality = LEAST(p_creator_prior_cap, COALESCE(cs.quality_rate, p_creator_prior_mean))`; `relevant_trend` = the velocity expression above (clamped to [0,1]). `author_rendered_30d` = `creator_feed_stats` 30d `rendered_count` (0 when no row). `post_rendered_30d`/`post_meaningful_30d` come from the posterior CTE v2 already computes.
   - No global `ORDER BY` score, no `LIMIT` beyond the per-pool limits. Grants mirror v2's.
4. `activate_feed_algorithm_version(p_version_id uuid) RETURNS jsonb`: target must exist with status in (`draft`,`shadow`); in the same statement set the current `active` row of the same `algorithm_key` to `retired` (`retired_at = now()`), then the target to `active` (`activated_at = now()`); return `{previous_active_id, activated_id, algorithm_key, version}`. `REVOKE ALL ... FROM PUBLIC, anon, authenticated` (service role only).
5. `create_feed_experiment(p_experiment jsonb, p_variants jsonb) RETURNS jsonb`: inserts one `feed_experiments` row (`experiment_key`, `status` default `running`, `traffic_basis_points` 1–10000, `assignment_salt` default `gen_random_uuid()::text`, `starts_at` default now, `ends_at` nullable) and its variants (`variant_key`, `algorithm_version_id` must exist with status in (`active`,`shadow`), `allocation_basis_points` summing to exactly 10000). Returns ids. `set_feed_experiment_status(p_experiment_id uuid, p_status text) RETURNS jsonb` for `paused|completed|cancelled|running`. Both service role only.
6. `feed_algorithm_scorecard(p_days integer DEFAULT 7) RETURNS TABLE(algorithm_version_id uuid, algorithm_label text, experiment_variant_id uuid, variant_key text, candidate_source text, served bigint, rendered bigint, qualified bigint, meaningful bigint, quick_skips bigint, negatives bigint, saves bigint, remix_starts bigint, distinct_viewers bigint, repeat_exposures bigint, avg_position double precision)` over `feed_delivery_facts` with `served_at >= now() − p_days` (p_days 1–30). `meaningful` uses `is_meaningful_feed_engagement`; `negatives` = `not_interested_at`/`hid_creator_at`/`reported_at` set; `repeat_exposures` = facts whose viewer had a qualified impression of the same post in the 14 days before `served_at`; `distinct_viewers` counts `COALESCE(viewer_user_id::text, anonymous_key_hash)`. Service role only.
7. Seed `for-you-rules` **v3**, `status='shadow'`, description "X-adoption: author-diversity decay, out-of-network discount, Thompson cold-start slot, cold pool, velocity trending, served-recently penalty, net-negative sink, visibility stage with recommendation-only rules, report-aware negatives." JSON:
   ```json
   weights: {"interest_match":0.24,"creator_affinity":0.12,"smoothed_usefulness":0.10,"engagement_depth":0.22,"attention_seconds_norm":0.08,"freshness":0.12,"relevant_trend":0.08,"creator_quality":0.06,"exploration_ucb":0.10,"exploration_bonus":0.0,"quick_skip_risk":-0.30,"negative_feedback_risk":-2.5}
   retrieval_config: {"candidate_rpc":"v3","following_limit":100,"interest_limit":150,"trending_limit":100,"recent_limit":150,"exploration_limit":100,"cold_limit":50,"cold_max_age_hours":168,"cold_impression_threshold":60,"max_age_days":365,"served_lookback_hours":6,"trending_per_author_cap":5,"seen_lookback_days":14,"seen_penalty":0.2,"creator_prior_cap":0.15,"creator_prior_mean":0.15,"exploration_confidence":1.5,"session_item_limit":60,"recommendation_max_post_negative_risk":0.12,"recommendation_max_creator_negative_rate":0.08}
   diversity_config: {"max_creator_per_20":3,"max_semantic_cluster_per_20":3,"exploration_per_10":1,"max_paid_share":0.20,"author_decay":0.5,"author_decay_floor":0.25,"out_of_network_multiplier":0.75,"served_penalty":0.5,"cold_start_slot_rank":6,"cold_start_max_age_hours":168,"cold_start_impression_threshold":60,"cold_start_prior_mean":0.15,"cold_start_prior_strength":50}
   ```
   The weights are starting points; the scorecard decides the tuning. The −2.5 is derived from our own counts: one report among 20 rendered deliveries must sink a post below an unremarkable one (−2.5 × (2 + 0.2)/40 = −0.14 against a typical +0.3–0.6), which −0.80 could not do.
8. Tests: `src/__tests__/feed-ranking-v3-migration.test.ts` (SQL text, in the style of `feed-ranking-v2-migration.test.ts`: every function, every new column, no literal weights in an `ORDER BY`, the seeded JSON equals the TS defaults the ranking agent exports — import them) and `supabase/tests/database/feed_ranking_v3_candidates.test.sql` (pgTAP: fixtures for a viewer, a followed creator, a blocked creator, the viewer's own post, an NSFW post, a post the viewer reported, a 1-hour-old post from an unexposed author, a post with a served-but-unseen fact 1 h ago; assert the exclusions, `is_following`, `sources @> '{cold}'`, `served_recently`, that `activate_feed_algorithm_version` swaps statuses atomically and refuses an `active` target, and that `create_feed_experiment` rejects allocations ≠ 10000). `auth.users` fixtures must set `created_at`.

## 3. Contract — TypeScript ranking core

Files: `src/lib/showcase-feed-ranking.ts`, new `src/lib/feed-visibility.ts`, `src/lib/showcase.ts` (only: add `'cold'` to `ShowcaseFeedCandidateSource`). Rule: **a config without the new keys must rank byte-for-byte as today** — add a test that runs a fixed fixture through v1 and v2 configs before and after and compares the full output, including `score`.

- `RankedFeedFeatureRow` gains `isFollowing: boolean` (default false), `servedRecently: boolean` (false), `authorRendered30d: number | null` (null = unknown → not cold-start eligible), `postRendered30d: number`, `postMeaningful30d: number` (0), `postAgeHours: number | null`, `reports7d: number` (0), `sources: ShowcaseFeedCandidateSource[]` (default `[candidateSource]`). `normalizeRankedFeedFeatureRow` reads the snake_case RPC columns; unknown source labels still become `fresh`, and `cold` gets reason text "New from the community".
- `RankedFeedDiversityConfig` gains `authorDecay` (default 1), `authorDecayFloor` (1), `outOfNetworkMultiplier` (1), `servedPenalty` (1), `coldStartSlotRank` (0 = off), `coldStartMaxAgeHours` (168), `coldStartImpressionThreshold` (60), `coldStartPriorMean` (0.15), `coldStartPriorStrength` (50); snake_case JSON keys as in §2.7; bounds: decays and multipliers in [0,1], slot rank integer in [0,60], hours 1–8760, threshold 0–100000, prior mean (0,1), strength 1–1000.
- `rankAndDiversifyShowcaseItems(items, weights, diversity, options)` where `options = { seed: number, seenPenalty }` (keep the current signature working through an overload or an options object with defaults). Pipeline per item:
  1. `base = Σ w·clamp01(f)` (unchanged).
  2. If any multiplier is active (`authorDecay<1 || outOfNetworkMultiplier<1 || servedPenalty<1 || coldStartSlotRank>0`): `offset(base) = base ≥ 0 ? base + 0.001 : ((base + N)/T)·0.001`, `N = Σ|negative weights|`, `T = N + Σ positive weights`. Otherwise `offset(base) = base` (v1/v2 unchanged).
  3. `× seenPenalty` if `seenRecently` (existing), else `× servedPenalty` if `servedRecently`.
  4. `× outOfNetworkMultiplier` if `!isFollowing`.
  5. Author decay: order by the score so far, `k` = same-creator items above, `× ((1 − floor)·decay^k + floor)`, then re-sort. X's table for decay 0.5 / floor 0.25: k=0 → 1, 1 → 0.625, 2 → 0.4375, 3 → 0.34375 — pin it in a test.
  6. Existing greedy diversity (seen tier, caps, exploration quota) over the multiplied scores.
  7. Cold-start slot (if `coldStartSlotRank > 0`): eligible = `!seenRecently && postAgeHours ≤ coldStartMaxAgeHours && authorRendered30d !== null && authorRendered30d < coldStartImpressionThreshold`. For each eligible item draw `θ ~ Beta(α0 + m, β0 + max(0, r − m))` with `α0 = priorMean·strength`, `β0 = (1 − priorMean)·strength`, `m = postMeaningful30d`, `r = postRendered30d`, using a deterministic PRNG seeded with `options.seed` (mulberry32 → Marsaglia–Tsang gamma → beta; put it in `src/lib/feed-thompson.ts` with its own test: same seed → same draws, mean of 10k draws within 0.01 of α/(α+β)). Take the top 2 by θ and pick the higher score — before the greedy pass. From the slot's rank on, the greedy pass takes the pick at the first position where the same diversity checks allow it (never a same-creator pair, never displacing a quota-forced exploration post), so the lift cannot undo a rule the pass enforces. Eligibility also requires the post was not served recently (a quick skip is sent instead of an impression, so "unseen" alone would re-lift a skipped post every session). Exactly one per ranking; none when nothing is eligible.
- Score components per item (for `score_components` on facts): `base`, `offset`, `seenPenalty|servedPenalty` applied, `oonMultiplier`, `authorDecay: {k, multiplier}`, `coldStart: {theta, lifted}` when relevant. Export a pure `explainRankedFeedScore(item)` that the wiring uses.
- `src/lib/feed-visibility.ts` (pure, no I/O):
  ```ts
  export type FeedVisibilityLevel = 'home' | 'recommendations';
  export type FeedVisibilityReason =
    | 'post_not_public' | 'post_archived' | 'post_not_visible' | 'self_post' | 'blocked'
    | 'hidden_post' | 'hidden_creator' | 'reported_by_viewer' | 'nsfw'
    | 'creator_negative_feedback' | 'post_negative_feedback' | 'not_evaluated';
  export type FeedVisibilityCandidate = { postId; creatorId; visibility; archivedAt; reviewStatus; isNsfw;
    negativeFeedbackRisk: number | null; creatorNegativeFeedbackRate: number | null };
  export type FeedViewerRelations = { viewerUserId: string | null; followingCreatorIds: Set<string>;
    blockedCreatorIds: Set<string>; hiddenPostIds: Set<string>; hiddenCreatorIds: Set<string>; reportedPostIds: Set<string> };
  export type FeedVisibilityThresholds = { recommendationMaxPostNegativeRisk: number; recommendationMaxCreatorNegativeRate: number }; // defaults 1 and 1 = off
  export function evaluateFeedVisibility(c, relations | null, thresholds): { action: 'show' | 'drop'; reason: FeedVisibilityReason | null; level: FeedVisibilityLevel };
  export function filterFeedVisibility(items, relations | null, thresholds): { kept; dropped: Array<{ postId; reason }> };
  ```
  Level = `followingCreatorIds.has(creatorId) ? 'home' : 'recommendations'`. Rules run in the order listed above; the first drop wins; `relations === null` (a read failed) → every item drops with `not_evaluated` (fail closed, as the current feedback filter does). `nsfw` drops at both levels — X lets followers see it blurred; our product decision (For You never shows NSFW) is unchanged and recorded here. The two negative-feedback rules are recommendation-level only.
- Tests: `src/__tests__/showcase-feed-ranking-v3.test.ts`, `feed-visibility.test.ts`, `feed-thompson.test.ts`. Export the v3 default JSON objects (`FOR_YOU_RULES_V3_*`) from the ranking module so the migration test can pin the seeded row to them.

## 4. Contract — ops CLI

`scripts/ops/feed-algorithm.ts` (pattern: `scripts/ops/generation-model-catalog.ts` — service-role client, read-only unless `--apply`, prints a plan first, never prints secrets), `package.json` script `"ops:feed-algorithm": "tsx --env-file-if-exists=.env.local scripts/ops/feed-algorithm.ts"`. Commands:

- `list` — versions (key, version, status, activated_at, description) and experiments with variants and allocations.
- `scorecard [--days 7] [--by version|source]` — calls `feed_algorithm_scorecard`, prints per version/variant rows with derived rates: rendered/served, qualified/rendered, meaningful/rendered, quick-skip/rendered, negatives per 1k rendered, saves and remix starts per 1k rendered, repeat-exposure share, distinct viewers, mean position. Raw numerators and denominators stay visible.
- `activate --key for-you-rules --version 3 --apply` — resolves the id, shows the swap, calls `activate_feed_algorithm_version`.
- `experiment start --key <k> --control <version> --treatment <version> [--traffic-bps 10000] [--treatment-bps 5000] --apply` → `create_feed_experiment`; `experiment stop --key <k> [--status completed] --apply` → `set_feed_experiment_status`.
- Tests: `src/__tests__/feed-algorithm-ops.test.ts` with a mocked client — parsing, the `--apply` guard, exact RPC payloads, rate arithmetic. Runbook: `docs/feed-algorithm-operations.md` (how to read the scorecard, promote, roll back by re-activating v1, the kill-switch keys, and why an A/B at 16 weekly viewers cannot reach significance: use the scorecard as a before/after guardrail read, not a significance test).

## 5. Contract — wiring (after §2 and §3 land)

`src/lib/showcase-feed-personalization.ts`: `normalizeRetrievalConfig` accepts `candidate_rpc: 'v3'` and the §2.3 keys with bounds; the v3 RPC call passes them; new columns flow through `normalizeRankedFeedFeatureRow`; the viewer's relations are loaded once per request (`followingCreatorIds` from the candidates' `is_following`, blocked ids via the existing `loadBlockedCreatorIds`, hidden sets from the existing feedback reads, reported ids from `post_reports` for the candidate post ids) and `filterFeedVisibility` runs **before** scoring and again in `loadPersistedPage`; the session `random_seed` is generated before ranking and passed as `options.seed`; `score_components` carries `explainRankedFeedScore`. Recent top-up items get `sources: ['fresh']`. `src/lib/post-report-service.ts`: after a signed-in user's report is stored, call `set_feed_post_feedback(reporter, post, true, 'reported')` through the service client (the RPC is revoked from `authenticated`). `showcase-feed.ts`'s post-ranking block filter stays as defence in depth. Update `showcase-feed-personalization.test.ts` and the report-service tests; add a status note to `docs/plans/feed_algorithm_v2.md` pointing here; index the two research docs and this plan in `docs/README.md`.

## 6. Deferred (not in this change)

- Home telemetry: Home emits no dwell, progress, skip or (mobile) save events, so watch-depth features are reel-only. Mobile OTA work; v3's weights keep `engagement_depth` at 0.22 knowing this.
- Reach target for followers (X `post_unexplored`: 3% of followers in 24 h) — needs follower-impression joins; revisit when follows > 100.
- `remix_complete` and `purchase` as server-written feed events; `resource_open` emitter.
- Embedding diversity (MMR/DPP) and the semantic pool — Phase 2 of `feed_algorithm_v2.md`; the embeddings table is empty.
- Viewer-grain daily rollup for sample-ratio checks and the 7-day creation metric; a "why you're seeing this" reason code on clients.
- Account-level NSFW/spam propagation with TTL (X's `safety-label-user-agg`).

## 7. Verification

`npm test`, `npm run lint`, `npm run typecheck`, `npm run typecheck:scripts`, `npm run typecheck:tests` in the worktree; migration replay (`npx --yes supabase@2.75.0 db reset --local`) and `supabase test db` when the local stack can start, otherwise CI's database job; the byte-identical v1/v2 ranking test; the scorecard run against production is the owner's step after deploy, before any activation.
