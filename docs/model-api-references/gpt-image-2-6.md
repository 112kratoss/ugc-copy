# GPT Image 2.6 — verified provider evidence (2026-11-14)

Captured on 2026-11-14 from `https://docs.kie.ai/market/gpt/gpt-image-2-6-{flare,sunburst,economy}-{text,image}-to-image.md`
(OpenAPI bodies) and the market page `https://kie.ai/gpt-image-2-6` (`pricingDesc`). Raw copies:
`UGC copy/archive/kie-models-2026-11-14/evidence/`. Credits are Kie credits 1:1 (1 credit =
$0.005). Listed by Kie on 2026-11-05.

## Provider ids — the tier is part of the id, after a slash

| Tier | Text-to-image | Image-to-image |
| --- | --- | --- |
| Flare | `gpt-image-2-6/flare-text-to-image` | `gpt-image-2-6/flare-image-to-image` |
| Sunburst | `gpt-image-2-6/sunburst-text-to-image` | `gpt-image-2-6/sunburst-image-to-image` |
| Economy | `gpt-image-2-6/economy-text-to-image` | `gpt-image-2-6/economy-image-to-image` |

Each is the sole entry of its spec's `model` enum. Unlike 2.5 (`gpt-image-2-5-flare-text-to-image`)
the vendor segment ends in a slash. The empty-input probe of both Economy ids answered "This field
is required" with no task (`archive/kie-models-2026-11-14/probe-results.txt`).

## Price — only Economy can be quoted before a run

The page's first block, before the four Flare and Sunburst ids:

> GPT Image 2.6 Flare and Sunburst: text input 900 credits / 1M tokens ($4.50), cached text input
> 225 ($1.125), image input 1,440 ($7.20), cached image input 360 ($1.80), image output 5,400
> ($27.00) — 10% below official pricing.

The block before the two Economy ids:

> GPT Image 2.6 (Economy) — just 5 credits ($0.025) per 1K image. Same GPT Image 2.6 model, served
> through our economy channel at a flat per-image price, 1K only.

Flare and Sunburst bill tokens: the prompt's, each input picture's and the output's, whose count
depends on what the model renders. No figure can be quoted before the run, and the onboarding rule
is that a setting which cannot be priced before the run is refused, so **neither ships**. 2.5's
tiers stay (6 / 10 / 16 per image). Economy is a flat **5 credits per picture, at 1K only**, and
ships as `gpt-image-2.6`. The page names no input-picture charge for Economy.

## Inputs — Economy (`additionalProperties: false` on both)

- `prompt` — required, 1–20,000 characters (t2i :134-149, i2i :135-150). Flare and Sunburst take
  32,000.
- `aspect_ratio` — `auto` (default), `1:1`, `16:9`, `9:16`, `3:2`, `2:3`, `21:9`, `4:3`
  (t2i :150-168, i2i :164-182). No `3:4`, `5:4`, `4:5` or `1:2` family, which Flare lists.
- No `resolution` and no `quality`: "It generates at 1K only, with a smaller set of aspect ratios
  and output formats" (t2i :26-27). The schema refuses any field it does not name, so the 2.5 body
  (`aspect_ratio`, `resolution`, `input_urls`) would fail here; Economy is sent without
  `resolution`.
- `background` — `transparent`, `opaque`, `auto` (default) (t2i :169-186). Not sent.
- `output_format` — `png` (default) or `gif` on text-to-image (:187-197), `png` only on
  image-to-image (:201). Not sent. `frame_count` / `frame_duration_ms` are the GIF's (:198-230).
- `input_urls` — image-to-image only, up to 16, "JPEG, PNG or WebP (including jpg), up to 30 MB
  each" (i2i :151-163). The spec does not mark it required, but it is the edit endpoint's input,
  and references are what select that endpoint.

## Shipped (2026-11-14)

- App id `gpt-image-2.6` ("GPT Image 2.6"), maker OpenAI. One resolution, `1K`, at 5 credits;
  the eight ratios above; up to 16 references, which select the image-to-image id.
- Its own `kie-task-v1` config: `aspect_ratio` and `input_urls` only (GPT Image 2's shared config
  would send `resolution`). The hand-written fallback in `startImageGeneration` sends the same.
- `src/lib/provider-image-limits.ts`: `input_urls` 30 MB.
- Enhancer: an alias of `gpt-image-2`, as 2.5's tiers are: the same prompt grammar, and a request
  schema that only drops fields.
- To ship Flare or Sunburst later, Kie has to list a per-image price for them, or the catalog has
  to learn to bill a run after it ends.
