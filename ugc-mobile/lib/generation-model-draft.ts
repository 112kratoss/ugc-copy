import type {
  CatalogGenerationInputAsset,
  CatalogGenerationRequest,
  CatalogControl,
  CatalogInputConstraint,
  CatalogInputSlot,
  CatalogPrimitive,
  GenerationModelCatalog,
  GenerationModelDescriptor,
  GenerationModelQuoteRequest,
} from './generation-model-catalog';
import {
  catalogConditionsMatch,
  getActiveCatalogInputSlots,
  getCatalogModel,
  normalizeCatalogSettings,
} from './generation-model-catalog';
import {
  extractPromptHandles,
  hydrateCreationDraftFromRemixSource,
  REMIX_RESTORE_WARNING_MESSAGE,
  subjectHandles,
  videoSubjects,
  type CatalogDraftInputAsset,
  type CatalogDraftInputSlots,
  type CreationDraft,
  type CreationSectionSummary,
  type CreationValidationResult,
  type ImageCreationDraft,
  type MediaDraft,
  type MotionCreationDraft,
  type ReferenceMode,
  type VideoCreationDraft,
  type VideoShotDraft,
} from './media-creation-view-model';
import {
  modeGatedSettingValues,
  SUBJECT_IMAGES_PER_NAME,
  SUBJECT_IMAGES_SLOT_KEY,
  subjectsPerRun,
} from './model-catalog/protocol';
import {
  createSeedanceAssetMetadata,
  getPreferredSeedanceReferenceValue,
  isSeedance2VideoModelId,
  type SeedanceAssetKind,
} from './model-catalog/seedance-assets';
import type {
  GenerationElementDescriptor,
  ImageGenerationRequest,
  MotionGenerationRequest,
  RemixMediaAssetDescriptor,
  RemixSourceBundle,
  VideoGenerationRequest,
} from './types';
import { formatCreditCost } from './generation-action-label';

function draftKey(draft: CreationDraft, controlKey: string) {
  return draft.tool === 'motion' && controlKey === 'resolution' ? 'mode' : controlKey;
}

function currentControlValue(draft: CreationDraft, control: CatalogControl): CatalogPrimitive | undefined {
  const value = (draft as unknown as Record<string, unknown>)[draftKey(draft, control.key)];
  if (control.type === 'choice') {
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') return value;
    const catalogValue = draft.catalogSettings?.[control.key];
    return typeof catalogValue === 'string' ? catalogValue : undefined;
  }
  if (control.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    const catalogValue = draft.catalogSettings?.[control.key];
    return typeof catalogValue === 'boolean' ? catalogValue : undefined;
  }
  if (typeof value === 'number') return value;
  const catalogValue = draft.catalogSettings?.[control.key];
  return typeof catalogValue === 'number' ? catalogValue : undefined;
}

function preparedAudioIds(draft: VideoCreationDraft): string[] {
  return Array.isArray(draft.preparedAudioIds) ? draft.preparedAudioIds : [];
}

function characterIds(draft: VideoCreationDraft): string[] {
  return Array.isArray(draft.characterIds) ? draft.characterIds : [];
}

function normalizedControlValue(
  draft: CreationDraft,
  control: CatalogControl,
  modeGated: Map<string, Set<string>>,
): CatalogPrimitive {
  const current = currentControlValue(draft, control);
  if (control.type === 'choice') {
    return typeof current === 'string'
      && (control.options.some((option) => option.value === current) || modeGated.get(control.key)?.has(current))
      ? current
      : control.defaultValue;
  }
  if (control.type === 'boolean') return typeof current === 'boolean' ? current : control.defaultValue;
  return typeof current === 'number'
    && Number.isInteger(current)
    && current >= control.min
    && current <= control.max
    && (current - control.min) % control.step === 0
    ? current
    : control.defaultValue;
}

function writeControlValues(draft: CreationDraft, model: GenerationModelDescriptor) {
  const values: Record<string, CatalogPrimitive> = {};
  const modeGated = modeGatedSettingValues(model.inputModes);
  for (const control of model.controls) {
    const value = normalizedControlValue(draft, control, modeGated);
    const key = draftKey(draft, control.key);
    values[key] = control.key === 'duration' && control.type === 'choice' ? Number(value) : value;
  }
  return values;
}

/** A shot's length as a run sends it: whole seconds, and at least one. */
function shotSeconds(shot: Pick<VideoShotDraft, 'duration'>) {
  return Math.max(1, Math.round(shot.duration || 0));
}

/**
 * How long a multi-shot run is: its shots' lengths added up, each as the request sends
 * it. The quote, the request and the server's own check all read this one total.
 */
export function multiShotTotalDuration(shots: readonly Pick<VideoShotDraft, 'duration'>[]): number {
  return shots.reduce((total, shot) => total + shotSeconds(shot), 0);
}

export function getCatalogDraftSettings(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
): Record<string, CatalogPrimitive> {
  const current = { ...(draft.catalogSettings ?? {}) };
  for (const control of model.controls) {
    const value = currentControlValue(draft, control);
    if (value !== undefined) current[control.key] = value;
  }
  const settings = normalizeCatalogSettings(model, current);
  // A multi-shot run renders its shots, not the single-shot duration kept behind the shot
  // editor: priced by that, the default two 5 s Kling shots cost what one did. Set after
  // normalizing, so a total the model cannot take reaches the quote as it is and is refused
  // there, rather than becoming the control's default and the price of a run never sent.
  if (draft.tool === 'video' && draft.isMultiShot) {
    settings.duration = multiShotTotalDuration(draft.multiPrompts);
  }
  return settings;
}

function mediaDraftAsset(media: MediaDraft): CatalogDraftInputAsset {
  return {
    id: media.id,
    kind: media.kind,
    url: media.url,
    storagePath: media.storagePath ?? null,
    fileName: media.fileName,
    displayName: media.displayName,
    handle: media.handle ?? null,
    durationSeconds: media.durationSeconds ?? null,
    sourceGenerationId: media.sourceGenerationId ?? null,
    ...(media.seedanceAsset ? { seedanceAsset: media.seedanceAsset } : {}),
  };
}

function idOnlyAsset(id: string, kind: 'character' | 'prepared-voice'): CatalogDraftInputAsset {
  return { id, kind };
}

function legacyAssetsForSlot(
  draft: CreationDraft,
  slot: CatalogInputSlot,
): CatalogDraftInputAsset[] {
  if (slot.role === 'startFrame') {
    return draft.tool === 'video' && draft.startFrame ? [mediaDraftAsset(draft.startFrame)] : [];
  }
  if (slot.role === 'endFrame') {
    // A multi-shot run ends where its last shot does. The quote and the web creator leave
    // the end frame out of one, so the run does too.
    return draft.tool === 'video' && draft.endFrame && !draft.isMultiShot ? [mediaDraftAsset(draft.endFrame)] : [];
  }
  if (slot.key === SUBJECT_IMAGES_SLOT_KEY) {
    // One asset per picture, each under its subject's handle and name: the server
    // groups them back into subjects by the handle, and labels each by the name.
    return draft.tool === 'video'
      ? videoSubjects(draft).flatMap((subject) => subject.images.map((image) => ({
          ...mediaDraftAsset(image),
          displayName: subject.displayName,
          handle: subject.handle,
        })))
      : [];
  }
  if (slot.kind === 'image') {
    if (draft.tool === 'image' || draft.tool === 'video') return draft.references.map(mediaDraftAsset);
    return draft.characterImage ? [mediaDraftAsset(draft.characterImage)] : [];
  }
  if (slot.kind === 'video') {
    if (draft.tool === 'video') return draft.referenceVideos.map(mediaDraftAsset);
    if (draft.tool === 'motion' && draft.referenceVideo) return [mediaDraftAsset(draft.referenceVideo)];
    return [];
  }
  if (slot.kind === 'audio') {
    return draft.tool === 'video' ? draft.referenceAudios.map(mediaDraftAsset) : [];
  }
  if (slot.kind === 'preparedVoice') {
    return draft.tool === 'video'
      ? preparedAudioIds(draft).map((id) => idOnlyAsset(id, 'prepared-voice'))
      : [];
  }
  return draft.tool === 'video'
    ? characterIds(draft).map((id) => idOnlyAsset(id, 'character'))
    : [];
}

function heldSlotAssets(draft: CreationDraft, slot: CatalogInputSlot): CatalogDraftInputAsset[] {
  return draft.catalogInputSlots?.[slot.key] ?? legacyAssetsForSlot(draft, slot);
}

function heldInputCounts(draft: CreationDraft, model: GenerationModelDescriptor): Record<string, number> {
  return Object.fromEntries((model.inputModes ?? [])
    .flatMap((mode) => mode.slots)
    .map((slot) => [slot.key, heldSlotAssets(draft, slot).length]));
}

/**
 * Each slot a run with these settings opens, with everything the draft holds for it. The
 * validator reads this, so it can say when a slot holds more than it takes.
 */
function heldCatalogDraftInputSlots(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  settings: Record<string, CatalogPrimitive>,
): Array<{ slot: CatalogInputSlot; assets: CatalogDraftInputAsset[] }> {
  return getActiveCatalogInputSlots(model, settings, heldInputCounts(draft, model))
    .map((slot) => ({ slot, assets: heldSlotAssets(draft, slot) }));
}

/**
 * What a run sends in each slot its settings open: at most the slot's max, and nothing for
 * a slot the model does not have. A draft keeps its references when the model changes, as
 * the web creator does, so it can hold more than this model takes; the rest wait in the
 * draft, and `validateCatalogCreationDraft` blocks the run until they are removed.
 */
export function buildCatalogDraftInputSlots(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  settings: Record<string, CatalogPrimitive> = getCatalogDraftSettings(draft, model),
): CatalogDraftInputSlots {
  return Object.fromEntries(heldCatalogDraftInputSlots(draft, model, settings)
    .map(({ slot, assets }) => [slot.key, assets.slice(0, Math.max(0, slot.max))]));
}

function hasReusableVideoInputs(model: GenerationModelDescriptor) {
  const reusableInputs = [
    model.inputs.imageReferences,
    model.inputs.videoReferences,
    model.inputs.audioReferences,
    model.inputs.preparedAudioReferences,
    model.inputs.characterReferences,
  ];
  return reusableInputs.some((input) => Boolean(input && input.max > 0));
}

/**
 * The slot a model's named subjects travel in, when its descriptor publishes one. The
 * same descriptor gives the web creator its editor, so subjects appear on exactly the
 * models the catalog says take them.
 */
export function catalogSubjectSlot(model: GenerationModelDescriptor | null | undefined): CatalogInputSlot | null {
  for (const mode of model?.inputModes ?? []) {
    const slot = mode.slots.find((candidate) => candidate.key === SUBJECT_IMAGES_SLOT_KEY);
    if (slot && slot.max > 0) return slot;
  }
  return null;
}

function isFrameSlot(slot: CatalogInputSlot) {
  return slot.role === 'startFrame' || slot.role === 'endFrame';
}

/** The shape a model's default input mode opens, for a draft whose attachments decide nothing. */
function defaultRunReferenceMode(
  model: GenerationModelDescriptor,
  framesShape: CatalogInputSlot[],
  referencesShape: CatalogInputSlot[],
): ReferenceMode {
  const gate = model.inputModes?.find((mode) => mode.default)?.conditions?.find((condition) => (
    condition.source === 'setting' && condition.key === 'referenceMode' && condition.operator === 'equals'
  ))?.value;
  if (gate === 'frames' || gate === 'elements') return gate;
  if (framesShape.some(isFrameSlot)) return 'frames';
  return referencesShape.some((slot) => slot.role === 'reference') ? 'elements' : 'frames';
}

/**
 * The shape a video run takes on this model, read off what the draft holds that the model
 * carries. Named subjects while one is attached and the model takes them, across multi-shot
 * too. Frames in any other multi-shot run, which sends its shots and no reference picture,
 * as the web creator's does. Otherwise references only when the draft holds something the
 * model takes in its references shape alone: a reference kept from another model, which
 * this one has no slot for, must not turn a frames run into a references run and leave its
 * frames out, and video elements that ride with either shape (Kling 3.0's) keep the frames.
 */
export function catalogVideoRunReferenceMode(
  draft: VideoCreationDraft,
  model: GenerationModelDescriptor,
): ReferenceMode {
  if (videoSubjects(draft).length > 0 && catalogSubjectSlot(model)) return 'subjects';
  if (draft.isMultiShot) return 'frames';
  if (!model.inputModes) {
    // A descriptor without input modes has no slots to read, so the draft's mode stands
    // where the model supports it.
    const supportsFrames = model.inputs.startFrame || model.inputs.endFrame;
    const supportsReusableReferences = hasReusableVideoInputs(model);
    if (draft.referenceMode === 'elements' && supportsReusableReferences) return 'elements';
    if (draft.referenceMode === 'frames' && supportsFrames) return 'frames';
    return supportsReusableReferences ? 'elements' : 'frames';
  }
  const settings = getCatalogDraftSettings(draft, model);
  const counts = heldInputCounts(draft, model);
  const framesShape = getActiveCatalogInputSlots(model, { ...settings, referenceMode: 'frames' }, counts);
  const referencesShape = getActiveCatalogInputSlots(model, { ...settings, referenceMode: 'elements' }, counts);
  const inFramesShape = new Set(framesShape.map((slot) => slot.key));
  const holds = (slot: CatalogInputSlot) => heldSlotAssets(draft, slot).length > 0;
  if (referencesShape.some((slot) => slot.role === 'reference' && !inFramesShape.has(slot.key) && holds(slot))) {
    return 'elements';
  }
  if (framesShape.some((slot) => isFrameSlot(slot) && holds(slot))) return 'frames';
  return defaultRunReferenceMode(model, framesShape, referencesShape);
}

/** The draft as a run on this model reads it: in the run's own reference shape. */
function catalogRunDraft<T extends CreationDraft>(draft: T, model: GenerationModelDescriptor): T {
  return draft.tool === 'video'
    ? { ...draft, referenceMode: catalogVideoRunReferenceMode(draft, model) } as T
    : draft;
}

function catalogRunSettings(runDraft: CreationDraft, model: GenerationModelDescriptor) {
  const settings = getCatalogDraftSettings(runDraft, model);
  if (runDraft.tool === 'video') settings.referenceMode = runDraft.referenceMode;
  return settings;
}

export function applyCatalogModelDefaults(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  catalogRevision: string | null = draft.catalogRevision ?? null,
): CreationDraft {
  const values = writeControlValues(draft, model);
  // References, clips, tracks and generic slot inputs stay in the draft whatever this model
  // takes: cut to its slots, they were gone for good, and picking the first model again did
  // not bring them back. A run sends what the model takes (buildCatalogDraftInputSlots), and
  // an excess blocks Generate with the slot's message until it is removed.
  if (draft.tool === 'image') {
    const normalized = { ...draft, ...values, model: model.id, catalogRevision } as ImageCreationDraft;
    return { ...normalized, catalogSettings: getCatalogDraftSettings(normalized, model) };
  }
  if (draft.tool === 'video') {
    const isMultiShot = model.capabilities.multiShot ? Boolean(values.isMultiShot ?? draft.isMultiShot) : false;
    const subjectSlot = catalogSubjectSlot(model);
    const normalized = {
      ...draft,
      ...values,
      model: model.id,
      catalogRevision,
      isMultiShot,
      sound: model.capabilities.sound ? Boolean(values.sound ?? draft.sound) : false,
      fixedLens: model.capabilities.fixedLens ? Boolean(values.fixedLens ?? draft.fixedLens) : false,
      subjects: subjectSlot
        ? videoSubjects(draft).slice(0, subjectsPerRun(subjectSlot))
        : [],
      preparedAudioIds: model.inputs.preparedAudioReferences
        ? preparedAudioIds(draft).slice(0, model.inputs.preparedAudioReferences.max)
        : [],
      characterIds: model.inputs.characterReferences
        ? characterIds(draft).slice(0, model.inputs.characterReferences.max)
        : [],
      startFrame: model.inputs.startFrame ? draft.startFrame : null,
      endFrame: model.inputs.endFrame && !isMultiShot ? draft.endFrame : null,
    } as VideoCreationDraft;
    const shaped = { ...normalized, referenceMode: catalogVideoRunReferenceMode(normalized, model) };
    return { ...shaped, catalogSettings: getCatalogDraftSettings(shaped, model) };
  }
  const normalized = { ...draft, ...values, model: model.id, catalogRevision } as MotionCreationDraft;
  return { ...normalized, catalogSettings: getCatalogDraftSettings(normalized, model) };
}

export function applyCatalogModelInitialDefaults(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  catalogRevision: string,
): CreationDraft {
  const descriptorDefaults = Object.fromEntries(model.controls.map((control) => [
    draftKey(draft, control.key),
    control.key === 'duration' && control.type === 'choice'
      ? Number(control.defaultValue)
      : control.defaultValue,
  ]));
  return applyCatalogModelDefaults({
    ...draft,
    ...descriptorDefaults,
    model: model.id,
    catalogSettings: {},
  } as CreationDraft, model, catalogRevision);
}

function referenceSummary(draft: CreationDraft) {
  if (draft.tool === 'image') return draft.references.length === 0 ? 'No references' : `${draft.references.length} image reference${draft.references.length === 1 ? '' : 's'}`;
  if (draft.tool === 'video') {
    const count = draft.references.length + draft.referenceVideos.length + draft.referenceAudios.length + preparedAudioIds(draft).length + characterIds(draft).length + (draft.startFrame ? 1 : 0) + (draft.endFrame ? 1 : 0);
    return count === 0 ? 'No references' : `${count} reference asset${count === 1 ? '' : 's'}`;
  }
  return `${draft.characterImage ? 'Character ready' : 'Character missing'} · ${draft.referenceVideo ? 'motion ready' : 'motion missing'}`;
}

export function getCatalogCreationSectionSummary(draft: CreationDraft, model: GenerationModelDescriptor): CreationSectionSummary {
  if (draft.tool === 'image') {
    return {
      essentials: `${model.displayName} · ${draft.aspectRatio} · ${draft.resolution}`,
      references: referenceSummary(draft),
      advanced: `${draft.outputFormat.toUpperCase()} · Search ${draft.googleSearch ? 'on' : 'off'}`,
    };
  }
  if (draft.tool === 'video') {
    const duration = draft.isMultiShot ? multiShotTotalDuration(draft.multiPrompts) : draft.duration;
    return {
      essentials: `${model.displayName} · ${draft.aspectRatio} · ${duration}s`,
      references: referenceSummary(draft),
      advanced: [draft.mode, draft.resolution, model.capabilities.sound ? `Sound ${draft.sound ? 'on' : 'off'}` : null].filter(Boolean).join(' · ') || 'Default settings',
    };
  }
  return {
    essentials: `${model.displayName} · ${draft.mode} · ${Math.max(1, Math.ceil(draft.referenceVideo?.durationSeconds ?? draft.duration))}s`,
    references: referenceSummary(draft),
    advanced: `${draft.characterOrientation === 'video' ? 'Video' : 'Image'} orientation`,
  };
}

/**
 * The @handles a run's prompt and shots may name: those of the references in the slots
 * the run fills, as the server lets a prompt name only what it is sent. A reference kept
 * from another model, which this one has no slot for, is not one the provider would be
 * given. One past its slot's max still counts here: that excess already blocks the run
 * with its own message, and removing either reference settles which one the prompt meant.
 */
export function catalogDraftRunHandles(draft: CreationDraft, model: GenerationModelDescriptor): string[] {
  if (draft.tool === 'motion') return [];
  if (!model.inputModes) {
    // No slots to read: every named reference the draft holds.
    const references = draft.tool === 'image'
      ? draft.references
      : [
          ...draft.references,
          ...(model.id === 'kling-3.0-video' && draft.referenceMode === 'elements' ? draft.referenceVideos : []),
        ];
    return Array.from(new Set([
      ...references.map((reference) => reference.handle).filter((handle): handle is string => Boolean(handle)),
      ...(draft.tool === 'video' ? subjectHandles(draft) : []),
    ]));
  }
  const runDraft = catalogRunDraft(draft, model);
  return Array.from(new Set(heldCatalogDraftInputSlots(runDraft, model, catalogRunSettings(runDraft, model))
    .filter(({ slot }) => slot.role === 'reference')
    .flatMap(({ assets }) => assets)
    .map((asset) => asset.handle)
    .filter((handle): handle is string => Boolean(handle))));
}

/**
 * The models whose shot prompts the server reads for mentions, refusing a handle no input
 * answers to (startVideoGeneration in src/lib/generation-services.ts). Any other model's
 * shots are sent as written, so a mention refused here would be one the server accepts.
 */
const SHOT_MENTION_CHECKED_MODEL_IDS: ReadonlySet<string> = new Set(['kling-3.0-video', 'kling-o3']);

/**
 * The mentions a run's text names that no input it sends answers to, read the way the
 * server reads them: an image prompt, a single-shot video prompt, and the shots of a Kling
 * 3.0 or Kling O3 multi-shot run. A motion run has no reference a prompt could name, and
 * a multi-shot run is described by its shots, so the prompt it keeps is not read.
 */
function unknownPromptMentions(draft: CreationDraft, model: GenerationModelDescriptor) {
  if (draft.tool === 'motion') return [];
  const knownHandles = catalogDraftRunHandles(draft, model);
  const unknownIn = (text: string) => extractPromptHandles(text).filter((handle) => !knownHandles.includes(handle));
  if (draft.tool === 'video' && draft.isMultiShot) {
    return SHOT_MENTION_CHECKED_MODEL_IDS.has(model.id)
      ? Array.from(new Set(draft.multiPrompts.flatMap((shot) => unknownIn(shot.prompt))))
      : [];
  }
  return unknownIn(draft.prompt);
}

/**
 * Shots per multi-shot run, by model: Kie's `multi_prompt` takes at most 5 for Kling 3.0
 * and 6 for Kling O3. The web creator holds runs to the same numbers
 * (src/lib/prompt-quality.ts); no descriptor publishes them yet.
 */
const MULTI_SHOT_MAX_SHOTS: Readonly<Record<string, number>> = {
  'kling-3.0-video': 5,
  'kling-o3': 6,
};

/**
 * What a multi-shot run on this model may hold: a shot count (null where none is known)
 * and a total length, which is the most its duration control offers, since the run's
 * duration is the shots' total. Both are null for a model without multi-shot.
 */
export function catalogMultiShotLimits(model: GenerationModelDescriptor): {
  maxShots: number | null;
  maxTotalSeconds: number | null;
} {
  if (!model.capabilities.multiShot) return { maxShots: null, maxTotalSeconds: null };
  const duration = model.controls.find((control) => control.key === 'duration');
  const choices = duration?.type === 'choice'
    ? duration.options.map((option) => Number(option.value)).filter((value) => Number.isFinite(value))
    : [];
  return {
    maxShots: MULTI_SHOT_MAX_SHOTS[model.id] ?? null,
    maxTotalSeconds: duration?.type === 'integer'
      ? duration.max
      : choices.length > 0 ? Math.max(...choices) : null,
  };
}

function validateControls(draft: CreationDraft, model: GenerationModelDescriptor, errors: string[]) {
  // A value an input mode is gated on is a shape the model takes, listed by the
  // control or not; the server's quote accepts it the same way.
  const modeGated = modeGatedSettingValues(model.inputModes);
  for (const control of model.controls) {
    const value = currentControlValue(draft, control);
    if (
      control.type === 'choice'
      && (typeof value !== 'string' || !(control.options.some((option) => option.value === value) || modeGated.get(control.key)?.has(value)))
    ) {
      errors.push(`${model.displayName} does not support ${control.label.toLowerCase()} ${String(value ?? '')}.`);
    }
    if (control.type === 'boolean' && typeof value !== 'boolean') {
      errors.push(`${control.label} must be on or off.`);
    }
    if (
      control.type === 'integer'
      && (
        typeof value !== 'number'
        || !Number.isInteger(value)
        || value < control.min
        || value > control.max
        || (value - control.min) % control.step !== 0
      )
    ) {
      errors.push(`${control.label} must be between ${control.min} and ${control.max}.`);
    }
  }
}

function validateCatalogInputLimit(
  count: number,
  limit: { max: number } | null,
  unsupportedMessage: string,
  limitMessage: (max: number) => string,
  errors: string[]
) {
  if (count <= 0) return;
  if (!limit) {
    errors.push(unsupportedMessage);
    return;
  }
  if (count > limit.max) errors.push(limitMessage(limit.max));
}

function catalogInputConstraintValue(
  constraint: CatalogInputConstraint,
  slots: CatalogDraftInputSlots,
) {
  if (constraint.type === 'combined-duration') {
    return constraint.slotKeys.reduce((total, slotKey) => (
      total + (slots[slotKey] ?? []).reduce((slotTotal, asset) => (
        slotTotal + Math.max(0, asset.durationSeconds ?? 0)
      ), 0)
    ), 0);
  }
  return constraint.slotKeys.reduce((total, slotKey) => {
    const count = slots[slotKey]?.length ?? 0;
    const weight = constraint.type === 'weighted-count'
      ? constraint.weights?.[slotKey] ?? 1
      : 1;
    return total + count * weight;
  }, 0);
}

function validateCatalogV2Inputs(
  runDraft: CreationDraft,
  model: GenerationModelDescriptor,
  errors: string[],
) {
  const settings = catalogRunSettings(runDraft, model);
  const held = heldCatalogDraftInputSlots(runDraft, model, settings);
  // What the run would send, which every rule but the slot's own max is about.
  const slots: CatalogDraftInputSlots = Object.fromEntries(
    held.map(({ slot, assets }) => [slot.key, assets.slice(0, Math.max(0, slot.max))]),
  );
  const inputCounts = Object.fromEntries(
    Object.entries(slots).map(([key, assets]) => [key, assets.length]),
  );
  for (const { slot, assets: heldAssets } of held) {
    const assets = slots[slot.key] ?? [];
    if (assets.length < slot.min) {
      errors.push(`${slot.label} requires at least ${slot.min} input${slot.min === 1 ? '' : 's'}.`);
    }
    // More than the slot takes: the run would leave the rest out without a word, so it
    // waits until the creator removes them, or switches to a model that takes them.
    if (heldAssets.length > slot.max) {
      errors.push(`${slot.label} supports up to ${slot.max} input${slot.max === 1 ? '' : 's'}.`);
    }
    for (const asset of assets) {
      if (slot.durationMetadata === 'required' && !(typeof asset.durationSeconds === 'number' && asset.durationSeconds >= 0)) {
        errors.push(`${slot.label} requires duration metadata.`);
      }
      if (
        typeof slot.maxDurationSeconds === 'number'
        && typeof asset.durationSeconds === 'number'
        && asset.durationSeconds > slot.maxDurationSeconds
      ) {
        errors.push(`${slot.label} inputs must be ${slot.maxDurationSeconds} seconds or shorter.`);
      }
    }
  }
  for (const constraint of model.inputConstraints ?? []) {
    if (!catalogConditionsMatch(constraint.conditions, settings, inputCounts)) continue;
    if (catalogInputConstraintValue(constraint, slots) > constraint.max) {
      errors.push(constraint.message);
    }
  }
  // A prompt-only model has no slot to report against. The references stay in the draft
  // for another model; this one cannot use them, as its quote says.
  if (runDraft.tool === 'image' && runDraft.references.length > 0 && !held.some(({ slot }) => slot.kind === 'image')) {
    errors.push(`${model.displayName} does not support image references.`);
  }
  if (runDraft.tool === 'video' && settings.referenceMode === 'subjects') {
    validateSubjects(runDraft, model, errors);
  }
}

/**
 * What the slot's count cannot say about subjects: how many there are, and that each
 * is made of enough pictures to fuse and not more than the provider reads. The server
 * refuses both; a run refused there would have had its credits held first.
 */
function validateSubjects(draft: VideoCreationDraft, model: GenerationModelDescriptor, errors: string[]) {
  const slot = catalogSubjectSlot(model);
  const subjects = videoSubjects(draft);
  if (!slot) {
    if (subjects.length > 0) errors.push(`${model.displayName} does not take named subjects.`);
    return;
  }
  const maxNamed = subjectsPerRun(slot);
  if (subjects.length > maxNamed) {
    errors.push(`${model.displayName} takes up to ${maxNamed} named subject${maxNamed === 1 ? '' : 's'} per run.`);
  }
  for (const subject of subjects) {
    if (subject.images.length < SUBJECT_IMAGES_PER_NAME.min || subject.images.length > SUBJECT_IMAGES_PER_NAME.max) {
      errors.push(`${subject.displayName} needs ${SUBJECT_IMAGES_PER_NAME.min} to ${SUBJECT_IMAGES_PER_NAME.max} pictures of the same person or thing.`);
    }
  }
}

export function validateCatalogCreationDraft(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  options: { credits?: number | null; quotedCost?: number | null } = {}
): CreationValidationResult {
  const errors: string[] = [];
  // Checked as the run it would start: in that run's reference shape.
  const runDraft = catalogRunDraft(draft, model);
  if (draft.tool === 'image' && !draft.prompt.trim()) errors.push('Prompt is required.');
  if (draft.tool === 'video' && !draft.isMultiShot && !draft.prompt.trim()) errors.push('Prompt is required.');
  if (draft.tool === 'video' && draft.isMultiShot && !draft.multiPrompts.every((shot) => shot.prompt.trim())) errors.push('All multi-shot entries need a text prompt.');
  if (draft.tool === 'motion') {
    if (!draft.characterImage) errors.push('Character image is required.');
    if (!draft.referenceVideo) errors.push('Reference video is required.');
  }

  validateControls(runDraft, model, errors);
  if (model.inputModes) {
    validateCatalogV2Inputs(runDraft, model, errors);
  } else if (draft.tool === 'image') {
    validateCatalogInputLimit(
      draft.references.length,
      model.inputs.imageReferences,
      `${model.displayName} does not support image references.`,
      (max) => `${model.displayName} supports up to ${max} total reference images.`,
      errors
    );
  }
  if (!model.inputModes && draft.tool === 'video') {
    if (!model.capabilities.multiShot && draft.isMultiShot) errors.push(`${model.displayName} does not support multi-shot video generation.`);
    if (!model.inputs.startFrame && draft.startFrame) errors.push(`${model.displayName} does not support a start frame.`);
    if (!model.inputs.endFrame && draft.endFrame) errors.push(`${model.displayName} does not support an end frame.`);
    validateCatalogInputLimit(
      draft.references.length,
      model.inputs.imageReferences,
      `${model.displayName} does not support image references.`,
      (max) => `${model.displayName} supports up to ${max} image references.`,
      errors
    );
    validateCatalogInputLimit(
      draft.referenceVideos.length,
      model.inputs.videoReferences,
      `${model.displayName} does not support reference videos.`,
      (max) => `${model.displayName} supports up to ${max} video references.`,
      errors
    );
    validateCatalogInputLimit(
      draft.referenceAudios.length,
      model.inputs.audioReferences,
      `${model.displayName} does not support reference audio.`,
      (max) => `${model.displayName} supports up to ${max} audio references.`,
      errors
    );
    validateCatalogInputLimit(
      preparedAudioIds(draft).length,
      model.inputs.preparedAudioReferences ?? null,
      `${model.displayName} does not support prepared voice references.`,
      (max) => `${model.displayName} supports up to ${max} prepared voice references.`,
      errors
    );
    validateCatalogInputLimit(
      characterIds(draft).length,
      model.inputs.characterReferences ?? null,
      `${model.displayName} does not support prepared character references.`,
      (max) => `${model.displayName} supports up to ${max} prepared character references.`,
      errors
    );
  }

  if (draft.tool === 'video' && draft.isMultiShot) {
    // The provider refuses more shots than it takes, and the run's duration is the shots'
    // total, which the model's duration control bounds.
    const { maxShots, maxTotalSeconds } = catalogMultiShotLimits(model);
    if (maxShots !== null && draft.multiPrompts.length > maxShots) {
      errors.push(`${model.displayName} multi-shot supports at most ${maxShots} shots.`);
    }
    if (maxTotalSeconds !== null && multiShotTotalDuration(draft.multiPrompts) > maxTotalSeconds) {
      errors.push(`${model.displayName} multi-shot runs can be at most ${maxTotalSeconds} seconds in total.`);
    }
  }

  const unknownHandles = unknownPromptMentions(draft, model);
  if (unknownHandles.length > 0) errors.push(`Unknown element mention${unknownHandles.length === 1 ? '' : 's'}: ${unknownHandles.join(', ')}`);

  const hasServerQuote = typeof options.quotedCost === 'number' && Number.isFinite(options.quotedCost);
  const cost = hasServerQuote ? options.quotedCost as number : 0;
  if (typeof options.credits === 'number' && hasServerQuote && options.credits < cost) {
    errors.push(`Insufficient credits. This generation costs ${formatCreditCost(cost)}.`);
  }
  return { errors, warnings: [], cost, canGenerate: errors.length === 0 && hasServerQuote };
}

function referenceSlotOf(kind: CatalogInputSlot['kind']) {
  return (slot: CatalogInputSlot) => (
    slot.role === 'reference' && slot.kind === kind && slot.key !== SUBJECT_IMAGES_SLOT_KEY
  );
}

/**
 * The draft with each kind cut to the limit the descriptor states, which
 * applyCatalogModelDefaults used to cut the draft itself to: what the per-kind payload
 * sends, and what a quote counts for a descriptor without input modes.
 */
function legacyRunDraft<T extends CreationDraft>(runDraft: T, model: GenerationModelDescriptor): T {
  if (runDraft.tool === 'image') {
    return { ...runDraft, references: runDraft.references.slice(0, model.inputs.imageReferences?.max ?? 0) } as T;
  }
  if (runDraft.tool === 'video') {
    return {
      ...runDraft,
      references: runDraft.references.slice(0, model.inputs.imageReferences?.max ?? 0),
      referenceVideos: runDraft.referenceVideos.slice(0, model.inputs.videoReferences?.max ?? 0),
      referenceAudios: runDraft.referenceAudios.slice(0, model.inputs.audioReferences?.max ?? 0),
    } as T;
  }
  return runDraft;
}

export function buildCatalogQuoteRequest(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  catalogRevision: string
): GenerationModelQuoteRequest {
  // Priced as the run it would start: in that run's shape, counting what it sends. A
  // reference the model has no room for is no part of the price, as it is no part of the run.
  const runDraft = catalogRunDraft(draft, model);
  const settings = catalogRunSettings(runDraft, model);
  const inputSlots = buildCatalogDraftInputSlots(runDraft, model, settings);
  const activeSlots = getActiveCatalogInputSlots(model, settings, heldInputCounts(runDraft, model));
  const counted = (matches: (slot: CatalogInputSlot) => boolean) => activeSlots
    .filter(matches)
    .reduce((total, slot) => total + (inputSlots[slot.key]?.length ?? 0), 0);
  const legacy = legacyRunDraft(runDraft, model);
  const inputMetadataSlots = Object.fromEntries(Object.entries(inputSlots).map(([slotKey, assets]) => {
    const durationsSeconds = assets
      .map((asset) => asset.durationSeconds)
      .filter((duration): duration is number => typeof duration === 'number' && Number.isFinite(duration));
    return [slotKey, {
      count: assets.length,
      ...(durationsSeconds.length > 0 ? { durationsSeconds } : {}),
    }];
  }));
  const v2ReferenceVideoDurations = activeSlots
    .filter((slot) => slot.kind === 'video' && slot.role === 'reference')
    .flatMap((slot) => inputSlots[slot.key] ?? [])
    .map((asset) => asset.durationSeconds)
    .filter((duration): duration is number => typeof duration === 'number' && Number.isFinite(duration));
  const legacyReferenceVideoDurations = legacy.tool === 'video'
    ? legacy.referenceVideos
      .map((asset) => asset.durationSeconds)
      .filter((duration): duration is number => typeof duration === 'number' && Number.isFinite(duration))
    : legacy.tool === 'motion' && typeof legacy.referenceVideo?.durationSeconds === 'number'
      ? [legacy.referenceVideo.durationSeconds]
      : [];
  const referenceVideoDurationsSeconds = v2ReferenceVideoDurations.length > 0
    ? v2ReferenceVideoDurations
    : legacyReferenceVideoDurations;
  const inputMetadata = {
    slots: inputMetadataSlots,
    ...(referenceVideoDurationsSeconds.length > 0 ? { referenceVideoDurationsSeconds } : {}),
  };
  const schemaVersion = model.inputModes ? 2 as const : 1 as const;
  if (legacy.tool === 'image') {
    return {
      schemaVersion,
      kind: 'image',
      modelId: model.id,
      settings,
      inputCounts: {
        images: model.inputModes ? counted((slot) => slot.kind === 'image') : legacy.references.length,
        videos: 0,
        audios: 0,
      },
      inputMetadata,
      catalogRevision,
    };
  }
  if (legacy.tool === 'video') {
    const usesReusableReferences = legacy.referenceMode === 'elements';
    const usesSubjects = legacy.referenceMode === 'subjects';
    const inputCounts = model.inputModes
      ? {
          images: usesSubjects
            ? counted((slot) => slot.key === SUBJECT_IMAGES_SLOT_KEY)
            : usesReusableReferences ? counted(referenceSlotOf('image')) : counted(isFrameSlot),
          videos: usesReusableReferences ? counted(referenceSlotOf('video')) : 0,
          audios: usesReusableReferences ? counted(referenceSlotOf('audio')) : 0,
          preparedAudios: usesReusableReferences ? counted(referenceSlotOf('preparedVoice')) : 0,
          characters: usesReusableReferences ? counted(referenceSlotOf('character')) : 0,
        }
      : {
          images: usesSubjects
            ? videoSubjects(legacy).reduce((count, subject) => count + subject.images.length, 0)
            : usesReusableReferences
              ? legacy.references.length
              : (legacy.startFrame ? 1 : 0) + (!legacy.isMultiShot && legacy.endFrame ? 1 : 0),
          videos: usesReusableReferences ? legacy.referenceVideos.length : 0,
          audios: usesReusableReferences ? legacy.referenceAudios.length : 0,
          preparedAudios: usesReusableReferences ? preparedAudioIds(legacy).length : 0,
          characters: usesReusableReferences ? characterIds(legacy).length : 0,
        };
    return {
      schemaVersion,
      kind: 'video',
      modelId: model.id,
      settings,
      inputCounts,
      inputMetadata,
      catalogRevision,
    };
  }
  return {
    schemaVersion,
    kind: 'motion',
    modelId: model.id,
    settings,
    inputCounts: { images: legacy.characterImage ? 1 : 0, videos: legacy.referenceVideo ? 1 : 0, audios: 0 },
    inputMetadata,
    catalogRevision,
  };
}

function generationInputKind(
  slot: CatalogInputSlot,
): CatalogGenerationInputAsset['kind'] {
  return slot.kind;
}

export function buildUnifiedCatalogGenerationRequest(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  catalogRevision: string,
  normalizedSettings?: Record<string, CatalogPrimitive>,
): CatalogGenerationRequest {
  const runDraft = catalogRunDraft(draft, model);
  const settings = normalizedSettings
    ? normalizeCatalogSettings(model, normalizedSettings)
    : getCatalogDraftSettings(runDraft, model);
  if (runDraft.tool === 'video' && !('referenceMode' in settings)) {
    settings.referenceMode = runDraft.referenceMode;
  }
  if (runDraft.tool === 'video' && runDraft.isMultiShot) {
    // The server refuses a multi-shot run whose duration is not its shots' total.
    settings.duration = multiShotTotalDuration(runDraft.multiPrompts);
  }
  const inputSlots = buildCatalogDraftInputSlots(runDraft, model, settings);
  const slotDescriptors = new Map(
    getActiveCatalogInputSlots(model, settings).map((slot) => [slot.key, slot]),
  );
  // The Seedance 2 family takes a reference's prepared asset in place of the file, once the
  // provider reports it active: the server hands any id it gets to Seedance, and one still
  // processing, or failed, would be refused there after the credit hold. The link goes
  // beside the id, so the server can still measure the file and price it.
  const preparesSeedanceAssets = isSeedance2VideoModelId(model.id);
  const inputs = Object.entries(inputSlots).flatMap(([slotKey, assets]) => {
    const slot = slotDescriptors.get(slotKey);
    if (!slot) return [];
    const takesPreparedAsset = preparesSeedanceAssets
      && slot.role === 'reference'
      && (slot.kind === 'image' || slot.kind === 'video' || slot.kind === 'audio');
    return assets.map((asset): CatalogGenerationInputAsset => {
      const preparedAssetId = takesPreparedAsset
        ? getPreferredSeedanceReferenceValue(null, asset.seedanceAsset)
        : null;
      return {
        slot: slotKey,
        kind: generationInputKind(slot),
        url: asset.url ?? null,
        ...(slot.kind === 'character' || slot.kind === 'preparedVoice'
          ? { assetId: asset.id }
          : preparedAssetId ? { assetId: preparedAssetId } : {}),
        storagePath: asset.storagePath ?? null,
        label: asset.displayName ?? asset.fileName ?? null,
        handle: asset.handle ?? null,
        durationSeconds: asset.durationSeconds ?? null,
        sourceGenerationId: asset.sourceGenerationId ?? null,
      };
    });
  });
  return {
    kind: runDraft.tool,
    modelId: model.id,
    catalogRevision,
    settings,
    prompt: runDraft.prompt.trim(),
    ...(runDraft.tool === 'video' && runDraft.isMultiShot
      ? {
          shots: runDraft.multiPrompts.map((shot) => ({
            prompt: shot.prompt.trim(),
            duration: shotSeconds(shot),
          })),
        }
      : {}),
    inputs,
    sourceGenerationId: runDraft.sourceGenerationId ?? null,
  };
}

export const REFERENCE_DURATION_CHANGED_CODE = 'REFERENCE_DURATION_CHANGED';

export type VerifiedInputDuration = {
  index: number;
  slot: string;
  durationSeconds: number;
};

/** The measured lengths a REFERENCE_DURATION_CHANGED refusal carries; malformed entries are dropped. */
export function readVerifiedInputDurations(details: unknown): VerifiedInputDuration[] {
  if (!details || typeof details !== 'object') return [];
  const inputs = (details as { inputs?: unknown }).inputs;
  if (!Array.isArray(inputs)) return [];
  return inputs.flatMap((entry): VerifiedInputDuration[] => {
    if (!entry || typeof entry !== 'object') return [];
    const { index, slot, durationSeconds } = entry as Record<string, unknown>;
    return typeof index === 'number' && Number.isInteger(index) && index >= 0
      && typeof slot === 'string'
      && typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? [{ index, slot, durationSeconds }]
      : [];
  });
}

/**
 * Takes the server's measured reference lengths into the draft, so the next
 * quote is built from them and the viewer confirms the price the server will
 * actually charge. Each measured input is matched back to its media by the
 * storage path, or else the URL, that the request sent for it. A motion run's
 * duration follows its reference performance, as it does on the server.
 */
export function applyVerifiedInputDurations<T extends CreationDraft>(
  draft: T,
  request: Pick<CatalogGenerationRequest, 'inputs'>,
  verified: VerifiedInputDuration[],
): T {
  const byPath = new Map<string, number>();
  const byUrl = new Map<string, number>();
  for (const { index, durationSeconds } of verified) {
    const input = request.inputs[index];
    if (!input) continue;
    if (input.storagePath) byPath.set(input.storagePath, durationSeconds);
    if (input.url) byUrl.set(input.url, durationSeconds);
  }
  if (byPath.size === 0 && byUrl.size === 0) return draft;

  const measuredFor = (media: { storagePath?: string | null; url?: string | null }) => (
    (media.storagePath ? byPath.get(media.storagePath) : undefined)
    ?? (media.url ? byUrl.get(media.url) : undefined)
  );
  const withMeasured = <M extends MediaDraft | CatalogDraftInputAsset>(media: M): M => {
    const measured = measuredFor(media);
    return measured === undefined ? media : { ...media, durationSeconds: measured };
  };
  const catalogInputSlots = draft.catalogInputSlots
    ? Object.fromEntries(
      Object.entries(draft.catalogInputSlots).map(([slot, assets]) => [slot, assets.map(withMeasured)]),
    )
    : draft.catalogInputSlots;

  if (draft.tool === 'video') {
    return {
      ...draft,
      catalogInputSlots,
      referenceVideos: draft.referenceVideos.map(withMeasured),
      referenceAudios: draft.referenceAudios.map(withMeasured),
    } as T;
  }
  if (draft.tool === 'motion') {
    const referenceVideo = draft.referenceVideo ? withMeasured(draft.referenceVideo) : null;
    const measured = referenceVideo !== draft.referenceVideo ? referenceVideo?.durationSeconds : undefined;
    return {
      ...draft,
      catalogInputSlots,
      referenceVideo,
      ...(typeof measured === 'number' ? { duration: Math.max(1, Math.ceil(measured)) } : {}),
    } as T;
  }
  return { ...draft, catalogInputSlots } as T;
}

export interface CatalogDraftReconciliation {
  draft: CreationDraft;
  model: GenerationModelDescriptor | null;
  switchedModel: boolean;
  previousModelId: string;
  discardedSettingKeys: string[];
  warning: string | null;
}

/** Whether this app can run the model for the tool: its kind, a schema it reads and, past schema 1, mobile availability. */
function isUsableCatalogModel(
  model: GenerationModelDescriptor | null | undefined,
  tool: CreationDraft['tool'],
  catalog: GenerationModelCatalog,
): model is GenerationModelDescriptor {
  return model?.kind === tool
    && model.minClientSchemaVersion <= catalog.schemaVersion
    && (catalog.schemaVersion === 1 || Boolean(model.availability?.mobile));
}

export function reconcileCreationDraftWithCatalog(
  draft: CreationDraft,
  catalog: GenerationModelCatalog,
): CatalogDraftReconciliation {
  const previousModelId = draft.model;
  const existing = getCatalogModel(catalog, previousModelId);
  const selected = isUsableCatalogModel(existing, draft.tool, catalog) ? existing : null;
  if (!selected) {
    return {
      draft,
      model: null,
      switchedModel: false,
      previousModelId,
      discardedSettingKeys: [],
      warning: `${previousModelId} is unavailable. Choose a replacement; your draft has been preserved.`,
    };
  }

  const sourceSettings = { ...(draft.catalogSettings ?? {}) };
  for (const control of selected.controls) {
    const current = currentControlValue(draft, control);
    if (current !== undefined) sourceSettings[control.key] = current;
  }
  const normalizedSettings = normalizeCatalogSettings(selected, sourceSettings);
  const discardedSettingKeys = Object.keys(sourceSettings).filter((key) => !(key in normalizedSettings) || normalizedSettings[key] !== sourceSettings[key]);
  const reconciled = applyCatalogModelDefaults({
    ...draft,
    model: selected.id,
    catalogRevision: catalog.revision,
    catalogSettings: normalizedSettings,
    ...(draft.catalogInputSlots === undefined
      ? {}
      : { catalogInputSlots: draft.catalogInputSlots }),
  } as CreationDraft, selected, catalog.revision);
  const switchedModel = selected.id !== previousModelId;
  const retiredModelWarning = switchedModel
    ? `Your previous ${draft.tool} model is no longer available. Switched to ${selected.displayName}.`
    : null;
  const discardedSettingsWarning = discardedSettingKeys.length > 0
    ? `Some saved settings are no longer supported and were reset: ${discardedSettingKeys.join(', ')}.`
    : null;
  return {
    draft: reconciled,
    model: selected,
    switchedModel,
    previousModelId,
    discardedSettingKeys,
    warning: [retiredModelWarning, discardedSettingsWarning].filter(Boolean).join(' ') || null,
  };
}

/** Whether the creator has put anything into a draft yet: a prompt, a shot prompt or an input. */
export function hasStartedCreationDraft(draft: CreationDraft) {
  if (draft.prompt.trim()) return true;
  if (draft.tool === 'image') return draft.references.length > 0;
  if (draft.tool === 'video') {
    return draft.references.length > 0
      || draft.referenceVideos.length > 0
      || draft.referenceAudios.length > 0
      || videoSubjects(draft).length > 0
      || Boolean(draft.startFrame)
      || Boolean(draft.endFrame)
      || draft.multiPrompts.some((shot) => shot.prompt.trim());
  }
  return Boolean(draft.characterImage) || Boolean(draft.referenceVideo);
}

export interface CatalogDraftNormalization {
  draft: CreationDraft;
  /** The reconciliation notice, when there is one, for the "Model updated" banner. */
  warning: string | null;
  /** The draft's model is not in this catalog, so the draft comes back untouched. */
  missingModel: boolean;
}

/**
 * A model and settings an untouched draft starts on in place of the catalog default (see
 * `GUIDED_CREATION_STARTERS`). Settings are written as the catalog writes them: a duration
 * choice is a string.
 */
export interface CreationStarter {
  modelId: string;
  settings: Record<string, CatalogPrimitive>;
}

/** The model with these values as its control defaults, wherever the control takes the value. */
function withStartingValues(
  model: GenerationModelDescriptor,
  values: Record<string, CatalogPrimitive>,
): GenerationModelDescriptor {
  const valid = normalizeCatalogSettings(model, values);
  return {
    ...model,
    controls: model.controls.map((control) => (
      control.key in values ? { ...control, defaultValue: valid[control.key] } as CatalogControl : control
    )),
  };
}

/**
 * What the create screen does to a draft each time a catalog arrives, as one pure step.
 *
 * An untouched draft takes the catalog's default model and that model's published defaults,
 * or the starter's model and settings when one is given; any other draft is reconciled
 * against its own model. A remix restore compares the live draft with baselines passed
 * through this same step, so the screen's own normalization, which lands while the source is
 * still loading, never reads as an edit the creator made.
 */
export function normalizeCreationDraftForCatalog(
  draft: CreationDraft,
  catalog: GenerationModelCatalog,
  options: { modelSelectionTouched: boolean; starter?: CreationStarter | null },
): CatalogDraftNormalization {
  const untouched = !draft.catalogRevision && !options.modelSelectionTouched && !hasStartedCreationDraft(draft);
  if (untouched && options.starter) {
    const starter = getCatalogModel(catalog, options.starter.modelId);
    // Its details are still loading. The default would stick (the draft gets a revision), so
    // wait; a starter the catalog does not carry is the caller's to stop passing.
    if (!starter) return { draft, warning: null, missingModel: false };
    if (isUsableCatalogModel(starter, draft.tool, catalog)) {
      return {
        draft: applyCatalogModelInitialDefaults(draft, withStartingValues(starter, options.starter.settings), catalog.revision),
        warning: null,
        missingModel: false,
      };
    }
  }
  const defaultId = catalog.defaults[draft.tool];
  const fallback = defaultId ? getCatalogModel(catalog, defaultId) : null;
  if (fallback?.kind === draft.tool && untouched) {
    return {
      draft: applyCatalogModelInitialDefaults(draft, fallback, catalog.revision),
      warning: null,
      missingModel: false,
    };
  }
  if (!getCatalogModel(catalog, draft.model)) return { draft, warning: null, missingModel: true };
  const result = reconcileCreationDraftWithCatalog(draft, catalog);
  return { draft: result.draft, warning: result.warning, missingModel: false };
}

function remixCatalogSettings(
  bundle: RemixSourceBundle,
  model: GenerationModelDescriptor,
): Record<string, CatalogPrimitive> {
  const nested = bundle.workflowSettings.settings;
  const nestedRecord = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : {};
  const settings: Record<string, CatalogPrimitive> = {};
  for (const control of model.controls) {
    const value = nestedRecord[control.key] ?? bundle.workflowSettings[control.key];
    if (
      typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
    ) {
      settings[control.key] = value;
    }
  }
  return normalizeCatalogSettings(model, settings);
}

/**
 * Whether the creator typed a prompt of their own while a remix restore was
 * still in flight.
 *
 * The create screen is interactive the moment it mounts and the bundle lands
 * whenever /api/remix-source answers, so replacing the draft outright discards
 * anything typed in between. Their words win over the restore.
 *
 * Both halves matter: a non-empty default prompt must not read as creator
 * input, so the value also has to have changed since the restore began.
 */
export function hasCreatorEditedPromptDuringRemix(
  currentPrompt: string,
  promptWhenRemixStarted: string
): boolean {
  return currentPrompt.trim().length > 0 && currentPrompt !== promptWhenRemixStarted;
}

/** Media a remix restored into a draft, counted so a later cap can say what it removed. */
function restoredRemixMediaCount(draft: CreationDraft): number {
  if (draft.tool === 'image') return draft.references.length;
  if (draft.tool === 'video') {
    return draft.references.length
      + draft.referenceVideos.length
      + draft.referenceAudios.length
      + (draft.startFrame ? 1 : 0)
      + (draft.endFrame ? 1 : 0);
  }
  return (draft.characterImage ? 1 : 0) + (draft.referenceVideo ? 1 : 0);
}

export function hydrateCatalogCreationDraftFromRemixSource(
  baseDraft: CreationDraft,
  bundle: RemixSourceBundle,
  catalog: GenerationModelCatalog,
): {
  draft: CreationDraft;
  model: GenerationModelDescriptor | null;
  warning: string | null;
  switchedModel: boolean;
} {
  const requestedModelId = typeof bundle.workflowSettings.model === 'string'
    ? bundle.workflowSettings.model
    : bundle.generation.model;
  const requestedModel = getCatalogModel(catalog, requestedModelId);
  const model = requestedModel?.kind === baseDraft.tool
    && requestedModel.minClientSchemaVersion <= catalog.schemaVersion
    && (catalog.schemaVersion === 1 || requestedModel.availability?.mobile)
    ? requestedModel
    : null;
  // The legacy hydrator restores signed media descriptors. Catalog model
  // selection and settings are deliberately reapplied afterwards so a remote
  // id never has to exist in the bundled registry. It must not cap media:
  // the draft still names the placeholder model at that point, and the
  // published descriptor's limits are applied by applyCatalogModelDefaults.
  const legacyBundle = {
    ...bundle,
    workflowSettings: {
      ...bundle.workflowSettings,
      model: baseDraft.model,
    },
  } as RemixSourceBundle;
  const legacyOptions = { capToBundledModel: false };
  const restored: { draft: CreationDraft; warning: string | null } = baseDraft.tool === 'image'
    ? hydrateCreationDraftFromRemixSource(baseDraft, legacyBundle, legacyOptions)
    : baseDraft.tool === 'video'
      ? hydrateCreationDraftFromRemixSource(baseDraft, legacyBundle, legacyOptions)
      : hydrateCreationDraftFromRemixSource(baseDraft, legacyBundle, legacyOptions);
  if (!model) return {
    draft: { ...restored.draft, model: requestedModelId, catalogRevision: catalog.revision } as CreationDraft,
    model: null,
    warning: `${requestedModelId} is unavailable. Choose a replacement; your draft has been preserved.`,
    switchedModel: false,
  };
  const restoredCatalogSettings = remixCatalogSettings(bundle, model);
  const projectedControlValues = Object.fromEntries(model.controls.map((control) => {
    const value = restoredCatalogSettings[control.key] ?? control.defaultValue;
    return [
      draftKey(restored.draft, control.key),
      control.key === 'duration' && control.type === 'choice' ? Number(value) : value,
    ];
  }));
  const draft = applyCatalogModelDefaults({
    ...restored.draft,
    ...projectedControlValues,
    model: model.id,
    catalogRevision: catalog.revision,
    catalogSettings: restoredCatalogSettings,
  } as CreationDraft, model, catalog.revision);
  const droppedByCatalog = restoredRemixMediaCount(restored.draft) - restoredRemixMediaCount(draft);
  const restoreWarning = restored.warning ?? (droppedByCatalog > 0 ? REMIX_RESTORE_WARNING_MESSAGE : null);
  const switchedModel = model.id !== requestedModelId;
  const retirementWarning = switchedModel
    ? `${requestedModelId} is no longer available. Switched to ${model.displayName}.`
    : null;
  return {
    draft,
    model,
    warning: [retirementWarning, restoreWarning].filter(Boolean).join(' ') || null,
    switchedModel,
  };
}

function elementDescriptors(draft: ImageCreationDraft | VideoCreationDraft): GenerationElementDescriptor[] {
  return draft.references
    .filter((reference): reference is typeof reference & { handle: string } => typeof reference.handle === 'string' && reference.handle.length > 0)
    .map((reference) => ({
      id: reference.id,
      displayName: reference.displayName,
      handle: reference.handle,
      storagePath: reference.storagePath ?? null,
      sourceGenerationId: reference.sourceGenerationId ?? null,
    }));
}

function mediaDescriptor(media: ImageCreationDraft['references'][number] | null): RemixMediaAssetDescriptor | null {
  return media ? {
    url: media.url,
    storagePath: media.storagePath ?? null,
    mediaType: media.kind,
    fileName: media.fileName,
  } : null;
}

export function buildCatalogGenerationPayload(draft: ImageCreationDraft, model: GenerationModelDescriptor, catalogRevision: string, normalizedSettings?: Record<string, CatalogPrimitive>): ImageGenerationRequest;
export function buildCatalogGenerationPayload(draft: VideoCreationDraft, model: GenerationModelDescriptor, catalogRevision: string, normalizedSettings?: Record<string, CatalogPrimitive>): VideoGenerationRequest;
export function buildCatalogGenerationPayload(draft: MotionCreationDraft, model: GenerationModelDescriptor, catalogRevision: string, normalizedSettings?: Record<string, CatalogPrimitive>): MotionGenerationRequest;
export function buildCatalogGenerationPayload(
  creatorDraft: CreationDraft,
  model: GenerationModelDescriptor,
  catalogRevision: string,
  normalizedSettings: Record<string, CatalogPrimitive> = {},
): ImageGenerationRequest | VideoGenerationRequest | MotionGenerationRequest {
  // The run's shape, and of each kind no more than the model takes.
  const draft = legacyRunDraft(catalogRunDraft(creatorDraft, model), model);
  if (draft.tool === 'image') {
    const hasQualityControl = model.controls.some((control) => control.key === 'qualityMode');
    return {
      model: model.id,
      prompt: draft.prompt.trim(),
      imageUrls: draft.references.map((reference) => reference.url),
      elements: elementDescriptors(draft),
      aspectRatio: draft.aspectRatio,
      resolution: draft.resolution,
      qualityMode: hasQualityControl ? draft.qualityMode : undefined,
      outputFormat: model.capabilities.outputFormat ? draft.outputFormat : 'jpg',
      googleSearch: model.capabilities.googleSearch ? draft.googleSearch : false,
      sourceGenerationId: draft.sourceGenerationId ?? null,
      catalogRevision,
      settings: normalizedSettings,
    };
  }
  if (draft.tool === 'video') {
    const usesReusableReferences = draft.referenceMode === 'elements';
    // Where the descriptor has input modes, Kling 3.0's video elements have one of their
    // own that rides with either shape, beside the frames.
    const usesKlingVideoElements = model.id === 'kling-3.0-video' && (usesReusableReferences || Boolean(model.inputModes));
    const activeReferences = usesReusableReferences ? draft.references : [];
    // The Seedance 2 family takes a prepared asset's id in place of a reference's
    // link, and is told what each reference had prepared, by index, as the web
    // creator does; every other model gets the links and no asset collections.
    const preparesSeedanceAssets = usesReusableReferences && isSeedance2VideoModelId(model.id);
    const referenceValue = (media: MediaDraft) => (preparesSeedanceAssets
      ? getPreferredSeedanceReferenceValue(media.url, media.seedanceAsset) ?? media.url
      : media.url);
    const seedanceAssetOf = (assetType: SeedanceAssetKind) => (media: MediaDraft) => createSeedanceAssetMetadata({
      ...media.seedanceAsset,
      assetType,
      sourceUrl: media.url,
    });
    const activeReferenceVideos = usesReusableReferences && !usesKlingVideoElements ? draft.referenceVideos : [];
    const activeReferenceAudios = usesReusableReferences ? draft.referenceAudios : [];
    const imageUrls = activeReferences.map(referenceValue);
    return {
      model: model.id,
      isMultiShot: model.capabilities.multiShot ? draft.isMultiShot : false,
      prompt: draft.prompt.trim(),
      multiPrompts: draft.isMultiShot ? draft.multiPrompts.map((shot, index) => ({
        id: shot.id || `shot-${index + 1}`,
        prompt: shot.prompt.trim(),
        duration: shotSeconds(shot),
      })) : undefined,
      elements: usesReusableReferences ? elementDescriptors(draft) : [],
      elementImageUrls: imageUrls,
      imageUrls,
      referenceVideoUrls: activeReferenceVideos.map(referenceValue),
      klingVideoElements: usesKlingVideoElements ? draft.referenceVideos.map((media) => ({
        id: media.id,
        url: media.url,
        handle: media.handle ?? null,
        displayName: media.displayName,
        storagePath: media.storagePath ?? null,
        sourceGenerationId: media.sourceGenerationId ?? null,
      })) : [],
      referenceAudioUrls: activeReferenceAudios.map(referenceValue),
      preparedAudioIds: usesReusableReferences ? preparedAudioIds(draft) : [],
      characterIds: usesReusableReferences ? characterIds(draft) : [],
      startImageUrl: usesReusableReferences && !model.inputs.combineFramesWithReferences ? null : draft.startFrame?.url ?? null,
      endImageUrl: usesReusableReferences || draft.isMultiShot ? null : draft.endFrame?.url ?? null,
      startFrame: usesReusableReferences && !model.inputs.combineFramesWithReferences ? null : mediaDescriptor(draft.startFrame),
      endFrame: usesReusableReferences || draft.isMultiShot ? null : mediaDescriptor(draft.endFrame),
      mode: draft.mode,
      aspectRatio: draft.aspectRatio,
      sound: model.capabilities.sound ? draft.sound : false,
      duration: draft.isMultiShot ? multiShotTotalDuration(draft.multiPrompts) : draft.duration,
      resolution: draft.resolution,
      fixedLens: model.capabilities.fixedLens ? draft.fixedLens : false,
      referenceMode: draft.referenceMode,
      seedanceAssets: preparesSeedanceAssets
        ? {
            images: activeReferences.map(seedanceAssetOf('Image')),
            videos: activeReferenceVideos.map(seedanceAssetOf('Video')),
            audios: activeReferenceAudios.map(seedanceAssetOf('Audio')),
          }
        : null,
      sourceGenerationId: draft.sourceGenerationId ?? null,
      catalogRevision,
      settings: normalizedSettings,
    };
  }
  return {
    model: model.id,
    prompt: draft.prompt.trim(),
    referenceVideoUrl: draft.referenceVideo?.url ?? '',
    characterImageUrl: draft.characterImage?.url ?? '',
    duration: Math.max(1, Math.ceil(draft.referenceVideo?.durationSeconds ?? draft.duration)),
    characterOrientation: draft.characterOrientation,
    mode: draft.mode,
    characterImage: mediaDescriptor(draft.characterImage),
    referenceVideo: mediaDescriptor(draft.referenceVideo),
    sourceGenerationId: draft.sourceGenerationId ?? null,
    catalogRevision,
    settings: normalizedSettings,
  };
}
