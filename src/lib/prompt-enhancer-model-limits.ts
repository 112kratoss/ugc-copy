/**
 * What a browser needs of the prompt enhancer's playbooks: the aliases that map a
 * catalog id onto the playbook it shares, and each playbook's prompt length limit
 * with its label. `prompt-quality.ts` warns from these on the creators' pages, and
 * importing them from `prompt-enhancer-playbooks.ts` sent all 41 playbooks with
 * them, 63 KB of script on `/create-video` (speed baseline, 2026-11-19).
 *
 * The playbooks stay the source: `prompt-enhancer-model-limits.test.ts` fails when
 * a playbook's label or `budget.maxChars` and the entry here disagree, or when an
 * entry has no playbook.
 */

/**
 * Aliases are the enhance endpoint's allowlist extension: SUPPORTED_ENHANCEMENT_MODELS
 * is built from playbook keys plus these. Only true grammar twins belong here —
 * a model whose provider, prompt dialect, and constraint set match the target.
 */
export const MODEL_ALIASES: Record<string, string> = {
  // Catalog id → provider id spelling of the same model.
  'kling-3.0-video': 'kling-3.0/video',
  // Identical request schema and official grammar; pro is the fidelity tier.
  'qwen3-pro': 'qwen3',
  // Same OpenAI image model family, request schema and prompting guide as GPT Image 2.
  'gpt-image-2.5-flare': 'gpt-image-2',
  'gpt-image-2.5-sunburst': 'gpt-image-2',
  'wan-2.7-image-pro': 'wan-2.7-image',
  // Same one-shot caption grammar; fast/ultra are speed/quality tiers.
  'imagen-4-fast': 'imagen-4',
  'imagen-4-ultra': 'imagen-4',
  // Same schema and constraints as the fast tier; mini is the draft tier.
  'seedance-2-mini': 'seedance-2-fast',
  // docs/model-api-references/seedream-5-flash.md: the Seedream prompt grammar with Lite's
  // budget; the request differs by one field name (`size` for `resolution`).
  'seedream-5-flash': 'seedream-5-lite',
  // docs/model-api-references/qwen-image-2-1.md: Qwen-Image's own prompting rules, the same
  // family as Qwen 3; `aspect_ratio` where Qwen 3's body says `image_size`.
  'qwen-image-2.1': 'qwen3',
  // docs/model-api-references/gemini-omni-1-1-flash.md: Gemini Omni Video's prompt,
  // image_urls, video_list, duration, aspect_ratio and resolution body plus a frame pair.
  'gemini-omni-1.1-flash': 'gemini-omni-video',
  // docs/model-api-references/wan-3-0.md: the Prime tier takes the identical body.
  'wan-3.0-prime': 'wan-3.0',
  // docs/model-api-references/kie-catalog-inputs-2026-10-29.md: Grok Imagine's prompt, image_urls,
  // aspect_ratio, resolution and duration body without the mode field, plus a frame pair
  // (first_frame_url, last_frame_url), as Gemini Omni 1.1 Flash's body adds one to its target's;
  // the same prompt grammar and audio rule.
  'grok-imagine-video-1.5': 'grok-imagine-video',
  // docs/model-api-references/nano-banana-2-1.md: Nano Banana 2's body field for field under
  // its own id, from the same Google model line.
  'nano-banana-2.1': 'nano-banana-2',
  // docs/model-api-references/pixverse-v6-max.md: PixVerse V6's text and image-to-video bodies
  // (no multi-clip switch), the same prompt grammar and sound toggle; Max has no references.
  'pixverse-v6-max': 'pixverse-v6',
  // docs/model-api-references/seedream-5-5.md: Seedream 5 Flash's body field for field (plus an
  // unsent `background`), so the Seedream grammar with Lite's budget, as Flash has.
  'seedream-5.5': 'seedream-5-lite',
  // docs/model-api-references/gpt-image-2-6.md: GPT Image 2's prompt and input_urls without a
  // resolution field, from the same OpenAI model family, as 2.5's tiers are.
  'gpt-image-2.6': 'gpt-image-2',
  // docs/model-api-references/kling-4-0-flash.md: Kling 4.0's two bodies with fewer fields
  // (720p, 3–20 s, no last frame or voices) and the same @image_N grammar and always-on audio.
  'kling-4.0-flash': 'kling-4.0',
  // docs/model-api-references/gemini-omni-1-2-flash.md: 1.1's prompt, image_urls, frame pair,
  // aspect_ratio and resolution body with an integer duration, as 1.1 aliases Gemini Omni Video.
  'gemini-omni-1.2-flash': 'gemini-omni-video',
};

export function normalizeEnhancerModelId(selectedModel: string): string {
  return MODEL_ALIASES[selectedModel] ?? selectedModel;
}

export interface EnhancerPromptLimit {
  label: string;
  maxChars: number;
}

/** The playbooks with a `budget.maxChars`, keyed as `ENHANCER_PLAYBOOKS` is. */
export const ENHANCER_PROMPT_LIMITS: Record<string, EnhancerPromptLimit> = {
  'imagen-4': { label: 'Imagen 4', maxChars: 1800 },
  'seedream-5-pro': { label: 'Seedream 5 Pro', maxChars: 4800 },
  'seedream-5-lite': { label: 'Seedream 5 Lite', maxChars: 2900 },
  'flux-2-pro': { label: 'FLUX.2 Pro', maxChars: 4800 },
  'flux-3-klein': { label: 'FLUX.3 Klein', maxChars: 4800 },
  'z-image': { label: 'Z-Image', maxChars: 990 },
  'qwen3': { label: 'Qwen Image 3.0', maxChars: 4800 },
  'wan-2.7-image': { label: 'Wan 2.7 Image', maxChars: 4800 },
  'minimax-h3-image': { label: 'MiniMax H3 Image', maxChars: 4800 },
  'kling-3.0-turbo': { label: 'Kling 3.0 Turbo', maxChars: 2300 },
  'kling-o3': { label: 'Kling O3', maxChars: 3000 },
  'hailuo-2.3': { label: 'Hailuo 2.3', maxChars: 1900 },
  'happyhorse-1.1': { label: 'HappyHorse 1.1', maxChars: 1900 },
  'kling-4.0': { label: 'Kling 4.0', maxChars: 7500 },
  'kling-2.6': { label: 'Kling 2.6 Motion Control', maxChars: 2400 },
  'kling-3.0': { label: 'Kling 3.0 Motion Control', maxChars: 2400 },
  'text-to-speech-turbo-2-5': { label: 'ElevenLabs TTS Turbo 2.5', maxChars: 4900 },
  'text-to-speech-multilingual-v2': { label: 'ElevenLabs TTS Multilingual V2', maxChars: 4900 },
  'text-to-dialogue-v3': { label: 'ElevenLabs Text-to-Dialogue V3', maxChars: 4900 },
  'sound-effect-v2': { label: 'ElevenLabs Sound Effect V2', maxChars: 440 },
};

/** The prompt length limit of the playbook a model uses, alias resolved; null when it has none. */
export function getEnhancerPromptLimit(selectedModel: string): EnhancerPromptLimit | null {
  return ENHANCER_PROMPT_LIMITS[normalizeEnhancerModelId(selectedModel)] ?? null;
}
