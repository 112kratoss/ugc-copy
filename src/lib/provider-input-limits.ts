import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '@/lib/models';
import { mediaTooShortMessage } from '../../ugc-mobile/lib/model-catalog/protocol';
import {
  promptLimitViolation,
  providerPromptMaxLength,
  type ProviderPromptRun,
} from '../../ugc-mobile/lib/model-catalog/provider-prompt-limits';

/**
 * What Kie refuses in a run's prompt and reference media, for each app model, as its
 * model pages documented them on 2026-10-20 (docs.kie.ai/market/…, read for the model
 * check-up recorded in archive/model-checkup-2026-10-20). Kie answers a createTask it
 * refuses with an error inside HTTP 200, after the start has held the run's credits,
 * so the run fails and is refunded. The start services ask these first, before any
 * hold.
 *
 * The prompt rules live in ugc-mobile/lib/model-catalog/provider-prompt-limits.ts, which
 * both creators read too, so a creator meets a model's limit while typing: this module
 * holds the starts to them, naming each model as the creators do. A model with no entry
 * keeps the shared GENERATION_PROMPT_MAX_LENGTH, which the starts check on the prompt as
 * written: its provider takes at least that much.
 */
export { providerPromptMaxLength };
export type { ProviderPromptRun };

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

/**
 * Why the provider would refuse the prompts a run sends it, in words for the creator
 * that name the model and the limit, or null when it would take them.
 */
export function providerPromptViolation(modelId: string, run: ProviderPromptRun): string | null {
  return promptLimitViolation(modelId, modelDisplayName(modelId), run);
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
  // wan/3-0-video and -prime: each reference clip "must be 1–15 seconds", each audio track
  // 1–15 s (docs/model-api-references/wan-3-0.md:26-28).
  'wan-3.0': { video: 1, audio: 1 },
  'wan-3.0-prime': { video: 1, audio: 1 },
  // kling-3.0/video: a video element's "duration must be at least 3 seconds" (:179-180, :229).
  'kling-3.0-video': { element: 3 },
  // kling-2.6/motion-control and kling-3.0/motion-control: "Between 3-30 seconds per video"
  // (motion-control:51, :188; motion-control-v3:45).
  'kling-2.6': { motion: 3 },
  'kling-3.0': { motion: 3 },
};

/**
 * What a file is to a run, as the start holds it to its provider's shortest: any track is
 * reference audio, a clip of a motion run is its performance, a clip in Kling 3.0's
 * `videoElements` slot is a named element, and any other clip a reference clip. The catalog
 * start judges each input by it, and the release CLI holds a published minimum to the role's.
 */
export function referenceMediaRole(
  runKind: 'image' | 'video' | 'motion',
  slotKey: string,
  mediaKind: 'video' | 'audio',
): ReferenceMediaRole {
  if (mediaKind === 'audio') return 'audio';
  if (runKind === 'motion') return 'motion';
  return slotKey === 'videoElements' ? 'element' : 'video';
}

/**
 * The shortest file the model's provider takes in that role, in seconds, or undefined where it
 * states none. The catalog publishes it on the slot the role travels in (`minDurationSeconds`),
 * so both creators hold a run to the minimum this module refuses it by.
 */
export function referenceMediaMinSeconds(modelId: string, role: ReferenceMediaRole): number | undefined {
  return hasRule(REFERENCE_MEDIA_MIN_SECONDS, modelId) ? REFERENCE_MEDIA_MIN_SECONDS[modelId][role] : undefined;
}

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

/**
 * Why the provider would refuse a run's reference media for being too short, in words
 * for the creator, or null when every length it knows is long enough. The words are
 * `mediaTooShortMessage`'s, which both creators say before Generate too.
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
    const what = `${modelDisplayName(modelId)} ${nouns.group}`;
    if (item.exact === false) return mediaTooShortMessage(what, minimum);
    const label = item.label?.trim()
      || (item.role === 'motion' ? nouns.one : `${nouns.one} ${place}`);
    return mediaTooShortMessage(what, minimum, { label, durationSeconds: length });
  }
  return null;
}
