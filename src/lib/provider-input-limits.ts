import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '@/lib/models';

/**
 * What Kie refuses in a run's prompt and reference media, for each app model, as its
 * model pages documented them on 2026-10-20 (docs.kie.ai/market/…, read for the model
 * check-up recorded in archive/model-checkup-2026-10-20). Kie answers a createTask it
 * refuses with an error inside HTTP 200, after the start has held the run's credits,
 * so the run fails and is refunded. The start services ask these first, before any
 * hold. Zero-cost probes that day found the prompt caps enforced at the limit + 1 for
 * Z-Image, FLUX.2 Pro, Seedream 5 Lite, Kling 3 Turbo and Ideogram Character ("The
 * text length cannot exceed the maximum limit").
 *
 * A model with no entry keeps the shared GENERATION_PROMPT_MAX_LENGTH, which the
 * starts check on the prompt as written: its provider takes at least that much.
 */
type PromptRule = {
  /** The most characters the provider takes in the prompt it is sent. */
  maxLength?: number;
  /** The fewest it takes, where that is more than one. */
  minLength?: number;
  /** The most it takes in each shot of a multi-shot run. */
  shotMaxLength?: number;
  /** The cap holds only for a run without reference pictures: the reference endpoint takes more. */
  textOnly?: boolean;
  /** The characters each mention of a named element counts as, however long its handle. */
  elementMentionLength?: number;
};

const PROMPT_RULES: Readonly<Record<string, PromptRule>> = {
  // Image models (market/<page>.md, prompt property).
  'z-image': { maxLength: 1000 }, // z-image/z-image:111-113
  'seedream-5-lite': { maxLength: 2995, minLength: 4 }, // seedream/5-lite-text-to-image:113-114, seedream-5-lite-image-to-image:111-112
  'seedream-5-flash': { maxLength: 5000, minLength: 4 }, // seedream/5-flash-text-to-image:117-118, -image-to-image:117-118
  'seedream-5-pro': { maxLength: 5000, minLength: 4 }, // seedream/5-pro-text-to-image:117-118, -image-to-image:123-124
  'flux-2-pro': { maxLength: 5000, minLength: 3 }, // flux2/pro-text-to-image:106,117; pro-image-to-image:124-126
  // grok-imagine/text-to-image:113; its image-to-image endpoint takes 390,000 (:148).
  'grok-imagine-image': { maxLength: 5000, textOnly: true },
  'grok-imagine-image-2': { maxLength: 8000 }, // grok-imagine-image-2-0/text-to-image:100
  'ideogram-character': { maxLength: 5000 }, // ideogram/character:121
  'ideogram-v3': { maxLength: 5000 }, // ideogram/v3-text-to-image:107; v3-remix:94
  'qwen-image-2.1': { maxLength: 5000 }, // qwen2-1/text-to-image:94; image-to-image:120
  'qwen3': { maxLength: 5000 }, // qwen3/text-to-image:106; image-to-image:122
  'qwen3-pro': { maxLength: 5000 }, // qwen3-pro/text-to-image:106; image-to-image:122
  'wan-2.7-image': { maxLength: 5000 }, // wan/2-7-image:104
  'wan-2.7-image-pro': { maxLength: 5000 }, // wan/2-7-image-pro:103
  // Video models.
  'kling-3.0-turbo': { maxLength: 2500 }, // kling/v3-turbo-text-to-video:119; v3-turbo-image-to-video:119
  // kling-3.0/video: the prompt "Up to 2,500 characters" (:419-423), each shot 500 (:544),
  // and "each @element will occupy 37 characters" (:193, :540).
  'kling-3.0-video': { maxLength: 2500, shotMaxLength: 500, elementMentionLength: 37 },
  // kling/v3-omni-*: the prompt 3,072 (text-to-video:120), each shot 512 (:161).
  'kling-o3': { maxLength: 3072, shotMaxLength: 512 },
  // Delisted; its archived page (docs/model-api-references/bytedance/seedance-1.5-pro.md) says 3-2500.
  'seedance-1.5-pro': { maxLength: 2500, minLength: 3 },
  // bytedance/seedance-2, -fast, -mini: "Min length: 3, Max length: 20000" (:161-163). 2.5 sets no minimum.
  'seedance-2': { minLength: 3 },
  'seedance-2-fast': { minLength: 3 },
  'seedance-2-mini': { minLength: 3 },
  'grok-imagine-video-1.5': { maxLength: 4096 }, // grok-imagine/1-5-preview:105
  'grok-imagine-video': { maxLength: 5000 }, // grok-imagine/text-to-video:121; image-to-video:178
  'hailuo-2.3': { maxLength: 5000 }, // hailuo/2-3-image-to-video-pro:111; -standard:113
  'happyhorse-1.1': { maxLength: 5000 }, // happyhorse-1-1/text-to-video:102; image-to-video:102; reference-to-video:106
  'pixverse-v6': { maxLength: 5000, minLength: 3 }, // pixverse/text-to-video:113-114 (and its three siblings)
  'wan-2.7': { maxLength: 5000 }, // wan/2-7-text-to-video:82; 2-7-image-to-video:111; 2-7-r2v:90
  'minimax-h3': { maxLength: 7000 }, // minimax-h3/text-to-video:94; image-to-video:93; reference-to-video:104
};

/** image-elements' HANDLE_PATTERN: an @handle with no word character on either side. */
const MENTION_PATTERN = /(^|[^\w])(@[a-z0-9_]+)(?=$|[^\w])/g;

function hasRule<T>(rules: Readonly<Record<string, T>>, modelId: string): boolean {
  return Object.hasOwn(rules, modelId);
}

/** The name the creators show for a model, so a refusal says which model it is. */
function modelDisplayName(modelId: string): string {
  for (const models of [IMAGE_MODELS, VIDEO_MODELS, MOTION_MODELS] as const) {
    if (Object.hasOwn(models, modelId)) {
      return (models as Record<string, { displayName: string }>)[modelId].displayName;
    }
  }
  return modelId;
}

function characters(count: number): string {
  return `${count.toLocaleString('en-US')} character${count === 1 ? '' : 's'}`;
}

/** The length Kie counts: each mention of a named element counts as at least `mentionLength`. */
function countedPromptLength(
  prompt: string,
  mentionLength: number | undefined,
  elementHandles: readonly string[],
): number {
  if (!mentionLength || elementHandles.length === 0) return prompt.length;
  const handles = new Set(elementHandles);
  let widened = 0;
  for (const match of prompt.matchAll(MENTION_PATTERN)) {
    const handle = match[2];
    if (handles.has(handle) && handle.length < mentionLength) widened += mentionLength - handle.length;
  }
  return prompt.length + widened;
}

export type ProviderPromptRun = {
  /**
   * The run's prompt as the provider is sent it, the legend naming its pictures
   * included, or null when the provider's body carries no prompt of the run's own.
   */
  prompt: string | null;
  /** Each shot's prompt as it is sent, for a multi-shot run. */
  shots?: readonly string[];
  /** Whether the run sends reference pictures, which picks some models' reference endpoint. */
  hasReferenceImages?: boolean;
  /** The handles of the run's named elements, where the provider counts a mention at a fixed width. */
  elementHandles?: readonly string[];
};

/** The most characters a model's provider takes in its prompt, or null where only the shared limit applies. */
export function providerPromptMaxLength(
  modelId: string,
  { hasReferenceImages = false }: { hasReferenceImages?: boolean } = {},
): number | null {
  if (!hasRule(PROMPT_RULES, modelId)) return null;
  const rule = PROMPT_RULES[modelId];
  if (rule.maxLength === undefined || (rule.textOnly && hasReferenceImages)) return null;
  return rule.maxLength;
}

/**
 * Why the provider would refuse the prompts a run sends it, in words for the creator
 * that name the model and the limit, or null when it would take them.
 */
export function providerPromptViolation(modelId: string, run: ProviderPromptRun): string | null {
  if (!hasRule(PROMPT_RULES, modelId)) return null;
  const rule = PROMPT_RULES[modelId];
  const name = modelDisplayName(modelId);
  const maxLength = providerPromptMaxLength(modelId, run);
  const elementHandles = run.elementHandles ?? [];
  const mentionNote = (literalLength: number, limit: number) => (
    literalLength <= limit && rule.elementMentionLength
      ? `, counting each video element mention as ${rule.elementMentionLength}`
      : ''
  );

  if (run.prompt !== null) {
    const counted = countedPromptLength(run.prompt, rule.elementMentionLength, elementHandles);
    if (maxLength !== null && counted > maxLength) {
      return `${name} prompts support up to ${characters(maxLength)}${mentionNote(run.prompt.length, maxLength)}.`;
    }
    if (rule.minLength !== undefined && run.prompt.trim().length < rule.minLength) {
      return `${name} prompts need at least ${characters(rule.minLength)}.`;
    }
  }

  const shotMaxLength = rule.shotMaxLength ?? maxLength;
  if (shotMaxLength !== null) {
    for (const [index, shot] of (run.shots ?? []).entries()) {
      if (countedPromptLength(shot, rule.elementMentionLength, elementHandles) > shotMaxLength) {
        return `Shot ${index + 1}: ${name} shot prompts support up to ${characters(shotMaxLength)}${mentionNote(shot.length, shotMaxLength)}.`;
      }
    }
  }
  return null;
}

/**
 * The shortest reference media each model's provider takes, in seconds, by what the
 * file is to the run: a reference clip or track, a Kling 3.0 named video element, or
 * a motion-control performance.
 */
export type ReferenceMediaRole = 'video' | 'audio' | 'element' | 'motion';

const REFERENCE_MEDIA_MIN_SECONDS: Readonly<Record<string, Partial<Record<ReferenceMediaRole, number>>>> = {
  // bytedance/seedance-2, -fast, -mini: "Single video duration [2, 15] s" (:217), audio the same (:248).
  'seedance-2': { video: 2, audio: 2 },
  'seedance-2-fast': { video: 2, audio: 2 },
  'seedance-2-mini': { video: 2, audio: 2 },
  // bytedance/seedance-2-5: video "[2, 30] seconds" (:238), audio the same (:259).
  'seedance-2-5': { video: 2, audio: 2 },
  // minimax-h3/reference-to-video: each clip and track "2 to 15 seconds" (:134, :153).
  'minimax-h3': { video: 2, audio: 2 },
  // wan/2-7-r2v: reference_voice "Duration: 1 to 10 seconds" (:166).
  'wan-2.7': { audio: 1 },
  // kling-3.0/video: a video element's "duration must be at least 3 seconds" (:179-180, :229).
  'kling-3.0-video': { element: 3 },
  // kling-2.6/motion-control and kling-3.0/motion-control: "Between 3-30 seconds per video"
  // (motion-control:51, :188; motion-control-v3:45).
  'kling-2.6': { motion: 3 },
  'kling-3.0': { motion: 3 },
};

const REFERENCE_MEDIA_NOUNS: Readonly<Record<ReferenceMediaRole, { group: string; one: string }>> = {
  video: { group: 'reference videos', one: 'Reference video' },
  audio: { group: 'reference audio', one: 'Reference audio' },
  element: { group: 'video elements', one: 'Video element' },
  motion: { group: 'motion reference videos', one: 'The reference video' },
};

export type ReferenceMediaLength = {
  role: ReferenceMediaRole;
  /** Its length in seconds. A missing or non-positive length is one nobody knows, and is not judged. */
  durationSeconds?: number | null;
  /**
   * False when the length is the whole seconds a run is priced at, not the file's own
   * measure: the refusal then names the minimum only.
   */
  exact?: boolean;
  /** What the creator calls it. */
  label?: string | null;
};

function seconds(value: number): string {
  return `${value} second${value === 1 ? '' : 's'}`;
}

/**
 * Why the provider would refuse a run's reference media for being too short, in words
 * for the creator, or null when every length it knows is long enough.
 */
export function referenceMediaLengthViolation(
  modelId: string,
  media: readonly ReferenceMediaLength[],
): string | null {
  if (!hasRule(REFERENCE_MEDIA_MIN_SECONDS, modelId)) return null;
  const minimums = REFERENCE_MEDIA_MIN_SECONDS[modelId];
  const placeByRole = new Map<ReferenceMediaRole, number>();
  for (const item of media) {
    const place = (placeByRole.get(item.role) ?? 0) + 1;
    placeByRole.set(item.role, place);
    const minimum = minimums[item.role];
    const length = item.durationSeconds;
    if (minimum === undefined || typeof length !== 'number' || !Number.isFinite(length) || length <= 0) continue;
    if (length >= minimum) continue;

    const nouns = REFERENCE_MEDIA_NOUNS[item.role];
    const refusal = `${modelDisplayName(modelId)} ${nouns.group} must be at least ${seconds(minimum)} long.`;
    if (item.exact === false) return refusal;
    const label = item.label?.trim()
      || (item.role === 'motion' ? nouns.one : `${nouns.one} ${place}`);
    // Rounded down, so a clip refused for being short never reads as long enough.
    return `${refusal} ${label} runs ${seconds(Math.floor(length * 10) / 10)}.`;
  }
  return null;
}
