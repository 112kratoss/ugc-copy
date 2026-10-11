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
```

- The CLI reads `SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`) and `SUPABASE_SERVICE_ROLE_KEY` from `.env.local` when present. That file is switched between local and production by hand: check which one it points at before any `--apply`.
- `list` and `scorecard` only read. `activate` and `experiment` print their plan and change nothing without `--apply`; with it, each makes one service-role call (`activate_feed_algorithm_version`, `create_feed_experiment` or `set_feed_experiment_status`) and prints what it returns. `list` and the dry runs work before the v3 migration; `scorecard` and every `--apply` need the functions it adds.
- They refuse up front what those functions would refuse: `activate` takes only a `draft` or `shadow` version, an experiment arm must be `active` or `shadow`, experiment keys are unique, and `experiment stop` leaves a `completed` or `cancelled` experiment alone.
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

Home sends no dwell, progress or skip events yet (plan §6), so meaningful and quick skips lean on the reel. The function counts viewers per candidate source, and a viewer who saw several sources is counted once in each, so a version's block shows distinct viewers as a range: at least the busiest source's count, at most the sum.

**This is not a significance test.** About 16 people a week use the feed. What varies is the viewer, not the delivery: 5,000 deliveries from 16 people are closer to 16 samples than to 5,000, and one person's habits move every rate. A 50/50 experiment leaves about 8 viewers per arm, and no difference a ranking change is likely to make will reach statistical significance at that traffic, so do not wait for one. Read the scorecard as a before/after guardrail: keep v3 if the guardrail lines (negatives, quick skips, rendered / served) are no worse and nothing looks broken, and take the upside lines as a direction at most. Revisit this when weekly viewers reach the hundreds.

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
