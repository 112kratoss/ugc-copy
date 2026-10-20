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
  isUsableCatalogModel,
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
  type VideoRunEnhancementInputs,
  type VideoShotDraft,
} from './media-creation-view-model';
import {
  catalogMotionInputSlots,
  catalogRunQuoteInput,
  catalogRunWithShownCost,
  modeGatedSettingValues,
  MOTION_INPUTS_FALLBACK_SLOTS,
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
import {
  creatorPromptViolation,
  promptLengthMeter,
  promptLimitFor,
  type PromptLengthMeter,
} from './model-catalog/provider-prompt-limits';
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

/**
 * The slots a motion run on this model sends its picture and its clip in, chosen by kind as the
 * web's motion page chooses them (`catalogMotionInputSlots`): a slot the run must fill first, and
 * never one that takes nothing. Production publishes Kling 2.6 with the motion-inputs slots
 * (`characterImage`, `referenceVideo`) and Kling 3.0 with plain reference slots
 * (`imageReferences`, `videoReferences`); the composer looked its slots up by the motion-inputs
 * names, so on Kling 3.0 it drew neither and refused a clip (2026-10-20). Before the model's
 * descriptor is in, the motion-inputs names.
 */
export function catalogMotionDraftSlotKeys(
  draft: MotionCreationDraft,
  model: GenerationModelDescriptor | null | undefined,
): { image: string; video: string } {
  return model ? catalogMotionInputSlots(model, getCatalogDraftSettings(draft, model)) : MOTION_INPUTS_FALLBACK_SLOTS;
}

function legacyAssetsForSlot(
  draft: CreationDraft,
  slot: CatalogInputSlot,
  model: GenerationModelDescriptor,
): CatalogDraftInputAsset[] {
  if (draft.tool === 'motion') {
    // Each input goes in one slot of its kind, the one the composer draws it in.
    const keys = catalogMotionDraftSlotKeys(draft, model);
    if (slot.kind === 'image' && slot.key === keys.image && draft.characterImage) return [mediaDraftAsset(draft.characterImage)];
    if (slot.kind === 'video' && slot.key === keys.video && draft.referenceVideo) return [mediaDraftAsset(draft.referenceVideo)];
    return [];
  }
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
  if (slot.kind === 'image') return draft.references.map(mediaDraftAsset);
  if (slot.kind === 'video') return draft.tool === 'video' ? draft.referenceVideos.map(mediaDraftAsset) : [];
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

function heldSlotAssets(draft: CreationDraft, slot: CatalogInputSlot, model: GenerationModelDescriptor): CatalogDraftInputAsset[] {
  return draft.catalogInputSlots?.[slot.key] ?? legacyAssetsForSlot(draft, slot, model);
}

/**
 * What a draft holds for each slot this model declares, counted as its run counts it: a
 * subject's pictures under the subjects' slot, and no end frame in a multi-shot run, which
 * sends none. A mode or slot that opens on a count reads these, on the creator's screen as in
 * the run, its quote and its checks.
 */
export function catalogDraftInputCounts(draft: CreationDraft, model: GenerationModelDescriptor): Record<string, number> {
  return Object.fromEntries((model.inputModes ?? [])
    .flatMap((mode) => mode.slots)
    .map((slot) => [slot.key, heldSlotAssets(draft, slot, model).length]));
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
  return getActiveCatalogInputSlots(model, settings, catalogDraftInputCounts(draft, model))
    .map((slot) => ({ slot, assets: heldSlotAssets(draft, slot, model) }));
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
  const counts = catalogDraftInputCounts(draft, model);
  const framesShape = getActiveCatalogInputSlots(model, { ...settings, referenceMode: 'frames' }, counts);
  const referencesShape = getActiveCatalogInputSlots(model, { ...settings, referenceMode: 'elements' }, counts);
  const inFramesShape = new Set(framesShape.map((slot) => slot.key));
  const holds = (slot: CatalogInputSlot) => heldSlotAssets(draft, slot, model).length > 0;
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

/**
 * Each slot a run on this model opens, with what it sends there, in the shape and with the
 * settings its quote request and its run request read: at most the slot's max, and nothing for a
 * slot the model does not have. A draft keeps its references when the model changes, as the web
 * creator does, so it can hold more than this model takes; the rest wait in the draft, and
 * `validateCatalogCreationDraft` blocks the run until those past a max are removed. The settings
 * are the run's (catalogRunSettings): the draft's own leave a video run's reference shape out, and
 * a mode gated on it closed. A descriptor without input modes opens no slots, so nothing is listed.
 */
export function catalogRunSlots(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
): Array<{ slot: CatalogInputSlot; assets: CatalogDraftInputAsset[] }> {
  const runDraft = catalogRunDraft(draft, model);
  return heldCatalogDraftInputSlots(runDraft, model, catalogRunSettings(runDraft, model))
    .map(({ slot, assets }) => ({ slot, assets: assets.slice(0, Math.max(0, slot.max)) }));
}

/** What a run on this model sends, by slot key: what the creator shows as going with the run. */
export function catalogRunInputSlots(draft: CreationDraft, model: GenerationModelDescriptor): CatalogDraftInputSlots {
  return Object.fromEntries(catalogRunSlots(draft, model).map(({ slot, assets }) => [slot.key, assets]));
}

/**
 * What a video run on this model sends, as its Enhance request tells the enhancer: the frames it
 * starts and ends on, how many reference pictures go with it, whether a clip does, and the named
 * references its prompt may mention, each once (a subject is one, however many pictures make it).
 * Read off the run, as an image run's request is read off the references it sends: Kling 3.0's
 * clips ride beside its frames, Wan 2.7 sends a start frame beside its references and no end
 * frame, and a clip kept from another model goes nowhere.
 */
export function catalogRunEnhancementInputs(
  draft: VideoCreationDraft,
  model: GenerationModelDescriptor,
): VideoRunEnhancementInputs {
  const slots = catalogRunSlots(draft, model);
  const sent = (sends: (slot: CatalogInputSlot) => boolean) => slots
    .filter(({ slot }) => sends(slot))
    .flatMap(({ assets }) => assets);
  const frame = (role: 'startFrame' | 'endFrame') => {
    const [asset] = sent((slot) => slot.role === role);
    return asset ? { url: asset.url ?? null } : null;
  };
  const elementReferences = new Map<string, string>();
  for (const asset of sent((slot) => slot.role === 'reference')) {
    if (asset.handle && !elementReferences.has(asset.handle)) {
      elementReferences.set(asset.handle, asset.displayName ?? asset.handle.slice(1));
    }
  }
  return {
    startFrame: frame('startFrame'),
    endFrame: frame('endFrame'),
    referenceImageCount: sent((slot) => slot.role === 'reference' && slot.kind === 'image' && slot.key !== SUBJECT_IMAGES_SLOT_KEY).length,
    hasReferenceVideo: sent((slot) => slot.role === 'reference' && slot.kind === 'video').length > 0,
    elementReferences: [...elementReferences].map(([handle, displayName]) => ({ handle, displayName })),
  };
}

export function applyCatalogModelDefaults(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  catalogRevision: string | null = draft.catalogRevision ?? null,
): CreationDraft {
  const values = writeControlValues(draft, model);
  // References, clips, tracks and generic slot inputs stay in the draft whatever this model
  // takes: cut to its slots, they were gone for good, and picking the first model again did
  // not bring them back. A run sends what the model takes (catalogRunSlots), and
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

/**
 * A draft on this model at its published defaults, or at `startingValues` where given (a guided
 * starter's pins). A value the model does not take falls back to its default as the draft is
 * normalized.
 */
export function applyCatalogModelInitialDefaults(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  catalogRevision: string,
  startingValues: Readonly<Record<string, CatalogPrimitive>> = {},
): CreationDraft {
  const descriptorDefaults = Object.fromEntries(model.controls.map((control) => {
    const value = Object.hasOwn(startingValues, control.key) ? startingValues[control.key] : control.defaultValue;
    return [
      draftKey(draft, control.key),
      control.key === 'duration' && control.type === 'choice' ? Number(value) : value,
    ];
  }));
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

/**
 * What a run on this model sends that decides how its provider counts the prompt: whether
 * it sends pictures (Grok Imagine's text-only cap goes with them), and the handles of
 * Kling 3.0's named clips, each mention of which Kling counts as 37 characters.
 */
function catalogPromptRunFacts(draft: CreationDraft, model: GenerationModelDescriptor | null) {
  if (draft.tool === 'motion') return { hasReferenceImages: false, elementHandles: [] as string[] };
  // Before the model's descriptor is in, the draft's own references stand in for the run's.
  if (!model) return { hasReferenceImages: draft.references.length > 0, elementHandles: [] as string[] };
  const slots = catalogRunSlots(draft, model);
  const sent = (kind: string) => slots.filter(({ slot }) => slot.kind === kind).flatMap(({ assets }) => assets);
  return {
    hasReferenceImages: model.inputModes
      ? sent('image').length > 0
      : legacyRunDraft(catalogRunDraft(draft, model), model).references.length > 0,
    elementHandles: model.id === 'kling-3.0-video'
      ? sent('video').map((asset) => asset.handle).filter((handle): handle is string => Boolean(handle))
      : [],
  };
}

/** What a composer's counters read: the prompt, and each shot of a multi-shot run by its id. */
export type CatalogPromptMeters = {
  prompt: PromptLengthMeter;
  shots: Record<string, PromptLengthMeter>;
};

/**
 * The prompt and each shot against the limits their model's provider sets
 * (model-catalog/provider-prompt-limits.ts), counted as the run sends them; the route's own
 * limit where the provider sets none (10,000, or 2,500 for motion). The draft's model names
 * the limits before its descriptor is in. Nothing here shortens a prompt: one past its limit
 * reads over, and `validateCatalogCreationDraft` holds the run.
 */
export function catalogPromptMeters(draft: CreationDraft, model: GenerationModelDescriptor | null): CatalogPromptMeters {
  const facts = catalogPromptRunFacts(draft, model);
  const limit = promptLimitFor(model?.id ?? draft.model, { hasReferenceImages: facts.hasReferenceImages, kind: draft.tool });
  const options = { elementMentionLength: limit.elementMentionLength, elementHandles: facts.elementHandles };
  return {
    prompt: promptLengthMeter(draft.prompt, limit.maxLength, options),
    shots: draft.tool === 'video'
      ? Object.fromEntries(draft.multiPrompts.map((shot) => [shot.id, promptLengthMeter(shot.prompt, limit.shotMaxLength, options)]))
      : {},
  };
}

/**
 * Why the start would refuse the prompts a run on this model sends, in the start's own
 * words, which name the model and the limit: "Z-Image prompts support up to 1,000
 * characters.", or "Shot 2: …" for a shot. Null while they fit, and for an empty prompt,
 * which has a message of its own.
 */
export function catalogPromptLimitError(draft: CreationDraft, model: GenerationModelDescriptor): string | null {
  if (draft.tool === 'motion') return null;
  const isMultiShot = draft.tool === 'video' && draft.isMultiShot;
  const shots = draft.tool === 'video' && isMultiShot ? draft.multiPrompts.map((shot) => shot.prompt) : [];
  if (isMultiShot ? !shots.some((shot) => shot.trim()) : !draft.prompt.trim()) return null;
  return creatorPromptViolation(model.id, model.displayName, {
    prompt: draft.prompt,
    isMultiShot,
    shots,
    ...catalogPromptRunFacts(draft, model),
  });
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
  // The model's own limit, which the start would otherwise refuse only at Generate.
  const promptLimitError = catalogPromptLimitError(draft, model);
  if (promptLimitError) errors.push(promptLimitError);
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
  // Priced as the run it would start, from the run request itself: its settings and the inputs
  // it sends, told to the server as the server tells itself when it quotes the run again to
  // start it. A reference the model has no room for is no part of the price, as it is no part
  // of the run.
  if (model.inputModes) {
    return catalogRunQuoteInput(buildUnifiedCatalogGenerationRequest(draft, model, catalogRevision));
  }
  // A descriptor without input modes, from a schema-1 catalog, has no slots to send inputs
  // in: its inputs are counted from the draft, cut to the limits the descriptor states.
  const runDraft = catalogRunDraft(draft, model);
  const settings = catalogRunSettings(runDraft, model);
  const legacy = legacyRunDraft(runDraft, model);
  const referenceVideoDurationsSeconds = legacy.tool === 'video'
    ? legacy.referenceVideos
      .map((asset) => asset.durationSeconds)
      .filter((duration): duration is number => typeof duration === 'number' && Number.isFinite(duration))
    : legacy.tool === 'motion' && typeof legacy.referenceVideo?.durationSeconds === 'number'
      ? [legacy.referenceVideo.durationSeconds]
      : [];
  const inputMetadata = {
    slots: {},
    ...(referenceVideoDurationsSeconds.length > 0 ? { referenceVideoDurationsSeconds } : {}),
  };
  if (legacy.tool === 'image') {
    return {
      schemaVersion: 1,
      kind: 'image',
      modelId: model.id,
      settings,
      inputCounts: { images: legacy.references.length, videos: 0, audios: 0 },
      inputMetadata,
      catalogRevision,
    };
  }
  if (legacy.tool === 'video') {
    const usesReusableReferences = legacy.referenceMode === 'elements';
    return {
      schemaVersion: 1,
      kind: 'video',
      modelId: model.id,
      settings,
      inputCounts: {
        images: legacy.referenceMode === 'subjects'
          ? videoSubjects(legacy).reduce((count, subject) => count + subject.images.length, 0)
          : usesReusableReferences
            ? legacy.references.length
            : (legacy.startFrame ? 1 : 0) + (!legacy.isMultiShot && legacy.endFrame ? 1 : 0),
        videos: usesReusableReferences ? legacy.referenceVideos.length : 0,
        audios: usesReusableReferences ? legacy.referenceAudios.length : 0,
        preparedAudios: usesReusableReferences ? preparedAudioIds(legacy).length : 0,
        characters: usesReusableReferences ? characterIds(legacy).length : 0,
      },
      inputMetadata,
      catalogRevision,
    };
  }
  return {
    schemaVersion: 1,
    kind: 'motion',
    modelId: model.id,
    settings,
    inputCounts: { images: legacy.characterImage ? 1 : 0, videos: legacy.referenceVideo ? 1 : 0, audios: 0 },
    inputMetadata,
    catalogRevision,
  };
}

export function buildUnifiedCatalogGenerationRequest(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  catalogRevision: string,
): CatalogGenerationRequest {
  const runDraft = catalogRunDraft(draft, model);
  // The settings of the draft, as its quote is asked with them (buildCatalogQuoteRequest prices
  // this request), never the quote's answer read back: the server quotes the run again from
  // these and makes it with its own normalized result, so it runs the settings it priced. A
  // multi-shot run's duration is its shots' total here, which the server checks against the shots.
  const settings = catalogRunSettings(runDraft, model);
  // Each slot the run opens, with what it sends there, at most the slot's max, from one lookup
  // opened with the draft's held input counts. Looked up twice, the second time without those
  // counts, a slot whose mode opens on a count lost its inputs from the run.
  const sent = new Map(heldCatalogDraftInputSlots(runDraft, model, settings).map(({ slot, assets }) => (
    [slot.key, { slot, assets: assets.slice(0, Math.max(0, slot.max)) }] as const
  )));
  // The Seedance 2 family takes a reference's prepared asset in place of the file, once the
  // provider reports it active: the server hands any id it gets to Seedance, and one still
  // processing, or failed, would be refused there after the credit hold. The link goes
  // beside the id, so the server can still measure the file and price it.
  const preparesSeedanceAssets = isSeedance2VideoModelId(model.id);
  const inputs = [...sent.values()].flatMap(({ slot, assets }) => {
    const takesPreparedAsset = preparesSeedanceAssets
      && slot.role === 'reference'
      && (slot.kind === 'image' || slot.kind === 'video' || slot.kind === 'audio');
    return assets.map((asset): CatalogGenerationInputAsset => {
      const preparedAssetId = takesPreparedAsset
        ? getPreferredSeedanceReferenceValue(null, asset.seedanceAsset)
        : null;
      return {
        slot: slot.key,
        kind: slot.kind,
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

/**
 * The run as it is sent to start: with the price the creator was shown, when that price is a
 * ready quote of this very run (asked with the run's own quote input, as `buildCatalogQuoteRequest`
 * asks it). The server prices the run again, charges its own price up to that one, and refuses a
 * start it prices above it (`cost_changed`) before anything is held. Without such a quote the run
 * goes without a price, and the server charges its own as it always has. The rule is the one the
 * web creators apply too (`catalogRunWithShownCost`).
 */
export function catalogStartRequest(
  run: CatalogGenerationRequest,
  quote: { key: string | null; status: string; cost: number | null },
): CatalogGenerationRequest {
  return catalogRunWithShownCost(run, quote);
}

/** A run the start refused as costing more than its price (`cost_changed`): its quote request as JSON, and that price. */
export type RefusedRunPrice = { key: string; costCredits: number };

/**
 * The run a `cost_changed` refusal was for, read off the start request refused: the quote request
 * its price went with (the key `catalogStartRequest` attaches a price under) and the price it
 * carried. Null for a run sent without a price, which the start never refuses on price.
 */
export function catalogRefusedRunPrice(run: CatalogGenerationRequest): RefusedRunPrice | null {
  return typeof run.expectedCostCredits === 'number'
    ? { key: JSON.stringify(catalogRunQuoteInput({ ...run, inputs: run.inputs ?? [] })), costCredits: run.expectedCostCredits }
    : null;
}

/**
 * Whether this build of the app is out of date for the run it would send: the start refused that
 * very run at its price, and the quote, asked again since, prices it the same. The app asks a run's
 * price with its own quote request and the start prices the run itself, so the two disagree when
 * the app quotes runs as the deployed server no longer does (or when the server's own quote and
 * start part, which its `generation_start_quote_drift` errors show), and another press could only
 * be refused the same way. Each press was refused, priced again at the same price and offered
 * again, until the app was updated (2026-10-20); the web creators hold an out-of-date page the same
 * way. Another run, or a price that moved, goes as before.
 */
export function catalogAppOutOfDateForRun(
  refused: RefusedRunPrice | null,
  quote: { key: string | null; status: string; cost: number | null },
): boolean {
  return refused !== null
    && quote.status === 'ready'
    && quote.key === refused.key
    && quote.cost === refused.costCredits;
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
  settings: Readonly<Record<string, CatalogPrimitive>>;
}

/**
 * What the create screen does to a draft each time a catalog arrives, as one pure step.
 *
 * An untouched draft takes the catalog's default model and that model's published defaults,
 * or the starter's model and settings when one is given; any other draft is reconciled
 * against its own model. A remix restore compares the live draft with baselines passed
 * through this same step, so the screen's own normalization, which lands while the source is
 * still loading, never reads as an edit the creator made.
 *
 * `missingIds` are the models the catalog says it does not carry: a starter among them gives
 * way to the default. `seededModelIds` are every starter the screen may have named in the
 * draft (`guidedCreationStarters`), so a draft seeded with one the catalog has since dropped
 * still moves to the next.
 */
export function normalizeCreationDraftForCatalog(
  draft: CreationDraft,
  catalog: GenerationModelCatalog,
  options: {
    modelSelectionTouched: boolean;
    starter?: CreationStarter | null;
    missingIds?: readonly string[];
    seededModelIds?: readonly string[];
  },
): CatalogDraftNormalization {
  const fresh = !draft.catalogRevision && !options.modelSelectionTouched;
  const starter = options.starter ?? null;
  // The screen names a starter's model in its first draft, so words typed before the model's
  // details arrive do not make it the creator's pick: the starter, or the default once the
  // starter is gone, still applies, and keeps them.
  const seeded = fresh && starter !== null
    && (draft.model === starter.modelId || (options.seededModelIds?.includes(draft.model) ?? false));
  const untouched = seeded || (fresh && !hasStartedCreationDraft(draft));
  if (untouched && starter) {
    const starterModel = getCatalogModel(catalog, starter.modelId);
    const starterGone = options.missingIds?.includes(starter.modelId) ?? false;
    // Its details are still loading. The default would stick (the draft gets a revision), so wait.
    if (!starterModel && !starterGone) return { draft, warning: null, missingModel: false };
    if (isUsableCatalogModel(starterModel, draft.tool, catalog)) {
      return {
        draft: applyCatalogModelInitialDefaults(draft, starterModel, catalog.revision, starter.settings),
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
  // A seeded draft whose starter is gone waits for the default's details: its model was never the creator's.
  if (seeded) return { draft, warning: null, missingModel: false };
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
  const model = isUsableCatalogModel(requestedModel, baseDraft.tool, catalog) ? requestedModel : null;
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

export function buildCatalogGenerationPayload(draft: ImageCreationDraft, model: GenerationModelDescriptor, catalogRevision: string): ImageGenerationRequest;
export function buildCatalogGenerationPayload(draft: VideoCreationDraft, model: GenerationModelDescriptor, catalogRevision: string): VideoGenerationRequest;
export function buildCatalogGenerationPayload(draft: MotionCreationDraft, model: GenerationModelDescriptor, catalogRevision: string): MotionGenerationRequest;
export function buildCatalogGenerationPayload(
  creatorDraft: CreationDraft,
  model: GenerationModelDescriptor,
  catalogRevision: string,
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
  };
}
