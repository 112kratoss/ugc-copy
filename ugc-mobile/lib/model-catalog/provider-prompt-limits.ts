import { GENERATION_PROMPT_MAX_LENGTH, MOTION_PROMPT_MAX_LENGTH } from './protocol';

/**
 * What Kie refuses in a run's prompt, for each app model, as its model pages documented
 * them on 2026-10-20 (the provider's market pages, cited below as <page>:<lines>, read
 * for the model check-up recorded in archive/model-checkup-2026-10-20; the app carries
 * no provider address, which ugc-mobile/__tests__/backend-boundary.test.ts holds it to).
 * Kie answers a createTask it refuses with an error inside HTTP 200, after the start has
 * held the run's credits, so the starts ask these first, before any hold
 * (src/lib/provider-input-limits.ts). Zero-cost probes that day found the prompt caps
 * enforced at the limit + 1 for Z-Image, FLUX.2 Pro, Seedream 5 Lite, Kling 3 Turbo and
 * Ideogram Character ("The text length cannot exceed the maximum limit").
 *
 * Both creators count against the same numbers, so a creator meets a model's limit while
 * typing, not at Generate: the web pages import this file by relative path and the app
 * through its draft validation. Like protocol.ts beside it, it holds no React Native, Expo
 * or Node import (this folder's tsconfig.json says why).
 *
 * A model with no entry keeps the shared GENERATION_PROMPT_MAX_LENGTH, which the starts
 * check on the prompt as written: its provider takes at least that much.
 */
export type ProviderPromptRule = {
  /** The most characters the provider takes in the prompt it is sent. */
  readonly maxLength?: number;
  /** The fewest it takes, where that is more than one. */
  readonly minLength?: number;
  /** The most it takes in each shot of a multi-shot run. */
  readonly shotMaxLength?: number;
  /** The cap holds only for a run without reference pictures: the reference endpoint takes more. */
  readonly textOnly?: boolean;
  /** The characters each mention of a named element counts as, however long its handle. */
  readonly elementMentionLength?: number;
};

export const PROVIDER_PROMPT_RULES: Readonly<Record<string, ProviderPromptRule>> = {
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

/** The rule a model's provider sets on its prompt, or null where only the shared limit applies. */
export function providerPromptRule(modelId: string): ProviderPromptRule | null {
  return Object.prototype.hasOwnProperty.call(PROVIDER_PROMPT_RULES, modelId)
    ? PROVIDER_PROMPT_RULES[modelId]
    : null;
}

/** The most characters a model's provider takes in its prompt, or null where only the shared limit applies. */
export function providerPromptMaxLength(
  modelId: string,
  { hasReferenceImages = false }: { hasReferenceImages?: boolean } = {},
): number | null {
  const rule = providerPromptRule(modelId);
  if (!rule || rule.maxLength === undefined || (rule.textOnly && hasReferenceImages)) return null;
  return rule.maxLength;
}

/** image-elements' HANDLE_PATTERN: an @handle with no word character on either side. */
const MENTION_PATTERN = /(^|[^\w])(@[a-z0-9_]+)(?=$|[^\w])/g;

/**
 * The length Kie counts: each mention of one of the run's named elements counts as at
 * least `mentionLength`, however short its handle. Any other text counts as written.
 */
export function countedPromptLength(
  prompt: string,
  mentionLength: number | null | undefined,
  elementHandles: readonly string[],
): number {
  if (!mentionLength || elementHandles.length === 0) return prompt.length;
  const handles = new Set(elementHandles);
  // A loop over exec, not matchAll: the app's engine compiles this file too.
  const pattern = new RegExp(MENTION_PATTERN.source, 'g');
  let widened = 0;
  for (let match = pattern.exec(prompt); match; match = pattern.exec(prompt)) {
    const handle = match[2];
    if (handles.has(handle) && handle.length < mentionLength) widened += mentionLength - handle.length;
  }
  return prompt.length + widened;
}

/** "10,000": a count with its thousands grouped, as every prompt counter and refusal prints it. */
export function groupPromptDigits(count: number): string {
  return String(Math.max(0, Math.trunc(count))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function characters(count: number): string {
  return `${groupPromptDigits(count)} character${count === 1 ? '' : 's'}`;
}

export type ProviderPromptRun = {
  /**
   * The run's prompt as the provider is sent it, the legend naming its pictures
   * included, or null when the provider's body carries no prompt of the run's own.
   */
  prompt: string | null;
  /**
   * The prompt as the creator wrote it, before the app added the legend that names the
   * run's pictures. When only the legend takes it past the limit, the refusal says so.
   */
  typedPrompt?: string;
  /** Each shot's prompt as it is sent, for a multi-shot run. */
  shots?: readonly string[];
  /** Whether the run sends reference pictures, which picks some models' reference endpoint. */
  hasReferenceImages?: boolean;
  /** The handles of the run's named elements, where the provider counts a mention at a fixed width. */
  elementHandles?: readonly string[];
};

/**
 * Why the provider would refuse the prompts a run sends it, in words for the creator
 * that name the model (`modelName`, as the creators show it) and the limit, or null when
 * it would take them. The server's starts and both creators say the same words.
 */
export function promptLimitViolation(modelId: string, modelName: string, run: ProviderPromptRun): string | null {
  const rule = providerPromptRule(modelId);
  if (!rule) return null;
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
      const typed = run.typedPrompt?.trim();
      const typedCounted = typed === undefined
        ? null
        : countedPromptLength(typed, rule.elementMentionLength, elementHandles);
      if (typedCounted !== null && typedCounted <= maxLength && counted > typedCounted) {
        // The creator's own words fit; the names the app adds for the references do not.
        return `${modelName} prompts support up to ${characters(maxLength)}, including the ${characters(counted - typedCounted)} that name your references. Shorten the prompt by ${characters(counted - maxLength)}.`;
      }
      return `${modelName} prompts support up to ${characters(maxLength)}${mentionNote(run.prompt.length, maxLength)}.`;
    }
    if (rule.minLength !== undefined && run.prompt.trim().length < rule.minLength) {
      return `${modelName} prompts need at least ${characters(rule.minLength)}.`;
    }
  }

  const shotMaxLength = rule.shotMaxLength ?? maxLength;
  if (shotMaxLength !== null) {
    for (const [index, shot] of (run.shots ?? []).entries()) {
      if (countedPromptLength(shot, rule.elementMentionLength, elementHandles) > shotMaxLength) {
        return `Shot ${index + 1}: ${modelName} shot prompts support up to ${characters(shotMaxLength)}${mentionNote(shot.length, shotMaxLength)}.`;
      }
    }
  }
  return null;
}

/** What a creator holds a model's prompt and its shots to. */
export type PromptLimit = {
  /** The most the prompt may hold: its provider's limit where it has one, else the route's own. */
  maxLength: number;
  /** The fewest it may hold, where its provider asks for more than one; null otherwise. */
  minLength: number | null;
  /** The most each shot of a multi-shot run may hold. */
  shotMaxLength: number;
  /** What each mention of one of the run's named elements counts as, where its provider counts them wider. */
  elementMentionLength: number | null;
};

/**
 * The limits a creator holds a prompt to on this model, as the starts hold it: the
 * provider's own where it sets one (a text-only cap only while the run sends no picture),
 * and otherwise the route's limit for the kind, which a motion prompt keeps at Kie's 2,500.
 */
export function promptLimitFor(
  modelId: string,
  { hasReferenceImages = false, kind = 'image' }: { hasReferenceImages?: boolean; kind?: 'image' | 'video' | 'motion' } = {},
): PromptLimit {
  const routeMax = kind === 'motion' ? MOTION_PROMPT_MAX_LENGTH : GENERATION_PROMPT_MAX_LENGTH;
  const rule = providerPromptRule(modelId);
  const maxLength = Math.min(providerPromptMaxLength(modelId, { hasReferenceImages }) ?? routeMax, routeMax);
  return {
    maxLength,
    minLength: rule?.minLength ?? null,
    shotMaxLength: Math.min(rule?.shotMaxLength ?? maxLength, routeMax),
    elementMentionLength: rule?.elementMentionLength ?? null,
  };
}

/** Where a prompt stands against its limit: within it, near it (its last tenth), or past it. */
export type PromptLengthState = 'within' | 'near' | 'over';

/** The share of a limit from which a prompt counter warns that the prompt nears it. */
export const PROMPT_LENGTH_NEAR_SHARE = 0.9;

export function promptLengthState(length: number, limit: number): PromptLengthState {
  if (length > limit) return 'over';
  return length >= Math.ceil(limit * PROMPT_LENGTH_NEAR_SHARE) ? 'near' : 'within';
}

/** "4,812 / 5,000": a prompt counter's words. */
export function promptLengthLabel(length: number, limit: number): string {
  return `${groupPromptDigits(length)} / ${groupPromptDigits(limit)}`;
}

/** A prompt counter's reading: the length the provider counts, against the model's limit. */
export type PromptLengthMeter = {
  length: number;
  limit: number;
  state: PromptLengthState;
  label: string;
};

/**
 * What a counter shows for one prompt or shot. It counts the text as a run sends it:
 * trimmed, and each mention of one of the run's named elements as wide as its provider
 * counts it (Kling 3.0's video elements count 37 each).
 */
export function promptLengthMeter(
  text: string,
  limit: number,
  { elementMentionLength = null, elementHandles = [] }: { elementMentionLength?: number | null; elementHandles?: readonly string[] } = {},
): PromptLengthMeter {
  const length = countedPromptLength(text.trim(), elementMentionLength, elementHandles);
  return { length, limit, state: promptLengthState(length, limit), label: promptLengthLabel(length, limit) };
}

/** A creator's prompts, as typed, and what of the run decides how its provider counts them. */
export type CreatorPromptRun = {
  /** The prompt: a single-shot run's, or the one a multi-shot run keeps behind its shots. */
  prompt: string;
  isMultiShot?: boolean;
  /** Each shot's prompt, for a multi-shot run. */
  shots?: readonly string[];
  /** Whether the run sends reference pictures. */
  hasReferenceImages?: boolean;
  /** The handles of the run's named elements (Kling 3.0's video elements). */
  elementHandles?: readonly string[];
};

/**
 * Why the start would refuse the prompts a creator's run sends, in the start's own words,
 * or null. The run is put together as the video start puts it together for this check
 * (startVideoGeneration in src/lib/generation-services.ts): a multi-shot Kling 3.0 run
 * sends its shots and no prompt of its own, and a Kling O3 run sends its prompt, or in
 * multi-shot its first shot when it kept none. An empty prompt is left to the creator's
 * own "a prompt is required" check, and an empty shot, which is never too long, keeps its
 * place, so a refusal numbers its shot as the start does. The legend the start adds to
 * name a run's pictures is not counted here: the start says so itself, before anything
 * is held.
 */
export function creatorPromptViolation(modelId: string, modelName: string, run: CreatorPromptRun): string | null {
  const prompt = run.prompt.trim();
  const shots = run.isMultiShot ? (run.shots ?? []).map((shot) => shot.trim()) : [];
  const sentPrompt = modelId === 'kling-o3'
    ? prompt || (run.isMultiShot ? shots[0] ?? '' : '')
    : modelId === 'kling-3.0-video' && run.isMultiShot ? '' : prompt;
  return promptLimitViolation(modelId, modelName, {
    prompt: sentPrompt || null,
    shots,
    hasReferenceImages: run.hasReferenceImages ?? false,
    elementHandles: run.elementHandles ?? [],
  });
}
