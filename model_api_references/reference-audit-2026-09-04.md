# Reference-input audit — re-verified provider evidence (2026-09-04)

Read from the live OpenAPI bodies under `https://docs.kie.ai/market/<vendor>/<model>.md`
(61 pages parsed) and the `pricingDesc` blocks on `https://kie.ai/<slug>` (30 pages), with
`curl`/`fetch` under a browser User-Agent. Credits are Kie credits 1:1 (1 credit = $0.005).
Full comparison against the catalog: `docs/model-reference-inputs-audit-2026-09-04.md`.
Shipped as catalog release
`config/generation-model-catalog/releases/2026-09-04-reference-audit.json` plus the code
changes on branch `fix/reference-input-audit`.

This supersedes the sections named below in `grok-imagine/text-to-video`,
`grok-imagine/image-to-video`, `kling_3.0.md`, `bytedance/seedance-2`,
`bytedance/seedance-2-fast`, `bytedance/seedance-1.5-pro.md` and
`dropin-models-2026-08-15.md`; each carries a banner pointing here.

## Reading kie.ai pricing without misattributing it

Two traps, both hit on the first pass of this audit:

- Each `"pricingDesc"` block on a multi-variant page sits **before** the `"model"` key of
  the variant it prices. The model id that appears just *after* a block names it; the id
  just before names the previous block. On `kie.ai/grok-imagine` that is how 2.4 / 4.5 / 8
  belongs to `grok-imagine/text-to-video` and `image-to-video`, not to extend or upscale.
- Pages also carry a `"pricingDescCn"` with different, Chinese-market figures (Veo lite
  15 / 22.5 / 75 against the real 30 / 35 / 150). `kie-evidence.mjs price` prints both
  sets without labelling them; only `pricingDesc` applies.

## `grok-imagine-video` → `grok-imagine/text-to-video` · `/image-to-video`

Pricing, quoted from the `pricingDesc` of both variants:

```
• 480p Output: 2.4 credits / sec        • 720p Output: 4.5 credits / sec       • 1080p Output: 8 credits / sec
High-tier top-ups (+10% bonus) bring effective pricing down to ~10% off the above rates.
```

The 2026-04-27 capture recorded 1.6 / 3; nothing on the page lists those figures any
more. Shipped: 2.4 / 4.5 (the 1080p tier is not exposed).

Schema deltas since that capture: `resolution` enum is `480p | 720p | 1080p`;
image-to-video `image_urls` "Up to 7 images are supported … reference an uploaded image by
typing @image(n)"; `aspect_ratio` "only applies to multi-image generation mode";
text-to-video declares `duration` as a number, image-to-video as a string (we send a
number to both; Kie has coerced so far).

## `kling-3.0-video` → `kling-3.0/video`

`kling_elements[]` items, quoted from the live schema:

```
required: [name, description, element_input_urls]
element_input_urls:        Image URLs for the element. 2-4 URLs required. Accepted formats: JPG, PNG.
element_input_audio_urls:  Optional. List of audio material URLs for characters. 5–30 seconds.
start_time:                Start time for video character material capture (ms). Only effective when
                           uploading videos through element_input_urls. If not uploaded, it defaults to 0.
end_time:                  … difference between end_time and start_time must be within 3000 to 8000 ms.
```

Prose: "Image Elements: 2-4 image URLs", "Video Elements: Up to 1 video URL (MP4/MOV, at
least 3 seconds, effective segment 3–8 s)", "Audio Reference: Up to 1 audio URL". There is
no `element_input_video_urls` anywhere on the page; the 2026-06-01 capture documented it
and the feature was built against it.

**Live probes, 2026-09-04** (`kling-3.0/video`, std, 3 s, 1:1, one video element):

| Payload | Kie response |
| --- | --- |
| `element_input_video_urls: [url]` (what production sent) | HTTP 200, body `code 422`, `"kling_elements element 'sample_clip'.element_input_urls is required."` — no task created |
| `element_input_urls: [url]`, no window (what the fix sends) | task created; ran character detection (`costTime 15`); failed only because the public sample clip had no person |
| `element_input_urls: [url]` with a Kie-hosted sample clip (`static.aiquickdraw.com/tools/example/1767525918769_QyvTNib2.mp4`) | task `2c70c7b27e7892e85463442a52282332` reached `state: success` with a result video in 85 s |

So every named-video-element run since Kie renamed the field failed at the provider
after the credit hold (the failure path refunds). The `image_urls` field is described as
"Required when elements are referenced in the prompt", but the probes above carried no
`image_urls` and were accepted, so that line is not enforced.

Also new since June: `mode` enum `std | pro | 4K` (4K at 67 credits/s either way).

## `seedance-2` · `seedance-2-fast` · `seedance-2-mini`

`reference_image_urls` is `maxItems: 9` on all three ("The sum of the number of frames at
the beginning and end must not exceed 9"); the catalog still offers 5. `reference_video_urls`
and `reference_audio_urls` stay at 3 with "total duration of all videos / audios not
exceeding 15 seconds". The Fast spec spells the video field with a trailing space
(`reference_video_urls `) — a docs typo; the example request uses the plain name.

Pricing on `kie.ai/seedance-2-0` and `kie.ai/seedance-2-0-mini`, quoted verbatim:

```
Fast — 480P: 6.8 credits/s ($0.034/s, with video) | 11.7 credits/s ($0.059/s, no video)
       720P: 15 credits/s ($0.075/s, with video) | 24.8 credits/s ($0.124/s, no video)
🎉 Limited-time discount: Seedance 2.0 Fast is now available at a reduced price until October 7, 06:00 (UTC).

Mini — 480p — 2.4 credits/s ($0.012/s, with video) | 3.8 credits/s ($0.019/s, no video)
       720p — 5.0 credits/s ($0.025/s, with video) | 8.2 credits/s ($0.041/s, no video)
🎉 Limited-time discount: Seedance 2.0 Mini is now available at a reduced price until October 7, 06:00 (UTC).
```

Both are dated promotions (Fast ≈ 25 % off, Mini 60 % off the rates we ship: 15.5 / 9,
33 / 20 and 9.5 / 6, 20.5 / 12.5). Per README rule 5 the undiscounted rates stay pinned;
until Oct 7 users pay 1.33× (Fast) and 2.5× (Mini) Kie's current list. Re-read both pages
after Oct 7 06:00 UTC. Seedance 2 (standard) is unchanged and matches exactly.

## `seedance-2-5`

Caps unchanged from `video-reference-caps-2026-09-03.md` (30 / 10 / 10, 30 s of clips).
`last_frame_url`: "cannot be passed alone; first_frame_url must be provided together with
it." The 1080p promotion moved: "Limited-Time 1080P Offer: 28% OFF until **Oct 17**, 2026
06:00 UTC" (was Sep 17). The pinned undiscounted 159 / 96 stands.

## `seedance-1.5-pro`

Pricing is now per second on `kie.ai/seedance-1-5-pro`:

```
480p: 1.75 credits/s no audio, 3.5 credits/s with audio;
720p: 3.5 credits/s no audio, 7 credits/s with audio;
1080p: 7.5 credits/s no audio, 15 credits/s with audio.
```

Multiplied out, every cell of the 4 / 8 / 12 s table matches except 480p 12 s, which is
21 / 42 (the 2026-03-18 capture listed 19 / 38). Shipped: 21 / 42.

## `veo-3.1`

`pricingDesc` on `kie.ai/veo-3-1`: Lite 30 / 35 / 150, Fast 60 / 65 / 180, "Quality mode
(text-to-video / image-to-video): 720P — 250 credits; 1080P — 255 credits; 4K — 370
credits". We billed 380 for quality 4K text-to-video; shipped 370. `generationType`
prose: "REFERENCE_2_VIDEO … requires 1-3 images in imageUrls" and "currently supports the
veo3_fast and veo3_lite models"; `duration` enum is now `4 | 6 | 8` (reference mode 8 only).

## `minimax-h3`

Unchanged from `video-reference-caps-2026-09-03.md`. `image-to-video`: "Either
first_frame_url or last_frame_url must be provided", so a last-only run is legal and now
travels as `last_frame_url`. `reference-to-video`: "the total duration of all reference
audios cannot exceed 15 seconds."

## `wan-2.7` → `wan/2-7-r2v`

`duration: integer, min 2, max 10, default 5` on the reference endpoint; text-to-video and
image-to-video declare 2–15. `reference_image` and `reference_video` are `maxItems: 5`
each with "The total number of images and videos cannot exceed 5"; `reference_voice` is a
single URL; `first_frame` "At most one image".

## `gpt-image-2`

Image-to-image: "5:4 and 4:5 aspect ratios only support 1K images." Text-to-image: "for
2K and 4K resolution, the following aspect ratios are not supported: 5:4, 4:5, 3:1, 1:3,
and 9:21." Shipped: 5:4 and 4:5 offer 1K only (3:1, 1:3 and 9:21 are not exposed).

## `kling-2.6` → `kling-2.6/motion-control`

`character_orientation`: "'image': same orientation as the person in the picture (max 10s
video). 'video': consistent with the orientation of the characters in the video (max 30s
video)." Shipped: image orientation refuses more than 10 s. Kling 3.0 motion-control
states no such limit.

## `grok-imagine-image-2` — reference variant now exists

`docs.kie.ai/market/grok-imagine-image-2-0/image-to-image.md` documents model
`grok-imagine-image-2-0/image-edit` with `image_urls` (1–5 URLs, required) and
`aspect_ratio`; the `task_id`-only editor the 2026-08-15 note describes moved to
`grok-imagine-image-2-0/segment-edit`. Not wired (still `maxImages: 0`); noted so the next
model pass does not repeat the "no reference variant" conclusion.
