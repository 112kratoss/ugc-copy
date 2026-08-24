# Enhance-Prompt: LLM Choice & Architecture Research (2026-08-24)

Latency figures = OpenRouter P50s. Kie facts from docs.kie.ai + llms.txt + live catalog + Kie blog.

## Kie LLM proxy inventory (docs.kie.ai/llms.txt, kie.ai/market/chat)
| Family | Models on Kie (Aug 2026) | Endpoint shape | Vision | Reasoning control |
|---|---|---|---|---|
| Gemini | 2.5 Pro/Flash, 3 Pro, **3 Flash** (incumbent), 3.1 Pro, 3.5 Flash, 3.6 Flash, 3.7 Flash (+ "(OpenAI)" variants) | api.kie.ai/<model>/v1/chat/completions — OpenAI-compatible | Yes (unified image_url block: image/video/audio/PDF) | reasoning_effort low\|high (default high) |
| OpenAI GPT | GPT-5.2, 5.4, 5.5, 5.6 Luna/Terra/Sol, Codex | api.kie.ai/codex/v1/responses — **Responses shape** | Yes (input_image) | low→xhigh (default low) |
| Claude | Opus 5/4.8/4.7/4.6/4.5, Sonnet 5/4.6/4.5, Haiku 4.5, Fable 5 | api.kie.ai/claude/v1/messages — **Anthropic Messages shape** | Not documented on Haiku page | thinkingFlag |
| Grok | 4.3, 4.5, 4.6 | api.kie.ai/grok/v1/responses | Yes | low→xhigh; JSON-schema documented |
| Absent | No DeepSeek/Qwen/Llama; Kimi K3 "Coming Soon" | | | |

- Gemini 3 Flash spec example includes `response_format: {type: json_schema}` (also in repo's model_api_references/gemini-3-flash.md) — JSON-schema output passes through though undocumented in schema block.
- Kie LLM pricing: NO public per-token table; metered in credits per call (`credits_consumed`, e.g. 0.48), 1 credit ≈ $0.005; Kie claims "30–50% lower than official"; budget at official rates. Platform: 20 req/10s, 100+ concurrent.
- **Every Gemini Flash tier through 3.7 is a drop-in URL swap from today's integration. GPT (Responses) or Claude (Messages) = second client.**

## LLM candidate comparison (2,000 in + 300 out per call)
| Model | $/1M in/out | JSON mode | P50 TTFT / tok/s → ~total | $/call | $/1k |
|---|---|---|---|---|---|
| Gemini 3 Flash (incumbent, Kie) | $0.50/$3.00 | json_schema | 1.20s / 73 → ~5.3s | $0.0019 | $1.90 |
| **Gemini 3.6 Flash (Kie)** | $0.75/$3.75 intro→Dec 31 2026; $1.50/$7.50 after | Yes | 1.37s / 137 → **~3.6s** | $0.0026 (→$0.0053 2027) | $2.63 |
| Gemini 3.7 Flash (Kie, newest) | same intro (OpenRouter shows $0.375/$1.875) | Yes | 2.39s / 95 → ~5.6s (young) | $0.0026 | $2.63 |
| Gemini 3.5 Flash-Lite (direct only, NOT Kie) | $0.30/$2.50 | Yes | 0.46s / 82 → ~4.1s | $0.00135 | $1.35 |
| Gemini 3.1 Flash-Lite (direct) | $0.25/$1.50 | Yes | — | $0.00095 | $0.95 |
| **GPT-5.6 Luna (Kie, Responses)** | $0.20/$1.20 (cached in $0.02) | Yes | 1.05s / 111 → ~3.8s | $0.00076 | $0.76 |
| gpt-5-mini | $0.25/$2.00 | Yes | — | $0.0011 | $1.10 |
| gpt-5-nano | $0.05/$0.40 | Yes | — | $0.00022 | $0.22 |
| Claude Haiku 4.5 (Kie, Messages) | $1/$5 (cache read 0.1×) | via tools/OpenRouter | **0.38s** / 94 → ~3.6s | $0.0035 | $3.50 |
| Claude Sonnet 5 | $2/$10 (4.7+ tokenizer ~30% more tokens) | Yes | — | ~$0.007–9 | $7–9 |

Observations: everything cheap vs the 2-credit ($0.01) charge — cost is a tiebreaker. One image immaterial everywhere (<$0.001–0.0014) → vision i2v doesn't change economics. **All candidates support strict structured outputs — the regex JSON extraction solves a problem that no longer needs to exist.** Latency ≤5s: 3.6 Flash, Luna, Haiku, 3.5 Flash-Lite all ~3.5–4s; streaming → ~1–1.4s perceived. **Incumbent 3-Flash is the slowest-throughput of the group.**

## Practitioner consensus on small-model rewrite quality
- EQ-Bench Creative Writing v3 (Aug 2026): Opus 5 Elo 2105 > Kimi K3 2060 > GPT-5.6 Sol 1959 — but long-form fiction, irrelevant at 3-sentence scale.
- ComfyUI ecosystem: "Prompt enhancement is a short task with maybe 200 tokens of output, and small models handle it well" — local picks gemma2:2b, qwen2.5:1.5b, llama3.2:3b.
- Industry: Fooocus ships GPT-2 124M expander; Flux-Prompt-Enhance is T5-base 0.2B; SuperPrompt T5 77M; fal serves Ideogram V4's expander on PEFT-fine-tuned Qwen 3.5 35B MoE that "matched the 397B model's quality" after fine-tuning. **The differentiator is instruction-following and schema discipline, not prose talent.**
- Weak-evidence tier: Claude ahead on writing preference (blind 47% vs GPT 29% vs Gemini 24%); Haiku TTFT/instruction leader among fast tiers; Luna "right pick where response time is visible"; Gemini 3.6/3.7 notes emphasize instruction following.
- Bottom line: no public eval shows a meaningful gap between Gemini Flash 3.6+, Luna, Haiku at this size. **Constraint-obedience is the real quality axis — testable in-house per playbook.**

## Competitor teardown
- **Ideogram Magic Prompt** (best-in-class): Auto/On/Off; Auto hedges across the 4-image batch by input length; details panel shows original + enhanced. Under the hood Ideogram 4.0 "was trained on structured JSON captions… magic prompt layer converts plain text to that JSON structure" (runware.ai). fal built dedicated serving: expansion "might quickly become the bottleneck", target <1s single-user/<2s load, ~600-token expansions. **Design principle: expander output format = the model's training caption format.**
- **DALL-E 3 / gpt-image**: mandatory GPT-4 rewrite, revised_prompt returned, can't disable; "I NEED to test… DO NOT add any detail, just use it AS-IS" partial workaround. Study: LLM rewriting closed ~58% of DALL-E 3 vs 2 prompt-following gap — the rewriter carries much of the improvement. Complaints: silent intent changes → the cautionary tale for invisible forced enhancement.
- **Google Veo/Vertex enhancePrompt**: cannot disable on Veo 3/3.1; adds video description, camera, transcription, SFX; rewritten prompt returned only <30 words input. Gemini-based, multimodal (sees i2v frames).
- **Runway**: explicit "Enhance Prompt" control (adds camera angles, lighting, texture); Gen-4 guide warns against over-detail (one primary action).
- **Luma**: enhance toggle; users toggle OFF for precise control — enhancement must respect the model's instruction bandwidth.
- **Hailuo/MiniMax API**: `prompt_optimizer` default TRUE ("False = follows instructions more strictly") + fast_pretreatment. **Provider-side enhancement is now a standard API param — check per Kie model for double-enhancing.**
- **fal.ai**: enable_prompt_expansion default on for Wan etc. — "most beneficial under 50 words; detailed prompts may get over-elaborated"; implemented as _expand_prompt → fal-ai/any-llm with per-endpoint system prompt.
- **Higgsfield**: "AI Prompt Generator — writes prompts for every leading model… compare side by side" — most explicit per-model-aware multi-variant enhancer; Commercial Generator goes script→scenes→voice→CTA. Community maintains 32-sub-skill per-model playbook repos — demand signal for per-model playbooks.
- Freepik improve-prompt (thin docs); Krea editable "Enhance Prompt" suggestion; OpenArt rewrites rough idea; Leonardo Prompt Enhance pads short prompts; Pika none; Midjourney none official (concise culture, over-expansion harmful).
- HeyGen/Hedra: enhancement at the SCRIPT level; HeyAds "one script × five avatars = 25 variants" — campaign-level fan-out lesson.

## Reusable system-prompt gold
- **Wan 2.2 official extension prompts** (wan/utils/system_prompt.py): T2V film-director role; "select up to 4" cinematic settings from FIXED ENUMERATED MENUS (time, light source, intensity/angle, tone, shot size, camera angle, composition) with hard defaults ("if not specified, choose Day time!!!", "default Medium/Wide shot", "default Center composition"); "detail the action's process; if there is no action, add one"; "do not output literary descriptions of mood"; style first; sky "deep blue" guard; 60–200 words; 4 worked examples. **Enum-menu trick constrains a small LLM to the model's known-good vocabulary — directly liftable.**
- **Wan I2V (vision-grounded), verbatim**: "retain the dynamic parts… If the user only provides an action (e.g., 'dancing'), supplement it reasonably based on the image content (e.g., 'a girl is dancing')… If the user's input already describes elements visible in the image, remove those static descriptions. Limit to 100 words or less." + empty-prompt variant (imagine the moving subject from the image).
- **Qwen-Image enhancer** (prompt_utils.py): rewrite preserving meaning; quoted text + position; <200 words; magic suffix; edit variant defines task taxonomy and outputs JSON {"Rewritten": "..."} — a plan-then-compile sibling.
- **DALL-E 3 leaked rewriter**: "create four captions as diverse as possible"; silent minimal policy substitutions. Diversity-across-batch → variant hedging.
- Small open expanders: Flux-Prompt-Enhance (T5-base, prefix "enhance prompt:", 256-token cap), SuperPrompt-v1, Fooocus V2 (GPT-2, per-generation variety as feature), diffusers/gemini-prompt-expander-mellon.

## Architecture findings
1. **Per-model beats one-global — unanimously.** Promptist: "performant prompts are often model-specific" (NeurIPS 2023). Prompt-A-Video names "Model-Unaware" as a core failure. VPO fine-tunes per target model. Wan/Qwen ship per-model prompts; Higgsfield sells per-model generation. **Playbook design is correct; the LLM behind it can stay singular.**
2. **Rewriting measurably improves output — when it adds structure, not length.** ~58% DALL-E gap closure; SCMAPR +2.67% VBench; FVG rewriting SOTA on T2V-CompBench; VBench's own protocol uses LLM rewriting. Counter-guardrails: fal "detailed prompts may get over-elaborated"; Runway/Pika/MJ favor one action; Wan caps i2v at 100 words. **Winning pattern: coverage of the model's trained caption axes + hard caps = enum-menu playbooks.**
3. **Plan-then-compile is state of the art**: Ideogram 4.0's pipeline is text → LLM → structured JSON caption → model (trained on that JSON). Qwen edit enhancer emits JSON. Google Prompt Expansion (ACL 2024) generates structured expansion sets. **Our weak link is regex extraction + silent fallback, not the architecture — schema-enforced decoding now native on every candidate.**
4. **Vision-grounded i2v enhancement is the norm at the frontier and our biggest gap.** Wan's i2v extender REQUIRES the image; Veo's rewriter is multimodal; VPO handles image-conditioned prompts. Kie Gemini endpoints accept image_url on the same call — attaching the start frame is a payload change, not an integration.
5. **Latency is a product feature; streaming is the cheap win.** fal targets <1s/<2s. Kie Gemini streams SSE by default. ~4s → ~1.3s perceived.
6. **Control and visibility beat silent enhancement.** Forced rewriters (DALL-E, Veo) draw complaints; loved ones expose original + enhanced (Ideogram), on/off/auto, or editable suggestion (Krea). Our append-only mode is already the light-touch lane.
7. **Cost control**: Anthropic cache read 0.1×; OpenAI cached automatic 0.1×; Gemini context caching 0.1×. **Order system prompt static-first (base + playbook), volatile last (settings, shot index, user prompt)** → saves ~40–60% input cost.

## Recommendation
**LLM (A): stay on Kie, one global model — upgrade gemini-3-flash → gemini-3.6-flash (OpenAI-compatible variant), 3.7-flash as follow-on once serving matures.** URL-only change on current payload; ~2× throughput (137 vs 73 tok/s → ~3.6s vs ~5.3s); Google positions 3.6/3.7 on instruction following; response_format json_schema; native vision for i2v; ≥47% margin vs 2-credit charge even at 2027 pricing. No per-medium override justified — specialization lives in playbooks. Contingencies: GPT-5.6 Luna (Kie) if Gemini disappoints in A/B ($0.76/1k, 1.05s TTFT, costs a Responses client); Gemini 3.5 Flash-Lite direct only if accepting a second vendor key; Claude Haiku 4.5 = quality-ceiling option (best TTFT, strongest instruction-following reputation) at 1.8× cost + Messages client — worth testing, not defaulting.

**Architecture (B), top 5 moves by impact:**
1. **Vision-ground the i2v scenarios** — attach start (and end) frame; adopt Wan's i2v contract (keep dynamics, remove static descriptions visible in frame, supplement bare actions from image, ≤100 words). Largest quality lever; payload-only; <$0.001/call.
2. **Enforce plan schema with response_format json_schema**; delete regex path (keep as fallback telemetry). Silent parse failures currently degrade invisibly.
3. **Stream the rewrite into the textbox** (SSE already default). ~4s → ~1.3s perceived; buys headroom for higher effort later.
4. **Show the work, keep control**: original-vs-enhanced visibility + revert chip; append-only as explicit level; audit Kie video models for provider-side optimizers to avoid double enhancement.
5. **Harden playbooks with Wan/Qwen patterns + cache-friendly ordering**: enumerated vocab menus with defaults, hard word caps per model (60–200 t2v, ≤100 i2v), "no literary mood language", "if no action, add one", exact-text-in-quotes; static-first prompt ordering for caching. Optional: Ideogram-style 2-variant hedging (diversity result says the second variant is where aesthetic upside lives).
