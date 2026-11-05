# FLUX.3 Klein — verified provider evidence (2026-11-05)

Captured on 2026-11-05 from `https://docs.kie.ai/market/flux3/klein-text-to-image.md` and
`https://docs.kie.ai/market/flux3/klein-edit-image.md` (OpenAPI bodies) and the market page
`https://kie.ai/flux-3` (`pricingDesc`, attributed by README rule 9). Raw copies:
`UGC copy/archive/kie-models-2026-11-05/evidence/`. The `flux-3` listing's `<lastmod>` is
2026-10-19. Only the Klein variants are live: the page carries no other FLUX 3 id.

## Provider ids — the docs path says `flux3/`, the id says `flux-3/`

| Shape | `model` enum | `required` |
| --- | --- | --- |
| Text | `flux-3/klein-text-to-image` | `prompt` |
| Edit with references | `flux-3/klein-edit-image` | `prompt`, `image_urls` |

Zero-cost probes on 2026-11-05 (`input: {}`) answered "This field is required" for both ids: live,
no task created.

## Inputs

Shared:

- `prompt` — `minLength: 1`, `maxLength: 5000` (text :83-89, edit :83-89).
- `aspect_ratio` — `1:1`, `4:3`, `3:4`, `3:2`, `2:3`, `16:9`, `9:16`, `21:9`, `9:21`; the edit
  endpoint adds `auto` ("match the first input image ratio", default there). Text defaults to
  `1:1`. The app offers the nine explicit ratios on both, and no `auto`.
- `resolution` — `1K`, `2K`, `4K`, default `1K`.
- `width` / `height` — 256–4096, together; "Once passed, aspect_ratio and resolution are
  ignored". Not sent.
- `output_format` — `png`, `jpeg`, `webp`, default `png`. Sent as `jpeg`: the app records the
  model's output as jpg, and a PNG default would store pictures several times larger.
- `num_images` — 1–4, default 1. Not sent (one picture per run, which is what is priced).
- `seed` — not sent.
- `enhance_prompt` — boolean, default true: "Rewrites the prompt into a fuller description
  before generating, which noticeably improves quality. Enabled by default (also when the
  parameter is omitted)". Sent as `true`, as Qwen Image 2.1's is, so the request says what
  runs; the enhancer playbook writes for a prompt Kie will expand.
- `nsfw_checker` — "Defaults to false. When false, no additional content filtering is applied".
  Sent as `true`, as FLUX.2 Pro's, Seedream's and Z-Image's are.

Edit only:

- `image_urls` — 1–10 URLs, "Accepted types: image/jpeg, image/png, image/webp; Max size:
  30.0MB" (edit :90-101).

## Price (`pricingDesc`, 2026-11-05)

```
FLUX 3 Klein Text to Image is priced at 1.6 credits per 1K image (≈ $0.008), 2.5 credits per 2K image (≈ $0.0125) and 6.5 credits per 4K image (≈ $0.0325).
FLUX 3 Klein Edit Image is priced at 1.6 credits per 1K image (≈ $0.008), 2.5 credits per 2K image (≈ $0.0125) and 6.5 credits per 4K image (≈ $0.0325). Use up to 10 reference images at no extra cost.
```

Per image, both endpoints: **1K 1.6, 2K 2.5, 4K 6.5**; references free. No promotional wording.
The catalog records these figures; a run is charged whole credits
(`calculateGenerationModelRuntimeCost` rounds up), so a person pays **2, 3 and 7**, as Seedream 5
Flash's 3.24 is charged 4.

## Shipped (2026-11-05)

App id `flux-3-klein`, maker Black Forest Labs, declarative `kie-task-v1` adapter (aspect ratio,
resolution, `image_urls` choosing the edit endpoint), its own enhancer playbook.

## Paid runs (2026-11-05)

The app's bodies (`output_format: jpeg`, `enhance_prompt: true`, `nsfw_checker: true`, 1K) ran
once per id; each charged 1.6 credits (`creditsConsumed`, the price above; the app charges 2):

- `flux-3/klein-text-to-image`, 1:1: task `a683d16f718f9d521ac43cb5ac4cf00a`, 14 s, a 1024×1024 JPEG.
- `flux-3/klein-edit-image`, 3:2 with one picture in `image_urls`: task
  `553c6aecfca363cafd5d6f7c12953886`, 22 s, a 1248×832 JPEG.

Both from `tempfile.aiquickdraw.com` (`archive/kie-models-2026-11-05/probe-results.txt`).
