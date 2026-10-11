# Magicbooklet For You ranking: engineering analysis (2026-10-11)

Scope: the showcase For You feed as it exists at `31634288` (branch `feed/x-algorithm-adoption-2026-10-11`, identical to `main`). Every path is repo-relative. All claims come from reading code and migrations in this worktree. Production rows were not read (no `.env.local`, no database access), so "active" below means "as seeded by the latest migration". A manual SQL change in production would not show up here. Numbers marked *arithmetic* are worked from the formulas, not measured.

---

## 1. Executive summary

The live For You feed is `for-you-rules` **v1**. It is seeded `active` in `supabase/migrations/20260711064036_feed_personalization_system.sql:122-164`, and no later migration changes any version's status. **v2** is seeded `shadow` (`20260728181000_feed_ranking_v2.sql:1283-1331`). It reaches users only through an experiment variant, and there is no code, ops CLI or admin screen for creating one.

A request runs in this order:
1. A SQL RPC pulls up to five candidate pools and computes 8 (v1) or 12 (v2) per-post features, each a clamped smoothed rate.
2. TypeScript sorts the candidates by `Σ weight × feature`, using weights stored as JSON on the algorithm row.
3. It hydrates the top 60 and fills any gap with recent posts.
4. It removes the viewer's hidden posts and hidden creators.
5. A greedy reranker applies diversity rules: hard caps, not decays.
6. One atomic RPC freezes the 60 posts into a session. Clients page through it with a cursor, 12 per page.

There is no per-viewer predicted-action model. Personalisation comes from `user_interest_weights`, whose dimensions are very coarse:
- `category`: image, video or text
- `media_type`: post format, which is mostly `media` vs `text`
- `source_tool`
- `creator`

On top of that, a +0.75 affinity is added for followed creators.

Four structural findings matter most for the X comparison:

1. **v1 has no seen suppression.** Its RPC returns no seen flag, so every new session re-ranks mostly the same posts.
2. **v1's 7d and 30d windows are effectively about 2 days.** Its post statistics count only events still attached to a feed session, and sessions are pruned 2 days after expiry.
3. **Four of the 16 event types are never written:** `follow`, `remix_complete`, `purchase` and `report`. A fifth, `resource_open`, has no client emitter. The ranking terms that read them are dead.
4. **Blocks are applied after ranking and after delivery facts are written**, at a different layer from every other visibility rule.

v2 fixes the seen problem and the denominators. It still has open gates before promotion: an unbounded SQL CTE, an unrun disjointness check, no scorecard and no A/A run. It also gets almost no watch signal from Home, the main surface, because Home emits no dwell, progress or save events.

---

## 2. Request path

| # | Stage | Layer | Location | What it does |
|---|---|---|---|---|
| 1 | Route | TS | `src/app/api/showcase/feed/route.ts:6-12` | `GET`/`HEAD` wrapped in `withRegionalIdentityAdmission`. |
| 2 | Parse + identity | TS | `src/lib/showcase-feed-route-adapter-service.ts:110-128,164,177` | `limit = min(limit ?? 12, 24)`; `cursor`; `sort`. A signed-out For You request gets an anonymous key hash (cookie, installation header or network) from `src/lib/showcase-feed-identity.ts:68+`. `offset` is forced to 0 when a cursor is present. For You always bypasses the cache. |
| 3 | Dispatch | TS | `src/lib/showcase-feed.ts:1234-1263` | Identityless cached bootstrap (`unstable_cache`, 60 s, `:1131-1158`, used only with no user, no anonymous key and no cursor), otherwise `getShowcaseForYouFeedPage` (`:1068-1129`). |
| 4 | Cursor continuation | TS | `src/lib/showcase-feed-personalization.ts:849-871` → `loadPersistedPage` `:359-546` | Decode `{s, p}` and validate session owner and expiry. Scan `feed_session_items` from position `p`, rehydrate, re-apply feedback, and mint facts for continuation pages (`:500-525`). Bad or expired cursor → empty page, `hasMore:false`. |
| 5 | Algorithm + experiment | TS / PostgREST | `showcase-feed-personalization.ts:316-357`, `src/lib/feed-experiments.ts:132-223` | Experiment assignment and active-version read run in parallel. An assigned variant's version wins; if it fails to load, fall back to active and drop the attribution. |
| 6 | Session reuse | TS | `showcase-feed-personalization.ts:766-805,912-940` | `offset=0`, same filters, created ≤ 2 min ago, same algorithm version and assignment → re-serve position 0 of that session. |
| 7 | Candidates + features | **SQL** | v1 `get_ranked_feed_candidates` (`20260809140000_feed_ranking_limit_first_pools.sql:71-430`); v2 `get_ranked_feed_candidates_v2` (`20260728181000_feed_ranking_v2.sql:542-879`); called at `showcase-feed-personalization.ts:686-732` | Pools, eligibility, viewer hide lists, features. v1 also pre-ranks with **hard-coded** v1 weights and `LIMIT 300`. |
| 8 | Pre-sort | TS | `showcase-feed-personalization.ts:952-958` | Seen tier first (v2 only), then `scoreRankedFeedFeatures` with the version's weights. |
| 9 | Hydration | TS / PostgREST | `showcase-feed-personalization.ts:734-764`; `showcase-feed.ts:1093-1109,245-293,530,641` | Batches of ≤ 60 ids, hydrated until 60 eligible items or the candidates run out. Re-checks `visibility='public'`, `archived_at IS NULL`, `review_status='visible'`. **Drops `is_nsfw`**, then tool, category, unlock and resource filters. |
| 10 | Recent top-up | TS | `showcase-feed-personalization.ts:966-969`; `showcase-feed.ts:1110-1122` | If fewer than 60 eligible, fetch 60 `recent` posts (non-NSFW). They are scored with synthetic fallback features. |
| 11 | Feedback filter | TS | `showcase-feed-personalization.ts:161-203,970-976` | Removes the viewer's active `not_interested` posts and `hide_creator` creators. A read error returns no items. |
| 12 | Score + rerank | TS | `src/lib/showcase-feed-ranking.ts:157-175,341-408` | Linear score; greedy diversity, exploration slot, seen tier. |
| 13 | Persist | **SQL RPC** | `showcase-feed-personalization.ts:548-612`; `persist_ranked_feed_session` `20260922054500_atomic_feed_session.sql:6-91` | One transaction writes the session (2 h expiry), all ≤ 60 items, and `feed_delivery_facts` **only for the served slice** (`served_at` set). |
| 14 | Page + cursor | TS | `showcase-feed-personalization.ts:999-1032`; `showcase-feed-ranking.ts:410-448` | `recommendation = {deliveryId, position, reason, algorithmVersion, candidateSource}`; `nextCursor = base64url({s,p})`. |
| 15 | Viewer state | TS | `showcase-feed.ts:1283-1296,1299-1439` | Localised prices, saved and purchased state, remix capability. **Bidirectional block filter (`:1371-1403`) runs here, after ranking and persistence**, and fails closed (empty page) on a read error. |
| 16 | Sanitise | TS | `src/lib/showcase.ts:286-309` | Public-content redaction. The recommendation object passes through. |

Offline: events are ingested via `/api/showcase/feed/events` (section 7). The `feed-maintenance` job runs hourly at minute 20 (`src/lib/backend-jobs.ts:223-231`) and executes `src/lib/feed-maintenance.ts:103-211` in this order: post stats v1 → engagement stats v2 → creator stats → cache invalidation → interest weights → daily rollup → prune.

**Fallback algorithm:** `recent-fallback-v1` (`showcase-feed-ranking.ts:8`). It is used when no algorithm row loads (`showcase-feed-personalization.ts:896-910`): recent posts, no session, no cursor, `hasMore:false`. If the candidate RPC fails instead (`:728` returns `null`), every item comes from the recent top-up and is scored by `buildFallbackRankedFeedFeatures` (`showcase-feed-ranking.ts:182-215`). That session is persisted under the **active** version id, so it cannot be told apart by version.

---

## 3. Algorithm versions and scoring

### 3.1 Rows as of the latest migration

`feed_algorithm_versions` (`20260711064036:6-36`):
- `status ∈ {draft, shadow, active, retired}`
- a partial unique index allows one `active` row per `algorithm_key` (`:31-33`)

v1 is `active`; v2 is `shadow`. No migration updates either status (a grep for `UPDATE public.feed_algorithm_versions` returns nothing).

**v1 `for-you-rules` / 1, `active`** (`20260711064036:122-164`)
```json
weights:          {"interest_match":0.35,"creator_affinity":0.15,"smoothed_usefulness":0.15,"freshness":0.15,
                   "relevant_trend":0.10,"exploration_bonus":0.10,"quick_skip_risk":-0.35,"negative_feedback_risk":-0.80}
retrieval_config: {"candidate_limit":300,"session_item_limit":60,"following_share":0.20,"interest_share":0.30,
                   "recent_share":0.20,"trending_share":0.15,"exploration_share":0.15}
diversity_config: {"max_creator_per_20":2,"max_semantic_cluster_per_20":3,"exploration_per_10":1,"max_paid_share":0.20}
```
None of the `*_share` keys are read anywhere: `normalizeRetrievalConfig` (`showcase-feed-personalization.ts:252-271`) ignores them, and the v1 SQL hard-codes its pool sizes.

**v2 `for-you-rules` / 2, `shadow`** (`20260728181000:1283-1331`)
```json
weights:          {"interest_match":0.26,"creator_affinity":0.12,"smoothed_usefulness":0.10,"engagement_depth":0.24,
                   "attention_seconds_norm":0.08,"freshness":0.12,"relevant_trend":0.06,"creator_quality":0.06,
                   "exploration_ucb":0.10,"exploration_bonus":0.0,"quick_skip_risk":-0.30,"negative_feedback_risk":-0.80}
retrieval_config: {"candidate_rpc":"v2","following_limit":100,"interest_limit":150,"trending_limit":100,"recent_limit":150,
                   "exploration_limit":100,"seen_lookback_days":14,"seen_penalty":0.2,"creator_prior_cap":0.15,
                   "exploration_confidence":1.5,"session_item_limit":60}
diversity_config: {"max_creator_per_20":2,"max_semantic_cluster_per_20":3,"exploration_per_10":1,"max_paid_share":0.20}
```

### 3.2 Config normalisation in TypeScript

- **Weights** (`showcase-feed-ranking.ts:105-123`): each key is accepted if it is finite and in `[-10, 10]`. Otherwise the default applies. The defaults (`:68-81`) **equal v1**, and the v2-only keys default to 0, so a missing key can never switch on a v2 feature.
- **Diversity** (`:125-155`): `max_creator_per_20` and `max_semantic_cluster_per_20` must be integers in `[1,20]`; `exploration_per_10` in `[0,10]`; `max_paid_share` in `[0,1]`.
- **Retrieval** (`showcase-feed-personalization.ts:252-271`):
  - `candidate_rpc` is `'v2'` or else `'v1'`
  - pool limits are integers in `[0,500]`
  - `seen_lookback_days` in `[0,365]`; `seen_penalty` and `creator_prior_cap` in `[0,1]`; `exploration_confidence` in `[0,5]`
  - `candidate_limit` is clamped to `[1,300]` and `session_item_limit` to `[1,60]` (`:277-288`)
- `algorithmVersion` label = `` `${algorithm_key}-v${version}` `` (`:276`), e.g. `for-you-rules-v1`.

### 3.3 Score

`scoreRankedFeedFeatures` (`showcase-feed-ranking.ts:157-175`): `score = Σ_k w_k · clamp01(f_k)` over 12 keys. Risks carry negative weights.

- v1 positive weights sum to 1.00, so the score lies in `[-1.15, 1.00]`.
- v2 positive weights sum to 1.14.
- A seen post (v2) has its score multiplied by `seen_penalty` (0.2) and is moved into a lower tier (`:357-374`).

**v1 duplicates its weights in SQL.** `get_ranked_feed_candidates` orders by the same eight weights as literals and truncates to `p_limit` (`20260809140000:417-428`). TypeScript re-sorts only those survivors.

### 3.4 Dynamic range (*arithmetic*, v1)

A brand-new post, viewer with no interests, creator not followed:

`0.15·0.08 (usefulness prior) + 0.15·1 (freshness) + 0.10·0 (trend) + 0.10·1 (exploration) − 0.35·0.25 (skip prior) − 0.80·0.01 = 0.167`

How the other terms compare:
- **Follow:** following the creator adds `0.15·0.75 = 0.11`.
- **Onboarding goal:** a matching seed (two rows of 4.0 → interest 0.8) adds `0.35·0.8 = 0.28`.
- **Usefulness:** the term is `(2+…)/(impressions+25)`, so a post needs above 8% weighted conversion just to stay at the 0.08 prior. Realistic values are 0.05–0.2, worth 0.01–0.03 of score.
- **Exploration bonus:** falls from 0.10 to 0.04 as 30-day impressions go from 0 to 100.
- **Quick-skip prior:** 0.25 shrinks toward 0 as Home impressions grow (Home emits no skips). That is worth up to +0.0875 to exposed posts.

So v1 is dominated by interest-format match, freshness and the exposure-driven exploration and skip terms. Measured quality moves the score by about 0.02.

---

## 4. Features

All features are clamped to `[0,1]` in SQL and again in TypeScript (`showcase-feed-ranking.ts:90-93`). "7d", "24h" and "30d" mean `post_feed_stats.window_key`. v1 stats come from `refresh_post_feed_stats` (`20260711064036:1311-1518`, event-based). v2 columns come from `refresh_post_feed_engagement_stats` (`20260808130000:129-349`, fact-based).

| Feature | Computed from (formula) | Range / prior | v1 w | v2 w | Notes |
|---|---|---|---|---|---|
| `interest_match` | `Σ max(w,0)/10` over the viewer's `user_interest_weights` rows matching `category = posts.category` ∪ `media_type ∈ {posts.category, posts.post_format}` ∪ `source_tool = posts.source_tool_slug` (v1 `20260809140000:365-381`; v2 `:839-855`) | [0,1]; 0 for anonymous | 0.35 | 0.26 | Excludes the `creator` dimension. One save (+3 on three dimensions) gives 0.9, so it saturates fast. |
| `creator_affinity` | `0.75·[follows(viewer→creator)] + max(0, max(creator-dimension weight)/10)` (v1 `:382-403`; v2 `:856-877`) | [0,1] | 0.15 | 0.12 | The only in-network signal used in scoring. |
| `smoothed_usefulness` | 7d `usefulness_score = min(1,(2 + .15·open + 1·save + .5·share + 1.25·follow + 1.5·remix_start + 2·remix_complete + .75·resource_open + 2.5·purchase)/(impressions+25))` (`20260711064036:1409-1422`); no row → 0.08 | [0,1], prior 0.08 | 0.15 | 0.10 | The follow, remix_complete and purchase terms are always 0 (§7.4). |
| `freshness` | `min(1, 0.5^(age_seconds/259200))`: half-life 72 h (v1 `:320-327`) | (0,1] | 0.15 | 0.12 | Soft decay only; there is no age cutoff. |
| `relevant_trend` | v1: `usefulness_24h · ln(1+impressions_24h)/ln(101)` (`:328-338`). v2: `meaningful_engagement_rate_24h · ln(1+rendered_24h)/ln(101)` (`20260728181000:792-802`) | [0,1] | 0.10 | 0.06 | Volume factor saturates at 100 impressions or renders. |
| `exploration_bonus` | `1/sqrt(1 + impressions_30d/20)` (`20260809140000:339-341`) | (0,1]; 1 when unexposed | 0.10 | 0.00 | Still computed in v2 but weighted 0. |
| `quick_skip_risk` | v1: `min(1,(quick_skip_7d+1.25)/(impressions_7d+5))` (`:342-346`). v2: `min(1,(quick_skip_delivery_7d+1)/(rendered_7d+8))` (`20260728181000:806-810`) | prior 0.25 (v1) / 0.125 (v2) | −0.35 | −0.30 | Skips come from reel viewers only. v1's denominator excludes its own numerator (a skip replaces an impression). |
| `negative_feedback_risk` | `min(1,(not_interested_7d + hide_creator_7d + 2·report_7d + 0.2)/(impressions_7d+20))`, same in both | prior 0.01 | −0.80 | −0.80 | `report_7d` is always 0. v2 still uses v1's event counts. |
| `engagement_depth` (v2) | 7d: video `(half_completions+1.5)/(video_starts+6)`; others `(meaningful+1.5)/(rendered+6)` (`20260808130000:257-268`); no row → 0.25 | prior 0.25 | 0 | 0.24 | Every rendered video delivery counts as a start, including Home renders, but progress is reported only from the reel. |
| `attention_seconds_norm` (v2) | `1 − exp(−avg_attention_s/20)`. Attention is progress·duration for video and dwell for other formats (`:196-210,271-283`) | [0,1]; 0 with no data | 0 | 0.08 | Saturates near 20 s. |
| `creator_quality` (v2) | `min(creator_prior_cap=0.15, creator_feed_stats_30d.quality_rate)`, where `quality_rate = (meaningful+3)/(rendered+20)` (`20260808130000:112-113`; `20260728181000:822-823`); no row → 0 | [0, 0.15] | 0 | 0.06 | The prior 3/20 equals the cap, so every creator with any rendered delivery sits at 0.15 and a creator with no row gets 0. |
| `exploration_ucb` (v2) | Beta(α = m₃₀+1, β = max(0, r₃₀−m₃₀)+1), score `= α/(α+β) + c·sqrt(αβ/((α+β)²(α+β+1)))`, c = 1.5 (`20260728181000:664-698`) | [0,1]; 0.933 when unexposed | 0 | 0.10 | Deterministic UCB, not a random draw. |
| `seen_recently`, `last_seen_at` (v2) | Viewer's (or anonymous hash's) `feed_events.event_type='impression'` within `seen_lookback_days` (`:609-626`) | bool | – | tier | Not scored. Drives the hard tier in the reranker. v1 returns neither column, so `seenRecently` is always `false` (`showcase-feed-ranking.ts:255`). |
| `semantic_cluster` | **Never returned** by either RPC | always `null` | – | – | `max_semantic_cluster_per_20` has no effect (§6). |

"Meaningful engagement" has one definition, `is_meaningful_feed_engagement` (`20260728181000:147-168`): video progress ≥ 0.5, or non-video dwell ≥ 3 s, or save, remix start, resource open or purchase, counted over rendered deliveries only.

Fallback features (`showcase-feed-ranking.ts:182-215`) apply to items without SQL features. They use `posts.save_count` and `remix_count`:
- `weighted = saves + 2.5·remixes`
- usefulness `= 1−e^(−weighted/20)`, trend `= 1−e^(−weighted/35)`
- freshness: 72 h half-life
- if saves + remixes < 3: `explorationBonus` 0.75, `explorationUcb` 0.9, source `exploration`
- otherwise: 0.1 / 0.5, source `trending` if trend > 0.45, else `fresh`
- `engagementDepth` 0.25

---

## 5. Retrieval pools

**Eligibility predicate shared by every pool** (repeated inline, `20260809140000:133-139` etc.):
- `visibility='public' AND archived_at IS NULL AND review_status='visible'`
- `AND (p_category IS NULL OR category=p_category)`
- `AND` the post is not in the viewer's active `feed_user_post_feedback`
- `AND` the creator is not in the viewer's active `feed_user_creator_feedback`

Both hide lists are materialised once per request (`:105-124`).

`p_category` is **always NULL** in practice. `showcase-feed-personalization.ts:699-701` maps every `ShowcaseCategory` (`all|media|image|video|text`, `src/lib/showcase.ts:39`) to `null`, so category, unlock, resource and tool filters are all applied after retrieval, in hydration.

### v1 (live), `get_ranked_feed_candidates(p_viewer_user_id, p_category, p_limit=300, p_as_of)`

| Pool (source label) | SQL | Size | Location |
|---|---|---|---|
| `following` | For each `follows` row with `follower_id = viewer`: newest posts of `following_id`, `LIMIT LEAST(p_limit,100)` per creator; then newest 100 overall. Signed-in only. | 100 | `20260809140000:125-147` |
| `interest` → TS `affinity` | For each `user_interest_weights` row with `weight > 0`: newest 150 posts matching that category, media_type, source_tool or creator. Group by post; order by `max(weight) DESC, created_at DESC`. | 150 | `:148-185` |
| `trending` | `post_feed_stats` 24h joined to eligible posts, ordered by `usefulness_score DESC, impression_count DESC, created_at DESC` | 100 | `:186-204` |
| `recent` → TS `fresh` | Eligible posts, newest first | 150 | `:205-216` |
| `exploration` | Lowest 30d `impression_count` (100) ∪ the newest 100 eligible posts with no 30d stats row; ordered by impressions ASC, created DESC | 100 | `:217-278` |

Then:
- **Deduplication:** `DISTINCT ON post_id`, priority following 1 > interest 2 > trending 3 > recent 4 > exploration 5 (`:290-296`).
- **Features:** computed for every surviving post (`:311-404`).
- **Order and cut:** `ORDER BY <hard-coded v1 score> DESC, post_id DESC LIMIT 300` (`:417-428`).
- **Index the following pool relies on:** `posts_public_visible_owner_recent_idx` (`:65-69`).

### v2 (shadow), `get_ranked_feed_candidates_v2(p_viewer_user_id, p_anonymous_key_hash, p_category, p_following_limit=100, p_interest_limit=150, p_trending_limit=100, p_recent_limit=150, p_exploration_limit=100, p_seen_lookback_days=14, p_creator_prior_cap=0.15, p_exploration_confidence=1.5, p_as_of)`

All pools select from `eligible AS MATERIALIZED`: every public, visible post with the viewer filters applied as correlated `NOT EXISTS`, plus a left join to `seen` (`20260728181000:627-663`). Every pool orders by `seen_recently ASC` first.

| Pool | Order after seen | Size param | Location |
|---|---|---|---|
| `following` | `created_at DESC` (join `follows`) | `following_limit` 100 | `:699-708` |
| `affinity` | `max(matching weight>0) DESC` (creator dimension included), `created_at DESC` | `interest_limit` 150 | `:709-738` |
| `trending` | 24h `meaningful_engagement_rate DESC, rendered_count DESC` | `trending_limit` 100 | `:739-751` |
| `fresh` | `created_at DESC` | `recent_limit` 150 | `:752-757` |
| `exploration` | `exploration_ucb DESC` | `exploration_limit` 100 | `:758-764` |

v2 deduplicates with the same priority (`:772-776`) and has **no global order and no limit**, so up to 600 rows reach TypeScript. Cost scales with the catalog: `eligible` and the posterior are computed over every eligible post. That is the documented promotion gate at `20260809140000:53-56`.

Two consequences of pool design:
- **Small catalogs.** Exploration has the lowest priority, and the recent pool (150) holds every post of a catalog with ≤ 150 eligible posts. In that case no candidate keeps the `exploration` label, so the `exploration_per_10` slot never fires and `is_exploration` is false on every fact.
- **Trending degrades to the prior.** Every post with a stats row also has a 24h row (all three windows are upserted, `20260711064036:1353-1358`). When 24h activity is sparse, the trending pool fills with prior-valued (0.08) ties ordered by newest.

---

## 6. Diversity, seen suppression, exploration, sessions (pseudocode)

From `showcase-feed-ranking.ts:287-408`. The input is ≤ 60 hydrated, feedback-filtered items; each gets its SQL feature row or a fallback row.

```
for each item: f = features[item] ?? fallback(item); s = Σ w·f; if f.seen: s *= seenPenalty (0.2)
sort by (seen ASC, s DESC, lastSeenAt ASC, createdAt DESC, id DESC)
selected = []
while remaining:
  requireExplore = explorationPer10 > 0 and
                   (explorationPer10 − #exploration in current block of 10) >= (10 − len(block))
  unseenRemains = any(!c.seen for c in remaining)
  inTier(c) = !unseenRemains or !c.seen                       # seen posts only once no unseen post remains
  ok(c) = !(c.creator == last.creator)                        # never back-to-back
          and count(creator in last 19) < maxCreatorPer20     # ≤2 per rolling 20
          and !(c.cluster and count(cluster in last 19) >= maxSemanticClusterPer20)   # inert: cluster is null
          and !(c.paid and (maxPaidShare <= 0 or count(paid in last 19) >= max(1, floor(20·maxPaidShare))))  # ≤4 per 20
  i = requireExplore ? first(c in tier: c.source=='exploration' and ok(c)) : -1
  if i<0: i = first(c in tier: ok(c))
  if i<0: i = first(c in tier)          # relax diversity before taking a seen post
  if i<0: i = 0
  selected.push(remaining.pop(i))
```

- **Caps, not decays.** Creator and paid rules are hard window caps, relaxed only when no candidate passes. There is no per-repeat score decay.
- **Exploration** is a quota of 1 per 10: forced at the last slot of each block of 10 if no exploration item was picked and one is available.
- **Seen tier** is v2-only in practice. The v1 RPC has no seen data.
- **Cost** is O(n²·19) with n ≤ 60, which is negligible.

**Seen definition (v2):** `feed_events` rows of type `impression` for the viewer (`viewer_user_id`), or for the anonymous hash when signed out, with `occurred_at ≥ as_of − 14 days` (`20260728181000:609-626`). Indexes: `feed_events_viewer_post_impression_idx` and `feed_events_anonymous_post_impression_idx` (`20260728180500:204-210`). An impression is qualified client-side: ≥ 50% visible for ≥ 1 s (§7). `seen_lookback_days = 0` is the kill switch. A post served but never impressed is not "seen", and there is no cross-session served filter.

**Exploration:**
- v1: the additive `exploration_bonus`, plus the exploration pool (lowest 30d impressions).
- v2: the UCB feature and a UCB-ordered pool. `exploration_propensity` is logged as 1/0 (`20260922054500:77`).
- `feed_sessions.random_seed` is written but never read.

**Sessions and cursors:**
- A session holds at most 60 items: `SHOWCASE_FEED_ELIGIBLE_ITEM_LIMIT` (`showcase-feed-ranking.ts:10`), and the persist RPC rejects more (`20260922054500:28-30`). At page size 12 (`src/lib/showcase.ts:13`, `ugc-mobile/lib/showcase-feed-query.ts:3`) that is 5 pages, then `hasMore:false`.
- Expiry 2 h; reuse window 2 min (`showcase-feed-personalization.ts:84-85`).
- Items are unique per session (`feed_session_items_session_post_key`, `20260711064036:229-230`).
- The cursor is opaque `base64url({s: sessionId, p: position})`, ≤ 512 characters (`showcase-feed-ranking.ts:430-448`).
- Continuation pages re-hydrate and re-filter, so they may skip positions. They scan at most 60 session rows (`showcase-feed-personalization.ts:420-485`).
- With no identity, or if persistence fails, paging falls back to `offset`, and **each offset request re-ranks from scratch** (`:999-1008`).
- After a session runs out, a new ranking happens only on a fresh `offset=0` request more than 2 minutes after the old session was created.

**"Starvation-free" refers to the aggregate jobs, not the feed:**
- The v2 post and creator stats refreshes now take the least-recently-refreshed rows first (`ORDER BY min(existing.updated_at) ASC NULLS FIRST`, `20260808130000:47-60,153-163`).
- The interest refresh records progress per user in `user_interest_refresh_state`, so users with no interest rows no longer pin the batch (`20261005170739:2-10,46-80`).

---

## 7. Signals

### 7.1 Ingestion

- **Endpoint:** `POST /api/showcase/feed/events` (`src/app/api/showcase/feed/events/route.ts`) → `src/lib/showcase-feed-events-route-adapter-service.ts`.
- **Write paths:** a single event goes through `recordShowcaseFeedEvent` (`src/lib/showcase-feed-events-service.ts:499-680`). A batch of ≤ 25 goes through `recordShowcaseFeedEvents` (`:702+`) and the RPC `record_showcase_feed_events` (`20260812150000_feed_event_batch_rpc.sql:6+`).
- **Rules:**
  - Event age must be ≤ 24 h (`:32`).
  - These types require a `deliveryId`: impression, open, dwell, media_progress, quick_skip, share, remix_start, resource_open (`:45-54`).
  - The delivery must belong to the viewer's session, and **the event must occur before the session's 2 h expiry** (`20260812150000:149-198`).
  - `follow`, `remix_complete`, `purchase` and `report` are rejected with 400, "must be recorded by its authoritative server action" (`events-service.ts:34-39,524-526`; `20260812150000:106-107`).
- **Triggers:**
  - `validate_feed_event_context` stamps the immutable `delivery_fact_id` (`20260728180500:216-299`, `:270`).
  - `apply_feed_delivery_outcome` sets write-once or max outcome columns on `feed_delivery_facts` (`:305-376`).
  - `media_progress` upserts one row per delivery with `GREATEST` (`:384-452`).
- **Clients:**
  - Mobile queues events: flush at 10 events or after 2 s, chunks of 25, max 200 entries, max age 24 h (`ugc-mobile/lib/feed-event-queue.ts:7-14`).
  - Web flushes after 2 s (`src/app/showcase/ShowcaseFeedInteraction.tsx:99`).

### 7.2 Event → storage → aggregate → feature

| Event | Emitted by | `feed_delivery_facts` column | v1 `post_feed_stats` | v2 stats (facts) | Interest weight (`20261005170739:99-124`) | Ranking use |
|---|---|---|---|---|---|---|
| `impression` | Mobile Home (≥ 50% visible, 1 s; `ugc-mobile/components/home-dashboard.tsx:298-320`, `ugc-mobile/lib/showcase-feed-events.ts:30-33`), mobile reel (`ugc-mobile/app/viewer.tsx:639-653`), web cards (`ShowcaseFeedInteraction.tsx:332-343`), web reel (`ShowcaseReelViewer.tsx:559-565`) | `qualified_impression_at`, `rendered_at` | `impression_count`, `unique_viewer_count` | `rendered_count` (any event) | 0 | Denominators (usefulness, skip, negative, trend, exploration_bonus); v2 seen set |
| `open` | Mobile Home and showcase tap; web feed and reel | `opened_at` | `open_count` | – | +0.10 | usefulness (+0.15) |
| `dwell` | **Reels only** (mobile `viewer.tsx:686-691`, web `ShowcaseReelViewer.tsx:572-578`) | `dwell_ms_max` | `dwell_ms` (**unused**) | attention and meaningful (non-video ≥ 3 s) | ≥ 3 s: +0.35; else +0.05 | v2 depth, attention, UCB, creator quality |
| `media_progress` | **Reels only** (`viewer.tsx:655-675`; `ShowcaseReelViewer.tsx:533`) | `media_progress_max`, `media_duration_ms` | `media_progress_count` (**unused**) | half-completion, completion, attention | ≥ 0.75: +0.50; else +0.10 | v2 only |
| `quick_skip` | Reels only, < 1 s (web: nothing under 250 ms) | `quick_skipped_at` | `quick_skip_count` | `quick_skip_delivery_count` | −1.0 | `quick_skip_risk` |
| `save` / `unsave` | Web `ShowcaseClient.tsx:318`; mobile reel `viewer.tsx:771`. **Not mobile Home** (`home-dashboard.tsx:447,827` save without an event) | `saved_at` (write-once) | `save_count` (unsave never subtracts) | meaningful | +3.0 / −1.0 | usefulness (+1.0); v2 meaningful |
| `share` | Web and mobile | `shared_at` | `share_count` | – | +2.0 | usefulness (+0.5) |
| `remix_start` | Web and mobile | `remix_started_at` | `remix_start_count` | meaningful | +4.0 | usefulness (+1.5) |
| `resource_open` | **No client emits it** | `resource_opened_at` | 0 | – | (+2.0) | dead |
| `follow` | **Never written** | `followed_at` always NULL | 0 | – | (+4.0) | dead (`follows` table used directly instead) |
| `remix_complete` | **Never written** | always NULL | 0 | – | (+6.0) | dead |
| `purchase` | **Never written** | always NULL | 0 | – | (+8.0) | dead (also in `is_meaningful_feed_engagement`) |
| `not_interested` | Web and mobile menus | `not_interested_at` | `not_interested_count` | – | −6.0 | `negative_feedback_risk`; signed-in users also get `feed_user_post_feedback` → hard exclusion |
| `hide_creator` | Web and mobile menus | `hid_creator_at` | `hide_creator_count` | – | −8.0 | `negative_feedback_risk`; signed-in users also get `feed_user_creator_feedback` → hard exclusion |
| `report` | **Never written** (real reports go to `post_reports`, `src/lib/post-report-service.ts:153-167`) | always NULL | 0 | – | (−10.0) | dead (the 2× term in negative risk) |

**Aggregation jobs** (hourly, `src/lib/feed-maintenance.ts:6-10,116-180`):
- **`refresh_post_feed_stats` (v1):** 1,000 posts per run. Its candidates are posts with an existing stats row or recent session events (`20260711064036:1335-1352`), and the set never shrinks. It counts only events with `session_item_id IS NOT NULL` (`:1399-1403`).
- **`refresh_post_feed_engagement_stats` (v2):** posts with facts in the last 31 days.
- **`refresh_creator_feed_stats`:** creators with rendered facts in the last 31 days.
- **`refresh_user_interest_weights`:** 1,000 users per run, 90-day lookback, 30-day half-life.
- **Retention** (`src/lib/feed-retention-policy.ts:27-71`):
  - events 30 d, sessions 2 d after expiry, raw facts 30 d, daily rollup 400 d
  - prune 5,000 rows per table per run

### 7.3 How interest dimensions are derived (no tags, no embeddings)

`refresh_user_interest_weights` is the latest definition (`20261005170739:12-325`):
- **Batch selection:** users with feed events (`delivery_fact_id IS NOT NULL`) or completed generations in the lookback window, oldest refresh first, `LIMIT 1000` (`:46-80`).
- **Rebuild:** each selected user's weights are deleted and rebuilt (`:86-87`) from three sources:
  - (a) feed events × the weight table above × `0.5^(age/30d)` (`:89-138`)
  - (b) completed `generations`: `(3.0 + 1.0 if template-run) × decay` (`:139-161`), mapped with `normalize_feed_interest_category`: motion and ugc-ad count as video, audio is dropped (`20260728181000:116-131`)
  - (c) mobile onboarding goal: `4.0 × decay` (`:162-177`)
- **Dimension fan-out** (`:178-274`):
  - events write `category`, `media_type = coalesce(post_format, category)`, `source_tool` and `creator`
  - creations and seeds write `category` and `media_type`
- **Aggregation:** per dimension, `weight = clamp(Σ, −20, 20)`, kept if `|Σ| ≥ 0.01` (`:288-305`).
- **Immediate seed:** `seed_user_interest_from_onboarding_goal` (`20260728181000:901-947`, called from `src/lib/onboarding-route-adapter-service.ts:357-369`) writes weight 4.0 on category and media_type with `GREATEST`.

Value space:
- `posts.category ∈ {image, video, text}`
- `posts.post_format ∈ {text, media, mixed}`
- plus the tool slug and the creator id

So "interest" means format, tool and creator. A single `not_interested` lowers the weight of an entire format and tool.

**Semantic layer is dormant:**
- `post_content_embeddings` and `match_post_content_embeddings` (`20260711064036:465-626`) have no writer and no caller.
- `semantic_cluster` is never produced, and the `semantic` source is never emitted.

### 7.4 Logged but unused by ranking

- `feed_events.dwell` and `media_progress` in v1: `dwell_ms` and `media_progress_count` are aggregated but read by no v1 feature.
- Fact columns `qualified_impression_at`, `opened_at`, `shared_at`, `remix_completed_at` (never set) and the `served_at` denominators are used by measurement only. v2 does not read `served_delivery_count`.
- `post_share_events` (`share_click`, `share_visit` with surface, `20260404163000:30-35`): inbound visits from shared links are a strong external signal, never read by the feed.
- `post_comments` and `posts.comment_count`: hydrated for display, never ranked. `posts.save_count` and `remix_count` are used only by fallback features.
- `post_saves` (authoritative saves from any surface) and `post_reports` / `posts.report_count`: not read by ranking.
- `user_blocks`: a hard filter only, not used as a negative interest signal on the creator dimension.
- `feed_experiments.targeting` and `feed_experiment_variants.config` columns: never read.

### 7.5 Not logged at all (vs X's action set)

- **Reply/comment:** a comment on a feed post is not a feed event.
- **Repost or quote:** no such feature exists.
- **Like:** no such feature. Save is the closest.
- **Profile click from a card.**
- **Follow from a post:** the `follows` insert carries no delivery.
- **Photo expand or "read more" dwell** (`ugc-mobile/lib/feed-read-more.ts` exists but emits nothing).
- **Video watch in Home:** inline autoplay reports no progress.
- **Share variants as feed events:** channel lives only in `post_share_events`.
- **Mute** (author or keyword): no table.
- **Block and report as per-viewer feed negatives:** not logged as feed events (see above).
- **"Show more like this":** no such control.
- **Server-side not-interested for anonymous viewers:** the event is stored but no exclusion row is written (`events-service.ts:373`). The client keeps a memory-only list (`ugc-mobile/lib/showcase-feed-events.ts:69-87`).

---

## 8. Social graph and safety

**Graph.** `public.follows(follower_id, following_id)` (`supabase/migrations/20260321200705_20260322_profile_improvements.sql:13`). Ranking uses it in two places only:
- the `following` pool
- the `creator_affinity` +0.75 term

There is no in-network vs out-of-network distinction beyond those two:
- no out-of-network multiplier
- no in-network quota
- no "following" lane

A followed creator's post that arrives through another pool still gets the affinity term. The viewer's **own posts are not excluded** from any pool.

**Where each exclusion is applied:**

| Rule | Where | Layer | Applies to |
|---|---|---|---|
| `visibility='public'`, `archived_at IS NULL` (also covers tombstoned posts), `review_status='visible'` | Every pool (`20260809140000`; v2 `eligible`) **and** hydration (`showcase-feed.ts:255-256,530`) | SQL + TS | Everyone |
| `is_nsfw` (manual label, `20260929120000_manual_nsfw_content.sql:2`) | Hydration only, `!item.isNsfw` (`showcase-feed.ts:1101,1121`). Candidates include NSFW posts. | TS | Everyone; For You never shows NSFW, even to opted-in adults (recommendation-only rule) |
| Not interested (post) | SQL hide lists + TS `filterActiveViewerFeedback` (`showcase-feed-personalization.ts:161-203`) | SQL + TS | Signed-in only. No undo path: no caller sets `is_active=false`; `set_feed_post_feedback` / `set_feed_creator_feedback` (`20260711064036:1097,1128`) are unused |
| Hide creator | As above | SQL + TS | Signed-in only; follows and non-follows alike |
| Block (either direction) | `attachViewerStateToFeed` → `loadBlockedCreatorIds` (`showcase-feed.ts:1371-1403`; `src/lib/moderation-service.ts:461-493`), **after ranking and persistence**. Blocking also deletes follows both ways (`moderation-service.ts:273-287`). | TS | Everyone; fails closed (empty page) |
| Report | `post_reports` row → `posts.report_count += 1`, no auto-flag since `20260726071722_harden_data_api_and_storage_contract.sql:150-166`. **No feed effect:** no ranking term and no per-viewer exclusion. The web shows "removed from your feed", but removal is client-side only (`src/lib/feed-safety-actions.ts:55-80`). | – | – |
| Moderator hide | `review_status` set to `hidden`/`flagged` by the moderation RPCs → excluded by the predicate | SQL | Everyone |
| Creator account state (banned or deleted) | **Not checked** by candidates or hydration; relies on moderation acting on posts (not verified) | – | – |

Followers and non-followers get identical safety treatment. There are no "suggestive"-specific columns: the only mature-content mechanism is `posts.is_nsfw` with reveal grants (`docs/plans/nsfw-labeling-and-moderation.md:28-36`). Clips "hidden" by the owner can only be hidden through `is_nsfw`, `review_status` or visibility. The repo has no separate flag.

**Consequences of the post-ranking block filter:**
- A blocked creator's posts consume the 60-item session budget.
- They get `feed_delivery_facts` with `served_at` (the served-slice facts are written before the filter).
- They shorten the page below `limit`.

The explore-merge endpoint `getShowcaseViewerExclusionsForRoute` (`src/lib/showcase-viewer-exclusions-service.ts:56-112`) repeats the same three reads for cached pages.

---

## 9. Experiments, activation, measurement

### Tables

`20260711064036:38-120`:
- `feed_experiments(status ∈ draft|running|paused|completed|cancelled, traffic_basis_points 0-10000, assignment_salt, targeting, starts_at, ends_at)`
- `feed_experiment_variants(variant_key, algorithm_version_id, allocation_basis_points, config)`
- `feed_experiment_assignments(viewer_user_id XOR anonymous_key_hash, expires_at)`, unique per experiment and viewer

No migration seeds an experiment.

### Assignment

`src/lib/feed-experiments.ts`:
- Only the oldest `running` experiment inside its time window is used (`:107-122`).
- **Enrolment:** `sha256(salt:enroll:viewerKey) % 10000 < traffic` (`:39-42,56-57`).
- **Variant:** an independent draw `sha256(salt:variant:viewerKey) % Σallocation` over variants sorted by `variant_key` (`:59-75`).
- A stored assignment wins over a fresh hash (`:158-170`), and a race reloads the winner (`:198-222`).
- Assignment TTL is 90 days (`:8`). Expired rows are pruned (`20260809230000:126-139`), and the next request re-assigns with the same hash.
- `viewerKey` is the user id, or `anon:<hash>`. Signing up therefore changes the key and the assignment.
- Unenrolled viewers get the active version with null experiment ids. There is **no holdout bucket**. A control arm must be an explicit variant pointing at v1.

### Activation

There is no code path:
- no migration
- nothing under `scripts/ops/` (no feed CLI)
- no `src/app/admin` screen
- no `/api/ops/*` writer

Promoting v2 means manual SQL in one transaction: retire v1, then set v2 `status='active'`, because of the partial unique index. An experiment needs manual `INSERT`s into the three experiment tables.

Gates recorded before promotion:
1. Bound the v2 RPC's `eligible` CTE (`20260809140000:53-56`).
2. Run the seed-1,000-creators disjointness check (`docs/archive/scaling-audit-2026-08-08.md:599`).
3. Build the scorecard and `/admin` panel (`docs/plans/feed_algorithm_v2.md:94-99,118`).
4. Run an A/A, then v1-vs-v2 (`:106-108,124`).

### Measurement available

- **`feed_delivery_facts`** (`20260728180500:23-117`): one row per **served** delivery, keyed by `feed_session_items.id`. It carries:
  - algorithm version, experiment, variant
  - viewer (user or anonymous hash), post, creator, position
  - candidate source, `is_exploration`, propensity
  - `final_score`, `score_components`
  - `ranked_at`, `served_at`, plus outcome timestamps and maxima (rendered, qualified impression, open, quick skip, dwell, progress, duration, save, share, follow, remix start/complete, resource open, purchase, not interested, hide creator, report)

  Retention is 30 days (`src/lib/feed-retention-policy.ts:45`).
- **`feed_delivery_fact_daily`** (`20260809180000:31-74`), 400 days:
  - grain `(fact_date, algorithm_version_id, experiment_id, experiment_variant_id, candidate_source, surface)`, with `UNIQUE NULLS NOT DISTINCT`
  - counts for every outcome, plus dwell, progress and score sums and counts
  - recomputed over the last 3 days each hour (`:81-195`)

What the daily table **can** measure: per-version, per-variant, per-source rates (served → rendered → qualified, open, save, share, remix, negatives, mean dwell and progress).

What it **cannot**, since there is no per-viewer grain:
- sample-ratio checks by viewer
- sessions per user, D1/D7 return
- the plan's primary metric, 7-day meaningful-creation rate (needs viewer → `generations` joins inside the 30-day raw window)
- position bias (position is not in the grain)
- format splits

Dashboards: none for feed quality. `/api/ops/backend-health` reports only feed retention lag (`src/lib/backend-health.ts:1537-1590`, `src/lib/feed-retention-lag.ts`) and table growth (`src/lib/operational-table-growth.ts:49`).

---

## 10. Consumers (mobile and web)

**Mobile.**
- **Requests** (`ugc-mobile/lib/showcase-feed-query.ts:88-112,145-156`): `sort=for-you&limit=12&offset=0`, then `cursor` (+ `feedSessionId`, which the server ignores). When there is no cursor it falls back to `nextOffset`.
- **Lanes** (`ugc-mobile/lib/home-feed-view-model.ts:22-30`):
  - `for-you`
  - `notes` = For You + `category=text`
  - `unlocks` = For You + `unlock=with-unlock`
  - `recent`

  The two filtered lanes rank from an unfiltered candidate set and filter in hydration. They can hydrate every candidate in ≤ 60-id batches (`showcase-feed-personalization.ts:747-761`) and lean on the recent top-up.
- **Persisted first page:** Home persists the For You first page for up to 3 days (`ugc-mobile/lib/persisted-home-feed.ts:24-30`). Its `deliveryId`s belong to a session that expires in 2 hours, so events on restored cards after that are rejected (`20260812150000:180-184`) until the refetch replaces them.
- **Recommendation fields:** the mobile type keeps `deliveryId, position, reason, algorithmVersion` (`ugc-mobile/lib/types.ts:794-799`). There is no `candidateSource`, and no score is sent to any client. `reason` is used only as event metadata `recommendationReason` (`ugc-mobile/lib/showcase-feed-events.ts:118-121`).

**Web.**
- `src/app/feed/FeedClient.tsx`: cursor paging (`:179-321`) and the hide menu.
- `src/app/showcase/ShowcaseClient.tsx`: paints the cached identityless bootstrap, then merges the personalised session under the visible prefix (`src/lib/showcase-feed-stability.ts:10-36`). Bootstrap items carry no `deliveryId`, so their impressions cannot be recorded.
- Neither web client renders `reason` (only `ShowcaseFeedInteraction.tsx:233` copies it into event metadata).

**A new candidate source** needs no client change. Clients never branch on source; `feed_session_items.candidate_source` is free text up to 80 characters, and the daily grain picks it up. On the server:
- add it to `ShowcaseFeedCandidateSource` (`src/lib/showcase.ts:173-179`)
- add it to the allowlist in `normalizeRankedFeedFeatureRow` (`showcase-feed-ranking.ts:230-238`); **unknown labels silently become `fresh`**
- give it a `sourceReason` string (`:270-285`)
- make any quota or slot rule aware of it (today only `'exploration'`, `:318-327`)

**A "why you're seeing this" UI** needs:
- a stable reason code: add `reasonCode` beside the English `reason` in `ShowcaseRecommendationContext` (`src/lib/showcase.ts:181-187`), set in `buildRecommendationContext` (`showcase-feed-ranking.ts:410-428`). Ideally it is derived from the dominant score component, not only the pool.
- the field on the mobile type
- a card or reel menu row on both platforms (JS-only; an OTA can carry it)
- contract fixture and test updates in both suites (AGENTS.md "Web ↔ mobile contract"). `recommendation` is not currently pinned in `contracts/mobile-api-v1.json`.

An optional field needs no `PERSISTED_HOME_FEED_FORMAT` bump.

---

## 11. Known weaknesses and open items

Evidence is cited inline. Items marked *(reading)* are inferred from code and not measured.

1. **No seen suppression on the live algorithm.** The v1 RPC has no seen columns (`20260809140000:77-88`), so `seenRecently` is always false. With a 60-item session cap and 2-minute reuse, every refresh re-serves the same top posts, shuffled only by freshness and exposure terms.
2. **v1 stats windows collapse to about 2 days.** `refresh_post_feed_stats` filters `events.session_item_id IS NOT NULL` (`20260711064036:1344-1345,1401`). Sessions are deleted when `expires_at < now − 2 d` (`20260809230000:97`), and the delete trigger nulls `session_item_id` (`20260715095000:68-87`). The 7d and 30d windows (usefulness, skip, negative risk, exploration bonus, exploration pool) therefore see only about 2 days. The interest refresh moved to `delivery_fact_id` for exactly this reason (`20261005170739:56-58`); v1 stats did not.
3. **Dead signals:** `follow`, `remix_complete`, `purchase` and `report` are rejected by the event API and written by no server action. `resource_open` has no emitter. The usefulness terms 1.25/2.0/2.5/0.75, the negative 2×report term, the interest weights +4/+6/+8/+2/−10 and the meaningful-engagement purchase and resource clauses are all inert.
4. **Hard-coded v1 weights in SQL** (`20260809140000:417-426`) pre-rank and cut to 300 independently of the row. The v1 `*_share` config is unused.
5. **Semantic diversity and the semantic source are inert;** the embeddings are unpopulated (§7.3).
6. **Coarse, quickly saturating interests** (§7.3). One onboarding goal outweighs a follow by 2.5×. One "not interested" lowers a whole format.
7. **Low dynamic range for quality** compared with freshness, interest and exposure terms (§3.4).
8. **Visibility is split across four layers:** SQL predicates, TS hydration (NSFW), the TS feedback re-check and the post-ranking block filter. Blocks act after persistence (§8).
9. **NSFW is filtered after retrieval,** so labelled posts consume candidate and hydration budget.
10. **Reports change nothing in the feed,** and hides cannot be undone server-side (§8).
11. **Filtered lanes rank from an unfiltered pool** (`p_category` is always null) *(reading)*.
12. **Batched aggregates fall behind as scale grows:** 1,000 posts per hour for v1 stats over a candidate set that never shrinks, and 1,000 users per hour for interests. Refresh latency grows linearly with catalog and active users *(reading)*. `docs/audits/backend-section-09-feed-interest-progress-2026-10-05.md` notes production-scale duration is uncertified.
13. **Shared refresh cursor.** v1 and v2 post stats both use `post_feed_stats.updated_at` as their least-recently-refreshed cursor (`20260711064036:1350`; `20260808130000:161`). Each run deprioritises rows the other just touched, so v2 columns can be staler than `updated_at` suggests *(reading)*.
14. **v2 signal coverage.** Home emits no dwell, progress, skip or (mobile) save events. v2's `video_start_count` counts Home renders as starts, but half-completions come only from the reel, so depth is biased low for Home-watched videos *(reading)*. Fix the telemetry before promoting.
15. **`creator_quality` is 0 for creators with no stats row and 0.15 (the cap) for almost everyone else.** That is a mild bias against new authors, the opposite of a new-author boost.
16. **The exploration label is lost in dedup** when the catalog is ≤ `recent_limit` (§5), so the exploration quota and `is_exploration` under-report.
17. **The trending pool ties at the prior** under sparse 24h activity (§5).
18. **Single experiment, no holdout, unused `targeting` and `config`;** anonymous-to-signed-in re-assignment (§9).
19. **Fallback-feature mixing.** Fallback items (synthetic exploration 0.75/0.9, depth 0.25) are ranked with real SQL features. RPC-failure sessions are labelled with the active version.
20. **No self-post exclusion; no creator-account-state check** (§8).
21. **Session constraints:** 2 h expiry, after which late events are rejected; events older than 24 h are rejected; a hard 60-item ceiling per ranking (`SHOWCASE_FEED_ELIGIBLE_ITEM_LIMIT`). The diversity pass sees only the top 60 by pre-score.
22. **v2 RPC cost is O(catalog)** (the `eligible` CTE, the posterior over all eligible posts, a correlated subquery in the interest-pool ORDER BY). The O(n²) reranker is negligible at n ≤ 60.
23. **Open items in docs:**
    - `docs/plans/feed_algorithm_v2.md`: scorecard and `/admin` panel (0A-4), A/A run, v1-vs-v2 experiment, Phase 1D ranking blocks, Phase 2 embeddings and clusters, Phase 3 learned ranking with position and propensity correction, Phase 4 retention loops
    - `docs/audits/scaling-findings-2026-08-22.md:233-250` S5: feed-fact pruning ceiling, REVALIDATE
    - `docs/audits/atomic-feed-session-2026-09-22.md:55-59`: P95 budget not established; candidate retrieval and hydration still material
    - section 9L/9M audits: production-scale query duration and full job fencing not certified

---

## 12. Test map

**Run in this worktree.** Web vitest, from the worktree root:

```
npx vitest run src/__tests__/{showcase-feed-ranking,showcase-feed-ranking-v2,showcase-feed-personalization,feed-experiments,\
showcase-feed-events-service,showcase-feed-events-route-adapter-service,showcase-feed-event-batching,\
showcase-feed-route-adapter-service,showcase-feed-route,showcase-feed,showcase-feed-identity,showcase-feed-stability,\
showcase-feed-cache-policy,showcase-feed-cache,showcase-viewer-exclusions-service,\
showcase-viewer-exclusions-route-adapter-service,showcase-viewer-exclusions-client,feed-maintenance,\
feed-maintenance-route,feed-retention-lag,feed-personalization-migration,feed-delivery-facts-migration,\
feed-ranking-v2-migration,feed-ranking-v2-starvation-free-refresh-migration,feed-ranking-limit-first-pools-migration,\
feed-fact-retention-visibility-migration,feed-delivery-fact-daily-migration,atomic-feed-session-migration,\
feed-interest-progress-migration,feed-event-batch-rpc-migration,feed-delivery-session-lookup-migration,\
feed-foreign-key-indexes-migration,prune-feed-clamp-fact-retention-migration,report-feed-retention-clamp-migration,\
feed-retention-probe-migration,feed-interest-progress-database,feed-maintenance-postgrest,moderation-service,\
user-block-list}.test.ts src/__tests__/feed-page-viewer-safety.test.tsx
```

(The brace form is shorthand; each path was passed explicitly.)

**Result:** 40 files; **38 passed, 2 skipped**; **278 tests passed, 19 skipped, 0 failed** (vitest 4.1.0, 5.4 s). The two skipped files are database-backed and need a local Postgres, so they skip without `SUPABASE_TEST_DB_URL`: `feed-interest-progress-database.test.ts` (2) and `feed-maintenance-postgrest.test.ts` (17).

Per-file passed counts:

| Test file | Passed |
|---|---|
| showcase-feed-ranking | 6 |
| showcase-feed-ranking-v2 | 10 |
| showcase-feed-personalization | 22 |
| feed-experiments | 12 |
| showcase-feed-events-service | 20 |
| showcase-feed-events-route-adapter-service | 14 |
| showcase-feed-event-batching | 3 |
| showcase-feed-route-adapter-service | 11 |
| showcase-feed-route | 4 |
| showcase-feed | 30 |
| showcase-feed-identity | 4 |
| showcase-feed-stability | 3 |
| showcase-feed-cache-policy | 2 |
| showcase-feed-cache | 1 |
| viewer-exclusions service / adapter / client | 10 / 6 / 8 |
| feed-maintenance | 5 |
| feed-maintenance-route | 3 |
| feed-retention-lag | 12 |
| moderation-service | 6 |
| user-block-list | 12 |
| feed-page-viewer-safety | 2 |

Migration text tests:

| Migration test | Passed |
|---|---|
| personalization | 10 |
| delivery-facts | 8 |
| ranking-v2 | 10 |
| v2-starvation-free | 6 |
| limit-first-pools | 8 |
| fact-retention-visibility | 4 |
| fact-daily | 7 |
| atomic-session | 1 |
| interest-progress | 1 |
| event-batch-rpc | 4 |
| session-lookup | 1 |
| foreign-keys | 1 |
| prune-clamp | 5 |
| retention-clamp | 4 |
| retention-probe | 2 |

**Not run:**
- **pgTAP** (needs the local Supabase stack, which this task excluded): `supabase/tests/database/` `atomic_feed_session`, `feed_delivery_fact_daily`, `feed_delivery_session_lookup`, `feed_event_batch_rpc`, `feed_interest_empty_progress`, `feed_retention_clamp_reporting`, `feed_session_pruning`, `prune_feed_clamp_fact_retention` (`.test.sql`).
- **Mobile** (no `ugc-mobile/node_modules` in this worktree; run with `cd ugc-mobile && npx vitest run __tests__/<file>`): `showcase-feed-events`, `feed-event-queue`, `persisted-home-feed`, `showcase-feed-query`, `home-feed-view-model`, `feed-pagination(-integration)`, `showcase-feed-view-model`, `showcase-save-feed-refetch`, `feed-installation-id`.
- **Other web feed UI tests:** `feed-client-*.test.tsx`, `showcase-feed-interaction.test.tsx`, `windowed-feed-list*.test.*`.

**Coverage gaps:**
- No behavioural (database) test of `get_ranked_feed_candidates`, `get_ranked_feed_candidates_v2`, `refresh_post_feed_stats`, `refresh_post_feed_engagement_stats`, `refresh_creator_feed_stats` or `seed_user_interest_from_onboarding_goal`. The migration tests assert SQL text only. The DB-backed `feed-maintenance-postgrest` covers the maintenance chain, and runs on CI only.
- No test pins the TS default weights against the seeded v1 row, or the SQL-literal weights (`20260809140000:417-426`) against the row.

---

## 13. Where each X-style mechanism would plug in

| X mechanism | Today | Missing | Where the change goes |
|---|---|---|---|
| **Predicted-action scoring `Σ wᵢ·P(actionᵢ)`** | A linear sum of 8/12 clamped features: post-level smoothed population rates plus coarse viewer interest and affinity. There are no per-(viewer, post) probabilities. Hand-set weights live in `weights` JSON. | Per-action predictions P(open), P(save), P(remix_start), P(dwell ≥ 3 s / video ≥ 50%), P(quick_skip), P(not_interested/hide), calibrated per viewer; a training loop. | **Features:** new columns on `get_ranked_feed_candidates_v2` RETURNS TABLE (`20260728181000:556-573`), e.g. per-viewer-segment action rates from `feed_delivery_facts`. **Score:** `scoreRankedFeedFeatures` (`showcase-feed-ranking.ts:157-175`) with action-keyed weights in `normalizeRankedFeedScoreWeights` (`:105-123`). **Logging:** add the predictions to `scoreComponents` (`showcase-feed-personalization.ts:95-112`). **Training data:** facts (30-day raw retention, `feed-retention-policy.ts:45`); needs the dead events (§7.4) fixed first. |
| **Author-diversity decay** | Hard caps: no back-to-back, ≤ `max_creator_per_20` per rolling 20, relaxed only when inventory runs out (`showcase-feed-ranking.ts:287-316,398-401`). | Multiplicative decay `score × max(floor, decay^k)` where k = posts already selected from the same author, re-evaluated each pick. | `rankAndDiversifyShowcaseItems` (`:341-408`): recompute the effective score per pick instead of the static sort. New keys `author_decay`, `author_decay_floor` in `normalizeRankedFeedDiversityConfig` (`:125-155`). Persist k and the multiplier in `score_components`. |
| **Out-of-network discount** | None. In-network effect is additive only: `creator_affinity` +0.75 × 0.15 (v1) / 0.12 (v2) (`20260809140000:382-403`). `candidate_source='following'` marks only following-pool winners. | An explicit `is_in_network` flag and a multiplicative OON factor. | Return `is_following boolean` from both RPCs (v1 `20260809140000:77-88`; v2 `20260728181000:556-573`); add it to `RankedFeedFeatureRow` (`showcase-feed-ranking.ts:39-58`); apply the factor in `scoreRankedFeedFeatures` or the reranker; config key such as `weights.out_of_network_multiplier`. |
| **New-author boost toward a target position** | Post-level only: v1 `exploration_bonus`, v2 UCB (0.933 when unexposed). The exploration quota (`mustSelectExploration`, `:318-327`) rarely fires (§11.16). v2 `creator_quality` gives new authors 0 vs 0.15. | Author age and exposure in features; a rule placing ≥ 1 new-author post by position K. | SQL: join `profiles.created_at` and `creator_feed_stats.rendered_count` (30d) in the v2 RPC and emit `author_rendered_30d` / `author_age_days`. TS: generalise `mustSelectExploration` into a positional quota (`new_author_by_position` in diversity config). Remove or invert the cap-equals-prior behaviour of `creator_quality` (`20260808130000:112-113`). |
| **Visibility filtering separate from ranking** | Split across SQL pool predicates, TS hydration (NSFW, filters), `filterActiveViewerFeedback`, and the post-ranking block filter (`showcase-feed.ts:1371-1403`). | One pre-ranking stage with reason codes; blocks before ranking and persistence. | New module (e.g. `src/lib/feed-visibility-filter.ts`) called in `getPersonalizedShowcaseFeedPage` where the feedback filter runs (`showcase-feed-personalization.ts:970-976`) and in `loadPersistedPage` (`:470-475`); move `loadBlockedCreatorIds` into it. SQL: add a materialised `viewer_blocked_creators` CTE beside `viewer_hidden_creators` (`20260809140000:118-124`; v2 `eligible` `20260728181000:627-663`) and add `is_nsfw = false` to pool predicates. |
| **Stricter recommendation-only rules** | Only `is_nsfw` exclusion (For You only) and For You-only hide lists. | Rules such as: reported-by-viewer → excluded; creator or post report velocity → no recommendation; young or unverified accounts not recommended out-of-network; negative-feedback rate above a threshold → excluded; self-posts excluded. | The same visibility stage with `surface='recommendation'`. Data already exists in `post_reports`, `posts.report_count`, `moderation_reports`, `profiles`. For "reported by viewer" also write a `feed_user_post_feedback` row in `post-report-service.ts:153-167`. |
| **Explicit candidate sources with ratios** | Five pools with sizes (v1 hard-coded; v2 from `retrieval_config`), first-wins dedup by priority, no final mix ratio except 1 exploration per 10. | Per-source quotas (in-network / out-of-network / popular / exploration) in the final list; multi-source membership. | Pools: `get_ranked_feed_candidates_v2` (`20260728181000:699-776`). Return `array_agg(source)` instead of `DISTINCT ON` first-wins. Quotas: `rankAndDiversifyShowcaseItems` via a `source_mix` map in diversity config. Labels: §10 checklist (`src/lib/showcase.ts:173-179`, `showcase-feed-ranking.ts:230-238,270-285`). |
| **Age filter** | None; only the 72 h freshness decay. Old posts enter via following, interest, trending and exploration. | A max age per pool, e.g. different for in-network and out-of-network. | Pool predicates in the v2 RPC (or the v1 limit-first pools) with a new `p_max_age_days` parameter; add it to `normalizeRetrievalConfig` (`showcase-feed-personalization.ts:252-271`) and to the RPC call (`:704-721`). |
| **Seen / served filters** | v2 only: 14-day qualified-impression seen tier with a ×0.2 fallback. Within-session uniqueness via constraint. Live v1: none. | A cross-session "served recently" filter; seen for the live version; optionally client-supplied seen ids. | v2 `seen` CTE (`20260728181000:609-626`): union `feed_delivery_facts` served in the last N hours for the viewer (`feed_delivery_facts_viewer_ranked_idx` exists; anonymous needs an index). Or activate v2. |
| **Muted keywords** | None (no table, no matching); no author mute (hide_creator is the nearest). | `user_muted_keywords` (and optionally `user_muted_creators`). | New migration and table; filter in the visibility stage on `title`, `prompt` and `body` (already selected in `fetchPostRowsByIds`, `showcase-feed.ts:253`), or a tsvector predicate in the v2 `eligible` CTE. |
| **Deterministic holdouts for measurement** | Deterministic salted SHA-256 bucketing, stored assignments, facts stamped with experiment and variant (`feed-experiments.ts:39-76,132-223`). One experiment at a time. | A global long-lived holdout independent of experiments; a holdout flag on facts and daily grain; concurrent experiment layers; viewer-grain readout. | `resolveFeedExperimentAssignment`: check a global-salt holdout bucket first. Add a `holdout` column to `feed_delivery_facts` (`20260728180500:23-117`), `persist_ranked_feed_session` (`20260922054500:63-82`) and the daily grain (`20260809180000:31-74`). Add a viewer-grain daily table for sample-ratio checks and D7/creation metrics. |
| **Config-driven params mirrored in code** | Weights, diversity and retrieval JSON per version, bounds-checked with v1-equal defaults (`showcase-feed-ranking.ts:66-155`; `showcase-feed-personalization.ts:252-293`), stamped on sessions and facts. v2 RPC takes pool sizes, seen lookback, prior cap and UCB `c`. | Many constants are SQL literals (priors 2/25, 1.25/5, 0.2/20, 1/8, 1.5/6, 2/12, 3/20; 72 h half-life; /10 interest divisor; follow 0.75; interest event weights; window lengths). The v1 SQL duplicates its weights. Session constants (60, 2 h, 2 min) live in TS. There is no TS-default ↔ seeded-row parity test. | Move feature constants into `retrieval_config` → RPC parameters (pattern in `get_ranked_feed_candidates_v2`'s signature). Keep the TS normalisers as the single schema. Add parity tests, extending `showcase-feed-ranking-v2.test.ts:47-71`, that pin TS defaults to the seeded rows and forbid literal weights in SQL. |
