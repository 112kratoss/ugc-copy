# GPT Image 2.5 (Flare, Sunburst) — verified provider evidence (2026-09-11)

Captured from `https://docs.kie.ai/market/gpt/gpt-image-2-5-{flare,sunburst}-{text-to-image,image-to-image}.md`
(OpenAPI bodies), the market page `https://kie.ai/gpt-image-2-5`, and the `https://kie.ai/pricing`
table. Credits are Kie credits 1:1 (1 credit = $0.005). Listed by Kie on 2026-09-09.

## Provider ids — the tier is part of the id

| App id | Text-to-image | Image-to-image |
| --- | --- | --- |
| `gpt-image-2.5-flare` | `gpt-image-2-5-flare-text-to-image` | `gpt-image-2-5-flare-image-to-image` |
| `gpt-image-2.5-sunburst` | `gpt-image-2-5-sunburst-text-to-image` | `gpt-image-2-5-sunburst-image-to-image` |

Each value is the sole entry of the `model` enum in its spec. The docs path and the id agree here;
the version is dashed (`2-5`), unlike our dotted app ids.

## Inputs — identical across all four endpoints

- `prompt` — required, 1–20,000 characters.
- `input_urls` — image-to-image only, required, array, `maxItems: 16`.
- `aspect_ratio` — `auto` (default), `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`, `21:9`,
  `27:16`, `16:27`, `9:8`, `8:9`. Spec text: "The 27:16, 16:27, 9:8 and 8:9 aspect ratios
  support 1K only. 2K and 4K are available for other aspect ratios."
- `resolution` — `1K`, `2K`, `4K`.
- `background` — `transparent`, `opaque`, `auto`. New relative to GPT Image 2.

GPT Image 2 by contrast offers `5:4` and `4:5` (1K only), and its spec caps `auto` at 1K and 1:1
at 2K. The 2.5 spec lists neither 5:4 nor 4:5 and says nothing about `auto` or 1:1.

## Price

**6 credits at 1K, 10 at 2K, 16 at 4K, per image**, for both tiers and both modes — the same as
GPT Image 2. The market page states it once per variant ("GPT Image 2.5 — now just 6 credits
($0.03) for 1 K, 10 credits ($0.05) for 2 K, and 16 credits ($0.08) for 4 K"), and the
kie.ai/pricing table lists the same twelve rows. No per-input-image charge, no promotional
qualifier.

## Tiers

The market page positions Flare for "quality and speed in production" at higher volume, and
Sunburst for "more premium visual workflows that benefit from tighter control and more polished
outputs". The request schema does not differ.

## Shipped (2026-09-11)

- Two catalog entries alongside `gpt-image-2`, which stays: `gpt-image-2.5-flare` and
  `gpt-image-2.5-sunburst`, both on the `kie-task-v1` adapter with GPT Image 2's bindings
  (`aspect_ratio`, `resolution`, `input_urls`; references select the image-to-image id).
- `background` is not sent, so Kie applies `auto`. Exposing it needs a control on the web
  create-image page, which renders a fixed set of settings.
- Aspect ratio → resolution: `27:16`, `16:27`, `9:8` and `8:9` at 1K only, as the spec states.
  `auto` at 1K only and `1:1` at 1K or 2K, carried over from GPT Image 2's spec because the 2.5
  spec is silent on both: a combination Kie cannot render fails at task creation, while an
  extra cap only hides a tier. Every other ratio offers 1K, 2K and 4K. One source of truth,
  `getGptImage25ResolutionOptions` in `src/lib/models.ts`, feeds the create pages, the start-path
  check and the catalog's quote rules. To lift a cap, run one 2K `auto` or 4K `1:1` task (16
  credits at most), then change the function and emit a release.
- Release: `config/generation-model-catalog/releases/2026-09-11-gpt-image-2-5.json`
  (`gpt-image-2-5-20260911`, based on `reference-audit-20260904`), pinned by
  `src/__tests__/gpt-image-2-5-manifest.test.ts`.
