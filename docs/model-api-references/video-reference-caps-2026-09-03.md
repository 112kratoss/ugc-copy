# Seedance 2.5 and MiniMax H3 — re-verified provider evidence (2026-09-03)

> **Update 2026-09-04:** the Seedance 2.5 1080p offer quoted below was extended from Sep 17 to Oct 17, 2026 06:00 UTC; the pinned undiscounted 159 / 96 is unaffected. See `reference-audit-2026-09-04.md`.

Read from `https://docs.kie.ai/market/bytedance/seedance-2-5.md`,
`https://docs.kie.ai/market/minimax-h3/reference-to-video.md` and the `pricingDesc` field
embedded in the `https://kie.ai/<slug>` market pages. Method: `curl` with a browser
User-Agent — WebFetch gets 403 from Cloudflare. Credits are Kie credits 1:1
(1 credit = $0.005).

This supersedes the seedance-2-5 and minimax-h3 sections of
`dropin-models-2026-08-15.md`, which understated every reference cap and predated the
1080p tier. Shipped as catalog release
`config/generation-model-catalog/releases/2026-09-03-video-reference-caps.json`.

**Note the docs path.** Seedance 2.5 lives at `market/bytedance/seedance-2-5`, not
`market/seedance-2-5` — the flat path 404s.

## `seedance-2-5` → `bytedance/seedance-2-5`

Single endpoint; no per-scenario variants.

| Field | Schema | Was in our catalog |
| --- | --- | --- |
| `resolution` | `480p`, `720p`, **`1080p`** (default `720p`) | 480p, 720p |
| `reference_image_urls` | maxItems **30** | 5 |
| `reference_video_urls` | maxItems **10** | 3 |
| `reference_audio_urls` | maxItems **10** | 3 |
| `output_format` | `mp4` \| `mov` (default `mp4`) | not exposed |
| `web_search` | boolean | not exposed (payload pins `false`) |
| `duration` | 4–30, default 5; `-1` = auto | 4–30 ✓ |
| `aspect_ratio` | `1:1`,`4:3`,`3:4`,`16:9`,`9:16`,`21:9`,`adaptive` | ✓ (no `adaptive`) |

Also present: `first_frame_url`, `last_frame_url`, `return_last_frame`, `generate_audio`,
`nsfw_checker`.

**More slots is not more footage.** `reference_video_urls` carries, quoted from the spec:
"Single video duration: [2, 30] seconds; Mutually exclusive with the first/last-frame
scenario; Total duration of reference videos must not exceed 30 seconds." The 30s combined
ceiling is enforced independently of the 10-file cap, so the catalog keeps its
`combined-duration` constraint at 30 unchanged.

**Mutual exclusion**, from the endpoint description: "Image-to-Video (First Frame),
Image-to-Video (First & Last Frames), and Multimodal Reference-to-Video (including
reference images, videos, and audio) are three mutually exclusive scenarios and cannot be
used simultaneously." Our frames/elements `referenceMode` split already models this.

### Pricing — the 1080p tier is discounted, quoted verbatim

```
480P: 17 credits/s ($0.085/s, with video) | 28 credits/s ($0.140/s, no video)
720P: 38 credits/s ($0.190/s, with video) | 63 credits/s ($0.315/s, no video)
1080P: 68.5 credits/s ($0.3425/s, with video) | 114 credits/s ($0.570/s, no video)

💰 Limited-Time 1080P Offer: 28% OFF until Sep 17, 2026 06:00 UTC (prices above already
reflect the discount)

🔸Note🔸: "With video input" has a lower unit price due to a different calculation method:
No video = Price × Output; With video = Price × (Input + Output)
```

480p and 720p carry no offer and match what we already ship — unchanged.

**We pin the undiscounted 1080p rate**: 114 / 0.72 = 158.33 → **159** no-reference, and
68.5 / 0.72 = 95.14 → **96** with-reference, rounded up. Pinning 114/68.5 would under-bill
the tier from Sep 17 onward, and a catalog release is not something that reprices itself on
a date. This mirrors `minimax-h3`, where we already pin the official rate through a
standing Kie discount (below). If the promotional rate is ever the right one to bill, that
should be a deliberate release, not drift.

### Marketing copy contradicts the schema

`kie.ai/seedance-2-5` advertises "up to 50 multimodal references" and "native 4K output".
The OpenAPI schema says `maxItems: 30` and caps `resolution` at `1080p`. Build against the
schema.

## `minimax-h3` → `/text-to-video` · `/image-to-video` · `/reference-to-video`

Caps below are from the **reference-to-video** spec; the text and image variants carry no
reference arrays.

| Field | Schema | Was in our catalog |
| --- | --- | --- |
| `reference_image_urls` | maxItems **9** | 5 |
| `reference_video_urls` | maxItems **3**, single 2–15s, **total ≤ 15s** | 1 |
| `reference_audio_urls` | maxItems **3**, single 2–15s, total ≤ 15s | 1 |
| `resolution` | `768P`, `2K` (default `2K` on this endpoint) | ✓ (we default 768P) |
| `duration` | 4–15, default 6 | ✓ |

**Reference audio cannot stand alone.** The input schema declares:

```yaml
allOf:
  - anyOf:
      - required: [reference_image_urls]
      - required: [reference_video_urls]
```

and the `reference_audio_urls` description spells it out: "reference_audio cannot be used
alone, it must be accompanied by reference_image or reference_video". Audio alone still
routes to `reference-to-video` (see the minimax branch in `generation-services.ts`), so the
catalog now carries a `forbidden-combination` rule that rejects it at quote time, before
any credit is deducted. Note the machine-readable `anyOf` is the stronger statement: an
image *or* a video is required regardless of whether audio is attached.

Note also that raising the video cap from 1 to 3 does **not** widen billing exposure: the
15s total applies either way. It does make the total reachable, which is why the release
adds a `combined-duration` constraint at 15 and flips the slot's `durationMetadata` to
`required` — the manifest validator refuses a duration ceiling that a silent client could
sum to zero and walk past.

### Pricing — Kie is currently running a 50% discount, quoted verbatim

```
Video generation & video input — 768P: 8 credits/s ($0.04/s); 2K: 13 credits/s ($0.065/s).
Video input is charged at the corresponding resolution rate. Additional image input:
4 credits/image ($0.02/image) for both 768P and 2K.

Total Cost = Unit Price × (Generated Video Duration + Input Video Duration) +
Additional Image Cost
 - Input images: The first 5 images are free; additional images are charged separately.
 - Input audio: Free.

Pricing is 50% of the official price. High-tier top-ups reduce the effective cost to
approximately 90% of the listed price.
```

We ship 768P **16** and 2K **26** — exactly double the discounted figures, i.e. the
official rate. Left unchanged: this is the same posture the release takes on Seedance
1080p.

Two costs we do not model, both unchanged by this release and both comfortably inside that
2× margin:

- **Input video seconds.** Kie bills `Unit Price × (output + input)`; our `per-second`
  strategy bills output only. Worst case at 2K is 15s of input, and the 15s total cap means
  raising the file count from 1 to 3 does not increase it.
- **Images beyond the first five**, at 4 credits each. Raising the cap 5 → 9 adds at most
  16 credits of unbilled cost per run.

If Kie's 50% offer ever lapses, both become live concerns and minimax-h3 should move to the
`reference-adjustment` pricing strategy that Seedance already uses.
