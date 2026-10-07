# Kie.ai — models we can configure next (2026-10-07)

A pass over everything Kie has listed since the 2026-09-11 scan
(`kie-new-models-2026-09-11.md`), checked against our catalog on the release production runs
(`gpt-image-2-5-20260911`: 18 image, 15 video and 2 motion models on both platforms). Kie's
sitemap now carries **113 market slugs** (104 on 2026-09-11).

## Method

As on 2026-09-11: the sitemap's `<lastmod>` sorted for "what is new", each market page read with
a browser User-Agent (`scripts/ops/kie-evidence.mjs price <slug>`), and the OpenAPI bodies at
`docs.kie.ai/market/<path>.md` for the `model` enum and the inputs. Each price was read on
2026-10-07 and again on 2026-10-08 from the market page's own `pricingDesc`.

## New since 2026-09-11, live and priced — shipped by release `seedream-5-flash-qwen-2-1-20261008`

| Model (listed) | Provider ids | Credits | Notes |
| --- | --- | --- | --- |
| **Seedream 5.0 Flash** (09-29) | `seedream/5-flash-text-to-image`, `seedream/5-flash-image-to-image` | 3.24 per image at 1K, 1.5K and 2K | `docs/model-api-references/seedream-5-flash.md`. A third endpoint, layer decomposition, is a different product. |
| **Qwen Image 2.1** (09-21) | `qwen2-1/text-to-image`, `qwen2-1/image-to-image` | 4 at 1K, 8 at 2K | `docs/model-api-references/qwen-image-2-1.md`. `background`, `seed` and `mask_url` are not sent. |

## New since 2026-09-11, not live

- **Kling 4.0** and **Kling 4.0 Flash** (09-29, 09-30): "Coming Soon", no price, no docs page.
- **Wan Animate 2** (08-12): still "Coming Soon". **Flux 3** (07-24): still "Upcoming".
- Chat and TTS listings (GPT-6 Sol, Claude Opus 5.5 and Sonnet 5.5, Grok 4.7, DeepSeek V4.1 Flash,
  Kimi K3, Gemini 3.8 Flash TTS and Flash-Lite TTS) are not media models.

## Still ready from the 2026-09-11 scan, prices unchanged on 2026-10-07

Gemini Omni 1.1 Flash (63/84/105/126 credits for 4/6/8/10 s; 147–210 at 4K), Wan 3.0 Video
(8/16/32 per s) and Video Prime (12.2/25.2/50.4 per s), Grok Imagine Video 1.5 Preview (2.4/4.5
per s at 480p/720p), PixVerse V6 (4.0–18.4 per s by resolution and audio; reference mode 12.5 %
more). Each is a video model with its own request body, so each is its own release; the catches
listed on 2026-09-11 still apply (Wan 3.0's `duration: -1`, Grok 1.5's unpriced 1080p, Omni's
unpriced helper endpoints, PixVerse's `extend`).

## Also found on the way

Kling O3's Input mode control names frames and references only beside its `subjects` mode, so
the quote refused every subjects run until `modeGatedSettingValues` (PR #405). Its production row
does carry `maxNamed: 3` on the subjects slot (the release diff reports it unchanged), but the
server's re-parse of stored descriptors (`generation-model-descriptor-parser.ts`) rebuilt slots
without that key, so `/api/model-catalog/v1/details` served the slot without it and both creators
fell back to the slot's 12. The parser keeps `maxNamed` from this release's code on; no catalog
change is needed for it.
