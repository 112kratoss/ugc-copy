# Kling 4.0 — verified provider evidence (2026-11-05)

Captured on 2026-11-05 from `https://docs.kie.ai/market/kling/v4-reference-to-video.md` and
`https://docs.kie.ai/market/kling/v4-keyframe-to-video.md` (OpenAPI bodies) and the market page
`https://kie.ai/kling-4-0` (`pricingDesc`). Raw copies:
`UGC copy/archive/kie-models-2026-11-05/evidence/`. The listing's `<lastmod>` is 2026-10-22; the
"Coming Soon" text on the page belongs to its Kling 4.0 Flash card, not to Kling 4.0.

## Provider ids

| Shape | `model` enum | `required` |
| --- | --- | --- |
| Text, reference pictures (and clips, elements, voices) | `kling-4.0/reference-to-video` | `prompt` |
| Keyframes: first, middle, last | `kling-4.0/keyframe-to-video` | `prompt` |

There is no text-to-video id: a probe of `kling-4.0/text-to-video` answered 422 "The model name
you specified is not supported". The reference endpoint says "All four material types are
optional. When none are provided, the request behaves as plain text-to-video", so a text run goes
there. Zero-cost probes of both real ids (`input: {}`) answered "This field is required": live, no
task created.

## Inputs

### `kling-4.0/reference-to-video` (`additionalProperties: false`)

- `prompt` — `minLength: 1`, `maxLength: 8000` (:160-187). Mentions: `@image_1`, `@image_2`, …
  name `image_urls` in order; `@video_N` names `video_urls`; `@name` names an element or voice.
  "Every `@` mention must match an asset included in this request, otherwise the request is
  rejected" — "Referencing an undeclared material returns a parameter error and the task is not
  created."
- `duration` — integer 3–30, default 5 (:188-195).
- `resolution` — `720p`, `1080p`, default `720p` (:196-202).
- `aspect_ratio` — `auto`, `16:9`, `9:16`, `1:1`, `21:9`; omitted: `auto` with materials, `16:9`
  without (:203-219).
- `image_urls` — up to 10; "Each side must be 300–65536 pixels; aspect ratio 0.40–2.5"; no file
  size (:220-232).
- `video_urls` — up to 5 clips of 2–30 s (:233-245). Not offered (see the price).
- `keep_original_sound` — only with `video_urls`; "If no reference video is provided, native
  audio is always generated" (:246-253).
- `elements` — up to 7 named subjects of 2–4 pictures or one 3–8 s character clip (:254-344).
  Not offered in this release.
- `voices` — up to 3 named reference voices (:345-413). Not offered.
- `image_urls` + `video_urls` + `elements` + `voices` ≤ 15 items.

### `kling-4.0/keyframe-to-video` (`additionalProperties: false`)

- `prompt` — 1–8,000 characters; mentions `@first_frame`, `@keyframe_N`, `@last_frame`, "only …
  frames that are actually provided" (:115-138).
- `duration`, `resolution` — as above (:139-171). The duration also caps the frames: 3 s → 4 …
  9 s or longer → 10.
- `aspect_ratio` — "Only used when no frame is provided (text-to-video) … If any frame is
  provided, the output follows the first frame's aspect ratio" (:172-184). Not sent.
- `first_frame_url`, `last_frame_url` — one picture each; no file size (:185-191, :204-210).
- `keyframe_urls` — up to 8 middle frames (:192-203). Not offered: the catalog has no slot role
  for a middle frame, and adding one needs an app release.

Neither page states whether a last frame may travel alone; the app asks for a start frame with an
end frame, as it does for Kling 3.0 and most frame-pair models.

## Price (`pricingDesc`, 2026-11-05), credits per second

Reference-to-video:

```
720P: 17 credits/s ($0.085/s, with video) | 28.5 credits/s ($0.1425/s, no video)
1080P: 25.5 credits/s ($0.1275/s, with video) | 42.5 credits/s ($0.2125/s, no video)

- No video input (text, images, image subjects or voices only): rate × output duration
- With video input: rate × (output × 2) when total input duration ≤ output duration; rate × (input + output) when input is longer.
```

Keyframe-to-video:

```
720P: 28.5 credits/s ($0.1425), 1080P: 42.5 credits/s ($0.2125) — billed on the output duration (3–30 s).
```

What ships is the no-video rate on both endpoints: **720p 28.5, 1080p 42.5 per second of
output**. A 5 s 720p run is 143 credits (142.5 rounded up); 30 s at 1080p is 1,275.

The with-video rate is left out with the clips: it bills `rate × (output + max(output, input))`,
and the catalog's `reference-adjustment` strategy can only bill `rate × (output + input)`, which
would undercharge every run whose clips are shorter than its output. Offering clips needs that
strategy to learn the floor first.

No promotional wording; "High-tier top-ups include +10% bonus credits" is about Kie's own
top-ups.

## Shipped (2026-11-05)

App id `kling-4.0`, provider `kling` with a branch of its own, maker Kuaishou. Text; a start frame
and an optional end frame (keyframe endpoint); or up to 10 reference pictures (reference
endpoint), whose @handles are rewritten to `@image_N` in the order the pictures are sent. Every
other `@` in a prompt is refused before anything is held, since Kie rejects an undeclared mention.
No sound toggle: the model always generates audio. Its own enhancer playbook.

## Paid runs (2026-11-05)

The app's bodies at 720p, 3 s, ran once per id; each charged 85.5 credits (`creditsConsumed`,
28.5 × 3, the price above):

- `kling-4.0/reference-to-video`, 16:9, one picture in `image_urls` and a prompt naming it
  `@image_1`: task `98e09ceec5ef49b511381d6e0790dc45`, 81 s, a 1280×720, 3.04 s MP4.
- `kling-4.0/keyframe-to-video`, the same 3:2 picture as first and last frame: task
  `21b4794a9f6eb9274466088b962b95e7`, 197 s, a 1164×772, 3.04 s MP4 (the frames set the ratio).

Both carry an AAC track with no audio field sent (the always-on audio above), from
`tempfile.aiquickdraw.com` (`archive/kie-models-2026-11-05/probe-results.txt`).
