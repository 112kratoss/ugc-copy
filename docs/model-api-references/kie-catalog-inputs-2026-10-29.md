# Grok Imagine Video 1.5, Grok Imagine Video and Seedance 1.5 Pro against Kie (2026-10-29)

Re-read on 2026-10-29 after the web creator's Kie audit found the three models' published inputs disagreeing with
Kie. Sources: `https://docs.kie.ai/market/<page>.md` and the market pages `https://kie.ai/<slug>` (browser User-Agent),
and createTask probes against `https://api.kie.ai/api/v1/jobs/createTask`. The pages, probe tools and results are in
`archive/kie-catalog-inputs-2026-10-29/` of the parent folder (`UGC copy`). This file supersedes the sections named
below in `grok-imagine-video-1-5.md`, `grok-imagine/image-to-video` and `bytedance/seedance-1.5-pro.md`; each carries
a banner pointing here.

## How the probes read Kie

Zero-cost probes put the field under test before deliberately broken fields (an unknown `resolution` or `mode`,
`duration: 0`) in the spec's property order. Kie checks types, enums, `maxItems` and `required` in property order and
answers the first error inside an HTTP 200, so no task starts, and a "resolution is not within the range of allowed
options" means the field under test passed. Calibrated the same day: `grok-imagine/text-to-video` with no prompt and a
bad `mode` answers "prompt is required"; Grok 1.5 with a bad `aspect_ratio` and a bad `resolution` answers the
`aspect_ratio` error. The Kie balance stayed at 2640.2 through every zero-cost probe.

## `grok-imagine-video-1-5-preview`

The docs page changed between 2026-10-20 (no required field; the prompt's cap at line 105) and 2026-10-29:

- `image_urls`: "Supports multi-file upload, up to 1 file. Only one is supported when the resolution is 1080p",
  `maxItems: 1` (:109-120), and `required: [image_urls]`.
- New: `first_frame_url` "First-frame image. Can be passed together with image_urls, or sent on its own" (:188);
  `last_frame_url` "Last-frame image" (:193); `loop_url` (not with a different first or last frame); `keyframes`
  "Mid-video keyframes, up to 4", each `url` + `timestamp_s`; `enable_audio` "Defaults to true".
- `aspect_ratio` adds `4:3` and `3:4`; the prompt names pictures "`@imageN` … the 1-based index".

The page's 1-picture cap and `required` are not what Kie runs:

- The validator takes 2 and 7 pictures, a text run, `image_urls: []`, `first_frame_url` alone and an unknown field
  (each reached the broken `resolution`), and refuses 8 with "image_urls supports at most 7 files".
- The market page says "Up to 7 reference images can be passed (JPEG, PNG or WebP), but only one is supported when the
  resolution is 1080p, and aspect_ratio has no effect with a single image". Its playground uploads `image_urls` with
  `limitFile: 7`, patched to 1 by a rule when `resolution` is 1080p, beside a frame uploader whose Start Frame and End
  Frame write `first_frame_url` and `last_frame_url` and which clears the end frame when the first goes.

Two paid runs (owner's "Yes, test and offer", 1 s at 480p, 2.4 credits each, neutral prompts so ignored frames would
show):

- Task `759d64b593a3a81967708b8f4ea4cc18`: `first_frame_url` (a tavern) + `last_frame_url` (a white room). Succeeded
  in 36 s: 752×416 (the tavern's 16:9), 1.04 s, AAC. The first frame is the tavern picture, the last the white room.
- Task `a177e6e8f5c5617bd2ea6a66902f2ce9`: `first_frame_url` (a guitarist) + `image_urls` [headshots, white room],
  "@woman is shown on @screen". Succeeded in 47 s: 464×688 (the guitarist's portrait shape). It starts on the
  guitarist and ends on the room's screen showing the woman: the start frame and both pictures were used.

Shipped (code, then release `kie-catalog-inputs-20261029`): Frames are a start and an end frame, sent as
`first_frame_url` and `last_frame_url`; References are up to 7 pictures in `image_urls` with the start frame kept
beside them, as Wan 2.7's are (`VIDEO_INPUT_LIMITS.startFrameWithReferences`); an end frame needs the start frame.
`aspect_ratio` goes with a text run or several pictures and no frame. Not offered: `loop_url`, `keyframes`,
`enable_audio` (the app never sent it, so audio stays on), `4:3` and `3:4`, 1080p (still unpriced).

## `grok-imagine/image-to-video` (Grok Imagine Video)

Unchanged since 2026-09-04: `image_urls` "Up to 7 images are supported … reference an uploaded image by typing
@image(n)", `maxItems: 7` (:105-127); `aspect_ratio` "only applies to multi-image generation mode. In single-image
mode, the video width and height are referenced to the image width and height." No frame field. The validator takes 7
pictures (the broken `mode` answered) and refuses 8 ("image_urls supports at most 7 files").

Shipped: up to 7 pictures on the references side (the catalog offered 1); `aspect_ratio` with several pictures. One
picture is the start frame, sent alone in `image_urls`; a start frame beside pictures is refused, since Kie would read
them as one list of references.

## `bytedance/seedance-1.5-pro`

Delisted by 2026-10-20 (pages 404, gone from `llms.txt`; the API still took the id). On 2026-10-29 every createTask,
`input: {}` included, answers code 410: "Seedance 1.5 Pro has been retired upstream and is no longer available on
Kie.ai. Please consider other models in the Seedance series — the latest is Seedance 2.5".

Shipped: retired (`RETIRED_MODEL_IDS`, the `retired` status): offered on no platform, as the Imagen 4 family was on
2026-08-24, and refused before a start holds credits (a template quotes at its own pinned revision). Its entry, prices
and routing stay for its old runs. The workflow builders send a before/after workflow to Kling 3.0 instead, whose start
and end frames the workflow wires (they wire a Seedance 2 model's frames as references).
