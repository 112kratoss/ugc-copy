# Nano Banana 2.1 — verified provider evidence (2026-11-05)

Captured on 2026-11-05 from `https://docs.kie.ai/market/google/nanobanana-2-1.md` (OpenAPI body)
and the market page `https://kie.ai/nano-banana-2-1` (`pricingDesc`). Raw copies:
`UGC copy/archive/kie-models-2026-11-05/evidence/`. Listed by Kie on 2026-10-07 (models sitemap
`<lastmod>`). Credits are Kie credits 1:1 (1 credit = $0.005).

## Provider id

| Shape | `model` enum | `required` |
| --- | --- | --- |
| Text and references | `nano-banana-2-1` | `prompt` |

Endpoint `POST /api/v1/jobs/createTask`, the shared status and callback path. A zero-cost probe
(`{"model":"nano-banana-2-1","input":{}}`) answered "This field is required" on 2026-11-05: the id
is live, and no task was created (the balance did not move).

## Inputs — identical to Nano Banana 2

A line-by-line diff against `google/nanobanana2.md` (re-captured the same day) differs only in the
title, the `model` enum and the example ids. So the body is Nano Banana 2's:

- `prompt` — "Max length: 20000 characters" (:111-116). Above the app's shared 10,000, so no
  entry in `provider-prompt-limits.ts`.
- `image_input` — up to 10 URLs, `maxItems: 10`, "Accepted types: image/jpeg, image/png,
  image/webp; Max size: 30.0MB" (:127-139).
- `aspect_ratio` — `1:1`, `2:3`, `3:2`, `1:4`, `4:1`, `3:4`, `4:3`, `4:5`, `5:4`, `1:8`, `8:1`,
  `9:16`, `16:9`, `21:9`, `auto`; default `auto` (:140-207).
- `resolution` — `1K`, `2K`, `4K`; default `1K` (:208-217).
- `output_format` — `png`, `jpg`; default `jpg` (:218-226).

No `google_search`, no seed, no negative prompt, no prompt rewrite on Kie's side.

## Price (`pricingDesc`, 2026-11-05)

```
4 credits ($0.02) for 1K, 6 credits ($0.03) for 2K, and 9 credits ($0.045) for 4K — 1K/2K 40% and 4K 60% below official pricing.
```

Per image, by resolution: **1K 4, 2K 6, 4K 9**. No reference surcharge. "Below official
pricing" is Kie's standing rate against Google's own API (as on the Wan 3.0 and MiniMax H3
pages), not a dated offer: no "limited-time", "until" or "% off" wording. The page's
`pricingDescCn` (1K 3, 2K 5, 4K 8) does not apply.

## Shipped (2026-11-05)

App id `nano-banana-2.1` (the provider's dashes become the app's dot, as `qwen-image-2.1`),
maker Google, Nano Banana 2's adapter config (`NANO_BANANA_ADAPTER_CONFIG`), every Nano Banana 2
option, Enhance aliased to `nano-banana-2` (identical body and prompt grammar).

## Paid run (2026-11-05)

The app's text body (`aspect_ratio: 1:1`, `resolution: 1K`, `output_format: jpg`) ran once: task
`10f7de3370a5afe8f915fee6bd09d603` succeeded in 50 s, charged 4 credits (`creditsConsumed`, the
price above) and delivered a 1024×1024 JPEG from `tempfile.aiquickdraw.com` (`archive/kie-models-2026-11-05/probe-results.txt`).
