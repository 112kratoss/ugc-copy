# Wan 3.0 Video and Video Prime — verified provider evidence (2026-10-08)

Captured from `https://docs.kie.ai/market/wan/3-0-video.md` and `.../wan/3-0-video-prime.md`
(OpenAPI bodies, diffed: identical inputs) and the market pages `https://kie.ai/wan3.0-video` and
`https://kie.ai/wan3.0-video-prime` (`pricingDesc`, `scripts/ops/kie-evidence.mjs price`). Credits
are Kie credits 1:1 (1 credit = $0.005). Listed by Kie on 2026-08-24; first scanned 2026-09-11,
prices unchanged on 2026-10-07 and 2026-10-08.

## Provider ids

| App id | `model` enum |
| --- | --- |
| `wan-3.0` | `wan/3-0-video` |
| `wan-3.0-prime` | `wan/3-0-video-prime` |

One id each for text, frames and references. Endpoint `POST /api/v1/jobs/createTask`, the shared
status and callback path. The spec's tip: "Billed seconds = output duration + total duration of
reference videos. With duration = -1, billing follows the duration the model chooses."

## Inputs (both ids)

- `prompt` — up to 20,000 characters; "Required for text-to-video generation". "In reference
  mode, use Image1/Video1/Audio1 to reference the provided media."
- `first_frame_url` — one image, "Cannot be provided together with `reference_*_urls`".
  `last_frame_url` — "Use together with first_frame_url".
- `reference_image_urls` — `maxItems: 10`; `reference_video_urls` — `maxItems: 5`, "Each clip
  must be 1–15 seconds, with a total duration ≤ 15 seconds", and "the input video duration +
  `duration` must not exceed 30 seconds"; `reference_audio_urls` — `maxItems: 5`, 1–15 s each,
  ≤ 15 s in total, wav or mp3 ≤ 15 MB. All three "Cannot be provided together with the
  first-frame/last-frame parameters".
- `reference_file_urls`, `reference_link_urls` — a document or a web page as the source; not a
  product surface we have, not offered.
- `resolution` — `480P`, `720P`, `1080P` (default `1080P`, uppercase P).
- `aspect_ratio` — `adaptive` (default), `16:9`, `4:3`, `1:1`, `3:4`, `9:16`.
- `duration` — integer, default 5; "Without video input, the range is [2, 30]"; "Pass `-1` to use
  an intelligent duration determined by the model."
- `audio` — boolean, default true: "Whether the output video includes an audio track."
- `seed`, `nsfw_checker` — not sent.

Against Wan 2.7 (`wan/2-7-*`, `docs/model-api-references/reference-audit-2026-09-04.md`): no
`prompt_extend`, `negative_prompt`, `watermark` or `ratio`; references are `reference_image_urls`
(not `reference_image`), and the duration reaches 30 s.

## Price (`pricingDesc`, 2026-10-08)

- Wan 3.0: 8 credits/s at 480P, 16 at 720P, 32 at 1080P — "all 20% below official pricing".
- Wan 3.0 Prime: 12.2 credits/s at 480P, 25.2 at 720P, 50.4 at 1080P — "all 10% below official
  pricing".

The "below official pricing" lines are Kie's standing rate against Alibaba's own API, as
minimax-h3's "50% of the official price" is, not a dated offer; both figures were the same on
2026-09-11, 2026-10-07 and 2026-10-08. Billed seconds are output seconds plus reference-clip
seconds.

## Shipped (2026-10-08)

- App ids `wan-3.0` and `wan-3.0-prime`, provider `wan-3` (a branch of its own, so Wan 2.7's body
  is never reused), on `video-v1`. Resolutions 480P, 720P, 1080P; duration 2–30 s as a stepper;
  ratios 16:9, 9:16, 1:1, 4:3, 3:4; a Sound toggle.
- Inputs: 10 reference images, 5 clips (15 s each and in total), 5 audio files (15 s each and in
  total), a start frame with an optional end frame. Frames and references are the catalog's
  either/or; a lone end frame is refused.
- Price: `reference-adjustment` per second, one rate per resolution for runs with and without
  clips, so the quote adds each reference clip's seconds, as the spec bills. `duration: -1` cannot
  be chosen: the control and `isValidVideoDuration` take 2–30 only.
- Reference runs keep their output to 15 s (`WAN_3_REFERENCE_MAX_DURATION_SECONDS`): clips may
  total 15 s and the spec caps input plus output at 30. Quote rule and start-path check.
- Request body (`startVideoGeneration`): `prompt`, `resolution`, `duration`, `audio`; references as
  `reference_image_urls` / `reference_video_urls` / `reference_audio_urls` with `aspect_ratio`;
  frames as `first_frame_url` / `last_frame_url` with the ratio left to the model (`adaptive`); a
  text run sends `aspect_ratio`. `nsfw_checker`, `seed`, `reference_file_urls` and
  `reference_link_urls` are never sent.
- Enhancer: `wan-3.0` has a playbook of its own (positional Image1 / Video1 / Audio1 references,
  no server-side extender, audio as a switch); `wan-3.0-prime` is its alias.
