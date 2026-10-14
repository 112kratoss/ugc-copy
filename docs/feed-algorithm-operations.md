# Feed algorithm operations

How the For You ranking versions are switched on, compared and switched off. The tool is a service-role CLI, `scripts/ops/feed-algorithm.ts`; the design behind v3 is `docs/plans/feed-algorithm-v3-x-adoption-2026-10-11.md`.

## Versions, statuses and experiments

The For You feed ranks with one row of `feed_algorithm_versions` (`algorithm_key` `for-you-rules`, shown as `for-you-rules-v<version>`). The row carries the weights and the retrieval and diversity settings as JSON; the code only holds defaults, which reproduce v1 and v2 when a key is missing.

| Status | Meaning |
| --- | --- |
| `draft` | Written, never served. Can be activated. |
| `shadow` | Ready, served to nobody by default. Can be an experiment arm, or be activated. |
| `active` | Served to every viewer who is not in a running experiment. One per `algorithm_key` (a unique index). |
| `retired` | Was active. Kept so its facts stay labelled; an experiment arm already pointing at it keeps serving it. |

On 2026-10-11 production had v1 `active` and v2 `shadow`, and had never run an experiment; the v3 migration adds v3 as `shadow`. `list` shows the current rows.

An experiment (`feed_experiments` and its `feed_experiment_variants`) enrols `traffic_basis_points` / 10000 of viewers, and each enrolled viewer gets a variant in proportion to its `allocation_basis_points`; everyone else gets the active version. There is no implicit holdout: the CLI always creates an explicit `control` and `treatment`. Only the oldest running experiment enrols anyone (`src/lib/feed-experiments.ts`), so the CLI will not start a second. Assignments last 90 days and follow the viewer key, so a guest who signs up is assigned again.

Every served item writes a `feed_delivery_facts` row labelled with the version and variant that ranked it (kept 30 days). The scorecard reads those rows.

## Commands

```bash
npm run ops:feed-algorithm -- list
npm run ops:feed-algorithm -- scorecard [--days 7] [--by version|source]
npm run ops:feed-algorithm -- activate --key for-you-rules --version 3 [--apply]
npm run ops:feed-algorithm -- experiment start --key <experiment_key> --control 1 --treatment 3 \
  [--algorithm-key for-you-rules] [--traffic-bps 10000] [--treatment-bps 5000] [--apply]
npm run ops:feed-algorithm -- experiment stop --key <experiment_key> [--status completed|cancelled|paused] [--apply]
npm run ops:feed-algorithm -- experiment srm --key <experiment_key>
```

- The CLI reads `SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`) and `SUPABASE_SERVICE_ROLE_KEY` from `.env.local` when present. That file is switched between local and production by hand: check which one it points at before any `--apply`.
- `list`, `scorecard` and `experiment srm` only read. `activate` and `experiment start|stop` print their plan and change nothing without `--apply`; with it, each makes one service-role call (`activate_feed_algorithm_version`, `create_feed_experiment` or `set_feed_experiment_status`) and prints what it returns. `list` and the dry runs work before the v3 migration; `scorecard` and every `--apply` need the functions it adds.
- They refuse up front what those functions would refuse: `activate` takes a `draft`, `shadow` or `retired` version (a `retired` one is a rollback, see Rollback) and refuses the one already `active`, an experiment arm must be `active` or `shadow`, experiment keys are unique, and `experiment stop` leaves a `completed` or `cancelled` experiment alone.
- Basis points: 10000 = 100%. `--traffic-bps` is the share of all viewers enrolled; `--treatment-bps` is the treatment's share of the enrolled viewers, and control gets the rest (`--treatment-bps 3000` gives control 7000). Both take 1–10000.
- A change reaches feed sessions started after it. A session already open keeps the list it was ranked with for its next pages (up to two hours).
- The exit code is 1 after a usage error, a refusal or a database error.

## Reading the scorecard

`scorecard` calls `feed_algorithm_scorecard(p_days)`: the deliveries served in the last `--days` days (1–30), one block per version and experiment arm (`no experiment` is everyone outside an experiment), or per arm and candidate source with `--by source`. Every rate prints its numerator and denominator; `–` means the denominator is zero.

| Line | What it counts | How to read it |
| --- | --- | --- |
| rendered / served | items the client drew, of those served | A drop is a client or payload fault, not ranking. |
| qualified / rendered | items on screen long enough to count as seen | Attention. |
| meaningful / rendered | a video watched to half, a still looked at for 3 s, a save, a remix start, a resource open, a purchase | The quality signal. |
| quick skips / rendered | items scrolled past at once | Lower is better. |
| negatives per 1k rendered | not interested, hide creator, report | Guardrail: must not rise. |
| saves, remix starts per 1k rendered | | The upside. |
| repeat exposures / served | items the viewer had already seen in the 14 days before | v3 should lower it; with a few dozen posts some repetition is unavoidable. |
| distinct viewers, mean position | | Context: how many people, how far down they got. |

Home sends no dwell, progress or skip events yet (plan §6), so meaningful and quick skips lean on the reel. The function also returns an all-sources row per version and arm, so a version's block shows its distinct viewers exactly, each viewer once however many sources reached them. With `--by source` each source's line counts that source's viewers, so one viewer can appear under several sources and those lines do not add up to the version's count.

**This is not a significance test.** About 16 people a week use the feed. What varies is the viewer, not the delivery: 5,000 deliveries from 16 people are closer to 16 samples than to 5,000, and one person's habits move every rate. A 50/50 experiment leaves about 8 viewers per arm, and no difference a ranking change is likely to make will reach statistical significance at that traffic, so do not wait for one. Read the scorecard as a before/after guardrail: keep v3 if the guardrail lines (negatives, quick skips, rendered / served) are no worse and nothing looks broken, and take the upside lines as a direction at most. Revisit this when weekly viewers reach the hundreds.

## Reading the viewer-grain scorecard

After the delivery block, `scorecard` prints three sections from the v4 functions (plan `docs/plans/feed-algorithm-v4-industry-parity-2026-10-12.md` §2.8), over the same `--days` window with one block per version and arm. Before the v4 migration each prints `Not available` and the delivery block still prints.

**Viewer grain** (`feed_scorecard_viewers`, over the last `--days` UTC days, today included). A viewer is an account (a registered one, or an app guest's anonymous session: the app signs its guests in anonymously, and the feed ranks and logs them as users) or a web guest's feed cookie key, so a guest who signs up counts twice. Each rate prints its numerator and denominator, people rather than deliveries; `–` means nobody qualified for the denominator.

| Line | What it counts | How to read it |
| --- | --- | --- |
| viewers, sessions per viewer | distinct viewers served; feed sessions per viewer. A session is one ranked list: opening the feed starts one unless the viewer opened it in the last two minutes. | How often people come back to the feed. |
| D1 return | of the viewers served on a day whose next day lies wholly inside the window, those served again on that next day | Habit: the headline retention number. |
| D7 return | the same with the second serve seven days later | Only viewers served more than a week before the window's end count, so it needs `--days` well above 7 and prints `0 / 0` and `–` otherwise. |
| 7-day meaningful creation | signed-in viewers with a completed generation within 7 days of their first serve in the window, of the signed-in viewers served | Whether the feed leads people to make something, which is the point of it. App guests count as signed in on both sides; web guests are on neither. |
| rendered, meaningful per viewer | | Depth per person, which the delivery rates hide when one heavy viewer dominates. |
| signed in N (registered R · app guests A) · web guests W | the signed-in viewers split by `auth.users.is_anonymous` (registered accounts against the app's guests) and the viewers with no user id (the web's cookie-hash guests) | registered + app guests = signed in, and signed in + web guests = viewers, so a signed-in rate can be read against how many of its people are guests. `split by account not available` means the database predates the split migration (`20261014053528`). |

`With N viewers, one viewer moves each rate by X points or more` is 100 / N: the smallest step a viewer rate can take.

**Position buckets** (`feed_scorecard_positions`): positions 1–3, 4–6, 7–12 and 13+, 1 being the top. rendered / served falls with depth because people stop scrolling, and meaningful / rendered falls with it because the top gets attention whatever is there: that is position bias, and the trainer models position for the same reason. A better ranking shows as better rates at the same depth, not only as more engagement at 1–3.

**Formats** (`feed_scorecard_formats`), by `posts.category`: attention / rendered is the mean longest dwell in seconds, and video half-completions / rendered (video only) the share of videos played to half. A surface counts dwell and progress only once it sends them: v4's Home telemetry reaches the web at the deploy and the app only with an OTA, and until then those items count as rendered with no attention.

**Sample ratio** (`experiment srm --key <experiment_key>`) reads `feed_experiment_assignment_counts`: per variant, the viewers assigned, those of them served at least once (exposed), and the allocation. Expected is the total split by allocation, and the test is Pearson's chi-square with variants − 1 degrees of freedom.

- p < 0.01 prints `assignment is skewed — do not read this experiment`. The split is not the one configured: a bucketing bug, an arm that fails before it records, or one client re-enrolling. Find the cause first; until then the arms are different populations and comparing them says nothing about the versions.
- An arm allocated 0 that has viewers is skewed outright. An expected count under 5 is `too few viewers to test`.
- The exposure line runs the same test on exposed viewers. The scorecard reads only exposed viewers, so a skew there (an arm that fails to serve) stops the read too. Assignments are kept 90 days and facts 30, so in an older experiment far fewer viewers are exposed than assigned; that is retention, and it shrinks both arms alike.

**The 16-weekly-viewers caveat.** About 16 people a week use the feed (see Reading the scorecard). At that size each viewer is 6 points of every viewer-grain rate, D7 return rests on the handful seen in the first days of the window, and a 50/50 experiment leaves about 8 viewers per arm, 12.5 points each. Read these sections as counts of people, week over week, not as rates to compare between arms. The sample-ratio check has almost no power at this size: it catches a broken split (14 against 2), not a subtle one, and `matches the allocation` means no evidence of a skew, not proof of balance.

## Turning v3 on

1. Deploy. The migration adds v3 as `shadow`; viewers see no change.
2. Baseline: run `scorecard --days 7` and `scorecard --days 7 --by source` while v1 serves everyone. Keep the output (paste it into the PR or a dated note).
3. Turn v3 on, one of:
   - **Experiment** (easier to undo): `experiment start --key v3-vs-v1-<yyyymmdd> --control 1 --treatment 3 --apply`. v1 stays active and half the viewers get v3, both arms in the same week.
   - **Activation**: `activate --key for-you-rules --version 3 --apply`. Everyone gets v3 and v1 becomes `retired`; the only comparison is before/after, and undoing it is one `activate` of v1 (see Rollback).
4. After 7 days, run `scorecard --days 7` (and `--by source`) again. Compare it with the baseline, and for an experiment, arm with arm.
5. Keep v3 or drop it:
   - Experiment, keep: `experiment stop --key <key> --apply` (it ends `completed`), then `activate --key for-you-rules --version 3 --apply`.
   - Experiment, drop: `experiment stop --key <key> --status cancelled --apply`. v1 never stopped being active.
   - Activation, drop: re-activate v1 as below.

## Training a version from data

`npm run ops:feed-ranker` (`scripts/ops/feed-ranker-train.ts`, plan v4 §5) fits a version's weights to the delivery facts and can write them as a `draft`. It reads the same environment as `ops:feed-algorithm`, and every command takes `--algorithm-key` (default `for-you-rules`).

```bash
npm run ops:feed-ranker -- dataset [--days 30]
npm run ops:feed-ranker -- train [--days 30] [--value-meaningful 1] [--value-skip -0.5] [--value-negative -3] \
  [--min-rendered 500] [--min-positives 50] [--apply] [--force]
npm run ops:feed-ranker -- replay --weights '<json>' [--days 30]
```

What it does:

- **Data.** Every rendered delivery served in the last `--days` days (1–30) by any version of the key, from `feed_delivery_facts` with the post's category. `dataset` prints the counts and positives by version and changes nothing.
- **Labels.** `meaningful` is `is_meaningful_feed_engagement` (a video played to half, anything else held for 3 s, a save, remix start, resource open, purchase or comment); `quick_skip` is a quick skip; `negative` is not interested, hide creator or report.
- **Features.** The 13 weight keys as stored in the delivery's `score_components` when it was ranked (a missing key reads 0: rankings before v4 stored no `semantic_similarity`), plus position, `is_following`, `served_recently` and `is_exploration`. Position is in the model so the top slots' extra attention is not credited to whatever the top items had.
- **Model.** One L2-regularised logistic regression per label, fitted by gradient descent over standardised features. A fixed fifth of the feed sessions is held out, each session's rows kept together, and each model reports holdout log-loss and AUC next to a constant at the training rate.
- **Weights.** An item's value is `1·p(meaningful) − 0.5·p(quick skip) − 3·p(negative)` at the top slot (`--value-*` change the values). Linearised at the training means, a feature's weight is `Σ value · coefficient · p(1 − p)`. The weights are then scaled so the positive ones sum to the live version's positive sum (the fit fixes their ratios, not their scale, and the net-negative offset adds a fixed 0.001 to every positive score, so the scale stays the live one), clamped to −10…10 (the normaliser would swap anything outside for the v1 default), and every key is written, so none falls back to a v1 default.
- **Replay.** Each holdout session's rendered items are re-ranked by the live weights and by the draft, and the top-12 meaningful and quick-skip rates of each print next to the order they were served in. `replay --weights` does the same for any weights JSON (a missing key reads as the feed reads it), to try a hand edit of the draft.
- **`--apply`** writes the draft through `create_feed_algorithm_version_draft`: the fitted `weights`, the live version's `retrieval_config` and `diversity_config` unchanged, and the description `Fitted <date>: <n> rendered, AUC meaningful/skip/negative …`. It prints the new version number.

What it does not do:

- Serve anything. A draft is served to nobody; the trainer never activates a version, starts an experiment or edits the live row.
- Learn new features, retrieval or diversity. It refits the 13 weights over features the ranking already computes.
- Say what would have happened. The facts come from the live ranking, which chose what was shown and where. The replay only reorders items that were shown, uses the base score alone (no diversity rules, multipliers or cold-start slot), and cannot change the top 12 of a session that rendered 12 items or fewer (the output counts the sessions where it can).
- Correct for the policy. A row weighs 1 / `exploration_propensity` when that is in (0, 1], but the ranking is deterministic: it logs 1 for an exploration pick and 0 for everything else, so every row weighs 1 today.
- Learn a feature that never varied in the window. Its weight is 0 and the output says `not learnable`: `semantic_similarity` until v4 rankings accumulate, `exploration_bonus` while no version gives it a weight. To keep the live value, edit the draft's `weights` with a SQL update (as under Kill switches) before activating it.

**The floors.** `train --apply` refuses below `--min-rendered` rendered deliveries (500), or below `--min-positives` positives (50) for any label whose value is not 0, counted over the whole window. It prints everything first; `--force` writes anyway. Negatives are the rare label, so they are usually the one short. `--value-negative 0` takes them out of the value model and the floor, but the draft then learns nothing about negative feedback directly: check that `negative_feedback_risk` stays strongly negative before activating it.

**Reading the output.**

- AUC is the chance a positive outranks a negative in the holdout: 0.5 is chance, 1 is perfect. Engagement models usually land between 0.6 and 0.75; under about 0.55 the model has learned little. Holdout log-loss must be below the baseline, or do not apply.
- Everything is noisy at this traffic. A viewer's sessions are alike and the split is by session, not viewer, so the holdout flatters the model; with a few dozen holdout positives an AUC moves by several hundredths from one window to the next.
- The replay should show the draft raising the top-12 meaningful rate without raising quick skips, against the live weights. A replay gain with an AUC near 0.5 is noise, and a weight clamped at ±10 is an unstable fit.
- Check the signs in the weights table (the two risk keys negative) and that no one positive key takes most of the positive sum without a coefficient that explains it.

**Promoting a draft.**

1. Run `train` without `--apply` and read it. Try a hand edit with `replay --weights '<json>'`, starting from the printed `Draft weights JSON`.
2. `train --apply` writes the draft and prints its version.
3. `npm run ops:feed-algorithm -- list` shows it as `draft`.
4. `npm run ops:feed-algorithm -- activate --key for-you-rules --version <n> --apply` makes it active and retires the current version. An experiment arm must be `active` or `shadow`, so a draft is judged before/after, as an activation is under Turning v3 on: keep a scorecard baseline, read the scorecard again after 7 days, and roll back by activating the previous version (Rollback).

## Rollback

Rolling back means making the previous version active again.

- **An experiment**: `experiment stop --key <key> --status cancelled --apply`. Every viewer is back on the active version at their next feed session.
- **An activation**: activate the previous version again. `activate_feed_algorithm_version` accepts a `retired` target and clears its `retired_at` in the same statement that retires the current version (`feed_algorithm_versions_lifecycle_check` forbids a `retired_at` earlier than the new `activated_at`, so the RPC does it, not you):

  ```bash
  npm run ops:feed-algorithm -- activate --key for-you-rules --version 1 --apply
  ```

## Kill switches

Each v3 mechanism has a key in the version's JSON that switches it off. No CLI command edits them today: a change is a SQL update of the row, and it reaches feed sessions started after it.

| Key | Column | Off at | Switches off |
| --- | --- | --- | --- |
| `seen_lookback_days` | `retrieval_config` | `0` | seen-recently detection (the seen tier and its penalty) |
| `author_decay` | `diversity_config` | `1` | the author-diversity decay |
| `out_of_network_multiplier` | `diversity_config` | `1` | the discount on creators the viewer does not follow |
| `cold_start_slot_rank` | `diversity_config` | `0` | the cold-start slot |

`served_penalty` at `1` (`diversity_config`) switches off the served-recently penalty, and `recommendation_max_post_negative_risk` and `recommendation_max_creator_negative_rate` at `1` (`retrieval_config`) switch off the two recommendation-only negative-feedback drops. With `author_decay`, `out_of_network_multiplier` and `served_penalty` at `1` and `cold_start_slot_rank` at `0`, the net-negative offset is off too.

```sql
UPDATE public.feed_algorithm_versions
SET diversity_config = diversity_config || '{"cold_start_slot_rank": 0}'::jsonb,
    updated_at = now()
WHERE algorithm_key = 'for-you-rules' AND version = 3;
-- A retrieval key: SET retrieval_config = retrieval_config || '{"seen_lookback_days": 0}'::jsonb
```

The scorecard groups by version, not by settings, so an edit in place mixes before and after in one block. Note when you made it, and afterwards use a `--days` no longer than the time since the edit.
