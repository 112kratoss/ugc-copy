# Kie account limits (rate and concurrency)

Captured 2026-11-14 from `https://kie.ai/getting-started` (section 8, "Rate Limits &
Concurrency"; `https://docs.kie.ai/` carries the same section). Not a model reference: this
is the account-wide limit every model's submissions share, and the input to
`PROVIDER_ADMISSION_POLICY` in `src/lib/provider-admission.ts`.

## What Kie states

| | Published figure |
|---|---|
| New generation requests | Up to 20 per 10 seconds |
| Concurrently running tasks | "typically" 100 or more (a consequence of the rate, not a separate promise) |
| Scope | Per account, not per key or per model |
| Over the rate | HTTP 429; the rejected request is not queued |
| Raising it | Ask support from the dashboard; the guide says approvals are handled cautiously |

Section 3 also lets a key carry its own hourly, daily and total usage caps, set in the
dashboard. The guide gives no default numbers, and the app cannot read them.

Not stated: whether the ten-second window is fixed or sliding, whether a `Retry-After`
header accompanies the 429, and whether endpoints other than task creation count as "new
generation requests". The app calls three that do not pass its admission gate: chat
completions for the prompt enhancer and the workflow assistant, and Seedance asset creation
(`playground/createAsset`).

## What we observed before it was published

- Model probes in October 2026: a 429 after about 20 calls sent as fast as a script can,
  which agrees with the figure above.
- The per-model references in this folder list `429 | Request rate limit exceeded` for every
  model and no number, which is why the first admission gate (2026-08-09) had to guess.

## How the app uses it

`KIE_PUBLISHED_ACCOUNT_LIMITS` holds these figures and `provider-admission.test.ts` holds the
policy to them: the app admits at most 18 submissions in any 12 seconds (a sliding window, so
it fits Kie's whether theirs is fixed or sliding), and runs at most 50 at once. That is a
burst of 18 and 1.5 per second sustained, against Kie's 20 and 2 per second. The longer
window covers transit, since we stamp a submission before it leaves and Kie counts it on
arrival. Everything on the account counts toward Kie's 20: a local dev server, a model
probe or an eval run on the same key spends from the same window production does.

A start over either limit is not failed. A creator's start (the app, the web and an agent's
`create_media`) is **queued**: it keeps its credit hold, its prepared provider request is
stored (`generation_queued_submissions`) and it answers at once, with `status: "waiting"`,
`queued: true` and the generation's own id as the id to follow it by. The server sends it
when its turn comes, in the order the queue was joined (`reserve_provider_submission` counts
the queue's rows as the line), whether or not the creator is still there. A queued run may
wait 10 minutes; the first pass over the queue after that (the cron's at the latest, so
within about 20) refunds it and notifies its creator. The queue holds 200 runs, 4 of
one creator. Past that a start answers `provider_busy` with its credits returned, as every
over-limit start once did. Template and workflow steps are not queued; their own retry brings
them back, behind only the runs queued before the step was first turned away. How the queue
is served, and what ends a queued run, is in `src/lib/generation-submission-queue.ts`.

When Kie changes the figures, re-capture this file, change `KIE_PUBLISHED_ACCOUNT_LIMITS`,
and let the test say whether the policy still fits.
