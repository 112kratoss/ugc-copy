import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import { getGenerationModelChoiceOptionLabel } from '@/lib/generation-model-catalog';
import { isMotionGeneration } from '@/lib/remix-source';
import { isTemplateResultGeneration, type TemplateRunLink } from '@/lib/template-result';
import {
  GENERATION_SETUP_LABELS,
  GENERATION_SETUP_SWITCH,
  type GenerationSetupEntry,
} from '../../ugc-mobile/lib/generation-setup/generation-setup';

/**
 * A creation's settings as its post shows them to everyone (owner, 2026-11-03):
 * under Made with on the web's post page, and in the app's post Details, which
 * read them from the post's own read (`getPublicPostDetail`,
 * `getShowcaseFeedItemById`). The words are the shared module's, so both
 * clients draw the same line.
 *
 * This is the setup a recipe made from a creation used to carry as a protected
 * "Saved generation setup" note (`generation-paywall.ts` wrote it, through the
 * same fields and wording), less what the post already says or a recipe still
 * sells: the model, which Made with names, and the inputs, which a locked
 * recipe's preview counts by kind. A template's result shows none: its settings
 * and model are the template author's (`template-result.ts`).
 */

/** The columns of a creation the setup is read from, and whether it is a template's result. */
export const PUBLIC_GENERATION_SETUP_COLUMNS = 'model, category, creation_mode, workflow_settings, template_run_id, template_run_step_id';

export type PublicGenerationSetupRow = TemplateRunLink & {
  model?: string | null;
  category?: string | null;
  creation_mode?: string | null;
  workflow_settings?: unknown;
};

type WorkflowSettings = Record<string, unknown>;

const LABELS = GENERATION_SETUP_LABELS;

function settingText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function settingSeconds(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? `${value}s` : null;
}

function switchValue(value: boolean): string {
  return value ? GENERATION_SETUP_SWITCH.on : GENERATION_SETUP_SWITCH.off;
}

/** "9:16", or "Auto" however the model spells it ("auto", "Auto"). */
function aspectRatioValue(value: unknown): string | null {
  const ratio = settingText(value);
  return ratio && ratio.toLowerCase() === 'auto' ? 'Auto' : ratio;
}

/** "1K", "720P": as the creators' settings chip writes a resolution. */
function resolutionValue(value: unknown): string | null {
  return settingText(value)?.toUpperCase() ?? null;
}

/** The video mode by the name the model's catalog entry gives it ("Standard (720p)"), else as stored. */
function videoModeValue(modelId: string | null, mode: unknown): string | null {
  const stored = settingText(mode);
  if (!stored || !modelId) return stored;
  return getGenerationModelChoiceOptionLabel(modelId, 'mode', stored) ?? stored;
}

/** The motion creator's own words for the two orientations (`CreateMotionClient`). */
function characterOrientationValue(value: unknown): string | null {
  const orientation = settingText(value);
  if (orientation === 'video') return 'Follow video';
  if (orientation === 'image') return 'Favor image';
  return orientation;
}

function shotCount(settings: WorkflowSettings): number {
  // The legacy start records its shots as `multiPrompts`, the catalog path as `shots`.
  const shots = Array.isArray(settings.multiPrompts) && settings.multiPrompts.length > 0
    ? settings.multiPrompts
    : Array.isArray(settings.shots) ? settings.shots : [];
  return shots.length;
}

function entry(label: string, value: string | null): GenerationSetupEntry[] {
  return value ? [{ label, value }] : [];
}

function imageSetup(settings: WorkflowSettings): GenerationSetupEntry[] {
  return [
    ...entry(LABELS.aspectRatio, aspectRatioValue(settings.aspectRatio)),
    ...entry(LABELS.resolution, resolutionValue(settings.resolution)),
    ...entry(LABELS.outputFormat, settingText(settings.outputFormat)?.toUpperCase() ?? null),
    ...entry(LABELS.googleSearch, typeof settings.googleSearch === 'boolean' ? switchValue(settings.googleSearch) : null),
  ];
}

function videoSetup(settings: WorkflowSettings, modelId: string | null): GenerationSetupEntry[] {
  const resolution = resolutionValue(settings.resolution);
  const shots = shotCount(settings);
  return [
    ...entry(LABELS.aspectRatio, aspectRatioValue(settings.aspectRatio)),
    // A model without resolutions names its mode for them ("Standard (720p)").
    ...(resolution
      ? entry(LABELS.resolution, resolution)
      : entry(LABELS.mode, videoModeValue(modelId, settings.mode))),
    ...entry(LABELS.duration, settingSeconds(settings.duration)),
    ...entry(LABELS.sound, typeof settings.sound === 'boolean' ? switchValue(settings.sound) : null),
    ...entry(LABELS.camera, settings.fixedLens === true ? 'Fixed lens' : null),
    ...entry(LABELS.shots, shots > 0 ? String(shots) : null),
  ];
}

function motionSetup(settings: WorkflowSettings): GenerationSetupEntry[] {
  return [
    ...entry(LABELS.duration, settingSeconds(settings.duration)),
    // The legacy start records its render mode as `mode`, the catalog path as `resolution`.
    ...entry(LABELS.renderMode, resolutionValue(settingText(settings.mode) ?? settings.resolution)),
    ...entry(LABELS.characterOrientation, characterOrientationValue(settings.characterOrientation)),
  ];
}

/**
 * The settings a creation's post shows, in the order the creators set them:
 * image, its aspect ratio, resolution, output format and Google Search
 * grounding; video, its aspect ratio, resolution (or mode), length, sound,
 * camera and shots; motion, its length, render mode and character orientation.
 * None for a template's result, a creation of another kind, or no creation.
 */
export function buildPublicGenerationSetup(generation: PublicGenerationSetupRow | null | undefined): GenerationSetupEntry[] {
  if (!generation || isTemplateResultGeneration(generation)) {
    return [];
  }

  const settings: WorkflowSettings = generation.workflow_settings && typeof generation.workflow_settings === 'object' && !Array.isArray(generation.workflow_settings)
    ? generation.workflow_settings as WorkflowSettings
    : {};
  const category = generation.category ?? null;
  const isMotion = isMotionGeneration({ category, creationMode: generation.creation_mode ?? null, workflowSettings: settings });
  const modelId = settingText(settings.model) ?? settingText(generation.model);

  if (category === 'image') return imageSetup(settings);
  if ((category === 'video' && !isMotion) || category === 'ugc-ad') return videoSetup(settings, modelId);
  if (isMotion) return motionSetup(settings);
  return [];
}

/**
 * The setup of the creation a post was made from, for a read that does not
 * already hold the creation's row (the app's post read by id). A read that
 * fails shows no setup rather than failing the post: it is a detail.
 */
export async function loadPublicGenerationSetup(
  adminSupabase: SupabaseClient,
  generationId: string | null | undefined,
): Promise<GenerationSetupEntry[]> {
  if (!generationId) return [];

  const { data, error } = await adminSupabase
    .from('generations')
    .select(PUBLIC_GENERATION_SETUP_COLUMNS)
    .eq('id', generationId)
    .maybeSingle();

  if (error) {
    logBackendError('failed_to_fetch_public_generation_setup', { error });
    return [];
  }

  return buildPublicGenerationSetup(data as PublicGenerationSetupRow | null);
}
