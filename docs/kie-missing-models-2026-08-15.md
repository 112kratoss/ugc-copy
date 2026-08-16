# Kie.ai — complete list of models we are not using (2026-08-15)

Kie exposes **137 media endpoints** across **98 market products** (a product page like `kling-o3`
covers 4 modalities). We integrate **44 endpoints**. **93 are unused.**

Our side: `src/lib/models.ts`, `src/lib/generation-model-runtime.ts`.

## How to read pricing (method that works)

- `https://kie.ai/<slug>` — each market page states its own credit price in plain text. **This is
  the authoritative source**; the OpenAPI specs at docs.kie.ai carry no pricing at all.
- `https://kie.ai/sitemaps/models-0.xml` — all 98 market slugs.
- WebFetch gets **403** (Cloudflare). `curl` with a normal browser User-Agent returns 200.
- Don't search the pricing table by product name — Kling AI Avatar is listed there as
  "Kling AI **Avtar**", and Kling 3.0 Omni is branded "**Kling O3**". Both return zero hits.

## The credit mapping is 1:1 — conversion is a copy/paste

Kie states **"1 credit ≈ $0.005 USD"** on every market page. Every one of our models matches
Kie's credit figure exactly:

| Model | Ours (`models.ts`) | Kie |
| --- | --- | --- |
| `kling-3.0-video` | std 14 / 20, pro 18 / 27 | 720p 14 / 20, 1080p 18 / 27 |
| `kling-3.0-turbo` | 720p 18, 1080p 22.5 | 18 / 22.5 |
| `kling-3.0` motion control | 720p 20, 1080p 27 | 20 / 27 |
| `kling-2.6` motion control | 720p 11, 1080p 18 | 11 / 18 |
| ElevenLabs TTS turbo / multilingual / dialogue | 6 / 12 / 14 | 6 / 12 / 14 |

**Our credit unit *is* Kie's credit unit, at cost.** Adding a model = paste the credit number
into a `pricing` block. No conversion, no markup maths.

Two consequences:

1. **No per-model margin.** All margin lives in the credit pack price, so an expensive model
   doesn't erode a spread — it just burns credits faster.
2. Kie notes **high-tier top-ups carry a +10% bonus**, so our real cost is ~10% below list. That
   is margin we currently get for free and should not accidentally price away.

## Tier A — talking avatars / lip sync (zero coverage, all priced)

The biggest functional gap for a UGC product.

| Kie model id | Credits/sec | USD/sec | Cap |
| --- | --- | --- | --- |
| `infinitalk/from-audio` | **3** @480P, **12** @720P | $0.015 / $0.06 | ≤15 s per generation |
| `kling/ai-avatar-standard` | **8** @720P | $0.04 | ≤15 s per generation |
| `volcengine/video-to-video-lip-sync` | **8** | $0.04 | re-syncs existing video |
| `kling/ai-avatar-pro` | **16** @1080P | $0.08 | ≤15 s per generation |
| `omnihuman-1-5` | **27** | $0.135 | audio <60 s |
| `omnihuman-1-5/subject-detection`, `/human-identification` | — | — | helpers |

✅ **The 15 s vs 5 min question is resolved.** The market page says "up to **15 seconds per
generation**"; the 5-minute figure in the API spec is the *audio upload* limit, not output
length. Any script longer than 15 s needs multiple generations stitched together — that is a real
product constraint, not a pricing detail.

A 15-second avatar clip costs **45 credits** on InfiniteTalk 480P, **120** on Kling Standard, or
**405** on OmniHuman.

## Tier A — direct upgrades to models we already ship

**`bytedance/seedance-2-5`** — supersedes our `seedance-2`. Adds reference video + audio inputs,
30 s duration, `return_last_frame`, mov output.

| Resolution | With video input | No video input |
| --- | --- | --- |
| 480P | **17**/s ($0.085) | **28**/s ($0.140) |
| 720P | **38**/s ($0.190) | **63**/s ($0.315) |

**`kling-3.0-omni/*`** (market: "Kling O3") — beside our `kling-3.0/video`. 4k, multi-shot
(1–6 prompts), up to 7 reference images, 3 named subjects for cross-shot identity, ≤15 s.

| Resolution | No native audio | With native audio | Video-input variants |
| --- | --- | --- | --- |
| 720P | **14**/s ($0.070) | **18**/s ($0.090) | 20/s ($0.100) |
| 1080P | **18**/s ($0.090) | **23**/s ($0.115) | 27/s ($0.135) |
| 4K | **67**/s ($0.335) | **67**/s ($0.335) | 67/s ($0.335) |

Real ids: `kling-3.0-omni/text-to-video`, `/image-to-video`, `/reference-to-video`,
`/transformation`. Note 1080p with audio is **23** here vs **27** on our `kling-3.0-video` — Omni
is cheaper *and* more capable at that tier.

Also incremental:

| Kie model id | Credits | Note |
| --- | --- | --- |
| `wan/2-7-videoedit` | **16**/s @720p, **24**/s @1080p | we ship wan 2.7 text/image/r2v, not edit |
| `ideogram/v3-edit` | — | we ship v3 text-to-image + remix, not edit |
| `happyhorse/video-edit` | — | no 1.1 equivalent exists |
| `grok-imagine/upscale`, `/extend`, `/1-5-preview` | — | post-gen extensions to Grok video |

## Tier A — whole video families absent

**`pixverse/*`** — the cheapest video on the platform, and `transition` (first & last frame) is
something nothing we ship does. Two tiers listed (fast / standard):

| Resolution | No audio | With audio |
| --- | --- | --- |
| 360P | **4.0 – 4.5**/s | 5.6 – 6.3/s |
| 540P | **5.6 – 6.3**/s | 7.2 – 8.1/s |
| 720P | **7.2 – 8.1**/s | 9.6 – 10.8/s |
| 1080P | **14.4 – 16.2**/s | 18.4 – 20.7/s |

Ids: `pixverse/text-to-video`, `/image-to-video`, `/reference-to-video`, `/extend`, `/transition`.

**`minimax-h3/*`** — 768P **16**/s ($0.08), 2K **26**/s ($0.13). First 5 input images free, then
**8** credits/image; input audio free. Ids: `/text-to-video`, `/image-to-video`,
`/reference-to-video`.

## Tier A — post-production utilities (zero coverage, nearly free)

| Kie model id | Credits | USD |
| --- | --- | --- |
| `recraft/crisp-upscale` | **0.5** | $0.0025 |
| `recraft/remove-background` | **1** per image | $0.005 |
| `topaz/video-upscale` | **8**/sec | $0.04 |
| `topaz/image-upscale` | **10** ≤2K, **20** @4K | $0.05 / $0.10 |
| `seedream/5-pro-layer-decomposition` | 1K/1.5K **7**, 2K **14** per image | $0.035 / $0.07 |

Background removal at **1 credit** is the cheapest thing on the platform and solves a recurring
product-on-white need.

## Tier A — image models worth a look

| Kie model id | Credits | USD |
| --- | --- | --- |
| `grok-imagine-image-2-0/text-to-image`, `/image-edit`, `/segment-map` | **4**/image | $0.02 (67% under official) |
| `qwen3/text-to-image`, `/image-to-image` | **4.8**/image (1K & 2K) | $0.024 |
| `qwen3-pro/text-to-image`, `/image-to-image` | **6.4** @1K, **12** @2K | $0.032 / $0.06 |
| `ideogram/character`, `/character-edit`, `/character-remix` | **12** Turbo, **18** Balanced, **24** Quality | $0.06 / $0.09 / $0.12 |
| `flux2/flex-text-to-image`, `/flex-image-to-image` | — | cheaper tier below the `flux-2/pro` we ship |

Input images on Qwen and Seedream cost **0.5 credits each** (first one free on Seedream).

Ideogram Character is the direct answer to cross-shot character continuity.

## Tier A — audio and music (we only do TTS + SFX)

The whole Suno suite is unused. A full backing track for **$0.06** is the standout.

| Suno operation | Credits | USD |
| --- | --- | --- |
| Cover generate / generate persona / MIDI from audio | **0** | free |
| Generate lyrics / boost style / convert to WAV | **0.4** | $0.002 |
| Timestamped lyrics | **0.5** | $0.0025 |
| Create music video | **2** | $0.01 |
| Generate sounds | **2.5** | $0.0125 |
| Replace music section | **5** | $0.025 |
| Vocal separate | **10** | $0.05 |
| **Generate music** / extend / add instrumental / add vocals / mashup / upload-and-cover / upload-and-extend | **12** each | $0.06 |
| Advanced split (stem named) | **20** | $0.10 |
| Multi-stem separation | **50** | $0.25 |

Also unused: `elevenlabs/audio-isolation`, `google/gemini-3-1-flash-tts` and Gemini 2.5 Pro TTS
(both 2800 credits/M output tokens, 140/M input), `gemini-omni-audio`, `gemini-omni-character`.

## On deck — announced but not yet callable

| Slug | Status |
| --- | --- |
| `wan-3-0` | "Coming Soon — not yet available". Omni-reference video generation. Would supersede the wan 2.7 we ship. |
| `flux-3` | "Upcoming Flux 3 API" — one multimodal foundation for image, video, audio, action. |

Neither has pricing or an API yet. Worth watching; nothing to build against.

## Tier B — superseded, skip (44 endpoints)

Older versions of what we already run. Listed so nobody re-audits them.

- **Seedance v1**: `bytedance/v1-lite-image-to-video`, `v1-lite-text-to-video`, `v1-pro-image-to-video`, `v1-pro-text-to-video`, `v1-pro-fast-image-to-video`
- **Kling legacy**: `kling/image-to-video`, `kling/text-to-video`, `kling/v2-1-master-image-to-video`, `v2-1-master-text-to-video`, `v2-1-pro`, `v2-1-standard`, `v25-turbo-image-to-video-pro`, `v25-turbo-text-to-video-pro`
- **Wan legacy**: `wan/2-2-a14b-{image-to-video,text-to-video,speech-to-video}-turbo`, `2-2-animate-move`, `2-2-animate-replace`, `2-5-{image,text}-to-video`, `2-6-{image-to-video,text-to-video,video-to-video}`, `2-6-flash-{image-to-video,video-to-video}`
- **Hailuo legacy**: `hailuo/02-{image,text}-to-video-{pro,standard}`
- **HappyHorse unversioned**: `happyhorse/{text-to-video,image-to-video,reference-to-video}` (but `/video-edit` is a real gap — Tier A)
- **Seedream legacy**: `seedream/4-5-edit`, `4-5-text-to-image`, `seedream/seedream`, `seedream-v4-edit`, `seedream-v4-text-to-image`
- **Nano Banana v1**: `google/nano-banana`, `google/nano-banana-edit`
- **GPT Image 1.5**: `gpt-image/1-5-text-to-image`, `1-5-image-to-image`
- **Qwen legacy**: `qwen/{text-to-image,image-to-image,image-edit}`, `qwen2/{text-to-image,image-edit}`

## The one trap when wiring these up

**The docs path is not the model id.**

| Docs path | Actual `model` value |
| --- | --- |
| `market/kling/v3-omni-reference-to-video.md` | `kling-3.0-omni/reference-to-video` |
| `market/omnihuman-1-5.md` | `omnihuman-1-5` (no vendor prefix) |
| `market/flux2/flex-text-to-image.md` | `flux-2/…` prefix in practice |

Read the `model` field out of the spec body, or off the market page heading. Same class of bug as
the `wan-2.7` → `wan/2-7-…` fix at `src/lib/generation-model-runtime.ts:112`.

## Suggested order

1. **`recraft/remove-background`** — 1 credit, one endpoint, no new taxonomy, immediately useful.
2. **`infinitalk/from-audio`** — 3 credits/sec, cheapest way to test whether avatar UGC lands.
3. **`bytedance/seedance-2-5`** — drop-in upgrade from `seedance-2`, prices known.
4. **Suno `generate-music`** — $0.06 a track, obvious fit, no model we can substitute.
5. **`kling-3.0-omni/*`** — cheaper than our current Kling 3.0 at 1080p *and* adds multi-shot.
6. **`pixverse/*`** — if cost per clip ever becomes the constraint, 360P at 4 credits/sec is 5×
   cheaper than anything we currently offer.
