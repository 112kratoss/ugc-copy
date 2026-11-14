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

Not stated: whether the ten-second window is fixed or sliding, and whether a `Retry-After`
header accompanies the 429.

## What we observed before it was published

- Model probes in October 2026: a 429 after about 20 calls sent as fast as a script can,
  which agrees with the figure above.
- The per-model references in this folder list `429 | Request rate limit exceeded` for every
  model and no number, which is why the first admission gate (2026-08-09) had to guess.

## How the app uses it

`KIE_PUBLISHED_ACCOUNT_LIMITS` holds these figures and `provider-admission.test.ts` holds the
policy to them: the app admits at most 18 submissions in any 12 seconds (a sliding window, so
it fits Kie's whether theirs is fixed or sliding), and runs at most 50 at once. The longer
window covers transit, since we stamp a submission before it leaves and Kie counts it on
arrival. Everything on the account counts toward Kie's 20: a local dev server, a model
probe or an eval run on the same key spends from the same window production does.

When Kie changes the figures, re-capture this file, change `KIE_PUBLISHED_ACCOUNT_LIMITS`,
and let the test say whether the policy still fits.
