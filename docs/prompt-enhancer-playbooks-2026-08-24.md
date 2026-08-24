# Prompt Enhancer Playbooks — 2026-08-24 rebuild

Supersedes `future_plans/prompt-enhancer-playbooks-2026-04-03.md`. Source research:
`docs/research/prompt-enhancer-2026-08-24/` (seven memos: per-family official
guidance, Kie endpoint specs, labeled community consensus, competitor teardown,
LLM comparison, and published prompt-rewriting evals).

## What changed

1. **Provider LLM**: `gemini-3-flash` → `gemini-3.6-flash` via Kie's
   OpenAI-compatible endpoint (`/gemini-3-6-flash-openai/v1/chat/completions`).
   Same payload shape, roughly double the generation throughput, positioned by
   Google on instruction following. Verified live on 2026-08-24: plain,
   `response_format: json_schema`, and `image_url` vision calls all return 200,
   and the schema-constrained call returns schema-valid JSON.
2. **One registry, one grammar per model** (`src/lib/prompt-enhancer-playbooks.ts`).
   Every live model id resolves to its own playbook + agent; `MODEL_ALIASES` is
   reserved for true grammar twins (qwen3-pro→qwen3, wan-2.7-image-pro→wan-2.7-image,
   imagen fast/ultra→imagen-4, seedance-2-mini→seedance-2-fast, and the
   kling-3.0-video id spelling). The old cross-provider aliases (hailuo→kling,
   qwen→seedream, seedance-2-5→seedance-2, …) are gone — each was teaching the
   model a wrong grammar (bracket camera commands, timestamp support, audio
   behavior all differ).
3. **Dialect compilers**. Image: narrative (nano-banana-2), design-brief
   (pro/seedream/qwen/wan-image/grok-2), labeled-sections (gpt-image-2),
   caption-tail (imagen), prose-photo (flux/grok/z-image), intent-compact
   (ideogram). Video: veo, kling-shot, seedance, single-clip
   (turbo/omni/wan/happyhorse/grok), timeline (minimax-h3, seedance-2-5),
   bracket-camera (hailuo). Word budgets are enforced in code (z-image's hard
   1,000-char cap is sentence-trimmed by the compiler).
4. **Vision-grounded image-to-video**: the web video client uploads the attached
   start/end frames at enhance time (`context.frameImageUrls`, sanitized
   server-side) and the enhancer sees the real frames — the Wan i2v contract
   (dynamics only, delete what the frame shows) is in the scenario rules.
5. **Schema-enforced planning**: planner calls send `response_format:
   json_schema` (ImagePromptSpec / VideoScenePlan); regex extraction survives
   only as a logged fallback (`promptenhancer_plan_parse_fallback`), with a
   retry-without-schema path if the provider ever rejects it.
6. **Audio routing encoded per model**: grok-imagine-video, wan-2.7, minimax-h3,
   happyhorse-1.1, veo-3.1 generate audio unconditionally → compilers always
   script a soundscape or state "no music"; kling-3.0-turbo and hailuo-2.3 are
   silent routes → dialogue/audio cues are stripped.
7. **Negative-prompt routing**: wan-2.7 video now always sends the condensed
   default negative stack (`WAN_VIDEO_DEFAULT_NEGATIVE_PROMPT`); Ideogram's
   server-side Magic Prompt (`expand_prompt`) is disabled whenever the compiled
   prompt quotes literal text (the double-rewrite threat to exact typography);
   everything else stays positive-phrasing-only per official guidance.
8. **ElevenLabs enhancement (backend-ready)**: `medium: 'audio'` is accepted by
   the enhance endpoint with playbooks for TTS normalization (turbo 2.5 /
   multilingual v2 — numbers/dates/symbols expanded, no stage directions),
   v3 dialogue tagging, and SFX foley vocabulary. No UI surface yet: the
   workflow voiceover node takes its script from an upstream prompt node, so
   wiring a button is a workflow-graph design question.
9. **Enhancement levels + undo**: `context.enhancementLevel: 'faithful' |
   'cinematic'` (HunyuanVideo's Normal/Master precedent); the web button gets a
   Full/Light toggle and an Undo chip that restores the pre-enhancement prompt.
10. **Catalog cap fixes** (code catalog + client mirror; the production DB
    catalog needs a release to match): qwen3/qwen3-pro maxImages 10→3,
    ideogram-character 4→1 (Kie uses only the first reference), Kling 3.0
    multi-shot quality gate 6→5 shots (Kie's `multi_prompt` cap; O3 stays 6).

## Known follow-ups (deliberately not in this change)

- **Imagen 4 sunset**: Google shut the upstream Imagen API on 2026-08-17; Kie
  still serves it. Live-test a generation and plan migration to nano-banana-2.
- **Production catalog release** for the maxImages fixes (ops:
  `generation-model-catalog` stage/publish workflow).
- **Hidden-audio UX**: wan-2.7 / grok video / minimax-h3 / happyhorse always
  output audio but the catalog models them as `supportsSound: false`; the
  enhancer now scripts audio, but the catalog/UI story (an "audio always on"
  affordance) is open.
- **Streaming the rewrite**: rejected for now — plan-then-compile means the
  final prompt only exists after compilation, so token streaming would show the
  user raw JSON. Revisit with a two-lane UX if latency ever matters more than
  the planner.
- **kling-o3 `elements`** (named @subjects) still needs a subject-grouping UI
  before the @Name grammar can be exercised end-to-end.
- **Live eval harness**: `npm run eval:enhancer` (scripts/enhancer-eval.ts)
  runs fixture prompts through the real provider and checks constraint
  obedience; not part of CI (costs money, needs `KIE_AI_API_KEY`).

## Per-model quick reference

See `src/lib/prompt-enhancer-playbooks.ts` (the registry is the reference) and
the research memos for per-claim sources. The full per-model report with
templates lives in the "Enhancer Playbook 2.0" artifact from the research pass.
