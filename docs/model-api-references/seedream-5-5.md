# Seedream 5.5 — verified provider evidence (2026-11-14)

Captured on 2026-11-14 from `https://docs.kie.ai/market/seedream/5-5-text-to-image.md` and
`.../5-5-image-to-image.md` (OpenAPI bodies) and the market page `https://kie.ai/seedream-5-5`
(`pricingDesc`). Raw copies: `UGC copy/archive/kie-models-2026-11-14/evidence/`. Credits are Kie
credits 1:1 (1 credit = $0.005). Listed by Kie on 2026-11-10; the page says ByteDance released the
model on 2026-11-09.

## Provider ids

| App id | Text-to-image | Image-to-image |
| --- | --- | --- |
| `seedream-5.5` | `seedream/5-5-text-to-image` | `seedream/5-5-image-to-image` |

Each value is the sole entry of the `model` enum in its spec, and the docs path agrees. A third
endpoint, `seedream/5-5-layer-decomposition` (one picture split into layers, billed per layer), is
a different product, as it was for Seedream 5 Flash, and is not shipped. The empty-input probe of
both ids answered "This field is required" with no task (balance 2375.9 before and after,
`archive/kie-models-2026-11-14/probe-results.txt`).

## Inputs

Seedream 5 Flash's body field for field (`seedream-5-flash.md`), plus `background`:

- `prompt` — `minLength: 5`, `maxLength: 5000` (t2i :106-115, i2i :113-125). Flash asks 4.
- `aspect_ratio` — `1:1`, `4:3`, `3:4`, `16:9`, `9:16`, `2:3`, `3:2`, `21:9`; required on
  text-to-image (:116-154, :231). Image-to-image adds `auto` and defaults to it (:149-194); `auto`
  is not offered, because the text endpoint has none (FLUX.3 Klein's precedent).
- `size` — `1K`, `1.5K`, `2K`, default `2K` (t2i :155-176, i2i :195-216). `1.5K` is not an
  `ImageResolution` on either client and costs what 1K costs, so it is left out.
- `output_format` — `png` (default), `jpeg` (t2i :177-192). The app's `jpg` is sent as `jpeg`.
- `background` — `auto` (default), `transparent`, `opaque` (t2i :193-224). New against Flash. Not
  sent, so Kie applies `auto`: the web create page has no control for it (GPT Image 2.5's case).
- `nsfw_checker` — boolean (t2i :225-230). Sent as true, as for Flash.
- `image_urls` — image-to-image only, required, `minItems: 1`, `maxItems: 10`, "JPEG, PNG, WEBP",
  "Max 10 MB per image" (i2i :126-148). Flash's page says 30 MB.

## Price (`pricingDesc`, 2026-11-14)

Text-to-image: "1K and 1.5K images: 3.6 credits per image ($0.018); 2K images: 6.3 credits per
image ($0.0315) — 10% below official pricing."

Image-to-image: the same output prices, and "Each input image is billed separately at 1.44
credits ($0.0072) … Example: a 2K edit with 2 input images costs 6.3 + 2 × 1.44 = 9.18 credits".

So: **1K 3.6, 2K 6.3 per image, plus 1.44 for every input picture, the first included**. That is
Qwen 3's shape (`additionalReferenceCredit` with `referenceCreditIncludesFirst`), not Seedream 5
Pro's, whose first reference rides free. A run is charged whole credits, rounded up: a 1K picture
is 4, a 1K edit of one picture 6 (5.04), the page's 2K example 10 (9.18).

"10% below official pricing" is Kie's standing rate against ByteDance's own API, as Wan 3.0's,
Vidu Q4's and Nano Banana 2.1's "below official" lines are, not a dated offer; there is no date or
"limited-time" wording, and `kie-evidence.mjs price` flags none.

## Shipped (2026-11-14)

- One catalog entry, `seedream-5.5`, on the `kie-task-v1` adapter with Flash's bindings:
  `aspect_ratio`, `size` (from our resolution), `output_format` (`jpg` → `jpeg`),
  `nsfw_checker: true`, `image_urls`; references select the image-to-image id.
- Resolutions `1K`, `2K`; up to 10 references; prompts of 5–5,000 characters.
- `src/lib/provider-image-limits.ts`: `image_urls` 10 MB.
- Enhancer: an alias of `seedream-5-lite`, as Flash is — the Seedream prompt grammar, the same
  request schema but for `background`, which is not sent.
- Maker ByteDance, already named in the AI-data question; no app release.
