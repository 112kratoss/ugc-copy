# PixVerse V6 Max — verified provider evidence (2026-11-05)

Captured on 2026-11-05 from `https://docs.kie.ai/market/pixverse/v6-max-text-to-video.md` and
`https://docs.kie.ai/market/pixverse/v6-max-image-to-video.md` (OpenAPI bodies) and the market
page `https://kie.ai/pixverse-v6-max` (`pricingDesc`, attributed by README rule 9). Raw copies:
`UGC copy/archive/kie-models-2026-11-05/evidence/`. Listed by Kie on 2026-10-23.

## Provider ids — two shapes only

| Shape | `model` enum | `required` |
| --- | --- | --- |
| Text | `pixverse-v6-max/text-to-video` | `prompt`, `aspect_ratio`, `quality`, `duration` |
| Start frame | `pixverse-v6-max/image-to-video` | `prompt`, `image_urls`, `quality`, `duration` |

Max has no transition (frame pair), reference-to-video or extend endpoint, unlike PixVerse V6
(`pixverse-v6.md`). Zero-cost probes on 2026-11-05 (`input: {}`) answered "This field is
required" for both ids: live, no task created.

## Inputs — PixVerse V6's text and image bodies

A diff against `pixverse/text-to-video.md` (re-captured the same day) finds the same fields,
enums and ranges, except that Max drops `generate_multi_clip_switch` and lowers the prompt's
minimum from 3 to 1.

- `prompt` — `minLength: 1`, `maxLength: 5000` (text :113-124, image :115-127).
- `aspect_ratio` (text only) — `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `2:3`, `3:2`, `21:9`; "Do not
  send it for image-to-video" (text :125-166).
- `image_urls` (start frame) — exactly 1 URL; "Each side must be ≤ 10,000 px and the file size
  must be ≤ 20 MB. The output aspect ratio follows this image; do not send `aspect_ratio`"
  (image :128-143).
- `quality` — `360p`, `540p`, `720p`, `1080p`.
- `duration` — integer 1–15 s.
- `generate_audio_switch` — boolean, default false: native audio synchronized with the video.
- `seed` — not sent.

## Price (`pricingDesc`, 2026-11-05), credits per second

One block for each endpoint, identical:

```
360P: 4.8 credits/s ($0.024/s, no audio) | 7.2 credits/s ($0.036/s, with audio)
540P: 7.2 credits/s ($0.036/s, no audio) | 8.8 credits/s ($0.044/s, with audio)
720P: 8.8 credits/s ($0.044/s, no audio) | 12.0 credits/s ($0.060/s, with audio)
1080P: 17.6 credits/s ($0.088/s, no audio) | 22.4 credits/s ($0.112/s, with audio)

Approximately 10% cheaper than official pricing.
```

| Resolution | No audio | With audio |
| --- | --- | --- |
| 360p | 4.8 | 7.2 |
| 540p | 7.2 | 8.8 |
| 720p | 8.8 | 12.0 |
| 1080p | 17.6 | 22.4 |

"Cheaper than official pricing" is Kie's standing rate against PixVerse's own API, the wording
PixVerse V6's page carries at 20 %; there is no dated offer.

## Shipped (2026-11-05)

App id `pixverse-v6-max`, provider `pixverse` (the PixVerse branch picks the Max ids), maker
PixVerse (already named in both the policy and the app's AI-data question), text or one start
frame, the sound toggle, Enhance aliased to `pixverse-v6`.
