# Kie.ai — new models since 2026-11-05 (2026-11-14)

A pass over Kie's market (`kie.ai/market`, 128 listings on 7 pages, read in the browser) against
production's release `kie-models-20261105` (50 entries, 46 served). The listings since the last
scan (`kie-new-models-2026-11-05.md`) were read from the page's `createTime`.

## Method

Each market page's `pricingDesc`, attributed by README rule 9; the OpenAPI bodies at
`docs.kie.ai/market/<path>.md`, whose paths came from `docs.kie.ai/llms.txt`; and a zero-cost
`input: {}` probe of every id shipped (all answered "This field is required"; a made-up id
answered 422; the Kie balance stayed at 2375.9). Raw copies:
`UGC copy/archive/kie-models-2026-11-14/evidence/`.

## Shipped by release `kie-models-20261114`

| Model (listed) | App id | Provider ids | Credits | Evidence |
| --- | --- | --- | --- | --- |
| **Seedream 5.5** (11-10) | `seedream-5.5` | `seedream/5-5-{text,image}-to-image` | 3.6 / 6.3 at 1K / 2K, + 1.44 per input picture | `seedream-5-5.md` |
| **GPT Image 2.6** (11-05) | `gpt-image-2.6` | `gpt-image-2-6/economy-{text,image}-to-image` | 5 a 1K picture | `gpt-image-2-6.md` |
| **Kling 4.0 Flash** (listed 09-29, priced by 11-14) | `kling-4.0-flash` | `kling-4.0/flash-{reference,keyframe}-to-video` | 17 per second, 720p | `kling-4-0-flash.md` |
| **Gemini Omni 1.2 Flash** (11-06) | `gemini-omni-1.2-flash` | `google/gemini-omni-flash-1-2` | 4 / 9 / 10 / 22 per second, 360p–4K | `gemini-omni-1-2-flash.md` |

No paid run yet: each evidence file says what the release leaves out and why.

- **GPT Image 2.6 Flare and Sunburst**: billed per token (prompt, input pictures, output), so no
  price can be quoted before a run. Only the Economy endpoints, at a flat 5 credits, ship.
- **Kling 4.0 Flash**: reference clips and video elements, for Kling 4.0's reason (a clip run
  bills `rate × (output + max(output, input))`).
- **Gemini Omni 1.2 Flash**: the video edit (billed by the input clip's length, with no output
  duration), `character_ids`, and the `-extend` endpoint.

## Listed, not shipped

- **MiniMax H3 Image** (11-10): `minimax-h3/text-to-image`, `minimax-h3/image-edit`; 1.8 credits
  up to 2K, 5.5 at 4K, plus 0.5 a reference. A new image model, not an upgrade; not scoped here.
- **Kie Image Upscaler** (11-10, `kie/image-upscale`) and **Video Upscaler** (11-09,
  `video/upscale`): utilities, which the creators have no surface for.
- **OmniHuman 2.0**: left out at the owner's word on 2026-11-05 (needs an audio input).
- **Wan Animate 2** and **Claude Fable 5.2**: still "Coming Soon".
- Chat, speech and transcription listings (Gemini 4 Hydrogen and Carbon, Kimi K3.1 Pro, GPT 6.1
  Terra, Nemotron 3.5 Transcribe) are not media models.
