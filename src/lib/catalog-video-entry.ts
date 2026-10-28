import type { CatalogControl, GenerationModelDescriptor } from '@/lib/generation-model-catalog';

/**
 * What a model's registry entry takes from its catalog descriptor. The browser lays it
 * over the built-in tables once the catalog is in (`applyGenerationModelCatalogToRegistries`);
 * the server builds video entries from the published catalog the same way, to price a
 * remix on each model as the page will (`creator-start-posts-server.ts`). Kept out of the
 * client module so the server can read it.
 */

export function catalogChoiceControl(model: GenerationModelDescriptor, key: string) {
  return model.controls.find((control): control is Extract<CatalogControl, { type: 'choice' }> => control.key === key && control.type === 'choice');
}

export function catalogIntegerControl(model: GenerationModelDescriptor, key: string) {
  return model.controls.find((control): control is Extract<CatalogControl, { type: 'integer' }> => control.key === key && control.type === 'integer');
}

export function catalogChoiceValues(model: GenerationModelDescriptor, key: string) {
  return catalogChoiceControl(model, key)?.options.map((option) => option.value) ?? [];
}

/** A video model's entry fields, read off its descriptor. */
export function catalogVideoEntryFields(model: GenerationModelDescriptor) {
  const durationChoice = catalogChoiceControl(model, 'duration');
  const durationInteger = catalogIntegerControl(model, 'duration');
  const durations = durationChoice
    ? durationChoice.options.map((option) => Number(option.value)).filter(Number.isFinite)
    : durationInteger ? [durationInteger.defaultValue] : [5];
  const modeControl = catalogChoiceControl(model, 'mode');
  return {
    id: model.id,
    displayName: model.displayName,
    description: model.description,
    supportsMultiShot: model.capabilities.multiShot,
    supportsSound: model.capabilities.sound,
    supportsFixedLens: model.capabilities.fixedLens,
    aspectRatios: catalogChoiceValues(model, 'aspectRatio'),
    durations,
    ...(durationInteger ? { singleShotDurationRange: { min: durationInteger.min, max: durationInteger.max, default: durationInteger.defaultValue } } : {}),
    resolutions: catalogChoiceValues(model, 'resolution'),
    modeOptions: modeControl?.options ?? [],
    catalogManaged: true,
    catalogActive: true,
    catalogInputs: model.inputs,
    catalogDescriptor: model,
    catalogSortOrder: model.sortOrder,
    catalogRecommended: model.recommended,
  };
}
