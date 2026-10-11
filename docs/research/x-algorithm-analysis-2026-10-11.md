# X "For You" algorithm: engineering analysis for a small-scale feed

Source: `github.com/xai-org/x-algorithm` at commit `cb45b5501423126adfc508052116c2d67c0e3fec` ("Open-source X Recommendation Algorithm", 2026-10-09 05:42 UTC), read from a shallow clone. `home-mixer/params/param.rs:1` says its defaults are "mirrored from config feature-switch defaults; last sync 2026-10-08T16:00:35Z". All paths are relative to the repo root. For multi-line `param!` entries the cited line is the line that holds the value. Nothing was built or run; every statement comes from reading the code. Where something is inferred, the text says so.

---

## 1. Executive summary

The For You feed is built per request by `home-mixer`, written in Rust. It pulls up to about 3,700 candidates from four live sources:

- **Thunder:** the followed accounts' posts from the last 48 hours, held in memory.
- **Phoenix retrieval:** a two-tower retrieval model.
- **SimClusters:** item-to-item nearest-neighbour search, seeded with the viewer's recent engagements.
- **Popular posts:** one shared list of posts ranked by projected 24-hour views.

It then applies 19 filters: age over 48 hours, seen or served, own posts, blocks and mutes, replies and reposts from accounts the viewer does not follow, and others. One transformer, Phoenix, scores every remaining post. For each post it predicts about 23 action probabilities and two dwell values.

`xai-value-model` turns those predictions into one number with hand-set weights. The weights make negatives dominate. For example, report is −234 and like is +0.5. An offset then places every net-negative post below every net-positive one.

A separate service, `vm-ranker`, applies the post-scoring adjustments:

- **Repeat-author decay:** each repeat post from an author is multiplied by 0.5ᵏ, rescaled so it never falls below a floor of 0.25.
- **Out-of-network discount:** ×0.75, which also applies to replies and reposts from followed accounts.
- **New-post exploration slot:** chosen in `home-mixer` and replayed here. One fresh, low-exposure post per request, picked by Thompson sampling, is lifted to rank 16.
- **Diversity filter:** a determinantal point process (DPP) over 1024-dimension post embeddings. It keeps 50 posts from the top 150, trading score for dissimilarity.

Only after ranking does visibility filtering decide, per post and viewer, whether to allow, blur or drop. It has a much stricter rule list for posts from accounts the viewer does not follow. For example, an NSFW-labelled author is dropped for non-followers and at most blurred for followers. The surviving 35 posts are then blended with ads (each ad placed between two brand-safe posts), a Who to Follow module at slot 6 and prompts at the top.

What transfers to a Postgres and TypeScript feed with thousands of interactions is the structure, not the model:

- per-action predictions combined by explicit, versioned weights, with negative feedback weighted heavily
- the author decay, the out-of-network discount and the exploration slot
- a "fresh cold pool" candidate source and follower-reach targets
- near-duplicate suppression
- safety rules kept separate from ranking, with a stricter tier for recommendations
- parameters held in config, with the production defaults mirrored into code

These do not transfer: the Phoenix transformer (10¹¹ training samples, 100M-row hash tables), semantic IDs, SimClusters, Thunder, the Kafka infrastructure and the ads stack.

---

## 2. Request path

The framework is `candidate-pipeline/candidate_pipeline.rs:123-158`. It runs these stages:

1. query hydrators, in parallel (`join_all`)
2. dependent query hydrators
3. sources, in parallel
4. candidate hydrators, in parallel
5. filters, sequentially (`:374-392`)
6. scorers, sequentially (`:398-409`)
7. the selector
8. post-selection hydrators
9. post-selection filters
10. truncation to `result_size`
11. side effects, asynchronously

The post pipeline is `PhoenixCandidatePipeline` (`home-mixer/candidate_pipeline/phoenix_candidate_pipeline.rs`). The blending pipeline is `ForYouCandidatePipeline` (`home-mixer/candidate_pipeline/for_you_candidate_pipeline.rs`).

| # | Stage | Component (path:line) | What it does | Key parameters (defaults) |
|---|---|---|---|---|
| 1 | Query hydration | `phoenix_candidate_pipeline.rs:257-308` | Loads the viewer's two action sequences, one for scoring and one for retrieval, from the user-action-aggregation service. Also loads blocked, muted, followed and subscribed IDs, cached posts, mutual follows, demographics, followed Grok topics, starter packs and installed apps. Adds explicit engagement signals (like, repost, reply, bookmark, share, own post) and implicit ones (photo expand, video quality view (VQV), immersive VQV). Finishes with impression bloom filters, IP geo and inferred gender. | `MaxSeqLengthScoring`/`Retrieval` 1024 (`param.rs:836`, `:842`); aggregation `DENSE_WITH_LONG_DWELL` (`:161`, `:167`); `UAS_WINDOW_TIME_MS` 300000 (`params/config.rs:38`); `EngagementSignalsMaxPerType` 15 (`param.rs:620`). `ImpressedPostsQueryHydrator` is built but not added (`:310-312`). |
| 2 | Candidate sources | `:354-364` | Nine sources run in parallel. Four are on for a normal For You request: Thunder, PhoenixSource, Simclusters and PopularPosts. | Thunder 1200 (`param.rs:27`). Phoenix 1000 plus a "cold" pool of 200 (`:8`, `:20`). SimClusters ≤800 (`sources/simclusters_source.rs:26`). Popular 500 (`param.rs:953`). Off: TweetMixer (`:51`), PhoenixMOE (`:174`, max 0 at `:198`), SID (`:632`). PhoenixTopics runs only for topic requests. |
| 3 | Candidate hydration | `:366-393` | Adds: in-network flag (author is followed or is the viewer), mutual follow, core post data, reply ancestors, quoted post, media, subscription, author data (follower count, NSFW flags), blocked-by, topics, language, engagement counts (including home views) and semantic IDs. | `in_network` (`candidate_hydrators/in_network_candidate_hydrator.rs`) |
| 4 | Pre-scoring filters | `:395-424` | 19 filters in order (see §5). | Age 48 h (`params/config.rs:40`) |
| 5a | Scoring: Phoenix | `scorers/phoenix_scorer.rs:79-129` | One request per viewer returns per-candidate head predictions. Skipped when the request is served from the candidate cache (`:69-71`). | Cluster `Experiment1Fou` (`param.rs:65`); new-user routing threshold 0, which means off (`:267`) |
| 5b | Scoring: VMRanker | `scorers/vm_ranker.rs:84-136` | Computes the local weighted score and the new-post lift decision. Calls `vm-ranker`, which runs the value model, author diversity, the out-of-network multiplier and the DPP. If the RPC fails, serves the local scores (`:107-113`). | `value_model_id: "dpp"`, `compute_value_model: true` (`scorers/vm_ranker_request.rs:8`, `:37-38`) |
| 6 | Selection | `selectors/top_k_score_selector.rs:15-17` | Sorts by final score and keeps the top K. | `TOP_K_CANDIDATES_TO_SELECT` 50 (`params/config.rs:17`) |
| 7 | Post-selection | `:460-487` | Visibility-filtering (VF) hydration (§8), ads brand-safety verdicts and other hydrators. Then the filters VFFilter, AncillaryVFFilter, DedupConversationFilter and VideoCarouselFilter. Truncates to 35. | `RESULT_SIZE` 35 (`params/config.rs:19`; `phoenix_candidate_pipeline.rs:1100-1102`) |
| 8 | Blending | `for_you_candidate_pipeline.rs:199-240`; `selectors/blender_selector.rs:35-104` | Sources: ScoredPosts, Ads, WhoToFollow, Prompts, PushToHome, Jetfuel frames (off), feed survey (off). An ads blender is chosen, then fixed-slot inserts. | Max 48 items (`params/config.rs:22-23`); ads blender `multi_risk` (`param.rs:785`) |
| 9 | Side effects | `phoenix_candidate_pipeline.rs:489-511`; `for_you_candidate_pipeline.rs:221-237` | Caches up to 750 scored candidates in Redis for 180 s. Writes served history, seen-ID and served/scored Kafka logs, and a 5% sample of retrieval candidates. Keeps the Phoenix request cache. | `MaxPostsToCache` 750 (`param.rs:574`); TTL 180 s (`side_effects/redis_post_candidate_cache_side_effect.rs:10`); 5% (`param.rs:119`); 10800 s (`:921`) |

**Pagination by cached re-ranking.** A follow-up request within 180 s may find at least 500 cached candidates (`query_hydrators/cached_posts_query_hydrator.rs:11`, `:69`). If so, `CachedPostsSource` replaces every other source and Phoenix is skipped. VMRanker re-runs on the cached weighted scores, and the filters remove what was already served.

**Blending details** (`selectors/blender_selector.rs`):

- **Ads.** The default `multi_risk` blender (`ads/multi_risk_blender.rs:39-261`) needs at least 5 posts (`ads/util.rs:9`).
  - **Spacing:** the smallest gap between the ads' requested positions. When there is one ad, or that gap is under 3, the spacing is 3 (`ads/util.rs:11-16`, `:54-75`).
  - **Number of ads:** at most `min(ads, (posts−1)/spacing, safe_posts/2)`.
  - **Placement:** each ad is emitted as `[safe post, AD, safe post]`. The safe pairs are taken from evenly spaced groups of brand-safe posts, so as written the first ad lands at index 1. The rest of the posts are re-sorted by score and spread evenly between the ad blocks (`:212-253`). Medium-risk posts can sit next to ads whose adjacency control is `BsrHigh` (`:128-152`; `ads/util.rs:89-95`); high-risk posts are never next to an ad.
- **Prompts:** inserted at index 0 (`PROMPTS_POSITION` 0, `params/config.rs:32`; `:111-121`).
- **Who to Follow:** at position 6 (`params/config.rs:30`; `:123-135`), only if none was served in the last 30 h (`WhoToFollowFatigueHours`, `param.rs:973`; `query_hydrators/served_history_query_hydrator.rs:38-43`).
- **Push-to-home:** pinned at index 0, above the prompts (`:155-166`).
- **Video carousel** (position 6, 60-min fatigue) and **feed survey** (position 12, 1440-min fatigue) are off (`param.rs:1045`, `:1032`).

---

## 3. Scoring

### 3.1 Arithmetic

The formula is in `xai-value-model/scoring.rs:57-139`; the offset is at `:160-169`. For each candidate *i*, with `p_h` the Phoenix prediction for head *h* (a missing head counts as 0, `:57-59`):

```
combined_i = Σ_h w_h · p_h,i
           + 0.004 · dwell_time_i              # predicted dwell, continuous (units: see 3.3)
           + 0.4   · click_dwell_time_i        # see 3.3
           + 0 · p(video_open)·E[video_continuation_secs]  + 0 · p(video_open)·user_avg_continuation
           + 0 · p(profile_click)·E[profile_visit_secs]          # products: scoring.rs:114-128
  where  w_reply = 5 + 15 = 20  if author is a mutual follow AND post is not a reply/repost   (weights.rs:82-89, inputs.rs:20-22)
         w_vqv applies only if video duration > 10_000 ms (weight is 0 anyway)               (scoring.rs:75-84, param.rs:580)
         w_post_unexplored applies only to in-network posts                                    (scoring.rs:85-90, value_model.rs:29)

weighted_i = combined_i + 0.001                                    if combined_i ≥ 0
           = (combined_i + N) / T · 0.001                          if combined_i < 0       (scoring.rs:160-169)
  N = −Σ negative weights = 47.52 + 31.2 + 58.8 + 234 + 0.02 = 371.54                       (weights.rs:70-76)
  T = N + Σ positive head weights = 371.54 + 43.235 = 414.775                               (weights.rs:49-68, 78-80)
```

The offset is the important part. Every net-positive post maps to a value of at least 0.001. A net-negative post maps into [0, 0.000896), keeping its order among the other net-negative posts. So any post whose expected value is negative falls below every post whose expected value is positive. There is no other clipping, normalisation or calibration. Scores are not divided by the sum of weights unless they are negative.

`weights.rs:100-108` and `:194-201` add an optional per-viewer **weight perturbation**. Each weight is multiplied by `exp(±σ)`, with the sign taken from `md5(salt:user_id:head)`. It is off by default (`WeightPerturbationSigma` 0.0, `vm-ranker/params.rs:155`).

### 3.2 Weights

`vm-ranker/params.rs:3-149` repeats the same feature-switch keys with the same defaults. The one difference is `post_unexplored`: 0.02 in `vm-ranker/params.rs:94` against 0.015 in `home-mixer`. `vm-ranker` computes the final score, but both files read the same config key, so the production value comes from config (§11).

| Head (prediction) | Weight | `home-mixer/params/param.rs` | Notes |
|---|---|---|---|
| favorite (like) | 0.5 | :314 | |
| reply | 5.0 | :315 | +`BidirectionalFollowReplyWeightBoost` 15.0 (:320) for original posts by mutual follows, so 20 |
| bidirectional dwell boost | 0.0 | :326 | tested, not shipped (`docs/BIDIRECTIONAL_BOOST_CHANGE.md:7`) |
| repost | 1.0 | :328 | |
| quote | 5.0 | :364 | |
| share (any) | 2.0 | :350 | |
| share via DM | 5.0 | :355 | |
| share via copy link | **20.0** | :361 | largest positive weight |
| click (open post) | 0.3 | :341 | |
| open link | 0.2 | :342 | |
| profile click | 0.0 | :347 | predicted, unused |
| photo expand | 0.05 | :333 | |
| video open | 0.07 | :339 | |
| quoted-post click | 0.05 | :369 | |
| video quality view | 0.0 | :349 | gated on video > 10 s (:580) |
| quoted VQV | 0.0 | :375 | |
| dwell (P(dwelled)) | 0.05 | :363 | client "recap dwelled" event |
| dwell time (continuous) | 0.004 | :393 | |
| click dwell time | 0.4 | :399 | |
| follow author | 4.0 | :381 | |
| post unexplored | 0.015 | :387 | in-network only (§7) |
| video continuation, user video continuation, profile-visit seconds | 0.0 | `vm-ranker/params.rs:70`, `:76`, `:82` | `home-mixer` hard-codes 0 (`scorers/value_model.rs:37-39`) |
| **not interested** | −47.52 | :406 | |
| **block author** | −31.2 | :412 | |
| **mute author** | −58.8 | :418 | |
| **report** | −234.0 | :420 | |
| not dwelled | −0.02 | :425 | |

The code comments (`param.rs:285-313`, repeated in `xai-value-model/scoring.rs:28-56`) say the weights "reflect a combination of how much an action is valued in ranking and typical propensities". They also say the base rate of a report is "more than 1000x lower than a Like", which is why the report weight is large. The weights multiply predicted probabilities, not counts. A negative counts only if it happened on a post served in Home.

### 3.3 Continuous predictions

- **`dwell_time`.** Production trains it with CREAD: a classification over 30 log-spaced thresholds starting at 2 s, plus a Huber "restoration" in seconds (δ = 5 s). It uses loss weight 0.1, with a separate "immersive" (gallery) variant (`phoenix/xrex/configs/xrecsys.py:274-275`, `:722-749`). The Tweedie and MAE variants have weight 0 in the flagship config (`:272-273`). Inferred: the prediction is in seconds. At 0.004 per second, 30 s of dwell is worth 0.12, the same as P(like) = 0.24.
- **`click_dwell_time`.** It is trained as a **binary** head on whether click-dwell is at least 10 s, with loss weight 1.0 (`xrecsys.py:271`, `:714-721`). Inferred: it is effectively a probability, which is why its weight (0.4) looks like a probability weight.
- **`set_user_video_continuation`** (`scoring.rs:141-158`) averages continuation seconds over the request's candidates, weighted by open probability. Its weight is 0.

### 3.4 Notable behaviour

1. **Negatives dominate by design.** Take a hypothetical post with P(like)=0.10, P(reply)=0.01, 8 s of predicted dwell and P(click-dwell ≥10 s)=0.05. Its positive sum is about 0.05 + 0.05 + 0.032 + 0.02 ≈ 0.15. A predicted P(report) of 0.0007 contributes −0.16 and is enough to push the post into the bottom band. One point of P(report) equals −2.34, which is 4.7 times a certain like.
2. **The positive weights are dominated by conversation and private sharing.** Copy-link share is 20, a mutual-follow reply 20, DM share 5, quote 5, reply 5, follow 4. A like is 0.5 and a click 0.3.
3. **Several predicted heads have weight 0:** profile click, VQV, quoted VQV and the three continuation or visit-seconds terms. They are predicted and logged, but they do not rank.
4. **The value model has no explicit recency term.** Recency comes from the 48 h age filter, the Phoenix input features (post age bucket, engagement counts) and the windows of the candidate sources.
5. **Position effects.** There is no position-bias correction at serving (`VMRankerSendDebiasInputs` false, `param.rs:469`). The only rank-based terms are the rank-16 lift and the rank-ordered author decay.
6. **The README is out of date.** Its diagram (`README.md:128-130`) links a `RankingScorer` at `home-mixer/scorers/value_model.rs` that does the weighted sum, the repeated-author decay, the out-of-network discount and the new-author boost. In the code, that file only builds weights for the local fallback, with diversity and the out-of-network discount switched off (`enable_author_diversity: false`, `oon_rescore…: false`, `value_model.rs:44-48`). The adjustments run in `vm-ranker`. If `vm-ranker` fails, users get the scores without author decay or the out-of-network discount (`vm_ranker.rs:107-113`).

---

## 4. Post-scoring adjustments

The adjustments are applied in this order in `vm-ranker`. The path is `vm-ranker/scoring/mod.rs:31-90` → `vm-ranker/scoring/value_model.rs:153-183` → `xai-value-model/scoring.rs:281-327`, using the default `MultiplierPreOffset` false (`vm-ranker/params.rs:191`):

```
w_i = weighted_i                                         # §3; recomputed from heads unless cached
b_i = offset(unoffset(w_i) + author_exploration_bonus(author_i))      # scoring.rs:314-318, 329-334
      # bonus default 0.0, bucketed by author: vm-ranker/params.rs:197, vm-ranker/scoring/value_model.rs:185-204
b   = apply_cold_start_decisions(b)                      # §4.3 lift, replayed (scoring.rs:262-279)
s_i = b_i · div_i · oon_i                                # §4.1, §4.2 (scoring.rs:216-250, 320-325)
s   = DPP(s)                                             # §4.4 (vm-ranker/dpp.rs)
```

### 4.1 Author diversity

The code is `xai-value-model/scoring.rs:182-203` and `:222-236`. The parameters are `EnableAuthorDiversity` true, `AuthorDiversityDecay` 0.5 and `AuthorDiversityFloor` 0.25 (`vm-ranker/params.rs:167`, `:173`, `:179`).

```
order candidates by b (desc); k_i = number of same-author candidates ranked above i
div_i = (1 − floor) · decay^k_i + floor = 0.75 · 0.5^k_i + 0.25
k:    0      1      2       3        4        ∞
div:  1.0    0.625  0.4375  0.34375  0.296875 0.25
```

The counts are computed once over the whole candidate pool (up to ~3,700), in pre-multiplier order. The list is not re-sorted after each penalty.

### 4.2 Out-of-network discount

The code is `scoring.rs:205-214` and `vm-ranker/scoring/value_model.rs:117-141`.

```
oon_i = effective_oon_weight   if author not followed
                               or (author followed and post is a reply or repost)   # EnableOonRescoreForInNetworkRepliesRetweets = true (:185)
      = 1.0                    otherwise
effective_oon_weight = 0.75     (OonWeightFactor, vm-ranker/params.rs:209)
                     = 0.5      for topic requests (TopicOonWeightFactor :203)
                     = 0.00001  for new users with ≥5 follows (NewUserOonWeightFactor :221),
                                but NewUserAgeThresholdSecs = 0 (:215), so this branch is off
```

### 4.3 New-author / new-post boost (Thompson-sampled exploration slot)

The slot is decided in `home-mixer/scorers/author_cold_start.rs:216-334` and `:378-422`, over the local weighted scores. The chosen rank is sent to `vm-ranker` as `cold_start_lift_to_rank` (`vm_ranker_request.rs:59`) and re-applied there to the recomputed scores (`scoring.rs:262-279`). It is skipped for topic requests (`:384-386`).

```
if !EnableViewerColdStart (true, param.rs:519): skip
rank r = uniform_int[ColdStartSlotMin 15, ColdStartSlotMax 16) = 15 (0-based)  → target = 16th-best score
nonzero = #candidates with score ≠ 0; pos_i = rank among those
eligible_i =  not a reply and not a repost
           ∧  author_followers ≤ 50_000            (ColdStartFollowerCap, param.rs:499)
           ∧  post age ≤ 7_200 s                   (ColdStartMaxPostAgeSecs, :505)
           ∧  pos_i < floor(0.97 · nonzero)        (LowImpressionsMaxPositionRatio, :512; i.e. not in the bottom 3%)
           ∧  home impressions < 200               (ColdStartImpressionThreshold, :481)
           ∧  author-experiment arm matches (all eligible when the viewer is in neither arm)
if Thompson sampling (true, :525):
    for eligible i: n = 1.0 · home_views_i (:549); x = min(likes_i, n)
                    θ_i ~ Beta(0.75 + x, 49.25 + n − x)     # prior mean 1.5% likes/view, prior strength 50 (:531, :537)
    pick = the one with the higher model score among the top 2 by θ    (ColdStartTsTopK 2, :543)
else pick = argmax score among eligible
score_pick = max(score_pick, target)        # exactly one post per request
```

The lift happens before the multipliers. An out-of-network or repeat-author pick can therefore still be pushed down by ×0.75 or by the decay, and the DPP can still remove it.

### 4.4 VMRanker: DPP diversity selection

The code is `vm-ranker/dpp.rs:35-314` and `vm-ranker/scoring/dpp_model.rs:54-207`. `DppEnabled` is true, `DppTheta` 0.65 and `DppMaxSelectedRank` 150 (`vm-ranker/params.rs:233`, `:235`, `:240`). `top_k` 50 and an embedding dimension of 1024 come from CLI flags (`vm-ranker/args.rs:19`, `:28`). The DPP context exists only if the `--dpp-enabled` flag is set, and that flag defaults to false (`args.rs:16`, `main.rs:29-50`).

```
pool = top 150 candidates by s
q_i  = s_i / max(s);   α = θ / (2(1−θ)) = 0.929;   f_i = exp(α·q_i) ∈ [1, 2.53]
L_ii = f_i²;   L_ij = f_i·f_j·cos(e_i, e_j)        # e = f16 multimodal post embedding; a repost uses the original's;
                                                    # missing → random unit vector (dpp_model.rs:43-49, 80-84)
greedy MAP via incremental Cholesky: add the argmax residual variance until 50 chosen or residual ≤ 1e-6
selected keep s_i; every other candidate gets 0.0   (dpp_model.rs:196-206)
```

The DPP is a **set filter, not a re-sort**: the selected posts keep their original score order (`dpp.rs:154-171`; test `filter_only_preserves_original_scores`, `:433-464`). Quality only spans a factor of 2.53, so it diversifies strongly. Take a candidate at q = 0.9 whose cosine to an already-selected post is 0.9. Its residual is 2.31² × (1 − 0.81) ≈ 1.01. An unrelated candidate at q = 0.3 scores 1.32² ≈ 1.74 and is picked first. `TopKScoreSelector` then takes the 50 non-zero posts. The README's "reorders them" describes the effect of zeroing the posts that are not selected.

---

## 5. Filters

### 5.1 Pre-scoring filters

These run in order (`phoenix_candidate_pipeline.rs:395-424`); the files are under `home-mixer/filters/`.

| Filter | Removes | Parameters / notes |
|---|---|---|
| DropDuplicatesFilter | Same post ID from more than one source; merges the `retrieval_sources` | `drop_duplicates_filter.rs:19-29` |
| CoreDataHydrationFilter | Posts whose core data failed to load | |
| AgeFilter | Posts older than 48 h, by the snowflake ID; posts with no parseable age are also removed | `params/config.rs:40`; `age_filter.rs:16-20` |
| SelfTweetFilter | Viewer's own posts | |
| OONRetweetReplyFilter | Out-of-network reposts and replies, and **any** reply whose ancestors failed to load | `EnablePhoenixOonReplies` false (`param.rs:77`); `oon_retweet_reply_filter.rs:16-23` |
| OONNsfwSimclustersFilter | SimClusters candidates from authors the viewer does not follow when the author is `nsfw_admin`, `nsfw_user` or carries the NSFW_HIGH_PRECISION user label | `oon_nsfw_simclusters_filter.rs:19-23`; `candidate_hydrators/gizmoduck_hydrator.rs:125-132` |
| RetweetDeduplicationFilter | Second and later reposts of the same original | keyed on `retweeted_tweet_id`, falling back to the post ID |
| IneligibleSubscriptionFilter | Subscriber-only posts the viewer cannot access | |
| PreviouslySeenPostsFilter | Seen IDs sent by the client, plus the impression bloom filters; checks the post and its related IDs | `previously_seen_posts_filter.rs:16-31` |
| PreviouslySeenPostsBackupFilter | Posts in `impressed_post_ids` | In practice this does nothing: the hydrator that fills the list is not wired in (`phoenix_candidate_pipeline.rs:310-312`) |
| PreviouslyServedPostsFilter | Posts served in the last 10 min, up to 100 IDs | `param.rs:982`, `:988`, all requests (`:855`); `served_history_query_hydrator.rs:85-108` |
| ViewerMutedKeywordFilter | Muted keywords | |
| AuthorSocialgraphFilter | The viewer blocks or mutes the author; the author blocks the viewer; a block involving the quoted or reposted author | `author_socialgraph_filter.rs:15-50` |
| Brazil2026ElectionFilter | Listed accounts, unless the viewer follows them | |
| VideoFilter / TopicIdsFilter | Video posts when the request excludes video; posts outside the requested topics | `TopicFilteringId` "PostBased50Pct" (`param.rs:143`) |
| NewUserMinEngagementFilter | Out-of-network posts below an engagement threshold, for accounts younger than 30 min | **Off** (`param.rs:717`); threshold 0.0 (`:735`); 1800 s (`:741`) |
| InventoryHoldoutFilter | A fixed percentage of originals, replies and reposts, chosen by a hash of (post, viewer) | **Off** (`:862`); percentages 0/0/0 (`:868-880`); hash at `inventory_holdout_filter.rs:31-48` |
| FavHoldoutFilter | Holds out a share of posts that rises with the like count: 2% at 2 likes, 5% at 11, 7% at 76, 13% at 1,001, 15% above 3,000 | **Off** (`param.rs:887`); `fav_holdout_filter.rs:10-47` |

### 5.2 Post-selection filters

These run on the top 50 (`phoenix_candidate_pipeline.rs:482-487`).

| Filter | Removes | Notes |
|---|---|---|
| VFFilter | Visibility actions `Drop`, `Tombstone` and **`NotEvaluated`**. Keeps `Allow`, `Interstitial`, `Avoid`, `Downrank` and posts with no VF result. | `vf_filter.rs:22-27` |
| AncillaryVFFilter | Posts whose reply ancestor, quoted post or reposted original was dropped | `candidate_hydrators/vf_candidate_hydrator.rs:140-170` |
| DedupConversationFilter | All but the highest-scored candidate per conversation; the conversation key is the smallest ancestor ID | `dedup_conversation_filter.rs:13-49` |
| VideoCarouselFilter | Carousel bookkeeping (carousel is off) | |

### 5.3 README table checked against the code

- **AgeFilter, 48 h:** confirmed (`params/config.rs:40`).
- **OONRetweetReplyFilter:** confirmed. The code also drops *in-network* replies whose ancestors are missing, which the README does not mention.
- **OONNsfwSimclustersFilter:** confirmed.
- **PreviouslySeenPostsBackupFilter** ("the same, from a second record of impressions"): its data source is not wired in this pipeline, so it does nothing.
- **NewUserMinEngagementFilter**, **InventoryHoldoutFilter** and **FavHoldoutFilter** are listed as active, but their switches default to off.
- **VFFilter:** the README says it removes "posts visibility-filtering answered drop for". It also removes `Tombstone` and `NotEvaluated`, so posts VF failed to evaluate are dropped.

---

## 6. Retrieval

There is **no per-request ratio or quota**. Every enabled source returns up to its cap, the union is deduplicated and filtered, and one score decides.

| Source | What it returns | Size | Freshness / caps | Paths |
|---|---|---|---|---|
| **Thunder** (in-network) | Posts by followed accounts, newest first. The default algorithm sorts purely by creation time. | 1200 (`param.rs:27`; `thunder/config.rs:1`) | Retention 172,800 s, i.e. 48 h (`thunder/args.rs:48`). Per author: ≤50 originals and ≤30 replies/reposts (`config.rs:5-6`), ≤100 videos; ≤500 scanned per author (`:8`). Following list ≤10,000 (`:3`). Excludes the viewer's seen IDs (`sources/thunder_source.rs:31-38`). A reply is kept only if its parent is an original post, or it is a reply-to-reply on the original addressed to a followed user (`posts/post_store.rs:341-365`). | `thunder_service.rs:307-342` |
| **Phoenix retrieval** (OON) | Top-K of user embedding · post index by dot product | 1000 (`param.rs:8`) plus up to 200 from the `HOME_COLD` pool (`:20`), tagged `ForYouPhoenixRetrievalCold` | Seen posts are **not** excluded at retrieval (`param.rs:254` false); filters catch them. Index windows in §7. | `sources/phoenix_source.rs:98-153` |
| **SimClusters** (OON) | Item-to-item. Seeds are the viewer's explicit and implicit engagement post IDs, newest first, ≤90 days old. Each seed queries the ANN with its log-like cluster embedding using cosine similarity. | ≤800 after round-robin interleaving across seeds; 10,000 / #seeds per seed | Per seed: 200 results, 50 clusters scanned, 800 top posts per cluster, candidate age ≤48 h (`param.rs:626`), score > 0.5. Model `20M_145K_2020`. Cached 10 min in process (2M entries) plus a shared cache. | `sources/simclusters_source.rs:25-36`, `:222-311` |
| **Popular posts** (OON, shared) | One list for every viewer | 500 (`param.rs:953`) | Authors are the top 0.005% of 7-day active posters by follower count, refreshed hourly (`util/popular_authors.rs:11`; `main.rs:33-36`). A job every 300 s takes their original posts from the last 24 h, ≤50 per author via Thunder (`popular_posts_job.rs:22-24`), scores them, keeps ≤5 per author, budget 500 (`util/popular_posts.rs:36-86`; `main.rs:53-60`). | below |
| Cached posts | The previous request's scored pool | ≥500 needed | 180 s TTL | §2 |

**Popular-post score** (`util/popular_posts.rs:48-53`). This is projected 24-hour views, with an 8 h half-life and a 0.5 h floor on age:

```
λ = ln2 / 8 h
quality = views · (1 − e^{−λ·24}) / (1 − e^{−λ·max(age_h, 0.5)})
```

**How in-network and out-of-network balance out.** Thunder supplies up to 1,200 in-network candidates; up to about 2,500 come from out-of-network sources. Out-of-network replies and reposts are filtered out. Out-of-network posts, and in-network replies and reposts, are multiplied by 0.75. A mutual-follow reply weighs 20 instead of 5, and the exploration bonus applies only in-network. VF is stricter for out-of-network posts. `docs/BIDIRECTIONAL_BOOST_CHANGE.md` shows this balance being tuned live:

- July 10, 2026: an A/B test of reply boosts 5, 10, 15 and 20.
- July 13: 20 launched broadly.
- July 24: reduced to 15, because users "weren't seeing as much [World Cup] discussion … many of the posts were from accounts they didn't follow" (`:7-11`, `:478-494`).

**SimClusters derivation** (`simclusters/simclusters_v2/`):

1. **KnownFor**, producer to cluster. A sparse binary factorization of the approximate-cosine-similarity graph of the follow graph. It covers the top 20M producers with ≥400 active followers, ≤400 neighbours per node, ≤3 epochs (`scalding/update_known_for/UpdateKnownFor20M145K2020.scala:44`, `:57-64`), giving about 145K clusters.
2. **InterestedIn**, consumer to clusters. Follow- and like-weighted sums of the KnownFor vectors of the producers a consumer follows or likes (`scalding/InterestedInFromKnownFor.scala:157-199`). The like-score threshold is 0.3 for the 2020 model (`summingbird/common/Configs.scala:27-31`).
3. **Post embedding.** A streaming sum of the InterestedIn vectors of the users who liked the post, decayed with an 8 h half-life, keeping ≤400 clusters per post and ≤1,600 posts per cluster (`Configs.scala:39`, `:51-55`).
4. **Retrieval.** The ANN finds posts whose cluster vectors have high cosine similarity to the seed post's vector (`simclustersann/candidate_source/`).

---

## 7. Phoenix

**Code.** JAX for training (`phoenix/xrex/`) and a Rust gRPC serving engine (`phoenix/crates/serving/`). The README says this is the production implementation; only infrastructure is replaced (`phoenix/README.md:9-21`).

**Ranking model** (`home_direct_packed`; `phoenix/README.md:397-418`; `xrex/configs/xrecsys.py:253-320`):

- **Size:** 8 layers, width 2560, 20 query and 4 KV heads (grouped-query attention), key size 128, FFN ×2, QK-norm, right-anchored RoPE.
- **Sequence:** a user-prefix token, a history of 1022 positions and up to 64 candidates.
- **Candidate isolation:** candidates attend to the user and the history and to themselves, never to each other (`README.md:193-235`). A post's score therefore does not depend on the rest of the batch and can be cached.
- **Embeddings:** hash embeddings with 2 hashes per entity. Vocabularies: user 100M, post 100M, author 30M, IP 10M (`xrecsys.py:169-180`).

**Inputs per history position** (`xrex/data/recsys/feature_config.py:8-71`, `:131-144`):

- hashed post ID and author ID
- a **multi-hot of the actions the user took on that impression** (64-action taxonomy)
- continuous values: dwell time, click dwell and others, 8 slots
- the semantic ID: 6 levels × 256 residual-quantized codes of the post's multimodal embedding
- context: product surface, timezone, local hour (dithered 10%), day of week, post-age bucket (60-min granularity), like/reply/repost/quote/view count buckets, author-is-NSFW, a stale-post flag (14 d), whether the viewer follows the author and the author follows the viewer, client app, IP

The user-prefix token carries language, country, state, DMA code, latitude and longitude, gender, age bracket and age, inferred gender, and installed apps (`feature_config.py:101-119`). The sequence handed over at serving time is at most 1,024 actions (`param.rs:836`).

**Candidate features sent at serving** (`home-mixer/models/candidate.rs:299-360`, `TweetInfo`):

- the original post and author IDs, plus reposter, quoted post and reply-to
- whether the viewer follows the author and whether the author follows the viewer
- the author's follower count and an **author-NSFW bit** (`:317-323`)
- video duration
- like, repost, quote, reply, view and bookmark counts
- language, `has_media`/`is_*` flags, semantic IDs and content features

**Heads and loss.**

- 64 action logits trained with sigmoid binary cross-entropy (`xrex/models/loss_recsys.py:22-56`).
- Continuous heads: dwell via CREAD and click-dwell ≥10 s as binary (§3.3).
- The value model reads the probability heads listed in §3.2 (`xai-value-model/phoenix_scores.rs:2-29`).
- Training appends sampled negative candidate blocks and weights candidates by 1/frequency in the batch (log-Q style; `xrecsys.py:265`; `xrex/models/recsys_model.py:3395-3419`).

**The "post unexplored" label** (`xrex/data/recsys/recsys_batch.py:61-89`) is computed in the data pipeline. It is true for an original post at most 24 h old whose views are below:

```
target = 0.03 · followers · (1 − e^{−(ln2/8)·age_h}) / (1 − e^{−(ln2/8)·24})
```

That is, about 3% of the author's followers by 24 h, ramping with an 8 h half-life. Follower count, views and age are model inputs, so P(unexplored) is close to a deterministic indicator. Weighted at 0.015 for in-network posts only, it gives under-delivered posts from followed accounts a small, steady lift.

**Data format.** One Parquet row is one user's session: `userId`, then per-position sequences `tweetIdSeq`, `authorIdSeq`, `impressedTimeMsSeq`, `actionNameMultiHotSeqSeq`, `continuousActionValuesSeqSeq`, `paddingMask` and `newEventMask` (which positions are labelled targets), plus the feature columns (`feature_config.py:131-175`). The target is next-impression action prediction. Training packs several sessions per row, with lengths drawn from Beta(1,1) between 126 and 1022 (`xrecsys.py:313-319`).

**Training scale.**

- `total_samples` 1e11 (`xrecsys.py:264`).
- Per-device batch 512 on GB300, 256 on H100 (`README.md:418`).
- Muon for dense parameters; rowwise AdaGrad for embeddings, with half-life decay (`phoenix/TRAINING.md:12-36`).
- The shipped "nano" configs (width 512, 4 layers, 100k vocabularies) on synthetic data only verify mechanics (`TRAINING.md:53-54`, `:83-84`).

**Retrieval model** (`xrex/configs/xrecsys_two_tower.py`; `README.md:94-125`). A two-tower model:

- **User tower:** the same transformer trunk (width 1024, 8 layers) over the history plus a profile token. There is **no per-user ID embedding** (`use_user_embedding: False`, `:311`).
- **Candidate tower:** semantic IDs plus the hashed author.
- **Training:** contrastive, with in-batch and 64 sampled global negatives and log-Q correction (`:262`). The positive is a like (`:280-282`); the combined config uses 8 positive actions (`:376-385`).
- **Index:** candidate-tower vectors for 10.24M posts (28.67M combined) are written **into each checkpoint** and served by dot-product top-K.

**Which posts are in the index** (`phoenix-rankall/src/config/mod.rs:168-226`):

- the `post_creation` 24 h window
- posts with ≥1 like within 24 h or 48 h, or ≥32 likes within 24 h
- 1-like videos up to 30 days, and video windows up to 720 h
- NSFW video windows and evergreen video (5 years)
- a "tail" pipeline for authors with ≤1,000 followers (`:104-108`)

**Cold pool (`HOME_COLD`):** posts at most 2 h old with <8 likes and <500 views (`phoenix/xrex/data/cold_pool_filter.py:16`, `:26-33`), returned through the separate 200-result allowance.

**What replication would need.** Production trains on 10¹¹ labelled impressions, uses multi-GPU sharded embedding tables with 100M+ rows, and runs a semantic-ID pipeline: a multimodal encoder, an RQ codebook and a lookup service (`phoenix/reference/sid_*.py`). Serving needs a GPU gRPC engine, a feature store holding the 1,024-action history per user, and a candidate index rebuilt every checkpoint. A community with thousands of interactions a day produces roughly 10⁶ labelled impressions a year, five orders of magnitude short. Hashing about 10⁵ posts into 10⁸ rows also means each row gets almost no gradient. The design is unusable at this scale. Its *output contract* (per-action probabilities) is reusable.

**Cold-start handling.**

*New posts:*

- Hash embeddings and semantic IDs make a new post representable immediately (`README.md:474-476`).
- The cold-pool retrieval and the small-author tail index.
- The ranking-time exploration slot (§4.3).
- The post-unexplored head, for in-network posts.

*New users:*

- Retrieval represents the user by history and profile features, with no ID embedding.
- The shared popular-posts source.
- Hooks that are switched off: new-user cluster routing (thresholds 0, `param.rs:235`, `:267`), the new-user out-of-network factor of 0.00001 (`vm-ranker/params.rs:215-221`) and NewUserMinEngagementFilter. Who to Follow is the only active onboarding path in the feed.

---

## 8. Safety and visibility

### 8.1 Two separate questions

**Where a post ranks** is decided by Phoenix and the value model. The ranker does see an author-NSFW bit as an input, but nothing in the value model special-cases NSFW. **Whether it can be shown** is decided by `visibility-filtering/`, called once for the **50 selected** posts, after ranking (`candidate_hydrators/vf_candidate_hydrator.rs:53-131`):

- **In-network candidates, and the originals of their reposts,** are evaluated at safety level `TimelineHome`.
- **Out-of-network candidates, and every reply ancestor and quoted post (even for in-network candidates),** are evaluated at the stricter `TimelineHomeRecommendations` level (`:67-106`).

### 8.2 Evaluation semantics

- **Severity order.** `Policy::new` stably sorts clauses by action severity: Appealable 18 > Drop 17 > Tombstone 16 > MediaRestriction (blur, interstitial) 10 > SoftIntervention 8 > LimitedEngagement 6 (`rules/rule_spec.rs:536-545`; `rules/registry.rs:21-40`).
- **First drop wins.** `decide()` walks the clauses in that order. The first Drop, Tombstone or Appealable notice that resolves true returns immediately. The first blur that resolves true is kept, and limited-engagement reasons accumulate (`registry.rs:58-171`).
- **Three-valued logic.** A failed lookup is `Unknown`, resolved by a per-predicate default. The verdict is marked `Partial` with its fail-open defaults listed (`registry.rs:42-56`; `rule_spec.rs:549-552`).
- **Not evaluated means dropped.** In `home-mixer`, `NotEvaluated` is dropped (`vf_filter.rs:25`). A missing result keeps the post.

### 8.3 Rule order

The order is pinned by test `registry.rs:559-641`.

**`TimelineHome` (31 rules: 25 drops, then 6 blurs):**

- **Author state:** suspended, deactivated, erased, offboarded; protected, when the viewer does not follow.
- **Viewer relationship:** the viewer blocks the author, mutes the author, or mutes reposts.
- **Post labels:** PDNA, bounce, spam, emergency.
- **FOSNR** ("freedom of speech, not reach") level-3 labels for hateful conduct, violent speech, abuse and civic integrity (`tweet_rules.rs:175-218`). Level 1 (abuse insults) is only in the recommendation list below (`:616-622`).
- **Post state:** nullcast, stale (superseded edit), legal takedown, local-laws takedown.
- **Sensitive viewers:** logged-out, underage, or no stated age in an NSFW-gating country, for NSFW media.
- **Access:** exclusive posts, trusted-friends posts.
- **Blurs:** `nsfw_high_precision` (nudity or sensitive), gore high precision, NSFW card image, `nsfw_admin`, `nsfw_user`.

**`TimelineHomeRecommendations` (57 rules):** the same 25 drops, then 26 rules used only for recommendations (`registry.rs:229-242`, `:608-635`), then the same 6 blurs. The recommendation-only rules:

- DMCA media and geo-restricted media.
- **NSFW-user author** and **NSFW-admin author**: any post by such an author, with or without media (`author_rules.rs:79-93`).
- NSFW user and admin flags on the post.
- Gore high precision; NSFW high recall; NSFW high precision; NSFW card image.
- `DO_NOT_AMPLIFY`, malicious URL, spam high recall, Brazil election (viewer in BR) and FOSNR abuse insults.
- **User labels:** NSFW high recall, high precision, avatar image, banner image, near-perfect; spam high recall; compromised; read-only; impersonation; and, for non-followers only, abusive high recall and do-not-amplify (`author_rules.rs:113-144`).

### 8.4 Interstitial outcome

Blur clauses produce `MediaRestriction`/`Interstitial`, and VFFilter keeps the post (`vf_filter.rs:24`). A blur applies only when the viewer has sensitive media turned off (`tweet_rules.rs:264-266`). The client draws the interstitial; nothing in this repository does (`README.md:229-233`).

### 8.5 NSFW, end to end

1. **Detection.**
   - The media classifiers (media-model-proxy, adult-content, pnsfwmedia) and Grox's policy flows score posts.
   - A health side-effect event triggers the scarecrow rule `NsfwTweetMediaProcessor` (`botmaker-rules/scarecrow/bot/NsfwTweetMediaProcessor.bot:5-27`). **One** post detected as label "3" puts NSFW_HIGH_PRECISION on the *author's account*, plus NSFW_NEAR_PERFECT if the score is above 0.99. Label "4" puts NSFW_HIGH_RECALL on the account.
   - `nsfw_user` events apply both labels (`nsfw_user_write_user_label.bot`).
   - `safety-label-user-agg` applies POSSIBLY_NSFW_ACCOUNT or NSFW_HIGH_PRECISION when enough of the author's last ≤10 posts (≤60 days old) carry labels. The label lasts ≤7 days, and high-PageRank or grey-badge accounts are exempt (`safety-label-user-agg/postToUserLabelRules.strato:6-43`, `:96-107`).
   - For AI images: when Grok-generated media is detected as NSFW, the share URL gets an NSFW_CARD_IMAGE verdict for 7 days (`NSFW_Grok_Share.bot`, `NSFW_Grok_Generated_Image_To_URL_Verdict.bot`).
2. **Retrieval.** NSFW authors from SimClusters are removed for non-followers before scoring. The rankall index keeps separate NSFW-video windows.
3. **Ranking.** The author-NSFW bit is a Phoenix feature, so propensity is learned per viewer.
4. **Followers (`TimelineHome`).** Nothing NSFW is dropped. Posts with media from flagged authors, or with NSFW high-precision, gore or card labels, are **blurred** for viewers with sensitive media turned off. They are **dropped** only for logged-out or underage viewers, or viewers with no stated age in gating countries (`tweet_rules.rs:379-417`, `:539-550`, `:901-942`).
5. **Non-followers (`TimelineHomeRecommendations`).** **Every** post by an NSFW-flagged or NSFW-labelled author is dropped, as is every NSFW-labelled post (`author_rules.rs:79-125`; `tweet_rules.rs:567-593`).
6. **Context posts.** Ancestors and quoted posts are always judged at the recommendations level. An in-network reply to, or quote of, an NSFW author the viewer does not follow is therefore removed by AncillaryVFFilter.

### 8.6 Label producers

| System | Signal → label |
|---|---|
| `botmaker/` | The rule language, compiler and runtime. A rule reads: on an event, if conditions hold, apply actions (labels, URL verdicts, reports). |
| `botmaker-rules/` | 73 files: 20 bot rules and 53 derived features under `scarecrow/`. Examples: NSFW media to user labels; duplicate-text spam ("BBQ"); low-quality URL at-mentions to non-followers; gore image model; Grok NSFW share URLs. Some rules are withheld. |
| `scarecrow/` | The real-time event processor that embeds botmaker and exposes registries to the rules: URL verdicts, spam label store, Gizmoduck, Flock, review intake. |
| `agatha/` | Offline account labels: Bayesian-smoothed **blocks per like, reports per like (180-day window) and spam reports per like**, against out-of-network likes: `(neg + 0.1)/(neg + likes + 0.1/prior)` (`scalding/labels/rate_based_labels/RateBasedLabels.scala:42-66`). Also NSFW and spam-suspension account models. |
| `bdsm/` | A transformer over an account's action stream, with time-aware RoPE and 8 heads: FollowBot, LikeBot, EngagementAmplifier, ReplySpamBot, TweetSpamBot, RTBot, MultiActionBot, LegitimateUser (`bdsm/README.md:19-35`). Its scores feed enforcement. |
| `user-cred-v2/` | PageRank over follow and engagement edges: jump probability 0.2, ≤50 iterations, engagement teleport 0.5, 7-day window. Score = clamp(165.2 + 7.07·ln(mass), 0, 100) (`UserCredV2Config.scala:25-35`; `UserCredV2.scala:10-18`). Accounts with a score ≥50 skip automated enforcement (`enforcement_user.yaml:32-38`). |
| `media-model-proxy/` | A proxy fanning one media fetch out to several image and video models: adult, violence/gore, hateful symbols, subject matter, known-media match. Returns scores; the callers persist them (`README.rst:7-19`). |
| `clip/` | Trains the CLIP image and text embedding model whose media embeddings the classifiers consume. |
| `pnsfwmedia/` | Frozen CLIP image score, the author's agatha-calibrated NSFW score, a text score, an NSFW-follower score, follower count and a missing-score flag, fed to Dense(50) and a sigmoid (`model_experimental.py:44-92`). |
| `adult-content/` | Training and isotonic calibration for the adult-media classifier (`calibration.py`). |
| `safety-label-user-agg/` | Turns post labels into account labels (POSSIBLY_NSFW_ACCOUNT, NSFW_HIGH_PRECISION), TTL ≤7 days (above). |
| `abuse-enforcement-service/` | YAML rules over model scores, mirrored from GrowthBook (an experiment-and-config service). Actions: add SpamHighRecall for 30 days, for example to "`llm_slop_user`" or majority-spam posters; captcha, Arkose or liveness challenges; suspension. Post rules: `llm_slop_post` adds RiskyHighVizReply; gibberish or fast-reply spam adds SpamHighRecall (`service-lib/rules/enforcement_user.yaml:56-70`; `enforcement_post.yaml:39-58`). Thresholds are masked (`12.34`). |
| `abuse-ledger-service/` | Appeal holds: an action overturned on appeal is not re-applied for a period set per queue. |
| `takedowns/` | Merges a post's own legal takedown reasons with its author's account-level ones, read by `rules/context.rs`. |
| `grox/` | LLM and vision-language classifiers that run as posts are published. Policy flows cover adult content, spam and special video. The "banger" initial screen (Gemma) returns a description, tags, topic-taxonomy scores, `slop_score` and `has_minor_score` (`flows/upa/classifier_banger_initial_screen_gemma.py:44-154`). Also multimodal post embeddings. The prompts (`templates/*.j2`) are withheld (`flows/upa/prompts.py:11`). |

---

## 9. Experimentation and configuration

- **Parameters.** `param!(Name, type, "feature_switch_key", default)` macros (`home-mixer/params/param.rs`) are resolved per request from `/usr/local/config/features/home-mixer/main/rust_home_mixer.yml` (`params/config.rs:1`).
- **Kill switches** are per-datacenter "decider" overlays (`params/config.rs:5-11`). Examples: `disable_home_mixer_phoenix_ranker` (`scorers/phoenix_scorer.rs:20`) and `enable_thunder_capi_home_mixer` (`sources/thunder_source.rs:16`).
- **Mirrored defaults.** Cron jobs overwrite the code defaults with the primary production values (`README.md:416-420`). The sync time is stamped in the file header (`param.rs:1`, 2026-10-08). Enforcement rules carry their own stamps (`enforcement_user.yaml:1`, 2026-08-26). `vm-ranker/params.rs` has **no** such header (§11).
- **Viewer bucketing.** Rules match the viewer's ID, country, language, app, version, roles, account age in days and minutes, and days since resurrection (`vm-ranker/ranking_config.rs:70-103`).
- **Same params in both services.** `home-mixer` forwards `fs_overrides` to `vm-ranker` (`scorers/vm_ranker_request.rs:73-88`). `vm-ranker` re-syncs the config from git every 30 s (`vm-ranker/args.rs:36-52`).
- **Author-side experiments.** `AuthorRulesEvaluator` buckets by *author* to test creator-side treatments without contaminating viewers. Examples are the exploration-slot corpus arms (`author_cold_start.rs:195-234`) and `AuthorExplorationBonus` (`vm-ranker/scoring/value_model.rs:185-204`).
- **Holdouts and sampling.**
  - Deterministic (post, viewer) hash holdouts: inventory and like-scaled, both off (§5.1).
  - Shadow traffic to candidate Phoenix clusters: `ShadowTrafficDefaultPercent` 0.3 (`param.rs:101`; unit not shown).
  - Per-viewer weight perturbation (σ = 0, §3.1).
  - A 5% sample of retrieval candidates logged to Kafka (`param.rs:119`).
- **Example change history.** `docs/BIDIRECTIONAL_BOOST_CHANGE.md` shows a full A/B test, launch and retune as code diffs: boost values 5/10/15/20 tested on July 10, 2026, 20 launched July 13, set to 15 on July 24. The README aims to show any experiment running at ≥10% of traffic (`README.md:416`).
- **Transparency output.** `under-the-hood/` runs daily Scalding jobs (X's Hadoop data-pipeline framework) that collect account and post labels, Gizmoduck safety flags and takedowns. Monthly aggregates go to Manhattan (X's key-value store) and are served by Strato (X's data-access API layer) and GraphQL as a per-account report page and JSON download (`under-the-hood/jetfuel/routes/*.tsx`).

---

## 10. Design principles worth borrowing for a small-scale feed

Each item gives the principle, why it matters at thousands of interactions, and a minimal form for Postgres and TypeScript with no learned model.

1. **Predict actions, then combine with explicit, versioned weights.**
   - *Why it matters:* X keeps "what will happen" (Phoenix) separate from "what we value" (weights in config). Weight changes are product decisions you can review and A/B test without retraining.
   - *Minimal form:* for each candidate, estimate p̂ₐ for like, comment, remix, save, share and hide/report with **Beta-smoothed rates**: `p̂ₐ(post) = (countₐ + m·μₐ(author)) / (impressions + m)`. `μₐ(author)` is itself smoothed toward the global rate. Personalise by multiplying by a smoothed viewer-to-author (or viewer-to-model, viewer-to-tag) affinity. The score is `Σ wₐ·p̂ₐ`, with the weights in a `feed_params` row. Requires impression logging with dwell; every rate needs an impression denominator.
2. **Let negative feedback dominate, and sink net-negative posts below everything** (`scoring.rs:160-169`).
   - *Why it matters:* with few users, one bad post shown widely does visible damage, and hide/report signals are rare but decisive.
   - *Minimal form:* the same offset. If `combined < 0`, score it as `(combined + N)/T·0.001`; otherwise `combined + 0.001`. **Re-derive the weights** as value ÷ base rate from your own counts. Do not copy −234 for report: X calibrated it to its own propensities (§3.2).
3. **Repeat-author decay with a floor** (`0.75·0.5ᵏ + 0.25`).
   - *Why it matters:* a few prolific creators otherwise fill the feed. This is the main lever against domination in a small community.
   - *Minimal form:* sort by score, count earlier posts by the same author, multiply. Ten lines of TypeScript.
4. **Discount out-of-network posts by a constant, not by a quota** (×0.75, including followed accounts' replies and reposts).
   - *Why it matters:* one number tunes the follow/discovery balance and keeps scores comparable. A small graph means most candidates are discovery, so the constant matters more than at X.
   - *Minimal form:* a multiplier in the final score. Consider a separate "mutual-follow" boost on conversation actions, as with the reply boost of 15.
5. **Reserve one exploration slot for fresh, low-exposure posts, chosen by Thompson sampling** (§4.3).
   - *Why it matters:* new creators get no organic signal without exposure. At small scale every new post needs a deliberate first audience.
   - *Minimal form:* eligible posts are originals, under 2 h old, with <200 feed impressions, from authors under the follower cap. Draw `θ ~ Beta(α0 + likes, β0 + views − likes)` with α0/(α0+β0) set to your global like-per-view rate and strength about 50. Among the top 2 by θ, pick the one with the higher score. Lift it to a fixed rank (X uses 16 of 35), once per page. Plain SQL plus a Beta sampler.
6. **Give fresh posts their own candidate source (a "cold pool").**
   - *Why it matters:* ranking cannot help a post that retrieval never returns. X's cold pool is ≤2 h old, <8 likes, <500 views, up to 200 slots.
   - *Minimal form:* `WHERE created_at > now() - interval '2 hours' AND impressions < N`, unioned into the candidates.
7. **Set a reach target for followers ("post unexplored").**
   - *Why it matters:* creators judge a community by whether their followers see their work.
   - *Minimal form:* `target = f·followers·(1 − e^{−λ·age})/(1 − e^{−λ·24})` with λ = ln2/8 h. If `impressions_to_followers < target`, add a bonus for in-network viewers. X uses f = 3%. A small community will want something like 30–60%, because follower counts are tiny.
8. **Several cheap sources with per-source and per-author caps, unioned and deduplicated.**
   - *Why it matters:* recall comes from variety. Caps stop any one source or author flooding the pool.
   - *Minimal form:*
     - follows, newest first, capped per author (X: 50 originals and 30 replies)
     - item-to-item from the viewer's recent likes, remixes and saves: co-engagement or pgvector cosine on image/prompt embeddings, which stands in for SimClusters
     - trending
     - the cold pool
     - dedupe on post ID, merging the source tags
9. **Rank trending by projected 24-hour views, with a per-author cap** (`quality = views·(1−e^{−λ·24})/(1−e^{−λ·max(age,0.5)})`, λ = ln2/8, ≤5 per author, refreshed every 5 min).
   - *Why it matters:* raw counts favour old posts; a velocity measure surfaces new hits fairly.
   - *Minimal form:* a materialised view refreshed by cron.
10. **Suppress near-duplicates with embedding diversity** (DPP over the top 150, keeping 50).
    - *Why it matters:* AI media produces near-identical generations, remixes of one template and repeated prompts. A diversity filter keeps one per cluster.
    - *Minimal form:* greedy maximal marginal relevance (MMR) or a small greedy DPP with pgvector embeddings (CLIP image or prompt text) over the top ~100. Missing embeddings are treated as unique (X uses a random vector). Keep the score order among the survivors.
11. **Keep safety separate from ranking, and run it after ranking on the page only.**
    - *Why it matters:* it is cheap to evaluate (about 50 posts), easy to audit, and lets the ranker stay purely about relevance.
    - *Minimal form:* two ordered rule lists in code, `home` for followed authors and `recommendations` for everyone else, read from Postgres labels. Severity sort, first drop wins, and posts that could not be evaluated are dropped. Judge reply parents and remix sources at the stricter level, and drop children of dropped parents.
12. **Propagate NSFW and spam from posts to accounts, with a TTL** (one high-precision NSFW post labels the account; aggregation over the last 10 posts; labels last 7 days).
    - *Why it matters:* it stops repeat offenders' new posts reaching non-followers before each one is classified.
    - *Minimal form:* a trigger or cron that writes an `account_labels(label, expires_at)` row. The recommendation rules drop for non-followers; followers get a blur.
13. **Use smoothed negative-feedback rates per author** (agatha: `(neg + s)/(neg + likes + s/prior)`).
    - *Why it matters:* it stays robust with few events and catches authors who draw hides or reports from strangers.
    - *Minimal form:* a nightly SQL job; use the result as a multiplier or as a recommendation-tier drop label above a threshold.
14. **Handle seen and served separately.** Client-reported seen IDs are a hard exclusion. "Served in the last 10 minutes, ≤100 IDs" stops pagination repeats. Also dedupe reposts by their original and keep one post per conversation.
    - *Minimal form:* `impressions(user_id, post_id, at)` and `served(user_id, post_id, at)` tables. No bloom filters needed at this scale.
15. **Cache the scored pool for pagination** (750 candidates, 180 s, used when ≥500 remain).
    - *Why it matters:* scoring once per session and re-ranking cheaply keeps latency flat and pages consistent.
    - *Minimal form:* the ranked IDs plus their base scores in Redis or an unlogged table, keyed by user, with a TTL.
16. **Keep parameters in config with code defaults mirrored from production, and fall back safely.**
    - *Why it matters:* tuning without deploys, an auditable history (as in the bidirectional-boost doc), and a degraded mode that still works when the re-ranker fails (`vm_ranker.rs:107-113`).
    - *Minimal form:* a versioned JSON params row, a hash-based A/B bucket per user (and per author for creator-side tests), and a CI check that the code defaults match the live row.

**What not to borrow**

- **The Phoenix transformer, for ranking or retrieval.** It needs about 10¹¹ impressions, GPU training and serving, and 100M-row hash tables (§7). At thousands of interactions, smoothed rates and affinities will beat any model you could train.
- **Semantic IDs (RQ codebooks) and a checkpoint-baked two-tower index.** They solve indexing millions of posts per hour. pgvector over thousands of posts is exact and simpler.
- **SimClusters.** It is built for 20M producers with ≥400 active followers each. A sparse small graph gives empty or noisy clusters; use co-engagement or embedding similarity instead.
- **Thunder, Kafka and the in-memory stores.** Postgres indexes on `(author_id, created_at)` do the same job at this scale.
- **The ads blender, brand-safety risk tiers and Jetfuel frames.** Not applicable.
- **X's absolute weight values.** They encode X's base rates (report "1000x" rarer than a like). Re-derive yours.
- **The 48 h age cut-off as a hard filter.** It assumes an abundant supply of content. A low-volume community should use a longer window with time decay, or the feed runs dry.
- **PageRank credibility exemptions, the BDSM behaviour model, agatha's PMI models and Grox LLM screening.** Use manual allowlists and a hosted moderation or vision-language API instead. Grox's prompts are withheld anyway.
- **Weight perturbation, like-scaled holdouts and shadow clusters.** They need large traffic to measure anything.

---

## 11. Open questions / things that could not be determined

1. **Is the DPP on in production?** `vm-ranker/params.rs:233` defaults `DppEnabled` to true. But the DPP context only exists when the `--dpp-enabled` flag is set, and it defaults to false (`vm-ranker/args.rs:16`; `main.rs:29-50`). `dpp_top_k` (50) is also a flag. The README implies it runs.
2. **Are `vm-ranker/params.rs` defaults production values?** The file has no "mirrored … last sync" header. Its `PostUnexploredWeight` (0.02, `:94`) disagrees with the mirrored `home-mixer` value (0.015, `param.rs:387`). The author-diversity decay and floor (0.5 / 0.25) and the out-of-network factor 0.75 appear only in this file.
3. **Units at serving.** That `dwell_time` is in seconds and `click_dwell_time` is a probability of ≥10 s is inferred from the training loss configuration. The serving conversion lives in `component_library`, which is not in the repo.
4. **`quality_factor::apply()`** scales the Thunder and Phoenix result counts (`thunder_source.rs:37`; `phoenix_source.rs:125`). It is not in the repo, so the effective source sizes may be smaller than the parameters.
5. **The user-action-aggregation service** ("DENSE_WITH_LONG_DWELL", the 300,000 ms window) is not in the repo. What counts as one sequence element (impression or engagement), and how the window applies, is unknown.
6. **The 64-action taxonomy list** comes from `recsys_pb2`, a generated protobuf that was not read. Only the ~30 named mappings in `xrex/data/recsys/constants.py:24-100` were seen.
7. **VF error handling.** What the pipeline framework does when the VF hydrator returns `Err` for a candidate (keep it or drop it) was not traced. `NotEvaluated` is dropped; a missing result is kept.
8. **The Who to Follow, prompts, push-to-home and ads selection services** are clients only; their logic is not in the repo.
9. **Withheld material:** the Grox prompts, some botmaker rules, the `safety-label-user-agg` rule configs (feature-switch JSON), the real follower-count thresholds in the enforcement rules (shown as `12.34`), and the production feature-switch YAML itself.
10. **Production experiment buckets** (which share of viewers receive which values) are not visible; only the defaults are.

**Not read in depth:** `TopicIdsFilter` (1,502 lines) and `Brazil2026ElectionFilter` (5,885 lines, mostly account lists); the ads blenders other than `multi_risk`; Jetfuel frames; the internals of `media-model-proxy`, `clip` and `bdsm` beyond their READMEs and entry points; Phoenix's `recsys_model.py` beyond the loss and negatives; the scarecrow runtime; and 53 derived-feature files in `botmaker-rules`, of which a sample was read.
