# Prompt Enhancer Playbooks Research Snapshot

Date: 2026-04-03

This note captures the research baseline used for the model-specific prompt enhancer playbooks introduced in `src/lib/prompt-enhancer.ts`.

## Summary

- The enhancer should not behave like one universal beautifier.
- Image models benefit from structured planning around subject, layout, materials, and readable text.
- Video models benefit from one-scene-per-clip planning, explicit camera and pacing cues, and model-specific continuity rules.
- The app now compiles hidden JSON planning artifacts into the final prompt string so the user-facing UI can stay unchanged.

## Image Playbooks

### Nano Banana 2

- Bias toward short, clarity-first prompts with one primary image idea.
- Keep readable text explicit and minimal when requested.
- Treat references as anchor constraints rather than a reason to restate every static detail.

Primary references:

- Google image generation docs: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/image-generation
- Local API reference: `/Users/athuls/UGC copy/ugc-app/model_api_references/nano_banana2.0.md`

### Nano Banana Pro

- Bias toward richer commercial layouts, higher-fidelity material detail, stronger brand consistency, and better text legibility.
- Preserve reference-led identity, packaging, and layout anchors.
- Structured planning is especially helpful for posters, product explainers, and infographic-like requests.

Primary references:

- Google Nano Banana Pro announcement: https://blog.google/innovation-and-ai/products/nano-banana-pro/
- Google image generation docs: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/image-generation
- Local API reference: `/Users/athuls/UGC copy/ugc-app/model_api_references/nano-banana-pro.md`

## Video Playbooks

### Veo 3.1

- Keep short clips focused on one scene.
- Structure prompts around subject, action, context, camera, and ambience.
- Avoid quoted dialogue because it can encourage unwanted text rendering.
- Use repeated continuity anchors only where needed across scenes.

Primary references:

- Veo best practices: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/best-practice
- Veo 3.1 model docs: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/veo/3-1-generate#3.1-generate-preview
- Local API reference: `/Users/athuls/UGC copy/ugc-app/model_api_references/veo-3-1.md`

### Seedance 1.5 Pro

- Layer action, environment, camera intent, pacing, and optional audio explicitly.
- If the camera should stay static, say so directly.
- Use frame references to guide motion evolution instead of re-describing fixed imagery.

Primary references:

- BytePlus prompt guide entry: https://docs.byteplus.com/ko/docs/ModelArk/2168087
- Secondary API reference: https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro/image-to-video/api
- Local API reference: `/Users/athuls/UGC copy/ugc-app/model_api_references/bytedance/seedance-1.5-pro.md`

### Kling 3.0 Video

- Treat prompts like shot design, not generic prose.
- Keep each shot cinematic and coherent with explicit camera behavior and atmosphere.
- In multi-shot work, maintain continuity anchors while keeping each shot self-contained.

Primary references:

- Kling quickstart entry point: https://kling.ai/quickstart/klingai-video-3-model-user-guide
- Local API reference: `/Users/athuls/UGC copy/ugc-app/model_api_references/kling_3.0.md`

## Notes

- Official documentation remains the highest-priority source when model guidance changes.
- Community usage patterns can inform future revisions, but they should be folded into these playbooks deliberately instead of being injected at runtime.
- Motion control remains on the legacy text enhancer path for now and should be researched separately before receiving the same structured-planner treatment.
