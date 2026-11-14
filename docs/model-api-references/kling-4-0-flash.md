# Kling 4.0 Flash — verified provider evidence (2026-11-14)

Captured on 2026-11-14 from `https://docs.kie.ai/market/kling/v4-flash-keyframe-to-video.md` and
`.../v4-flash-reference-to-video.md` (OpenAPI bodies) and the market page
`https://kie.ai/kling-4-0-flash` (`pricingDesc`). Raw copies:
`UGC copy/archive/kie-models-2026-11-14/evidence/`. Listed since 2026-09-29 as "Coming Soon"; the
2026-11-05 scan still found no price, and on 2026-11-14 both endpoints are priced and documented.

## Provider ids

| Shape | `model` enum | `required` |
| --- | --- | --- |
| Text, reference pictures (and clips, elements) | `kling-4.0/flash-reference-to-video` | `prompt` |
| A first frame | `kling-4.0/flash-keyframe-to-video` | `prompt` |

The vendor segment is Kling 4.0's (`kling-4.0/`), with the tier in the endpoint. Both empty-input
probes answered "This field is required" with no task
(`archive/kie-models-2026-11-14/probe-results.txt`).

## Inputs — Kling 4.0's schema with less in it

Diffed against the 2026-11-05 captures of `kling/v4-*-to-video.md` (`kling-4-0.md`):

- `prompt` — 1–8,000 characters, both endpoints (keyframe :119-139, reference :166-192). The same
  mention grammar: `@image_N` for `image_urls` in order, `@first_frame`, `@name` for an element.
- `duration` — integer **3–20**, default 5 (keyframe :140-147, reference :193-200). Kling 4.0
  reaches 30.
- `resolution` — **`720p` only** (keyframe :148-155, reference :201-208). Kling 4.0 adds `1080p`.
- `aspect_ratio` — reference: `auto`, `16:9`, `9:16`, `1:1`, `21:9` (:209-225); keyframe: `16:9`,
  `9:16`, `1:1`, `21:9`, "only used when no first frame is sent" (:156-168).
- `first_frame_url` — keyframe only (:169-). **No `last_frame_url` and no `keyframe_urls`**: the
  listing says "Middle frames (`keyframes`) and a last frame are not supported".
- `image_urls` — reference only, up to 10 (:226-237); no file size is documented, as for Kling 4.0.
- `video_urls` (up to 5), `keep_original_sound`, `elements` (up to 7) — reference only
  (:238-414). No standalone `voices` field; "bind character audio on the element's `voice_url`".
  "If no reference video is provided, native audio is always generated" (:254-261).

## Price (`pricingDesc`, 2026-11-14)

Reference-to-video (the block before `kling-4.0/flash-keyframe-to-video` belongs to it, by the
page's order rule, README rule 9):

```
720P: 11.3 credits/s ($0.0565/s, with video) | 17 credits/s ($0.085/s, no video)
- No video input (Keyframe to Video, or Reference to Video with text, images or image elements only): rate × output duration
- With video input (reference videos or video elements): rate × (output × 2) when total input duration ≤ output duration; rate × (input + output) when input is longer.
```

Keyframe-to-video: "720P: 17 credits/s ($0.085/s) — billed on the output duration (3–20 s)."

What ships is the no-video rate on both endpoints: **17 credits per second of output at 720p**. A
5 s run is 85 credits; 20 s is 340. Clips stay out for Kling 4.0's reason: a clip run bills
`rate × (output + max(output, input))`, which the catalog's `reference-adjustment` pricing cannot
express. No promotional wording.

## Shipped (2026-11-14)

- App id `kling-4.0-flash` ("Kling 4.0 Flash"), provider `kling`, maker Kuaishou. Text; a start
  frame (keyframe endpoint, no end frame); or up to 10 reference pictures (reference endpoint).
  720p, 3–20 s, the four ratios above. No sound toggle: the audio is always generated.
- The start shares Kling 4.0's branch and prompt rewrite (`kling-4-prompt.ts`): each picture's
  @handle is sent as `@image_N`, and any other `@` is refused before the hold.
- Enhancer: an alias of `kling-4.0` — the same prompt grammar and a request schema that only
  drops fields.
