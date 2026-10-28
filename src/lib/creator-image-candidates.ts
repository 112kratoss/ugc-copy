import { catalogRunQuoteInput } from '../../ugc-mobile/lib/model-catalog/protocol';
import {
  getImageQualityModes,
  getImageResolutionOptions,
  IMAGE_MODELS,
  type ImageModelId,
} from '@/lib/client-generation-models';
import { planImageRunInputs, type ImageRunInput } from '@/lib/creator-run-inputs';
import type { GenerationModelDescriptor, GenerationModelQuoteInput } from '@/lib/generation-model-catalog';

/**
 * The image creator's run moved to another model, for its model list: the settings the
 * page lands on when the model is picked, read as its own clamp reads them (a ratio, a
 * resolution or a quality mode the model lacks becomes the model's default), the pictures
 * the model takes, and the quote request that prices that run. So the price on a row is
 * the price Generate shows once the creator is on the model.
 */

type ImageRegistryEntry = (typeof IMAGE_MODELS)[ImageModelId] & { catalogDescriptor?: GenerationModelDescriptor };

/** The settings the image form sets, as the page holds them. */
export type ImageFormSettings = {
  aspectRatio: string;
  resolution: string;
  qualityMode: string;
  googleSearch: boolean;
};

function entryOf(modelId: string): ImageRegistryEntry | undefined {
  return (IMAGE_MODELS as unknown as Record<string, ImageRegistryEntry | undefined>)[modelId];
}

/** A choice's default as the model's descriptor gives it, or the first option before its details are in. */
function choiceDefault(entry: ImageRegistryEntry, key: string, fallback: string): string {
  const control = entry.catalogDescriptor?.controls.find((candidate) => candidate.key === key);
  return control?.type === 'choice' ? control.defaultValue : fallback;
}

/** The form's settings on a model, as the page's clamp leaves them once the model is picked. */
export function fitImageFormToModel(modelId: string, form: ImageFormSettings): ImageFormSettings | null {
  const entry = entryOf(modelId);
  if (!entry) return null;
  const ratios = entry.aspectRatios as readonly string[];
  const aspectRatio = ratios.includes(form.aspectRatio) ? form.aspectRatio : choiceDefault(entry, 'aspectRatio', ratios[0]);
  const resolutions = getImageResolutionOptions(modelId as ImageModelId, aspectRatio) as readonly string[];
  const preferred = choiceDefault(entry, 'resolution', resolutions[0] ?? form.resolution);
  const resolution = resolutions.includes(form.resolution)
    ? form.resolution
    : resolutions.includes(preferred) ? preferred : (resolutions[0] ?? form.resolution);
  const modes = getImageQualityModes(modelId as ImageModelId) as readonly string[];
  const qualityMode = modes.length === 0 || modes.includes(form.qualityMode)
    ? form.qualityMode
    : choiceDefault(entry, 'qualityMode', modes[0]);
  return { aspectRatio, resolution, qualityMode, googleSearch: entry.supportsGoogleSearch ? form.googleSearch : false };
}

export type ImageRunOnModel<Element> = {
  modelId: string;
  settings: ImageFormSettings;
  inputs: ImageRunInput<Element>[];
  quoteInput: GenerationModelQuoteInput;
  /** What the price on the model's row is for: "1K · 16:9". */
  summary: string;
};

/** The run the form would send on `modelId`: its settings as the page lands them, and the pictures the model takes. */
export function imageRunOnModel<Element>({
  modelId,
  catalogRevision,
  form,
  elements,
}: {
  modelId: string;
  catalogRevision: string;
  form: ImageFormSettings;
  elements: readonly Element[];
}): ImageRunOnModel<Element> | null {
  const entry = entryOf(modelId);
  const settings = fitImageFormToModel(modelId, form);
  if (!entry || !settings) return null;
  const inputs = planImageRunInputs(elements, entry.maxImages);
  return {
    modelId,
    settings,
    inputs,
    // In the page's own order, so a run on the model in use asks the page's own question.
    quoteInput: catalogRunQuoteInput({
      kind: 'image' as const,
      modelId,
      catalogRevision,
      settings: {
        aspectRatio: settings.aspectRatio,
        resolution: settings.resolution,
        qualityMode: settings.qualityMode,
        googleSearch: settings.googleSearch,
      },
      inputs,
    }),
    summary: [settings.resolution.toUpperCase(), settings.aspectRatio].filter(Boolean).join(' · '),
  };
}
