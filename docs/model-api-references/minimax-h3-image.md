# MiniMax H3 Image — verified provider evidence (2026-11-14)

Captured on 2026-11-14 from `https://docs.kie.ai/market/minimax-h3/text-to-image.md` and
`.../image-edit.md` (OpenAPI bodies) and the market page `https://kie.ai/minimax-h3-image`
(`pricingDesc`). Raw copies: `UGC copy/archive/kie-models-2026-11-14/evidence/`. Credits are Kie
credits 1:1 (1 credit = $0.005). Listed by Kie on 2026-11-10. The image model of the MiniMax H3
family whose video model (`minimax-h3`) the app already runs.

## Provider ids

| App id | Text-to-image | Image-to-image |
| --- | --- | --- |
| `minimax-h3-image` | `minimax-h3/text-to-image` | `minimax-h3/image-edit` |

Each is the sole entry of its spec's `model` enum (t2i :141-144), under the vendor segment of the
H3 video ids. The empty-input probe of both answered "This field is required" with no task
(balance 2375.9 before and after, `archive/kie-models-2026-11-14/probe-results.txt`).

## Inputs — the two bodies differ only by `image_urls`

- `prompt` — required, 1–5,000 characters (t2i :178-189, edit :192-205). The edit endpoint names
  its pictures `<Picture 1>`, `<Picture 2>`, … "in `image_urls` order".
- `aspect_ratio` — `auto`, `1:1`, `5:4`, `4:3`, `3:2`, `16:9`, `21:9`, `4:5`, `3:4`, `2:3`, `9:16`;
  default `auto` (t2i :190-252, edit :206-267). On text-to-image `auto` "lets the prompt rewriter
  choose the ratio"; on the edit endpoint it "follows the aspect ratio of the first reference
  image".
- `resolution` — `1K` (~1 MP), `2K` (~4 MP), `4K` (~16 MP), default `2K` (t2i :253-287, edit
  :268-303). The header's size table tops out at 6272×2688 (16.9 MP), under the 20 MP of the
  price's top tier.
- `seed` (:288 / :304) — not sent.
- `expand_prompt` — boolean, default `true`, "we recommend keeping it on for better image
  quality" (t2i :300-316, edit :316-331). Sent as `true`, so the request says what runs.
- `output_format` — `png` (default), `jpeg` (t2i :317-335, edit :332-350). The app's `jpg` is sent
  as `jpeg`.
- `image_urls` — edit only, required, 1–16, "Each image ≤ 20 MB and ≤ 64 MP", JPG, PNG, WEBP, HEIC,
  BMP (edit :351-373).
- `width` / `height` — a custom size instead of `resolution` + `aspect_ratio` (:336-367, :374-405).
  Not offered: the create pages pick a tier and a ratio.

## Price (`pricingDesc`, 2026-11-14)

Text-to-image: "Billed per image by total output pixels: 1.8 credits ($0.009) up to 4.5 MP (1K /
2K) and 5.5 credits ($0.0275) up to 20 MP (4K) — about 60% below official pricing."

Image edit: the same, "plus 0.5 credits ($0.0025) for each reference image, including the first".

So: **1K and 2K 1.8, 4K 5.5 per image, plus 0.5 for every input picture** — Qwen 3's shape
(`additionalReferenceCredit` with `referenceCreditIncludesFirst`). A run is charged whole
credits, rounded up: 2 at 1K or 2K, 6 at 4K, a 2K edit of one picture 3 (2.3), a 4K edit of
sixteen 14 (13.5). "About 60% below official pricing" is Kie's standing rate against MiniMax's own
API, as the H3 video model's "50% of the official price" is, not a dated offer.

## Shipped (2026-11-14)

- App id `minimax-h3-image` ("MiniMax H3 Image"), maker MiniMax (already named in the AI-data
  question, for Hailuo and MiniMax H3); on the `kie-task-v1` adapter: `aspect_ratio`,
  `resolution`, `output_format` (`jpg` → `jpeg`), `expand_prompt: true`, `image_urls`; references
  select the edit id.
- Resolutions 1K, 2K, 4K; the eleven ratios above; up to 16 references; prompts to 5,000.
- `src/lib/provider-image-limits.ts`: `image_urls` 20 MB.
- Reference pictures reach the prompt through the app's usual legend (`@name = attached reference
  image N`), as for the other image models; Kie does not refuse an `@`, and its prompt rewriter
  reads the legend. Its own enhancer playbook names the pictures in upload order.
