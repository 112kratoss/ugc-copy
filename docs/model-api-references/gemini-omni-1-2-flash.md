# Gemini Omni 1.2 Flash — verified provider evidence (2026-11-14)

Captured on 2026-11-14 from `https://docs.kie.ai/market/google/gemini-omni-flash-1-2.md` (OpenAPI
body) and the market page `https://kie.ai/gemini-omni-1-2-flash` (`pricingDesc`). Raw copies:
`UGC copy/archive/kie-models-2026-11-14/evidence/`. Listed by Kie on 2026-11-06.

## Provider id

`google/gemini-omni-flash-1-2` — the sole entry of the `model` enum, for text, references and
frames. Endpoint `POST /api/v1/jobs/createTask`, the shared status and callback path. The
empty-input probe answered "This field is required" with no task
(`archive/kie-models-2026-11-14/probe-results.txt`). A sibling,
`google/gemini-omni-flash-1-2-extend`, lengthens an earlier clip and is not shipped.

## Inputs — changed against 1.1 (`gemini-omni-1-1-flash.md`)

"Use only one generation mode per request: text / reference images, first frame only, first and
last frame, or video edit."

- `prompt` — required, 1–20,000 characters (:157-167).
- `duration` — now an **integer, 3–15** (:168-187), where 1.1 took the strings `4`, `6`, `8`, `10`:
  "First frame only: required, 3–15"; "First and last frame: required, **3–10**"; "Video edit
  (`video_list` set): do not send; output duration follows the input video".
- `aspect_ratio` — `16:9` (default), `9:16`, `auto`; "When no reference image is provided, `auto`
  is treated as `16:9`" (:188-213). `auto` is not offered.
- `resolution` — `360p`, `720p` (default), `1080p`, `4k` (:214-239). Unchanged.
- `seeds` — integer 10000–99999 (:240-248). Not sent (1.1's `seed` was not either).
- `image_urls` — **up to 6** (1.1: 7), each ≤ 20 MB, "Mutually exclusive with `first_frame_url`
  and `last_frame_url`" (:249-273).
- `character_ids` — up to 2, from `/api/v1/omni/character/create` (:274-288). Not offered, as for
  1.1: the helper carries no published price.
- `first_frame_url`, `last_frame_url` — `last_frame_url` "must be sent together with
  `first_frame_url`" (:289-319, and `dependencies` :350).
- `video_list` — now an array of **plain URLs**, at most 1, "no longer than 15 seconds", the video
  edit mode (:320-346). 1.1 took `{ url, start, ends }` objects of up to 30 s.
- `audio_ids` — gone.

## Price (`pricingDesc`, 2026-11-14)

```
- 360P: 4 credits/s ($0.02)
- 720P: 9 credits/s ($0.045)
- 1080P: 10 credits/s ($0.05)
- 4K: 22 credits/s ($0.11)
Billed per second of output. Text, image and first/last-frame requests are billed for the
selected duration; video editing is billed for the length of the input video at the same rates.
```

1.1's table was per run (63 / 84 / 105 / 126 at 360p–1080p) with a flat figure for a clip; 1.2 is
per second: **4 / 9 / 10 / 22 credits per second** at 360p / 720p / 1080p / 4K. A 6 s 720p run is
54 credits; 15 s at 4K, 330. No promotional wording.

## Shipped (2026-11-14)

- App id `gemini-omni-1.2-flash` ("Gemini Omni 1.2 Flash"), provider `gemini-omni`, maker Google,
  on `video-v1`. Resolutions 360p, 720p, 1080p, 4k; 3–15 s, default 6; ratios 16:9 and 9:16.
- Inputs: up to 6 reference pictures, or a start frame with an optional end frame — the spec's
  mutual exclusion, as the catalog's either/or. A frame pair longer than 10 s is refused at the
  quote and at the start, before any hold.
- Video edit is not offered: its price follows the input clip's length with no output duration,
  a shape the catalog does not price yet, and its output length is the model's.
- Request body: `prompt`, `duration` as an integer, `aspect_ratio`, `resolution`; frames as
  `first_frame_url` / `last_frame_url`, otherwise `image_urls` when pictures are attached.
- Enhancer: an alias of `gemini-omni-video`, as 1.1 is (the same prompt grammar).
