# Qwen Image 2.1 — verified provider evidence (2026-10-08)

Captured from `https://docs.kie.ai/market/qwen2-1/text-to-image.md` and
`.../qwen2-1/image-to-image.md` (OpenAPI bodies, fetched 2026-10-07 23:30 IST) and the market
page `https://kie.ai/qwen-image-2.1` (fetched 2026-10-08 01:10 IST). Credits are Kie credits 1:1
(1 credit = $0.005). Listed by Kie on 2026-09-21 (`<lastmod>` in `kie.ai/sitemaps/models-0.xml`).

## Provider ids — the docs path is not the id

| App id | Text-to-image | Image-to-image |
| --- | --- | --- |
| `qwen-image-2.1` | `qwen2-1/text-to-image` | `qwen2-1/image-to-image` |

Each value is the sole entry of the `model` enum in its spec. The vendor segment is `qwen2-1`
(dashed), where Qwen Image 3.0 lives under `qwen3/`.

## Inputs

Text-to-image (`required: prompt`):

- `prompt` — string, max 5,000 characters. "Any language."
- `aspect_ratio` — `1:1` (default), `4:3`, `3:4`, `3:2`, `2:3`, `16:9`, `9:16`, `21:9`, `9:21`.
- `resolution` — `1K` (default), `2K`.
- `background` — `opaque` (default), `transparent`. Transparent needs `png` or `webp` output.
- `output_format` — `png` (default), `webp`, `jpeg`.
- `enhance_prompt` — boolean, default true: Kie rewrites the prompt on its side (the same switch
  Qwen 3 calls `prompt_extend`).
- `seed` — integer.
- `nsfw_checker` — boolean, defaults to false.

Image-to-image (`required: image_urls, prompt`): `image_urls` is an array of 1 to 10 URLs,
"the order of the array is the order the model reads them"; `aspect_ratio` gains `auto`
(default) and is ignored for a local edit; `mask_url` marks a local edit and must be used with
exactly one entry in `image_urls`, cannot be combined with `background: transparent`.

## Price

**4 credits per 1K image, 8 credits per 2K image**, text and image-to-image alike. The market
page: "Qwen-Image-2.1 is priced at 4 credits per 1K image (≈ $0.02) and 8 credits per 2K image
(≈ $0.04)." No per-input-image charge is stated (Qwen 3's page has one: 0.5 credits per input
image), so none is billed. No promotional qualifier on the page.

## Probes (2026-10-08)

- Empty input to both ids answered "This field is required" with no task; a made-up id under the
  same vendor segment was refused as "not supported".
- One real task, the exact adapter body at the cheapest setting (`prompt`, `aspect_ratio: 1:1`,
  `resolution: 1K`, `output_format: jpeg`, `enhance_prompt: true`, `nsfw_checker: true`): task
  `b5310f0b82636a216d077cdee04b495c`, state `success` in 18 s, one JPEG on
  `tempfile.aiquickdraw.com` (already on `MEDIA_IMPORT_HOST_ALLOWLIST`). Kept in
  `archive/kie-image-models-2026-10-08/`.

## Shipped (2026-10-08)

- One catalog entry, `qwen-image-2.1`, on the `kie-task-v1` adapter: `aspect_ratio`,
  `resolution`, `output_format` (`jpg` → `jpeg`), `enhance_prompt: true` and `nsfw_checker: true`
  as Qwen 3 sends `prompt_extend: true` and `nsfw_checker: true`, `image_urls`; references select
  the image-to-image id.
- Not sent: `background` (Kie applies `opaque`), `seed`, `mask_url`, and the image-to-image
  `auto` aspect ratio. Each needs a control the creators do not draw yet.
- Up to 10 references, the spec's `maxItems`.
- Enhancer: an alias of `qwen3` — the Qwen-Image official prompting rules, the same family, with
  `aspect_ratio` where Qwen 3's body says `image_size`.
