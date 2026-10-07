# Grok Imagine Video 1.5 Preview — verified provider evidence (2026-10-08)

Captured from `https://docs.kie.ai/market/grok-imagine/1-5-preview.md` (OpenAPI body) and the
market page `https://kie.ai/grok-imagine-video-1.5` (`pricingDesc`,
`scripts/ops/kie-evidence.mjs price grok-imagine-video-1.5`). Credits are Kie credits 1:1
(1 credit = $0.005). Listed by Kie on 2026-06-01; first scanned 2026-09-11, prices unchanged on
2026-10-07 and 2026-10-08.

## Provider id

`grok-imagine-video-1-5-preview` — the sole entry of the `model` enum, for text and pictures
alike. Endpoint `POST /api/v1/jobs/createTask`, the shared status and callback path. The docs
path (`grok-imagine/1-5-preview`) is not the id.

The page's description, as for the other Grok Imagine endpoints: "Output is an MP4 video with an
audio track generated together with the video (dialogue written in the prompt is spoken). Audio
cannot be turned off."

## Inputs

- `prompt` — up to 4,096 characters. Nothing is `required` in the schema.
- `image_urls` — `maxItems: 7`, jpeg / png / webp ≤ 20 MB each. "Only one is supported when the
  resolution is 1080p."
- `aspect_ratio` — `1:1`, `16:9`, `9:16`, `3:2`, `2:3`, `auto` (default). "This parameter is
  invalid if it is a single image."
- `resolution` — `480p`, `720p`, `1080p` (default `480p`).
- `duration` — integer 1–15, default 8, step 1.
- `nsfw_checker` — boolean, "Defaults to false. When false, no additional content filtering is
  applied".

Against `grok-imagine/text-to-video` and `image-to-video` (`grok-imagine/` in this folder): no
`mode` field (no normal / fun), seven pictures where the older ids take one, 1–15 s where the
older ids reach 30.

## Price (`pricingDesc`, 2026-10-08)

"2.4 credits per second for 480p (≈ $0.012), 4.5 credits per second for 720p (≈ $0.0225)— video
generation is about 90% of official pricing." The same rates as `grok-imagine-video`. **1080p is in
the schema and carries no published price, so it does not ship** (README rule 2).

## Shipped (2026-10-08)

- App id `grok-imagine-video-1.5`, provider `grok` (the Grok branch, minus `mode`), on `video-v1`.
  Resolutions 480p and 720p; duration 1–15 s as a stepper, default 8; ratios 16:9, 9:16, 1:1,
  3:2, 2:3; no mode control.
- Inputs: 7 reference images, or one start frame (no end frame). Frames and references are the
  catalog's either/or.
- Request body (`startVideoGeneration`): `prompt`, `duration`, `resolution`, `nsfw_checker: true`
  (as the Grok branch has always sent); `image_urls` when pictures are attached, and
  `aspect_ratio` for a text run or when more than one picture is attached, never with a single
  picture.
- Price: 2.4 / 4.5 credits per second (`grok-imagine-video-1.5` in `getVideoCost` and
  `videoPricingExpression`).
- Enhancer: alias of `grok-imagine-video` (same prompt grammar; audio always generated).
