import type { EnhancerContext, Medium } from '@/lib/prompt-enhancer';

type PromptEnhancementWarningSeverity = 'info' | 'warning' | 'blocking';

export interface PromptEnhancementWarning {
  code: string;
  severity: PromptEnhancementWarningSeverity;
  message: string;
  fixHint?: string;
}

export interface PromptQualityInspection {
  warnings: PromptEnhancementWarning[];
  qualityScore: number;
}

interface PromptQualityOptions {
  medium: Medium;
  selectedModel: string;
  prompt: string;
  context?: EnhancerContext;
}

const ACTION_RE = /\b(walks?|runs?|jumps?|turns?|looks?|smiles?|speaks?|says?|lifts?|holds?|opens?|closes?|reveals?|demonstrates?|uses?|pours?|moves?|transitions?|transforms?|zooms?|pushes?|pulls?|tracks?|pans?|tilts?|orbits?|glides?|drifts?|waves?|dances?|rotates?|shakes?|places?|slides?|reaches?|pauses?)\b/i;
const CAMERA_RE = /\b(camera|shot|close-up|closeup|wide|medium|macro|framing|frame|lens|focus|dolly|push-in|pull-back|pan|tilt|orbit|track|tracking|handheld|static|locked|tripod|pov|overhead|low-angle|high-angle|rack focus|zoom|crane)\b/i;
const AUDIO_RE = /\b(audio|sound|sfx|music|voice|voiceover|dialogue|dialog|ambient|ambience|noise|says?|speaks?|whispers?|tone|chatter|footsteps|hum|whoosh)\b/i;
const TRANSITION_RE = /\b(transition|from|to|into|between|smoothly|morph|transform|match cut|continuity|start|end|ending|finish)\b/i;
const VAGUE_QUALITY_RE = /\b(cinematic|epic|beautiful|cool|amazing|viral|high quality|best|awesome|stunning)\b/gi;
const TEMPORAL_CONNECTOR_RE = /\b(then|after|before|next|finally|suddenly|meanwhile|as .* then|and then)\b/gi;
const QUOTED_DIALOGUE_RE = /["“”][^"“”]{2,}["“”]/;

function normalizeModelId(selectedModel: string): string {
  return selectedModel === 'kling-3.0-video' ? 'kling-3.0/video' : selectedModel;
}

function uniqueWarnings(warnings: PromptEnhancementWarning[]): PromptEnhancementWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function scoreWarnings(warnings: PromptEnhancementWarning[]): number {
  const penalty = warnings.reduce((total, warning) => {
    if (warning.severity === 'blocking') return total + 40;
    if (warning.severity === 'warning') return total + 15;
    return total + 5;
  }, 0);

  return Math.max(0, Math.min(100, 100 - penalty));
}

function countMatches(value: string, pattern: RegExp): number {
  return Array.from(value.matchAll(pattern)).length;
}

export function inspectPromptQuality({
  medium,
  selectedModel,
  prompt,
  context,
}: PromptQualityOptions): PromptQualityInspection {
  const trimmedPrompt = prompt.trim();
  const normalizedModel = normalizeModelId(selectedModel);
  const warnings: PromptEnhancementWarning[] = [];

  if (!trimmedPrompt) {
    warnings.push({
      code: 'empty_prompt',
      severity: 'blocking',
      message: 'Add a prompt before generating.',
      fixHint: 'Describe the subject, one clear action, and the camera behavior.',
    });
    return { warnings, qualityScore: 0 };
  }

  if (medium !== 'video') {
    return { warnings: [], qualityScore: 100 };
  }

  if (trimmedPrompt.length < 18) {
    warnings.push({
      code: 'too_short_video_prompt',
      severity: 'warning',
      message: 'This video prompt is very short and may leave the model guessing.',
      fixHint: 'Add one subject, one action, the setting, and camera movement.',
    });
  }

  if (!ACTION_RE.test(trimmedPrompt)) {
    warnings.push({
      code: 'missing_action',
      severity: 'warning',
      message: 'The prompt does not clearly say what should move or happen.',
      fixHint: 'Add a concrete action such as lifting, walking, revealing, turning, or transitioning.',
    });
  }

  if (!CAMERA_RE.test(trimmedPrompt)) {
    warnings.push({
      code: 'missing_camera_intent',
      severity: 'info',
      message: 'Add camera intent to make the clip more predictable.',
      fixHint: 'Use terms like locked camera, slow push-in, medium shot, close-up, pan, or tracking shot.',
    });
  }

  if ((context?.duration ?? 8) <= 8 && countMatches(trimmedPrompt, TEMPORAL_CONNECTOR_RE) >= 2) {
    warnings.push({
      code: 'too_many_events_for_duration',
      severity: 'warning',
      message: 'The prompt may contain too many beats for a short clip.',
      fixHint: 'Keep this generation to one clear moment or split it into multiple shots.',
    });
  }

  const vagueMatches = countMatches(trimmedPrompt, VAGUE_QUALITY_RE);
  if (vagueMatches >= 3) {
    warnings.push({
      code: 'vague_quality_language',
      severity: 'info',
      message: 'The prompt leans on broad quality words instead of observable direction.',
      fixHint: 'Replace broad adjectives with concrete lighting, framing, texture, and motion details.',
    });
  }

  if (context?.sound && !AUDIO_RE.test(trimmedPrompt)) {
    warnings.push({
      code: 'sound_enabled_without_audio_intent',
      severity: 'info',
      message: 'Sound is enabled, but the prompt does not describe dialogue, ambience, music, or effects.',
      fixHint: 'Add concise audio cues or say that the clip should have no dialogue.',
    });
  }

  if ((context?.elementReferences?.length ?? 0) > 0 && context?.elementReferences?.every((element) => !trimmedPrompt.includes(element.handle))) {
    warnings.push({
      code: 'references_not_mentioned',
      severity: 'info',
      message: 'Reference elements are attached but not mentioned in the prompt.',
      fixHint: 'Mention the relevant @handle when identity, product shape, or wardrobe should be preserved.',
    });
  }

  if ((context?.hasStartImage || context?.hasEndImage) && !TRANSITION_RE.test(trimmedPrompt)) {
    warnings.push({
      code: 'frame_prompt_missing_transition',
      severity: 'warning',
      message: 'Frame-based video works better when the prompt describes the motion between frames.',
      fixHint: 'Describe the subject movement, camera path, and continuity from start to end.',
    });
  }

  if (normalizedModel === 'kling-3.0/video' && context?.isMultiShot && (context.shotCount ?? 0) > 6) {
    warnings.push({
      code: 'kling_too_many_shots',
      severity: 'blocking',
      message: 'Kling multi-shot should stay at 6 shots or fewer.',
      fixHint: 'Merge adjacent beats or split the concept into separate generations.',
    });
  }

  if (normalizedModel === 'veo-3.1' && QUOTED_DIALOGUE_RE.test(trimmedPrompt)) {
    warnings.push({
      code: 'veo_quoted_dialogue',
      severity: 'warning',
      message: 'Veo prompts are less likely to render text when dialogue avoids quotation marks.',
      fixHint: 'Use a speaker format like: Creator says: Glow in one swipe.',
    });
  }

  if ((normalizedModel === 'seedance-2' || normalizedModel === 'seedance-2-fast') && (context?.hasReferenceVideo || (context?.referenceImageCount ?? 0) > 0) && !/\b(reference|same|preserve|match|follow|attached|identity|motion|timing)\b/i.test(trimmedPrompt)) {
    warnings.push({
      code: 'seedance_reference_intent_missing',
      severity: 'info',
      message: 'Seedance reference runs are stronger when the prompt says how references should guide the output.',
      fixHint: 'Mention whether the reference controls identity, product look, motion timing, camera, or audio style.',
    });
  }

  const unique = uniqueWarnings(warnings);
  return {
    warnings: unique,
    qualityScore: scoreWarnings(unique),
  };
}
