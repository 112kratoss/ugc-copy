# Vidu Q4 — verified provider evidence (2026-11-05)

Captured on 2026-11-05 from `https://docs.kie.ai/market/vidu-q4/image-to-video.md` and
`https://docs.kie.ai/market/vidu-q4/reference-to-video.md` (OpenAPI bodies) and the market page
`https://kie.ai/vidu-q4` (`pricingDesc`, attributed by README rule 9). Raw copies:
`UGC copy/archive/kie-models-2026-11-05/evidence/`. Listed by Kie on 2026-10-12. Vidu is made by
ShengShu Technology, a maker the app has not named before.

## Provider ids — no text-only run

| Shape | `model` enum | `required` |
| --- | --- | --- |
| Start frame | `vidu-q4/image-to-video` | `image_url` |
| Reference pictures | `vidu-q4/reference-to-video` | `prompt`, `reference_image_urls` |

There is no text-to-video endpoint: every run needs a start frame or at least one reference
picture. Zero-cost probes on 2026-11-05 (`input: {}`) answered "This field is required" for both
ids: live, no task created.

## Inputs (both `additionalProperties: false`)

Shared:

- `prompt` — up to 20,000 characters; optional on image-to-video, `minLength: 1` on
  reference-to-video (i2v :81-86, r2v :81-88). Above the app's shared 10,000.
- `duration` — integer 3–16, default 5 (i2v :87-92, r2v :89-94).
- `resolution` — `540p`, `720p`, `1080p`, `2k`, `4k`, default `720p` (i2v :93-102, r2v :95-104).
- `audio` — boolean, default **true**: "Generate synchronized audio (dialogue and sound effects).
  Set false for a silent video" (i2v :103-108, r2v :105-110). The app sends the sound toggle,
  off by default as on every model.

Image-to-video:

- `image_url` — the first frame, "JPG, JPEG, PNG or WEBP, up to 50 MB. The video inherits this
  image's aspect ratio" (:109-116). No ratio field.

Reference-to-video:

- `reference_image_urls` — 1–15 (:111-120); no file size. The prompt names them by order ("the
  man in reference image 2").
- `reference_audio_urls` — up to 3, "MP3 only, each 3-12 seconds" (:121-129). Not offered: the
  app converts a refused track to WAV, which this field refuses too.
- `aspect_ratio` — `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, default `16:9` (:130-139).

## Price (`pricingDesc`, 2026-11-05), credits per second

One block for each endpoint, identical:

```
540p: 7.2 credits/s ($0.036/s) | 720p: 15.2 credits/s ($0.076/s) | 1080p: 19.2 credits/s ($0.096/s) | 2K: 30.4 credits/s ($0.152/s) | 4K: 62.4 credits/s ($0.312/s) — 20% below official pricing.
```

| Resolution | Credits per second |
| --- | --- |
| 540p | 7.2 |
| 720p | 15.2 |
| 1080p | 19.2 |
| 2k | 30.4 |
| 4k | 62.4 |

Audio does not change the price. "20% below official pricing" is Kie's standing rate against
Vidu's own API (the wording of the Wan 3.0 page), not a dated offer.

## Shipped (2026-11-05)

App id `vidu-q4`, provider `vidu`, maker ShengShu (new in `ai-data-recipients.ts`, named "on the
web" in the privacy policy). **Web only** in this release: the installed apps' AI-data question
does not name ShengShu, so the descriptor publishes `availability.mobile: false` until an app
update that names it (and raises `AI_DATA_CONSENT_VERSION`) is in people's hands, as PixVerse V6
went in October. A start frame (required in Frames) or 1–15 reference pictures; aspect ratio
sent only with references. Its own enhancer playbook.

## Paid runs (2026-11-05)

The app's bodies at 540p, 3 s, ran once per id; each charged 21.6 credits (`creditsConsumed`,
7.2 × 3, the price above, with audio or without):

- `vidu-q4/image-to-video`, a 3:2 picture as `image_url`, `audio: true`: task
  `c318e4908c52e5b1132b0b9c8cecd17f`, 101 s, an 884×586, 3.04 s MP4 with an AAC track.
- `vidu-q4/reference-to-video`, 16:9, one picture in `reference_image_urls`, `audio: false`, and
  the legend prompt the app sends (`compilePromptWithElements`, so it carries `@scene` and the
  word "@handle"): task `cdceddcdbfd5cd25af3ac276abaaebb7`, 147 s, a 960×528, 3.04 s MP4 with no
  audio track. Vidu accepted it: an `@` that names nothing is not refused, as it is by Kling 4.0.

Both from `tempfile.aiquickdraw.com` (`archive/kie-models-2026-11-05/probe-results.txt`).
