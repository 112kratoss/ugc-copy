# Kie.ai model catalog audit — 2026-08-15

What Kie currently exposes vs. what Magicbooklet wires up, so we can decide what to adopt next.

Sources: `https://docs.kie.ai/llms.txt` (full page index) plus per-model OpenAPI specs under
`https://docs.kie.ai/market/…`. Our side: `src/lib/generation-model-runtime.ts`
(`IMAGE_PROVIDER_MODELS` / `VIDEO_PROVIDER_MODELS`) and `src/lib/models.ts` (`apiModelId`).

## Two traps before anyone codes against this

**1. The docs path is not the model id.** They diverge often enough that deriving one from the
other is how you earn a 422 `The model name you specified is not supported`.

| Docs path | Actual `model` value |
| --- | --- |
| `market/kling/v3-omni-reference-to-video.md` | `kling-3.0-omni/reference-to-video` |
| `market/flux2/flex-text-to-image.md` | `flux-2/…` (our shipped prefix) |
| `market/omnihuman-1-5.md` | `omnihuman-1-5` (no vendor prefix) |

Always read the `model` field out of the spec body. This is the same class of bug as the
`wan-2.7` → `wan/2-7-…` correction already documented at
`src/lib/generation-model-runtime.ts:112`.

**2. The OpenAPI specs carry no pricing.** Pricing lives only on the `kie.ai/<slug>` market
pages. Resolved — see [kie-missing-models-2026-08-15.md](kie-missing-models-2026-08-15.md), which
carries the full priced list and supersedes the gap analysis below. Our credits are Kie credits
1:1 at cost, so adoption is a copy/paste of the credit figure.

## What we ship today

| Class | Count | Kie model ids |
| --- | --- | --- |
| Motion | 2 | `kling-2.6/motion-control`, `kling-3.0/motion-control` |
| Image | 13 app models | nano-banana 2/2-lite/pro, `gpt-image-2-*`, `seedream/5-{pro,lite}-*`, `wan/2-7-image{,-pro}`, `google/imagen4{,-fast,-ultra}`, `ideogram/v3-{text-to-image,remix}`, `flux-2/pro-*`, `z-image`, `grok-imagine/{text-to,image-to}-image` |
| Video | 11 app models | `kling-3.0/video`, `kling/v3-turbo-*`, `bytedance/seedance-1.5-pro`, `bytedance/seedance-2{,-fast,-mini}`, `wan/2-7-{text-to-video,image-to-video,r2v}`, `happyhorse-1-1/*`, `gemini-omni-video`, `hailuo/2-3-image-to-video-{standard,pro}`, `veo3{,_fast,_lite}`, `grok-imagine/{text-to,image-to}-video` |
| Audio | 4 | `elevenlabs/{text-to-speech-turbo-2-5,text-to-speech-multilingual-v2,text-to-dialogue-v3,sound-effect-v2}` |

Coverage of Kie's text→image and text→video families is genuinely good. The gaps are
concentrated in categories we have never entered at all.

## Gap 1 — talking avatars (we have zero coverage)

The single largest category gap, and the one closest to what UGC ads actually are. All of these
take a still image plus an audio track and return a lip-synced performance. Nothing in our
catalog does this — `MOTION_MODELS` is motion *transfer*, not speech.

| Model id | Inputs | Limits (verified) |
| --- | --- | --- |
| `kling/ai-avatar-standard` | `image_url`, `audio_url`, `prompt` | image ≤10 MB jpeg/png; audio ≤100 MB, ≤5 min; prompt ≤5 000 chars |
| `kling/ai-avatar-pro` | same shape | quality tier above standard |
| `omnihuman-1-5` | `image_url`, `audio_url`, optional `mask_url[]`, `prompt` | image ≤10 MB jpeg/png/webp; audio ≤10 MB, **<60 s**; `output_resolution` 720/1080 (default 1080); `pe_fast_mode`; `seed` |
| `infinitalk/from-audio` | audio-driven | not yet spec-checked |
| Volcengine video→video lip sync | existing video + audio | not yet spec-checked |

⚠️ Corrected: the 5-minute figure is Kling's **audio upload** limit, not its output length. The
market page caps every one of these at **15 seconds per generation**. Long-form scripts need
multiple generations stitched together regardless of which model is chosen.

## Gap 2 — direct upgrades to models we already ship

**`bytedance/seedance-2-5`** supersedes the `bytedance/seedance-2` family we ship. Verified
additions over our current integration:

- `reference_video_urls` (≤10) and `reference_audio_urls` (≤10) — we only pass image references
- `duration` 4–30 s, or `-1` for auto (our seedance-2 entry is capped well below 30)
- `return_last_frame` — enables chaining shots without re-uploading a frame
- `output_format` `mp4` | `mov`
- `reference_image_urls` up to 30

**`kling-3.0-omni/{text-to-video,image-to-video,reference-to-video,transformation}`** is a new
family alongside the `kling-3.0/video` we ship. Reference-to-video verified: up to 7 reference
images, **4k** output, `duration` 3–15 s, and two things we have no equivalent for —
`customize_multi_shots` with a `multi_prompt` array of 1–6 shots, and an `elements` array of up
to 3 named subjects (name + description + URLs) for cross-shot character identity.

Also incremental: `wan/2-7` video edit (we ship text/image/r2v but not edit), Grok Imagine video
upscale + extend, HappyHorse video edit, and the Veo 3.1 extend / 1080p / 4k endpoints.

## Gap 3 — whole families absent

- **PixVerse V6** — text-to-video, image-to-video, first & last frame transition, extension, reference-to-video
- **MiniMax H3** — text-to-video, image-to-video, reference-to-video

## Gap 4 — post-production utilities (no coverage)

We generate but never post-process. Each of these is a cheap, deterministic pass:

- `topaz/video-upscale`, Topaz image upscale
- `recraft/remove-background`, Recraft crisp upscale
- `seedream/5-pro-layer-decomposition` — splits a generated image into layers

Background removal in particular is a recurring ask for product-on-white UGC shots.

## Gap 5 — image character consistency

- `ideogram/character`, character edit, character remix — recurring character across shots
- Flux-2 **Flex** tier (`flex-text-to-image` / `flex-image-to-image`) — cheaper than the `pro` tier we ship
- Grok Imagine Image 2.0 — text-to-image, **segment map**, image edit (newer than the `grok-imagine/*` we ship)
- Qwen3 / Qwen3 Pro text-to-image and image-to-image

## Gap 6 — audio beyond TTS

We ship four ElevenLabs endpoints and nothing else. Available and unused:

- The full **Suno** suite: music generation, extend, cover, stems/vocal separation, MIDI, music video, persona and custom voice
- ElevenLabs audio isolation
- Gemini 3.1 Flash TTS, Gemini 2.5 Pro TTS

Music is the obvious one — every UGC ad needs a bed track, and we currently have no way to make one.

## Also available: chat models

Kie fronts GPT 5.2–5.6, Claude (Opus 4.5–5, Sonnet 4.5–5, Haiku 4.5, Fable 5), Gemini 2.5–3.7,
and Grok 4.3–4.6. Relevant only because `src/lib/prompt-enhancer.ts` and
`src/lib/workflow-assistant.ts` already call an LLM — routing them through Kie would consolidate
billing onto one vendor. Worth a look, not urgent.

## Open items before adoption

1. Pull USD pricing for each shortlisted model (not in the specs) and derive credit costs.
2. Decide where avatar models live in the catalog taxonomy — see below.
3. Verify `infinitalk/from-audio` and the Volcengine lip-sync model ids against their spec bodies.

## Decision needed: where avatar models live in the taxonomy

`models.ts` has four families, each keyed by a single input mode:

```ts
MOTION_MODELS      // driving video/image → animated character
IMAGE_MODELS       // text (+ refs) → image
VIDEO_MODELS       // text | image | reference → video
VOICEOVER_MODELS / SOUND_EFFECT_MODELS   // text → audio
```

Avatar models are the first thing that takes **two media inputs of different kinds** — a still
image *and* an audio track — and returns a third kind. Three ways to model it, and the choice
propagates into `IMAGE_PROVIDER_MODELS`/`VIDEO_PROVIDER_MODELS` in
`generation-model-runtime.ts`, the catalog controls in `generation-model-catalog.ts:270`, and the
workflow blueprint model whitelists in `workflow-blueprint.ts:218`:

- **A fifth family, `AVATAR_MODELS`.** Cleanest conceptually; costs a new branch in every
  `switch` over model class, and a new pricing shape (per second of *audio*, not output video).
- **A new input mode inside `VIDEO_MODELS`.** Cheapest to ship — the runtime table already keys
  variants by mode (`text` / `image` / `reference`), so `audio` slots in beside them. But video
  pricing is credits-per-second-of-output and avatar cost tracks the audio length instead.
- **An extension of `MOTION_MODELS`.** Closest in spirit (both animate a character from a still)
  but `characterOrientations: ['video', 'image']` has no room for an audio driver.

<!-- TODO(athul): pick one and sketch the entry shape here — roughly 5–10 lines showing how
     kling/ai-avatar-standard would be declared, including how duration and pricing are keyed.
     The pricing key is the real decision: audio-seconds vs output-video-seconds changes the
     quote path in generation-model-quote-service.ts. -->

