# Gemini Omni 1.1 Flash — verified provider evidence (2026-10-08)

Captured from `https://docs.kie.ai/market/google/gemini-omni-flash-1-1.md` (OpenAPI body) and the
market page `https://kie.ai/gemini-omni-1-1-flash` (`pricingDesc`, read with
`scripts/ops/kie-evidence.mjs price gemini-omni-1-1-flash`). Credits are Kie credits 1:1
(1 credit = $0.005). Listed by Kie on 2026-08-28; first scanned 2026-09-11, prices unchanged on
2026-10-07 and 2026-10-08.

## Provider id

`google/gemini-omni-flash-1-1` — the sole entry of the `model` enum, for text, frames and
references alike. Endpoint `POST /api/v1/jobs/createTask`, the shared status and callback path.
The docs path and the id agree.

## Inputs

- `prompt` — required, up to 20,000 characters.
- `duration` — required, string enum `4`, `6`, `8`, `10`. "This parameter only takes effect when
  there is no video input. If video input is used, the output duration is determined by the
  model".
- `aspect_ratio` — `16:9`, `9:16`.
- `resolution` — `360p`, `720p`, `1080p`, `4k` (default `720p`).
- `image_urls` — array, "Maximum of 7 images", each ≤ 20 MB. "This field is mutually exclusive
  with the first-frame image (`first_frame_url`)".
- `first_frame_url` — "mutually exclusive with `image_urls`, `audio_ids`, `video_list`, and
  `character_ids`".
- `last_frame_url` — "cannot be used alone and must be provided together with the first-frame
  image".
- `video_list` — array of `{ url, start, ends }`: "Maximum of 1 item, occupying two image slots";
  each file ≤ 100 MB and ≤ 30 s, `ends - start` ≤ 10 s; mutually exclusive with the first frame.
- `audio_ids`, `character_ids` — ids from the `gemini-omni-audio` and `gemini-omni-character`
  helper endpoints, which carry no published price. Not offered.
- `seed` — integer; not sent.

Against `gemini-omni-video` (`docs/model-api-references/reference-audit-2026-09-04.md`): the same
prompt, image_urls, video_list, duration, aspect_ratio and resolution body, plus the frame pair
and the 360p tier.

## Price (`pricingDesc`, 2026-10-08)

- 360P / 720P / 1080P: 4 s 63, 6 s 84, 8 s 105, 10 s 126 credits.
- 4K: 4 s 147, 6 s 168, 8 s 189, 10 s 210 credits.
- With a video input the price is flat, "per generation": 168 credits at 360P / 720P / 1080P,
  252 at 4K.

Identical to Gemini Omni Video's table, with 360p priced like 720p and 1080p. No promotional
qualifier.

## Shipped (2026-10-08)

- App id `gemini-omni-1.1-flash`, provider `gemini-omni`, on `video-v1`. Resolutions 360p, 720p,
  1080p, 4k; durations 4, 6, 8, 10; ratios 16:9 and 9:16.
- Inputs: 7 reference images, 1 reference clip (two of the seven slots), a start frame with an
  optional end frame. Frames and references are the catalog's either/or (`referenceMode`), which
  is the spec's mutual exclusion; a lone end frame is refused on the quote and the start path.
- Request body (`startVideoGeneration`): `prompt`, `duration` as a string, `aspect_ratio`,
  `resolution`; frames as `first_frame_url` / `last_frame_url`; otherwise `image_urls` when
  pictures are attached and `video_list: [{ url, start: 0, ends: <duration> }]` for a clip.
  `audio_ids`, `character_ids` and `seed` are never sent.
- Price: the table above (`gemini-omni-1.1-flash` in `getVideoCost` and
  `videoPricingExpression`); a run with a clip quotes the flat figure.
- Enhancer: alias of `gemini-omni-video` (same body and prompt grammar).
