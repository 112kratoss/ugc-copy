# Kie.ai — models we can configure next (2026-09-11)

A pass over everything Kie has listed since the 2026-08-15 inventory
(`docs/audits/kie-missing-models-2026-08-15.md`), checked against our catalog on the release
production runs (`reference-audit-20260904`, 36 models). Kie's sitemap now carries **104
market slugs** (98 on 2026-08-15).

## Method

- `https://kie.ai/sitemaps/models-0.xml` — every market slug, and its `<lastmod>` is the listing
  date, so sorting on it answers "what is new".
- `https://kie.ai/<slug>` — the market page, read with a browser User-Agent (Cloudflare 403s
  anything else). Prices attributed per `docs/model-api-references/README.md` rule 9: each
  `pricingDesc` belongs to the `model` that follows it.
- `https://docs.kie.ai/market/<path>.md` — OpenAPI bodies for the `model` enum and inputs.
- `https://kie.ai/pricing` renders client-side, so `curl` gets no rows; a browser shows the table
  sorted newest-first. Its USD column carries typos — trust the credits column.

## Ready to configure — fits the image and video pipelines as they are

| Model (listed) | Provider ids | Credits | Against what we ship |
| --- | --- | --- | --- |
| **GPT Image 2.5** Flare / Sunburst (09-09) | `gpt-image-2-5-{flare,sunburst}-{text-to-image,image-to-image}` | 6 / 10 / 16 per image at 1K / 2K / 4K, both tiers | Same price as GPT Image 2. Adds `background` (transparent / opaque / auto). No 5:4 or 4:5; adds 27:16, 16:27, 9:8, 8:9 at 1K only. Flare = speed and volume, Sunburst = premium polish. **Onboarding started 2026-09-11.** |
| **Gemini Omni 1.1 Flash** (08-28) | `google/gemini-omni-flash-1-1` | 63 / 84 / 105 / 126 for 4 / 6 / 8 / 10 s; 147–210 at 4K; 168 / 252 with a video input | Identical table to `gemini-omni-video`; adds 360p and first / last frame. |
| **Wan 3.0 Video** (08-24) | `wan/3-0-video` | 8 / 16 / 32 per s (480p / 720p / 1080p) | Wan 2.7 is 16 / 24. One id for text, first / last frame, and references (≤10 images, ≤5 video, ≤5 audio clips); 2–30 s; audio on by default. |
| **Wan 3.0 Video Prime** (08-24) | `wan/3-0-video-prime` | 12.2 / 25.2 / 50.4 per s | Same schema as Wan 3.0 (diffed); Kie's high-speed variant. |
| **Grok Imagine Video 1.5 Preview** (06-01) | `grok-imagine-video-1-5-preview` | 2.4 / 4.5 per s (480p / 720p) | Same rate as `grok-imagine-video`; ≤7 reference images, 1–15 s, no normal / fun mode. |
| **PixVerse V6** (07-21) | `pixverse-v6/{text-to-video,image-to-video,transition,reference-to-video}` | 4.0–14.4 per s (360p–1080p), 5.6–18.4 with audio; reference mode 12.5 % more | New family; `@ref_name` subjects in reference mode. |

### Catches to handle while configuring

- **Wan 3.0** bills (input video seconds + output seconds). The `reference-adjustment` pricing
  strategy minimax-h3 uses already models this. `duration: -1` (model-chosen length) cannot be
  quoted up front and must be refused.
- **Grok 1.5**: the spec accepts 1080p but no 1080p price is published — expose 480p / 720p only.
- **Gemini Omni 1.1 Flash**: `audio_ids` and `character_ids` come from the `gemini-omni-audio` and
  `gemini-omni-character` helper endpoints, which carry no published price. Leave both inputs off.
- **PixVerse V6's 2026-08-15 exclusion** (`docs/model-api-references/dropin-models-2026-08-15.md`) is
  resolved on both counts. The "conflicting tiers" were per-mode prices — the 4.5 / 16.2 block sits
  inside the `reference-to-video` object on the market page — and PixVerse now appears on
  kie.ai/pricing. `extend` needs a prior video, so leave it out.

## Available, but each needs a product surface rather than a catalog entry

| Model | Provider id | Credits | Needs |
| --- | --- | --- | --- |
| OmniHuman 1.5 (06-15) | `omnihuman-1-5` | 27 per s | Image + audio input, audio < 60 s — the avatar taxonomy decision in `docs/audits/kie-model-catalog-audit-2026-08-15.md` |
| Volcengine lip sync (06-15) | `volcengine/video-to-video-lip-sync` | 8 per s | Video + audio input |
| Gemini 3.1 Flash TTS / 2.5 Pro TTS (07-17) | `google/gemini-3-1-flash-tts`, `google/gemini-2-5-pro-tts` | 140 input / 2,800 audio-output per 1M tokens | Token billing; our ElevenLabs voices bill per character |

## Not live yet

- **Flux 3** — the page says "Upcoming"; no model ids.
- **Wan Animate 2** — "Coming Soon"; no model ids.

## Prompt enhancer

`src/lib/prompt-enhancer.ts` runs on Gemini 3.6 Flash. **Gemini 3.8 Flash** (09-03) costs the same
(45 input / 225 output credits per 1M tokens, 50 % off until 2026-12-31) at the same
`/gemini-3-8-flash-openai/v1/chat/completions` shape, so the swap is the two constants plus an
`npm run eval:enhancer` pass. GPT-6 Astra and the other chat listings are not media models.

## The catalog payload budget is nearly spent

Scaling finding S8 holds the public catalog (`/api/generation-models`, schema v3) to 57,344 decoded
bytes (`config/performance-budgets.json`, enforced locally in
`generation-model-catalog-route-adapter-service.test.ts`). Each image model adds about 1.4 KB.
With both GPT Image 2.5 tiers, the projection production serves measures **56,537 bytes** — 807
to spare — so the next model after this one will fail the gate. Before adding it, either trim
the projection (S8's first two options) or deliberately re-measure the budget (its third), and
record which.

## Suggested order

1. GPT Image 2.5 — same price as GPT Image 2, fits the `kie-task-v1` image adapter.
2. Gemini Omni 1.1 Flash — same price table, new frame controls.
3. Grok Imagine Video 1.5 at 480p / 720p — same rate.
4. Wan 3.0 / Prime — needs the `duration: -1` refusal; billing already exists.
5. PixVerse V6 — new family.

Every price here was read on 2026-09-11. Kie reprices without notice (README rule 10), so
re-read the market page on the day each release is cut.
