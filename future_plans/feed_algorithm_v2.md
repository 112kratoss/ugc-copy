# Feed Algorithm v2 — Analysis, Research, and Plan (rev 2)

_Date: 2026-07-28. Analysis of `for-you-rules-v1` and a phased plan toward platform-grade ranking. Rev 2 incorporates review corrections: the measurement and ranking contracts must be repaired before any ranking-signal work._

---

## 1. What we have today (`for-you-rules-v1`)

### Pipeline

```
feed_events (16 types, idempotent, delivery-attributed while the session lives)
        │  feed-maintenance job: HOURLY at :20 (batches of 1000)
        ▼
post_feed_stats (24h/7d/30d Bayesian aggregates)          ← refresh_post_feed_stats
user_interest_weights (4 dims, 30d half-life decay)       ← refresh_user_interest_weights
        │
        ▼  per feed request (no cursor)
get_ranked_feed_candidates: 5 pools (sizes hard-coded in SQL)
  following ≤100 │ interest ≤150 │ trending ≤100 │ recent ≤150 │ exploration ≤100
        │  dedup → 8 features/candidate → ORDER BY **hard-coded v1 weights** → LIMIT 300
        ▼
TS re-sorts survivors with DB-configured weights → greedy diversity rerank
  no creator back-to-back · ≤2/creator per 20 · ≤3/semantic-cluster per 20 (inert)
  ≥1 exploration per 10 · ≤20% paid
        ▼
feed_sessions + feed_session_items (frozen 60-item session, 2h TTL, 2min reuse)
  → stable cursors, per-item deliveryId → but session graph is PRUNED after ~2 days,
    and retained feed_events are detached (session_id/session_item_id nulled)
```

### Two truths the first draft of this plan got wrong

1. **Ranking weights are only half DB-versioned.** The SQL pre-ranker orders and truncates to 300 with hard-coded v1 weights (`20260711064036` migration, ORDER BY at line ~992); `retrieval_config` pool shares are stored but unused (pool caps hard-coded). TS applies configurable weights only to the survivors. A v2 experiment with meaningfully different weights would be testing "reordering of v1's top-300", not a different ranking.
2. **The training log does not accumulate.** `score_components` live on `feed_session_items`; the prune job (`20260715095000`, ~2-day session retention) deletes the session graph and **nulls `session_id`/`session_item_id` on retained events**. `feed_events` carries no authoritative `algorithm_version_id`/`experiment_assignment_id` (only a client-supplied metadata string). After ~2 days, features and outcomes can no longer be joined → no offline analysis, no learned ranking, no honest D7 attribution.

### Client telemetry reality

- Web reel viewer emits: `open`, `impression` (after 1s), then `quick_skip` (<1s, and silently nothing if <250ms) or `dwell`. Mobile viewer emits: `impression` (after 1s), `quick_skip`/`dwell`.
- **Nobody emits `media_progress`.** The API accepts it; a completion-rate feature would read zero today.
- **Denominators are inconsistent:** a `quick_skip` fires *instead of* an `impression` (skips never have matching impressions), yet `quick_skip_rate = skips/(impressions+5)`. `dwell_ms/impressions` mixes feed cards, opened reels, images, and videos. All engagement rates need format- and surface-aware denominators.

### Honest strengths (keep all of this)

1. Delivery attribution exists at serve time (`deliveryId` per item) — the bones of a proper experimentation/training pipeline; it just isn't durable yet.
2. Bayesian smoothing everywhere; small-sample posts can't fake virality.
3. Negative feedback dominates (−0.80 weight; −6/−8/−10 interest hits; hard exclusions).
4. Frozen sessions: stable pagination, reproducible ranking, refresh-spam protection.
5. Versioned algorithm config + `algorithm_version` stamped on sessions.
6. Multi-pool retrieval mirrors industry candidate generation in miniature.
7. Locked-down RLS, event-context validation trigger, clock-skew rejection.

### Gap summary (post-review)

| # | Gap | Status |
|---|-----|--------|
| 1 | Two-stage ranking contract broken (SQL pre-ranker hard-coded) | Blocks experiments |
| 2 | Attribution/training data destroyed by pruning after ~2 days | Blocks measurement |
| 3 | Watch-time signals not collected (`media_progress` unsent) nor ranked | High leverage, needs 0A first |
| 4 | Engagement-rate denominators incoherent (skip vs impression, mixed formats) | Fix in 0A |
| 5 | No cross-session seen-post suppression → repeats | High leverage |
| 6 | Semantic layer dead (pgvector tables unpopulated, `semanticCluster` always null) | Phase 2 |
| 7 | Creation activity absent from interests (only feed events feed them) | High leverage |
| 8 | Cold start: onboarding's image/video/motion goal is captured but never seeds interests | Quick win |
| 9 | Experiments framework unwired (no assignment code) | Phase 0B |
| 10 | Exploration = lowest-impressions ordering, no posterior logic | Phase 1E |
| 11 | No creator prior (needs fairness cap when added) | Phase 1E |
| 12 | Personalization latency: hourly maintenance; nothing adapts within a session | Phase 1D |

---

## 2. Research: how the major platforms drive engagement

From the platforms' own disclosures plus research literature. Claims below are hedged to what's actually public; these systems are partly opaque and change constantly.

- **Rank by predicted per-user engagement, not global quality.** All three major feeds describe scoring candidates with predictions (P(watch), P(share), expected watch time) blended into a value score. TikTok's official explainer lists watched-to-completion, shares, likes, follows, and *content you create* among ranking inputs, weighted by signal strength — completion is called out as a strong signal ([TikTok newsroom](https://newsroom.tiktok.com/how-tiktok-recommends-videos-for-you?lang=en)).
- **Watch behavior is central but no longer sufficient alone.** Instagram (Mosseri) names watch time — relative % and absolute seconds — plus sends-per-reach and likes-per-reach as top Reels signals. YouTube describes watch time as one signal among several, deliberately re-weighted by **satisfaction** (surveys, "valued watch time") after raw time-max promoted regretted bingeing ([YouTube blog](https://blog.youtube/inside-youtube/on-youtubes-recommendation-system/)). Meta's Reels engineering explicitly warns that watch time and engagement alone are noisy proxies and describes correcting with user-feedback models ([Meta Engineering, Jan 2026](https://engineering.fb.com/2026/01/14/ml-applications/adapting-the-facebook-reels-recsys-ai-model-based-on-user-feedback/)).
- **Explicit interest capture + interest graph.** TikTok and Instagram both front-load explicit interest/topic selection and lean on watch-behavior interest graphs over follow graphs.
- **Seen-content suppression + guaranteed freshness.** TikTok's explainer states it avoids repeating videos you've seen; a reliable stream of new content per session is a core reopen driver.
- **Cheap exploration with fast amplification.** New content gets small trial exposure that expands with performance. (The widely-cited "200–500 first views" figure lacks a primary source — treat as folklore; the *mechanism* of staged trial-and-expand is well attested.)
- **Fast feedback loops.** ByteDance's Monolith paper documents online training with minutes-level parameter sync for BytePlus Recommend (their commercial recsys, not confirmed TikTok production — but directionally credible; [paper](https://arxiv.org/abs/2209.07663)). Users experience this as within-first-session adaptation.
- **Experiment velocity is the moat.** Continuous A/B against retention/satisfaction metrics, with guardrails (sample-ratio checks, holdouts), is the durable capability — more than any single model.

**Not for us at current scale:** deep two-tower retrieval/online-trained DNNs (insufficient traffic to train; under-trained ML loses to good heuristics + embeddings + Bayesian smoothing), and raw time-in-app as the objective (feed minutes are our biggest cost — Supabase egress — and our feed exists to drive creation/remix/purchases; YouTube's satisfaction framing fits us better than time-max).

---

## 3. The plan (revised sequence)

**North-star decision (product owner):** recommended composite = **D7 retention** + **feed→creation conversion** (remix_start / resource_open / purchase per session), with session depth and egress/DAU as guardrails. Locks in before 0A metric definitions.

### Phase 0A — Measurement contract (prerequisite for everything)

> **Implementation status (2026-07-28):** items 1–3 are built and verified —
> migration `20260728180500_feed_delivery_facts.sql`, serve-path fact writes in
> `showcase-feed-personalization.ts`, media_progress GREATEST upsert in
> `showcase-feed-events-service.ts`, and milestone/background/exit completion
> telemetry in both reel viewers (`showcase-media-progress.ts` on each
> platform). Item 4 (daily scorecard + `/admin` panel) is the remaining 0A work.
>
> **Phases 0B / 1A / 1B / 1C / 1E are also built** in migration
> `20260728181000_feed_ranking_v2.sql` plus `feed-experiments.ts` and the v2
> feature/weight/reranker changes. `for-you-rules` v2 exists as a **shadow**
> version: nothing serves it until it is activated or referenced by an
> experiment variant, so the live feed is unchanged by the deploy. What remains
> before switching traffic on is the scorecard (0A item 4), the A/A run, and a
> real v1-control versus v2-treatment experiment — without them there is no way
> to read whether v2 is better. Phase 1D (ranking blocks) and Phase 2
> (embeddings) are untouched.

1. **Durable attribution (decided).** Append-only `feed_delivery_facts` table written at serve time, keyed by the delivery id (`feed_session_items.id`), carrying `algorithm_version_id`, `experiment_assignment_id`, viewer identity, post/creator, position, candidate_source, is_exploration (+ propensity later), score, `score_components`, surface/mode, served_at. Own retention, exempt from session pruning. **Critically, `feed_events` gains an immutable `delivery_fact_id` stamped server-side at ingest** — session pruning still nulls `session_item_id`, so without the snapshot column the fact→outcome join dies with the session graph. Serves are countable even when no event fires (honest qualified-view denominators).
2. **Instrument completion.** Emit `media_progress` from both viewers with **milestone + background + exit flushes** (one exit-only event undercounts app kills and network failures); the server upserts `GREATEST(existing_progress, new_progress)` per delivery. Include video duration so relative and absolute watch are both derivable.
3. **Redefine rates with correct denominators, segmented by format (video/image/text) and surface (card vs reel):**
   - qualified-view rate = impressions / served deliveries
   - quick-skip rate = quick_skips / reel starts (opens), not impressions
   - completion = completions / video starts; relative completion normalized by duration
   - expected watch seconds = Σwatch / video starts
4. **Core scorecard job + `/admin` panel:** per day × experiment × variant × algorithm version × surface × format — the rates above, saves/remixes/purchases per 1k impressions, sessions/user, D1/D7 return cohorts, **repeat-exposure rate** (share of served items previously seen), egress/DAU. Store raw numerators and denominators; derive rates at read time. Sample-ratio checks use assigned/exposed viewers, never delivery counts.

### Phase 0B — Ranking contract

1. Make retrieval configuration-honest. Preferred: `get_ranked_feed_candidates` returns the deduped candidate union with features, **unranked and untruncated** (or truncated per-pool by parameters); TS becomes the single scorer. Alternative: pass weights + pool shares into the RPC. Either way, `retrieval_config` must actually drive pool sizes.
2. Wire experiment assignment: resolve running `feed_experiments` → deterministic hash(viewer, salt) → variant → `algorithm_version_id`; stamp `experiment_assignment_id` on sessions (and per 0A, onto durable facts).
3. **Run an A/A experiment first.** Two identical variants; verify sample-ratio, metric parity, and that the pipeline detects no false winners. This validates the whole measurement stack before a real v1-control versus v2-treatment A/B; only that A/B can support activation.

### Phase 1A — Seen-post suppression (biggest feel-improvement per line of code)

> **Built.** The viewer's recent qualified impressions are collected once per
> request (cost tracks viewer activity, not catalog size), every retrieval pool
> prefers unseen rows, and the reranker treats "seen" as a hard tier: a repeat
> is selected only when no unseen candidate remains at all — diversity fatigue
> is explicitly not enough of a reason to serve one — with score ×0.2 and
> least-recently-seen first. Anonymous viewers are covered via their key hash;
> `seen_lookback_days = 0` is the kill switch.

- **Strict unseen-first for 14 days** (decided): exclude posts with a qualified impression by this viewer (user id **or** anonymous key hash). No followed-creator exemption — following affinity ranks *unseen* posts; it must not force exact repeats. Fall back to a repeat penalty (score ×0.2, oldest-seen first) **only when unseen inventory cannot fill the next ranking block**.
- Supporting partial indexes on `feed_events` (must include `post_id` to be usable as an anti-join):
  - `(viewer_user_id, post_id, occurred_at DESC) WHERE event_type = 'impression'`
  - `(anonymous_key_hash, post_id, occurred_at DESC) WHERE event_type = 'impression'`
- Watch the 0A repeat-exposure metric drop; guard qualified-view rate.

### Phase 1B — Watch-time ranking features (after 0A telemetry is proven)

- Extend `refresh_post_feed_stats` with format-aware aggregates: completion rate, relative completion, expected watch seconds — Bayesian-smoothed with the same prior style, only over video starts.
- Add them as ranked features with weights in a `for-you-rules` v2 row (testable via 0B). Suggested starting blend: replace part of `smoothed_usefulness`'s weight rather than piling on.

### Phase 1C — Interests: seed and broaden

- **Seed from the onboarding goal that already exists** (image/video/motion → `media_type` weight ≈5). Zero new UX. An additional optional interest-chip step is itself an experiment (mandatory chips risk onboarding completion).
- **Creation signals:** in `refresh_user_interest_weights`, UNION events derived from **successful `generations`** (status/completed_at, with model/template metadata) joined to `template_runs` where applicable — mapped to category/media_type/source_tool at roughly save-level weight (3.0), template/paid usage higher. (Not `generation_start_requests` — that table only stores idempotency binding, no completion status or content metadata. Not the `ai_usage_events` credit ledger either.) What a user *makes* is the strongest interest signal a UGC app has.

### Phase 1D — Faster adaptation via ranking blocks (not tail mutation)

Frozen positions, cursors, and delivery attribution make in-place reordering of a session's tail unsafe. Instead: build sessions in **blocks of 10–20**. Serving the last items of block N triggers generation of block N+1, ranked with the session's events so far (skipped clusters demoted, engaged clusters/creators promoted) and appended at stable positions. Session invariants hold; personalization latency drops from "next session" to "next block". (This also creates the natural hook point for Phase 2's "more-like-this" probes.)

### Phase 1E — Exploration and priors, done properly

> **Built.** Exploration is Bayesian UCB over Beta(meaningful + 1, rendered −
> meaningful + 1) from `feed_delivery_facts`; the creator prior is a separate
> feature capped at `creator_prior_cap` (0.15) and never blended into a post's
> own evidence. `is_meaningful_feed_engagement()` is the single SQL definition
> of the locked reward, shared by retrieval, post stats, and creator stats so
> they cannot drift. Verified live: an unexposed post scores UCB > 0.85 while a
> measured mediocre post scores < 0.85, and a creator whose true quality is 0.20
> still contributes exactly 0.15. The deterministic v2 policy logs conditional
> exploration propensity as 1/0; inverse-propensity training remains disabled
> until a future stochastic exploration policy provides non-degenerate support.

- **Exploration:** define the binary reward first (suggested: qualified view with ≥50% relative completion, or any save/remix — decide alongside the north star). Then start with **Bayesian UCB** on Beta(successes+α, failures+β) — deterministic, debuggable, one query; graduate to true Thompson sampling (posterior draws) if/when we want more aggressive discovery. (The first draft's `random()^(1/(useful+1))` was weighted shuffling, not Thompson sampling.)
- **Creator prior, capped:** blend creator 30d quality into new posts' usefulness via a weak hierarchical prior (small k), with an explicit cap on its contribution (e.g., ≤0.15 of the feature range) to avoid rich-get-richer lock-in. Note TikTok publicly states past performance isn't a direct ranking factor for new videos — the cap keeps us honest for creator equity.
- Log the exploration propensity on the delivery fact. Deterministic UCB honestly logs 1/0; a later stochastic policy must log its actual draw probability before propensity-corrected training is valid.

### Phase 2 — Content understanding

1. Populate `post_content_embeddings` at publish + backfill job (embed prompt + caption + tool/model metadata — every post has rich text provenance; no CV needed).
2. Per-user taste vector = decayed mean of embeddings of saved/completed/remixed posts (refresh in the hourly job).
3. Semantic candidate pool via `match_post_content_embeddings` (TS already accepts the `semantic` source end-to-end).
4. Offline clustering (~50–200 clusters) → populate `semanticCluster` → the existing diversity rule activates; clusters become finer interest dimensions.
5. "More like this" probe: after a strong positive, the next **block** (1D) front-loads semantic neighbors.

### Phase 3 — Learned ranking (once 0A facts accumulate and heuristics plateau)

Offline logistic regression on the durable delivery facts: predict P(save), P(quick_skip), P(remix) per impression; blend into a value score; ship as coefficients in a new algorithm version. **Must** correct for position bias (position is on the fact row) and exploration propensity (1E). Heavier models only if data volume ever justifies them.

### Phase 4 — Retention loops outside the feed

Creator-side notifications first ("your post was remixed/saved" — the most defensible hook for a creation app), followed-creator new posts, weekly digest from your clusters, guaranteed K never-seen fresh items per new session.

### Guardrails

- Negative feedback and moderation signals must always be able to zero a post regardless of engagement (YouTube's satisfaction pivot exists because raw watch-time-max amplified regretted/borderline content; Meta says the same about noisy engagement).
- Sample-ratio checks + A/A validation before trusting any experiment readout.
- Egress/DAU tracked beside engagement (engagement ↑ ⇒ video egress ↑; renditions mitigate, don't eliminate).
- Every change ships as a new `feed_algorithm_versions` row — attributable, reversible.

### Product decisions (locked 2026-07-28)

1. **North star — no weighted composite.**
   - Product north star: **Weekly Retained Creators** — users who successfully create/remix in both the current and preceding 7-day windows.
   - Experiment primary: **7-day meaningful-creation rate** = feed-exposed assigned users completing a successful generation or remix within 7 days ÷ feed-exposed assigned users.
   - Leading diagnostic: feed→creation conversion. Secondary outcome: D7 feed return.
   - Guardrails: negative-feedback rate, egress/DAU, feed latency, crash/error rate.
2. **Exploration reward — binary "meaningful engagement" per rendered delivery:** success = video ≥50% relative completion, OR image/text ≥3s active dwell, OR save / remix start / resource open / purchase. A rendered delivery with none is a failure. **Never-rendered deliveries are excluded, not failures** (facts must record renderedness).
3. **Seen policy:** strict unseen-first, 14 days, ×0.2 penalty fallback only when a ranking block cannot fill from unseen inventory; no followed-creator exemption.
4. **Interest chips: not yet.** Seed from the existing image/video/motion goal, measure cold-start, and only test a "Tune your feed" surface if evidence shows a remaining problem.

The delivery-fact schema captures primitive measurements (render, qualified view, dwell ms, max progress, per-action flags) broadly enough that future KPI redefinitions need no reinstrumentation.

---

## Sources

Primary/official:
- [TikTok — How TikTok recommends videos #ForYou](https://newsroom.tiktok.com/how-tiktok-recommends-videos-for-you?lang=en)
- [YouTube — On YouTube's recommendation system](https://blog.youtube/inside-youtube/on-youtubes-recommendation-system/)
- [YouTube Help — How YouTube recommendations work](https://support.google.com/youtube/answer/16089387?hl=en)
- [Meta Engineering — Adapting the Facebook Reels recsys AI model based on user feedback (Jan 2026)](https://engineering.fb.com/2026/01/14/ml-applications/adapting-the-facebook-reels-recsys-ai-model-based-on-user-feedback/)
- [Monolith: Real Time Recommendation System With Collisionless Embedding Table (BytePlus Recommend)](https://arxiv.org/abs/2209.07663)

Secondary/context:
- [Instagram signals per Mosseri — Dataslayer summary](https://www.dataslayer.ai/blog/instagram-algorithm-2025-complete-guide-for-marketers), [Torro summary](https://torro.io/blog/instagram-algorithm-2025-explained)
- [Hootsuite — TikTok algorithm guide](https://blog.hootsuite.com/tiktok-algorithm/)
- [arXiv — Simulating User Watch-Time to Investigate Bias in YouTube Shorts](https://arxiv.org/pdf/2507.04534)
- [arXiv — Towards a Theoretical Understanding of Two-Stage Recommender Systems](https://arxiv.org/pdf/2403.00802)
- Background: YouTube DNN recsys (Covington et al.), Twitter's open-sourced `the-algorithm`, Instagram engineering blog on multi-stage ranking.
