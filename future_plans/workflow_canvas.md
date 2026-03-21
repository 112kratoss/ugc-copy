# Workflow Canvas

This document is the handoff note for the node-based workflow canvas feature. Use it as the starting context in future conversations.

User-facing usage guide:
- `future_plans/workflow_canvas_user_guide.md`

## Product goal

Build a visual workflow canvas inspired by Freepik Spaces and similar AI node editors:
- infinite canvas
- draggable nodes
- typed connectors
- reusable templates
- run one node or run downstream branches
- mix prompt, media, generation, and later audio/compositing steps

This feature lives at `/create-workflow`.

## Current implementation snapshot

### Canvas and persistence
- The canvas UI is implemented in `src/app/create-workflow/page.tsx`.
- Graph schema, node types, connection rules, and normalization live in `src/lib/workflow-canvas.ts`.
- Canvas persistence APIs live under `src/app/api/workflow-canvases/`.
- Run orchestration lives in `src/lib/workflow-runner.ts`.
- Shared generation start helpers live in `src/lib/generation-services.ts`.
- Database tables for canvases and runs were added in:
  - `supabase/migrations/20260318155000_workflow_canvases.sql`

### Node types currently implemented
- `text-input`
  - stores prompt text
  - outputs `text`
- `image-input`
  - uploads or stores an image
  - outputs `image`
- `video-input`
  - uploads or stores a video
  - outputs `video`
- `audio-input`
  - uploads or stores an audio file
  - outputs `audio`
- `image-generate`
  - runnable
  - consumes `prompt` and optional `reference-image`
  - outputs `image`
- `video-generate`
  - runnable
  - consumes `prompt` and optional `reference-image`
  - outputs `video`
- `motion-generate`
  - runnable
  - consumes `reference-image`, `reference-video`, and optional `prompt`
  - outputs `video`
- `voiceover-generate`
  - runnable
  - consumes `prompt`
  - outputs `audio`
  - uses ElevenLabs models via KIE
- `music-generate`
  - schema support exists, but it is intentionally not exposed in the node palette yet
  - consumes `prompt`
  - outputs `audio`
  - still blocked until a real music backend is added
- `sound-effects-generate`
  - runnable
  - consumes `prompt`
  - outputs `audio`
  - uses ElevenLabs SFX via KIE
- `note`
  - non-runnable annotation node
- `group`
  - visual grouping only

### Connection rules currently enforced
- `text -> prompt`
- `image -> reference-image`
- `video -> reference-video`

## Audio setup status

Audio generation support is partially live.

### What is ready
- audio node types exist in the graph schema
- audio nodes appear in the palette and inspector
- audio previews render in the canvas
- `generated_audio` storage bucket support was added to app code
- audio media proxy support was added in `src/app/api/media/route.ts`
- voiceover generation is wired through `src/lib/generation-services.ts`
- sound-effects generation is wired through `src/lib/generation-services.ts`
- audio creations show up in `src/app/creations/page.tsx`
- audio bucket migration was added in:
  - `supabase/migrations/20260318182000_generated_audio_bucket.sql`
  - `supabase/migrations/20260319090000_allow_audio_generation_category.sql`

### What is not wired yet
- no music generation backend yet
- no video compositing/export step that merges external audio into generated video
- no waveform/timeline editing

## Current UX gaps vs the intended Freepik-style experience

These are the main missing behaviors still called out during implementation review:
- node delete was missing originally, and is now added
- duplicate node is still missing
- connector deletion UX can be improved
- per-node action menus are still light
- right-click add menu is missing
- keyboard shortcuts are minimal
- templates/starter packs are basic
- node-level media actions like replace/reset/download are still light
- audio compositing is not yet wired
- collaboration/comments are not implemented

## Important execution caveats

### Async chain behavior
`Run from here` now uses topological ordering and queued downstream steps. When an upstream generation is still processing, dependent nodes stay queued and are resumed on subsequent run polling.

Current limitation:
- connected external audio is not yet a valid downstream dependency because video compositing is intentionally not exposed until the backend exists

## Local environment notes

- The app is currently configured for local Supabase in `.env.local`
- local project URL: `http://127.0.0.1:54321`
- local Studio UI: `http://127.0.0.1:54323`
- local workflow canvas page: `http://localhost:3000/create-workflow`

## Recommended next implementation order

1. Add a real music backend before exposing `music-generate` in the palette.
2. Add an explicit audio compositing/export step so audio can feed video or final renders safely.
3. Add node duplication, connector deletion polish, and right-click creation.
4. Add richer media actions such as replace/reset/download on node results.
5. Add templates/help/collaboration improvements once the interaction model stabilizes.

## Suggested prompt for future conversations

Use this note as context:

“Please read `future_plans/workflow_canvas.md` first. I want to continue the workflow canvas feature. Preserve the existing node graph architecture, review current gaps vs the intended Freepik-style experience, and help implement the next missing piece.”
