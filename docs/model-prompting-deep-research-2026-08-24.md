# Model prompting research for UGC Copy

**Research date:** 2026-08-24

**Scope:** every generation model currently registered in `src/lib/models.ts` (19 image, 15 video, 2 motion-control models)

**Purpose:** establish the evidence base for redesigning the app's prompt-enhancement system. This document does not change generation or enhancement behavior.

## Executive findings

1. **There is no defensible universal prompt format.** The target models disagree about prompt length, negative instructions, reference notation, editing language, shot syntax, and audio syntax. For example, FLUX.2 says not to use negative prompts, Ideogram recommends positive phrasing in the main prompt while also exposing a separate negative-prompt control, Gemini Omni accepts ordinary negative instructions in the main prompt, and Hailuo supports bracketed camera commands.
2. **The app currently has only 15 native enhancement playbooks for 36 live model IDs.** Twenty-one model IDs are aliases to another model's playbook. Some are close variants; others cross providers and prompt grammars (Qwen to Seedream, MiniMax H3 to Kling, Gemini Omni to Seedance, Ideogram to Seedream).
3. **The choice of prompt-writing LLM is secondary to the target-model program.** First-party systems repeatedly use model-specific preprocessors, schemas, or built-in expanders. The strongest evidence is Qwen's own `qwen-plus`/vision rewrite scripts, Wan's explicit `qwen3.6-plus` recommendation, Ideogram Magic Prompt, FLUX prompt upsampling, Grok 4.6's Imagine tool orchestration, and MiniMax H3 Context-IR plus its official prompt-writing skill.
4. **Where a first-party prompt preprocessor exists, use it or reproduce its contract.** Where it does not, a strong multimodal language model can be used, but it must compile into a provider-specific schema and pass deterministic checks. No public evidence establishes one general LLM as the best writer across all 36 targets.
5. **Several model aliases require operational verification before prompt work.** Google's current documentation says Imagen models were deprecated and scheduled to shut down on 2026-08-17, yet the app still offers Imagen 4 Fast, Standard, and Ultra through KIE. KIE may retain compatible routes, but the app should not assume first-party availability or behavior.
6. **The research supports an enhancer registry, not a larger monolithic system prompt.** Each target needs explicit fields for prompt grammar, length budget, reference roles, edit invariants, negative policy, text policy, timing/shot grammar, audio grammar, and preferred prompt-writer path.

## Evidence policy

Sources are ranked as follows:

- **A — exact first-party:** the model vendor's current documentation, model card, repository, prompt guide, skill, or API example for the exact model.
- **B — adjacent first-party:** official guidance for the same provider/model family when the exact distributor alias has no public page.
- **C — implementation evidence:** official or well-maintained GitHub code showing prompt expansion, parsing, or generation behavior.
- **D — practitioner evidence:** YouTube demonstrations, Reddit reports, and independent GitHub tools. These help identify failure modes and useful experiments but do not override first-party behavior.
- **U — unverified:** the public identity or behavior of a distributor alias cannot be tied confidently to a first-party release.

Community sources are deliberately labeled as anecdotal. Search-result volume, copied prompt guides, and affiliate pages are not treated as independent corroboration.

## Current app baseline

The current enhancer sends all model requests to `gemini-3-flash` through KIE and charges two app credits (`src/lib/prompt-enhancer.ts:153–158`). It builds a model/scenario system prompt, requests a structured plan, compiles that plan deterministically, applies safeguards, and returns a heuristic quality result.

The main coverage problem is visible in `MODEL_ALIASES`: 21 live IDs borrow another playbook.

| Live app ID | Current enhancement playbook |
|---|---|
| `kling-3.0-video` | `kling-3.0/video` |
| `grok-imagine-image-2` | `grok-imagine-image` |
| `qwen3`, `qwen3-pro` | `seedream-5-pro` |
| `ideogram-character`, `ideogram-v3` | `seedream-5-pro` |
| `seedance-2-5`, `seedance-2-mini` | `seedance-2` |
| `kling-o3`, `kling-3.0-turbo` | `kling-3.0/video` |
| `minimax-h3`, `happyhorse-1.1`, `hailuo-2.3` | `kling-3.0/video` |
| `seedream-5-lite`, `wan-2.7-image`, `wan-2.7-image-pro` | `seedream-5-pro` |
| `imagen-4-fast`, `imagen-4`, `imagen-4-ultra` | `nano-banana-2` |
| `wan-2.7`, `gemini-omni-video` | `seedance-2` |

This is not merely a wording issue. The borrowed playbooks can encode the wrong negative-prompt policy, reference syntax, edit behavior, timing structure, or audio structure.

## Code-level diagnosis of the current enhancer

The present system has a sound high-level shape—planner, structured output, deterministic compiler, safeguards, and warnings—but its intermediate representation is narrower than the models it now serves.

| Current behavior | Evidence in the app | Consequence |
|---|---|---|
| Alias table is also the enhancement allowlist | `src/lib/prompt-enhancer.ts:327` | Adding a generation model without a prompt profile produces a 400 until it is aliased; the emergency alias then silently defines its grammar |
| One generic image schema/compiler serves nearly every structured image target | `ImagePromptSpec` and `compileNanoBananaProPrompt`; dispatch at `src/lib/prompt-enhancer.ts:1701` | No native Seedream/Qwen/Wan edit contract, reference-role map, region instruction, batch intent, or model-specific length policy |
| One generic video schema lacks task and media semantics | `VideoScenePlan` at `src/lib/prompt-enhancer.ts:79` | Cannot encode reference/edit/extend task type, typed asset roles, attributed voice/language, special audio syntax, or contiguous time intervals |
| Seedance compilation resolves one shot | `resolveVideoShot` and `compileSeedancePrompt` at `src/lib/prompt-enhancer.ts:1451` and `:1566` | With no `shotIndex`, every planned shot after the first is discarded; no `Shot N` or Seedance 2.5 timeline is emitted |
| The UI computes reference-video presence but omits it from video enhancer context | `src/app/create-workflow/WorkflowNodeEditors.tsx:1242` and `:1268` | The planner cannot reliably distinguish a reference-video workflow; reference audio is not represented either |
| Handled image references force append-only enhancement | `src/app/create-workflow/WorkflowNodeEditors.tsx:1262/:1288`; rules at `src/lib/prompt-enhancer.ts:865` | The raw prompt must remain verbatim and only one short sentence may be appended, blocking the role-map/task-classification rewrite needed most for multi-reference work |
| Image quality inspection returns 100 for every non-empty image prompt | `src/lib/prompt-quality.ts:82` | Exact-copy, edit locality, reference-role, constraint, and provider-length failures are invisible |
| Parsed-output failure is treated as a successful raw enhanced prompt | `src/lib/prompt-enhancer.ts:1688` | A provider or JSON failure can consume credits and return unvalidated prose instead of failing/refunding |

The urgent architectural fix is therefore not “write a better system prompt.” It is to widen the intermediate representation, compile by exact target and task, and validate the compiled contract before charging or generating.

## Registered model inventory

### Image models

| App model | App-visible mode and important limits | Research family |
|---|---|---|
| Nano Banana 2 Lite | generation/editing; 1K; up to 10 app references | Google Gemini image |
| Nano Banana 2 | generation/editing; 1K–4K; up to 14 app references; Search toggle | Google Gemini image |
| Nano Banana Pro | generation/editing; 1K–4K; up to 8 app references | Google Gemini image |
| GPT Image 2 | generation/editing; app exposes up to 16 inputs | OpenAI GPT Image |
| Seedream 5 Pro | generation/editing; 1K–2K; up to 10 inputs | ByteDance Seedream |
| Seedream 5 Lite | generation/editing; 2K–3K; up to 14 inputs | ByteDance Seedream |
| Wan 2.7 Image | generation/editing; 1K–2K; up to 9 inputs | Alibaba/Wan distributor route |
| Wan 2.7 Image Pro | generation/editing; 1K–4K; up to 9 inputs | Alibaba/Wan distributor route |
| Imagen 4 Fast | prompt-only; 1K | Google Imagen |
| Imagen 4 | prompt-only; 1K | Google Imagen |
| Imagen 4 Ultra | prompt-only; 1K | Google Imagen |
| Ideogram V3 | generation plus one remix input; typography focus | Ideogram |
| FLUX.2 Pro | generation/editing; 1K–2K; up to 8 inputs | Black Forest Labs |
| Z-Image | prompt-only; 1K | Tongyi-MAI |
| Grok Imagine | generation or one-image edit; multi-output | xAI Imagine |
| Grok Imagine 2.0 | prompt-only in this app route | xAI Imagine |
| Qwen Image 3.0 | generation/editing; 1K–2K; up to 10 inputs | Qwen Image |
| Qwen Image 3.0 Pro | generation/editing; 1K–2K; up to 10 inputs | Qwen Image |
| Ideogram Character | reference-required; up to 4 character images | Ideogram |

### Video models

| App model | App-visible mode and important limits | Research family |
|---|---|---|
| Kling 3.0 Cinematic | single/multi-shot; 3–15s effective range; native-audio option | Kling Video 3.0 |
| Kling 3 Turbo | single shot; 3–15s; no app sound toggle | Kling Video 3.0 Turbo |
| Seedance 1.5 Pro | 4/8/12s; fixed-lens option; generated audio | ByteDance Seedance |
| Seedance 2 | 4–15s; image/video/audio references; up to 4K | ByteDance Seedance |
| Seedance 2 Fast | 4–15s; image/video/audio references; 480p/720p | ByteDance Seedance |
| Seedance 2 Mini | 4–15s; multimodal references; 480p/720p | ByteDance Seedance |
| Wan 2.7 | 2–15s; frames plus multimodal references; no sound toggle | Alibaba/Wan distributor route |
| HappyHorse 1.1 | 3–15s; text/frame/up to 9 references | Alibaba HappyHorse distributor route |
| Gemini Omni Video | 4/6/8/10s; images or one app reference clip | Google Gemini Omni Flash |
| Hailuo 2.3 | image-to-video only in app; 6/10s; Standard/Pro | MiniMax Hailuo |
| Veo 3.1 | 8s; Lite/Fast/Quality; frame/reference modes | Google Veo |
| Grok Imagine Video | 6–30s; Normal/Fun; frame or text | xAI Imagine |
| Seedance 2.5 | 4–30s; image/video/audio references; 480p/720p | ByteDance Seedance |
| Kling O3 | app route is Kling 3.0 Omni; named subjects; multi-shot; up to 4K | Kling Video 3.0 Omni |
| MiniMax H3 | 4–15s; text/keyframe/reference modes; 768P/2K | MiniMax H3 |

### Motion-control models

| App model | App-visible mode and important limits | Research family |
|---|---|---|
| Kling 2.6 Motion Control | character image + motion video; 3–30s; image/video orientation modes | Kling Motion Control |
| Kling 3.0 Motion Control | character image + motion video; 3–30s; enhanced facial element support | Kling Motion Control |

### Exact registry coverage audit

- **19 image IDs:** `nano-banana-2-lite`, `nano-banana-2`, `nano-banana-pro`, `gpt-image-2`, `seedream-5-pro`, `seedream-5-lite`, `wan-2.7-image`, `wan-2.7-image-pro`, `imagen-4-fast`, `imagen-4`, `imagen-4-ultra`, `ideogram-v3`, `flux-2-pro`, `z-image`, `grok-imagine-image`, `grok-imagine-image-2`, `qwen3`, `qwen3-pro`, `ideogram-character`.
- **15 video IDs:** `kling-3.0-video`, `kling-3.0-turbo`, `seedance-1.5-pro`, `seedance-2`, `seedance-2-fast`, `seedance-2-mini`, `wan-2.7`, `happyhorse-1.1`, `gemini-omni-video`, `hailuo-2.3`, `veo-3.1`, `grok-imagine-video`, `seedance-2-5`, `kling-o3`, `minimax-h3`.
- **2 motion IDs:** `kling-2.6`, `kling-3.0`.

All 36 IDs are covered by an inventory row, a family guide, a writer/preprocessor recommendation, and an implementation disposition in this report. Family-level guidance is shared only where the researched provider contract is actually shared; route-specific caveats remain explicit.

## Prompt-writer routing: evidence-backed conclusion

The table below answers “is a specific AI model better for writing prompts for this target?” It distinguishes a documented first-party path from a plausible but unproven preference.

| Target family | Preferred writer/preprocessor | Evidence and confidence |
|---|---|---|
| Qwen Image | Qwen's own prompt-rewrite workflow: a current Qwen Plus/Max-class writer, with a vision-capable Qwen for edits | High: first-party code uses `qwen-plus` for T2I and `qwen-vl-max-latest` for image-aware edits |
| Wan | `qwen3.6-plus` with Wan's published prompt formula; use a vision-capable Qwen path for I2V/R2V | Very high: Alibaba explicitly recommends this writer path for Wan 2.7 |
| Ideogram | Ideogram Magic Prompt when expansion is wanted; keep it off for already precise production prompts | High: first-party product documentation; internal LLM is not disclosed |
| FLUX.2 Pro | Built-in `prompt_upsampling` when ideation/expansion is wanted; direct 30–80 word prompt for controlled production work | High: first-party documentation; upsampler model is not disclosed |
| Grok Imagine image | Grok 4.6 with the xAI image-generation tool | High: xAI documents it writing the prompt and aspect ratio for current Image 2.0; parity with older KIE aliases must be tested |
| Grok Imagine video | Grok 4.6 is the most natural same-vendor candidate, but xAI has not published an equivalent video prompt-writer comparison | Medium; recommendation is an inference from current xAI orchestration |
| MiniMax H3 | Official H3 Context-IR when available; otherwise the official `h3-prompt-writing` skill with a genuinely multimodal instruction-following LLM | Very high for Context-IR: first-party architecture and skill. MiniMax does not claim that a named external LLM is uniquely best |
| Google Gemini image | The selected Gemini image model's integrated conversational reasoning; use an external Gemini only for a genuinely complex brief | High for integrated operation; no evidence that a second rewrite improves routine edits |
| Google Imagen 4 | Imagen's built-in prompt rewriter for sparse concepts; disable it where possible for exact or already complex prompts, especially Fast | High for native behavior; the app routes require immediate operational verification after first-party deprecation |
| Google Veo | Constraint-preserving Gemini compiler followed by Veo's mandatory native rewriter; Flash for throughput, stronger Gemini only after evaluation | High for the provider architecture; medium for the exact external Gemini checkpoint |
| Google Gemini Omni | Omni itself; for edits use one compact change plus preservation clause rather than creative expansion | High: first-party integrated reasoning and conversational-edit contract |
| GPT Image 2 | Responses image-generation auto-revision; GPT-5.6 Sol for highest-quality orchestration or Terra for a balanced production lane, then direct Image API when the exact image model must be fixed | High for tool compatibility/auto-revision; medium for Sol-over-Terra as a writer choice because OpenAI publishes no prompt-writer leaderboard |
| Kling Video/Motion | Kling's internal Prompt Enhancer where the routed product applies it; externally, a strong multimodal LLM using the exact Kling shot/element/motion contract | High that Kling has an internal multimodal-LLM enhancer; it publishes no recommended named public LLM |
| Seedream | Native `optimize_prompt_options` (`standard`; Pro also has `fast`) for ordinary briefs; Seed2.1 Pro is a first-party-aligned candidate for complex multimodal planning | High for native optimization; medium for Seed2.1 because ByteDance publishes no head-to-head writer study |
| Seedance 1.5/2/2.5 | Exact 1.5 guide or official `sd2-pe`/packaged `sd25-pe` skill, run by a capable text/multimodal host; Seed2.1 Pro is a plausible same-vendor host | Very high for the exact schemas/skills; medium for Seed2.1 because ByteDance names no uniquely best writer LLM |
| Hailuo 2.3 | Its built-in, unnamed `prompt_optimizer` for casual input; a deterministic Hailuo compiler with the optimizer disabled for exact direction | High in the first-party API. The KIE routes used by the app do not expose the optimizer toggle, so their rewrite behavior must be tested |
| Z-Image | The official enhancer template with `qwen3-max-preview` or its current Qwen3 Max successor | High for Z-Image Turbo's first-party Space; medium for the app's unverified bare `z-image` alias |
| HappyHorse 1.1 | A Qwen Plus/Max-class writer using Alibaba's official HappyHorse prompt repository; use vision capability for I2V/R2V | High that the model is Alibaba and the prompt contract is official; medium for the exact writer checkpoint |

The practical recommendation is **not** to call a different commercial LLM for every request. Use provider-native expansion only where it is exposed and valuable; otherwise route a shared high-quality planner through exact model schemas and run target-specific evals. The current `gemini-3-flash` planner may remain a cost-effective default if it passes those evals, but its current success is not established by the heuristic quality score.

## Cross-model prompt compiler contract

Every exact model profile should declare these fields:

```text
model identity and provider route
generation mode: text / edit / first frame / first+last / references / motion
prompt language and maximum effective length
positive-vs-negative instruction policy
literal text policy and quoting rules
reference labels, roles, capacity, and preservation rules
edit syntax: change list + invariant list
shot mode: single / automatic multi-shot / explicit storyboard
timeline syntax and duration budget
camera vocabulary
audio, dialogue, voice, music, and ambience syntax
unsupported controls and conflict rules
native prompt expansion/preprocessor availability
deterministic validation and quality checks
```

The planner should return meaning, not prose polish. A deterministic compiler should then produce the exact grammar required by the selected model.

## Evaluation needed before choosing a universal writer

Web research cannot prove that one prompt-writing LLM yields the best images or videos in this app. Run an app-level evaluation with the same creative intent compiled by candidate writers.

### Candidate writer lanes

1. Current `gemini-3-flash` planner.
2. A stronger general multimodal reasoning model.
3. Provider-native path where documented: Qwen rewrite/extension, Seedream optimization, Seedance `sd2-pe`/`sd25-pe`, Ideogram Magic Prompt, FLUX upsampling, Grok Imagine tool, H3 Context-IR or official skill.
4. Deterministic template-only baseline.

### Test set

- 8–12 prompts per family, including generation, edit, text-in-image, identity preservation, products, people, first/last frame, multi-reference, dialogue, ambient sound, single take, multi-shot, and motion transfer.
- Easy, ambiguous, overloaded, contradictory, and adversarial inputs.
- The exact context available in web and mobile clients.

### Metrics

- Human-rated intent preservation, prompt adherence, identity/reference preservation, text accuracy, motion continuity, audio/dialogue correctness, and unwanted additions.
- First-pass acceptance, retry rate, revert rate, edit distance from the user's intent, latency, and total provider cost to an accepted result.
- Schema validity and deterministic lint failures before generation.

A writer wins only if it improves accepted generation outcomes—not because its prompt is longer or sounds more cinematic.

## First-party prompting guides and model-family findings

### Google Nano Banana family

Google's current image guide identifies the app's three variants as distinct operating points:

- **Nano Banana 2 Lite (`gemini-3.1-flash-lite-image`)** is the throughput/latency choice. Keep one decisive visual concept, avoid reference-heavy planning, and use it for drafts and high-volume edits.
- **Nano Banana 2 (`gemini-3.1-flash-image`)** is the general workhorse. Use a clear subject, setting, action, composition, lighting, and intent; assign reference roles explicitly; iterate in small changes.
- **Nano Banana Pro (`gemini-3-pro-image`)** is for complex professional assets, world knowledge, layout, typography, and high-fidelity multi-reference work. More structured art direction is justified here than for Lite.

Across the family, Google recommends hyper-specific descriptions, context and intended use, stepwise handling of complex scenes, semantic positive descriptions instead of tag piles, and camera language for photographic control. For text, quote exact copy and keep the desired layout explicit. For edits, specify the change and what must remain fixed, then iterate narrowly.

Sources: [Google Gemini image generation guide](https://ai.google.dev/gemini-api/docs/image-generation).

### Google Imagen 4 family

The usable Imagen grammar is concise: **subject + context/background + style**, extended with composition, lighting, and exact short text where needed. Google's guide recommends clear descriptive language and iterative refinement. Text works best when short (roughly 25 characters or fewer and no more than a few phrases), with placement and style stated explicitly.

Important variant note: Google's generation documentation warns that Imagen 4 Fast can produce unwanted results for complex prompts when its own prompt enhancement is enabled. Do not stack an aggressive external rewrite on top of provider enhancement without an eval; disable one of the two for already detailed prompts.

Operational note: the current Google Gemini image guide states that Imagen models were deprecated and scheduled to shut down on 2026-08-17. Verify the KIE routes immediately and plan migration to Nano Banana even if the distributor endpoints still respond.

Sources: [Google Imagen prompt guide](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/image/img-gen-prompt-guide), [Imagen generation settings](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/image/generate-images), [current Gemini image model selection and Imagen deprecation](https://ai.google.dev/gemini-api/docs/image-generation#model-selection).

### OpenAI GPT Image 2

OpenAI's current production guide recommends a stable order: **background/scene → subject → key details → constraints**, with intended use such as ad, UI mockup, or infographic. Use labeled sections for complex creative briefs. State framing, angle, light, material, placement, and invariants directly.

For edits, use “change only X” and repeat what must stay unchanged on each turn. For multi-image compositing, identify each input by index and purpose, then specify how the inputs interact. Put literal text in quotes or all caps, define typography and placement, and spell unfamiliar words letter by letter if necessary. Small targeted follow-ups are easier to debug than one overloaded prompt. GPT Image 2 already treats input fidelity as high, so legacy fidelity flags are unnecessary.

The Responses image-generation tool automatically revises the prompt and exposes `revised_prompt`. For the strongest first-party orchestration lane, use GPT-5.6 Sol with that tool; use Terra for a balanced production lane. If the app must guarantee `gpt-image-2`, let the text model produce the structured brief and call the Image API directly. OpenAI publishes no prompt-rewriter leaderboard, so the Sol/Terra tradeoff is a product-positioning inference, not a measured prompt-writing result.

Sources: [GPT Image 2 model page](https://developers.openai.com/api/docs/models/gpt-image-2), [official GPT Image generation prompting guide](https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide).

### ByteDance Seedream 5 Pro and 5 Lite

Seedream uses ordinary natural-language instructions, not tag soup. A reliable generation order is **purpose/output → primary subject and observable action → environment → composition/framing → style/palette/light/material → exact text → narrow constraints**. BytePlus recommends keeping English prompts below 600 words. Typography briefs should quote every literal string and specify language, position, hierarchy, treatment, and the surrounding visual structure.

For edits, identify one target, the exact located change, and the invariants. Then describe physical integration only where needed: perspective, occlusion, reflections/refraction, and shadows. For multiple references, assign each input one non-overlapping role. A production form is:

```text
Image 1 is the target and identity/composition anchor. Image 2 supplies [outfit/style/material].
Keep [identity, pose, layout, untouched areas] unchanged. Change only [located object/region]
from A to B; update [perspective, occlusion, reflections and shadows] naturally.
```

Pro and Lite should not be aliases. **Pro** supports 1K/2K single-output generation/editing, an interactive region-edit workflow, and prompt optimization modes `standard` and `fast`. **Lite** adds a reasoning-led general workflow, standard optimization, streaming, one-or-many outputs, and native 2K/3K/4K support, with references plus outputs capped at 15 on the documented route. The app's 14-reference, 2K/3K surface is therefore a conservative distributor contract, not the full native limit. Lite is especially suited to vague world-knowledge/spatial tasks and fast iterations, but a precise edit should still remain short and local.

Use Seedream's native `optimize_prompt_options` for ordinary briefs instead of emulating it through prose inflation. For complex multi-reference planning, Seed2.1 Pro is the strongest same-vendor multimodal host candidate found; that is an inference from its visual/video/spatial understanding, not a published prompt-writing comparison. Never invent coordinates or region markers that the user/provider did not supply.

Sources: [Seedream 5 Pro release](https://seed.bytedance.com/en/blog/beyond-generation-it-understands-design-introducing-seedream-5-0-pro), [Seedream 5 Pro guide/API](https://docs.byteplus.com/api/docs/ModelArk/1824121), [Seedream 5 Lite release](https://seed.bytedance.com/en/blog/deeper-thinking-more-accurate-generation-introducing-seedream-5-0-lite), [Seedream 5 Lite product page](https://seed.bytedance.com/seedream5_0_lite), [Seed2.1](https://seed.bytedance.com/en/seed2_1).

### ByteDance Seedance 1.5 Pro

The official formula is **subject + movement + environment + camera movement + aesthetic + sound**. Start with the opening composition, name one stable subject, describe the visible action/emotional progression, choose one camera path with speed/amplitude and an end composition, then add sound.

Attribute dialogue to a stable speaker and give the exact line, language/dialect, timbre, emotion, intonation, and rate only when those details matter. Keep BGM, ambience, and source-specific SFX distinct. For multiple shots use `Shot 1`, `Shot 2`; for VFX state the start condition, transformation process, final state, material behavior, and SFX. A fixed-lens API selection overrides a contradictory camera-motion sentence, so the compiler should omit the motion rather than rely on conflict resolution.

Do not put ratio, resolution, duration, FPS, or provider toggles into the prose. There is no separate negative field on the researched app route; write desired visible/audio outcomes directly. Known weak cases—complex simultaneous motion, many characters, and singing—should be simplified rather than hidden behind extra adjectives.

Sources: [Seedance 1.5 Pro release](https://seed.bytedance.com/en/blog/sound-and-vision-all-in-one-take-the-official-release-of-seedance-1-5-pro), [official prompt guide](https://docs.byteplus.com/en/docs/ModelArk/2168087), [KIE Seedance 1.5 route](https://docs.kie.ai/market/bytedance/seedance-1-5-pro).

### ByteDance Seedance 2, 2 Fast, and 2 Mini

The 2.0 family is a reference compiler, not merely a cinematic prose model. Put an asset-role map first—identity/subject, scene/tone, camera/action rhythm, audio/timbre—then a one-sentence overall brief and `Shot N` blocks. Use stable subject labels with two or three identifying traits, repeat those labels instead of pronouns, and choose one camera move per shot. The guide recommends roughly four or five well-chosen assets even though more can be accepted.

Task wording changes model behavior:

```text
Reference: @Image1 controls identity; @Video1 controls camera/action rhythm only.
Edit: Strictly edit @Video1: change A to B; keep all unmentioned content unchanged.
Extend: Extend @Video1 forward/backward; preserve identity, scene, style, ambience and motion phase.
```

Use the exact handles exposed by the provider/app; never emit raw storage IDs or invent missing refs. Put music in `( )`, SFX in `< >`, dialogue in `{ }`, and subtitles in `〖 〗` only when that syntax survives the routed API. Native 2.0 can accept up to nine images, three videos, and three audio files, with total video/audio duration no more than 15 seconds; app limits may be narrower. Standard reaches 4K; Fast and Mini are 480p/720p. Fast/Mini benefit from simpler briefs, but “shorter is always better” is an engineering heuristic, not an official grammar difference.

BytePlus now publishes a first-party `sd2-pe` skill. It performs task classification and schema compilation rather than generic paraphrasing. It does not endorse a particular LLM. A text-only host must preserve labels without claiming to inspect assets; a multimodal host should actually inspect and map them.

Sources: [Seedance 2.0 release](https://seed.bytedance.com/en/blog/official-launch-of-seedance-2-0), [official 2.0-family guide](https://docs.byteplus.com/api/docs/ModelArk/2222480), [official `sd2-pe` tutorial](https://docs.byteplus.com/en/docs/ModelArk/2291680), [BytePlus enhanced-video API matrix](https://docs.byteplus.com/en/docs/byteplus_las/video_gen_enhanced), [KIE Seedance 2 route](https://docs.kie.ai/market/bytedance/seedance-2).

### ByteDance Seedance 2.5

Seedance 2.5 must not inherit the 2.0 compiler. Its native surface supports up to 30 seconds, multi-round extension, richer multi-view references, and a much larger documented asset envelope (up to 30 images, 10 videos, and 10 audio files). The app's 5/3/3 limit is a KIE/app limit and should be labeled that way.

Compile 2.5 as **numbered asset-role map → one-sentence overall event/style/camera → contiguous integer-second timeline → preservation clauses**. Time intervals must cover the requested duration without gaps or overlap. Keep dialogue/SFX adjacent to the speaker/action. For strict keyframe sequences, use independent images in order; for edits, identify the exact video, interval, A→B change, and everything outside that interval that remains unchanged. Extension starts from the observed final frame and preserves the existing identity, scene, style, ambience, and motion phase.

The official `sd25-pe` 0.1.1 package is the best exact enhancement contract found. It recompiles by task template; preserves intent, subject count, causality, edit target, and extension direction; gives each activated asset exactly one role; calls out readable but unused assets; and keeps parameters outside prompt text. It returns one submission-ready prompt and does not auto-append “4K,” generic stability packs, watermarks, subtitles, duplicate constraints, or a negative bundle. It asks one consolidated question only when ambiguity materially changes the output. Crucially, it works with any capable host and names no preferred LLM.

Sources: [Seedance 2.5 release](https://seed.bytedance.com/en/blog/one-take-creation-flexible-referencing-introducing-seedance-2-5), [official 2.5 guide and `sd25-pe` install](https://docs.byteplus.com/en/docs/ModelArk/2607689), [official skill index](https://arkdocs-en.tos-ap-southeast-1.volces.com/skills/.well-known/agent-skills/index.json), [current `sd25-pe` 0.1.1 artifact](https://arkdocs-en.tos-ap-southeast-1.volces.com/skills/artifacts/video-generation/sd25-pe/0.1.1/sd25-pe-0.1.1.zip).

### Black Forest Labs FLUX.2 Pro

Use **subject + action + style + context**, with critical content early. First-party guidance says 30–80 words is usually a useful range. State the desired positive condition rather than a negative prompt. Add camera, lens, film-stock, light, and material details only when they control the intended result.

Quote literal text and specify placement/style/size/color. FLUX supports structured/JSON-like prompts and hex colors. For multiple references, assign one role to each input and avoid contradictory transformations. Built-in prompt upsampling is a first-party expansion path, but controlled production prompts should be tested with it both on and off.

Black Forest Labs' official CLI uses `mistralai/pixtral-large-2411` for external upsampling; its local fallback uses `Mistral-Small-3.2-24B-Instruct-2506`. These are the strongest documented external writer candidates for FLUX, but simple/direct prompts often do not improve. Use upsampling for incomplete briefs, text/diagram/reference interpretation, and other reasoning-heavy layouts; keep it off for identity-, logo-, or detail-locked work.

Sources: [FLUX.2 prompting guide](https://docs.bfl.ai/guides/prompting_guide_flux2), [official FLUX.2 repository](https://github.com/black-forest-labs/flux2), [prompt-upsample documentation](https://github.com/black-forest-labs/flux2/blob/main/docs/flux2_with_prompt_upsampling.md).

### Ideogram V3 and Ideogram Character

Ideogram responds best to natural sentences, not weights or hidden syntax. Put the highest-priority concept early. Its recommended structure is **image summary → main subject details → pose/action → secondary elements → setting/background → lighting/atmosphere → framing/composition → technical finish**.

Keep prompts under roughly 150–160 words/200 tokens because later content may be ignored. Put exact text early and in quotation marks, describe placement and visual treatment, and reduce background complexity when typography is critical. In the main prompt, express desired positive states (“empty street,” “clean-shaven”) rather than “no people” or “without a beard.” Use the separate negative-prompt control for exclusions when the route exposes it.

Magic Prompt uses Ideogram's built-in language model to expand or translate a prompt. It is useful for sparse ideation, but precise prompts should be tested with Magic Prompt off to avoid unwanted invention. Character mode additionally requires a real reference asset; prose cannot replace the character anchor.

Sources: [Ideogram prompt structure](https://docs.ideogram.ai/using-ideogram/prompting-guide/3-prompt-structure), [prompting fundamentals](https://docs.ideogram.ai/using-ideogram/prompting-guide/2-prompting-fundamentals), [text and typography](https://docs.ideogram.ai/using-ideogram/prompting-guide/2-prompting-fundamentals/text-and-typography), [Magic Prompt](https://docs.ideogram.ai/using-ideogram/generation-settings/magic-prompt).

Ideogram Character is a specialized reference workflow, not a Seedream-like general editor. First-party Ideogram allows one character-reference image with an optional mask; the KIE/app route advertises up to four, so references 2–4 are provider-specific and need testing. Use a clear, well-lit, slightly angled portrait. Prompt the new action, pose, clothing changes, scene, framing, and light; do not redescribe face/hair unless they should change. Color Palette, negative prompt, seed, and style reference are unavailable in the native Character workflow. Keep Magic Prompt off for identity-locked remix/edit work.

Source: [Ideogram Character Reference guide](https://docs.ideogram.ai/using-ideogram/generation-settings/character-reference).

### Qwen Image 3.0 and 3.0 Pro

Qwen Image prefers fluent natural-language briefs over tag piles. Use **image type/style → subject/count/appearance/material → action/pose → scene/spatial relationships → camera/composition → light/palette/texture → exact text/layout**. Quote every visible string and specify placement, hierarchy, language/case, font treatment, color, and size.

For edits, state the minimum sufficient change, the target image/region, and the invariants. For multiple images, identify every input's role explicitly. Preserve identity-critical traits and do not introduce facial changes the user did not request.

Qwen exposes both `negative_prompt` and `prompt_extend` on its native Pro API. Extension is appropriate for short/simple ideas, not for a complete production brief. The app currently hardcodes `prompt_extend:true` after performing its own enhancement, creating a double-rewrite risk, and it does not forward a separate negative prompt.

First-party prompt-enhancement code is unusually specific: T2I rewriting uses `qwen-plus`; image-aware edit rewriting uses `qwen-vl-max-latest`. It classifies portrait, text-containing, and general prompts, preserves proper nouns, quotes visible text, and adds only logically consistent detail. This is stronger evidence than the app's current mapping to Seedream 5 Pro.

The native Pro API documents one to three input images, while KIE advertises up to ten. Treat inputs 4–10 as a KIE-specific capacity and test identity/role adherence rather than assuming native parity.

Sources: [Qwen Image repository](https://github.com/QwenLM/Qwen-Image), [Qwen prompt rewrite rules](https://github.com/QwenLM/Qwen-Image/blob/main/src/examples/tools/prompt_utils.py), [newer Qwen prompt enhancer](https://github.com/QwenLM/Qwen-Image/blob/main/src/examples/tools/prompt_utils_2512.py), [Qwen Image generation/edit API](https://www.alibabacloud.com/help/en/model-studio/qwen-image-generation-and-editing-api-reference).

### Wan 2.7 Image and Image Pro

Wan 2.7 Image supports text generation, multi-image editing/fusion, local bounding-box edits, and sequential image sets. The app uses the non-sequential path with up to nine images and disables `thinking_mode`.

For generation, use **subject + attributes/material + action + setting + composition/camera + lighting + palette + style + exact visible text**. For edits, identify images by order and role: “apply the graphic from image 2 to the car in image 1,” followed by blending/light and invariants. A local edit names the target image/region, replacement, and everything outside the region that must remain unchanged. Sequential work must enumerate each output and repeat identity/style anchors.

The API has no separate negative or prompt-extension field; put concise exclusions in the main instruction. `thinking_mode` is the native quality mechanism for text-only non-sequential generation and defaults on first-party. Consider enabling it for eligible app requests instead of adding more external prose.

Pro shares the same grammar, with 4K available for text-to-image only; editing/sequential work remains capped at 2K. The app's existing rejection of 4K reference edits is therefore source-aligned.

Sources: [Wan image generation/edit API](https://www.alibabacloud.com/help/en/model-studio/wan-image-generation-and-editing-api-reference), [Wan image overview](https://www.alibabacloud.com/help/en/model-studio/text-to-image), [official Wan 2.7 image skill](https://github.com/Wan-Video/Wan-skills/tree/main/skills/wan2.7-image-skill).

### Z-Image

The public first-party API exposes `z-image-turbo`, while the app/KIE uses a bare prompt-only `z-image`; the exact checkpoint is therefore not proven. For Turbo, front-load subject identity/count, action, color, and visible text, then composition, lens/camera, depth, lighting, material, palette, setting, and style. Avoid metaphorical filler and empty “8K masterpiece” quality spam. Quote exact text.

Z-Image Base and Turbo differ materially: open-weight Base supports and benefits from a separate negative prompt; the hosted Turbo API does not document one and instead supports prompt extension. Do not apply Base's negative policy to an assumed Turbo route without verifying the alias.

The official Z-Image Turbo Space uses `qwen3-max-preview` plus a first-party enhancement system prompt. This makes a current Qwen3 Max-class model the strongest documented writer for Turbo, but the app should first establish that its bare route is Turbo.

Sources: [Z-Image repository](https://github.com/Tongyi-MAI/Z-Image), [Z-Image Turbo API](https://www.alibabacloud.com/help/en/model-studio/z-image-api-reference), [official enhancer code](https://huggingface.co/spaces/Tongyi-MAI/Z-Image-Turbo/blob/main/pe.py).

### Wan 2.7 Video

Wan's official basic formula is **entity + scene + motion**; the advanced formula adds entity/scene detail, motion amplitude/speed/effect, aesthetics, and style. For image-to-video, describe motion and camera rather than repeating the static frame. Use “fixed camera” when that is the real constraint.

Reference-to-video uses exact, separately numbered `Image 1`, `Image 2`, `Video 1`, and so on. Sound prompts name the sound source; dialogue specifies exact line, speaker, emotion, tone, speed, timbre/accent; BGM names a musical style. “No dialogue” and “No background music” are documented suppression phrases.

First-party Wan 2.7 supports both multi-shot and audio, while the app declares neither. For multi-shot, write an overall summary plus numbered/timestamped shots; explicitly say “Generate a single-shot video” when cuts are unwanted. Positive prompts can be up to 5,000 characters and negative prompts 500. Avoid real-person names, rapid state changes within one shot, exact small text, long action chains, and promises of exact lip sync.

Alibaba explicitly recommends supplying the prompt formula to `qwen3.6-plus`. Older official code used `qwen-plus` for T2V and `qwen-vl-max` for I2V, corroborating the Qwen-family route. The app currently enhances with Gemini and then hardcodes `prompt_extend:true`; choose one enhancement path for already detailed input.

Sources: [Wan prompt guide](https://www.alibabacloud.com/help/en/model-studio/text-to-video-prompt), [Wan T2V API](https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference), [Wan I2V API](https://www.alibabacloud.com/help/en/model-studio/image-to-video-general-api-reference), [Wan R2V API](https://www.alibabacloud.com/help/en/model-studio/wan-video-to-video-api-reference), [official Wan prompt extension](https://github.com/Wan-Video/Wan2.2/blob/main/wan/utils/prompt_extend.py).

### HappyHorse 1.1

HappyHorse 1.1 is verifiably an Alibaba model, not an unidentified third-party brand. Alibaba's own announcement and Model Studio prompt repository document it. It supports T2V, first-frame I2V, and one-to-nine-image reference video with native audio/video co-generation.

For T2V, use **duration + style/atmosphere + setting + subjects + ordered action/shot sequence + camera + dialogue/audio + global consistency/exclusions**. For I2V, minimally describe what happens after the first frame; do not repeat its static content. For references, use exact `[Image 1]`, `[Image 2]` syntax and name the referenced object (“the woman in the red qipao in [Image 1]”). This is different from both Wan's unbracketed labels and Kling's `@handles`.

HappyHorse 1.1 can schedule six to eight continuous scenes in one prompt. For a storyboard, state panel order, visual style, character/product definitions, each shot, transitions, and global invariants. Dialogue must identify speaker and vocal delivery. Exclusions stay in the main prompt because the native API exposes neither `negative_prompt` nor `prompt_extend`.

The app declares no sound and no multi-shot and currently compiles HappyHorse as Kling. Verify which native abilities the KIE routes retain; regardless, give it its own reference grammar now. A vision-capable Qwen Plus/Max-class writer using the official repository is the most ecosystem-aligned option, although Alibaba does not name a unique internal writer.

Sources: [Alibaba HappyHorse 1.1 announcement](https://www.alibabacloud.com/blog/happyhorse-gets-stronger-motion-expressiveness-higher-generation-consistency-and-enhanced-visual-quality_603293), [official HappyHorse prompt repository](https://github.com/modelstudioai/awesome-happyhorse-prompts), [T2V API](https://www.alibabacloud.com/help/en/model-studio/happyhorse-text-to-video-api-reference), [I2V API](https://www.alibabacloud.com/help/en/model-studio/happyhorse-image-to-video-api-reference), [R2V API](https://help.aliyun.com/en/model-studio/happyhorse-reference-to-video-api-reference).

### Google Veo 3.1

Google's fuller first-party anatomy is **style/type → composition/camera → exact subject appearance → ordered action → setting → lighting/ambience → lens/focus → quoted dialogue + SFX + ambient sound**. For reference-led video, choose an input closest to the intended opening and describe motion/evolution rather than re-captioning the frame. First/last/reference roles belong in API configuration, not invented prompt tags.

The current first-party surface supports 4/6/8 seconds, with 1080p, 4K, reference images, and some extension flows forcing eight seconds. The app exposes only eight seconds. Native audio is always on first-party even though the app catalog has no sound control. A prompt timeline must be feasible in the routed duration; lint dialogue length and action count instead of merely adding cinematic detail.

Critical double-rewrite fact: current Google Cloud documentation says Veo 3/3.1's LLM prompt rewriter cannot be disabled, and the rewritten prompt is returned only when the original is under 30 words. It adds video description, camera, transcription, and sound effects. The KIE route may hide or alter this behavior, so verify it; meanwhile the app's external enhancer should preserve constraints and fill missing official slots, not aggressively embellish a prompt that will be rewritten again.

Google recommends Gemini for Veo meta-prompting, and Google-owned reference implementations use Gemini to plan storyboards/prompts before Veo. A current Flash tier is the throughput candidate; a stronger Gemini tier may help complex branded storyboards, but only a generated-output eval can choose it. Persist any provider-returned rewritten prompt when available.

Sources: [Google Veo 3.1 guide and prompt guide](https://ai.google.dev/gemini-api/docs/veo#veo-prompt-guide), [DeepMind Veo prompt guide](https://deepmind.google/models/veo/prompt-guide/), [mandatory Veo prompt rewriter](https://cloud.google.com/vertex-ai/generative-ai/docs/video/turn-the-prompt-rewriter-off), [Google video-model routing overview](https://ai.google.dev/gemini-api/docs/video).

### Google Gemini Omni Video

Omni defaults to planning several shots. If a single take is required, say **“single continuous shot,” “single unbroken scene,” and “no scene cuts.”** Simple edit instructions work better than detailed re-descriptions; append **“Keep everything else the same.”** Ordinary negative instructions such as “No dialogue” belong in the main prompt because the API has no separate negative-prompt parameter.

Natural-language timing and `[0-3s]` timecode blocks are supported. Describe music, sound design, dialogue, and ambience explicitly. For media binding, use the documented `<FIRST_FRAME>` and `<IMAGE_REF_N>` roles or their explicit source/reference declarations. This is materially different from the Seedance playbook the app currently borrows.

Omni is an integrated reasoning-and-generation model whose response contains a thought/planning step. It should usually control its own prompt. Use an external Gemini only to organize a genuinely complex generation brief, then emit a compact direct instruction; for edits, bypass creative expansion and compile one change plus the preservation clause. The app must also respect Omni limitations: no separate negative parameter, no audio-reference upload, unreliable short video references in the current API, no multi-video reasoning, no extension/interpolation, and no voice editing.

Source: [Google Gemini Omni Flash prompt guide](https://ai.google.dev/gemini-api/docs/omni#gemini-omni-flash-prompt-guide).

### Grok Imagine Image, Image 2.0, and Video

The app's Grok routes must be distinguished from xAI's current first-party releases. `grok-imagine-image` is an older KIE market route; `grok-imagine-image-2` is text-only in the app even though current xAI Image 2.0 supports editing/references; `grok-imagine-video` lacks app audio controls and exposes a different duration/resolution/mode surface from current Video 1.5.

For image generation, use direct natural language: composition, subject, action, light, palette, mood, materials, and rendering style. For exact text, give the copy, hierarchy, placement, and typography. For edits and multi-reference work on a route that truly supports them, name each reference role, state the change, and list invariants.

xAI explicitly documents Grok 4.6 using the image-generation tool: it writes the prompt, chooses aspect ratio, and returns the written prompt. This is the strongest first-party evidence for a specific writer in the Grok family. It currently targets `grok-imagine-image-2.0`, so using it for the older KIE route is only family-aligned until tested.

For video, describe one coherent cinematic beat: subject, action, camera movement, pacing/timing, mood/light, and audio/dialogue only when the provider route supports it. Image-to-video should focus on motion and camera, not re-caption the still. xAI has not published an equivalent video prompt-writer model comparison; Grok 4.6 is a reasonable same-vendor candidate, not a proven winner.

Sources: [xAI Imagine capability guide](https://docs.x.ai/developers/model-capabilities/imagine), [Grok Imagine Image 2 release](https://x.ai/news/grok-imagine-image-2), [xAI image-generation tool](https://docs.x.ai/developers/tools/image-generation), [Grok Imagine Video 1.5 release](https://x.ai/news/grok-imagine-video-1-5).

### Kling Video 3.0, Turbo, and 3.0 Omni (`kling-o3`)

Kling 3.0 supports automatic and custom multi-shot generation. For explicit storyboards, write `Shot 1`, `Shot 2`, and so on, with duration, framing/angle, subject action, camera movement, and dialogue in each shot. Bind named elements and then reference the exact names consistently. Assign dialogue directly to its speaker and specify language/accent only when needed.

Kling's general first-party formula is **subject (description) + subject movement + scene (description) + optional camera, lighting, and atmosphere**. For image-to-video, reduce it to **subject movement + background movement** because the image already supplies identity and composition.

For a 15-second long take, use explicit time landmarks and a feasible progression. For a multi-shot result, budget each shot so the total fits the selected duration. On KIE, individual multi-shot items are 1–12 seconds, each has a 500-character prompt limit, and their durations must sum to the requested total. Kling 3.0 Omni uses `@Element`/`@Image`-style bindings in its first-party examples and supports voice-bearing character elements. Preserve provider handles byte-for-byte and reject nonexistent handles; do not silently translate them into a generic “reference image” paragraph.

Turbo should use the same scene vocabulary but a simpler single-shot plan. It should not inherit multi-shot, element-handle, end-frame, or audio requirements that its app route does not expose. Kling's first-party catalog describes Turbo as native-audio capable, while the KIE route and app expose no audio parameter; treat Turbo audio as an integration question until tested.

Kling research papers describe an internal multimodal-LLM Prompt Enhancer trained for the generator's expected distribution. They do not name or recommend GPT, Gemini, Claude, DeepSeek, or another public LLM. An external enhancer should therefore clarify intent and compile controls rather than stack ornamental prose on top of an unknown internal rewrite.

Sources: [Kling Video 3.0 guide](https://kling.ai/quickstart/klingai-video-3-model-user-guide), [Kling Video 3.0 Omni guide](https://kling.ai/quickstart/klingai-video-3-omni-model-user-guide), [Kling text-to-video prompt guide](https://kling.ai/quickstart/text-to-video-prompt-guide), [Kling image-to-video guide](https://kling.ai/quickstart/image-to-video-guide), [Kling API overview](https://kling.ai/document-api/apiReference%2Fmodel%2FvideoModels), [KIE Kling 3.0 route](https://docs.kie.ai/market/kling/kling-3-0), [Kling-Omni paper](https://arxiv.org/abs/2512.16776).

### Kling 2.6 and 3.0 Motion Control

The motion clip—not the text prompt—defines the primary action. Match full-body/half-body framing between the character image and the motion reference. Use one clear, continuously visible person, a single uncut motion clip, moderate speed, minimal displacement, and enough empty image space for the action.

In “orientation matches video,” body orientation, expression, and camera follow the motion reference; prompt only the remaining scene details. In “orientation matches image,” the prompt can control camera and other elements while the motion reference supplies movement and expression. Kling 3.0 facial element binding references face identity only, not clothing, hair, makeup, or props, so those invariants must remain in the character image/prompt.

Source: [Kling Motion Control guide](https://kling.ai/quickstart/motion-control-user-guide).

### MiniMax H3

H3 is the clearest example of a target that should never borrow a generic Kling prompt. The first-party skill defines five modes: T2VA, I2VA, FL2VA, L2VA, and full-reference Ref2VA.

Base modes require these fields in order:

```text
integrated_multimodal_description
overall_soundscape
non_diegetic_music
```

Full-reference mode requires:

```text
subject_definitions
summary
retention_analysis
detailed_description
overall_soundscape
non_diegetic_music
```

Shots must include composition, subjects, environment, action/state change, camera, sound, timing, and exact reference application. Reference labels must remain stable. Dialogue uses stable speaker IDs and `<d>[Language] ...</d>` notation. The hosted H3 Context-IR performs instruction parsing, cross-modal association, temporal reasoning, and semantic completion before H3-Base; when unavailable, the app should reproduce the published prompt contract rather than inventing cinematic prose.

Base-mode timing is also a formal contract: `[Shot 1]` has no timestamp; each later shot begins `[Shot N] At MM:SS.mmm, ...`; cut times must strictly increase and remain inside the requested duration. Use a camera move rather than a cut when only distance or angle changes. I2VA, first/last-frame, and last-frame modes have exact picture-alignment prefixes in the official guide, so a generic “start from the supplied image” sentence is not equivalent.

Ref2VA labels have distinct meanings:

- `<Subject N>` is reusable visible identity/style/content abstracted from one or more assets.
- `<Picture N>` is a concrete frame, keyframe, composition, or storyboard anchor.
- `<Video N>` is a source video to edit/continue or a temporal, camera, cut, or rhythm reference.
- `<Audio N>` is an intentionally copied or referenced audio signal. It is not implied merely because a video contains sound.

`retention_analysis` uses fixed preservation markers (`fully_preserved`, `partially_preserved`, `attribute_transfer`, `weak_reference`) and audio markers (`fully_copy`, `partially_copy`, `reference`, `weak_reference`). `summary` begins with explicit task types such as `keyframe completion`, `reference generation`, `video editing`, `video continuation`, `audio reuse`, and `audio reference`.

H3 natively generates stereo audio. Its prompt must therefore control `overall_soundscape` and `non_diegetic_music`, using `N/A` when silence/no score is actually intended. The app currently marks H3 `supportsSound: false`, classifies ordinary reference runs without frames as text-to-video, supplies no ordered image/video/audio role map to the enhancer, and compiles it through Kling. That loses the most important parts of H3's contract.

H3's encoder uses Qwen3-VL-32B hidden states, which makes Qwen a plausible compatibility candidate but **does not prove Qwen is the best prompt writer**. Context-IR is a separate private multi-stage system, and MiniMax publishes no external-writer comparison.

Sources: [official MiniMax H3 repository](https://github.com/MiniMax-AI/MiniMax-H3), [official H3 prompt-writing skill](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/SKILL.md), [base prompt guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md), [full-reference guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md).

### MiniMax Hailuo 2.3

The app exposes Hailuo 2.3 only as image-to-video, so the prompt should describe motion, camera, and change from the supplied first frame instead of rebuilding the still image. Hailuo's canonical command set is `[Truck left]`, `[Truck right]`, `[Pan left]`, `[Pan right]`, `[Push in]`, `[Pull out]`, `[Pedestal up]`, `[Pedestal down]`, `[Tilt up]`, `[Tilt down]`, `[Zoom in]`, `[Zoom out]`, `[Shake]`, `[Tracking shot]`, and `[Static shot]`. Do not emit the non-canonical phrase `[Push out]` found in one sequential example; the API enum says `[Pull out]`.

Multiple simultaneous moves can appear comma-separated inside one bracket, with a first-party recommendation of no more than three. Sequential moves can be placed in playback order around natural-language action. In practice, prefer one primary camera path unless a short sequence is feasible.

The first-party API has an unnamed `prompt_optimizer` enabled by default: keep it for casual input, but disable it for exact bracketed direction to avoid a second rewrite. The KIE Standard/Pro routes used by this app expose only prompt, image, duration, resolution, and safety settings; they do not expose `prompt_optimizer` or `fast_pretreatment`. The app therefore cannot currently choose raw versus provider-rewritten prompts, and should test whether KIE performs any hidden enhancement.

The app already enforces the main route limits: a start image is required; 1080P is limited to six seconds; ten seconds is available at 768P. The enhancer should lint those facts and avoid dialogue/audio direction because this app route does not expose generated sound.

Sources: [official MiniMax I2V API](https://platform.minimax.io/docs/api-reference/video-generation-i2v), [official Hailuo 2.3 launch](https://www.minimax.io/news/minimax-hailuo-23), [official MiniMax CLI model handling](https://github.com/MiniMax-AI/cli/blob/main/src/commands/video/generate.ts), [official MiniMax skill camera-command reference](https://github.com/MiniMax-AI/skills/blob/main/skills/frontend-dev/references/minimax-video-guide.md), [KIE Standard route](https://docs.kie.ai/market/hailuo/2-3-image-to-video-standard), [KIE Pro route](https://docs.kie.ai/market/hailuo/2-3-image-to-video-pro).

## GitHub, YouTube, and Reddit practitioner evidence

The links below were reviewed for implementation ideas and real-world failure modes. Except where explicitly labeled vendor-owned, they are **Tier D anecdotal evidence**: useful for forming tests, never sufficient to define a model contract or declare a winning prompt writer.

| Family | GitHub / reproducible implementation | YouTube evidence | Reddit evidence | What survives cautious review |
|---|---|---|---|---|
| Google Nano Banana | Google's [image-generation samples](https://github.com/google-gemini/generative-ai-js) are stronger than copied prompt collections | [Google's official Nano Banana prompt video](https://www.youtube.com/watch?v=UQsJIo46ZR8); [independent creator workflow](https://www.youtube.com/watch?v=RVKbR7JOTSw) | [community “ultimate guide”](https://www.reddit.com/r/PromptEngineering/comments/1pid4cs/nano_banana_pro_ultimate_prompting_guide/) | Iterative, reference-aware natural language is consistently useful; community “magic words” are not evidence |
| Seedream 5 | [community Seedream skill](https://github.com/penposs/seedream-5.0-skills/blob/main/seedream-5-pro-prompt/SKILL.md); [Replicate's tested guide](https://replicate.com/blog/how-to-prompt-seedream-5) | [Pro constraint/lighting tests](https://www.youtube.com/watch?v=HP0erEe2YAQ); [Lite mixed tests](https://www.youtube.com/watch?v=Hya5KNw7ESI) | [Pro exact-prompt stress test](https://www.reddit.com/r/AIGenArt/comments/1uskvc4/i_gave_seedream_50_pro_4_breakthrough_claims_to/); [week-of-use report](https://www.reddit.com/r/Bard/comments/1v556ax/seedream_50_pro_after_a_week_what_its_genuinely/) | Exact copy, located edits, explicit preservation, and assigned reference roles recur; dense simultaneous hard constraints still require output verification |
| Seedance | Official skills should lead; [large community 2.0 quick reference](https://github.com/Emily2040/seedance-2.0/blob/main/references/quick-ref.md) and [reference workflow](https://github.com/Emily2040/seedance-2.0/blob/main/references/reference-workflow.md) corroborate them | [2.5 course](https://www.youtube.com/watch?v=UxwV16jDglA); [2.0 prompting course](https://www.youtube.com/watch?v=lkL8mlpVScY); [1.5 practitioner review](https://www.youtube.com/watch?v=b6mfdIGVmKk) | [2.0 role-binding report](https://www.reddit.com/r/Seedance_AI/comments/1rjq6cc/i_spent_way_too_long_figuring_out_seedance_20/); [2.5 timeline workflow](https://www.reddit.com/r/Seedance_AI/comments/1vu58tx/how_i_made_a_60second_mtb_video_with_seedance_25/) | One primary role per asset, stable exact tags, feasible shot/timeline design, and iteration from observed output align with first-party guidance; promotional workflow claims remain low confidence |
| FLUX.2 | [official FLUX.2 repository and upsampler](https://github.com/black-forest-labs/flux2) | No controlled FLUX.2 prompt-writer comparison found | [discussion of the official FLUX.2 guide](https://www.reddit.com/r/StableDiffusion/comments/1p6lqy2/flux2_official_prompting_guide/) | Direct prompts beat inflated negatives for controlled work; upsampling is a testable option, not an automatic win |
| Ideogram | First-party docs are materially stronger than available community prompt generators | No controlled V3/Character writer comparison found | [Magic Prompt adding unwanted detail](https://www.reddit.com/r/ideogramai/comments/1ktlk4a) | Magic Prompt is valuable for exploration and risky for locked typography/identity; keep the toggle observable |
| Qwen Image 3 | [official Qwen Image enhancer code](https://github.com/QwenLM/Qwen-Image/blob/main/src/examples/tools/prompt_utils.py) is the decisive implementation | [Qwen-VL reference-aware prompt workflow](https://www.youtube.com/watch?v=1PjDwD3P67Y) is adjacent rather than a 3.0 benchmark | [Qwen 3 versus GPT Image 2 comparison](https://www.reddit.com/r/Qwen_AI/comments/1v2v2vn/a_comparison_of_gpt_image_2_vs_qwen_image_30_vs/) | Qwen-family writers have first-party support; small comparison posts cannot establish superiority across task classes |
| Z-Image | [official enhancer](https://huggingface.co/spaces/Tongyi-MAI/Z-Image-Turbo/blob/main/pe.py) plus [model repository](https://github.com/Tongyi-MAI/Z-Image) | [three-week Turbo enhancement workflow](https://www.youtube.com/watch?v=hk-0HnUtdls) | [prompt-enhancer comparison](https://www.reddit.com/r/StableDiffusion/comments/1p9efo1/zimage_prompt_enhancer_comparison/) | Short prompts often benefit from the official Qwen template; already detailed prompts can degrade, and Base/Turbo negative behavior must not be mixed |
| Wan / HappyHorse | [official Wan skills](https://github.com/Wan-Video/Wan-skills); [official HappyHorse prompts](https://github.com/modelstudioai/awesome-happyhorse-prompts) | No sufficiently strong Wan 2.7/HappyHorse 1.1-specific independent tutorial found | [same-prompt cross-model comparison](https://www.reddit.com/r/comfyui/comments/1t7t0kl/wan_27_happyhorse_veo_31_seedance_20_on_8_prompts/); [older Wan I2V prompting discussion](https://www.reddit.com/r/StableDiffusion/comments/1nkktjn/how_can_i_improve_my_prompts_for_image_to_video/) | Official syntax is far more reliable; community reports weakly reinforce positive motion wording and the need to test with identical briefs |
| Google Veo / Omni | [Google Scene Machine](https://github.com/google-marketing-solutions/scene-machine) and [Gen V](https://github.com/google-marketing-solutions/gen-v) show Gemini-to-Veo planning but are explicitly unsupported reference implementations | [official Omni editing demo](https://www.youtube.com/watch?v=guv2-EoGUXw); [official Omni overview](https://www.youtube.com/watch?v=uW4B6ziQqvY) | [Omni trial-and-error structure](https://www.reddit.com/r/GeminiAI/comments/1tzu0uo/after_a_lot_of_trial_and_error_with_gemini_omni/); [Veo prompt-writer discussion](https://www.reddit.com/r/VEO3/comments/1m014jt/using_models_to_generate_veo_3_prompts/) | Gemini-to-Veo is provider-aligned, but no controlled public study ranks Gemini/GPT/Claude; compact edits and modular video slots are more defensible than JSON folklore |
| Grok Imagine | [official Grok Build source](https://github.com/xai-org/grok-build) shows short, direct orchestration | [practitioner Grok video workflow](https://www.youtube.com/watch?v=7pODA3fUbks) predates Video 1.5 | [Image prompt-quality discussion](https://www.reddit.com/r/grok/comments/1v1kr8r/grok_imagine_image_prompt_quality/) | Concise coherent briefs and direct edits recur; old community behavior must not be generalized to current Image 2.0/Video 1.5 or the app's legacy aliases |
| Kling | [community Kling 3 prompting skill](https://github.com/aedev-tools/kling-3-prompting-skill/blob/main/skills/kling-3-prompting/SKILL.md) | [Kling official Motion Control video](https://www.youtube.com/watch?v=Un36CzFxL6k); [independent Motion Control test](https://www.youtube.com/watch?v=yUBGI_kUm-g) | [multi-shot prompting discussion](https://www.reddit.com/r/KlingAI_Videos/comments/1qwhdzu/kling_30_elements_multishot_prompting_what_is/); [Motion Control physics report](https://www.reddit.com/r/klingO1/comments/1rprgmo/kling_30_motion_control_apithe_movement_physics/) | Stable named elements, feasible shot budgets, and matching reference framing matter; the internal enhancer's unnamed LLM prevents a defensible external-brand recommendation |
| MiniMax H3 / Hailuo | [official H3 skill](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/SKILL.md); [community open H3 IR](https://github.com/ruashots/open-h3-ir) for experiments | [H3 local walkthrough](https://youtu.be/mzfqJR9IXtk); [Hailuo camera-command tutorial](https://www.youtube.com/watch?v=DuRHup2QxtI) | [official H3-team AMA](https://www.reddit.com/r/StableDiffusion/comments/1vh9rtw/ama_minimax_h3_team_ask_us_anything_about_our/) | H3's formal IR and Hailuo's bracket commands dominate stylistic prompt advice; local/community IR implementations are not equivalents of hosted Context-IR |

No high-quality controlled YouTube or Reddit experiment was found that holds intent, route, parameters, references, and enough samples constant while comparing writer LLMs across these target models. The absence of such evidence is why the report recommends an app-owned generated-media eval rather than a universal-writer claim.

## Gaps that remain provider-dependent

Some KIE market aliases expose a narrower or different contract than the current first-party model. For these, the implementation must retain a provider-parity label until a live task is verified against current output metadata:

- Wan 2.7 and HappyHorse 1.1 have first-party Alibaba documentation, but KIE may omit native audio, multi-shot, thinking, negative-prompt, or reference behavior.
- The bare `z-image` alias is likely related to Z-Image Turbo but does not prove the exact checkpoint or its negative-prompt policy.
- Seedream/Seedance point releases distributed through KIE expose different reference capacities and duration/resolution options from the documented BytePlus surfaces; those app limits should be labeled as distributor limits.
- Grok Imagine market aliases may lag the current first-party Image 2.0 or Video 1.5 release.

These are not reasons to use a generic playbook. They are reasons to keep the profile explicit, versioned, and testable.

## Recommended next implementation phase

1. Replace `MODEL_ALIASES` with exact profiles for all 36 IDs, allowing inheritance only for immutable shared fields.
2. Introduce provider-specific intermediate schemas: image brief, edit brief, single-shot, storyboard, audio-video timeline, multimodal reference plan, and motion-transfer plan.
3. Add native prompt-writer adapters for Seedream, Seedance 2/2.5, Qwen/Wan, Ideogram, FLUX, Grok, H3, and other routes where the provider exposes an exact mechanism.
4. Make malformed structured output a failure/refund, never a successful raw prompt.
5. Add deterministic lints for length, exact copy, reference labels, invariants, time budgets, dialogue budgets, unsupported controls, and provider syntax.
6. Run the writer evaluation above before changing the default planner model.
7. Verify or remove the three Imagen entries, and verify KIE parity for HappyHorse audio/multi-shot rather than its ownership (Alibaba ownership is now confirmed).

## Source-led research caveat

This report is a web and code research synthesis, not a generation benchmark. Official documentation establishes supported grammar and intended workflows; GitHub, YouTube, and Reddit help identify practical patterns and failure cases. A final “best writer” decision requires the controlled app-level evaluation described above.
