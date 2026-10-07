# Seedream 5.0 Flash — verified provider evidence (2026-10-08)

Captured from `https://docs.kie.ai/market/seedream/5-flash-text-to-image.md` and
`.../5-flash-image-to-image.md` (OpenAPI bodies, fetched 2026-10-07 23:30 IST) and the market page
`https://kie.ai/seedream-5-0-flash` (fetched 2026-10-08 01:10 IST). Credits are Kie credits 1:1
(1 credit = $0.005). Listed by Kie on 2026-09-29 (`<lastmod>` in `kie.ai/sitemaps/models-0.xml`).

## Provider ids

| App id | Text-to-image | Image-to-image |
| --- | --- | --- |
| `seedream-5-flash` | `seedream/5-flash-text-to-image` | `seedream/5-flash-image-to-image` |

Each value is the sole entry of the `model` enum in its spec. The docs path and the id agree. A
third endpoint, `seedream/5-flash-layer-decomposition` (one `image_url`, splits a picture into
layers, billed per output layer), is a different product and is not shipped.

## Inputs

Text-to-image (`required: prompt, aspect_ratio`):

- `prompt` — string, max 5,000 characters.
- `aspect_ratio` — `1:1`, `4:3`, `3:4`, `16:9`, `9:16`, `2:3`, `3:2`, `21:9`. Required.
- `size` — `1K` (default), `1.5K`, `2K`. The field is `size`, where Seedream 5 Pro and Lite take
  `resolution`; the values are the same strings.
- `output_format` — `png`, `jpeg`. (Our `jpg` is sent as `jpeg`, as for Qwen.)
- `nsfw_checker` — boolean, defaults to false; true turns on Kie's content filter. Sent as true.

Image-to-image adds `image_urls` (required, array, `maxItems: 10`, JPG/PNG URLs) and keeps the
same fields and enums.

## Price

**3.24 credits per image at 1K, 1.5K and 2K**, text and image-to-image alike. The market page:
"1K and 2K images are priced the same: 3.24 credits per image ($0.0162)." No per-input-image
charge is stated, unlike Qwen 3 ("Input images are charged at 0.5 credits per image"), so none
is billed. No promotional qualifier on the page (`kie-evidence.mjs price seedream-5-0-flash`
printed none; the only "discount" strings are the site's top-up copy).

## Shipped (2026-10-08)

- One catalog entry, `seedream-5-flash`, on the `kie-task-v1` adapter: `aspect_ratio`, `size`
  (from our resolution), `output_format` (`jpg` → `jpeg`), `nsfw_checker: true`, `image_urls`;
  references select the image-to-image id.
- Resolutions offered: `1K` and `2K`. `1.5K` is not a value of the app's `ImageResolution` type
  on either client and costs the same, so it is left out.
- Up to 10 references, the spec's `maxItems`.
- Enhancer: an alias of `seedream-5-lite` — the Seedream prompt grammar, one request field renamed.
