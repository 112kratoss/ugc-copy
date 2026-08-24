# Drop-in Kie models — verified provider evidence (2026-08-15)

Captured from `https://docs.kie.ai/market/<slug>.md` (OpenAPI bodies) and `https://kie.ai/<slug>`
market pages. Method: `curl` with a browser User-Agent — WebFetch gets 403 from Cloudflare.
Credits are Kie credits 1:1 (1 credit = $0.005).

**Read the `model` enum from the spec body, never the docs path.** Confirmed divergences below.

## Docs path ≠ model id (all confirmed this pass)

| Docs path | Real `model` value |
| --- | --- |
| `market/qwen3-pro/text-to-image` | **`qwen3/pro-text-to-image`** |
| `market/qwen3-pro/image-to-image` | **`qwen3/pro-image-to-image`** |
| `market/flux2/flex-*` | `flux-2/flex-*` |
| `market/kling/v3-omni-*` | `kling-3.0-omni/*` |
| `market/pixverse/*` | `pixverse-v6/*` |

## Image models

### `grok-imagine-image-2` → `grok-imagine-image-2-0/text-to-image`
- Input: `prompt` (req), `aspect_ratio` (req) — enum `1:1`, `2:3`, `3:2`, `16:9`, `9:16`
- Price: **4 credits/image** flat
- ⚠️ **Text-to-image only.** The sibling `grok-imagine-image-2-0/image-edit` takes
  `task_id` ("The source task ID to use for image editing") + optional `mask_indexs` — it edits a
  *previous Kie task's* output, not an uploaded image. Our reference flow supplies image URLs, so
  there is no reference variant to map. Do not wire one.

### `qwen3` → `qwen3/text-to-image` (text) · `qwen3/image-to-image` (reference)
- Input: `prompt` (req), `resolution` (`1K`|`2K`, default `1K`), `image_size`, `output_format`,
  `prompt_extend`, `nsfw_checker`, `negative_prompt`, `seed`; i2i adds `image_urls` (req, array)
- Price: **4.8 credits/image at both 1K and 2K**; input images **+0.5 credits each**

### `qwen3-pro` → `qwen3/pro-text-to-image` · `qwen3/pro-image-to-image`
- Same input schema as `qwen3`
- Price: **6.4 credits @1K, 12 credits @2K**; input images **+0.5 credits each**

### `ideogram-character` → `ideogram/character`
- Input: `prompt` (req), `reference_image_urls` (**req**), `rendering_speed`
  (`TURBO`|`BALANCED`|`QUALITY`, default `BALANCED`), `style`, `expand_prompt`, `num_images`,
  `image_size`, `seed`, `negative_prompt`
- Price: **12 (Turbo) / 18 (Balanced) / 24 (Quality)** credits
- Reference-required: there is no text-only mode; at least one character reference is mandatory.
- ⚠️ Siblings not wired: `ideogram/character-edit` requires `mask_url` (we have no mask UI);
  `ideogram/character-remix` requires a separate `image_url` **and** `reference_image_urls`
  (two distinct slots our single reference array can't express unambiguously).

## Video models

### `seedance-2-5` → `bytedance/seedance-2-5`
- Input: `prompt`, `first_frame_url`, `last_frame_url`, `reference_image_urls`,
  `reference_video_urls`, `reference_audio_urls`, `return_last_frame`, `generate_audio`,
  `resolution`, `aspect_ratio`, `duration`, `output_format`, `web_search`, `nsfw_checker`
- `resolution`: **`480p`, `720p` only** (default `720p`) — narrower than our seedance-2, which
  also offers 1080p/4k
- `aspect_ratio`: `1:1`, `4:3`, `3:4`, `16:9`, `9:16`, `21:9`, `adaptive` (default `adaptive`)
- `duration`: **4–30 s**, default 5; `-1` = auto (not wired this pass)
- `output_format`: `mp4` | `mov`
- Price (per second): 480p **28** no-video / **17** with-video; 720p **63** / **38**

### `kling-o3` → `kling-3.0-omni/text-to-video` · `/image-to-video` · `/reference-to-video`
- Common input: `prompt` (req), `resolution` (`720p`|`1080p`|`4k`, default `720p`),
  `aspect_ratio` (`16:9`|`9:16`|`1:1`, default `16:9`), `duration` (**3–15**, default 5),
  `audio` (bool), `customize_multi_shots`, `prefer_multi_shots`, `multi_prompt`, `elements`
- image/reference variants add `image_urls` (req)
- Price (per second, no-audio / with-audio): 720p **14 / 18**; 1080p **18 / 23**;
  4k **67 / 67**
- Cheaper than our `kling-3.0-video` at 1080p-with-sound (23 vs 27) and adds 4k + multi-shot.
- `kling-3.0-omni/transformation` deferred (video-input intent, bills on input+output seconds).

#### `elements` (named subjects) — verified 2026-08-16, NOT yet wired

The field is **`element_input_urls`**, not `urls` (it mirrors kling-3.0-video's
`element_input_video_urls`). Schema, quoted from the image-to-video spec body:

```
elements: array, maxItems 3, default []
  items: required [name, description, element_input_urls]
    name:               unique per request, referenced in the prompt as @name
    description:        subject description
    element_input_urls: array, minItems 1, maxItems 4
                        "For a multi-image subject, provide 2 to 4 images.
                         For a video character subject, provide exactly 1 video.
                         Images and videos cannot be mixed."
```

⚠️ **Blocked on a UI concept we do not have.** A named subject is a *set* of 2–4 images
of the same subject; our elements editor produces exactly one image per named element,
so today's data shape cannot express a subject. Sending a single image per subject sits
below the documented multi-image range (schema-legal via `minItems: 1`, but outside the
described contract) and would risk 422s or degraded output on paid generations.

Kling O3 therefore ships with flat `image_urls` references (up to 7), which works today.
Wiring `elements` needs a subject-grouping editor (N images per named subject, ≤3
subjects) plus a live test generation — tracked as follow-up, not guessed at here.

> **Resolved 2026-08-24:** the live test generation succeeded
> (kling-3.0-omni/text-to-video, 2-image subject, task
> 7da3646b6a8362b9aa783c2176d0c71e) and `elements` shipped end to end — see
> `docs/prompt-enhancer-playbooks-2026-08-24.md` and catalog release
> `2026-08-24-kling-o3-subjects.json`.

### `minimax-h3` → `minimax-h3/text-to-video` · `/image-to-video` · `/reference-to-video`
- text: `prompt` (req), `aspect_ratio` (req), `duration` (req), `resolution`
- image: `prompt`, `first_frame_url`, `last_frame_url`, `duration`, `resolution`
- reference: `prompt`, `reference_image_urls`, `reference_video_urls`, `reference_audio_urls`,
  `aspect_ratio`, `duration`, `resolution`
- `resolution`: **`768P`, `2K`** (uppercase `P` — exact enum matters)
- `aspect_ratio`: `adaptive`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`
- `duration`: **4–15**, default 6
- Price (per second): 768P **16**; 2K **26**. First 5 input images free, then 8 credits/image;
  input audio free. We cap references at 5 to stay inside the free allowance.

## Excluded from this wave — pricing not verifiable

### `flux-2-flex`
Kie's own flux-2 market page returns **contradictory** prices for the same variant:

| Variant | pricingDesc |
| --- | --- |
| `flux2/pro-text-to-image` | 5 credits 1K / 7 credits 2K |
| `flux2/flex-text-to-image` | 14 credits 1K / 24 credits 2K |
| `flux2/flex-image-to-image` | 14 / 24 **and** 5 / 7 (two rows) |

The 5/7 row matches our shipped `flux-2-pro` pricing, so pro is confirmed. Flex is both
ambiguous **and** ~3× *more* expensive than pro — which falsifies the "cheaper flux tier"
premise this model was queued on. Not shipped. Revisit if Kie publishes a single authoritative
flex row.

### `pixverse-v6`
**Absent from `https://kie.ai/pricing` entirely** — searches for both "pixverse" and "v6" return
"No pricing data found". Its market page shows two conflicting per-second tiers
(360P 4.0 vs 4.5, 1080P 14.4 vs 16.2) with no variant labels distinguishing them. Model ids are
`pixverse-v6/text-to-video`, `/image-to-video`, `/transition`, `/reference-to-video`, `/extend`;
`quality` (not `resolution`) is the tier field with `360p|540p|720p|1080p`; `transition` uses
`first_frame_image_url` + `last_frame_image_url`; audio via `generate_audio_switch`.
Not shipped — billing users on an unpublished rate risks charging wrong in either direction.
