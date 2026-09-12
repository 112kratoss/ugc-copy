# Template vocabulary expansion — scoping (2026-08-18)

Status: **scoping decision record** from the 2026-08-18 workflow→template audit (finding F4).
Nothing here is implemented; this documents what is safe to build in which order, and why
the obvious quick version must not ship.

## The gap

The workflow builder speaks 13 node kinds; a published template accepts six
(`validateWorkflowTemplateAuthoringGraph`, `src/lib/workflow-canvas.ts` — `supportedKinds`):
`text-input`, `image-input`, `video-input`, `image-generate`, `video-generate`, `approval-gate`.
Practical consequences, in decreasing order of consumer pain:

1. **Consumers can never type anything.** `TemplateInputSlot.kind` is `'image' | 'video'`
   (`src/lib/media-template-types.ts`); `text-input` nodes have no `consumer` mode, so every
   prompt is frozen at publish time.
2. **Audio is untemplatable even as a fixed asset.** `audio-input` is not in `supportedKinds`,
   so a video node using `reference-audio` cannot be published at all.
3. **Motion, voiceover, music, and sound-effect nodes make a workflow unpublishable**
   (`unsupported-node` — "not supported in published templates yet").

## Why the quick version must not ship

The template DTOs are part of the public mobile API contract, and the iOS app has been live
since 2026-08-15 — installed clients cannot be patched by a web deploy.

The shipped app treats slot kind as a **binary**: anything that is not `image` renders as a
*video* slot and taps into the native media picker
(`ugc-mobile/components/media-template-screens.tsx:313`, `:592`, and
`pickMedia(slot.kind)` at `:417`). If the server ever serves a `text` slot on an active
template, every installed app renders a broken video-upload tile for it. The same applies to
step `mediaKind`: the run screen switches image/video only (`:783`, `:789`).

The database pins the same vocabulary: `templates.output_kind`,
`template_versions.output_kind`, `template_runs.output_kind` and
`template_run_steps.media_kind` are all `CHECK (... IN ('image', 'video'))`
(`supabase/migrations/20260711131023_graph_media_templates.sql:30`, `:65`, `:135`, `:190`).

So expansion is a **gated contract change**, not a validator tweak.

## Phasing

### Phase A — fixed audio assets (server-only, no contract change) — recommended first

A `fixed`-mode `audio-input` never becomes a consumer slot, never appears in
`inputSlots`, and never becomes a run step — it is invisible to both clients. Scope:

- `supportedKinds` += `audio-input`, restricted to `templateInput.mode === 'fixed'`
  (reject `consumer` mode with a clear issue code).
- `copyFixedAssets` / `copyOwnedAssetToVersion` (`src/lib/media-template-service.ts`): accept
  the audio storage bucket + audio MIME/extension checks (today hardcoded to
  `generated_images`/`generated_videos`).
- `hydrateRunGraph` (`src/lib/template-run-service.ts`): hydrate `audio-input` storage paths
  the way image/video inputs are hydrated.
- Compiler + publish tests; no DTO, no migration, no mobile work.

Unlocks every "video with licensed soundtrack" template immediately.

### Phase B — consumer text slots (contract change, needs gating + a mobile release)

Adds `kind: 'text'` to `TemplateInputSlot` and text values to `template_runs.inputs`
(strings, not storage paths — the upload/preflight pipeline does not apply).

Gate options, in preference order:

1. **Capability-aware projection**: templates carrying text slots are omitted from
   list/detail responses for clients that don't declare support. The infra exists —
   `x-magicbooklet-min-api-version` / `x-magicbooklet-min-app-version` headers and the
   426 upgrade policy in `src/lib/mobile-client-compatibility.ts`. New templates with text
   slots simply don't exist for old apps; nothing breaks.
2. Per-template `min_app_version` column enforced at the API boundary — same effect,
   creator-visible ("this template needs app ≥ X").

Do **not** rely on old clients "degrading gracefully" — they demonstrably don't (see above).
Requires: web run UI, mobile run UI + store release, `contracts/mobile-api-v1.json` +
fixture tests on both sides, input length/moderation policy for free text entering prompts.

### Phase C — new step media kinds (motion / voiceover / music / sound-effects)

Largest change; blocked on two prerequisites:

- **Catalog-first pricing**: voiceover/music/sfx nodes don't quote through the generation
  model catalog (`quoteNode` returns 0 for them; the canvas runner prices only
  image/video/motion via the catalog). Templates require honest cost estimates, so these
  models must join the catalog control plane first.
- **Migrations relaxing the four CHECK constraints** plus `TemplateMediaKind`,
  step DTO `mediaKind`, and both clients' step renderers — behind the same gating as Phase B.

Ship after Phases A/B prove the gating mechanism.

## Interaction with the 2026-08-18 fixes

The pinned-revision quoting fix (template runs quote against their published catalog
release) means Phase C models must also be published through catalog releases before any
template can use them — reinforcing the Phase C prerequisite above.
