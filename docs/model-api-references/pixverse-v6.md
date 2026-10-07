# PixVerse V6 — verified provider evidence (2026-10-08)

Captured from `https://docs.kie.ai/market/pixverse/{text-to-video,image-to-video,transition,reference-to-video,extend}.md`
(OpenAPI bodies) and the market page `https://kie.ai/pixverse-v6` (`pricingDesc` blocks attributed
by README rule 9: each block precedes the `model` it belongs to). Credits are Kie credits 1:1
(1 credit = $0.005). Listed by Kie on 2026-07-21; left out on 2026-08-15 over what looked like
conflicting tiers (`dropin-models-2026-08-15.md`), resolved on 2026-09-11, prices unchanged on
2026-10-07 and 2026-10-08.

## Provider ids — one per input shape

| Shape | `model` enum | `required` |
| --- | --- | --- |
| Text | `pixverse-v6/text-to-video` | `prompt`, `aspect_ratio`, `quality`, `duration` |
| Start frame | `pixverse-v6/image-to-video` | `prompt`, `image_urls`, `quality`, `duration` |
| Frame pair | `pixverse-v6/transition` | `prompt`, `first_frame_image_url`, `last_frame_image_url`, `quality`, `duration` |
| Named references | `pixverse-v6/reference-to-video` | `prompt`, `image_references`, `aspect_ratio`, `quality`, `duration` |
| Extend a video | `pixverse-v6/extend` | needs a prior PixVerse video; not offered |

Endpoint `POST /api/v1/jobs/createTask`, the shared status and callback path. The docs path
(`pixverse/...`) is not the id.

## Inputs

Shared by every shape:

- `prompt` — 3–5,000 characters.
- `quality` — `360p`, `540p`, `720p`, `1080p`.
- `duration` — integer 1–15 s.
- `generate_audio_switch` — boolean, default false: "Whether to generate audio synchronized with
  the video content." The tip on every page: "Enabling audio costs more."
- `seed` — integer; not sent.

Per shape:

- Text and reference: `aspect_ratio` — `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `2:3`, `3:2`, `21:9`.
  "This parameter is supported in text-to-video and Fusion multi-reference image-to-video modes."
  The start-frame and frame-pair bodies have no ratio field.
- Start frame: `image_urls` — "Without template_id, provide 1 image (used as the first frame)";
  `template_id` selects a PixVerse effect template with its own fixed duration (not offered).
- Frame pair: `first_frame_image_url`, `last_frame_image_url` — JPG / PNG / WebP ≤ 20 MB.
- Named references: `image_references` — 1–7 of `{ image_url, type: subject | background,
  ref_name }`; "`ref_name` must be unique within the same list. You can reference the reference
  object in the prompt via `@ref_name`"; `ref_name` 1–30 characters.
- `generate_multi_clip_switch` (text, start frame) — "Whether to generate a multi-clip video";
  not offered.

## Price (`pricingDesc`, 2026-10-08), credits per second

Text-to-video, image-to-video, transition and extend share one block; reference-to-video has its
own, 12.5 % higher:

| Resolution | No audio | With audio | Reference, no audio | Reference, with audio |
| --- | --- | --- | --- | --- |
| 360P | 4.0 | 5.6 | 4.5 | 6.3 |
| 540P | 5.6 | 7.2 | 6.3 | 8.1 |
| 720P | 7.2 | 9.6 | 8.1 | 10.8 |
| 1080P | 14.4 | 18.4 | 16.2 | 20.7 |

No promotional qualifier. (`kie-evidence.mjs price pixverse-v6` prints both blocks unlabelled;
the order above is the page's.)

## Shipped (2026-10-08)

- App id `pixverse-v6`, provider `pixverse`, maker PixVerse (new in `ai-data-recipients.ts`),
  on `video-v1`. Resolutions 360p, 540p, 720p, 1080p; duration 1–15 s as a stepper, default 5;
  the eight ratios; a Sound toggle (`generate_audio_switch`).
- **Web only for now** (`availability` in `generation-model-catalog.ts`, which the release
  emitter follows): the installed apps' AI-data question names each maker, PixVerse is new, and
  the iOS update is held behind App Review. A later release flips `mobile` on once an app update
  naming PixVerse has shipped on both platforms (`AI_MODEL_MAKERS` and
  `AI_DATA_CONSENT_VERSION` in `ugc-mobile/lib/ai-data-consent.ts`).
- Inputs: 7 reference images (named), or a start frame with an optional end frame. The shape
  picks the id: references → `reference-to-video`; two frames → `transition`; one frame →
  `image-to-video`; none → `text-to-video`. A lone end frame is refused.
- Request body (`startVideoGeneration`): `prompt`, `quality`, `duration`,
  `generate_audio_switch`; text and reference runs add `aspect_ratio`; references travel as
  `image_references` with `type: subject` and `ref_name` = the @handle without its `@`, cut to
  30 characters, so the provider resolves the prompt's @mentions itself (the compiled prompt
  keeps them). `seed`, `template_id` and `generate_multi_clip_switch` are never sent.
- Price: the table above; the reference block applies when the run is in references mode with a
  picture attached (`pixverse-v6` in `getVideoCost` and `videoPricingExpression`).
- Enhancer: a playbook of its own (plain sentences, @names kept verbatim, optional Audio line).
