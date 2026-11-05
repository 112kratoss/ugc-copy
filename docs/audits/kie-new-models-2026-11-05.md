# Kie.ai — new models since 2026-10-07 (2026-11-05)

A pass over everything Kie listed since the last scan (`kie-new-models-2026-10-07.md`), checked
against production's release `kling-3-image-orientation-20261105` (45 entries). Kie's models
sitemap now carries **117 market slugs** (113 on 2026-10-07).

## Method

As before: the sitemap's `<lastmod>` sorted for "what is new"; each market page's `pricingDesc`
(`scripts/ops/kie-evidence.mjs price <slug>`, attributed by README rule 9); the OpenAPI bodies at
`docs.kie.ai/market/<path>.md` (`kie-evidence.mjs spec`), whose paths came from `docs.kie.ai/llms.txt`;
and a zero-cost `input: {}` probe of every id (all answered "This field is required"; the Kie
balance did not move). Raw copies: `UGC copy/archive/kie-models-2026-11-05/evidence/`.

## New, live and priced — shipped by release `kie-models-20261105`

| Model (listed) | App id | Provider ids | Credits | Evidence |
| --- | --- | --- | --- | --- |
| **Nano Banana 2.1** (10-07) | `nano-banana-2.1` | `nano-banana-2-1` | 4 / 6 / 9 at 1K / 2K / 4K | `nano-banana-2-1.md` |
| **FLUX.3 Klein** (10-19) | `flux-3-klein` | `flux-3/klein-text-to-image`, `flux-3/klein-edit-image` | 1.6 / 2.5 / 6.5, charged 2 / 3 / 7 | `flux-3-klein.md` |
| **PixVerse V6 Max** (10-23) | `pixverse-v6-max` | `pixverse-v6-max/{text,image}-to-video` | 4.8–17.6 per s, 7.2–22.4 with audio | `pixverse-v6-max.md` |
| **Kling 4.0** (10-22) | `kling-4.0` | `kling-4.0/reference-to-video`, `kling-4.0/keyframe-to-video` | 28.5 / 42.5 per s (720p / 1080p) | `kling-4-0.md` |
| **Vidu Q4** (10-12) | `vidu-q4` | `vidu-q4/image-to-video`, `vidu-q4/reference-to-video` | 7.2 / 15.2 / 19.2 / 30.4 / 62.4 per s (540p–4k) | `vidu-q4.md` |

One paid run per endpoint (2026-11-05, on the owner's word) charged exactly the listed price
(`creditsConsumed`) and delivered the asked length, size and audio; each evidence file records
its tasks.

What each leaves out, and why:

- **Kling 4.0**: reference clips (Kie bills a clip run `rate × (output + max(output, input))`, which
  the `reference-adjustment` pricing cannot express without undercharging), elements, voices and
  middle keyframes (a middle frame needs a new slot role, which needs an app release).
  `kling-4.0/text-to-video` does not exist (422).
- **Vidu Q4**: MP3-only reference audio (the app converts a refused track to WAV). Web only:
  ShengShu is a maker the installed apps do not name in their AI-data question.
- **FLUX.3 Klein**: the edit endpoint's `auto` ratio (the text endpoint has none), `num_images`
  above 1, explicit `width` / `height`.

## Listed, not shipped

- **OmniHuman 2.0** (10-23): `omnihuman-2-0`, image + audio → talking video, 14 credits/s, 720p,
  4–300 s. Live and priced; left out at the owner's word (2026-11-05): it needs an audio-input
  surface the creators do not have.
- **Kling 4.0 Flash** (09-29) and **Wan Animate 2** (08-12): still "Coming Soon".
- Chat and TTS listings since the last scan (GPT-6.1 Terra, Gemini 4 Argon, Claude Haiku 5.5) are
  not media models.
