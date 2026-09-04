# Model API reference-input audit — 2026-09-04

> **Resolution, 2026-09-04 (branch `fix/reference-input-audit`, release manifest `2026-09-04-reference-audit.json`):** findings 1–6 and 8–13 are fixed in code and/or the emitted catalog release; finding 7 stays a pricing decision (see below). Two things the fix pass added to the audit: Kie rejects the old Kling element field outright (`element_input_urls is required`, confirmed by a zero-cost probe), so named video elements had been failing at the provider; and release `minimax-reference-duration-20260904` was edited by hand while the code build stayed per-second, which the next emitted release would have undone — the code now emits the reference-adjustment shape and a test pins that release to it. The "Suggested order of work" at the end records what shipped where.

What every model integration says about reference inputs (reference images, clips, audio,
frames, named elements and subjects), checked against what Kie.ai's live OpenAPI specs and
market pages say today, and against what production is actually running.

## Scope and method

Compared, for every one of the 36 catalog models plus the two motion models:

1. **Seven in-repo representations** of the same facts: `src/lib/models.ts`,
   `src/lib/client-generation-models.ts`, the descriptor builder in
   `src/lib/generation-model-catalog.ts` (`VIDEO_INPUT_LIMITS`, `videoInputModes`,
   `videoInputConstraints`), the runtime tables in `src/lib/generation-model-runtime.ts`
   (`VIDEO_REFERENCE_IMAGE_CAPS`, `REFERENCE_VIDEO_SECONDS_CAPS`, pricing expressions,
   validation rules), the provider dispatch in `src/lib/generation-services.ts`, the two
   September release manifests, and the mobile catalog path in
   `ugc-mobile/lib/generation-model-draft.ts` / `media-creation-screen.tsx`.
2. **Kie's live contract**: 61 spec pages fetched from `docs.kie.ai` on 2026-09-04 and parsed
   from their embedded OpenAPI YAML (request-body fields, `maxItems`, enums, `oneOf`
   variants, prose rules), plus the `pricingDesc` blocks on 30 `kie.ai/<slug>` market pages.
3. **Production**: the active `generation_model_catalog_releases` row and its entries, read
   over the Supabase MCP. Active revision is `minimax-reference-duration-20260904`
   (activated 2026-09-03 19:58 UTC); every reference cap, pricing table and validation rule
   in it matches the code catalog, so "code" and "production" are one thing below.
4. **Behaviour, not reading**: ten scratch cases were run through the real
   `startVideoGeneration` / `quoteGenerationModel` with the provider call captured. Findings
   marked *reproduced* cite that output. The six suites that pin this area
   (`video-reference-caps-manifest`, `model-capability-reachability`,
   `generation-model-affordances`, `model-registry-parity`,
   `model-registration-completeness`, `models`) pass: 238 tests.

Kie's market pages carry a trap worth knowing for the next pass: each `pricingDesc` block
sits *before* the `model` key of the variant it prices, so a naive "nearest model id" read
attributes every block to the previous variant. The same pages also carry a
`pricingDescCn` with different (Chinese-market) numbers; only `pricingDesc` applies.

## Findings at a glance

| # | Sev | Model(s) | Finding | Status |
| --- | --- | --- | --- | --- |
| 1 | P1 | grok-imagine-video | Billed at 1.6 / 3 credits per second; Kie now lists 2.4 / 4.5 (and a 1080p tier at 8). Every Grok video run is under-billed by a third. | Verified on kie.ai |
| 2 | P1 | seedance-2-5 | The 2026-09-03 release publishes 10 clip and 10 audio slots, the quote accepts them, but the start service still refuses more than 3 of either with a "Seedance 2" message. | Reproduced |
| 3 | P1 | kling-3.0-video | Named video elements are sent as `element_input_video_urls`; Kie's live schema has no such field and marks `element_input_urls` required per element. The spec also now says `image_urls` is required whenever `@element` is used. | Schema drift, provider outcome unverified |
| 4 | P2 | seedance-2 family, minimax-h3, wan-2.7, kling-3.0-video | An end-frame-only draft is silently sent as the *first* frame. | Reproduced |
| 5 | P2 | wan-2.7 | References mode allows 2–15 s; Kie's r2v endpoint stops at 10 s. A 15 s reference run is quoted and dispatched. | Reproduced |
| 6 | P2 | gpt-image-2 | 5:4 and 4:5 are offered at 2K/4K; Kie only renders them at 1K. The quote accepts 4:5 @ 2K. | Reproduced |
| 7 | P2 (policy) | seedance-2-fast, seedance-2-mini | Both bill the pre-promotion rate while Kie runs a dated discount until Oct 7: users pay 1.33× (Fast) and 2.5× (Mini) the provider's current list price. | Verified on kie.ai |
| 8 | P3 | seedance-1.5-pro | 480p 12 s bills 19 / 38; Kie's per-second rate (1.75 / 3.5) makes it 21 / 42. | Verified |
| 9 | P3 | veo-3.1 | Quality (veo3) 4K text-to-video bills 380; Kie lists 370. | Verified |
| 10 | P3 | seedance-2 family, minimax-h3 | Total reference-*audio* duration (15 s) is a Kie rule we never enforce; audio slots carry optional duration metadata. | Gap |
| 11 | P3 | seedance-2-5 | The 1080p promotion was extended from Sep 17 to Oct 17. The pinned undiscounted rate stands; the dated comments and README rule are stale. | Doc drift |
| 12 | P3 | kling-2.6 | `character_orientation: image` caps output at 10 s on Kie; we allow 30 s in both orientations. | Gap |
| 13 | P3 | evidence files | `grok-imagine/*`, `kling_3.0.md`, `bytedance/seedance-2*` and README rule 5 no longer match Kie. | Doc drift |

Everything not listed here matched: field names, endpoint routing, mutual-exclusion
modelling, the September caps for Seedance 2.5 and MiniMax H3, and the pricing of 26 of the
30 priced models (details in the matrices below).

## P1 — fix before the next catalog release

### 1. Grok Imagine Video is under-billed by a third

- **Ours**: `VIDEO_MODELS['grok-imagine-video'].pricing = { '480p': 1.6, '720p': 3 }`, per
  second, mirrored in the active release's lookup table.
- **Kie** (`kie.ai/grok-imagine`, blocks attributed to `grok-imagine/text-to-video` and
  `grok-imagine/image-to-video`): "480p Output: 2.4 credits / sec • 720p Output: 4.5
  credits / sec • 1080p Output: 8 credits / sec". No 1.6 or 3 appears anywhere on the page.
- **History**: `model_api_references/grok-imagine/text-to-video` (captured 2026-04-27)
  recorded 1.6 / 3, so this is a provider price rise, not an original mistake.
- **Impact**: a 10 s 720p run is billed 30 credits and costs 45. Both spec pages also now
  offer `resolution: 1080p`, which we do not expose.
- **Fix**: `models.ts` pricing (2.4 / 4.5, add 1080p at 8 if exposing it), emit and publish a
  release, refresh the evidence file.

### 2. Seedance 2.5 refuses the clip and audio slots the catalog advertises

- **Ours**: descriptor and active release publish `videoReferences.max = 10` and
  `audioReferences.max = 10` (release `video-reference-caps-20260903`). The quote accepts
  four clips plus four tracks (*reproduced*, case J). The web surface renders all ten
  slots from a fresh session (that is what PR #95 fixed).
- **But** `generation-services.ts:2228` and `:2235` still guard the whole
  `isSeedance2VideoModelId` family at 3: a run with four clips fails with
  `Seedance 2 supports up to 3 reference videos per run.` (*reproduced*, cases C and D).
  The throw happens before the ledger hold, so no credits are lost, but the user gets a
  400 that contradicts the UI, after uploading everything.
- **Fix**: derive both guards from the per-model limit (`VIDEO_INPUT_LIMITS` or the
  descriptor) or delete them, since `quoteGenerationModel` already enforces the slot cap
  and the 30 s combined ceiling. Add the 4-clip case to
  `video-reference-caps-manifest.test.ts`.

### 3. Kling 3.0 video elements no longer match Kie's schema

- **Ours** (`generation-services.ts:2603`): each element is sent as
  `{ name, description, element_input_video_urls: [url] }` (*reproduced*, case F: the
  element's keys are exactly those three).
- **Kie** (`docs.kie.ai/market/kling/kling-3-0`, fetched today): `kling_elements[]` items
  have `element_input_urls` (required), `element_input_audio_urls`, `start_time`,
  `end_time`. The two time fields are documented as "Only effective when uploading videos
  through element_input_urls", i.e. video elements now travel in the same array as image
  elements, with a 3 000–8 000 ms window. There is no `element_input_video_urls` anywhere
  in the page. The `image_urls` field is additionally described as "Required when elements
  are referenced in the prompt (using @element_name syntax)"; we send it only when a frame
  is attached.
- **History**: `model_api_references/kling_3.0.md` (captured 2026-06-01) documents
  `element_input_video_urls`, so Kie renamed the field after we built the feature
  (commit `5e5f0b9`, 2026-05-14).
- **What is not known**: whether Kie still accepts the old name. If it does not, every
  Kling named-video-element run now fails at the provider after the hold (the failure path
  refunds). This needs one live probe; the cheapest is a 3 s `std` run
  (≈42 credits) with one element under `element_input_urls` plus `start_time`/`end_time`,
  or a comparison in the kie.ai playground for `kling-3-0`.
- **Fix once confirmed**: send `element_input_urls: [url]` with an optional window, decide
  whether a start frame must accompany elements, re-verify, and re-capture the evidence
  file with the new date.

## P2 — provider rejections and silent misroutes

### 4. An end-frame-only draft becomes the first frame

`frameImageUrls` in `startVideoGeneration` is built as
`[start ?? legacy[0], end ?? legacy[1]].filter(Boolean)`, which discards position. With only
an end frame attached, Seedance 2 Mini receives `first_frame_url = <end image>` and no
`last_frame_url` (*reproduced*, case A); MiniMax H3 is routed to `image-to-video` with the
same inversion (case B). Neither surface gates the end-frame control on a start frame: the
web dropzone and the mobile tile (`media-creation-screen.tsx:2924`, disabled only in
multi-shot) both accept it, and the quote agrees with the wrong payload because
`descriptorSlotCount` also derives `startFrame` from the image count.

Kie's rules differ per model, which is why the fix should keep positions rather than add one
guard: Seedance 2.5 states "last_frame_url cannot be passed alone; first_frame_url must be
provided together with it" (reject or require a start frame), while MiniMax H3's
image-to-video says "Either first_frame_url or last_frame_url must be provided" (a last-only
run is legal and should be sent as `last_frame_url`). Wan's `image-to-video` and Kling's
`image_urls` (index 0 = first, index 1 = last) have the same positional contract.

### 5. Wan 2.7 references mode exceeds Kie's 10-second ceiling

`wan/2-7-r2v` declares `duration: min 2, max 10`; text-to-video and image-to-video allow
2–15. Our single `duration` control spans 2–15 for every mode, so a 15 s run with a reference
clip is accepted by the quote (*reproduced*, case I) and dispatched to `wan/2-7-r2v` with
`duration: 15` (case E). Add a `control-range` rule (max 10) conditioned on
`referenceMode = elements`, and clamp the stepper on both surfaces when references are
attached.

### 6. GPT Image 2 offers aspect/resolution pairs Kie cannot render

Kie: image-to-image "5:4 and 4:5 aspect ratios only support 1K images"; text-to-image "for
2K and 4K resolution, the following aspect ratios are not supported: 5:4, 4:5, 3:1, 1:3,
and 9:21". We expose 5:4 and 4:5 alongside 1K/2K/4K, and the existing rules only cover
`auto → 1K` and `1:1 → 1K/2K`. The quote accepts 4:5 at 2K (*reproduced*, case G). Add two
`control-options` rules mirroring the existing ones.

### 7. Seedance 2 Fast and Mini bill the pre-promotion rate (policy)

Kie's `seedance-2-0` and `seedance-2-0-mini` pages both carry "Limited-time discount: …
reduced price until October 7, 06:00 (UTC)":

| Model | Tier | We bill (no video / with video) | Kie lists today | Ratio |
| --- | --- | --- | --- | --- |
| seedance-2-fast | 480p | 15.5 / 9 | 11.7 / 6.8 | 1.33× |
| seedance-2-fast | 720p | 33 / 20 | 24.8 / 15 | 1.33× |
| seedance-2-mini | 480p | 9.5 / 6 | 3.8 / 2.4 | 2.5× |
| seedance-2-mini | 720p | 20.5 / 12.5 | 8.2 / 5.0 | 2.5× |

This is exactly the posture `model_api_references/README.md` rule 5 prescribes (pin the
undiscounted rate; a release cannot reprice itself on a date), and the Fast figures are the
same 25 %-off relationship the evidence file recorded. It is flagged because the Mini gap is
2.5× and both promotions have already been extended once (the 2.5 offer moved from Sep 17
to Oct 17). Decide deliberately whether Mini should track the listed rate; nothing here
derives the post-offer number automatically.

## P3 — small drifts and unenforced rules

- **Seedance 1.5 Pro (8)**: Kie now prices per second (480p 1.75 / 3.5, 720p 3.5 / 7,
  1080p 7.5 / 15). Every entry in our per-duration table matches except 480p 12 s: 19 / 38
  vs 21 / 42 (*reproduced*, case H). The Mar-18 evidence file recorded 19 / 38, so Kie
  changed it.
- **Veo 3.1 quality 4K (9)**: `pricing.veo3.text['4k'] = 380`; Kie lists 370 for quality
  text-to-video and image-to-video. Lite/Fast at every resolution and quality 720p/1080p
  match. Note the reference path already bills 370 because `getVideoCost` counts frames as
  references, so only the pure text-to-video 4K quote is off.
- **Reference-audio totals (10)**: Seedance 2 / Fast / Mini state "total duration of all
  audios not exceeding 15 s" and MiniMax H3 "total duration of all reference audios cannot
  exceed 15 seconds". Audio slots are `durationMetadata: 'optional'` with no
  `combined-duration` constraint, so Kie can reject a quoted run. Low frequency; if audio
  duration becomes reliable on both clients, flip to `required` and add the constraint (the
  manifest validator already refuses the constraint without required metadata).
- **Seedance 2.5 offer date (11)**: comments in `models.ts`, the manifest test, README rule
  5 and `video-reference-caps-2026-09-03.md` all say Sep 17; Kie now says Oct 17. The
  pinned 159 / 96 is unaffected.
- **Kling 2.6 motion (12)**: `character_orientation: image` is documented as "max 10s
  video"; `MOTION_MODELS['kling-2.6'].maxDuration = 30` regardless of orientation.
- **Gemini Omni clip window**: we send `video_list: [{ url, start: 0, ends: duration }]`.
  Kie caps the window at 10 s (fine, our max duration is 10) and source clips at 30 s, but
  the slot carries no `maxDurationSeconds`, and a clip shorter than `duration` gets a window
  past its end. Also `duration` is ignored by Kie when a clip is present, which the flat
  with-video price already reflects.
- **Grok video duration type**: text-to-video declares `duration` as a number,
  image-to-video as a string; we send a number to both. Kie has coerced so far.
- **Grok image-to-image**: schema says `image_urls maxItems: 5`, prose says "up to 1"; our
  cap of 1 is the safe reading.
- **Z-Image**: Kie lists 0.8 credits; we bill 1. Integer billing rounds up anyway.

## What Kie exposes that the catalog does not (opportunities, no action required)

| Model | Kie capability | Our state |
| --- | --- | --- |
| grok-imagine-video | `image_urls` up to **7** on image-to-video, referenced in the prompt as `@image1`; `resolution: 1080p` (8 credits/s) | 1 image, 480p/720p |
| kling-o3 | image-to-video has a "First and Last Frames" variant (`image_urls` exactly 2); reference-to-video accepts `video_urls` (1 clip, billed at the 20/27/67 "with video input" rate); up to **7** multi-image subjects; `multi_prompt` up to 6 shots of 1–15 s | start frame only; no clips; 3 subjects; shots clamped to 12 s |
| kling-3.0-video | `mode: 4K` (67 credits/s either way); **image** elements (2–4 images per element, 3 elements) which `getVideoElementSupport` still reports as "not available for Kling yet"; `element_input_audio_urls` (5–30 s) | std/pro; video elements only |
| seedance-2 / -fast / -mini | `reference_image_urls maxItems: 9` | 5 |
| seedance-2-5 | `aspect_ratio: adaptive`, `output_format: mov`, `duration: -1` (auto) | not exposed |
| grok-imagine-image-2 | a new `grok-imagine-image-2-0/image-edit` endpoint (docs path `image-to-image`) takes `image_urls` 1–5 plus `aspect_ratio`; the old `task_id`-only editor moved to `segment-edit` | `maxImages: 0`, evidence file says no reference variant exists |
| wan-2.7 | image-to-video `first_clip_url` (continuation) and `driving_audio_url`; text-to-video `audio_url` | not exposed |
| veo-3.1 | `duration: 4 / 6 / 8` (REFERENCE_2_VIDEO fixed at 8) | 8 only |
| seedream-5-lite | `quality: ultra` (4K) | 2K/3K |
| minimax-h3 | `aspect_ratio: adaptive` on reference-to-video | not exposed |

## Per-model matrix — video

Caps are ours → Kie's (✓ = equal). "Combine" is whether frames may accompany references.

| Model | Provider ids (ours) | Images | Clips | Audio | Start / End | Combine | Clip total | Duration | Resolutions | Pricing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| kling-3.0-video | `kling-3.0/video` | 0 → elements 2–4 img ×3 | 3 video elements ✓ (1 URL each) | 0 → 1 per element | ✓ / ✓ (`image_urls` 1–2) | elements + frames ✓ | 3–8 s effective window | 3–15 ✓ | std/pro → +4K | ✓ (F3: element field) |
| kling-3.0-turbo | text / image | 0 ✓ | 0 ✓ | 0 ✓ | ✓ / – ✓ | – | – | 3–15 ✓ | 720p/1080p ✓ | ✓ 18 / 22.5 |
| seedance-1.5-pro | `bytedance/seedance-1.5-pro` | 2 ✓ (`input_urls` ≤ 2) | 0 ✓ | 0 ✓ | ✓ / ✓ | frames ARE the refs | – | 4/8/12 (Kie 4–12) | 480p–1080p ✓ | 480p 12 s off (F8) |
| seedance-2 | `bytedance/seedance-2` | 5 → **9** | 3 ✓ | 3 ✓ | ✓ / ✓ | exclusive ✓ | 15 s ✓ | 4–15 ✓ | 480p–4k ✓ | ✓ |
| seedance-2-fast | `bytedance/seedance-2-fast` | 5 → **9** | 3 ✓ | 3 ✓ | ✓ / ✓ | exclusive ✓ | 15 s ✓ | 4–15 ✓ | 480p/720p ✓ | undiscounted (F7) |
| seedance-2-mini | `bytedance/seedance-2-mini` | 5 → **9** | 3 ✓ | 3 ✓ | ✓ / ✓ | exclusive ✓ | 15 s ✓ | 4–15 ✓ | 480p/720p ✓ | undiscounted (F7) |
| seedance-2-5 | `bytedance/seedance-2-5` | 30 ✓ | 10 ✓ (start guard 3, F2) | 10 ✓ (start guard 3, F2) | ✓ / ✓ (last needs first) | exclusive ✓ | 30 s ✓ | 4–30 ✓ | 480p–1080p ✓ | ✓; 1080p pinned undiscounted |
| wan-2.7 | text / image / `wan/2-7-r2v` | 5 ✓ | 5 ✓ | 1 ✓ (`reference_voice`) | ✓ / ✓ | `first_frame` in r2v ✓ | img+clip ≤ 5 ✓ | 2–15 → **r2v ≤ 10** (F5) | 720p/1080p ✓ | ✓ 16 / 24 |
| happyhorse-1.1 | text / image / reference | 9 ✓ | 0 ✓ | 0 ✓ | ✓ / – ✓ | – | – | 3–15 ✓ | 720p/1080p ✓ | ✓ 22.5 / 29 |
| gemini-omni-video | `gemini-omni-video` | 7 ✓ | 1 ✓ (2 units) | voices 3, characters 3 ✓ | – / – ✓ | n/a | clip window ≤ 10 s | 4/6/8/10 ✓ | 720p–4k ✓ | ✓ |
| hailuo-2.3 | standard / pro | 0 ✓ | 0 ✓ | 0 ✓ | required / – ✓ | – | – | 6/10; 1080P 6 s only ✓ | 768P/1080P ✓ | ✓ |
| veo-3.1 | veo3 / veo3_fast / veo3_lite | 3 ✓ (lite+fast only ✓) | 0 ✓ | 0 ✓ | ✓ / ✓ (`imageUrls` 1–2) | exclusive ✓ | – | 8 (Kie 4/6/8) | 720p–4k ✓ | veo3 4K text 380 → 370 (F9) |
| grok-imagine-video | text / image | 1 → **7** | 0 ✓ | 0 ✓ | ✓ / – ✓ | n/a | – | 6–30 ✓ | 480p/720p → +1080p | **1.6 / 3 → 2.4 / 4.5** (F1) |
| kling-o3 | text / image / reference | 7 ✓; subjects 3×2–4 (Kie ≤ 7 subjects) | 0 (Kie r2v `video_urls` 1) | 0 ✓ | ✓ / – (Kie i2v also 2 frames) | separate endpoints ✓ | – | 3–15 ✓ | 720p–4k ✓ | ✓ 14/18, 18/23, 67/67 |
| minimax-h3 | text / image / reference | 9 ✓ | 3 ✓ | 3 ✓ (not alone ✓) | ✓ / ✓ (either) | separate endpoints ✓ | 15 s ✓ | 4–15 ✓ | 768P/2K ✓ | ✓ 8 / 13 on output + input seconds; +4/img past 5 unmodelled (≤ 16) |

## Per-model matrix — image and motion

| Model | Provider ids | Reference field | Cap (ours → Kie) | Pricing |
| --- | --- | --- | --- | --- |
| nano-banana-2 | `nano-banana-2` | `image_input` | 14 ✓ | ✓ 8 / 12 / 18 |
| nano-banana-2-lite | `nano-banana-2-lite` | `image_urls` | 10 ✓ | ✓ 4 |
| nano-banana-pro | `nano-banana-pro` | `image_input` | 8 ✓ | ✓ 18 / 18 / 24 |
| gpt-image-2 | text / image-to-image | `input_urls` | 16 ✓ | ✓ 6 / 10 / 16 (aspect rules, F6) |
| seedream-5-pro | text / image-to-image | `image_urls` | 10 ✓ | ✓ 7 / 14, +0.5 per extra image, first free |
| seedream-5-lite | text / image-to-image | `image_urls` | 14 ✓ | ✓ 5.5 flat |
| wan-2.7-image / -pro | `wan/2-7-image[-pro]` | `input_urls` | 9 ✓ | ✓ 4.8 / 12; Pro 4K text-only rule ✓ |
| imagen-4 family | `google/imagen4*` | – | 0 ✓ (disabled in prod) | ✓ 4 / 8 / 12 |
| ideogram-v3 | text / `v3-remix` | `image_url` (single) | 1 ✓ | ✓ 3.5 / 7 / 10 |
| flux-2-pro | text / image-to-image | `input_urls` | 8 ✓ | ✓ 5 / 7 |
| z-image | `z-image` | – | 0 ✓ | 1 vs 0.8 (rounds to 1) |
| grok-imagine-image | text / image-to-image | `image_urls` | 1 ✓ (schema 5, prose 1) | ✓ 4 / 5; i2i 4 |
| grok-imagine-image-2 | text only | – | 0 → Kie now has `image-edit` with 1–5 | ✓ 4 |
| qwen3 / qwen3-pro | text / image-to-image | `image_urls` | 3 ✓ | ✓ 4.8; 6.4 / 12; +0.5 per image |
| ideogram-character | `ideogram/character` | `reference_image_urls` | 1 ✓ (Kie: "only 1 supported") | ✓ 12 / 18 / 24 |
| kling-2.6 (motion) | `kling-2.6/motion-control` | `input_urls` 1 + `video_urls` 1 | ✓ | ✓ 11 / 18; image orientation ≤ 10 s (F12) |
| kling-3.0 (motion) | `kling-3.0/motion-control` | same | ✓ | ✓ 20 / 27 |

## Layer consistency (in-repo)

- The seven mirrors agree with each other today: `VIDEO_INPUT_LIMITS` ↔
  `VIDEO_REFERENCE_IMAGE_CAPS` ↔ both `getVideoElementSupport` copies ↔
  `getVideoReferenceSupport` ↔ the manifests ↔ production. `model-registry-parity` and
  `video-reference-caps-manifest` pin this; the one mirror they do not reach is the
  hand-written family guard in `startVideoGeneration` (finding 2), which is why it drifted.
- Mutual-exclusion modelling matches Kie's three shapes: Seedance documents frames and
  references as exclusive scenarios on one endpoint; MiniMax H3 and Kling O3 route to
  reference endpoints with no frame field; Wan's r2v takes `first_frame`. Kling 3.0's video
  elements coexist with frames, and the mobile screen distinguishes mode-gated reference
  slots from that always-on slot correctly.
- The legacy `getVideoCost` cross-check is inert: `resolveQuotedGenerationCost` returns the
  quote whenever one is supplied, and every start service found (web video, image, motion,
  the unified catalog path, and the workflow runner) supplies one. Its Seedance and MiniMax
  branches still bill output seconds only, so any future caller that omits a quote would
  under-bill reference runs.
- Mobile derives `referenceMode` from attachments on every read (`videoDraftReferenceMode`),
  and the bundled `media-creation-view-model.ts` ladder is test-only; neither drifted.
- `referenceMode` remains a descriptor control (passthrough setting) although no surface
  renders a picker any more; harmless, and older mobile builds still parse it.

## Evidence that needs re-capture

| File | Captured | Out of date on |
| --- | --- | --- |
| `model_api_references/grok-imagine/text-to-video`, `image-to-video` | 2026-04-27 | price 1.6 / 3 → 2.4 / 4.5 / 8; i2v `image_urls` up to 7; 1080p |
| `model_api_references/kling_3.0.md` | 2026-06-01 | `element_input_video_urls` gone; `element_input_urls` + `start_time`/`end_time`; `mode: 4K`; `image_urls` required with elements |
| `model_api_references/bytedance/seedance-2`, `seedance-2-fast` | 2026-07-24 / 04-04 | `reference_image_urls maxItems: 9`; Fast 480p with-video listed 6.8 (promo) |
| `model_api_references/bytedance/seedance-1.5-pro.md` | 2026-03-18 | per-second pricing (480p 12 s now 21 / 42) |
| `model_api_references/dropin-models-2026-08-15.md` | 2026-08-15 | grok-imagine-image-2 now has an image-edit endpoint taking `image_urls` |
| `model_api_references/README.md` rule 5, `video-reference-caps-2026-09-03.md` | 2026-09-03 | offer date Sep 17 → Oct 17 |

Re-verify with the committed tooling: `node scripts/kie-evidence.mjs price <slug>` for
credits (it now prints promotion qualifiers) and `spec <docs-path>` for fields, remembering
that the `price` scan lists every variant's block on a multi-model page in page order.

## What shipped (2026-09-04, branch `fix/reference-input-audit`)

| # | Fix | Where | Verified by |
| --- | --- | --- | --- |
| 1 | Grok Imagine Video bills 2.4 / 4.5 credits per second | `models.ts`, release manifest | `models.test.ts`, `reference-audit-manifest.test.ts` (15 for 6 s @ 480p, 45 for 10 s @ 720p) |
| 2 | Seedance clip and audio guards read `getVideoInputLimits` (now exported) instead of a literal 3; the workflow canvas reads `getVideoReferenceSupport` and a per-model seconds cap | `generation-services.ts`, `workflow-canvas.ts` | `generation-services.test.ts`: four clips and four tracks reach Kie on 2.5; Fast still stops at three, naming the model |
| 3 | Kling 3.0 video elements travel as `element_input_urls` | `generation-services.ts` | Live: the old field is refused by Kie (`code 422`, "element_input_urls is required", no task created); the new payload created task `2c70c7b2…` which completed with a video in 85 s. Unit tests updated |
| 4 | Frames keep their positions; a lone end frame is refused on every model but MiniMax H3, where it travels as `last_frame_url`; a quote-time `min-slot-count` rule says the same before submit; mobile now shows the quote's field message | `generation-services.ts`, `generation-model-runtime.ts`, `media-creation-screen.tsx` | `generation-services.test.ts` (Seedance 2 Mini refused, MiniMax last-only sent), manifest test across six models |
| 5 | Wan 2.7 reference runs capped at 10 s, at quote time and at start | runtime rule + `generation-services.ts` | manifest test (15 s refused with a clip, accepted without), service test |
| 6 | GPT Image 2 offers 1K only at 5:4 and 4:5 in both helpers, the mobile mirror, and a quote rule | `models.ts`, `client-generation-models.ts`, `media-creation-view-model.ts`, runtime rule | `models.test.ts`, `workflow-canvas.test.ts`, manifest test |
| 7 | Not changed: Fast and Mini keep the undiscounted rate per README rule 5 (now dated Oct 7 in the evidence); re-read both pages after Oct 7 06:00 UTC | `model_api_references/reference-audit-2026-09-04.md` | — |
| 8 | Seedance 1.5 Pro 480p 12 s bills 21 / 42 | `models.ts` | `models.test.ts`, manifest test |
| 9 | Veo quality 4K text-to-video bills 370 | `models.ts` | `models.test.ts`, manifest test |
| 10 | 15 s combined reference-audio ceiling on Seedance 2 / Fast / Mini and MiniMax H3 as a runtime rule; the web surface now measures audio durations and reports them in the quote. Mobile cannot measure a picked audio file, so the rule stays advisory there | runtime rule, `CreateVideoClient.tsx` | manifest test (16 s refused, 14 s accepted, unreported durations accepted) |
| 11 | Offer date corrected to Oct 17 in `models.ts`, the September evidence file, the manifest test and README rule 5 | comments and docs | — |
| 12 | Kling 2.6 image orientation capped at 10 s, at quote time and at start | runtime rule + `generation-services.ts` | manifest test, service test |
| 13 | New capture `model_api_references/reference-audit-2026-09-04.md`; seven stale files carry supersession banners; README gained rules 9 and 10 (price attribution, silent repricing) | `model_api_references/` | — |
| 14 (new) | `minimax-h3` code pricing now emits the reference-adjustment shape production already runs; `minimax-reference-duration-manifest.test.ts` pins the September release to the code build; the runbook now states that every release is emitted and then pinned | `generation-model-runtime.ts`, tests, runbook | manifest tests |

Release manifest: `config/generation-model-catalog/releases/2026-09-04-reference-audit.json`
(revision `reference-audit-20260904`, based on `minimax-reference-duration-20260904`, twelve
entries). Staged and published to production on 2026-09-04 at 10:58 UTC after a read-back of
the shadow rows; every rule type it uses was already supported by the deployed quote engine,
and all three public projections served the new revision within the minute. The code fixes
for findings 2, 3, 4 and 5 go live with this branch's deploy (PR #101).

Still open, by choice: finding 7 (a pricing decision), the mobile side of finding 10 (needs
a way to read audio duration on device), and the opportunities table above.
