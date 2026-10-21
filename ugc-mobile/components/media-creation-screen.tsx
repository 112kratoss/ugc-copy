import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import {
  AudioLines,
  Check,
  ChevronDown,
  Image as ImageIcon,
  Layers,
  Plus,
  Play,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Video,
  Wand2,
  X,
} from 'lucide-react-native';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ActivityIndicator, AppState, Keyboard, Modal, Pressable, ScrollView, Switch, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { MediaPreview, StableMediaImage } from '@/components/media-preview';
import { Overlay } from '@/components/overlay-host';
import { PushOfferCard } from '@/components/push-offer-card';
import {
  AppText,
  ChoiceChip,
  PrimaryButton,
  SecondaryButton,
} from '@/components/ui';
import { WhatsNewModelsStrip } from '@/components/whats-new-models-strip';
import { ensureAiDataConsent } from '@/lib/ai-data-consent';
import { ApiError } from '@/lib/api-client';
import { acquireActivityLock } from '@/lib/app-activity';
import { showConfirmDialog } from '@/lib/dialog';
import { reportGenerationOutput } from '@/lib/use-viewer-action-handlers';
import { useAuth } from '@/lib/auth';
import { env } from '@/lib/env';
import { countDraftMedia, heldDraftMedia, needsRemixReferenceRecovery, recoverRemixReferences, remixSourceMediaUrl, replaceDraftMediaSeedanceAsset, replaceDraftMediaUrl } from '@/lib/remix-draft-recovery';
import { recordCreatorSession } from '@/lib/creator-session-diagnostics';
import { CREATION_DRAFT_FORMAT, clearPersistedCreationDrafts, loadOrdinaryCreationDrafts, loadPersistedCreationDrafts, ordinaryDraftScope, persistCreationDrafts, remixDraftScope } from '@/lib/creation-draft-resume';
import {
  clearPendingGenerationAttempt,
  GENERATION_ATTEMPT_CHOICE_MESSAGE,
  GENERATION_ATTEMPT_UNCONFIRMED_MESSAGE,
  generationStartRefusalCode,
  isAmbiguousGenerationStartFailure,
  loadPendingGenerationAttempt,
  reusableAttemptKey,
  savePendingGenerationAttempt,
  type PendingGenerationAttempt,
} from '@/lib/generation-attempts';
import {
  clearActiveGenerationRecord,
  loadActiveGenerationRecord,
  saveActiveGenerationRecord,
  type ActiveGenerationRecord,
} from '@/lib/active-generation-record';
import { createDraftSaveQueue } from '@/lib/draft-save-queue';
import { SheetBackdrop, SheetGrabber, SheetPanel, sheetMotion, useSheetDismissDrag, useSheetPresentation } from '@/components/sheet-chrome';
import { useReducedMotion } from '@/lib/motion';
import { CloseGlyph } from '@/lib/platform-glyphs';
import { trackOnboardingEvent } from '@/lib/onboarding';
import { getGenerationOutput, getGenerationOutputs, pollGenerationStatus } from '@/lib/generation';
import {
  applyCatalogModelDefaults,
  applyVerifiedInputDurations,
  buildCatalogQuoteRequest,
  buildUnifiedCatalogGenerationRequest,
  catalogAppOutOfDateForRun,
  catalogDraftInputCounts,
  catalogDraftRunHandles,
  catalogMotionDraftSlotKeys,
  catalogMotionDraftSlotLabels,
  catalogMultiShotLimits,
  catalogPromptMeters,
  catalogRefusedRunPrice,
  catalogRunEnhancementInputs,
  catalogRunSlots,
  catalogStartRequest,
  catalogSubjectSlot,
  catalogVideoRunReferenceMode,
  getCatalogDraftSettings,
  hasCreatorEditedPromptDuringRemix,
  hydrateCatalogCreationDraftFromRemixSource,
  MOTION_INPUT_LABELS,
  multiShotTotalDuration,
  normalizeCreationDraftForCatalog,
  readVerifiedInputDurations,
  REFERENCE_DURATION_CHANGED_CODE,
  validateCatalogCreationDraft,
  type RefusedRunPrice,
} from '@/lib/generation-model-draft';
import { guidedCreationStarter, guidedCreationStarters } from '@/lib/guided-creation-starter';
import {
  getActiveCatalogInputSlots,
  getCatalogModel,
  getCatalogModels,
  catalogConditionsMatch,
  type CatalogControl,
  type CatalogGenerationRequest,
  type CatalogInputSlot,
  type CatalogPrimitive,
  type GenerationModelCatalog,
} from '@/lib/generation-model-catalog';
import {
  buildPromptEnhancementRequest,
  buildShotPromptEnhancementRequest,
  createDefaultCreationDraft,
  createMediaDraftFromUpload,
  createSubjectDraft,
  getMotionDuration,
  nameUnnamedReferences,
  placeName,
  REMIX_RESTORE_WARNING_MESSAGE,
  renameMediaDraft,
  renameSubjectDraft,
  replaceMediaDraftMedia,
  replaceShotPrompt,
  subjectAsReference,
  type CreationDraft,
  type ImageCreationDraft,
  type MediaDraft,
  type MotionCreationDraft,
  type ReferenceMode,
  type SubjectDraft,
  type VideoCreationDraft,
  videoDraftHandles,
  videoDraftReferenceMode,
  videoSubjects,
} from '@/lib/media-creation-view-model';
import { assetDurationSeconds, pickAudioDocument, pickMedia, pickMediaList, uploadPickedMedia, type UploadedMedia } from '@/lib/media';
import { isUploadCancelledError, runWeightedUploadQueue, type WeightedUploadQueueResult } from '@/lib/upload-file';
import { invalidateProfileCreations } from '@/lib/profile-media-query';
import { signedStorageUrlExpiresAt } from '@/lib/media-url-expiry';
import {
  findActiveReferenceMention,
  insertHandleAtSelection,
  normalizeTextSelection,
  type TextSelection,
} from '@/lib/reference-mentions';
import { formatCreditAmount } from '@/lib/pricing';
import { withCreditCost, formatCreditCost } from '@/lib/generation-action-label';
import {
  generationWaitCountdownLabel,
  generationWaitDetail,
  generationWaitPhase,
  generationWaitProgressPercent,
  generationWaitTitle,
  readGenerationWaitTiming,
} from '@/lib/generation-wait';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { hexWithAlpha } from '@/lib/eased-fade';
import { accentColor, appTheme, mediaColors, type ToolAccent } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type { CreatorToolId, GenerationStartResponse, GenerationStatusResponse, PromptEnhancementLevel, PromptEnhancementRequest, PromptEnhancementResponse, PromptEnhancementWarning, SeedanceAssetResponse } from '@/lib/types';
import { SUBJECT_IMAGES_PER_NAME, SUBJECT_IMAGES_SLOT_KEY, subjectsPerRun, type ModelCatalogSummary, GENERATION_PROMPT_MAX_LENGTH, MOTION_PROMPT_MAX_LENGTH, PROMPT_ENHANCEMENT_COST_CREDITS } from '@/lib/model-catalog/protocol';
import { createSeedanceAssetMetadata, isSeedance2VideoModelId, type SeedanceAssetKind, type SeedanceAssetMetadata } from '@/lib/model-catalog/seedance-assets';
import type { PromptLengthMeter } from '@/lib/model-catalog/provider-prompt-limits';
import { useGenerationModelCatalog } from '@/lib/use-generation-model-catalog';
import { invalidateActiveGenerations } from '@/lib/active-generations';
import { verticalHitSlop } from '@/lib/hit-target';
import { haptic } from '@/lib/haptics';
import { useHardwareBack } from '@/lib/use-hardware-back';

const TOOL_META: Record<CreatorToolId, { title: string; accent: ToolAccent; subtitle: string }> = {
  image: {
    title: 'Image',
    accent: 'image',
    subtitle: 'Reference-aware image generation',
  },
  video: {
    title: 'Video',
    accent: 'video',
    subtitle: 'Frames, elements, sound, and shots',
  },
  motion: {
    title: 'Motion',
    accent: 'motion',
    subtitle: 'Character image plus motion video',
  },
};

function waitUntilAppActive(signal?: AbortSignal) {
  // React Native can briefly report null during startup. Only pause polling for
  // states that are explicitly known to be offscreen.
  const currentState = AppState?.currentState;
  if (currentState !== 'background' && currentState !== 'inactive') {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const abortError = () => {
      const error = new Error('Generation status check cancelled.');
      error.name = 'AbortError';
      return error;
    };
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const cleanup = () => {
      subscription.remove();
      signal?.removeEventListener('abort', handleAbort);
    };
    const handleAbort = () => {
      cleanup();
      reject(abortError());
    };
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      cleanup();
      resolve();
    });
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

function isTool(value: unknown): value is CreatorToolId {
  return value === 'image' || value === 'video' || value === 'motion';
}

function catalogControlDraftKey(draft: CreationDraft, controlKey: string) {
  return draft.tool === 'motion' && controlKey === 'resolution' ? 'mode' : controlKey;
}

function readCatalogControlDraftValue(
  draft: CreationDraft,
  control: CatalogControl,
): CatalogPrimitive {
  const key = catalogControlDraftKey(draft, control.key);
  const legacyValue = (draft as unknown as Record<string, unknown>)[key];
  if (
    typeof legacyValue === 'string'
    || typeof legacyValue === 'boolean'
    || (typeof legacyValue === 'number' && Number.isFinite(legacyValue))
  ) {
    return legacyValue;
  }
  return draft.catalogSettings?.[control.key] ?? control.defaultValue;
}

function writeCatalogControlDraftValue(
  draft: CreationDraft,
  control: CatalogControl,
  value: CatalogPrimitive,
): CreationDraft {
  const key = catalogControlDraftKey(draft, control.key);
  const legacyUpdate = Object.prototype.hasOwnProperty.call(draft, key)
    ? { [key]: value }
    : {};
  return {
    ...draft,
    ...legacyUpdate,
    catalogSettings: {
      ...(draft.catalogSettings ?? {}),
      [control.key]: value,
    },
  } as CreationDraft;
}

function withUniqueReferenceHandle(media: MediaDraft, existing: MediaDraft[]) {
  const base = media.displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'reference';
  const used = new Set(existing.map((item) => item.handle).filter((handle): handle is string => Boolean(handle)));
  let handle = `@${base}`;
  let suffix = 2;
  while (used.has(handle)) {
    handle = `@${base}_${suffix}`;
    suffix += 1;
  }
  return { ...media, handle };
}

function promptHandlePattern(handle: string, global = false) {
  const escapedHandle = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w@])${escapedHandle}(?![\\w])`, global ? 'g' : undefined);
}

function replacePromptHandle(prompt: string, handle: string, replacement = '') {
  return prompt
    .replace(promptHandlePattern(handle, true), `$1${replacement}`)
    .replace(/[ \t]+([,.;!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function promptContainsHandle(prompt: string, handle?: string | null) {
  if (!handle) return false;
  return promptHandlePattern(handle).test(prompt);
}

const ASPECT_RATIO_ORDER = ['auto', '1:1', '4:5', '3:4', '2:3', '9:16', '5:4', '4:3', '3:2', '16:9', '21:9'];

function orderAspectRatioOptions<T extends { value: string }>(options: T[]) {
  return options
    .map((option, index) => ({ option, index }))
    .sort((left, right) => {
      const leftOrder = ASPECT_RATIO_ORDER.indexOf(left.option.value.toLowerCase());
      const rightOrder = ASPECT_RATIO_ORDER.indexOf(right.option.value.toLowerCase());
      const normalizedLeft = leftOrder === -1 ? ASPECT_RATIO_ORDER.length : leftOrder;
      const normalizedRight = rightOrder === -1 ? ASPECT_RATIO_ORDER.length : rightOrder;
      return normalizedLeft - normalizedRight || left.index - right.index;
    })
    .map(({ option }) => option);
}

type CreatorCatalogModel = ReturnType<typeof getCatalogModels>[number];

function activeCatalogInputSlots(
  model: CreatorCatalogModel | null,
  draft: CreationDraft,
  /**
   * Which reference shape to ask about. Every slot a model declares is on screen at once,
   * so each group asks about its own shape: reading both off one "current" mode made the
   * reference slots report zero capacity until you were already in the reference mode,
   * which was only reachable from a control that capacity gated.
   */
  referenceMode: ReferenceMode = 'frames',
) {
  if (!model?.inputModes) return null;
  const settings = {
    ...getCatalogDraftSettings(draft, model),
    ...(draft.tool === 'video'
      ? { referenceMode, isMultiShot: draft.isMultiShot }
      : {}),
  };
  // Opened with what the draft holds, counted as the run counts it.
  return getActiveCatalogInputSlots(model, settings, catalogDraftInputCounts(draft, model));
}

function catalogInputSlot(
  model: CreatorCatalogModel | null,
  draft: CreationDraft,
  key: string,
  referenceMode: ReferenceMode = 'frames',
): CatalogInputSlot | null {
  return activeCatalogInputSlots(model, draft, referenceMode)?.find((slot) => slot.key === key) ?? null;
}

function catalogInputLimit(
  model: CreatorCatalogModel | null,
  draft: CreationDraft,
  key: string,
  legacyMax: number,
  referenceMode: ReferenceMode = 'frames',
) {
  if (!model?.inputModes) return legacyMax;
  return catalogInputSlot(model, draft, key, referenceMode)?.max ?? 0;
}

function catalogInputSupported(
  model: CreatorCatalogModel | null,
  draft: CreationDraft,
  key: string,
  legacySupported: boolean,
  referenceMode: ReferenceMode = 'frames',
) {
  if (!model?.inputModes) return legacySupported;
  return Boolean(catalogInputSlot(model, draft, key, referenceMode));
}

/**
 * True when a model's reference slots sit behind a reference-mode condition, which is what
 * makes them exclusive with the frame slots.
 *
 * Kling's video elements live in a mode with no conditions at all — deliberately, so they
 * can be attached alongside a start frame, which is what `kling-3.0/video` accepts
 * (`image_urls` and `kling_elements` in one request). Testing only "does this model have
 * any reference slot" locked the frames behind them and told the user "one per run".
 */
function modeGatedReferenceSlots(model: CreatorCatalogModel | null) {
  if (!model?.inputModes) return true;
  return model.inputModes.some((mode) => (
    (mode.conditions ?? []).length > 0
    && mode.slots.some((slot) => slot.role === 'reference')
  ));
}

function supportsReusableVideoInputs(
  model: CreatorCatalogModel | null,
  draft: VideoCreationDraft,
  shape: ReferenceMode,
) {
  if (!model) return false;
  if (model.inputModes) {
    // Subjects' pictures have a group of their own.
    return (activeCatalogInputSlots(model, draft, shape) ?? []).some((slot) => (
      slot.role === 'reference'
      && slot.key !== SUBJECT_IMAGES_SLOT_KEY
      && ['image', 'video', 'audio', 'character', 'preparedVoice'].includes(slot.kind)
    ));
  }
  // A descriptor without input modes sends its references in single shots only.
  return !draft.isMultiShot && Boolean(
    model.inputs.imageReferences
    || model.inputs.videoReferences
    || model.inputs.audioReferences
    || model.inputs.preparedAudioReferences
    || model.inputs.characterReferences
  );
}

/**
 * The shape a video run takes on this model, as the quote, the validator and the request
 * read it. A reference kept from another model, which this one has no slot for, no longer
 * makes a frames run a references run. Seeded with the shape the attachments imply, which
 * is all a descriptor without input modes can go by.
 */
function videoRunReferenceMode(draft: VideoCreationDraft, model: CreatorCatalogModel | null): ReferenceMode {
  const derived = videoDraftReferenceMode(draft);
  return model ? catalogVideoRunReferenceMode({ ...draft, referenceMode: derived }, model) : derived;
}

/**
 * The shape a video draft's reference rail, and the uploads it starts, ask about. A single shot
 * becomes a references run once a reference is attached, so its rail offers the references shape
 * whatever the run is now. A multi-shot run keeps its own shape (frames, or subjects): its rail
 * offers only what goes with that, Kling 3.0's video elements, which its multi_prompt takes
 * beside the shots.
 */
function referenceRailShape(draft: VideoCreationDraft, model: CreatorCatalogModel | null): ReferenceMode {
  return draft.isMultiShot ? videoRunReferenceMode(draft, model) : 'elements';
}

/**
 * The slot a model takes reference clips in, found by kind rather than key: Kling 3.0, the
 * default video model, takes its clips as named `videoElements` beside its frames, and a
 * lookup by `videoReferences` left it with no way to add one.
 */
function referenceVideoSlot(model: CreatorCatalogModel | null, draft: VideoCreationDraft, shape: ReferenceMode): CatalogInputSlot | null {
  return activeCatalogInputSlots(model, draft, shape)?.find((slot) => slot.role === 'reference' && slot.kind === 'video') ?? null;
}

function isFrameRole(role: CatalogInputSlot['role']) {
  return role === 'startFrame' || role === 'endFrame';
}

/**
 * What a video draft holds that a run on this model would not send: past a slot's max, of a
 * kind the run's shape has no slot for, or a frame the run's shape leaves out while it sends the
 * other (Wan 2.7 takes a start frame beside references, and no end frame). A draft keeps them
 * across a model change, as the web creator does, so they wait apart from the run's own inputs
 * until they are removed or a model or shape that takes them is picked. Frames a run sends none
 * of are the other side of a frames-or-references choice, which the frames group itself says.
 */
function standbyVideoReferences(draft: VideoCreationDraft, model: CreatorCatalogModel | null): MediaDraft[] {
  if (!model) return [];
  if (!model.inputModes) {
    return [
      ...draft.references.slice(model.inputs.imageReferences?.max ?? 0),
      ...draft.referenceVideos.slice(model.inputs.videoReferences?.max ?? 0),
      ...draft.referenceAudios.slice(model.inputs.audioReferences?.max ?? 0),
    ];
  }
  const run = catalogRunSlots(draft, model);
  const sent = new Set(run.flatMap(({ assets }) => assets).map((asset) => asset.id));
  const frames = run.some(({ slot }) => isFrameRole(slot.role))
    ? [draft.startFrame, draft.endFrame].filter((media): media is MediaDraft => Boolean(media))
    : [];
  return [...draft.references, ...draft.referenceVideos, ...draft.referenceAudios, ...frames].filter((media) => !sent.has(media.id));
}

/** The validator's word on a slot holding more than it takes, said beside the extras. */
function isReferenceLimitError(error: string) {
  return / supports up to \d+ /.test(error) || / does not support (?:image references|reference videos|reference audio)\.$/.test(error);
}

/** Only a positive 404 says a staged upload was swept; offline, a rate limit or a 5xx says nothing. */
function isMissingUploadError(error: unknown) {
  return Boolean(error && typeof error === 'object' && (error as { status?: unknown }).status === 404);
}

/**
 * What holds a run whose own inputs include a swept upload: one the run leaves out (past a slot's
 * max, kept for another model) is marked where it waits and holds nothing. A subject's picture
 * carries the subject's name, and the subject is what is added again. A descriptor without input
 * modes has no slots to read, so every piece of media the draft holds counts, as its quote counts
 * them from the draft.
 */
function unavailableRunInputMessage(
  draft: CreationDraft,
  model: CreatorCatalogModel | null,
  unavailablePaths: ReadonlySet<string>,
): string | null {
  if (!model || unavailablePaths.size === 0) return null;
  const inputs = model.inputModes
    ? catalogRunSlots(draft, model).flatMap(({ slot, assets }) => assets.map((asset) => ({ asset, ofSubject: slot.key === SUBJECT_IMAGES_SLOT_KEY })))
    : heldDraftMedia(draft).map((asset) => ({ asset, ofSubject: false }));
  const gone = inputs.find(({ asset }) => Boolean(asset.storagePath && unavailablePaths.has(asset.storagePath)));
  if (!gone) return null;
  const name = gone.asset.displayName?.trim() || gone.asset.fileName?.trim() || 'unnamed reference';
  return gone.ofSubject
    ? `A picture of ${name} is no longer available. Add ${name} again.`
    : `${name} is no longer available. Add this reference again.`;
}

/**
 * Shown in place of a motion quote the server would refuse (it needs both inputs to price), asking
 * for the inputs by what the composer's slots are called (`catalogMotionDraftSlotLabels`): production
 * publishes Kling 3.0's as "Reference images" and "Reference videos", and a line asking for a
 * character image and a motion clip named neither (2026-10-21). The motion-inputs pair keeps its
 * own line, which says what the clip is for.
 */
function motionInputsHint(labels: { image: string; video: string }): string {
  if (labels.image === MOTION_INPUT_LABELS.image && labels.video === MOTION_INPUT_LABELS.video) {
    return 'Add a character image and a motion clip.';
  }
  return `Add ${slotLabelInSentence(labels.image)} and ${slotLabelInSentence(labels.video)}.`;
}

/** A slot's label mid-sentence: its first letter lowered when it starts a plain word, with an article unless it reads as a plural. */
function slotLabelInSentence(label: string): string {
  const words = /^[A-Z][a-z]/.test(label) ? `${label[0].toLowerCase()}${label.slice(1)}` : label;
  return /s$/i.test(words) ? words : `${/^[aeiou]/i.test(words) ? 'an' : 'a'} ${words}`;
}

/**
 * Said in place of a `cost_changed` refusal once the run's price, asked again, is the price the
 * start refused (`catalogAppOutOfDateForRun`): this build prices the run as the server no longer
 * does. It promises no fix on reopening: the update that prices the run as the server does goes
 * out by hand after the server's deploy, so for a while there is none, and expo-updates swaps a
 * fetched bundle in only at the cold start after the one that fetched it (`app-update-policy.ts`).
 * Short enough for the creator bar's two lines, where a longer one lost its end on the Pixel 9a;
 * the failure view adds that the draft is saved.
 */
const APP_OUT_OF_DATE_MESSAGE = 'This app is out of date, so it can’t price this run. Update it, or try again later.';
const APP_OUT_OF_DATE_DRAFT_NOTE = 'Your draft is saved.';

/**
 * What the failure view offers first for a refusal the server named, where pressing Try
 * again would only send the same refusal back: the prompt, the balance, the reference or
 * the price is what has to change.
 */
function startRefusalActionLabel(code: string | null): string | null {
  if (code === 'prompt_blocked') return 'Edit prompt';
  if (code === 'insufficient_credits') return 'Get credits';
  if (code === 'invalid_input_media') return 'Replace reference';
  if (code === 'cost_changed' || code === 'REFERENCE_DURATION_CHANGED') return 'Check the new price';
  if (code === 'CATALOG_CHANGED' || code === 'MODEL_UNAVAILABLE') return 'Review options';
  return null;
}

/** The video and motion bars' summary; the image bar builds its own from the image draft's fields. */
function creatorParameterSummary(draft: VideoCreationDraft | MotionCreationDraft, model: CreatorCatalogModel | null) {
  if (draft.tool === 'video') {
    const totalDuration = draft.isMultiShot ? multiShotTotalDuration(draft.multiPrompts) : draft.duration;
    const modeControl = model?.controls.find((control) => control.key === 'mode' && control.type === 'choice');
    const modeLabel = modeControl?.type === 'choice'
      ? modeControl.options.find((option) => option.value === draft.mode)?.label ?? draft.mode
      : draft.mode;
    const inferredResolution = modeLabel.match(/(?:\d{3,4}p|4k)/i)?.[0] ?? draft.resolution ?? modeLabel;
    return [inferredResolution.toUpperCase(), draft.aspectRatio, `${totalDuration}s`].filter(Boolean).join(' · ');
  }
  const duration = draft.referenceVideo ? getMotionDuration(draft) : null;
  return [draft.mode.toUpperCase(), duration ? `${duration}s` : 'Add motion'].join(' · ');
}

type EnhanceVerb = 'Enhance' | 'Polish';

/**
 * An Enhance button's words. Every press debits the enhancer's price, so the button states it, and
 * so does what is announced while the press runs, as on the web button.
 */
function enhanceButtonLabels(verb: EnhanceVerb, busy: boolean) {
  const word = busy ? (verb === 'Polish' ? 'Polishing' : 'Enhancing') : verb;
  return {
    label: busy ? word : withCreditCost(word, PROMPT_ENHANCEMENT_COST_CREDITS),
    accessibilityLabel: withCreditCost(word, PROMPT_ENHANCEMENT_COST_CREDITS),
  };
}

/** A shot's Enhance names its shot, so it is not taken for the prompt's, priced as every Enhance is. */
function shotEnhanceButtonLabels(shotNumber: number, busy: boolean) {
  const word = `${busy ? 'Enhancing' : 'Enhance'} shot ${shotNumber}`;
  return {
    label: busy ? word : withCreditCost(word, PROMPT_ENHANCEMENT_COST_CREDITS),
    accessibilityLabel: withCreditCost(word, PROMPT_ENHANCEMENT_COST_CREDITS),
  };
}

/** Notes such as a prompt longer than the model reads; a blocking one is a refusal, not a note. */
function enhancementNotes(result: PromptEnhancementResponse): PromptEnhancementWarning[] {
  return (result.warnings ?? []).filter((warning) => warning.severity !== 'blocking').slice(0, 3);
}

/** The references an image run sends: the first ones, up to the model's max; all of them before its descriptor is in. */
function imageRunReferences(draft: ImageCreationDraft, model: CreatorCatalogModel | null) {
  if (!model) return draft.references;
  return draft.references.slice(0, catalogInputLimit(model, draft, 'imageReferences', model.inputs.imageReferences?.max ?? 0));
}

/**
 * A prompt that names a reference the run sends is polished rather than rewritten, as on the web:
 * the enhancer keeps the sentence that names it as written and only adds around it.
 */
function imagePromptNamesReference(draft: ImageCreationDraft, model: CreatorCatalogModel | null) {
  return imageRunReferences(draft, model).some((media) => promptContainsHandle(draft.prompt, media.handle));
}

/** "10,000": the prompt counter's numbers. */
function groupDigits(value: number) {
  return String(Math.max(0, Math.trunc(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Which add control an upload came from: that tile shows the upload's progress. */
type UploadTarget = 'image-references' | 'subject' | 'start-frame' | 'end-frame' | 'character' | 'reference-video' | 'reference-audio' | 'motion-clip';

/** An upload in flight: where it came from, how far its bytes have got (null while their size is unknown), and whether it can be stopped. */
type UploadProgress = { target: UploadTarget; percent: number | null; cancellable: boolean };

/** A file the picker handed over, as the upload takes it. */
type PickedUpload = {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  kind: 'image' | 'video' | 'audio';
  durationSeconds?: number | null;
  sizeBytes?: number | null;
};

function uploadPercentLabel(progress: UploadProgress) {
  return progress.percent === null ? '…' : `${progress.percent}%`;
}

/**
 * Names the picks that did not arrive. The ones that did are kept, so only these need adding again;
 * the loop this replaced dropped every finished upload when one failed.
 */
function uploadFailureMessage(failures: ReadonlyArray<{ item: PickedUpload; error: unknown }>, added: number): string | null {
  if (failures.length === 0) return null;
  const names = failures.map(({ item }) => item.fileName?.trim() || (item.kind === 'video' ? 'a clip' : item.kind === 'audio' ? 'a track' : 'a picture'));
  const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const lead = added > 0 ? `Added ${added} of ${added + failures.length}. ` : '';
  if (failures.every(({ error }) => isUploadCancelledError(error))) return `${lead}Upload cancelled.`;
  const reason = failures.map(({ error }) => error).find((error) => !isUploadCancelledError(error));
  const detail = reason instanceof Error && reason.message.trim() ? ` ${reason.message.trim()}` : '';
  return `${lead}Could not add ${listed}.${detail}`;
}

/** Kie's motion-control limit for the clip, stricter than the sign step's 250 MB, as the web creator holds it. */
const MOTION_CLIP_MAX_BYTES = 100 * 1024 * 1024;
/** The clip length the web creator holds a model to when its descriptor names none. */
const MOTION_CLIP_DEFAULT_MAX_SECONDS = 30;

/**
 * A motion clip the run would refuse, said at the pick in the web creator's words: checked after the
 * upload, a long clip cost a full upload (minutes on mobile data) before the refusal.
 */
function motionClipRefusal(picked: { fileName?: string | null; fileSize?: number | null; duration?: number | null }, maxSeconds: number) {
  const seconds = assetDurationSeconds(picked.duration);
  if (seconds !== null && seconds > maxSeconds) return `Reference video exceeds ${maxSeconds}s. Please choose a shorter clip.`;
  if ((picked.fileSize ?? 0) > MOTION_CLIP_MAX_BYTES) return `"${picked.fileName?.trim() || 'This video'}" is over 100 MB. Please upload a smaller video.`;
  return null;
}

/**
 * Where sign-in returns to: this creator with the params it was opened with, so the screen still
 * under the sign-in is the one shown again. A return without them was a different route, which
 * opened a creator without the remix or the prompt. Inside the Create tab, the tab itself.
 */
function creatorReturnPath({ insideTab, tool, guided, initialPrompt, remixSource }: {
  insideTab: boolean;
  tool: CreatorToolId;
  guided: boolean;
  initialPrompt?: string | null;
  remixSource?: MediaCreationScreenProps['remixSource'];
}) {
  const params: Array<[string, string | null | undefined]> = insideTab
    ? [['tool', tool], ['guided', guided ? '1' : null]]
    : [
        ['remix', remixSource?.generationId],
        ['remixPost', remixSource?.postId],
        ['prompt', initialPrompt],
        ['guided', guided ? '1' : null],
        ['sourceTitle', remixSource?.title],
        ['sourceCreator', remixSource?.creatorLabel],
        ['sourceThumbnail', remixSource?.thumbnailUrl],
      ];
  const query = params
    .flatMap(([key, value]) => (value && value.trim() ? [`${encodeURIComponent(key)}=${encodeURIComponent(value)}`] : []))
    .join('&');
  const path = insideTab ? '/(tabs)/creator' : `/create/${tool}`;
  return query ? `${path}?${query}` : path;
}

function mediaAccessibleName(media: MediaDraft) {
  return media.displayName.trim() || media.fileName.trim() || 'unnamed reference';
}

/**
 * A Seedance 2 reference prepared with the provider: Kie registers the file once
 * and answers with an asset id, which a run sends in place of the link, so the
 * file is not fetched and processed again on every run and a file the provider
 * rejects is known before a run is paid for (as on the web creator). Reading it
 * back is polled a bounded number of times after a prepare; a press asks again.
 */
const SEEDANCE_ASSET_CHECK_MS = 4_000;
const SEEDANCE_ASSET_CHECK_LIMIT = 15;

function seedanceAssetKindOf(media: MediaDraft): SeedanceAssetKind {
  return media.kind === 'video' ? 'Video' : media.kind === 'audio' ? 'Audio' : 'Image';
}

function seedanceAssetFromResponse(response: SeedanceAssetResponse, assetType: SeedanceAssetKind, sourceUrl: string): SeedanceAssetMetadata {
  return createSeedanceAssetMetadata({
    assetId: response.assetId,
    assetType,
    status: response.status,
    sourceUrl: response.sourceUrl ?? sourceUrl,
    error: response.error,
    lastCheckedAt: response.lastCheckedAt,
  });
}

/** What the Reference details sheet says about a reference's Seedance asset. */
function seedanceAssetStatusLine(asset: SeedanceAssetMetadata | null): string {
  if (!asset || asset.status === 'idle') return 'Not prepared. Prepared once, the file is reused by every run instead of being sent to Seedance again.';
  if (asset.status === 'processing') return 'Seedance is processing the file. Runs send the link until it is ready.';
  if (asset.status === 'active') return 'Ready. Runs send the prepared asset in place of the file.';
  return asset.error ? `Failed: ${asset.error}` : 'Failed. Try again, or replace the media.';
}

function seedanceAssetActionLabel(asset: SeedanceAssetMetadata | null, busy: boolean): string {
  if (busy) return asset?.status === 'processing' ? 'Checking…' : 'Preparing…';
  if (!asset || asset.status === 'idle') return 'Prepare for Seedance';
  if (asset.status === 'processing') return 'Check status';
  if (asset.status === 'active') return 'Prepare again';
  return 'Try again';
}

/** The word under an audio tile, which has no details sheet. */
function seedanceAssetTileLabel(asset: SeedanceAssetMetadata | null, busy: boolean): string {
  if (busy) return '…';
  if (!asset || asset.status === 'idle') return 'Prepare';
  if (asset.status === 'processing') return 'Processing';
  if (asset.status === 'active') return 'Ready';
  return 'Retry';
}

function replaceMediaInList(items: MediaDraft[], id: string, upload: Parameters<typeof replaceMediaDraftMedia>[1]) {
  return items.map((media) => (media.id === id ? replaceMediaDraftMedia(media, upload) : media));
}

function promptValidationMessage(error: string) {
  if (error === 'Prompt is required.') return 'Add a prompt before generating.';
  if (error === 'All multi-shot entries need a text prompt.') return error;
  return null;
}

function createMobileGenerationIdempotencyKey(prefix: CreatorToolId) {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) {
    return `${prefix}:${randomUUID()}`;
  }

  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

/** What the remix banner says when only an account can read the source. */
const REMIX_RESTORE_SIGN_IN_MESSAGE = 'Sign in to restore remix source media.';

/** The answer of a route the server keeps for accounts, to a guest's token. */
function isRegistrationRequiredError(error: unknown) {
  return error instanceof ApiError && error.status === 403 && error.code === 'REGISTRATION_REQUIRED';
}

type MediaCreationScreenProps = {
  initialTool?: CreatorToolId;
  insideTab?: boolean;
  initialPrompt?: string | null;
  remixSource?: {
    generationId?: string | null;
    postId?: string | null;
    title?: string | null;
    creatorLabel?: string | null;
    thumbnailUrl?: string | null;
  };
  guided?: boolean;
  onClose?: () => void;
  registerBeforeClose?: (guard: (() => Promise<boolean>) | null) => void;
  /** Reports the first edit of the session, so the route can take the native
   *  pop gesture away from a screen whose exit now has to save something. */
  onDirtyChange?: (dirty: boolean) => void;
};

/**
 * What the creator holds belongs to the identity it opened under: the drafts,
 * a run it is watching, a start it could not confirm. The Create tab is keyed
 * by tool, not identity, so it can stay mounted through a sign-out and the next
 * sign-in; when the identity changes, the screen starts again for the new one
 * instead of carrying the last person's work onto it (audit A5).
 *
 * The one change it stays mounted through is an ordinary session getting its
 * first identity — signing in from Generate, or a guest session arriving once
 * the phone is online. Nothing typed before then was saved anywhere, and it
 * belongs to the person who now has an identity.
 */
export function MediaCreationScreen(props: MediaCreationScreenProps) {
  const { identityUserId } = useAuth();
  const [opened, setOpened] = useState({ identityUserId, generation: 0 });
  if (opened.identityUserId !== identityUserId) {
    const keepsWork = opened.identityUserId === null && !props.remixSource;
    setOpened({ identityUserId, generation: keepsWork ? opened.generation : opened.generation + 1 });
  }
  return <IdentityCreationScreen key={opened.generation} {...props} />;
}

function IdentityCreationScreen({
  initialTool = 'image',
  insideTab = false,
  initialPrompt,
  remixSource,
  guided = false,
  onClose,
  registerBeforeClose,
  onDirtyChange,
}: MediaCreationScreenProps) {
  const theme = useAppTheme();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // Generating and enhancing key off `identityUserId` so a guest can spend the
  // credits they just bought. So does the remix restore: the server serves a
  // guest the source of its own or a linked creation, and keeps another
  // creator's for accounts (403 REGISTRATION_REQUIRED), which the restore
  // answers with its sign-in line (D4).
  const { identityUserId, isGuest, session, api, credits, updateCredits, refreshProfile, ensureGuestMergeTicket } = useAuth();
  const queryClient = useQueryClient();
  const [activeTool, setActiveTool] = useState<CreatorToolId>(isTool(initialTool) ? initialTool : 'image');
  // A guided first creation names its starter's model from the outset, so the default is never
  // quoted first; the catalog reconcile below applies the starter's settings. A remix restores
  // its source's model instead, so a remix opened as guided takes no starter.
  const guidedScreen = guided && !remixSource;
  // Every starter the guided draft may land on, in order: the catalog may have dropped the first.
  const guidedStarterIds = guidedCreationStarters(initialTool, { guided: guidedScreen, initialTool }).map((starter) => starter.modelId);
  const withGuidedStart = <T extends CreationDraft>(draft: T): T => {
    const starter = guidedCreationStarter(draft.tool, { guided: guidedScreen, initialTool });
    return starter ? { ...draft, model: starter.modelId } : draft;
  };
  const [imageDraft, setImageDraft] = useState<ImageCreationDraft>(() => withGuidedStart({
    ...createDefaultCreationDraft('image'),
    prompt: initialTool === 'image' ? initialPrompt ?? '' : '',
  }));
  const [videoDraft, setVideoDraft] = useState<VideoCreationDraft>(() => withGuidedStart({
    ...createDefaultCreationDraft('video'),
    prompt: initialTool === 'video' ? initialPrompt ?? '' : '',
  }));
  const [motionDraft, setMotionDraft] = useState<MotionCreationDraft>(() => withGuidedStart({
    ...createDefaultCreationDraft('motion'),
    prompt: initialTool === 'motion' ? initialPrompt ?? '' : '',
  }));
  const [isUploading, setIsUploading] = useState(false);
  // The running upload's tile, progress and Cancel (uploadPicks).
  const [upload, setUpload] = useState<UploadProgress | null>(null);
  const uploadControllerRef = useRef<AbortController | null>(null);
  // The picker's own copy of each upload this session made, by storage path, for its tile: the signed
  // link downloaded the whole upload again. Never saved, so after a restart a tile draws the link.
  const [localPreviews, setLocalPreviews] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [replacingReferenceId, setReplacingReferenceId] = useState<string | null>(null);
  const [preparingAssetId, setPreparingAssetId] = useState<string | null>(null);
  const seedanceAssetTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => () => {
    seedanceAssetTimers.current.forEach((timer) => clearTimeout(timer));
    seedanceAssetTimers.current.clear();
  }, []);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [enhanceLevel, setEnhanceLevel] = useState<'cinematic' | 'faithful'>('cinematic');
  // `shotId` names the shot of a multi-shot run whose words were enhanced, and not the prompt.
  const [enhanceUndo, setEnhanceUndo] = useState<{ previous: string; enhanced: string; shotId?: string } | null>(null);
  // What the enhancer said about the prompt it wrote, shown while that prompt (or that shot's words) stands.
  const [enhanceNotes, setEnhanceNotes] = useState<{ tool: CreatorToolId; prompt: string; warnings: PromptEnhancementWarning[]; shotId?: string } | null>(null);
  const [status, setStatus] = useState<GenerationStatusResponse | null>(null);
  const [lastGenerationId, setLastGenerationId] = useState<string | null>(null);
  const [lastPredictionId, setLastPredictionId] = useState<string | null>(null);
  const [generationTool, setGenerationTool] = useState<CreatorToolId | null>(null);
  const [pollingInterrupted, setPollingInterrupted] = useState(false);
  // The code of a start the server refused outright, which picks the failure view's first action.
  const [startRefusal, setStartRefusal] = useState<string | null>(null);
  // What a failed run's settlement gave back, said under its failure.
  const [refundNotice, setRefundNotice] = useState<string | null>(null);
  // What the start of the run being watched charged, as its answer said.
  const runCostRef = useRef<number | null>(null);
  // A run of another tool this identity started and has not seen end (see loadActiveGenerationRecord).
  const [otherToolRun, setOtherToolRun] = useState<ActiveGenerationRecord | null>(null);
  const activeRunCheckedRef = useRef(false);
  // Staged uploads the server no longer holds: swept 48 h after a run used them.
  const [unavailableReferencePaths, setUnavailableReferencePaths] = useState<ReadonlySet<string>>(() => new Set());
  const stagedReferencesCheckedRef = useRef(false);
  const [promptFocusRequest, setPromptFocusRequest] = useState(0);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [guidedReferencesExpanded, setGuidedReferencesExpanded] = useState(false);
  const [draftsHydrated, setDraftsHydrated] = useState(false);
  const [draftLoadError, setDraftLoadError] = useState(false);
  const [draftLoadAttempt, setDraftLoadAttempt] = useState(0);
  const [draftSaveError, setDraftSaveError] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  // Hold the app "busy" for as long as this screen has work that a restart
  // would destroy. An OTA update reloads the JS bundle, which is free at a cold
  // start and ruinous here: the render survives on the server but the screen
  // watching it does not, since lastPredictionId is component state. An upload
  // simply restarts from zero. See lib/app-update-policy — busy vetoes every
  // reload, critical updates included.
  useEffect(() => {
    if (!isGenerating && !pollingInterrupted) return;
    return acquireActivityLock('generation');
  }, [isGenerating, pollingInterrupted]);

  useEffect(() => {
    if (!isUploading) return;
    return acquireActivityLock('upload');
  }, [isUploading]);

  const closingRef = useRef(false);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumedRemixRef = useRef(false);
  const recoveringRemixReferences = useRef(false);
  const remixResolvedRef = useRef(false);
  const [remixRetry, setRemixRetry] = useState(0);
  const [remixRestoreFailed, setRemixRestoreFailed] = useState(false);
  const remixScope = remixDraftScope(identityUserId, remixSource);
  // Every saved draft is kept under an identity, a registered account or a
  // guest session. With no identity yet there is no one to keep it for, so
  // nothing is written until there is.
  const draftScope = remixScope ?? (identityUserId ? ordinaryDraftScope(identityUserId) : null);
  const draftWriter = useMemo(() => createDraftSaveQueue((drafts: { image: ImageCreationDraft; video: VideoCreationDraft; motion: MotionCreationDraft; remixRestored?: boolean; remixEditedKeys?: Partial<Record<CreatorToolId, string[]>> }) => (
    draftScope ? persistCreationDrafts(drafts, draftScope) : Promise.resolve()
  )), [draftScope]);
  const [dirty, setDirty] = useState(false);
  const latestDrafts = useRef({ image: imageDraft, video: videoDraft, motion: motionDraft });
  // The timers, the background flush and the close guard all need the newest
  // drafts without being rebuilt for each keystroke. An effect hands them over
  // early enough for every one of those — all of which run after paint — and
  // keeps rendering free of the side effect a bare assignment here would be.
  useEffect(() => {
    latestDrafts.current = { image: imageDraft, video: videoDraft, motion: motionDraft };
  }, [imageDraft, videoDraft, motionDraft]);
  const remixBaseline = useRef(latestDrafts.current);
  const savedRemixEdits = useRef<Partial<Record<CreatorToolId, string[]>>>({});
  const lastSavedFingerprint = useRef(JSON.stringify(latestDrafts.current));
  // The scope the drafts on screen were loaded under: undefined before the
  // first load, null while there was no identity to load them for.
  const hydratedScopeRef = useRef<string | null | undefined>(undefined);

  const [message, setMessage] = useState<string | null>(null);
  const [promptMessage, setPromptMessage] = useState<string | null>(null);
  const [referenceNotice, setReferenceNotice] = useState<string | null>(null);
  const [isPromptFocused, setIsPromptFocused] = useState(false);
  const [isReferenceMentionActive, setIsReferenceMentionActive] = useState(false);
  const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
  const [remixRestoreWarning, setRemixRestoreWarning] = useState<string | null>(null);
  // The screen is interactive from mount, so the restore needs its own visible
  // in-flight state — an empty form reads as finished, not as loading.
  const [isRestoringRemix, setIsRestoringRemix] = useState(false);
  // Mirrors each draft's prompt so the restore can tell whether the creator
  // typed while the bundle was still in flight.
  // Seeded from the drafts themselves, not from blanks: the restore effect below
  // is declared first, so on mount it reads this ref before the sync effect runs.
  const draftPromptsRef = useRef({
    image: imageDraft.prompt,
    video: videoDraft.prompt,
    motion: motionDraft.prompt,
  });
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
  // A pick whose model's details are still loading, or failed to: the draft changes once they are in.
  const [modelPick, setModelPick] = useState<{ modelId: string; error: string | null } | null>(null);
  const modelPickRef = useRef<string | null>(null);
  // The starter's details load whatever the drafts name, so the reconcile never waits on them for
  // good, until the guided draft settles (a revision): a starter the catalog dropped then leaves
  // the selected ids, where it would hold the creator "unavailable" through any catalog error.
  const guidedDraft = initialTool === 'image' ? imageDraft : initialTool === 'motion' ? motionDraft : videoDraft;
  const pinnedStarterIds = guidedDraft.catalogRevision ? [] : guidedStarterIds;
  const catalogQuery = useGenerationModelCatalog(api, {
    kind: activeTool,
    selectedIds: [imageDraft.model, videoDraft.model, motionDraft.model, ...pinnedStarterIds],
    pickerOpen: modelPickerVisible,
  });
  const catalog = catalogQuery.catalog;
  const refetchCatalog = catalogQuery.refetch;
  const loadCatalogDetails = catalogQuery.loadDetails;
  const [parametersVisible, setParametersVisible] = useState(false);
  const [workspaceVisible, setWorkspaceVisible] = useState(false);
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null);
  const modelSelectionTouched = useRef<Record<CreatorToolId, boolean>>({ image: false, video: false, motion: false });
  const activeGenerationRequestKeyRef = useRef<string | null>(null);
  const generationPollControllerRef = useRef<AbortController | null>(null);
  const remixHydrationKeyRef = useRef<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => () => {
    generationPollControllerRef.current?.abort();
  }, []);

  // A start whose response never arrived, kept per identity so a restart can
  // still check it instead of letting the next press start a second run.
  const [pendingAttempt, setPendingAttempt] = useState<PendingGenerationAttempt | null>(null);
  useEffect(() => {
    setPendingAttempt(null);
    if (!identityUserId) return;
    let active = true;
    void loadPendingGenerationAttempt(identityUserId).then(
      (attempt) => {
        if (active) setPendingAttempt((current) => current ?? attempt);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [identityUserId]);

  useEffect(() => {
    let active = true;
    setDraftsHydrated(false);
    setDraftLoadError(false);
    resumedRemixRef.current = false;
    recoveringRemixReferences.current = false;
    remixResolvedRef.current = false;
    // Read when the scope changes rather than tracked: the session object is
    // replaced on every token refresh, and reloading then would pull the drafts
    // out from under someone typing.
    const signedInAt = session?.user?.last_sign_in_at ?? null;
    // A remix can resume its own session. A prompt-only entry resumes the saved drafts too and
    // replaces only its own tool's prompt: it used to skip the load, and its first save then
    // wrote the defaults over every tool's saved draft.
    const seedsPrompt = Boolean(initialPrompt) && !remixScope;
    const seed = <T extends CreationDraft>(draft: T): T => (
      seedsPrompt && draft.tool === initialTool ? { ...draft, prompt: initialPrompt ?? '' } : draft
    );
    const load = !identityUserId
      ? Promise.resolve(null)
      : remixScope
        ? loadPersistedCreationDrafts(remixScope)
        : loadOrdinaryCreationDrafts({ identityUserId, signedInAt });
    void load.then((persisted) => {
      if (!active) return;
      if (persisted) {
        // The fingerprint below stays the saved record's, so the autosave writes the seeded prompt.
        setImageDraft(seed(persisted.image));
        setVideoDraft(seed(persisted.video));
        setMotionDraft(seed(persisted.motion));
        // A previous failed restore may have been saved as complete, or the links
        // it saved may have run out since. Re-read its source without resetting
        // the creator's other saved fields.
        recoveringRemixReferences.current = Boolean(remixScope && persisted.remixRestored
          && needsRemixReferenceRecovery(persisted[initialTool], { now: Date.now(), storageBaseUrl: env.supabaseUrl }));
        resumedRemixRef.current = Boolean(remixScope && persisted.remixRestored && !recoveringRemixReferences.current);
        remixResolvedRef.current = resumedRemixRef.current;
        savedRemixEdits.current = persisted.remixEditedKeys ?? {};
      }
      // Typed while there was no identity, by the person this one belongs to
      // (see MediaCreationScreen). With no draft of their own to resume, it
      // stays on screen, and an empty fingerprint has the autosave keep it for them.
      const keepsUnsavedWork = !persisted && hydratedScopeRef.current === null && draftScope !== null
        && JSON.stringify(latestDrafts.current) !== lastSavedFingerprint.current;
      hydratedScopeRef.current = draftScope;
      recordCreatorSession({
        tool: initialTool,
        outcome: persisted ? 'resumed' : 'new',
        referenceCount: countDraftMedia(persisted ? persisted[initialTool] : latestDrafts.current[initialTool]),
        catalogRevision: null,
        draftFormat: CREATION_DRAFT_FORMAT,
      });
      lastSavedFingerprint.current = keepsUnsavedWork
        ? ''
        : JSON.stringify(persisted ? { image: persisted.image, video: persisted.video, motion: persisted.motion } : latestDrafts.current);
      setDraftsHydrated(true);
    }).catch(() => { if (active) setDraftLoadError(true); });
    return () => { active = false; };
  }, [draftScope, initialPrompt, draftLoadAttempt]);

  const saveLatestDraft = async () => {
    // Without a scope nothing is saved, and the fingerprint stays as it was so
    // the work still reads as unsaved when an identity arrives.
    if (!draftsHydrated || !draftScope) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = null;
    // If a keystroke lands during a slow write, flush that newer snapshot too.
    let saved: typeof latestDrafts.current;
    do {
      saved = latestDrafts.current;
      const fingerprint = JSON.stringify(saved);
      if (fingerprint === lastSavedFingerprint.current) return;
      const remixEditedKeys = Object.fromEntries((['image', 'video', 'motion'] as const).map((tool) => {
        // Compare with the baseline as the catalog leaves it, so the screen's own
        // normalization is never saved as something the creator changed.
        const baseline = catalog
          ? normalizeCreationDraftForCatalog(remixBaseline.current[tool], catalog, {
              modelSelectionTouched: false,
              starter: guidedCreationStarter(tool, { guided: guidedScreen, initialTool }, catalogQuery.missingIds),
              missingIds: catalogQuery.missingIds,
              seededModelIds: guidedCreationStarters(tool, { guided: guidedScreen, initialTool }).map((starter) => starter.modelId),
            }).draft
          : remixBaseline.current[tool];
        return [tool, Object.keys(saved[tool]).filter((key) => JSON.stringify((saved[tool] as unknown as Record<string, unknown>)[key]) !== JSON.stringify((baseline as unknown as Record<string, unknown>)[key]))];
      }));
      await draftWriter.save({ ...saved, remixRestored: remixResolvedRef.current, remixEditedKeys });
      lastSavedFingerprint.current = fingerprint;
    } while (saved.image !== latestDrafts.current.image || saved.video !== latestDrafts.current.video || saved.motion !== latestDrafts.current.motion);
  };
  const saveLatestDraftRef = useRef(saveLatestDraft);
  useEffect(() => { saveLatestDraftRef.current = saveLatestDraft; });

  useEffect(() => {
    if (!draftsHydrated || isRestoringRemix || closingRef.current) return;
    // Sticky: from the first edit onward this session's exit has something to
    // save, and the route keeps the native pop gesture off until it closes.
    if (!dirty && JSON.stringify({ image: imageDraft, video: videoDraft, motion: motionDraft }) !== lastSavedFingerprint.current) {
      setDirty(true);
    }
    autosaveTimer.current = setTimeout(() => {
      void saveLatestDraftRef.current().then(() => setDraftSaveError(null), () => setDraftSaveError('Your latest changes could not be saved. Retry before closing.'));
    }, 350);
    return () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); };
  }, [dirty, draftsHydrated, imageDraft, motionDraft, videoDraft, isRestoringRemix]);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!draftsHydrated) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        void saveLatestDraftRef.current().catch(() => setDraftSaveError('Your latest changes could not be saved. Retry before closing.'));
      }
    });
    return () => subscription.remove();
  }, [draftsHydrated]);

  const prepareClose = async (): Promise<boolean> => {
    if (closingRef.current) return false;
    closingRef.current = true;
    setIsClosing(true);
    try {
      if (draftsHydrated) await saveLatestDraft();
      return true;
    } catch {
      setDraftSaveError('Your latest changes could not be saved. Retry before closing.');
      const discard = await showConfirmDialog({
        title: 'Could not save your draft',
        message: 'Stay to retry, or close without saving the latest changes.',
        cancelLabel: 'Keep editing', confirmLabel: 'Close without saving', destructive: true,
      });
      return discard;
    } finally {
      closingRef.current = false;
      setIsClosing(false);
    }
  };

  const closeGuardRef = useRef(prepareClose);
  useEffect(() => { closeGuardRef.current = prepareClose; });
  useEffect(() => {
    registerBeforeClose?.(() => closeGuardRef.current());
    return () => registerBeforeClose?.(null);
  }, [registerBeforeClose]);
  const closeCreator = async () => {
    if (registerBeforeClose) onClose?.(); // The route guard also covers native gestures.
    else if (await prepareClose()) onClose?.();
  };

  useEffect(() => {
    if (!catalog) return;
    const reconcile = <T extends CreationDraft>(
      kind: CreatorToolId,
      setter: (updater: (draft: T) => T) => void
    ) => {
      setter((draft) => {
        const result = normalizeCreationDraftForCatalog(draft, catalog, {
          modelSelectionTouched: modelSelectionTouched.current[kind],
          starter: guidedCreationStarter(kind, { guided: guidedScreen, initialTool }, catalogQuery.missingIds),
          missingIds: catalogQuery.missingIds,
          seededModelIds: guidedCreationStarters(kind, { guided: guidedScreen, initialTool }).map((starter) => starter.modelId),
        });
        if (result.missingModel) {
          if (catalogQuery.missingIds.includes(draft.model)) setCatalogNotice('This model is no longer available. Your draft is saved; choose another model.');
          return draft;
        }
        if (result.warning) setCatalogNotice(result.warning);
        return result.draft as T;
      });
    };
    reconcile<ImageCreationDraft>('image', setImageDraft);
    reconcile<VideoCreationDraft>('video', setVideoDraft);
    reconcile<MotionCreationDraft>('motion', setMotionDraft);
  }, [catalog, catalogQuery.missingIds, guidedScreen, initialTool]);

  const rawDraft: CreationDraft = activeTool === 'image' ? imageDraft : activeTool === 'video' ? videoDraft : motionDraft;
  const currentCatalogModel = useMemo(
    () => catalog ? getCatalogModel(catalog, rawDraft.model) : null,
    [catalog, rawDraft.model]
  );
  // Nothing selects a reference mode any more — every slot a model declares is on screen
  // at once — so the field is derived before anything reads it, from what the model can
  // carry of what is attached: a reference kept from another model must not turn a frames
  // run into a references run, which would leave its frames out without saying so.
  const currentDraft: CreationDraft = rawDraft.tool === 'video'
    ? { ...rawDraft, referenceMode: videoRunReferenceMode(rawDraft, currentCatalogModel) }
    : rawDraft;
  // A motion quote needs both inputs: asked without them, the server refuses it, and that
  // refusal read as an error on every first visit.
  const motionInputsMissing = currentDraft.tool === 'motion' && (!currentDraft.characterImage || !currentDraft.referenceVideo);
  const quoteRequest = useMemo(
    () => currentCatalogModel && catalog && !motionInputsMissing
      ? buildCatalogQuoteRequest(currentDraft, currentCatalogModel, catalog.revision)
      : null,
    [catalog, currentCatalogModel, currentDraft, motionInputsMissing]
  );
  const quoteKey = quoteRequest ? JSON.stringify(quoteRequest) : null;
  // Only the price is kept from a quote. The run is built from the draft as this request was
  // (buildUnifiedCatalogGenerationRequest), and the server normalizes and prices it again.
  const [quoteState, setQuoteState] = useState<{
    key: string | null;
    /** The asking this answers (`quoteAsking.attempt`); an answer to an earlier one is no answer yet. */
    attempt: number;
    status: 'idle' | 'pending' | 'ready' | 'error';
    cost: number | null;
    error: string | null;
  }>({ key: null, attempt: 0, status: 'idle', cost: null, error: null });
  // Each asking of the price, by Retry quote or after a refusal, and the run the start last refused
  // at its price. One state, so a refusal and the asking again it brings arrive in one render: a
  // ready quote read against the refusal is always the new answer, never the one refused.
  const [quoteAsking, setQuoteAsking] = useState<{ attempt: number; refused: RefusedRunPrice | null }>({ attempt: 0, refused: null });

  const quoteAttempt = quoteAsking.attempt;
  useEffect(() => {
    const attempt = quoteAttempt;
    if (!quoteRequest || !quoteKey) {
      setQuoteState({ key: null, attempt, status: 'idle', cost: null, error: null });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api.quoteGenerationModel(quoteRequest, controller.signal)
        .then((quote) => {
          if (controller.signal.aborted) return;
          setQuoteState({
            key: quoteKey,
            attempt,
            status: 'ready',
            cost: quote.costCredits,
            error: null,
          });
          // A price in for the run the start refused: moved, and the refusal is forgotten, as the
          // web creators forget it; unmoved, it stands (`catalogAppOutOfDateForRun`).
          setQuoteAsking((current) => (
            current.refused && current.refused.key === quoteKey && current.refused.costCredits !== quote.costCredits
              ? { ...current, refused: null }
              : current
          ));
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          const details = error && typeof error === 'object' && 'details' in error
            ? (error as { details?: { code?: string } }).details
            : null;
          if (details?.code === 'CATALOG_CHANGED' || details?.code === 'MODEL_UNAVAILABLE') {
            void refetchCatalog();
            setMessage('Model settings changed. Review the refreshed options before generating.');
          }
          // A 422 carries the specific rule that failed in `fieldErrors` ("Add a start
          // frame to use an end frame with this model."); the top-level message is the
          // generic "settings are no longer available", which the web surface already
          // looks past. Prefer the field message so the user learns what to change.
          const fieldErrors = details && typeof details === 'object' && 'fieldErrors' in details
            ? (details as { fieldErrors?: Record<string, unknown> }).fieldErrors
            : undefined;
          const fieldMessage = fieldErrors
            ? Object.values(fieldErrors).find((value): value is string => typeof value === 'string' && value.trim().length > 0)
            : undefined;
          setQuoteState({
            key: quoteKey,
            attempt,
            status: 'error',
            cost: null,
            error: fieldMessage ?? (error instanceof Error ? error.message : 'Could not calculate generation cost.'),
          });
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, quoteKey, quoteAttempt, refetchCatalog]);

  // The answer to this run's open asking. Anything else in hand (another run's, or this run's from
  // before a refusal or Retry quote asked again) is no answer yet, so the price reads as pending
  // until the asking answers. Derived here, never set in the effect: a refusal and the asking it
  // brings land in one render, and the answer the run was refused at is never read against it.
  const activeQuote = quoteState.key === quoteKey && quoteState.attempt === quoteAttempt
    ? quoteState
    : { status: 'pending' as const, cost: null, error: null };
  // The start refused this very run at its price, and asked again, its price is that price: the
  // app prices it as the server no longer does, so the run is held and the app says why.
  const appOutOfDate = catalogAppOutOfDateForRun(quoteAsking.refused, { key: quoteKey, status: activeQuote.status, cost: activeQuote.cost });
  const catalogUnavailable = Boolean(
    catalogQuery.isUnavailable ?? (!catalog && catalogQuery.error),
  );
  const creatorQuoteStatus = catalogUnavailable ? 'error' as const : activeQuote.status;
  const creatorRetryLabel = catalogUnavailable ? 'Retry settings' : 'Retry quote';
  const retryCreatorQuote = () => {
    if (catalogUnavailable) {
      void refetchCatalog();
      return;
    }
    setQuoteAsking((current) => ({ ...current, attempt: current.attempt + 1 }));
  };
  // A swept upload the run sends cannot be sent, so the run waits until it is removed or replaced.
  const unavailableReference = unavailableRunInputMessage(currentDraft, currentCatalogModel, unavailableReferencePaths);
  const validation = useMemo(() => {
    const result = currentCatalogModel
      ? validateCatalogCreationDraft(currentDraft, currentCatalogModel, { credits, quotedCost: activeQuote.cost })
      : catalog
        ? {
            errors: [catalogQuery.missingIds.includes(currentDraft.model) ? 'This model is no longer available. Choose another model.' : catalogQuery.error ? 'Model settings unavailable. Retry before generating.' : 'Loading model settings…'],
            warnings: [],
            cost: 0,
            canGenerate: false,
          }
        : {
            errors: catalogUnavailable ? ['Model settings unavailable. Retry before generating.'] : [],
            warnings: [],
            cost: 0,
            canGenerate: false,
          };
    return unavailableReference
      ? { ...result, errors: [unavailableReference, ...result.errors], canGenerate: false }
      : result;
  }, [activeQuote.cost, catalog, catalogUnavailable, currentCatalogModel, currentDraft, credits, unavailableReference]);
  const outputUrl = useMemo(() => (status ? getGenerationOutput(status) : null), [status]);
  // Every output, the primary first: a run can return several (Grok Imagine's options).
  const outputUrls = useMemo(() => (status ? getGenerationOutputs(status) : []), [status]);
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const isCompact = width < 380;
  const meta = TOOL_META[activeTool];
  // Both branches must clear the status bar: the tab navigator does not apply a
  // top inset for us, so a flat pad here renders the header under the system
  // clock and battery — where it also can't be tapped. Content still scrolls
  // beneath the opaque status-bar scrim below, which is what keeps that band
  // readable.
  const contentTopPadding = topInset + (insideTab ? 10 : 8);
  // A model still loading its details (a pick from the What's new strip, which leaves Generate in view)
  // is not in the draft yet: a run started now would go to the model before it.
  const modelPickLoading = Boolean(modelPick && !modelPick.error);
  const generateDisabled = !draftsHydrated || isRestoringRemix || remixRestoreFailed || isClosing || isGenerating || pollingInterrupted || isUploading || modelPickLoading || !catalog || activeQuote.status !== 'ready' || appOutOfDate || validation.errors.length > 0;
  const openAuthForCurrentDraft = () => {
    router.push({
      pathname: '/auth',
      params: {
        // The route's own tool, not the one switched to: the tool, remix and prompt are what the
        // route was opened with, and only those find this screen again.
        returnTo: creatorReturnPath({ insideTab, tool: initialTool, guided, initialPrompt, remixSource }),
      },
    } as never);
  };

  /** Answers whether the screen is now on `tool`: a run still going keeps its own, and says why. */
  const changeTool = (tool: CreatorToolId) => {
    if (isGenerating || pollingInterrupted) {
      setMessage('This generation is still running. You can switch tools when it finishes or leave and follow it in Alerts.');
      setWorkspaceVisible(true);
      return false;
    }
    if (tool !== activeTool) {
      // A pick still loading (the What's new strip's) stays with the tool it was made in: its retry in
      // the picker would otherwise give another tool's model to this tool's draft.
      modelPickRef.current = null;
      setModelPick(null);
    }
    setActiveTool(tool);
    setAdvancedExpanded(false);
    setGuidedReferencesExpanded(false);
    setMessage(null);
    setPromptMessage(null);
    setIsPromptFocused(false);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
    return true;
  };

  /**
   * Puts a changed draft on screen, normalized for its model. Without that model's descriptor
   * the draft goes on as it is and the catalog reconcile normalizes it once the details are in,
   * rather than through the bundled ladder, which reads a model it does not know as Kling 3.0
   * and cuts its references to fit. A model pick loads the descriptor first (pickModel).
   */
  const replaceDraft = (draft: CreationDraft, source: GenerationModelCatalog | null = catalog) => {
    const catalogModel = source ? getCatalogModel(source, draft.model) : null;
    const normalized = catalogModel
      ? applyCatalogModelDefaults(draft, catalogModel, source?.revision ?? null)
      : draft;
    if (normalized.tool === 'image') {
      setImageDraft((current) => {
        if (current.model !== normalized.model) modelSelectionTouched.current.image = true;
        return normalized;
      });
    }
    if (normalized.tool === 'video') {
      setVideoDraft((current) => {
        if (current.model !== normalized.model) modelSelectionTouched.current.video = true;
        return normalized;
      });
    }
    if (normalized.tool === 'motion') {
      setMotionDraft((current) => {
        if (current.model !== normalized.model) modelSelectionTouched.current.motion = true;
        return normalized;
      });
    }
  };

  const normalizeCatalogDraft = <T extends CreationDraft>(draft: T): T => {
    const model = catalog ? getCatalogModel(catalog, draft.model) : null;
    return (model ? applyCatalogModelDefaults(draft, model, catalog?.revision ?? null) : draft) as T;
  };

  /**
   * A model chosen in a picker. The picker lists every model, but the catalog holds details
   * only for the drafts' models and the defaults, so a first pick waits for its model's
   * descriptor, with the picker's row turning, and the draft changes only once it is in.
   */
  const pickModel = async (tool: CreatorToolId, modelId: string) => {
    const withModel = () => ({ ...latestDrafts.current[tool], model: modelId }) as CreationDraft;
    if (catalog && getCatalogModel(catalog, modelId)) {
      replaceDraft(withModel());
      setModelPickerVisible(false);
      return;
    }
    modelPickRef.current = modelId;
    setModelPick({ modelId, error: null });
    try {
      const loaded = await loadCatalogDetails([modelId]);
      if (modelPickRef.current !== modelId) return;
      if (!getCatalogModel(loaded, modelId)) throw new Error('This model is no longer available. Choose another model.');
      replaceDraft(withModel(), loaded);
      setModelPick(null);
      setModelPickerVisible(false);
    } catch (error) {
      if (modelPickRef.current !== modelId) return;
      setModelPick({ modelId, error: error instanceof Error ? error.message : 'Could not load model settings.' });
    } finally {
      if (modelPickRef.current === modelId) modelPickRef.current = null;
    }
  };
  // Closing the picker drops a pick still loading: the choice is the picker's, made while it is open.
  const closeModelPicker = () => {
    modelPickRef.current = null;
    setModelPick(null);
    setModelPickerVisible(false);
  };
  /**
   * A model tapped in the What's new strip: its tool, as the tool switcher opens one, then the picker's
   * own pick. A model whose details are in lands at once. One whose details still have to load turns on
   * its chip until it lands, or says under the strip why it could not. The picker stays shut: the newest
   * models end their kind's list, so it would open on rows above the one it waits for, then shut itself.
   */
  const pickWhatsNewModel = (model: ModelCatalogSummary) => {
    if (model.kind !== activeTool && !changeTool(model.kind)) return;
    void pickModel(model.kind, model.id);
  };

  useEffect(() => {
    const generationId = remixSource?.generationId?.trim();
    if (!generationId || !catalog || !draftsHydrated || resumedRemixRef.current || remixHydrationKeyRef.current === generationId) return;
    // No identity to read the source as: the guest bootstrap failed, or the
    // session is not back yet. Signing in is then the way to get one.
    if (!identityUserId) {
      setRemixRestoreWarning(REMIX_RESTORE_SIGN_IN_MESSAGE);
      return;
    }

    const targetTool = isTool(initialTool) ? initialTool : 'image';
    let isCancelled = false;
    setRemixRestoreWarning(null);
    setRemixRestoreFailed(false);
    setMessage(null);
    setPromptMessage(null);
    remixHydrationKeyRef.current = generationId;
    setIsRestoringRemix(true);
    remixResolvedRef.current = false;
    const promptWhenRemixStarted = draftPromptsRef.current[targetTool];
    // Taken as this catalog leaves the draft. The reconcile effect above normalizes the same
    // draft in this commit, but its update has not rendered yet; the raw draft would make the
    // catalog's own defaults read as edits made while the source loaded, spread over the restore.
    // A remix takes no guided starter (guidedScreen), so its baseline needs none either.
    const draftWhenRemixStarted = normalizeCreationDraftForCatalog(
      latestDrafts.current[targetTool],
      catalog,
      { modelSelectionTouched: modelSelectionTouched.current[targetTool] },
    ).draft;

    void api.getRemixSourceBundle(generationId, { postId: remixSource?.postId ?? null })
      .then(async (bundle) => {
        const modelId = typeof bundle.workflowSettings.model === 'string' ? bundle.workflowSettings.model : bundle.generation.model;
        const restoredCatalog = await loadCatalogDetails([modelId]);
        if (isCancelled) return;
        const baseDraft = targetTool === 'image'
          ? createDefaultCreationDraft('image')
          : targetTool === 'video'
            ? createDefaultCreationDraft('video')
            : createDefaultCreationDraft('motion');
        const restored = hydrateCatalogCreationDraftFromRemixSource(baseDraft, bundle, restoredCatalog);
        const creatorPrompt = draftPromptsRef.current[targetTool];
        const prompt = hasCreatorEditedPromptDuringRemix(creatorPrompt, promptWhenRemixStarted)
          ? creatorPrompt
          : restored.draft.prompt;
        // Preserve every field edited during restoration, including model and references.
        const current = latestDrafts.current[targetTool];
        const edits = Object.fromEntries(Object.entries(current).filter(([key, value]) => (
          savedRemixEdits.current[targetTool]?.includes(key)
          || JSON.stringify(value) !== JSON.stringify((draftWhenRemixStarted as unknown as Record<string, unknown>)[key])
        )));
        const restoredPrompt = savedRemixEdits.current[targetTool]?.includes('prompt') ? current.prompt : prompt;
        // A model chosen while loading keeps its compatible settings as a unit.
        const merged = recoveringRemixReferences.current
          ? recoverRemixReferences(current, restored.draft)
          : 'model' in edits
          ? { ...current, sourceGenerationId: restored.draft.sourceGenerationId }
          : { ...restored.draft, ...edits, prompt: restoredPrompt };
        remixBaseline.current = { ...remixBaseline.current, [targetTool]: restored.draft };
        lastSavedFingerprint.current = JSON.stringify(remixBaseline.current);
        if (restored.draft.tool === 'image') setImageDraft(merged as ImageCreationDraft);
        if (restored.draft.tool === 'video') setVideoDraft(merged as VideoCreationDraft);
        if (restored.draft.tool === 'motion') setMotionDraft(merged as MotionCreationDraft);
        recordCreatorSession({
          tool: targetTool,
          outcome: recoveringRemixReferences.current ? 'recovered' : 'restored',
          referenceCount: countDraftMedia(merged as CreationDraft),
          catalogRevision: restoredCatalog.revision,
          draftFormat: CREATION_DRAFT_FORMAT,
        });
        remixResolvedRef.current = true;
        setRemixRestoreWarning(restored.warning);
      })
      .catch((error) => {
        if (isCancelled) return;
        remixHydrationKeyRef.current = null;
        // Another creator's source, read as a guest: the server keeps it for
        // accounts. Not a failed restore, so Generate stays free for what the
        // editor holds, as it always was for a guest.
        if (isRegistrationRequiredError(error)) {
          setRemixRestoreWarning(REMIX_RESTORE_SIGN_IN_MESSAGE);
          return;
        }
        recordCreatorSession({
          tool: targetTool,
          outcome: 'restore_failed',
          referenceCount: countDraftMedia(latestDrafts.current[targetTool]),
          catalogRevision: catalog?.revision ?? null,
          draftFormat: CREATION_DRAFT_FORMAT,
        });
        setRemixRestoreFailed(true);
        setRemixRestoreWarning(error instanceof Error ? error.message : REMIX_RESTORE_WARNING_MESSAGE);
      })
      .finally(() => {
        if (isCancelled) return;
        setIsRestoringRemix(false);
      });

    return () => {
      isCancelled = true;
      // Catalog/auth refresh can cancel an in-flight restore. Let the next
      // effect retry instead of leaving the editor permanently "restoring".
      if (!remixResolvedRef.current && remixHydrationKeyRef.current === generationId) {
        remixHydrationKeyRef.current = null;
      }
      // A cancelled run never reaches its `finally`, so it hands the busy state
      // back here. The next run sets it again in this same commit when it does
      // restore. When it returns early instead (the saved draft was read again
      // and is one to resume) nothing else would ever clear it. Unlike the key
      // above, this does not look at `remixResolvedRef`: on a device the draft
      // is back, and marked resolved, before this cleanup runs.
      setIsRestoringRemix(false);
    };
  }, [api, catalog, loadCatalogDetails, draftsHydrated, initialTool, remixSource?.generationId, remixSource?.postId, remixRetry, identityUserId]);

  const updatePrompt = (prompt: string) => {
    if (activeTool === 'image') setImageDraft((draft) => ({ ...draft, prompt }));
    if (activeTool === 'video') setVideoDraft((draft) => ({ ...draft, prompt }));
    if (activeTool === 'motion') setMotionDraft((draft) => ({ ...draft, prompt }));
    if (promptMessage) setPromptMessage(null);
  };

  useEffect(() => {
    draftPromptsRef.current = {
      image: imageDraft.prompt,
      video: videoDraft.prompt,
      motion: motionDraft.prompt,
    };
  }, [imageDraft.prompt, videoDraft.prompt, motionDraft.prompt]);

  const rememberLocalPreviews = (uploads: ReadonlyArray<{ item: PickedUpload; result: UploadedMedia }>) => {
    const previews = uploads.filter(({ item }) => item.kind !== 'audio');
    if (previews.length === 0) return;
    setLocalPreviews((current) => new Map([...current, ...previews.map(({ item, result }) => [result.storagePath, item.uri] as const)]));
  };

  /**
   * Uploads picked files two pictures (or one clip) at a time, keeping every one that arrives: the
   * loop this replaced sent one file at a time and dropped them all when one failed. The tile that
   * started it shows how far the bytes have got, and a clip can be stopped.
   */
  const uploadPicks = async (target: UploadTarget, picks: PickedUpload[]): Promise<WeightedUploadQueueResult<PickedUpload, UploadedMedia>> => {
    const controller = new AbortController();
    uploadControllerRef.current = controller;
    const sentBytes = picks.map(() => 0);
    const totalBytes = picks.map((pick) => (pick.sizeBytes && pick.sizeBytes > 0 ? pick.sizeBytes : 0));
    const cancellable = picks.some((pick) => pick.kind === 'video');
    const report = () => {
      const total = totalBytes.reduce((sum, bytes) => sum + bytes, 0);
      const sent = sentBytes.reduce((sum, bytes) => sum + bytes, 0);
      const percent = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : null;
      // A render per whole percent, not per progress event.
      setUpload((current) => (current && current.target === target && current.percent === percent ? current : { target, percent, cancellable }));
    };
    report();
    try {
      const result = await runWeightedUploadQueue(
        picks.map((pick) => ({ item: pick, kind: pick.kind === 'video' ? 'video' as const : 'image' as const })),
        async (pick, index) => {
          const media = await uploadPickedMedia(pick.uri, {
            api,
            fileName: pick.fileName,
            mimeType: pick.mimeType,
            kind: pick.kind,
            durationSeconds: pick.durationSeconds ?? null,
            sizeBytes: pick.sizeBytes ?? null,
            signal: controller.signal,
            onProgress: (progress) => {
              sentBytes[index] = progress.bytesSent;
              totalBytes[index] = progress.totalBytes;
              report();
            },
          });
          sentBytes[index] = totalBytes[index];
          report();
          return media;
        },
        { signal: controller.signal },
      );
      rememberLocalPreviews(result.successes);
      return result;
    } finally {
      if (uploadControllerRef.current === controller) {
        uploadControllerRef.current = null;
        setUpload(null);
      }
    }
  };
  const cancelUpload = () => uploadControllerRef.current?.abort();

  const uploadImageReferences = async (tool: 'image' | 'video') => {
    setMessage(null);
    setPromptMessage(null);
    const selectedDraft = tool === 'image' ? imageDraft : videoDraft;
    const selectedModel = catalog ? getCatalogModel(catalog, selectedDraft.model) : null;
    const maxImages = catalogInputLimit(
      selectedModel,
      selectedDraft,
      'imageReferences',
      selectedModel?.inputs.imageReferences?.max ?? 0,
      tool === 'video' ? referenceRailShape(videoDraft, selectedModel) : 'elements',
    );
    const remainingSlots = Math.max(0, maxImages - selectedDraft.references.length);
    if (remainingSlots === 0) {
      setMessage(maxImages > 0 ? `This model supports up to ${maxImages} reference images.` : 'This model does not support image references.');
      return;
    }
    setIsUploading(true);
    try {
      const picked = await pickMediaList('image', { allowsMultipleSelection: true });
      if (picked.length === 0) return;
      const result = await uploadPicks('image-references', picked.slice(0, remainingSlots).map((asset) => ({
        uri: asset.uri,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        kind: 'image' as const,
        sizeBytes: asset.fileSize ?? null,
      })));
      const uploaded = result.successes.map(({ result: media }) => createMediaDraftFromUpload(media));
      setMessage(uploadFailureMessage(result.failures, uploaded.length) ?? (picked.length > remainingSlots
        ? `Added ${remainingSlots} reference${remainingSlots === 1 ? '' : 's'} to stay within this model's ${maxImages}-image limit.`
        : null));
      if (uploaded.length === 0) return;
      // Named after their files (or by their place, where a file name says nothing), so the same
      // photo picked twice, or two files named alike, would otherwise answer to one @mention.
      const withHandles = (references: MediaDraft[], others: MediaDraft[] = []) => nameUnnamedReferences(uploaded, references, others).reduce<MediaDraft[]>(
        (added, media) => [...added, withUniqueReferenceHandle(media, [...references, ...others, ...added])],
        [],
      );
      if (tool === 'image') {
        setImageDraft((draft) => normalizeCatalogDraft({ ...draft, references: [...draft.references, ...withHandles(draft.references)] }));
      } else {
        setVideoDraft((draft) => normalizeCatalogDraft({
          ...draft,
          references: [...draft.references, ...withHandles(draft.references, [...draft.referenceVideos, ...videoSubjects(draft).map(subjectAsReference)])],
          referenceMode: 'elements',
        }));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  // Replaces one image reference's media in place, keeping its name and
  // @handle so prompt mentions stay valid — the alternative was remove,
  // re-pick, re-name, and re-mention.
  const storeSeedanceAsset = (mediaId: string, asset: SeedanceAssetMetadata) => {
    setVideoDraft((draft) => replaceDraftMediaSeedanceAsset(draft, mediaId, asset));
  };
  const scheduleSeedanceAssetCheck = (mediaId: string, assetId: string, assetType: SeedanceAssetKind, sourceUrl: string, attempt: number) => {
    const timers = seedanceAssetTimers.current;
    const pending = timers.get(mediaId);
    if (pending) clearTimeout(pending);
    if (attempt >= SEEDANCE_ASSET_CHECK_LIMIT) return;
    timers.set(mediaId, setTimeout(() => {
      timers.delete(mediaId);
      void checkSeedanceAsset(mediaId, assetId, assetType, sourceUrl, attempt + 1);
    }, SEEDANCE_ASSET_CHECK_MS));
  };
  const checkSeedanceAsset = async (mediaId: string, assetId: string, assetType: SeedanceAssetKind, sourceUrl: string, attempt = 0) => {
    try {
      const asset = seedanceAssetFromResponse(await api.getSeedanceAsset(assetId), assetType, sourceUrl);
      storeSeedanceAsset(mediaId, asset);
      if (asset.status === 'processing') scheduleSeedanceAssetCheck(mediaId, assetId, assetType, sourceUrl, attempt);
    } catch (error) {
      // A read that fails leaves the asset as it was; the sheet's button asks again.
      setReferenceNotice(error instanceof Error ? error.message : 'Could not check the Seedance asset.');
    }
  };
  const videoReferenceById = (mediaId: string) => [...videoDraft.references, ...videoDraft.referenceVideos, ...videoDraft.referenceAudios]
    .find((media) => media.id === mediaId) ?? null;
  const prepareSeedanceAsset = async (mediaId: string) => {
    const media = videoReferenceById(mediaId);
    if (!media) return;
    // Preparing hands the file to the AI service, as a run does, so it waits for the
    // same permission; a refusal leaves the reference unprepared and the button free.
    if (!(await ensureAiDataConsent())) return;
    const assetType = seedanceAssetKindOf(media);
    setPreparingAssetId(mediaId);
    try {
      // The storage path when the file is the creator's own upload or creation; the
      // server resolves it and refuses media that is not theirs, as it does on the web.
      const asset = seedanceAssetFromResponse(await api.createSeedanceAsset({ url: media.storagePath ?? media.url, assetType }), assetType, media.url);
      storeSeedanceAsset(mediaId, asset);
      if (asset.status === 'processing' && asset.assetId) scheduleSeedanceAssetCheck(mediaId, asset.assetId, assetType, media.url, 0);
    } catch (error) {
      storeSeedanceAsset(mediaId, createSeedanceAssetMetadata({
        ...media.seedanceAsset,
        assetType,
        status: 'failed',
        sourceUrl: media.url,
        error: error instanceof Error ? error.message : 'Seedance asset request failed',
        lastCheckedAt: new Date().toISOString(),
      }));
    } finally {
      setPreparingAssetId(null);
    }
  };
  const refreshSeedanceAsset = async (mediaId: string) => {
    const media = videoReferenceById(mediaId);
    const assetId = media?.seedanceAsset?.assetId;
    if (!media || !assetId) return;
    setPreparingAssetId(mediaId);
    try {
      await checkSeedanceAsset(mediaId, assetId, seedanceAssetKindOf(media), media.url, SEEDANCE_ASSET_CHECK_LIMIT);
    } finally {
      setPreparingAssetId(null);
    }
  };

  const replaceImageReference = async (tool: 'image' | 'video', id: string) => {
    setMessage(null);
    setPromptMessage(null);
    setReplacingReferenceId(id);
    try {
      const picked = await pickMedia('image');
      if (!picked) return;
      const uploaded = await uploadPickedMedia(picked.uri, {
        api,
        fileName: picked.fileName,
        mimeType: picked.mimeType,
        kind: 'image',
        sizeBytes: picked.fileSize ?? null,
      });
      rememberLocalPreviews([{ item: { uri: picked.uri, kind: 'image' }, result: uploaded }]);
      if (tool === 'image') {
        setImageDraft((draft) => ({ ...draft, references: replaceMediaInList(draft.references, id, uploaded) }));
      } else {
        setVideoDraft((draft) => ({ ...draft, references: replaceMediaInList(draft.references, id, uploaded) }));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Upload failed.');
    } finally {
      setReplacingReferenceId(null);
    }
  };

  const uploadSingleImage = async (role: 'start' | 'end' | 'character') => {
    setMessage(null);
    setPromptMessage(null);
    setIsUploading(true);
    try {
      const picked = await pickMedia('image');
      if (!picked) return;
      const result = await uploadPicks(role === 'start' ? 'start-frame' : role === 'end' ? 'end-frame' : 'character', [{
        uri: picked.uri,
        fileName: picked.fileName,
        mimeType: picked.mimeType,
        kind: 'image',
        sizeBytes: picked.fileSize ?? null,
      }]);
      const uploaded = result.successes[0]?.result;
      if (!uploaded) {
        setMessage(uploadFailureMessage(result.failures, 0));
        return;
      }
      const draft = createMediaDraftFromUpload(uploaded, {
        displayName: role === 'start' ? 'Start Frame' : role === 'end' ? 'End Frame' : 'Character Image',
      });
      if (role === 'character') {
        setMotionDraft((current) => ({ ...current, characterImage: draft }));
      } else {
        setVideoDraft((current) => ({
          ...current,
          referenceMode: current.model === 'wan-2.7' && current.referenceMode === 'elements' && role === 'start' ? 'elements' : 'frames',
          [role === 'start' ? 'startFrame' : 'endFrame']: draft,
        }));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  const uploadReferenceVideo = async (target: 'video' | 'motion') => {
    setMessage(null);
    setPromptMessage(null);
    const selectedDraft = target === 'video' ? videoDraft : motionDraft;
    const selectedModel = catalog ? getCatalogModel(catalog, selectedDraft.model) : null;
    const currentCount = target === 'video' ? videoDraft.referenceVideos.length : motionDraft.referenceVideo ? 1 : 0;
    const clipSlot = target === 'video' && selectedModel?.inputModes ? referenceVideoSlot(selectedModel, videoDraft, referenceRailShape(videoDraft, selectedModel)) : null;
    // The slot the composer draws a motion run's clip in, whatever the model calls it.
    const motionClipSlotKey = catalogMotionDraftSlotKeys(motionDraft, selectedModel).video;
    const maxVideos = target === 'video'
      ? selectedModel?.inputModes ? clipSlot?.max ?? 0 : selectedModel?.inputs.videoReferences?.max ?? 0
      : catalogInputLimit(selectedModel, selectedDraft, motionClipSlotKey, 1, 'elements');
    // Named clips are mentioned in the prompt, so each needs a handle of its own.
    const namesClips = clipSlot ? Boolean(clipSlot.supportsNaming) : videoDraft.model === 'kling-3.0-video';
    // A motion run takes one clip, so a new pick takes the place of the one attached, as Replace does.
    const replacesClip = target === 'motion' && maxVideos > 0;
    if (currentCount >= maxVideos && !replacesClip) {
      setMessage(maxVideos > 0
        ? `This model supports up to ${maxVideos} reference video${maxVideos === 1 ? '' : 's'}.`
        : 'This model does not support reference videos.');
      return;
    }
    setIsUploading(true);
    try {
      const picked = await pickMedia('video');
      if (!picked) return;
      if (target === 'motion') {
        const motionSlot = catalogInputSlot(selectedModel, motionDraft, motionClipSlotKey);
        const refusal = motionClipRefusal(picked, motionSlot?.maxDurationSeconds ?? MOTION_CLIP_DEFAULT_MAX_SECONDS);
        if (refusal) {
          setMessage(refusal);
          return;
        }
      }
      const result = await uploadPicks(target === 'motion' ? 'motion-clip' : 'reference-video', [{
        uri: picked.uri,
        fileName: picked.fileName,
        mimeType: picked.mimeType,
        kind: 'video',
        durationSeconds: assetDurationSeconds(picked.duration),
        sizeBytes: picked.fileSize ?? null,
      }]);
      const uploaded = result.successes[0]?.result;
      if (!uploaded) {
        setMessage(uploadFailureMessage(result.failures, 0));
        return;
      }
      const media = createMediaDraftFromUpload(uploaded, {
        displayName: target === 'motion' ? 'Reference Motion' : 'Reference Video',
      });
      if (target === 'motion') {
        setMotionDraft((draft) => ({
          ...draft,
          // Replaced in place, the clip keeps the name it was given.
          referenceVideo: draft.referenceVideo ? replaceMediaDraftMedia(draft.referenceVideo, uploaded) : media,
          duration: Math.ceil(media.durationSeconds ?? draft.duration),
        }));
      } else {
        setVideoDraft((draft) => {
          const nextMedia = namesClips ? withUniqueReferenceHandle(media, draft.referenceVideos) : media;
          return normalizeCatalogDraft({ ...draft, referenceVideos: [...draft.referenceVideos, nextMedia] });
        });
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  const uploadReferenceAudio = async () => {
    setMessage(null);
    setPromptMessage(null);
    const selectedModel = catalog ? getCatalogModel(catalog, videoDraft.model) : null;
    const maxAudios = catalogInputLimit(
      selectedModel,
      videoDraft,
      'audioReferences',
      selectedModel?.inputs.audioReferences?.max ?? 0,
      referenceRailShape(videoDraft, selectedModel),
    );
    if (videoDraft.referenceAudios.length >= maxAudios) {
      setMessage(maxAudios > 0
        ? `This model supports up to ${maxAudios} audio reference${maxAudios === 1 ? '' : 's'}.`
        : 'This model does not support audio references.');
      return;
    }
    setIsUploading(true);
    try {
      const picked = await pickAudioDocument();
      if (!picked) return;
      const result = await uploadPicks('reference-audio', [{
        uri: picked.uri,
        fileName: picked.name,
        mimeType: picked.mimeType,
        kind: 'audio',
        sizeBytes: picked.size ?? null,
      }]);
      const uploaded = result.successes[0]?.result;
      if (!uploaded) {
        setMessage(uploadFailureMessage(result.failures, 0));
        return;
      }
      const media = createMediaDraftFromUpload(uploaded, { displayName: 'Reference Audio' });
      setVideoDraft((draft) => normalizeCatalogDraft({ ...draft, referenceAudios: [...draft.referenceAudios, media] }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  // A named subject: several pictures of one person or thing, picked together, which
  // the provider fuses into one identity the prompt mentions as @name. Offered where
  // the model's catalog descriptor publishes a subjects slot, as the web creator's
  // editor is, so the two cannot disagree about which models take them.
  const uploadSubject = async () => {
    setMessage(null);
    setPromptMessage(null);
    const selectedModel = catalog ? getCatalogModel(catalog, videoDraft.model) : null;
    const slot = catalogSubjectSlot(selectedModel);
    if (!slot) {
      setMessage('This model does not take named subjects.');
      return;
    }
    const maxNamed = subjectsPerRun(slot);
    if (videoSubjects(videoDraft).length >= maxNamed) {
      setMessage(`This model takes up to ${maxNamed} named subject${maxNamed === 1 ? '' : 's'} per run.`);
      return;
    }
    setIsUploading(true);
    try {
      const picked = await pickMediaList('image', { allowsMultipleSelection: true });
      if (picked.length === 0) return;
      if (picked.length < SUBJECT_IMAGES_PER_NAME.min) {
        setMessage(`Pick ${SUBJECT_IMAGES_PER_NAME.min} to ${SUBJECT_IMAGES_PER_NAME.max} pictures of the same person or thing.`);
        return;
      }
      const result = await uploadPicks('subject', picked.slice(0, SUBJECT_IMAGES_PER_NAME.max).map((asset) => ({
        uri: asset.uri,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        kind: 'image' as const,
        sizeBytes: asset.fileSize ?? null,
      })));
      const uploaded = result.successes.map(({ result: media }) => createMediaDraftFromUpload(media));
      const failure = uploadFailureMessage(result.failures, uploaded.length);
      // The pictures that arrived still make the subject when there are enough of them.
      if (uploaded.length < SUBJECT_IMAGES_PER_NAME.min) {
        setMessage(`${failure ?? ''} A subject is made of ${SUBJECT_IMAGES_PER_NAME.min} to ${SUBJECT_IMAGES_PER_NAME.max} pictures of the same person or thing.`.trim());
        return;
      }
      setMessage(failure ?? (picked.length > SUBJECT_IMAGES_PER_NAME.max
        ? `Kept the first ${SUBJECT_IMAGES_PER_NAME.max} pictures: a subject is made of ${SUBJECT_IMAGES_PER_NAME.min} to ${SUBJECT_IMAGES_PER_NAME.max}.`
        : null));
      setVideoDraft((draft) => {
        const subjects = videoSubjects(draft);
        const name = placeName('Subject', subjects.length + 1, [...draft.references, ...draft.referenceVideos, ...subjects.map(subjectAsReference)]);
        const subject = createSubjectDraft(uploaded, name, videoDraftHandles(draft));
        return normalizeCatalogDraft({ ...draft, subjects: [...subjects, subject] });
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  // A refusal is said under the prompt (or the shot); a failed enhancement is refunded, and the
  // answer carries the balance after the refund.
  const showEnhancementFailure = (error: unknown) => {
    setPromptMessage(error instanceof Error ? error.message : 'Prompt enhancement failed.');
    setMessage(null);
    const details = error && typeof error === 'object' && 'details' in error ? (error as { details?: unknown }).details : null;
    const remainingCredits = details && typeof details === 'object' ? (details as { remainingCredits?: unknown }).remainingCredits : undefined;
    if (typeof remainingCredits === 'number' && Number.isFinite(remainingCredits)) updateCredits(remainingCredits);
    haptic.error();
  };

  const enhancePrompt = async () => {
    if (!currentDraft.prompt.trim()) {
      setPromptMessage('Add a prompt before enhancing.');
      setMessage(null);
      return;
    }
    // Only fires if the guest bootstrap failed outright (offline, or anonymous
    // sign-ins disabled on the project). Signing in is then the one way left to
    // get a backend identity, so the prompt is a fallback rather than a gate.
    if (!identityUserId) {
      openAuthForCurrentDraft();
      return;
    }
    // The enhancer is Google's Gemini: the prompt leaves the phone.
    if (!(await ensureAiDataConsent())) return;
    setMessage(null);
    setPromptMessage(null);
    setEnhanceNotes(null);
    setIsEnhancing(true);
    try {
      const previousPrompt = currentDraft.prompt;
      const result = await api.enhancePrompt(promptEnhancementRequest(currentDraft));
      updatePrompt(result.enhancedPrompt);
      setEnhanceUndo({ previous: previousPrompt, enhanced: result.enhancedPrompt });
      const warnings = enhancementNotes(result);
      if (warnings.length > 0) setEnhanceNotes({ tool: currentDraft.tool, prompt: result.enhancedPrompt, warnings });
      if (typeof result.remainingCredits === 'number') updateCredits(result.remainingCredits);
      haptic.success();
    } catch (error) {
      showEnhancementFailure(error);
    } finally {
      setIsEnhancing(false);
    }
  };

  /**
   * One shot's Enhance in a multi-shot run, as each shot has on the web: that shot's words go to
   * the enhancer, at the same price and with the same permission as the prompt's, and only that
   * shot changes.
   */
  const enhanceShotPrompt = async (shotId: string) => {
    if (currentDraft.tool !== 'video') return;
    const request = buildShotPromptEnhancementRequest(currentDraft, shotId, { level: enhanceLevel, ...videoRunEnhancement(currentDraft) });
    if (!request?.prompt.trim()) return;
    if (!identityUserId) {
      openAuthForCurrentDraft();
      return;
    }
    // The enhancer is Google's Gemini: the shot's words leave the phone.
    if (!(await ensureAiDataConsent())) return;
    setMessage(null);
    setPromptMessage(null);
    setEnhanceNotes(null);
    setIsEnhancing(true);
    try {
      const result = await api.enhancePrompt(request);
      setVideoDraft((draft) => replaceShotPrompt(draft, shotId, result.enhancedPrompt));
      setEnhanceUndo({ previous: request.prompt, enhanced: result.enhancedPrompt, shotId });
      const warnings = enhancementNotes(result);
      if (warnings.length > 0) setEnhanceNotes({ tool: 'video', prompt: result.enhancedPrompt, warnings, shotId });
      if (typeof result.remainingCredits === 'number') updateCredits(result.remainingCredits);
      haptic.success();
    } catch (error) {
      showEnhancementFailure(error);
    } finally {
      setIsEnhancing(false);
    }
  };

  /** A video run's inputs as its model sends them, for its Enhance request; none before the model is in. */
  const videoRunEnhancement = (draft: VideoCreationDraft) => {
    const model = catalog ? getCatalogModel(catalog, draft.model) : null;
    return model ? { videoRun: catalogRunEnhancementInputs(draft, model) } : {};
  };

  /**
   * What the enhancer is asked. An image's request says what the web creator's does: the run's
   * settings, only the references the run sends, and append-only ("Polish") when the prompt names
   * one of them, so a sentence naming a reference is kept as written instead of rewritten. A
   * video's describes what its run sends too: its frames, pictures, clips and named references.
   */
  const promptEnhancementRequest = (draft: CreationDraft): PromptEnhancementRequest => {
    if (draft.tool === 'video') return buildPromptEnhancementRequest(draft, { level: enhanceLevel, ...videoRunEnhancement(draft) });
    if (draft.tool !== 'image') return buildPromptEnhancementRequest(draft, { level: enhanceLevel });
    const model = catalog ? getCatalogModel(catalog, draft.model) : null;
    const request = buildPromptEnhancementRequest({ ...draft, references: imageRunReferences(draft, model) }, { level: enhanceLevel });
    const context = {
      ...request.context,
      modelId: draft.model,
      aspectRatio: draft.aspectRatio,
      resolution: draft.resolution,
      googleSearch: draft.googleSearch,
      ...(imagePromptNamesReference(draft, model) ? { elementEnhancementMode: 'append-only' as const } : {}),
    };
    return { ...request, context };
  };

  const handleUndoEnhance = () => {
    if (enhanceUndo?.shotId !== undefined) {
      const { shotId, previous, enhanced } = enhanceUndo;
      setVideoDraft((draft) => (
        draft.multiPrompts.some((shot) => shot.id === shotId && shot.prompt === enhanced)
          ? replaceShotPrompt(draft, shotId, previous)
          : draft
      ));
    } else if (enhanceUndo && enhanceUndo.enhanced === currentDraft.prompt) {
      updatePrompt(enhanceUndo.previous);
    }
    setEnhanceUndo(null);
  };

  const pollGenerationForTool = (
    tool: CreatorToolId,
    predictionId: string,
    controller: AbortController,
  ) => pollGenerationStatus(
    () => tool === 'image'
      ? api.getImageGeneration(predictionId)
      : tool === 'video'
        ? api.getVideoGeneration(predictionId)
        : api.getMotionGeneration(predictionId),
    { onTick: setStatus, signal: controller.signal, waitUntilReady: waitUntilAppActive, isGuest },
  );

  // Cleared only for the run it names: a start from another creator screen keeps its own.
  const forgetActiveRun = async (identity: string, predictionId: string) => {
    const record = await loadActiveGenerationRecord(identity).catch(() => null);
    if (record?.predictionId === predictionId) await clearActiveGenerationRecord(identity).catch(() => undefined);
  };

  const finishGenerationPolling = async (finalStatus: GenerationStatusResponse, tool: CreatorToolId, predictionId: string) => {
    setStatus(finalStatus);
    setPollingInterrupted(false);
    setLastPredictionId(null);
    // Over either way, so there is nothing left for a creator opened again to resume.
    if (identityUserId) void forgetActiveRun(identityUserId, predictionId);
    if (finalStatus.status === 'failed') {
      setMessage(finalStatus.error?.trim() || 'Generation failed. Your inputs are still here, so you can adjust them and retry.');
      // A failed run's settlement returns what its start held; the balance on screen predates it.
      void refreshProfile().catch(() => undefined);
      const cost = runCostRef.current;
      setRefundNotice(typeof cost === 'number' && cost > 0
        ? cost === 1 ? 'Your 1 credit was returned.' : `Your ${formatCreditCost(cost)} were returned.`
        : null);
      haptic.error();
      return;
    }

    setMessage(null);
    haptic.success();
    // A guest's creation exists only on its identity: the ticket kept from now on carries it
    // onto the account at the next sign-in, even if this guest session ends first (02-7).
    // Nothing is minted when the guest already keeps one.
    if (isGuest) void ensureGuestMergeTicket().catch(() => undefined);
    // Profile → Creations read in the last minute would otherwise go on without the new creation.
    void invalidateProfileCreations(queryClient, identityUserId).catch(() => undefined);
    // A remix link reopens its session until a run in it succeeds. The ordinary drafts stay
    // saved, as on the web, so what is on screen is still what is stored.
    if (remixScope) void clearPersistedCreationDrafts(remixScope).catch(() => undefined);
    if (guided) void trackOnboardingEvent(api, 'first_generation_succeeded', { goal: tool, step: 'creator' });
  };

  const resumeGenerationPolling = async (run: { tool: CreatorToolId; predictionId: string } | null = (
    lastPredictionId && generationTool ? { tool: generationTool, predictionId: lastPredictionId } : null
  )) => {
    if (!run || isGenerating || activeGenerationRequestKeyRef.current) return;
    const requestKey = `poll:${run.tool}:${run.predictionId}`;
    activeGenerationRequestKeyRef.current = requestKey;
    generationPollControllerRef.current?.abort();
    const pollController = new AbortController();
    generationPollControllerRef.current = pollController;
    setWorkspaceVisible(true);
    setPollingInterrupted(false);
    setMessage(null);
    setIsGenerating(true);
    try {
      const finalStatus = await pollGenerationForTool(run.tool, run.predictionId, pollController);
      await finishGenerationPolling(finalStatus, run.tool, run.predictionId);
    } catch (error) {
      if (pollController.signal.aborted) return;
      setPollingInterrupted(true);
      setMessage(error instanceof Error ? error.message : 'Could not refresh generation progress.');
    } finally {
      if (generationPollControllerRef.current === pollController) generationPollControllerRef.current = null;
      if (activeGenerationRequestKeyRef.current === requestKey) activeGenerationRequestKeyRef.current = null;
      setIsGenerating(false);
    }
  };

  const forgetPendingAttempt = async (identity: string) => {
    setPendingAttempt((current) => (current?.identityUserId === identity ? null : current));
    await clearPendingGenerationAttempt(identity).catch(() => undefined);
  };

  const sendGenerationAttempt = (attempt: PendingGenerationAttempt): Promise<GenerationStartResponse> => {
    // Only POST /api/generations starts a run: the per-kind routes answer a start 410
    // (product decision 21), so an attempt an older build saved under one is not sent.
    if (attempt.route !== 'unified' || !api.startGeneration) {
      return Promise.reject(new Error('This version of the app can’t check that generation. Start a new run instead.'));
    }
    // Parsed back from what was saved, so a check replays the exact request the
    // server hashed under this key.
    const body = JSON.parse(attempt.requestJson) as never;
    return api.startGeneration(body, attempt.idempotencyKey);
  };

  const runGenerationAttempt = async (
    attempt: PendingGenerationAttempt,
    { draft, request }: { draft: CreationDraft; request: CatalogGenerationRequest | null },
  ) => {
    activeGenerationRequestKeyRef.current = attempt.idempotencyKey;
    generationPollControllerRef.current?.abort();
    const pollController = new AbortController();
    generationPollControllerRef.current = pollController;
    setIsGenerating(true);
    let startedPredictionId: string | null = null;
    let attemptSaved = false;
    try {
      // Saved before the request leaves the phone, so a response lost to a
      // dropped connection or a restart can still be checked under this key.
      setPendingAttempt(attempt);
      await savePendingGenerationAttempt(attempt);
      attemptSaved = true;
      const started = await sendGenerationAttempt(attempt);
      startedPredictionId = started.predictionId;
      // The server took a run from this build at the price it showed, so the refusal it last gave
      // is no word on this build now: the run it refused goes as any other. The web creators forget
      // a refusal on a start of the refused run itself; here any start the server takes forgets it,
      // so a run refused before another started is not held once the server has come to agree with
      // this build. One it still refuses is refused once more, and held from then.
      setQuoteAsking((current) => (current.refused ? { ...current, refused: null } : current));
      void forgetPendingAttempt(attempt.identityUserId);
      runCostRef.current = typeof started.cost === 'number' ? started.cost : null;
      // Kept until the run ends, so a creator opened again watches this run rather than
      // offering Generate on the same draft, which would start and charge a second one.
      const attemptedAt = Date.parse(attempt.createdAt);
      void saveActiveGenerationRecord({
        version: 1,
        identityUserId: attempt.identityUserId,
        tool: attempt.tool,
        predictionId: started.predictionId,
        generationId: started.generationId ?? null,
        startedAt: Number.isFinite(attemptedAt) ? attemptedAt : Date.now(),
        estimatedTotalMs: null,
      }).catch(() => undefined);
      // One record per identity: this run's has taken the place of any other's.
      setOtherToolRun(null);
      // The tab bar's create ring counts the viewer's in-flight runs, and its
      // poll is off while that count is zero. Tell it a run exists now, or it
      // stays dark until the app next comes back to the foreground.
      invalidateActiveGenerations(queryClient, identityUserId);
      // And Profile's Rendering strip, which a read from the last minute would leave without this run.
      void invalidateProfileCreations(queryClient, identityUserId).catch(() => undefined);
      setLastPredictionId(started.predictionId);
      setLastGenerationId(started.generationId ?? null);
      if (typeof started.remainingCredits === 'number') updateCredits(started.remainingCredits);
      const finalStatus = await pollGenerationForTool(attempt.tool, started.predictionId, pollController);
      await finishGenerationPolling(finalStatus, attempt.tool, started.predictionId);
    } catch (error) {
      if (pollController.signal.aborted) return;
      const details = error && typeof error === 'object' && 'details' in error
        ? (error as { details?: { code?: string } }).details
        : null;
      if (!attemptSaved) {
        // Keep the same attempt available for retry, but never send without
        // a durable key that survives a lost response and an app restart.
        setMessage('Could not save your generation attempt. Free up device storage if needed, then check again. No request was sent.');
      } else if (startedPredictionId) {
        setPollingInterrupted(true);
        setMessage(error instanceof Error ? error.message : 'Could not refresh generation progress.');
      } else if (isAmbiguousGenerationStartFailure(error)) {
        // The server may have started this run. The attempt stays, and checking
        // it replays this request under this key, which cannot start another.
        setMessage(GENERATION_ATTEMPT_UNCONFIRMED_MESSAGE);
      } else {
        void forgetPendingAttempt(attempt.identityUserId);
        const refusal = generationStartRefusalCode(error) ?? details?.code ?? null;
        setStartRefusal(refusal);
        // The balance the form reads can be stale; the server has just said it is short.
        if (refusal === 'insufficient_credits') void refreshProfile().catch(() => undefined);
        // Priced again at once, so Try again states what the run now costs. The refused run is kept
        // with the asking, so a price that comes back unmoved for it says this app is out of date.
        if (refusal === 'cost_changed') {
          const refused = request ? catalogRefusedRunPrice(request) : null;
          setQuoteAsking((current) => ({ attempt: current.attempt + 1, refused }));
        }
        // The server does not say which reference it could not use; storage says which are gone.
        if (refusal === 'invalid_input_media') void verifyStagedReferences([attempt.tool], { onlyExpired: false });
        if (details?.code === 'CATALOG_CHANGED' || details?.code === 'MODEL_UNAVAILABLE') {
          void refetchCatalog();
          setMessage('The model catalog changed before generation started. Review the refreshed options and generate again.');
        } else if (details?.code === REFERENCE_DURATION_CHANGED_CODE) {
          // Nothing was charged. Taking the measured lengths refreshes the quote to
          // the price the server will charge, and the viewer confirms it.
          if (request) {
            replaceDraft(applyVerifiedInputDurations(draft, request, readVerifiedInputDurations(details)));
          }
          setMessage('We measured your reference media, and it changes the cost. Check the new price, then generate again.');
        } else {
          setMessage(error instanceof Error ? error.message : 'Generation failed.');
        }
      }
      haptic.error();
    } finally {
      if (generationPollControllerRef.current === pollController) {
        generationPollControllerRef.current = null;
      }
      activeGenerationRequestKeyRef.current = null;
      setIsGenerating(false);
    }
  };

  const generate = async ({ newRun = false }: { newRun?: boolean } = {}) => {
    if (activeGenerationRequestKeyRef.current) return;
    if (pollingInterrupted) {
      setWorkspaceVisible(true);
      return;
    }
    // Guests generate. Credits are a server-side balance on their identity, so
    // there is nothing account-specific to ask for before spending them.
    if (!identityUserId) {
      openAuthForCurrentDraft();
      return;
    }
    if (!currentCatalogModel || activeQuote.status !== 'ready') {
      setMessage(activeQuote.error ?? 'Wait for the current generation cost before continuing.');
      return;
    }
    // The start would refuse this run as it did; the blocker already says why.
    if (appOutOfDate) return;
    const nextValidation = validateCatalogCreationDraft(currentDraft, currentCatalogModel, { credits, quotedCost: activeQuote.cost });
    const nextErrors = unavailableReference
      ? [unavailableReference, ...nextValidation.errors]
      : nextValidation.errors;
    if (nextErrors.length > 0) {
      const promptError = promptValidationMessage(nextErrors[0]);
      if (promptError) {
        setPromptMessage(promptError);
        setMessage(null);
      } else {
        setMessage(nextErrors[0]);
        setPromptMessage(null);
      }
      return;
    }
    // Every run starts on POST /api/generations, which the app's catalog schema always has;
    // the per-kind routes answer a start 410 and are only polled.
    const route = 'unified' as const;
    // Kept so a refusal that measured the references can be matched back to the draft's media.
    // It carries the price on the button, which the server will not charge more than.
    const unifiedRequest = catalogStartRequest(
      buildUnifiedCatalogGenerationRequest(currentDraft, currentCatalogModel, catalog?.revision ?? ''),
      { key: quoteKey, status: activeQuote.status, cost: activeQuote.cost },
    );
    const requestJson = JSON.stringify(unifiedRequest);
    // An unchanged press after a lost response is the same attempt, under the same key.
    const reusedKey = newRun ? null : reusableAttemptKey(pendingAttempt, identityUserId, route, requestJson);
    if (pendingAttempt && !newRun && !reusedKey) {
      setPromptMessage(null);
      setMessage(GENERATION_ATTEMPT_CHOICE_MESSAGE);
      return;
    }
    // Last, so the question comes only for a run that is ready to go, and a
    // refusal leaves the draft exactly as it was.
    if (!(await ensureAiDataConsent())) return;
    setMessage(null);
    setPromptMessage(null);
    setStatus(null);
    setLastGenerationId(null);
    setLastPredictionId(null);
    setPollingInterrupted(false);
    setStartRefusal(null);
    setRefundNotice(null);
    setGenerationTool(currentDraft.tool);
    // Stamped here rather than when the workspace becomes visible: minimizing
    // and coming back must not restart the clock the wait is reporting.
    setGenerationStartedAt(Date.now());
    setWorkspaceVisible(true);
    if (guided) void trackOnboardingEvent(api, 'first_generation_started', { goal: currentDraft.tool, step: 'creator' });
    await runGenerationAttempt({
      version: 1,
      identityUserId,
      tool: currentDraft.tool,
      route,
      idempotencyKey: reusedKey ?? createMobileGenerationIdempotencyKey(currentDraft.tool),
      requestJson,
      createdAt: reusedKey && pendingAttempt ? pendingAttempt.createdAt : new Date().toISOString(),
    }, { draft: currentDraft, request: unifiedRequest });
  };

  /** Replays the unconfirmed attempt as it was saved, whatever the draft says now. */
  const checkPendingAttempt = async () => {
    const attempt = pendingAttempt;
    if (!attempt || activeGenerationRequestKeyRef.current || attempt.identityUserId !== identityUserId) return;
    // The replay sends the saved request again, and permission may have been withdrawn since.
    if (!(await ensureAiDataConsent())) return;
    setMessage(null);
    setPromptMessage(null);
    setStatus(null);
    setLastGenerationId(null);
    setLastPredictionId(null);
    setPollingInterrupted(false);
    setStartRefusal(null);
    setRefundNotice(null);
    setGenerationTool(attempt.tool);
    const attemptedAt = Date.parse(attempt.createdAt);
    setGenerationStartedAt(Number.isFinite(attemptedAt) ? attemptedAt : Date.now());
    setWorkspaceVisible(true);
    let request: CatalogGenerationRequest | null = null;
    if (attempt.route === 'unified') {
      try {
        request = JSON.parse(attempt.requestJson) as CatalogGenerationRequest;
      } catch {
        request = null;
      }
    }
    await runGenerationAttempt(attempt, { draft: latestDrafts.current[attempt.tool], request });
  };

  /** The explicit choice to run again while the last run may still exist. */
  const startNewRun = async () => {
    if (activeGenerationRequestKeyRef.current || !identityUserId) return;
    await forgetPendingAttempt(identityUserId);
    await generate({ newRun: true });
  };

  /** Watches a run this identity started from a creator screen that has since closed. */
  const openActiveRun = (record: ActiveGenerationRecord) => {
    setOtherToolRun(null);
    setActiveTool(record.tool);
    setGenerationTool(record.tool);
    setStatus(null);
    setMessage(null);
    setStartRefusal(null);
    setRefundNotice(null);
    setLastPredictionId(record.predictionId);
    setLastGenerationId(record.generationId);
    setGenerationStartedAt(record.startedAt);
    runCostRef.current = null;
    void resumeGenerationPolling({ tool: record.tool, predictionId: record.predictionId });
  };
  // Once the drafts are back: a run still in flight for this tool is watched again, with its
  // progress on screen, and one for another tool is offered, before Generate can start a second.
  useEffect(() => {
    if (!draftsHydrated || !identityUserId || activeRunCheckedRef.current) return;
    let active = true;
    void loadActiveGenerationRecord(identityUserId).then((record) => {
      if (!active) return;
      activeRunCheckedRef.current = true;
      if (!record || activeGenerationRequestKeyRef.current) return;
      if (record.tool === activeTool) openActiveRun(record);
      else setOtherToolRun(record);
    }, () => {
      if (active) activeRunCheckedRef.current = true;
    });
    return () => {
      active = false;
    };
  }, [draftsHydrated, identityUserId]);

  // New models in the Create tab only (D9), from the catalog pages this screen has read. A first
  // creation, opened from onboarding, keeps to its starters: every model is new to its creator.
  const whatsNewStrip = insideTab && !guided ? (
    <WhatsNewModelsStrip models={catalogQuery.summaries} selectedModelId={rawDraft.model} pick={modelPick} onSelect={pickWhatsNewModel} />
  ) : null;

  const otherToolRunNotice = otherToolRun && !isGenerating ? (
    <View style={{ gap: 8 }}>
      <SlimCreatorBanner label="Run in progress" body={`A ${otherToolRun.tool} run is in progress.`} />
      <SecondaryButton label="Open" onPress={() => openActiveRun(otherToolRun)} />
    </View>
  ) : null;

  const pendingAttemptMedium = pendingAttempt?.tool === 'image'
    ? 'image'
    : pendingAttempt?.tool === 'video'
      ? 'video'
      : 'motion video';
  const pendingAttemptNotice = pendingAttempt && !isGenerating ? (
    <View style={{ gap: 8 }}>
      <SlimCreatorBanner
        label="Generation not confirmed"
        body={`Your last ${pendingAttemptMedium} may already be running. Checking it can’t start a second run.`}
      />
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <SecondaryButton label="Check again" onPress={() => void checkPendingAttempt()} />
        <SecondaryButton
          label={withCreditCost('Start a new run', activeQuote.status === 'ready' ? activeQuote.cost : null)}
          onPress={() => void startNewRun()}
        />
      </View>
    </View>
  ) : null;

  // A reference whose link has stopped working, renewed from where it came from
  // (audit A6). Media from a remix source can only be signed again by reading
  // that source again, behind its own access gate; the creator's own upload is
  // signed again directly. The draft keeps the new link, so a resume does not
  // start from the dead one.
  const renewReferenceLink = async (media: MediaDraft): Promise<string> => {
    const sourceGenerationId = remixSource?.generationId?.trim();
    let url: string | null = null;
    if (sourceGenerationId) {
      try {
        url = remixSourceMediaUrl(await api.getRemixSourceBundle(sourceGenerationId, { postId: remixSource?.postId ?? null }), media);
      } catch (error) {
        if (!media.storagePath) throw error;
      }
    }
    if (!url && media.storagePath) {
      try {
        url = (await api.createMediaReadUrl({ storagePath: media.storagePath })).signedUrl;
      } catch (error) {
        // Gone from storage: the tile asks for the reference again rather than offering a retry.
        if (isMissingUploadError(error)) markReferenceUnavailable(media.storagePath);
        throw error;
      }
    }
    if (!url) throw new Error('This reference can’t be refreshed. Remove it and add it again.');
    const renewed = url;
    setImageDraft((draft) => replaceDraftMediaUrl(draft, media.id, renewed));
    setVideoDraft((draft) => replaceDraftMediaUrl(draft, media.id, renewed));
    setMotionDraft((draft) => replaceDraftMediaUrl(draft, media.id, renewed));
    return renewed;
  };
  const markReferenceUnavailable = (storagePath: string) => {
    setUnavailableReferencePaths((current) => (current.has(storagePath) ? current : new Set([...current, storagePath])));
  };
  /**
   * Signs the creator's own staged uploads again, marking any the server has swept: a staged
   * upload a run used is deleted 48 h after it was signed, and a draft keeps its path for ever.
   * On resume only uploads whose saved link has run out are asked about (a link lasts an hour,
   * so one still good has not been swept); after a refusal of the run's media, all of them.
   */
  const verifyStagedReferences = async (tools: readonly CreatorToolId[], { onlyExpired }: { onlyExpired: boolean }) => {
    const now = Date.now();
    const staged = tools
      .flatMap((tool) => heldDraftMedia(latestDrafts.current[tool]))
      .filter((media): media is MediaDraft & { storagePath: string } => Boolean(media.storagePath) && !media.sourceGenerationId)
      .filter((media) => {
        if (!onlyExpired) return true;
        const expiresAt = signedStorageUrlExpiresAt(media.url, env.supabaseUrl);
        return expiresAt !== null && expiresAt - 60_000 <= now;
      });
    for (const storagePath of new Set(staged.map((media) => media.storagePath))) {
      try {
        const { signedUrl } = await api.createMediaReadUrl({ storagePath });
        if (!signedUrl) continue;
        for (const media of staged.filter((item) => item.storagePath === storagePath)) {
          setImageDraft((draft) => replaceDraftMediaUrl(draft, media.id, signedUrl));
          setVideoDraft((draft) => replaceDraftMediaUrl(draft, media.id, signedUrl));
          setMotionDraft((draft) => replaceDraftMediaUrl(draft, media.id, signedUrl));
        }
      } catch (error) {
        if (isMissingUploadError(error)) markReferenceUnavailable(storagePath);
      }
    }
  };
  useEffect(() => {
    if (!draftsHydrated || stagedReferencesCheckedRef.current) return;
    stagedReferencesCheckedRef.current = true;
    void verifyStagedReferences(['image', 'video', 'motion'], { onlyExpired: true });
  }, [draftsHydrated]);
  const withReferenceLinkRenewal = (tree: ReactElement) => (
    <ReferenceLinkRenewal.Provider value={renewReferenceLink}>
      <UnavailableReferences.Provider value={unavailableReferencePaths}>
        <LocalReferencePreviews.Provider value={localPreviews}>{tree}</LocalReferencePreviews.Provider>
      </UnavailableReferences.Provider>
    </ReferenceLinkRenewal.Provider>
  );

  /** The failure view's first action for a refusal the server named (startRefusalActionLabel). */
  const runRefusalAction = () => {
    const refusal = startRefusal;
    const refusalMessage = message;
    setWorkspaceVisible(false);
    setStatus(null);
    setLastPredictionId(null);
    setPollingInterrupted(false);
    setGenerationTool(null);
    setStartRefusal(null);
    setRefundNotice(null);
    if (refusal === 'insufficient_credits') {
      setMessage(null);
      router.push('/(tabs)/pricing' as never);
      return;
    }
    if (refusal === 'prompt_blocked') {
      setMessage(null);
      setPromptMessage(refusalMessage);
      setPromptFocusRequest((value) => value + 1);
      return;
    }
    // The reference, the price or the options to change are on the creator itself, where the
    // refusal stays said until the next press.
    setMessage(refusalMessage);
  };
  // An app out of date for this run has no new price to check: the refusal is answered with why.
  const refusalOutOfDate = appOutOfDate && startRefusal === 'cost_changed';
  const refusalActionLabel = refusalOutOfDate ? null : startRefusalActionLabel(startRefusal);
  const refusalAction = refusalActionLabel ? { label: refusalActionLabel, onPress: runRefusalAction } : null;
  const promptNotes = enhanceNotes && enhanceNotes.shotId === undefined && enhanceNotes.tool === activeTool && enhanceNotes.prompt === currentDraft.prompt
    ? enhanceNotes.warnings
    : [];
  // A shot's notes go to the shot editor, which shows them while that shot's enhanced words stand.
  const shotNotes = enhanceNotes?.shotId !== undefined && enhanceNotes.tool === activeTool
    ? { shotId: enhanceNotes.shotId, prompt: enhanceNotes.prompt, warnings: enhanceNotes.warnings }
    : null;
  // Undo stands while the enhanced words do: the prompt's, or the one shot's they were written for.
  const canUndoEnhance = enhanceUndo !== null && (enhanceUndo.shotId === undefined
    ? enhanceUndo.enhanced === currentDraft.prompt
    : currentDraft.tool === 'video'
      && currentDraft.multiPrompts.some((shot) => shot.id === enhanceUndo.shotId && shot.prompt === enhanceUndo.enhanced));
  // The parameter sheet is a Modal, which would stay over the pricing page.
  const openCreditsFromParameters = () => {
    setParametersVisible(false);
    router.push('/(tabs)/pricing' as never);
  };
  // Share goes through the composer, as the viewer's Share does for a creation never posted: there
  // is no public link until it is posted, and the composer opens the share sheet once it is.
  const openComposerForResult = (shareAfterPublish: boolean) => {
    if (!lastGenerationId) return;
    setWorkspaceVisible(false);
    router.push({
      pathname: '/post/new',
      params: shareAfterPublish ? { generationId: lastGenerationId, shareAfterPublish: '1' } : { generationId: lastGenerationId },
    } as never);
  };
  // The reel's report, from the result itself: the run is this identity's own,
  // so a guest's report is taken as an account's is.
  const reportResult = () => {
    if (!lastGenerationId) return;
    void reportGenerationOutput({ api, generationId: lastGenerationId, details: 'Reported from the mobile creator result.' });
  };

  // Both layouts draw it. Under the sign-in line (another creator's source,
  // read as a guest, or no identity at all) a retry gets the same answer, so
  // the way on is signing in, which comes back to this remix.
  const remixRestoreBanner = remixRestoreWarning ? (
    <View style={{ gap: 8 }}>
      <SlimCreatorBanner label="Remix source" body={remixRestoreWarning} />
      <View style={{ flexDirection: 'row', gap: 12 }}>
        {remixRestoreWarning === REMIX_RESTORE_SIGN_IN_MESSAGE ? (
          <SecondaryButton label="Sign in" onPress={openAuthForCurrentDraft} />
        ) : (
          <SecondaryButton label="Retry restore" onPress={() => { remixHydrationKeyRef.current = null; setRemixRetry((value) => value + 1); }} />
        )}
        <SecondaryButton label="Use available inputs" onPress={() => { remixResolvedRef.current = true; setRemixRestoreFailed(false); setRemixRestoreWarning(null); }} />
      </View>
    </View>
  ) : null;

  if (activeTool !== 'image') {
    const creatorModels = catalog ? getCatalogModels(catalog, activeTool) : [];
    const selectedCreatorModel = currentCatalogModel?.kind === activeTool
      ? currentCatalogModel
      : null;
    const activeGenerationStatus = generationTool === activeTool ? status : null;
    const activeOutputUrl = generationTool === activeTool ? outputUrl : null;
    const parameterSummary = creatorParameterSummary(activeTool === 'video' ? videoDraft : motionDraft, selectedCreatorModel);
    const visibleValidationError = isRestoringRemix ? undefined : validation.errors.find((error) => (
      !isReferenceMentionActive || !error.startsWith('Unknown element mention:')
    ));
    const blocker = ((appOutOfDate ? APP_OUT_OF_DATE_MESSAGE : null)
      ?? promptMessage
      ?? message
      ?? (catalogUnavailable ? catalogQuery.error?.message : null)
      ?? (activeQuote.status === 'error' ? activeQuote.error : null)
      ?? (motionInputsMissing && !unavailableReference ? motionInputsHint(catalogMotionDraftSlotLabels(motionDraft, selectedCreatorModel)) : null)
      // Through the same mapper the Generate press uses: before this, the
      // blocker stated the condition ("Prompt is required.") and pressing
      // Generate restated it as an instruction ("Add a prompt before
      // generating."), so one requirement had two voices.
      ?? (visibleValidationError ? promptValidationMessage(visibleValidationError) ?? visibleValidationError : null)) ?? null;
    const persistentAction: 'generate' | 'progress' | 'result' = activeOutputUrl
      ? 'result'
      : isGenerating || activeGenerationStatus || (pollingInterrupted && generationTool === activeTool)
        ? 'progress'
        : 'generate';
    const contentBottom = bottomInset + 108;

    return withReferenceLinkRenewal(
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <KeyboardAvoidingArea iosScrollViewAdjustsInsets>
        <ScrollView
          ref={scrollRef}
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingTop: contentTopPadding,
            paddingHorizontal: isCompact ? 16 : 20,
            paddingBottom: contentBottom,
            gap: 14,
          }}
        >
          <CompactCreatorHeader
            activeTool={activeTool}
            modelName={selectedCreatorModel?.displayName ?? (catalogQuery.missingIds.includes(currentDraft.model) ? 'Choose another model' : 'Loading model settings…')}
            modelDisabled={!catalogQuery.current && !catalog}
            onChangeTool={changeTool}
            onOpenModels={() => setModelPickerVisible(true)}
            onClose={onClose ? () => void closeCreator() : undefined}
            closing={isClosing}
            remix={Boolean(remixSource)}
          />
          {whatsNewStrip}
          {remixSource ? (
            <View accessibilityLabel="Remix source post" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              {remixSource.thumbnailUrl ? <StableMediaImage url={remixSource.thumbnailUrl} cacheKey={`remix-source:${remixSource.postId ?? remixSource.generationId}`} style={{ width: 40, height: 40, borderRadius: 10 }} /> : null}
              <View style={{ flex: 1, gap: 2 }}>
                <Text numberOfLines={1} style={{ color: theme.colors.text, ...appTheme.type.bodySm, fontWeight: '700' }}>{remixSource.title || 'Source creation'}</Text>
                <Text numberOfLines={1} style={{ color: theme.colors.muted, ...appTheme.type.caption }}>{remixSource.creatorLabel ? `By ${remixSource.creatorLabel}` : 'Make your own version'}</Text>
              </View>
            </View>
          ) : null}

          {guided ? (
            <>
              <GuidedCreatorHint />
              <GuidedPromptChips tool={activeTool} prompt={currentDraft.prompt} onSelectPrompt={updatePrompt} />
            </>
          ) : null}

          {catalogNotice ? (
            <SlimCreatorBanner label="Model updated" body={catalogNotice} onDismiss={() => setCatalogNotice(null)} />
          ) : null}
          {isRestoringRemix ? (
            <SlimCreatorBanner
              label="Remix source"
              body="Restoring the original prompt, settings, and references…"
              loading
            />
          ) : null}
          {remixRestoreBanner}
          {draftLoadError ? <View style={{ gap: 8 }}><SlimCreatorBanner label="Draft unavailable" body="Your saved draft could not be read. Retry to continue without overwriting it." /><SecondaryButton label="Retry loading draft" onPress={() => setDraftLoadAttempt((value) => value + 1)} /></View> : null}
          {draftSaveError ? <View style={{ gap: 8 }}><SlimCreatorBanner label="Draft not saved" body={draftSaveError} /><SecondaryButton label="Retry saving draft" onPress={() => { void saveLatestDraft().then(() => setDraftSaveError(null), () => undefined); }} /></View> : null}
          {referenceNotice ? (
            <SlimCreatorBanner label="Reference updated" body={referenceNotice} onDismiss={() => setReferenceNotice(null)} />
          ) : null}
          {pendingAttemptNotice}
          {otherToolRunNotice}

          {activeTool === 'video' ? (
            <VideoCreatorComposer
              draft={videoDraft}
              model={selectedCreatorModel}
              promptFocusRequest={promptFocusRequest}
              isEnhancing={isEnhancing}
              isUploading={isUploading}
              promptMessage={promptMessage}
              validationErrors={validation.errors}
              onPromptChange={updatePrompt}
              onEnhance={enhancePrompt}
              onEnhanceShot={(shotId) => void enhanceShotPrompt(shotId)}
              shotNotes={shotNotes}
              enhanceLevel={enhanceLevel}
              onEnhanceLevelChange={setEnhanceLevel}
              canUndoEnhance={canUndoEnhance}
              onUndoEnhance={handleUndoEnhance}
              onChange={(draft) => replaceDraft(draft)}
              onUploadImages={() => uploadImageReferences('video')}
              onUploadStart={() => uploadSingleImage('start')}
              onUploadEnd={() => uploadSingleImage('end')}
              onUploadVideo={() => uploadReferenceVideo('video')}
              onUploadAudio={uploadReferenceAudio}
              onAddSubject={() => void uploadSubject()}
              upload={upload}
              onCancelUpload={cancelUpload}
              promptNotes={promptNotes}
              onReplaceReference={(id) => {
                void replaceImageReference('video', id);
              }}
              replacingReferenceId={replacingReferenceId}
              preparingAssetId={preparingAssetId}
              onPrepareSeedanceAsset={(id) => void prepareSeedanceAsset(id)}
              onRefreshSeedanceAsset={(id) => void refreshSeedanceAsset(id)}
              onReferenceNotice={setReferenceNotice}
              onFocus={() => setIsPromptFocused(true)}
              onBlur={() => setIsPromptFocused(false)}
              onMentionStateChange={setIsReferenceMentionActive}
            />
          ) : (
            <MotionCreatorComposer
              draft={motionDraft}
              model={selectedCreatorModel}
              promptFocusRequest={promptFocusRequest}
              isEnhancing={isEnhancing}
              isUploading={isUploading}
              promptMessage={promptMessage}
              validationErrors={validation.errors}
              onPromptChange={updatePrompt}
              onEnhance={enhancePrompt}
              enhanceLevel={enhanceLevel}
              onEnhanceLevelChange={setEnhanceLevel}
              canUndoEnhance={canUndoEnhance}
              onUndoEnhance={handleUndoEnhance}
              onChange={(draft) => replaceDraft(draft)}
              onUploadCharacter={() => uploadSingleImage('character')}
              onUploadMotion={() => uploadReferenceVideo('motion')}
              upload={upload}
              onCancelUpload={cancelUpload}
              promptNotes={promptNotes}
              onFocus={() => setIsPromptFocused(true)}
              onBlur={() => setIsPromptFocused(false)}
            />
          )}
        </ScrollView>
        </KeyboardAvoidingArea>

        <CreatorPersistentBar
          bottom={bottomInset + 8}
          summary={parameterSummary}
          blocker={persistentAction === 'generate' ? blocker : null}
          quoteStatus={creatorQuoteStatus}
          awaitingInputs={motionInputsMissing}
          cost={activeQuote.cost}
          retryLabel={creatorRetryLabel}
          action={persistentAction}
          disabled={persistentAction === 'generate' && generateDisabled}
          onOpenParameters={() => setParametersVisible(true)}
          onRetryQuote={retryCreatorQuote}
          onAction={() => {
            if (persistentAction === 'generate') void generate();
            else setWorkspaceVisible(true);
          }}
        />

        <SearchableModelPickerSheet
          visible={modelPickerVisible}
          loading={catalogQuery.isLoadingModels}
          pendingId={modelPick && !modelPick.error ? modelPick.modelId : null}
          error={modelPick?.error ?? catalogQuery.error?.message}
          onRetry={modelPick?.error ? () => void pickModel(activeTool, modelPick.modelId) : refetchCatalog}
          items={catalogQuery.summaries.filter(model => model.kind === activeTool)}
          value={currentDraft.model}
          onClose={closeModelPicker}
          onChange={(modelId) => void pickModel(activeTool, modelId)}
        />

        <CreatorParameterSheet
          visible={parametersVisible}
          bottomInset={bottomInset}
          catalog={catalog}
          model={selectedCreatorModel}
          draft={currentDraft}
          hiddenControlKeys={activeTool === 'video'
            ? videoDraft.isMultiShot
              ? ['isMultiShot', 'referenceMode', 'duration']
              : ['isMultiShot', 'referenceMode']
            : ['duration']}
          sourceDurationSeconds={activeTool === 'motion' && motionDraft.referenceVideo ? getMotionDuration(motionDraft) : null}
          quoteStatus={creatorQuoteStatus}
          awaitingInputs={motionInputsMissing}
          cost={activeQuote.cost}
          availableCredits={credits}
          blocker={blocker}
          retryLabel={creatorRetryLabel}
          onClose={() => setParametersVisible(false)}
          onRetryQuote={retryCreatorQuote}
          onGetCredits={openCreditsFromParameters}
          onChange={replaceDraft}
          onGenerate={() => {
            setParametersVisible(false);
            void generate();
          }}
          generateDisabled={generateDisabled}
        />

        <GenerationWorkspace
          visible={workspaceVisible && generationTool === activeTool}
          tool={activeTool}
          status={activeGenerationStatus}
          isGenerating={isGenerating && generationTool === activeTool}
          outputUrl={activeOutputUrl}
          outputUrls={generationTool === activeTool ? outputUrls : []}
          generationId={generationTool === activeTool ? lastGenerationId : null}
          settingsSummary={`${selectedCreatorModel?.displayName ?? meta.title} · ${parameterSummary}`}
          startedAt={generationStartedAt}
          retryCost={activeQuote.status === 'ready' ? activeQuote.cost : null}
          retryHeld={appOutOfDate}
          refusalAction={refusalAction}
          notice={refusalOutOfDate ? APP_OUT_OF_DATE_DRAFT_NOTE : refundNotice}
          error={refusalOutOfDate ? APP_OUT_OF_DATE_MESSAGE : activeGenerationStatus?.status === 'failed' ? activeGenerationStatus.error?.trim() || message : message}
          pollingInterrupted={pollingInterrupted && generationTool === activeTool}
          onResumePolling={() => void resumeGenerationPolling()}
          attemptUnconfirmed={Boolean(pendingAttempt) && !isGenerating && pendingAttempt?.tool === activeTool}
          onCheckAttempt={() => void checkPendingAttempt()}
          onStartNewRun={() => void startNewRun()}
          onMinimize={() => setWorkspaceVisible(false)}
          onOpenAlerts={() => {
            setWorkspaceVisible(false);
            router.push('/(tabs)/studio');
          }}
          onRetry={() => void generate()}
          onBack={() => {
            setWorkspaceVisible(false);
            setStatus(null);
            setLastPredictionId(null);
            setPollingInterrupted(false);
            setGenerationTool(null);
            setMessage(null);
            setStartRefusal(null);
            setRefundNotice(null);
          }}
          onPost={() => openComposerForResult(false)}
          onShare={() => openComposerForResult(true)}
          onReport={reportResult}
          onCreateAnother={() => {
            setWorkspaceVisible(false);
            setStatus(null);
            setLastGenerationId(null);
            setLastPredictionId(null);
            setPollingInterrupted(false);
            setGenerationTool(null);
            setMessage(null);
            setPromptMessage(null);
            setStartRefusal(null);
            setRefundNotice(null);
          }}
        />
      </View>
    );
  }

  if (activeTool === 'image') {
    const imageModels = catalog ? getCatalogModels(catalog, 'image') : [];
    const selectedImageModel = currentCatalogModel?.kind === 'image' ? currentCatalogModel : null;
    const activeGenerationStatus = generationTool === 'image' ? status : null;
    const activeOutputUrl = generationTool === 'image' ? outputUrl : null;
    const imageRecord = imageDraft as unknown as Record<string, unknown>;
    const parameterSummary = [imageRecord.resolution, imageRecord.aspectRatio, imageRecord.outputFormat]
      .filter((value) => typeof value === 'string' && value.length > 0)
      .map((value) => String(value).toUpperCase())
      .join(' · ');
    const visibleValidationError = isRestoringRemix ? undefined : validation.errors.find((error) => (
      !isReferenceMentionActive || !error.startsWith('Unknown element mention:')
    ));
    const blocker = ((appOutOfDate ? APP_OUT_OF_DATE_MESSAGE : null)
      ?? promptMessage
      ?? message
      ?? (catalogUnavailable ? catalogQuery.error?.message : null)
      ?? (activeQuote.status === 'error' ? activeQuote.error : null)
      // Through the same mapper the Generate press uses: before this, the
      // blocker stated the condition ("Prompt is required.") and pressing
      // Generate restated it as an instruction ("Add a prompt before
      // generating."), so one requirement had two voices.
      ?? (visibleValidationError ? promptValidationMessage(visibleValidationError) ?? visibleValidationError : null)) ?? null;
    const persistentAction: 'generate' | 'progress' | 'result' = activeOutputUrl
      ? 'result'
      : isGenerating || activeGenerationStatus || (pollingInterrupted && generationTool === 'image')
        ? 'progress'
        : 'generate';
    const imageContentBottom = bottomInset + 108;
    const maxImageReferences = catalogInputLimit(
      selectedImageModel,
      imageDraft,
      'imageReferences',
      selectedImageModel?.inputs.imageReferences?.max ?? 0,
    );

    return withReferenceLinkRenewal(
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <KeyboardAvoidingArea iosScrollViewAdjustsInsets>
        <ScrollView
          ref={scrollRef}
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingTop: contentTopPadding,
            paddingHorizontal: isCompact ? 16 : 20,
            paddingBottom: imageContentBottom,
            gap: 14,
          }}
        >
          <CompactCreatorHeader
            activeTool={activeTool}
            modelName={selectedImageModel?.displayName ?? (catalogQuery.missingIds.includes(currentDraft.model) ? 'Choose another model' : 'Loading model settings…')}
            modelDisabled={!catalogQuery.current && !catalog}
            onChangeTool={changeTool}
            onOpenModels={() => setModelPickerVisible(true)}
            onClose={onClose ? () => void closeCreator() : undefined}
            closing={isClosing}
            remix={Boolean(remixSource)}
          />
          {whatsNewStrip}
          {remixSource ? (
            <View accessibilityLabel="Remix source post" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              {remixSource.thumbnailUrl ? <StableMediaImage url={remixSource.thumbnailUrl} cacheKey={`remix-source:${remixSource.postId ?? remixSource.generationId}`} style={{ width: 40, height: 40, borderRadius: 10 }} /> : null}
              <View style={{ flex: 1, gap: 2 }}>
                <Text numberOfLines={1} style={{ color: theme.colors.text, ...appTheme.type.bodySm, fontWeight: '700' }}>{remixSource.title || 'Source creation'}</Text>
                <Text numberOfLines={1} style={{ color: theme.colors.muted, ...appTheme.type.caption }}>{remixSource.creatorLabel ? `By ${remixSource.creatorLabel}` : 'Make your own version'}</Text>
              </View>
            </View>
          ) : null}

          {guided ? (
            <>
              <GuidedCreatorHint />
              <GuidedPromptChips tool="image" prompt={imageDraft.prompt} onSelectPrompt={updatePrompt} />
            </>
          ) : null}

          {catalogNotice ? (
            <SlimCreatorBanner label="Model updated" body={catalogNotice} onDismiss={() => setCatalogNotice(null)} />
          ) : null}
          {isRestoringRemix ? (
            <SlimCreatorBanner
              label="Remix source"
              body="Restoring the original prompt, settings, and references…"
              loading
            />
          ) : null}
          {remixRestoreBanner}
          {draftLoadError ? <View style={{ gap: 8 }}><SlimCreatorBanner label="Draft unavailable" body="Your saved draft could not be read. Retry to continue without overwriting it." /><SecondaryButton label="Retry loading draft" onPress={() => setDraftLoadAttempt((value) => value + 1)} /></View> : null}
          {draftSaveError ? <View style={{ gap: 8 }}><SlimCreatorBanner label="Draft not saved" body={draftSaveError} /><SecondaryButton label="Retry saving draft" onPress={() => { void saveLatestDraft().then(() => setDraftSaveError(null), () => undefined); }} /></View> : null}
          {referenceNotice ? (
            <SlimCreatorBanner label="Reference updated" body={referenceNotice} onDismiss={() => setReferenceNotice(null)} />
          ) : null}
          {pendingAttemptNotice}
          {otherToolRunNotice}

          <ImagePromptComposer
            draft={imageDraft}
            maxReferences={maxImageReferences}
            // Until the model's descriptor is in, nothing is known to be left out.
            referencesSent={selectedImageModel ? maxImageReferences : imageDraft.references.length}
            promptOnlyModelName={selectedImageModel && maxImageReferences === 0 ? selectedImageModel.displayName : null}
            mentionHandles={selectedImageModel ? catalogDraftRunHandles(imageDraft, selectedImageModel) : null}
            referenceLimitMessage={validation.errors.find(isReferenceLimitError) ?? null}
            promptMeter={catalogPromptMeters(imageDraft, selectedImageModel).prompt}
            promptFocusRequest={promptFocusRequest}
            isEnhancing={isEnhancing}
            enhanceVerb={imagePromptNamesReference(imageDraft, selectedImageModel) ? 'Polish' : 'Enhance'}
            promptNotes={promptNotes}
            isUploading={isUploading}
            uploadProgress={upload?.target === 'image-references' ? upload : null}
            promptMessage={promptMessage}
            onPromptChange={updatePrompt}
            onEnhance={enhancePrompt}
            enhanceLevel={enhanceLevel}
            onEnhanceLevelChange={setEnhanceLevel}
            canUndoEnhance={canUndoEnhance}
            onUndoEnhance={handleUndoEnhance}
            onUploadReferences={() => uploadImageReferences('image')}
            onRenameReference={(id, displayName) => setImageDraft((draft) => {
              const currentReference = draft.references.find((media) => media.id === id);
              if (!currentReference) return draft;
              const renamed = renameMediaDraft(currentReference, displayName);
              // Two references renamed alike would otherwise answer to one @mention.
              const renamedReference = renamed.handle
                ? withUniqueReferenceHandle(renamed, draft.references.filter((media) => media.id !== id))
                : renamed;
              const nextPrompt = currentReference.handle && promptContainsHandle(draft.prompt, currentReference.handle)
                ? replacePromptHandle(draft.prompt, currentReference.handle, renamedReference.handle ?? '')
                : draft.prompt;
              return {
                ...draft,
                prompt: nextPrompt,
                references: draft.references.map((media) => (media.id === id ? renamedReference : media)),
              };
            })}
            onReplaceReference={(id) => {
              void replaceImageReference('image', id);
            }}
            replacingReferenceId={replacingReferenceId}
            onRemoveReference={(id) => {
              const removedReference = imageDraft.references.find((media) => media.id === id);
              const handleWasUsed = promptContainsHandle(imageDraft.prompt, removedReference?.handle);
              if (removedReference) {
                setReferenceNotice(handleWasUsed && removedReference.handle
                  ? `${removedReference.displayName} and ${removedReference.handle} were removed from this draft.`
                  : `${removedReference.displayName} was removed from this draft.`);
              }
              setImageDraft((draft) => ({
                ...draft,
                prompt: handleWasUsed && removedReference?.handle
                  ? replacePromptHandle(draft.prompt, removedReference.handle)
                  : draft.prompt,
                references: draft.references.filter((media) => media.id !== id),
              }));
            }}
            onFocus={() => setIsPromptFocused(true)}
            onBlur={() => setIsPromptFocused(false)}
            onMentionStateChange={setIsReferenceMentionActive}
          />
        </ScrollView>
        </KeyboardAvoidingArea>

        <CreatorPersistentBar
          bottom={bottomInset + 8}
          summary={parameterSummary || 'Settings'}
          blocker={persistentAction === 'generate' ? blocker : null}
          quoteStatus={creatorQuoteStatus}
          cost={activeQuote.cost}
          retryLabel={creatorRetryLabel}
          action={persistentAction}
          disabled={persistentAction === 'generate' && generateDisabled}
          onOpenParameters={() => setParametersVisible(true)}
          onRetryQuote={retryCreatorQuote}
          onAction={() => {
            if (persistentAction === 'generate') void generate();
            else setWorkspaceVisible(true);
          }}
        />

        <SearchableModelPickerSheet
          visible={modelPickerVisible}
          loading={catalogQuery.isLoadingModels}
          pendingId={modelPick && !modelPick.error ? modelPick.modelId : null}
          error={modelPick?.error ?? catalogQuery.error?.message}
          onRetry={modelPick?.error ? () => void pickModel('image', modelPick.modelId) : refetchCatalog}
          items={catalogQuery.summaries.filter(model => model.kind === 'image')}
          value={imageDraft.model}
          onClose={closeModelPicker}
          onChange={(modelId) => void pickModel('image', modelId)}
        />

        <CreatorParameterSheet
          visible={parametersVisible}
          bottomInset={bottomInset}
          catalog={catalog}
          model={selectedImageModel}
          draft={imageDraft}
          quoteStatus={creatorQuoteStatus}
          cost={activeQuote.cost}
          availableCredits={credits}
          blocker={blocker}
          retryLabel={creatorRetryLabel}
          onClose={() => setParametersVisible(false)}
          onRetryQuote={retryCreatorQuote}
          onGetCredits={openCreditsFromParameters}
          onChange={replaceDraft}
          onGenerate={() => {
            setParametersVisible(false);
            void generate();
          }}
          generateDisabled={generateDisabled}
        />

        <GenerationWorkspace
          visible={workspaceVisible && generationTool === 'image'}
          tool="image"
          status={activeGenerationStatus}
          isGenerating={isGenerating && generationTool === 'image'}
          outputUrl={activeOutputUrl}
          outputUrls={generationTool === 'image' ? outputUrls : []}
          generationId={generationTool === 'image' ? lastGenerationId : null}
          settingsSummary={`${selectedImageModel?.displayName ?? 'Image'} · ${parameterSummary || 'Default settings'}`}
          startedAt={generationStartedAt}
          retryCost={activeQuote.status === 'ready' ? activeQuote.cost : null}
          retryHeld={appOutOfDate}
          refusalAction={refusalAction}
          notice={refusalOutOfDate ? APP_OUT_OF_DATE_DRAFT_NOTE : refundNotice}
          error={refusalOutOfDate ? APP_OUT_OF_DATE_MESSAGE : status?.status === 'failed' ? status.error?.trim() || message : message}
          pollingInterrupted={pollingInterrupted && generationTool === 'image'}
          onResumePolling={() => void resumeGenerationPolling()}
          attemptUnconfirmed={Boolean(pendingAttempt) && !isGenerating && pendingAttempt?.tool === 'image'}
          onCheckAttempt={() => void checkPendingAttempt()}
          onStartNewRun={() => void startNewRun()}
          onMinimize={() => setWorkspaceVisible(false)}
          onOpenAlerts={() => {
            setWorkspaceVisible(false);
            router.push('/(tabs)/studio');
          }}
          onRetry={() => void generate()}
          onBack={() => {
            setWorkspaceVisible(false);
            setStatus(null);
            setLastPredictionId(null);
            setPollingInterrupted(false);
            setGenerationTool(null);
            setMessage(null);
            setStartRefusal(null);
            setRefundNotice(null);
          }}
          onPost={() => openComposerForResult(false)}
          onShare={() => openComposerForResult(true)}
          onReport={reportResult}
          onCreateAnother={() => {
            setWorkspaceVisible(false);
            setStatus(null);
            setLastGenerationId(null);
            setLastPredictionId(null);
            setPollingInterrupted(false);
            setGenerationTool(null);
            setMessage(null);
            setPromptMessage(null);
            setStartRefusal(null);
            setRefundNotice(null);
          }}
        />
      </View>
    );
  }
}

function CompactCreatorHeader({
  activeTool,
  modelName,
  modelDisabled,
  onChangeTool,
  onOpenModels,
  onClose,
  closing = false,
  remix = false,
}: {
  activeTool: CreatorToolId;
  modelName: string;
  modelDisabled: boolean;
  onChangeTool: (tool: CreatorToolId) => void;
  onOpenModels: () => void;
  onClose?: () => void;
  closing?: boolean;
  remix?: boolean;
}) {
  const theme = useAppTheme();
  const modelAccent = accentColor(TOOL_META[activeTool].accent, theme.colors);
  return (
    <View style={{ gap: 14 }}>
      <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {onClose ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={remix ? "Close remix" : "Close creator"}
              accessibilityHint={remix ? "Saves your changes and returns to the source post." : "Saves your changes and returns to the previous screen."}
              disabled={closing}
              accessibilityState={{ busy: closing }}
              onPress={onClose}
              style={({ pressed }) => ({
                width: 48,
                height: 48,
                borderRadius: 24,
                backgroundColor: pressed ? theme.colors.pressed : theme.colors.surfaceStrong,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <CloseGlyph size={appTheme.icon.feature} color={theme.colors.textSecondary} />
            </Pressable>
          ) : null}
          <AppText variant="pageTitle">{remix ? 'Remix' : 'Create'}</AppText>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Selected model ${modelName}. Change model`}
          accessibilityState={{ disabled: modelDisabled }}
          disabled={modelDisabled}
          onPress={onOpenModels}
          style={({ pressed }) => ({
            minHeight: 48,
            maxWidth: onClose ? '48%' : '64%',
            borderRadius: appTheme.radii.pill,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: `${modelAccent}57`,
            backgroundColor: `${modelAccent}18`,
            paddingHorizontal: 14,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 7,
            opacity: modelDisabled ? 0.5 : pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.text, fontSize: 13, fontWeight: '800' }}>
            {modelName}
          </Text>
          <ChevronDown size={15} color={modelAccent} />
        </Pressable>
      </View>
      <ToolSwitcher value={activeTool} onChange={onChangeTool} />
    </View>
  );
}

/**
 * What a first-time creator is told before they spend anything. Onboarding's
 * last act is `router.replace('/(tabs)/creator', { guided: '1' })`, so this is
 * the first screen of the app's actual job — and until S8 it arrived carrying
 * nothing but a row of clipped starter pills, because the section written for
 * this moment sat in a branch that could not render — that branch, and the
 * section with it, have since been deleted.
 *
 * Generative AI: "Set clear expectations about what your AI-powered feature can
 * and can't do … If your feature has known limitations, let people know up
 * front, show them how to get good results." Machine learning/Limitations asks
 * the same. The starters are the chips' job; this is the part that was lost —
 * the promise that looking around costs nothing, and one sentence on what a
 * good prompt contains.
 */
function GuidedCreatorHint() {
  return (
    <SlimCreatorBanner
      label="Your first creation"
      body="Nothing spends credits until you press Generate. Describe subject, setting, lighting and camera in one sentence."
    />
  );
}

function GuidedPromptChips({
  tool,
  prompt,
  onSelectPrompt,
}: {
  tool: CreatorToolId;
  prompt: string;
  onSelectPrompt: (prompt: string) => void;
}) {
  const theme = useAppTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 8 }}>
      {GUIDED_PROMPTS[tool].map((starter, index) => {
        const active = starter === prompt;
        return (
          <Pressable
            key={starter}
            accessibilityRole="button"
            accessibilityLabel={`Starter ${index + 1}. ${starter}`}
            accessibilityState={{ selected: active }}
            onPress={() => onSelectPrompt(starter)}
            style={({ pressed }) => ({
              minHeight: 48,
              maxWidth: 230,
              borderRadius: appTheme.radii.pill,
              borderWidth: 1,
              borderColor: active ? hexWithAlpha(theme.colors.image, 0.58) : theme.colors.border,
              backgroundColor: active ? hexWithAlpha(theme.colors.image, 0.12) : theme.colors.surfaceStrong,
              paddingHorizontal: 14,
              justifyContent: 'center',
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            {/* Two lines, not one: a starter is an example of what to write,
                and "Premium product photo on a cl…" is an example of a third of
                one. Generative AI asks for "diverse, predefined example inputs
                that hint at what's possible". */}
            <Text numberOfLines={2} style={{ color: active ? theme.colors.image : theme.colors.textSecondary, fontSize: 12, lineHeight: 16, fontWeight: '700' }}>
              {starter}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function SlimCreatorBanner({ label, body, loading, onDismiss }: { label: string; body: string; loading?: boolean; onDismiss?: () => void }) {
  const theme = useAppTheme();
  return (
    <View
      style={{
        minHeight: 56,
        borderRadius: 18,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: hexWithAlpha(theme.colors.primary, 0.28),
        backgroundColor: hexWithAlpha(theme.colors.primary, 0.08),
        paddingLeft: 13,
        paddingRight: 5,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={{ color: theme.colors.primary, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }}>{label}</Text>
        <Text numberOfLines={2} style={{ color: theme.colors.textSecondary, fontSize: 12, lineHeight: 16 }}>{body}</Text>
      </View>
      {loading ? (
        <View style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={theme.colors.primary} size="small" />
        </View>
      ) : onDismiss ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Dismiss ${label}`}
          onPress={onDismiss}
          style={({ pressed }) => ({ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
        >
          <X size={17} color={theme.colors.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

function ImagePromptComposer({
  draft,
  maxReferences,
  referencesSent,
  promptOnlyModelName,
  mentionHandles,
  referenceLimitMessage,
  promptMeter,
  promptFocusRequest,
  isEnhancing,
  enhanceVerb,
  promptNotes,
  isUploading,
  uploadProgress,
  promptMessage,
  onPromptChange,
  onEnhance,
  enhanceLevel,
  onEnhanceLevelChange,
  canUndoEnhance,
  onUndoEnhance,
  onUploadReferences,
  onRenameReference,
  onReplaceReference,
  replacingReferenceId,
  onRemoveReference,
  onFocus,
  onBlur,
  onMentionStateChange,
}: {
  draft: ImageCreationDraft;
  maxReferences: number;
  /** How many of the draft's references a run sends: the first ones, up to the model's max. */
  referencesSent: number;
  /** The model's name when it takes no reference images, for the note drawn in place of the rail. */
  promptOnlyModelName: string | null;
  /** The handles a run on this model may name, or null before its descriptor is in. */
  mentionHandles: string[] | null;
  /** The validator's word on references past the model's max, said beside them. */
  referenceLimitMessage: string | null;
  /** The prompt's length against the model's own limit (`catalogPromptMeters`). */
  promptMeter: PromptLengthMeter;
  /** Bumped to put the cursor in the prompt, after a refusal of what it says. */
  promptFocusRequest: number;
  isEnhancing: boolean;
  /** Polish when the prompt names a reference the run sends: the enhancer then only adds around it. */
  enhanceVerb: EnhanceVerb;
  promptNotes: PromptEnhancementWarning[];
  isUploading: boolean;
  /** References being uploaded from the rail's add tile. */
  uploadProgress: UploadProgress | null;
  promptMessage: string | null;
  onPromptChange: (prompt: string) => void;
  onEnhance: () => void;
  enhanceLevel: PromptEnhancementLevel;
  onEnhanceLevelChange: (level: PromptEnhancementLevel) => void;
  canUndoEnhance: boolean;
  onUndoEnhance: () => void;
  onUploadReferences: () => void;
  onRenameReference: (id: string, displayName: string) => void;
  onReplaceReference: (id: string) => void;
  replacingReferenceId: string | null;
  onRemoveReference: (id: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  onMentionStateChange: (active: boolean) => void;
}) {
  const theme = useAppTheme();
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const initialSelection = { start: draft.prompt.length, end: draft.prompt.length };
  const [promptSelection, setPromptSelection] = useState<TextSelection>(initialSelection);
  const [promptFocused, setPromptFocused] = useState(false);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null);
  const promptInputRef = useRef<TextInput>(null);
  const promptTextRef = useRef(draft.prompt);
  const lastPromptSelectionRef = useRef<TextSelection>(initialSelection);
  const restoringSelectionRef = useRef<TextSelection | null>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedReference = draft.references.find((media) => media.id === referenceId) ?? null;
  const referenceLimitReached = maxReferences === 0 || draft.references.length >= maxReferences;
  // The rest wait in the draft for a model that takes them.
  const sentReferences = draft.references.slice(0, referencesSent);
  const standbyReferences = draft.references.slice(referencesSent);
  const detectedMention = useMemo(
    () => promptFocused ? findActiveReferenceMention(draft.prompt, promptSelection) : null,
    [draft.prompt, promptFocused, promptSelection],
  );
  const mentionKey = detectedMention ? `${draft.prompt}:${promptSelection.start}:${promptSelection.end}` : null;
  const activeMention = detectedMention && mentionKey !== dismissedMentionKey ? detectedMention : null;
  const mentionReferences = useMemo(() => {
    if (!activeMention) return [];
    const query = activeMention.query.toLowerCase();
    return draft.references.filter((media) => {
      if (!media.handle) return false;
      // Only what the run sends can be named: the server refuses a mention of anything else.
      if (mentionHandles && !mentionHandles.includes(media.handle)) return false;
      const normalizedHandle = media.handle.slice(1).toLowerCase();
      return normalizedHandle.includes(query) || media.displayName.toLowerCase().includes(query);
    });
  }, [activeMention, draft.references, mentionHandles]);

  useEffect(() => {
    if (promptFocusRequest > 0) promptInputRef.current?.focus();
  }, [promptFocusRequest]);

  useEffect(() => {
    promptTextRef.current = draft.prompt;
    const normalized = normalizeTextSelection(draft.prompt, lastPromptSelectionRef.current);
    if (normalized.start === lastPromptSelectionRef.current.start && normalized.end === lastPromptSelectionRef.current.end) return;
    lastPromptSelectionRef.current = normalized;
    setPromptSelection(normalized);
  }, [draft.prompt]);

  useEffect(() => () => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
  }, []);

  useEffect(() => {
    onMentionStateChange(Boolean(activeMention));
    return () => onMentionStateChange(false);
  }, [activeMention, onMentionStateChange]);

  const clearPromptBlurTimer = () => {
    if (!blurTimerRef.current) return;
    clearTimeout(blurTimerRef.current);
    blurTimerRef.current = null;
  };

  const restorePromptFocus = (delay = 0) => {
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    focusTimerRef.current = setTimeout(() => {
      promptInputRef.current?.focus();
      promptInputRef.current?.setNativeProps({ selection: lastPromptSelectionRef.current });
      focusTimerRef.current = null;
    }, delay);
  };

  const insertReferenceHandle = (handle: string, selection: TextSelection, focusDelay = 0) => {
    clearPromptBlurTimer();
    const prompt = promptTextRef.current;
    if (promptContainsHandle(prompt, handle)) {
      setPromptFocused(true);
      restorePromptFocus(focusDelay);
      return;
    }
    const result = insertHandleAtSelection(prompt, handle, selection);
    promptTextRef.current = result.text;
    lastPromptSelectionRef.current = result.selection;
    restoringSelectionRef.current = result.selection;
    setPromptSelection(result.selection);
    setDismissedMentionKey(`${result.text}:${result.selection.start}:${result.selection.end}`);
    setPromptFocused(true);
    onPromptChange(result.text);
    restorePromptFocus(focusDelay);
  };

  return (
    <>
      <View style={{ gap: 12 }}>
      <View
        style={{
          borderRadius: 28,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: hexWithAlpha(theme.colors.image, 0.2),
          backgroundColor: theme.colors.panel,
          overflow: 'hidden',
        }}
      >
        <View
          testID="prompt-heading-inset"
          style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, backgroundColor: theme.colors.panel, zIndex: 1 }}
        >
          <Text style={{ color: theme.colors.image, fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' }}>Prompt</Text>
        </View>
        <View testID="prompt-scroll-viewport" style={{ height: 190, overflow: 'hidden' }}>
          <TextInput
            maxLength={GENERATION_PROMPT_MAX_LENGTH}
            ref={promptInputRef}
            accessibilityLabel="Generation prompt"
            value={draft.prompt}
            onChangeText={(prompt) => {
              clearPromptBlurTimer();
              setPromptFocused(true);
              setDismissedMentionKey(null);
              promptTextRef.current = prompt;
              onPromptChange(prompt);
            }}
            onSelectionChange={(event) => {
              const selection = normalizeTextSelection(promptTextRef.current, event.nativeEvent.selection);
              const matchesRestoredSelection = restoringSelectionRef.current?.start === selection.start && restoringSelectionRef.current.end === selection.end;
              lastPromptSelectionRef.current = selection;
              setPromptSelection(selection);
              if (!matchesRestoredSelection) setDismissedMentionKey(null);
              if (matchesRestoredSelection) restoringSelectionRef.current = null;
            }}
            multiline
            scrollEnabled
            textAlignVertical="top"
            placeholder="Describe the subject, setting, lighting, composition, and style…"
            placeholderTextColor={theme.colors.faint}
            onFocus={() => {
              clearPromptBlurTimer();
              setPromptFocused(true);
              onFocus();
            }}
            onBlur={() => {
              onBlur();
              clearPromptBlurTimer();
              blurTimerRef.current = setTimeout(() => {
                setPromptFocused(false);
                blurTimerRef.current = null;
              }, 160);
            }}
            style={{
              height: 190,
              overflow: 'hidden',
              color: theme.colors.text,
              fontSize: 14,
              lineHeight: 20,
              paddingHorizontal: 16,
              paddingTop: 12,
              paddingBottom: 28,
            }}
          />
          <View
            testID="prompt-bottom-inset"
            pointerEvents="none"
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 16, backgroundColor: theme.colors.panel }}
          />
        </View>
        <PromptLengthCounter meter={promptMeter} />
        {promptMessage ? (
          <Text accessibilityRole="alert" selectable style={{ color: theme.colors.danger, fontSize: 12, fontWeight: '700', paddingHorizontal: 16, paddingBottom: 10 }}>
            {promptMessage}
          </Text>
        ) : null}
        <PromptQualityNotes warnings={promptNotes} />
      </View>

        {activeMention ? (
          <ReferenceMentionSuggestions
            references={mentionReferences}
            prompt={draft.prompt}
            query={activeMention.query}
            onSelect={(handle) => insertReferenceHandle(handle, activeMention)}
          />
        ) : null}

        <View testID="composer-action-grid" style={{ flexDirection: 'row', alignItems: 'stretch', gap: 8 }}>
          <ComposerToolbarButton icon={<Layers size={15} color={theme.colors.muted} />} label="Templates" onPress={() => router.push('/templates' as never)} quiet />
          <ComposerToolbarButton icon={<Wand2 size={16} color={theme.colors.primary} />} {...enhanceButtonLabels(enhanceVerb, isEnhancing)} onPress={onEnhance} disabled={isEnhancing} accent />
        </View>

        <EnhanceControlsRow
          level={enhanceLevel}
          onLevelChange={onEnhanceLevelChange}
          canUndo={canUndoEnhance}
          onUndo={onUndoEnhance}
          disabled={isEnhancing}
          polishes={enhanceVerb === 'Polish'}
        />

        <View
          testID="image-reference-rail"
          style={{
            borderRadius: 24,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: hexWithAlpha(theme.colors.image, 0.13),
            backgroundColor: theme.colors.panel,
            paddingTop: 14,
            paddingBottom: 14,
            overflow: 'hidden',
            gap: 10,
          }}
        >
          {promptOnlyModelName ? (
            <View style={{ paddingHorizontal: 16 }}>
              <PromptOnlyNote modelName={promptOnlyModelName} />
            </View>
          ) : (
            <>
              <View style={{ paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <Text style={{ color: theme.colors.muted, fontSize: 11, fontWeight: '700' }}>Reference images</Text>
                <Text style={{ color: theme.colors.faint, fontSize: 11, fontWeight: '700' }}>{draft.references.length} / {maxReferences}</Text>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 9, paddingHorizontal: 16, paddingRight: 16 }}>
                {sentReferences.map((media) => (
                  <Pressable
                    key={media.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Open details for ${mediaAccessibleName(media)}`}
                    onPress={() => setReferenceId(media.id)}
                    style={({ pressed }) => ({ opacity: pressed ? appTheme.opacity.pressed : 1, width: 72 })}
                  >
                    <ReferenceMediaPreview media={media} size={72} />
                  </Pressable>
                ))}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={uploadProgress ? `Uploading reference images, ${uploadPercentLabel(uploadProgress)}` : 'Add reference images'}
                  accessibilityState={{ disabled: isUploading || referenceLimitReached, busy: Boolean(uploadProgress) }}
                  disabled={isUploading || referenceLimitReached}
                  onPress={onUploadReferences}
                  style={({ pressed }) => ({
                    width: 72,
                    height: 72,
                    borderRadius: 16,
                    borderWidth: 1,
                    borderStyle: 'dashed',
                    borderColor: hexWithAlpha(theme.colors.image, 0.42),
                    backgroundColor: hexWithAlpha(theme.colors.image, 0.08),
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                    // The tile the upload came from stays legible: it is where its progress shows.
                    opacity: uploadProgress ? 1 : isUploading || referenceLimitReached ? 0.38 : pressed ? appTheme.opacity.pressed : 1,
                  })}
                >
                  {isUploading ? <ActivityIndicator color={theme.colors.image} size="small" /> : <Plus size={22} color={theme.colors.image} />}
                  {uploadProgress ? (
                    <Text testID="reference-upload-progress" style={{ color: theme.colors.textSecondary, fontSize: 11, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{uploadPercentLabel(uploadProgress)}</Text>
                  ) : null}
                </Pressable>
              </ScrollView>
            </>
          )}
          {standbyReferences.length > 0 ? (
            <View style={{ paddingHorizontal: 16 }}>
              <StandbyReferences references={standbyReferences} message={referenceLimitMessage} onRemove={(media) => onRemoveReference(media.id)} />
            </View>
          ) : null}
        </View>
      </View>

      <ReferenceDetailsOverlay
        media={selectedReference}
        handleUsedInPrompt={promptContainsHandle(draft.prompt, selectedReference?.handle)}
        onClose={() => setReferenceId(null)}
        onRename={(displayName) => {
          if (selectedReference) onRenameReference(selectedReference.id, displayName);
        }}
        onUseHandle={(handle) => {
          insertReferenceHandle(handle, lastPromptSelectionRef.current, 280);
          setReferenceId(null);
        }}
        onReplace={() => {
          if (selectedReference) onReplaceReference(selectedReference.id);
        }}
        isReplacing={selectedReference != null && replacingReferenceId === selectedReference.id}
        onRemove={() => {
          if (selectedReference) onRemoveReference(selectedReference.id);
          setReferenceId(null);
        }}
      />
    </>
  );
}

function CompactReferenceSlot({
  testID,
  title,
  helper,
  media,
  required,
  disabled = false,
  isUploading,
  progress = null,
  onAdd,
  onOpen,
}: {
  testID: string;
  title: string;
  helper?: string;
  media: MediaDraft | null;
  required?: boolean;
  disabled?: boolean;
  isUploading: boolean;
  /** The upload this slot started, whose progress it shows until the media arrives. */
  progress?: UploadProgress | null;
  onAdd: () => void;
  onOpen: () => void;
}) {
  const theme = useAppTheme();
  const action = media ? onOpen : onAdd;
  const label = progress && !media
    ? `Uploading ${title.toLowerCase()}, ${uploadPercentLabel(progress)}`
    : media ? `Open details for ${mediaAccessibleName(media)}` : `Add ${title.toLowerCase()}`;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy: isUploading, disabled }}
      disabled={isUploading || disabled}
      onPress={action}
      style={({ pressed }) => ({
        flex: 1,
        minWidth: 0,
        minHeight: 148,
        borderRadius: 22,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderStyle: media ? 'solid' : 'dashed',
        borderColor: media ? hexWithAlpha(theme.colors.image, 0.28) : hexWithAlpha(theme.colors.image, 0.38),
        backgroundColor: media ? theme.colors.surfaceStrong : hexWithAlpha(theme.colors.image, 0.055),
        padding: 11,
        gap: 9,
        opacity: progress ? 1 : isUploading || disabled ? 0.45 : pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <View style={{ minHeight: required ? 29 : 16, alignItems: 'flex-start', justifyContent: 'flex-start', gap: 1 }}>
        <Text numberOfLines={1} style={{ width: '100%', color: theme.colors.text, fontSize: 12, fontWeight: '800' }}>{title}</Text>
        {required ? <Text style={{ color: theme.colors.primary, fontSize: 11, fontWeight: '900', textTransform: 'uppercase' }}>Required</Text> : null}
      </View>
      {media ? (
        <>
          <ReferenceMediaPreview media={media} size={78} />
          <Text numberOfLines={1} style={{ color: theme.colors.muted, fontSize: 11, fontWeight: '700' }}>{media.displayName}</Text>
        </>
      ) : (
        <View style={{ flex: 1, minHeight: 82, alignItems: 'center', justifyContent: 'center', gap: 7 }}>
          {/* Only the slot being filled turns; the others wait, dimmed, for the upload to end. */}
          {progress ? <ActivityIndicator color={theme.colors.image} size="small" /> : <Plus size={23} color={theme.colors.image} />}
          <Text numberOfLines={2} style={{ color: progress ? theme.colors.textSecondary : theme.colors.muted, fontSize: 11, lineHeight: 14, textAlign: 'center', fontVariant: ['tabular-nums'] }}>
            {progress ? `Uploading ${uploadPercentLabel(progress)}` : helper ?? 'Tap to add media'}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

/** What the enhancer said about one shot's words, shown under that shot while they stand. */
type ShotEnhancementNotes = { shotId: string; prompt: string; warnings: PromptEnhancementWarning[] };

function CompactShotEditor({
  draft,
  model,
  isEnhancing,
  promptMessage,
  notes,
  onEnhanceShot,
  onChange,
  onFocus,
  onBlur,
}: {
  draft: VideoCreationDraft;
  model: CreatorCatalogModel | null;
  isEnhancing: boolean;
  /** In a multi-shot run the prompt box is the shot's, so what is said about a prompt is said here. */
  promptMessage: string | null;
  notes: ShotEnhancementNotes | null;
  onEnhanceShot: (shotId: string) => void;
  onChange: (draft: VideoCreationDraft) => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const theme = useAppTheme();
  const [selectedId, setSelectedId] = useState(draft.multiPrompts[0]?.id ?? '');
  const selectedShot = draft.multiPrompts.find((shot) => shot.id === selectedId) ?? draft.multiPrompts[0] ?? null;
  // The run's duration, as the quote and the request carry it, and what the provider takes.
  const totalDuration = multiShotTotalDuration(draft.multiPrompts);
  const { maxShots, maxTotalSeconds } = model ? catalogMultiShotLimits(model) : { maxShots: null, maxTotalSeconds: null };
  const shotsLabel = maxShots !== null ? `${draft.multiPrompts.length} of ${maxShots} shots` : `${draft.multiPrompts.length} shots`;
  const totalLabel = maxTotalSeconds !== null ? `${totalDuration}s of ${maxTotalSeconds}s` : `${totalDuration}s total`;
  // At either cap another shot could only be refused; the shots already there can still be shortened.
  const atShotCap = (maxShots !== null && draft.multiPrompts.length >= maxShots)
    || (maxTotalSeconds !== null && totalDuration >= maxTotalSeconds);
  const selectedShotNumber = selectedShot ? draft.multiPrompts.findIndex((shot) => shot.id === selectedShot.id) + 1 : 0;
  // Each shot against its model's shot limit (Kling 3.0 takes 500 characters, Kling O3 512).
  const shotMeters = catalogPromptMeters(draft, model).shots;
  const shotEnhanceLabels = shotEnhanceButtonLabels(selectedShotNumber, isEnhancing);
  // A shot with no words has nothing to enhance, as the web's per-shot button says by being off.
  const shotEnhanceDisabled = isEnhancing || !selectedShot?.prompt.trim();

  useEffect(() => {
    if (selectedShot || draft.multiPrompts.length === 0) return;
    setSelectedId(draft.multiPrompts[0].id);
  }, [draft.multiPrompts, selectedShot]);

  const updateSelected = (patch: Partial<{ prompt: string; duration: number }>) => {
    if (!selectedShot) return;
    onChange({
      ...draft,
      multiPrompts: draft.multiPrompts.map((shot) => shot.id === selectedShot.id ? { ...shot, ...patch } : shot),
    });
  };

  return (
    <View testID="video-shot-editor" style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <View style={{ gap: 2 }}>
          <Text style={{ color: theme.colors.video, fontSize: 11, fontWeight: '900', letterSpacing: 1, textTransform: 'uppercase' }}>Multi-shot story</Text>
          <Text testID="video-shot-totals" style={{ color: theme.colors.muted, fontSize: 11 }}>{`${shotsLabel} · ${totalLabel}`}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add shot"
          accessibilityState={{ disabled: atShotCap }}
          disabled={atShotCap}
          onPress={() => {
            const id = `shot-${Date.now().toString(36)}`;
            onChange({ ...draft, multiPrompts: [...draft.multiPrompts, { id, prompt: '', duration: 5 }] });
            setSelectedId(id);
          }}
          style={({ pressed }) => ({ minHeight: 48, borderRadius: 16, paddingHorizontal: 13, backgroundColor: pressed ? theme.colors.pressed : theme.colors.surfaceStrong, flexDirection: 'row', alignItems: 'center', gap: 6, opacity: atShotCap ? 0.38 : pressed ? appTheme.opacity.pressed : 1 })}
        >
          <Plus size={16} color={theme.colors.video} />
          <Text style={{ color: theme.colors.text, fontSize: 11, fontWeight: '800' }}>Add shot</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 8 }}>
        {draft.multiPrompts.map((shot, index) => {
          const active = shot.id === selectedShot?.id;
          // A shot past its limit says so on its chip too, so it can be found among the others.
          const over = shotMeters[shot.id]?.state === 'over';
          return (
            <Pressable
              key={shot.id}
              accessibilityRole="button"
              accessibilityLabel={`Edit shot ${index + 1}${over ? ', over the character limit' : ''}`}
              accessibilityState={{ selected: active }}
              onPress={() => setSelectedId(shot.id)}
              style={({ pressed }) => ({ minWidth: 76, minHeight: 48, borderRadius: 16, borderWidth: 1, borderColor: over ? theme.colors.danger : active ? hexWithAlpha(theme.colors.image, 0.55) : theme.colors.border, backgroundColor: active ? hexWithAlpha(theme.colors.image, 0.12) : theme.colors.surfaceStrong, alignItems: 'center', justifyContent: 'center', gap: 2, opacity: pressed ? appTheme.opacity.pressed : 1 })}
            >
              <Text style={{ color: over ? theme.colors.danger : active ? theme.colors.text : theme.colors.muted, fontSize: 11, fontWeight: '900' }}>Shot {index + 1}</Text>
              <Text style={{ color: theme.colors.faint, fontSize: 11 }}>{shot.duration}s</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {selectedShot ? (
        <View style={{ borderRadius: 24, borderCurve: 'continuous', borderWidth: 1, borderColor: hexWithAlpha(theme.colors.image, 0.2), backgroundColor: theme.colors.panel, overflow: 'hidden' }}>
          <TextInput
            maxLength={GENERATION_PROMPT_MAX_LENGTH}
            testID="selected-shot-prompt"
            accessibilityLabel="Selected shot prompt"
            value={selectedShot.prompt}
            onChangeText={(prompt) => updateSelected({ prompt })}
            multiline
            scrollEnabled
            textAlignVertical="top"
            placeholder="Describe action, camera movement, and the beat for this shot…"
            placeholderTextColor={theme.colors.faint}
            onFocus={onFocus}
            onBlur={onBlur}
            style={{ height: 154, color: theme.colors.text, fontSize: 14, lineHeight: 20, paddingHorizontal: 15, paddingTop: 15, paddingBottom: 22 }}
          />
          {shotMeters[selectedShot.id] ? <PromptLengthCounter testID="shot-prompt-length" meter={shotMeters[selectedShot.id]} /> : null}
          {promptMessage ? <Text accessibilityRole="alert" style={{ color: theme.colors.danger, fontSize: 12, fontWeight: '700', paddingHorizontal: 15, paddingBottom: 10 }}>{promptMessage}</Text> : null}
          {notes && notes.shotId === selectedShot.id && notes.prompt === selectedShot.prompt ? <PromptQualityNotes warnings={notes.warnings} /> : null}
          <View style={{ paddingHorizontal: 12, paddingBottom: 4 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={shotEnhanceLabels.accessibilityLabel}
              accessibilityState={{ disabled: shotEnhanceDisabled }}
              disabled={shotEnhanceDisabled}
              onPress={() => onEnhanceShot(selectedShot.id)}
              style={({ pressed }) => ({ minHeight: 44, borderRadius: 16, borderCurve: 'continuous', borderWidth: 1, borderColor: hexWithAlpha(theme.colors.primary, 0.3), backgroundColor: hexWithAlpha(theme.colors.primary, 0.11), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 12, opacity: shotEnhanceDisabled ? 0.45 : pressed ? appTheme.opacity.pressed : 1 })}
            >
              <Wand2 size={16} color={theme.colors.primary} />
              <Text style={{ color: theme.colors.primary, fontSize: 12, fontWeight: '800' }}>{shotEnhanceLabels.label}</Text>
            </Pressable>
          </View>
          <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}>
            <Text style={{ color: theme.colors.muted, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }}>Shot duration</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 7 }}>
              {[3, 4, 5, 6, 8, 10, 12].map((duration) => (
                <Chip key={duration} label={`${duration}s`} active={selectedShot.duration === duration} accent="video" onPress={() => updateSelected({ duration })} />
              ))}
            </ScrollView>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove shot ${draft.multiPrompts.findIndex((shot) => shot.id === selectedShot.id) + 1}`}
            accessibilityState={{ disabled: draft.multiPrompts.length <= 1 }}
            disabled={draft.multiPrompts.length <= 1}
            onPress={() => {
              const index = draft.multiPrompts.findIndex((shot) => shot.id === selectedShot.id);
              const nextShots = draft.multiPrompts.filter((shot) => shot.id !== selectedShot.id);
              onChange({ ...draft, multiPrompts: nextShots });
              setSelectedId(nextShots[Math.max(0, index - 1)]?.id ?? nextShots[0]?.id ?? '');
            }}
            style={({ pressed }) => ({ width: 48, height: 48, position: 'absolute', right: 6, top: 6, borderRadius: 24, backgroundColor: pressed ? theme.colors.pressed : hexWithAlpha(theme.colors.surfaceInset, 0.78), alignItems: 'center', justifyContent: 'center', opacity: draft.multiPrompts.length <= 1 ? 0.35 : 1 })}
          >
            <Trash2 size={17} color={theme.colors.muted} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function VideoCreatorComposer({
  draft,
  model,
  promptFocusRequest,
  isEnhancing,
  isUploading,
  promptMessage,
  validationErrors,
  onPromptChange,
  onEnhance,
  onEnhanceShot,
  shotNotes,
  enhanceLevel,
  onEnhanceLevelChange,
  canUndoEnhance,
  onUndoEnhance,
  onChange,
  onUploadImages,
  onUploadStart,
  onUploadEnd,
  onUploadVideo,
  onUploadAudio,
  onAddSubject,
  upload,
  onCancelUpload,
  promptNotes,
  onReplaceReference,
  replacingReferenceId,
  preparingAssetId,
  onPrepareSeedanceAsset,
  onRefreshSeedanceAsset,
  onReferenceNotice,
  onFocus,
  onBlur,
  onMentionStateChange,
}: {
  draft: VideoCreationDraft;
  model: CreatorCatalogModel | null;
  /** Bumped to put the cursor in the prompt, after a refusal of what it says. */
  promptFocusRequest: number;
  isEnhancing: boolean;
  isUploading: boolean;
  promptMessage: string | null;
  validationErrors: string[];
  onPromptChange: (prompt: string) => void;
  onEnhance: () => void;
  /** A multi-shot run's Enhance for one shot. */
  onEnhanceShot: (shotId: string) => void;
  shotNotes: ShotEnhancementNotes | null;
  enhanceLevel: PromptEnhancementLevel;
  onEnhanceLevelChange: (level: PromptEnhancementLevel) => void;
  canUndoEnhance: boolean;
  onUndoEnhance: () => void;
  onChange: (draft: VideoCreationDraft) => void;
  onUploadImages: () => void;
  onUploadStart: () => void;
  onUploadEnd: () => void;
  onUploadVideo: () => void;
  onUploadAudio: () => void;
  onAddSubject: () => void;
  /** An upload in flight, shown on the control it came from. */
  upload: UploadProgress | null;
  onCancelUpload: () => void;
  promptNotes: PromptEnhancementWarning[];
  onReplaceReference: (id: string) => void;
  replacingReferenceId: string | null;
  /** The reference whose Seedance asset is being prepared or checked. */
  preparingAssetId: string | null;
  onPrepareSeedanceAsset: (id: string) => void;
  onRefreshSeedanceAsset: (id: string) => void;
  onReferenceNotice: (message: string | null) => void;
  onFocus: () => void;
  onBlur: () => void;
  onMentionStateChange: (active: boolean) => void;
}) {
  const theme = useAppTheme();
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const initialSelection = { start: draft.prompt.length, end: draft.prompt.length };
  const [promptSelection, setPromptSelection] = useState<TextSelection>(initialSelection);
  const [promptFocused, setPromptFocused] = useState(false);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null);
  const promptInputRef = useRef<TextInput>(null);
  const promptTextRef = useRef(draft.prompt);
  const lastPromptSelectionRef = useRef<TextSelection>(initialSelection);
  const restoringSelectionRef = useRef<TextSelection | null>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supportsStartFrame = catalogInputSupported(
    model,
    draft,
    'startFrame',
    Boolean(model?.inputs.startFrame),
  );
  const supportsEndFrame = catalogInputSupported(
    model,
    draft,
    'endFrame',
    Boolean(model?.inputs.endFrame),
  );
  const startFrameSlot = catalogInputSlot(model, draft, 'startFrame');
  const endFrameSlot = catalogInputSlot(model, draft, 'endFrame');
  const supportsFrames = supportsStartFrame || supportsEndFrame;
  const referenceMode = videoRunReferenceMode(draft, model);
  const railShape = referenceRailShape(draft, model);
  const supportsReusable = supportsReusableVideoInputs(model, draft, railShape);
  // A frame the run's shape leaves out while it sends the other (Wan 2.7 takes a start frame
  // beside references, and no end frame): its slot takes none, and one held waits apart with the
  // run's other leftovers (standbyVideoReferences).
  const runSlotRoles = new Set(model?.inputModes ? catalogRunSlots(draft, model).map(({ slot }) => slot.role) : []);
  const runTakesFrames = runSlotRoles.has('startFrame') || runSlotRoles.has('endFrame');
  const startFrameLeftOut = runTakesFrames && !runSlotRoles.has('startFrame');
  const endFrameLeftOut = runTakesFrames && !runSlotRoles.has('endFrame');
  const frameLeftOutHelper = referenceMode === 'elements' ? 'Not with references' : 'Not with these settings';
  // Kie only lets wan-2.7 send a first frame alongside references; Seedance documents the
  // two as mutually exclusive scenarios, and minimax-h3 and kling-o3 route references to
  // an endpoint with no frame field. Both groups stay on screen either way — the one the
  // run cannot use greys out with the reason above it.
  const framesExcludeReferences = supportsFrames
    && supportsReusable
    && modeGatedReferenceSlots(model)
    && model?.inputs.combineFramesWithReferences !== true;
  const hasFrameAttachment = Boolean(draft.startFrame || draft.endFrame);
  // A references run, as the model reads the draft: a reference kept from another model,
  // which this one takes nowhere, is not one and must not lock this model's frames.
  const hasReferenceAttachment = referenceMode === 'elements';
  // Only ever lock the empty side. A restored draft can hold both — the previous surface
  // kept the frames while you worked in references — and locking each against the other
  // leaves a panel where nothing can be removed, so nothing can be unlocked either.
  const framesLockedByReferences = framesExcludeReferences && hasReferenceAttachment && !hasFrameAttachment;
  const referencesLockedByFrames = framesExcludeReferences && hasFrameAttachment && !hasReferenceAttachment;
  const framesAndReferencesConflict = framesExcludeReferences && hasFrameAttachment && hasReferenceAttachment;
  // Named subjects, where the model's descriptor publishes a slot for them. They replace
  // frames and references for the run, as the server's quote reads them, so the same
  // empty-side locks hold between the subjects group and the other two.
  const subjectSlot = catalogSubjectSlot(model);
  const subjects = videoSubjects(draft);
  const maxSubjects = subjectSlot ? subjectsPerRun(subjectSlot) : 0;
  const subjectsAttached = subjects.length > 0;
  const framesLockedBySubjects = subjectsAttached && !hasFrameAttachment;
  const referencesLockedBySubjects = subjectsAttached && !hasReferenceAttachment;
  const subjectsLockedByOthers = !subjectsAttached && (hasFrameAttachment || hasReferenceAttachment);
  const subjectsConflict = subjectsAttached && (hasFrameAttachment || hasReferenceAttachment);
  const subjectModeLabel = model?.inputModes?.find((mode) => (
    mode.slots.some((slot) => slot.key === subjectSlot?.key)
  ))?.label ?? 'Named subjects';
  const imageLimit = catalogInputLimit(
    model,
    draft,
    'imageReferences',
    model?.inputs.imageReferences?.max ?? 0,
    railShape,
  );
  const videoLimit = model?.inputModes
    ? referenceVideoSlot(model, draft, railShape)?.max ?? 0
    : model?.inputs.videoReferences?.max ?? 0;
  // Held for another model, or past a slot's max: drawn apart, each with its own Remove.
  const standbyReferences = standbyVideoReferences(draft, model);
  const standbyIds = new Set(standbyReferences.map((media) => media.id));
  const isSent = (media: MediaDraft) => !standbyIds.has(media.id);
  const referenceLimitMessage = validationErrors.find(isReferenceLimitError) ?? null;
  // The handles a run on this model may name: those it sends, as the server refuses the rest.
  const runHandles = new Set(model
    ? catalogDraftRunHandles({ ...draft, referenceMode }, model)
    : videoDraftHandles(draft));
  const audioLimit = catalogInputLimit(
    model,
    draft,
    'audioReferences',
    model?.inputs.audioReferences?.max ?? 0,
    railShape,
  );
  const preparedVoiceLimit = catalogInputLimit(
    model,
    draft,
    'preparedVoices',
    model?.inputs.preparedAudioReferences?.max ?? 0,
    railShape,
  );
  const characterLimit = catalogInputLimit(
    model,
    draft,
    'characters',
    model?.inputs.characterReferences?.max ?? 0,
    railShape,
  );
  const frameModeLabel = model?.inputModes?.find((mode) => (
    mode.slots.some((slot) => slot.role === 'startFrame' || slot.role === 'endFrame')
  ))?.label ?? 'Frames';
  const reusableModeLabel = model?.inputModes?.find((mode) => (
    mode.slots.some((slot) => slot.role === 'reference')
  ))?.label ?? 'Reusable';
  // A subject opens the same details sheet a reference does, wearing a reference's
  // shape: its first picture under its own id, name and handle, with its other
  // pictures beside it.
  const selectedSubject = subjects.find((subject) => subject.id === referenceId) ?? null;
  const selectedReference = selectedSubject
    ? subjectAsReference(selectedSubject)
    : [
      ...draft.references,
      ...draft.referenceVideos,
      draft.startFrame,
      draft.endFrame,
    ].find((media): media is MediaDraft => Boolean(media && media.id === referenceId)) ?? null;
  // Only the Seedance 2 family takes a prepared asset, and only for a reusable
  // reference: frames and subjects travel as links.
  const preparesSeedanceAssets = supportsReusable && model !== null && isSeedance2VideoModelId(model.id);
  const selectedPreparableReference = preparesSeedanceAssets && selectedReference && !selectedSubject
    && [...draft.references, ...draft.referenceVideos].some((media) => media.id === selectedReference.id)
    ? selectedReference
    : null;
  const detectedMention = useMemo(
    () => !draft.isMultiShot && promptFocused ? findActiveReferenceMention(draft.prompt, promptSelection) : null,
    [draft.isMultiShot, draft.prompt, promptFocused, promptSelection],
  );
  const mentionKey = detectedMention ? `${draft.prompt}:${promptSelection.start}:${promptSelection.end}` : null;
  const activeMention = detectedMention && mentionKey !== dismissedMentionKey ? detectedMention : null;
  const mentionReferences = useMemo(() => {
    if (!activeMention) return [];
    const query = activeMention.query.toLowerCase();
    const namedReferences = [...draft.references, ...draft.referenceVideos, ...subjects.map(subjectAsReference)];
    return namedReferences.filter((media) => media.handle && runHandles.has(media.handle) && (
      media.handle.slice(1).toLowerCase().includes(query) || media.displayName.toLowerCase().includes(query)
    ));
  }, [activeMention, draft.referenceVideos, draft.references, runHandles, subjects]);

  useEffect(() => {
    promptTextRef.current = draft.prompt;
    const normalized = normalizeTextSelection(draft.prompt, lastPromptSelectionRef.current);
    lastPromptSelectionRef.current = normalized;
    setPromptSelection(normalized);
  }, [draft.prompt]);

  useEffect(() => () => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
  }, []);

  useEffect(() => {
    onMentionStateChange(Boolean(activeMention));
    return () => onMentionStateChange(false);
  }, [activeMention, onMentionStateChange]);

  useEffect(() => {
    if (promptFocusRequest > 0) promptInputRef.current?.focus();
  }, [promptFocusRequest]);

  const restorePromptFocus = (delay = 0) => {
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    focusTimerRef.current = setTimeout(() => {
      promptInputRef.current?.focus();
      promptInputRef.current?.setNativeProps({ selection: lastPromptSelectionRef.current });
      focusTimerRef.current = null;
    }, delay);
  };

  const insertReferenceHandle = (handle: string, selection: TextSelection, focusDelay = 0) => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    if (promptContainsHandle(promptTextRef.current, handle)) {
      setPromptFocused(true);
      restorePromptFocus(focusDelay);
      return;
    }
    const result = insertHandleAtSelection(promptTextRef.current, handle, selection);
    promptTextRef.current = result.text;
    lastPromptSelectionRef.current = result.selection;
    restoringSelectionRef.current = result.selection;
    setPromptSelection(result.selection);
    setDismissedMentionKey(`${result.text}:${result.selection.start}:${result.selection.end}`);
    setPromptFocused(true);
    onPromptChange(result.text);
    restorePromptFocus(focusDelay);
  };

  // Whether the words the run reads name a handle: a single shot's prompt, or a story's shots.
  const runTextNames = (handle?: string | null) => (draft.isMultiShot
    ? draft.multiPrompts.some((shot) => promptContainsHandle(shot.prompt, handle))
    : promptContainsHandle(draft.prompt, handle));
  // Those words with a reference's @handle renamed, or taken out when it is removed.
  const withMentionReplaced = (handle: string, replacement = '') => (draft.isMultiShot
    ? { multiPrompts: draft.multiPrompts.map((shot) => (promptContainsHandle(shot.prompt, handle) ? { ...shot, prompt: replacePromptHandle(shot.prompt, handle, replacement) } : shot)) }
    : { prompt: replacePromptHandle(draft.prompt, handle, replacement) });

  const renameSelectedReference = (displayName: string) => {
    if (!selectedReference) return;
    if (selectedSubject) {
      const renamedSubject = renameSubjectDraft(selectedSubject, displayName, videoDraftHandles(draft));
      onChange({
        ...draft,
        ...(runTextNames(selectedSubject.handle) ? withMentionReplaced(selectedSubject.handle, renamedSubject.handle) : {}),
        subjects: subjects.map((subject) => (subject.id === selectedSubject.id ? renamedSubject : subject)),
      });
      return;
    }
    const nextName = renameMediaDraft(selectedReference, displayName);
    // Two references renamed alike would otherwise answer to one @mention.
    const renamed = nextName.handle
      ? withUniqueReferenceHandle(nextName, [...draft.references, ...draft.referenceVideos, ...subjects.map(subjectAsReference)]
        .filter((media) => media.id !== selectedReference.id))
      : nextName;
    const withRenamed = (items: MediaDraft[]) => items.map((media) => (media.id === selectedReference.id ? renamed : media));
    const mention = selectedReference.handle && runTextNames(selectedReference.handle)
      ? withMentionReplaced(selectedReference.handle, renamed.handle ?? '')
      : {};
    if (draft.references.some((media) => media.id === selectedReference.id)) {
      onChange({ ...draft, ...mention, references: withRenamed(draft.references) });
      return;
    }
    if (draft.referenceVideos.some((media) => media.id === selectedReference.id)) {
      onChange({ ...draft, ...mention, referenceVideos: withRenamed(draft.referenceVideos) });
      return;
    }
    if (draft.startFrame?.id === selectedReference.id) onChange({ ...draft, startFrame: renameMediaDraft(selectedReference, displayName) });
    if (draft.endFrame?.id === selectedReference.id) onChange({ ...draft, endFrame: renameMediaDraft(selectedReference, displayName) });
  };

  // A reference, clip or track, with its @handle taken out of the words the run reads. A frame
  // waiting apart goes as its own slot's Remove takes it.
  const removeReference = (media: MediaDraft) => {
    if (draft.startFrame?.id === media.id || draft.endFrame?.id === media.id) {
      onReferenceNotice(`${media.displayName} was removed from this draft.`);
      onChange({
        ...draft,
        startFrame: draft.startFrame?.id === media.id ? null : draft.startFrame,
        endFrame: draft.endFrame?.id === media.id ? null : draft.endFrame,
      });
      return;
    }
    const handleUsed = runTextNames(media.handle);
    onReferenceNotice(handleUsed && media.handle
      ? `${media.displayName} and ${media.handle} were removed from this draft.`
      : `${media.displayName} was removed from this draft.`);
    const without = (items: MediaDraft[]) => items.filter((item) => item.id !== media.id);
    onChange({
      ...draft,
      ...(handleUsed && media.handle ? withMentionReplaced(media.handle) : {}),
      references: without(draft.references),
      referenceVideos: without(draft.referenceVideos),
      referenceAudios: without(draft.referenceAudios),
    });
  };

  const removeSelectedReference = () => {
    if (!selectedReference) return;
    if (selectedSubject) {
      const handleUsed = runTextNames(selectedSubject.handle);
      onReferenceNotice(handleUsed
        ? `${selectedSubject.displayName} and ${selectedSubject.handle} were removed from this draft.`
        : `${selectedSubject.displayName} was removed from this draft.`);
      onChange({
        ...draft,
        ...(handleUsed ? withMentionReplaced(selectedSubject.handle) : {}),
        subjects: subjects.filter((subject) => subject.id !== selectedSubject.id),
      });
    } else if ([...draft.references, ...draft.referenceVideos].some((media) => media.id === selectedReference.id)) {
      removeReference(selectedReference);
    } else if (draft.startFrame?.id === selectedReference.id) {
      onChange({ ...draft, startFrame: null });
    } else if (draft.endFrame?.id === selectedReference.id) {
      onChange({ ...draft, endFrame: null });
    }
    setReferenceId(null);
  };

  const frameError = validationErrors.find((error) => /start image|start frame|end frame/i.test(error));

  return (
    <View testID="video-creator-composer" style={{ gap: 12 }}>
      {model?.capabilities.multiShot ? (
        <View testID="video-shot-mode" style={{ minHeight: 48, borderRadius: 18, backgroundColor: theme.colors.surfaceStrong, padding: 4, flexDirection: 'row', gap: 4 }}>
          {[
            { label: 'Single shot', value: false },
            { label: 'Multi-shot', value: true },
          ].map((option) => (
            <Pressable
              key={option.label}
              accessibilityRole="button"
              accessibilityLabel={option.label}
              accessibilityState={{ selected: draft.isMultiShot === option.value }}
              onPress={() => onChange({ ...draft, isMultiShot: option.value, referenceMode: option.value ? 'frames' : draft.referenceMode })}
              hitSlop={verticalHitSlop(40)}
              style={({ pressed }) => ({ flex: 1, minHeight: 40, borderRadius: 14, backgroundColor: draft.isMultiShot === option.value ? hexWithAlpha(theme.colors.image, 0.14) : pressed ? theme.colors.pressed : 'transparent', alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
            >
              <Text style={{ color: draft.isMultiShot === option.value ? theme.colors.text : theme.colors.muted, fontSize: 12, fontWeight: '800' }}>{option.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {draft.isMultiShot ? (
        <CompactShotEditor
          draft={draft}
          model={model}
          isEnhancing={isEnhancing}
          promptMessage={promptMessage}
          notes={shotNotes}
          onEnhanceShot={onEnhanceShot}
          onChange={onChange}
          onFocus={onFocus}
          onBlur={onBlur}
        />
      ) : (
        <View style={{ borderRadius: 28, borderCurve: 'continuous', borderWidth: 1, borderColor: hexWithAlpha(theme.colors.image, 0.2), backgroundColor: theme.colors.panel, overflow: 'hidden' }}>
          <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 }}>
            <Text style={{ color: theme.colors.video, fontSize: 11, fontWeight: '900', letterSpacing: 1, textTransform: 'uppercase' }}>Prompt</Text>
          </View>
          <TextInput
            maxLength={GENERATION_PROMPT_MAX_LENGTH}
            ref={promptInputRef}
            testID="video-prompt-input"
            accessibilityLabel="Generation prompt"
            value={draft.prompt}
            onChangeText={(prompt) => {
              if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
              setPromptFocused(true);
              setDismissedMentionKey(null);
              promptTextRef.current = prompt;
              onPromptChange(prompt);
            }}
            onSelectionChange={(event) => {
              const selection = normalizeTextSelection(promptTextRef.current, event.nativeEvent.selection);
              const restored = restoringSelectionRef.current?.start === selection.start && restoringSelectionRef.current.end === selection.end;
              lastPromptSelectionRef.current = selection;
              setPromptSelection(selection);
              if (!restored) setDismissedMentionKey(null);
              if (restored) restoringSelectionRef.current = null;
            }}
            multiline
            scrollEnabled
            textAlignVertical="top"
            placeholder="Describe action, camera movement, lighting, pace, and sound…"
            placeholderTextColor={theme.colors.faint}
            onFocus={() => {
              if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
              setPromptFocused(true);
              onFocus();
            }}
            onBlur={() => {
              onBlur();
              if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
              blurTimerRef.current = setTimeout(() => setPromptFocused(false), 160);
            }}
            style={{ height: 188, color: theme.colors.text, fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 28 }}
          />
          <PromptLengthCounter meter={catalogPromptMeters(draft, model).prompt} />
          {promptMessage ? <Text accessibilityRole="alert" style={{ color: theme.colors.danger, fontSize: 12, fontWeight: '700', paddingHorizontal: 16, paddingBottom: 11 }}>{promptMessage}</Text> : null}
          <PromptQualityNotes warnings={promptNotes} />
        </View>
      )}

      {activeMention ? (
        <ReferenceMentionSuggestions references={mentionReferences} prompt={draft.prompt} query={activeMention.query} onSelect={(handle) => insertReferenceHandle(handle, activeMention)} />
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'stretch', gap: 8 }}>
        <ComposerToolbarButton icon={<Layers size={15} color={theme.colors.muted} />} label="Templates" onPress={() => router.push('/templates' as never)} quiet />
        <ComposerToolbarButton icon={<Wand2 size={16} color={theme.colors.primary} />} {...enhanceButtonLabels('Enhance', isEnhancing)} onPress={onEnhance} disabled={isEnhancing || draft.isMultiShot} accent />
      </View>

        <EnhanceControlsRow
          level={enhanceLevel}
          onLevelChange={onEnhanceLevelChange}
          canUndo={canUndoEnhance}
          onUndo={onUndoEnhance}
          disabled={isEnhancing}
        />

      <View testID="video-reference-section" style={{ borderRadius: 24, borderCurve: 'continuous', borderWidth: 1, borderColor: hexWithAlpha(theme.colors.image, 0.13), backgroundColor: theme.colors.panel, padding: 14, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <View style={{ gap: 2 }}>
            <Text style={{ color: theme.colors.text, fontSize: 12, fontWeight: '800' }}>{draft.isMultiShot ? 'Story inputs' : 'Visual inputs'}</Text>
            <Text style={{ color: theme.colors.muted, fontSize: 11 }}>
              {subjectsConflict
                ? `Clear frames and references — this run will use ${subjectModeLabel.toLowerCase()}`
                : framesLockedBySubjects || referencesLockedBySubjects
                ? `${subjectModeLabel} replace frames and references`
                : framesAndReferencesConflict
                ? `Clear one — this run will use ${reusableModeLabel.toLowerCase()}`
                : framesLockedByReferences
                ? `${frameModeLabel} unavailable with references attached`
                : referencesLockedByFrames
                  ? `${reusableModeLabel} unavailable with frames attached`
                  : framesExcludeReferences
                    ? `${frameModeLabel} or ${reusableModeLabel} — one per run`
                    : draft.isMultiShot
                      ? supportsReusable ? `Start frame and ${reusableModeLabel.toLowerCase()} for the story` : 'Start frame for the story'
                      : 'Frames and references'}
            </Text>
          </View>
        </View>

        {supportsFrames ? (
          <View
            pointerEvents={framesLockedByReferences || framesLockedBySubjects ? 'none' : 'auto'}
            style={{ gap: 6, opacity: framesLockedByReferences || framesLockedBySubjects ? 0.4 : 1 }}
          >
            <View testID="video-frame-slots" style={{ flexDirection: 'row', gap: 9 }}>
              {supportsStartFrame ? (
                <CompactReferenceSlot testID="video-start-frame-slot" title={startFrameSlot?.label ?? 'Start frame'} helper={startFrameLeftOut ? frameLeftOutHelper : 'First visual'} media={startFrameLeftOut ? null : draft.startFrame} required={(startFrameSlot?.min ?? (model?.id === 'hailuo-2.3' ? 1 : 0)) > 0} disabled={startFrameLeftOut} isUploading={isUploading} progress={upload?.target === 'start-frame' ? upload : null} onAdd={onUploadStart} onOpen={() => setReferenceId(draft.startFrame?.id ?? null)} />
              ) : null}
              {supportsEndFrame ? (
                <CompactReferenceSlot
                  testID="video-end-frame-slot"
                  title={endFrameSlot?.label ?? 'End frame'}
                  helper={endFrameLeftOut ? frameLeftOutHelper : draft.isMultiShot ? 'Single shot only' : 'Optional finish'}
                  media={endFrameLeftOut ? null : draft.endFrame}
                  required={(endFrameSlot?.min ?? 0) > 0}
                  disabled={endFrameLeftOut || (draft.isMultiShot && !draft.endFrame)}
                  isUploading={isUploading}
                  progress={upload?.target === 'end-frame' ? upload : null}
                  onAdd={onUploadEnd}
                  onOpen={() => setReferenceId(draft.endFrame?.id ?? null)}
                />
              ) : null}
            </View>
            {frameError ? <Text accessibilityRole="alert" style={{ color: theme.colors.amber, fontSize: 11, fontWeight: '700', lineHeight: 15 }}>{frameError}</Text> : null}
          </View>
        ) : null}

        {supportsReusable ? (
          <View
            testID="video-reusable-reference-rail"
            pointerEvents={referencesLockedByFrames || referencesLockedBySubjects ? 'none' : 'auto'}
            style={{ gap: 10, opacity: referencesLockedByFrames || referencesLockedBySubjects ? 0.4 : 1 }}
          >
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 9, paddingRight: 6 }}>
              {draft.references.filter(isSent).map((media) => (
                <Pressable key={media.id} accessibilityRole="button" accessibilityLabel={`Open details for ${mediaAccessibleName(media)}`} onPress={() => setReferenceId(media.id)} style={({ pressed }) => ({ width: 72, gap: 5, opacity: pressed ? appTheme.opacity.pressed : 1 })}>
                  <ReferenceMediaPreview media={media} size={72} />
                  <Text numberOfLines={1} style={{ color: theme.colors.muted, fontSize: 11, fontWeight: '700', textAlign: 'center' }}>{media.displayName}</Text>
                </Pressable>
              ))}
              {draft.referenceVideos.filter(isSent).map((media) => (
                <Pressable key={media.id} accessibilityRole="button" accessibilityLabel={`Open details for ${mediaAccessibleName(media)}`} onPress={() => setReferenceId(media.id)} style={({ pressed }) => ({ width: 72, gap: 5, opacity: pressed ? appTheme.opacity.pressed : 1 })}>
                  <ReferenceMediaPreview media={media} size={72} />
                  <Text numberOfLines={1} style={{ color: theme.colors.muted, fontSize: 11, fontWeight: '700', textAlign: 'center' }}>{media.displayName}</Text>
                </Pressable>
              ))}
              {draft.referenceAudios.filter(isSent).map((media) => (
                <View key={media.id} style={{ width: 72, gap: 4 }}>
                  <ReferenceMediaPreview media={media} size={72} />
                  <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${mediaAccessibleName(media)}`} onPress={() => onChange({ ...draft, referenceAudios: draft.referenceAudios.filter((item) => item.id !== media.id) })} style={({ pressed }) => ({ minHeight: 48, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}>
                    <Text style={{ color: theme.colors.danger, fontSize: 11, fontWeight: '800' }}>Remove</Text>
                  </Pressable>
                  {preparesSeedanceAssets ? (
                    /* An audio tile opens no details sheet, so its Seedance asset is prepared from the tile. */
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${seedanceAssetActionLabel(media.seedanceAsset ?? null, preparingAssetId === media.id)} for ${mediaAccessibleName(media)}`}
                      accessibilityState={{ disabled: preparingAssetId === media.id }}
                      disabled={preparingAssetId === media.id}
                      onPress={() => (media.seedanceAsset?.status === 'processing' ? onRefreshSeedanceAsset(media.id) : onPrepareSeedanceAsset(media.id))}
                      style={({ pressed }) => ({ minHeight: 48, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
                    >
                      <Text numberOfLines={1} style={{ color: media.seedanceAsset?.status === 'failed' ? theme.colors.danger : media.seedanceAsset?.status === 'active' ? theme.colors.image : theme.colors.textSecondary, fontSize: 11, fontWeight: '800' }}>
                        {seedanceAssetTileLabel(media.seedanceAsset ?? null, preparingAssetId === media.id)}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
              {imageLimit > 0 ? <CompactRailAddButton label={`Images ${draft.references.length}/${imageLimit}`} onPress={onUploadImages} disabled={isUploading || draft.references.length >= imageLimit} progress={upload?.target === 'image-references' ? upload : null} /> : null}
              {videoLimit > 0 ? <CompactRailAddButton label={`Video ${draft.referenceVideos.length}/${videoLimit}`} onPress={onUploadVideo} disabled={isUploading || draft.referenceVideos.length >= videoLimit} icon="video" progress={upload?.target === 'reference-video' ? upload : null} /> : null}
              {audioLimit > 0 ? <CompactRailAddButton label={`Audio ${draft.referenceAudios.length}/${audioLimit}`} onPress={onUploadAudio} disabled={isUploading || draft.referenceAudios.length >= audioLimit} icon="audio" progress={upload?.target === 'reference-audio' ? upload : null} /> : null}
            </ScrollView>
            {upload?.target === 'reference-video' && upload.cancellable ? <UploadCancelButton onPress={onCancelUpload} /> : null}
            {preparesSeedanceAssets ? (
              <Text style={{ color: theme.colors.muted, fontSize: 11 }}>
                Open a reference to prepare it with Seedance once. Every run then reuses the prepared asset instead of sending the file again.
              </Text>
            ) : null}
            {preparedVoiceLimit > 0 ? (
              <PreparedReferenceIds title="Prepared voice IDs" accessibilityLabel="Prepared voice ID" placeholder="Paste prepared voice ID" items={draft.preparedAudioIds} max={preparedVoiceLimit} onChange={(items) => onChange({ ...draft, preparedAudioIds: items })} />
            ) : null}
            {characterLimit > 0 ? (
              <PreparedReferenceIds title="Prepared character IDs" accessibilityLabel="Prepared character ID" placeholder="Paste prepared character ID" items={draft.characterIds} max={characterLimit} onChange={(items) => onChange({ ...draft, characterIds: items })} />
            ) : null}
          </View>
        ) : null}

        {subjectSlot ? (
          <View
            testID="video-subjects-group"
            pointerEvents={subjectsLockedByOthers ? 'none' : 'auto'}
            style={{ gap: 8, opacity: subjectsLockedByOthers ? 0.4 : 1 }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <Text style={{ color: theme.colors.muted, fontSize: 11, fontWeight: '700' }}>{subjectModeLabel}</Text>
              <Text style={{ color: theme.colors.faint, fontSize: 11, fontWeight: '700' }}>{subjects.length} / {maxSubjects}</Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 9, paddingRight: 6 }}>
              {subjects.map((subject) => (
                <Pressable key={subject.id} accessibilityRole="button" accessibilityLabel={`Open details for ${subject.displayName}, ${subject.handle}`} onPress={() => setReferenceId(subject.id)} style={({ pressed }) => ({ width: 72, gap: 4, opacity: pressed ? appTheme.opacity.pressed : 1 })}>
                  <SubjectPreview subject={subject} size={72} />
                  <Text numberOfLines={1} style={{ color: theme.colors.muted, fontSize: 11, fontWeight: '700', textAlign: 'center' }}>{subject.displayName}</Text>
                </Pressable>
              ))}
              {subjects.length < maxSubjects ? (
                <CompactRailAddButton label={`Subject ${subjects.length}/${maxSubjects}`} onPress={onAddSubject} disabled={isUploading} progress={upload?.target === 'subject' ? upload : null} />
              ) : null}
            </ScrollView>
            <Text style={{ color: theme.colors.muted, fontSize: 11 }}>
              {`${SUBJECT_IMAGES_PER_NAME.min} to ${SUBJECT_IMAGES_PER_NAME.max} pictures of one person or thing, mentioned in the prompt as @name.`}
            </Text>
          </View>
        ) : null}

        {supportsFrames || supportsReusable || subjectSlot ? null : (
          <Text style={{ color: theme.colors.muted, fontSize: 11 }}>This model creates from text without reference media.</Text>
        )}

        <StandbyReferences references={standbyReferences} message={referenceLimitMessage} onRemove={removeReference} />
      </View>

      <ReferenceDetailsOverlay
        media={selectedReference}
        gallery={selectedSubject?.images ?? null}
        noun={selectedSubject ? 'subject' : 'reference'}
        handleUsedInPrompt={runTextNames(selectedReference?.handle)}
        onClose={() => setReferenceId(null)}
        onRename={renameSelectedReference}
        // A story's prompt is its shots: the single shot's prompt an insert would write into is hidden.
        onUseHandle={selectedReference && !draft.isMultiShot && (selectedSubject !== null || Boolean(selectedReference.handle && runHandles.has(selectedReference.handle)))
          ? (handle) => {
              insertReferenceHandle(handle, lastPromptSelectionRef.current, 280);
              setReferenceId(null);
            }
          : undefined}
        onReplace={selectedReference && draft.references.some((media) => media.id === selectedReference.id)
          ? () => onReplaceReference(selectedReference.id)
          : undefined}
        isReplacing={selectedReference != null && replacingReferenceId === selectedReference.id}
        asset={selectedPreparableReference ? selectedPreparableReference.seedanceAsset ?? null : undefined}
        isPreparingAsset={selectedPreparableReference != null && preparingAssetId === selectedPreparableReference.id}
        onPrepareAsset={selectedPreparableReference ? () => onPrepareSeedanceAsset(selectedPreparableReference.id) : undefined}
        onRefreshAsset={selectedPreparableReference ? () => onRefreshSeedanceAsset(selectedPreparableReference.id) : undefined}
        onRemove={removeSelectedReference}
      />
    </View>
  );
}

function CompactRailAddButton({ label, icon = 'image', onPress, disabled, progress = null }: {
  label: string;
  icon?: 'image' | 'video' | 'audio';
  onPress: () => void;
  disabled: boolean;
  /** The upload this button started, whose progress it shows in place of its label. */
  progress?: UploadProgress | null;
}) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={progress ? `Uploading ${label}, ${uploadPercentLabel(progress)}` : `Add ${label}`}
      accessibilityState={{ disabled, busy: Boolean(progress) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ width: 80, minHeight: 96, borderRadius: 16, borderWidth: 1, borderStyle: 'dashed', borderColor: hexWithAlpha(theme.colors.image, 0.38), backgroundColor: hexWithAlpha(theme.colors.image, 0.055), alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 6, opacity: progress ? 1 : disabled ? 0.38 : pressed ? appTheme.opacity.pressed : 1 })}
    >
      {progress
        ? <ActivityIndicator color={theme.colors.image} size="small" />
        : icon === 'video' ? <Video size={20} color={theme.colors.video} /> : icon === 'audio' ? <AudioLines size={20} color={theme.colors.motion} /> : <Plus size={21} color={theme.colors.image} />}
      <Text numberOfLines={2} style={{ color: theme.colors.muted, fontSize: 11, fontWeight: '800', lineHeight: 14, textAlign: 'center', fontVariant: ['tabular-nums'] }}>{progress ? uploadPercentLabel(progress) : label}</Text>
    </Pressable>
  );
}

/** Stops a clip's upload: a clip can run to 250 MB, minutes on mobile data. */
function UploadCancelButton({ onPress }: { onPress: () => void }) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Cancel upload"
      onPress={onPress}
      style={({ pressed }) => ({ minHeight: 44, alignSelf: 'flex-start', paddingHorizontal: 14, borderRadius: appTheme.radii.pill, borderWidth: 1, borderColor: hexWithAlpha(theme.colors.danger, 0.34), alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
    >
      <Text style={{ color: theme.colors.danger, fontSize: 12, fontWeight: '800' }}>Cancel upload</Text>
    </Pressable>
  );
}

/**
 * References a draft keeps that this run does not send: past a slot's max, or of a kind this
 * model or mode takes none of. A model change keeps them, as the web creator does, so they
 * wait here, each with its own Remove, and an excess that blocks Generate says why beside them.
 */
function StandbyReferences({
  references,
  message,
  onRemove,
}: {
  references: MediaDraft[];
  message: string | null;
  onRemove: (media: MediaDraft) => void;
}) {
  const theme = useAppTheme();
  if (references.length === 0) return null;
  return (
    <View testID="standby-references" style={{ gap: 8 }}>
      <View style={{ gap: 2 }}>
        <Text style={{ color: theme.colors.muted, fontSize: 11, fontWeight: '700' }}>Not sent with this run</Text>
        {message ? <Text accessibilityRole="alert" style={{ color: theme.colors.amber, fontSize: 11, fontWeight: '700', lineHeight: 15 }}>{message}</Text> : null}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 9, paddingRight: 6 }}>
        {references.map((media) => (
          <View key={media.id} style={{ width: 72, gap: 4 }}>
            <View style={{ opacity: 0.45 }}>
              <ReferenceMediaPreview media={media} size={72} />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${mediaAccessibleName(media)}`}
              onPress={() => onRemove(media)}
              style={({ pressed }) => ({ minHeight: 48, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
            >
              <Text style={{ color: theme.colors.danger, fontSize: 11, fontWeight: '800' }}>Remove</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

/** Web's note for a model that takes no reference images, drawn where the rail would be. */
function PromptOnlyNote({ modelName }: { modelName: string }) {
  const theme = useAppTheme();
  return (
    <View testID="prompt-only-note" style={{ gap: 3 }}>
      <Text style={{ color: theme.colors.text, fontSize: 12, fontWeight: '800' }}>Prompt-only model</Text>
      <Text style={{ color: theme.colors.muted, fontSize: 11, lineHeight: 15 }}>
        {`${modelName} does not accept reference images. Switch models whenever you need identity, product, or style anchors.`}
      </Text>
    </View>
  );
}

function MotionCreatorComposer({
  draft,
  model,
  promptFocusRequest,
  isEnhancing,
  isUploading,
  promptMessage,
  validationErrors,
  onPromptChange,
  onEnhance,
  enhanceLevel,
  onEnhanceLevelChange,
  canUndoEnhance,
  onUndoEnhance,
  onChange,
  onUploadCharacter,
  onUploadMotion,
  upload,
  onCancelUpload,
  promptNotes,
  onFocus,
  onBlur,
}: {
  draft: MotionCreationDraft;
  model: CreatorCatalogModel | null;
  /** Bumped to put the cursor in the prompt, after a refusal of what it says. */
  promptFocusRequest: number;
  isEnhancing: boolean;
  isUploading: boolean;
  promptMessage: string | null;
  validationErrors: string[];
  onPromptChange: (prompt: string) => void;
  onEnhance: () => void;
  enhanceLevel: PromptEnhancementLevel;
  onEnhanceLevelChange: (level: PromptEnhancementLevel) => void;
  canUndoEnhance: boolean;
  onUndoEnhance: () => void;
  onChange: (draft: MotionCreationDraft) => void;
  onUploadCharacter: () => void;
  /** Picks a clip; with one attached, the new one takes its place. */
  onUploadMotion: () => void;
  /** An upload in flight, shown on the slot it came from. */
  upload: UploadProgress | null;
  onCancelUpload: () => void;
  promptNotes: PromptEnhancementWarning[];
  onFocus: () => void;
  onBlur: () => void;
}) {
  const theme = useAppTheme();
  const promptInputRef = useRef<TextInput>(null);
  useEffect(() => {
    if (promptFocusRequest > 0) promptInputRef.current?.focus();
  }, [promptFocusRequest]);
  const [selectedRole, setSelectedRole] = useState<'character' | 'motion' | null>(null);
  const selectedMedia = selectedRole === 'character' ? draft.characterImage : selectedRole === 'motion' ? draft.referenceVideo : null;
  const duration = draft.referenceVideo ? getMotionDuration(draft) : null;
  // The lines under the slots, found by what the slots are called (`catalogMotionDraftSlotLabels`):
  // the draft's checks open a line about a slot with its label, as the slot itself is titled. A line
  // goes under the slot whose label it opens with, the longer label where both do, so a line about
  // a "Reference video" is not also the line of a "Reference".
  const labels = catalogMotionDraftSlotLabels(draft, model);
  const slotNamedBy = (error: string) => [labels.image, labels.video]
    .filter((label) => error.startsWith(`${label} `))
    .sort((a, b) => b.length - a.length)[0];
  const characterError = validationErrors.find((error) => slotNamedBy(error) === labels.image);
  const motionError = validationErrors.find((error) => slotNamedBy(error) === labels.video);
  // The slots the run sends its picture and its clip in, found by kind: Kling 3.0's are plain
  // reference slots, where Kling 2.6 has the motion-inputs pair.
  const slotKeys = catalogMotionDraftSlotKeys(draft, model);
  const characterSlot = catalogInputSlot(model, draft, slotKeys.image);
  const motionSlot = catalogInputSlot(model, draft, slotKeys.video);
  const supportsCharacter = catalogInputSupported(model, draft, slotKeys.image, true);
  const supportsMotion = catalogInputSupported(model, draft, slotKeys.video, true);

  return (
    <View testID="motion-creator-composer" style={{ gap: 12 }}>
      {supportsCharacter || supportsMotion ? <View testID="motion-required-inputs" style={{ borderRadius: 26, borderCurve: 'continuous', borderWidth: 1, borderColor: hexWithAlpha(theme.colors.motion, 0.18), backgroundColor: theme.colors.panel, padding: 14, gap: 12 }}>
        <View style={{ gap: 3 }}>
          <Text style={{ color: theme.colors.motion, fontSize: 11, fontWeight: '900', letterSpacing: 1, textTransform: 'uppercase' }}>Required inputs</Text>
          <Text style={{ color: theme.colors.muted, fontSize: 11, lineHeight: 15 }}>Choose the character to preserve and the movement to transfer.</Text>
        </View>
        {/* Both are required whatever a slot's min says: a motion run starts with both or not at
            all, as the server's start says (Kling 3.0's slots have a min of 0). The panel's title and
            the bar say so; a slot carries no badge, and an empty slot no line of its own. */}
        <View style={{ flexDirection: 'row', gap: 9 }}>
          {supportsCharacter ? <CompactReferenceSlot testID="motion-character-slot" title={characterSlot?.label ?? 'Character image'} helper="Who should move?" media={draft.characterImage} isUploading={isUploading} progress={upload?.target === 'character' ? upload : null} onAdd={onUploadCharacter} onOpen={() => setSelectedRole('character')} /> : null}
          {supportsMotion ? <CompactReferenceSlot testID="motion-video-slot" title={motionSlot?.label ?? 'Motion video'} helper="How should they move?" media={draft.referenceVideo} isUploading={isUploading} progress={upload?.target === 'motion-clip' ? upload : null} onAdd={onUploadMotion} onOpen={() => setSelectedRole('motion')} /> : null}
        </View>
        <View style={{ gap: 4 }}>
          {characterError && draft.characterImage ? <Text accessibilityRole="alert" style={{ color: theme.colors.amber, fontSize: 11, fontWeight: '700' }}>{characterError}</Text> : null}
          {motionError && draft.referenceVideo ? <Text accessibilityRole="alert" style={{ color: theme.colors.amber, fontSize: 11, fontWeight: '700' }}>{motionError}</Text> : null}
          {duration ? <Text style={{ color: theme.colors.textSecondary, fontSize: 11, fontWeight: '700' }}>Detected motion length · {duration}s</Text> : null}
          {upload?.target === 'motion-clip' && upload.cancellable ? (
            <>
              {/* A replacement uploads behind the attached clip, so its progress is said here too. */}
              {draft.referenceVideo ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.textSecondary, fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{`Uploading the new clip · ${uploadPercentLabel(upload)}`}</Text> : null}
              <UploadCancelButton onPress={onCancelUpload} />
            </>
          ) : null}
        </View>
      </View> : null}

      <View style={{ borderRadius: 26, borderCurve: 'continuous', borderWidth: 1, borderColor: hexWithAlpha(theme.colors.motion, 0.16), backgroundColor: theme.colors.panel, overflow: 'hidden' }}>
        <View style={{ paddingHorizontal: 16, paddingTop: 15, paddingBottom: 7 }}>
          <Text style={{ color: theme.colors.motion, fontSize: 11, fontWeight: '900', letterSpacing: 1, textTransform: 'uppercase' }}>Optional direction</Text>
        </View>
        <TextInput
          ref={promptInputRef}
          maxLength={MOTION_PROMPT_MAX_LENGTH}
          testID="motion-prompt-input"
          accessibilityLabel="Optional motion prompt"
          value={draft.prompt}
          onChangeText={onPromptChange}
          multiline
          scrollEnabled
          textAlignVertical="top"
          placeholder="Add expression, timing, camera, or framing guidance…"
          placeholderTextColor={theme.colors.faint}
          onFocus={onFocus}
          onBlur={onBlur}
          style={{ height: 128, color: theme.colors.text, fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 22 }}
        />
        <PromptLengthCounter meter={catalogPromptMeters(draft, model).prompt} />
        {promptMessage ? <Text accessibilityRole="alert" style={{ color: theme.colors.danger, fontSize: 12, fontWeight: '700', paddingHorizontal: 16, paddingBottom: 11 }}>{promptMessage}</Text> : null}
        <PromptQualityNotes warnings={promptNotes} />
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'stretch', gap: 8 }}>
        <ComposerToolbarButton icon={<Layers size={15} color={theme.colors.muted} />} label="Templates" onPress={() => router.push('/templates' as never)} quiet />
        <ComposerToolbarButton icon={<Wand2 size={16} color={theme.colors.primary} />} {...enhanceButtonLabels('Enhance', isEnhancing)} onPress={onEnhance} disabled={isEnhancing || !draft.prompt.trim()} accent />
      </View>

        <EnhanceControlsRow
          level={enhanceLevel}
          onLevelChange={onEnhanceLevelChange}
          canUndo={canUndoEnhance}
          onUndo={onUndoEnhance}
          disabled={isEnhancing}
        />

      <ReferenceDetailsOverlay
        media={selectedMedia}
        handleUsedInPrompt={false}
        onClose={() => setSelectedRole(null)}
        onRename={(displayName) => {
          if (!selectedMedia) return;
          if (selectedRole === 'character') onChange({ ...draft, characterImage: renameMediaDraft(selectedMedia, displayName) });
          if (selectedRole === 'motion') onChange({ ...draft, referenceVideo: renameMediaDraft(selectedMedia, displayName) });
        }}
        // The clip is swapped in place: Remove then Add read like a limit ("supports up to 1").
        onReplace={selectedRole === 'motion' ? onUploadMotion : undefined}
        isReplacing={selectedRole === 'motion' && upload?.target === 'motion-clip'}
        onRemove={() => {
          if (selectedRole === 'character') onChange({ ...draft, characterImage: null });
          if (selectedRole === 'motion') onChange({ ...draft, referenceVideo: null });
          setSelectedRole(null);
        }}
      />
      {!model ? <Text style={{ color: theme.colors.muted, fontSize: 11 }}>Loading motion settings…</Text> : null}
    </View>
  );
}

function ReferenceMentionSuggestions({
  references,
  prompt,
  query,
  onSelect,
}: {
  references: MediaDraft[];
  prompt: string;
  query: string;
  onSelect: (handle: string) => void;
}) {
  const theme = useAppTheme();
  const matchLabel = references.length === 1 ? '1 reference' : `${references.length} references`;
  return (
    <View
      testID="reference-mention-suggestions"
      accessibilityRole="list"
      accessibilityLabel={`Reference suggestions, ${matchLabel}`}
      style={{
        maxHeight: 210,
        borderRadius: 20,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: hexWithAlpha(theme.colors.image, 0.26),
        backgroundColor: theme.colors.surfaceStrong,
        overflow: 'hidden',
      }}
    >
      <View style={{ minHeight: 40, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
        <Text style={{ color: theme.colors.textSecondary, fontSize: 12, fontWeight: '800' }}>References</Text>
        <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.faint, fontSize: 11, fontWeight: '700' }}>{matchLabel}</Text>
      </View>
      {references.length > 0 ? (
        <ScrollView keyboardShouldPersistTaps="always" nestedScrollEnabled style={{ maxHeight: 168 }}>
          {references.map((media) => {
            const handle = media.handle;
            if (!handle) return null;
            const used = promptContainsHandle(prompt, handle);
            return (
              <Pressable
                key={media.id}
                accessibilityRole="button"
                accessibilityLabel={used ? `${media.displayName}, ${handle}, already added` : `Insert ${handle}, ${media.displayName}`}
                accessibilityState={{ disabled: used }}
                disabled={used}
                onPress={() => onSelect(handle)}
                style={({ pressed }) => ({
                  minHeight: 56,
                  paddingHorizontal: 12,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  borderBottomWidth: 1,
                  borderBottomColor: theme.colors.border,
                  backgroundColor: pressed ? theme.colors.pressed : 'transparent',
                  opacity: used ? 0.58 : pressed ? appTheme.opacity.pressed : 1,
                })}
              >
                <ReferenceMediaPreview media={media} size={38} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 13, fontWeight: '800' }}>{media.displayName}</Text>
                  <Text numberOfLines={1} style={{ color: theme.colors.image, fontSize: 11, fontWeight: '700' }}>{handle}</Text>
                </View>
                {used ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Check size={14} color={theme.colors.image} />
                    <Text style={{ color: theme.colors.muted, fontSize: 11, fontWeight: '800' }}>Added</Text>
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : (
        <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 14, paddingVertical: 16 }}>
          {query ? `No named references match “@${query}”.` : 'Add and name a reference to mention it here.'}
        </Text>
      )}
    </View>
  );
}

/**
 * Enhancement level + undo, shared by every prompt surface (one per creator
 * composer) so the controls cannot drift apart.
 */
function EnhanceControlsRow({
  level,
  onLevelChange,
  canUndo,
  onUndo,
  disabled,
  polishes = false,
}: {
  level: PromptEnhancementLevel;
  onLevelChange: (level: PromptEnhancementLevel) => void;
  canUndo: boolean;
  onUndo: () => void;
  disabled?: boolean;
  /** The prompt names a reference, so a press polishes around it and no level applies, as on the web. */
  polishes?: boolean;
}) {
  const theme = useAppTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {polishes ? (
        <Text testID="polish-note" style={{ flex: 1, color: theme.colors.muted, fontSize: 11, lineHeight: 15 }}>
          Your @references stay as written. Polish only adds light visual detail around them.
        </Text>
      ) : (
      <View style={{ flexDirection: 'row', borderRadius: appTheme.radii.pill, borderWidth: 1, borderColor: hexWithAlpha(theme.colors.text, 0.12), padding: 2 }}>
        {([['cinematic', 'Full'], ['faithful', 'Light']] as const).map(([value, label]) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityLabel={value === 'cinematic' ? 'Full enhancement' : 'Light enhancement'}
            accessibilityState={{ selected: level === value, disabled }}
            disabled={disabled}
            onPress={() => onLevelChange(value)}
            hitSlop={verticalHitSlop(32)}
            // A press state as well as the selected state: without one, tapping
            // the option you are already on gives no feedback at all.
            style={({ pressed }) => ({
              minHeight: 32,
              paddingHorizontal: 12,
              borderRadius: appTheme.radii.pill,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: level === value
                ? hexWithAlpha(theme.colors.primary, 0.18)
                : pressed ? theme.colors.surfaceStrong : 'transparent',
              opacity: disabled ? 0.5 : pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <Text style={{ color: level === value ? theme.colors.primary : theme.colors.faint, fontWeight: '700', fontSize: 12 }}>{label}</Text>
          </Pressable>
        ))}
      </View>
      )}
      {canUndo ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Undo enhancement"
          onPress={onUndo}
          hitSlop={verticalHitSlop(32)}
          style={({ pressed }) => ({
            minHeight: 32,
            paddingHorizontal: 12,
            borderRadius: appTheme.radii.pill,
            borderWidth: 1,
            borderColor: hexWithAlpha(theme.colors.text, 0.12),
            alignItems: 'center',
            justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
        >
          <Text style={{ color: theme.colors.muted, fontWeight: '700', fontSize: 12 }}>Undo</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ComposerToolbarButton({ icon, label, accessibilityLabel, onPress, disabled, accent, quiet }: { icon: React.ReactNode; label: string; accessibilityLabel?: string; onPress: () => void; disabled?: boolean; accent?: boolean; quiet?: boolean }) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 60,
        flex: 1,
        borderRadius: 18,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: accent ? hexWithAlpha(theme.colors.primary, 0.3) : quiet ? hexWithAlpha(theme.colors.text, 0.055) : theme.colors.border,
        backgroundColor: accent ? hexWithAlpha(theme.colors.primary, 0.11) : pressed ? theme.colors.pressed : quiet ? hexWithAlpha(theme.colors.text, 0.025) : theme.colors.surfaceStrong,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 4,
        opacity: disabled ? 0.45 : pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      {icon}
      {/* Centred, because a priced label ("Enhance · 2 credits") can take two lines in a third of the row. */}
      <Text style={{ color: accent ? theme.colors.primary : quiet ? theme.colors.muted : theme.colors.textSecondary, fontSize: quiet ? 10 : 11, fontWeight: '800', textAlign: 'center', paddingHorizontal: 4 }}>{label}</Text>
    </Pressable>
  );
}

/** What the Reference details sheet draws: the reference, and which of its optional rows it has. */
type ReferenceDetailsContent = {
  media: MediaDraft;
  /** A subject's pictures, drawn in place of the one preview. */
  gallery: MediaDraft[] | null;
  noun: 'reference' | 'subject';
  insertsHandle: boolean;
  replaces: boolean;
  isReplacing: boolean;
  /** The Seedance asset row: absent on a reference that takes none, null before one is prepared. */
  asset: SeedanceAssetMetadata | null | undefined;
  isPreparingAsset: boolean;
};

function sameReferenceDetails(held: ReferenceDetailsContent | null, live: ReferenceDetailsContent) {
  return held !== null
    && held.media === live.media
    && held.gallery === live.gallery
    && held.noun === live.noun
    && held.insertsHandle === live.insertsHandle
    && held.replaces === live.replaces
    && held.isReplacing === live.isReplacing
    && held.asset === live.asset
    && held.isPreparingAsset === live.isPreparingAsset;
}

/**
 * The sheet a reference tile opens: its preview, its name, and what can be done
 * with it.
 *
 * Through the overlay host, not a `Modal`, because it holds a text field and
 * has to give way to the keyboard. In the app's own window the area below
 * follows the keyboard frame by frame, by its whole height. Inside a Modal on
 * Android that tracker reads nothing, and the most that arrived there on the
 * emulator was React Native's event, once the keyboard had stopped moving and
 * short by the navigation bar. Being an ordinary view, it owns what a Modal
 * gave for free: the entrance and exit, Android's back key, and taking the
 * keyboard from the page as it opens.
 *
 * Under the title the body scrolls. With the keyboard up there is no room for
 * a 300pt preview, the field and the rows below it, so on Android the panel
 * shortens to what is left of the screen and the scroll view keeps the
 * focused field in what remains of it; on iOS the panel stays and the scroll
 * view makes the room itself. On a short phone the tallest shape of the sheet
 * scrolls at rest too, where its last row used to run off the screen.
 */
function ReferenceDetailsOverlay({
  media,
  gallery = null,
  noun = 'reference',
  handleUsedInPrompt,
  onClose,
  onRename,
  onUseHandle,
  onReplace,
  isReplacing,
  asset,
  isPreparingAsset,
  onPrepareAsset,
  onRefreshAsset,
  onRemove,
}: {
  media: MediaDraft | null;
  /** A subject's pictures: the sheet then draws all of them in place of the one preview. */
  gallery?: MediaDraft[] | null;
  noun?: 'reference' | 'subject';
  handleUsedInPrompt: boolean;
  onClose: () => void;
  onRename: (displayName: string) => void;
  onUseHandle?: (handle: string) => void;
  /** Swap the underlying media while keeping the name and @handle. */
  onReplace?: () => void;
  isReplacing?: boolean;
  /** Given (null included) when the reference can be prepared with Seedance; the row is drawn then. */
  asset?: SeedanceAssetMetadata | null;
  isPreparingAsset?: boolean;
  onPrepareAsset?: () => void;
  onRefreshAsset?: () => void;
  onRemove: () => void;
}) {
  const theme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const visible = media !== null;
  // A caller drops the reference the moment the sheet closes, and the rows that
  // hang off it go with it. The panel leaves showing what it was opened with,
  // or it would change height under its own exit.
  const [held, setHeld] = useState<ReferenceDetailsContent | null>(null);
  const live: ReferenceDetailsContent | null = media
    ? { media, gallery, noun, insertsHandle: Boolean(onUseHandle), replaces: Boolean(onReplace), isReplacing: Boolean(isReplacing), asset, isPreparingAsset: Boolean(isPreparingAsset) }
    : null;
  if (live && !sameReferenceDetails(held, live)) setHeld(live);
  const content = live ?? held;

  // The panel takes a touch only once it is a pull. Holding it from its start,
  // as a sheet in a Modal must, costs the body its scrolling on Android: a slow
  // drag that began on the picture went nowhere (Pixel 9a emulator, 2026-10-05).
  const drag = useSheetDismissDrag({ onDismiss: onClose, visible, takesTouchDown: false });
  // A clip's player waits for the sheet to arrive. A player is built on the
  // main thread, which is where this entrance is drawn too, and the Modal this
  // sheet used to be was slid in by the system, which a busy main thread does
  // not slow. Built with the sheet, the player took the start of the 300 ms
  // slide: the sheet was first drawn 67 to 175 ms in on the iPhone simulator
  // and 32 to 197 ms in on the Pixel 9a emulator, part-way up the screen, where
  // with a picture it was drawn from 15 to 56 ms in (films, 2026-10-05).
  const [arrived, setArrived] = useState(false);
  const presentation = useSheetPresentation({
    visible,
    reducedMotion,
    onEntered: () => setArrived(true),
    onExited: () => {
      setHeld(null);
      setArrived(false);
    },
  });
  // An overlay is an ordinary view: unlike a Modal it has no native claim on
  // Android's back key, so it takes one (Modality: always an obvious way out).
  useHardwareBack(visible, onClose);
  const [renameStatus, setRenameStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const renameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The keyboard goes with whatever had it. Opening over the prompt while it
  // is being typed in takes the keyboard from it, as a Modal's window did by
  // taking the focus; left up, the sheet would open already lifted, with the
  // keys still typing into the prompt behind it. Closing puts the sheet's own
  // keyboard away as it leaves rather than after it has gone.
  const wasVisibleRef = useRef(visible);
  useEffect(() => {
    if (wasVisibleRef.current === visible) return;
    wasVisibleRef.current = visible;
    Keyboard.dismiss();
  }, [visible]);

  // Keyed to the reference the sheet shows, which it still shows while it
  // leaves: reset when the caller drops it, the saved line would go from under
  // the field as the exit began and the panel would shorten on its way out.
  const shownId = content?.media.id;
  useEffect(() => {
    setRenameStatus('idle');
    if (renameTimerRef.current) clearTimeout(renameTimerRef.current);
    return () => {
      if (renameTimerRef.current) clearTimeout(renameTimerRef.current);
    };
  }, [shownId]);

  // The overlay is drawn at the app's root, outside the creator's providers, so the sheet hands on
  // what its pictures read: the link renewal, the swept uploads and the picker's own copies.
  const renewLink = useContext(ReferenceLinkRenewal);
  const unavailableReferences = useContext(UnavailableReferences);
  const localPreviews = useContext(LocalReferencePreviews);

  if (!content) return null;
  const shown = content.media;
  const shownUrl = (shown.storagePath ? localPreviews.get(shown.storagePath) : undefined) ?? shown.url;
  const accessibleName = mediaAccessibleName(shown);
  const motion = sheetMotion(drag, presentation);

  const markRenameSaved = () => {
    if (renameTimerRef.current) clearTimeout(renameTimerRef.current);
    setRenameStatus('saved');
  };

  const handleRename = (displayName: string) => {
    onRename(displayName);
    setRenameStatus('saving');
    if (renameTimerRef.current) clearTimeout(renameTimerRef.current);
    renameTimerRef.current = setTimeout(() => setRenameStatus('saved'), 650);
  };

  const nounLabel = content.noun === 'subject' ? 'Subject' : 'Reference';

  const confirmRemove = () => {
    void showConfirmDialog({
      title: `Remove ${content.noun}?`,
      message: handleUsedInPrompt && shown.handle
        ? `${accessibleName} and ${shown.handle} will be removed from this draft.`
        : `${accessibleName} will be removed from this draft.`,
      confirmLabel: 'Remove',
      destructive: true,
    }).then((remove) => {
      if (remove) onRemove();
    });
  };

  return (
    <Overlay visible={presentation.rendered}>
      <ReferenceLinkRenewal.Provider value={renewLink}>
      <UnavailableReferences.Provider value={unavailableReferences}>
      <LocalReferencePreviews.Provider value={localPreviews}>
      {/* Answered once: while the exit plays the sheet is still drawn, and a press on it must not land. */}
      <View pointerEvents={visible ? 'auto' : 'none'} style={{ flex: 1 }}>
        <KeyboardAvoidingArea iosScrollViewAdjustsInsets followsKeyboard={presentation.settled} testID="reference-details-keyboard-area" style={{ justifyContent: 'flex-end' }}>
          <SheetBackdrop drag={drag} style={motion.backdrop} color={hexWithAlpha(theme.dim.color, 0.68 * theme.dim.scale)} onPress={onClose} />
          <SheetPanel {...drag.contentPanHandlers} accessibilityViewIsModal onLayout={presentation.onPanelLayout} style={[{ maxHeight: '88%', borderTopLeftRadius: 30, borderTopRightRadius: 30, backgroundColor: theme.colors.panel, paddingHorizontal: 20, paddingTop: 6, paddingBottom: 30, gap: 14 }, motion.panel]}>
            <SheetGrabber drag={drag} />
            {/* The title takes a pull as the grabber does, wherever the body is scrolled to. The panel's own
                drag waits for the body to be at its top, and with the keyboard up the body never quite is. */}
            <View {...drag.panHandlers} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ color: theme.colors.text, fontSize: 20, fontWeight: '800' }}>{`${nounLabel} details`}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`Close ${content.noun} details`} onPress={onClose} style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 24, backgroundColor: theme.colors.surfaceStrong, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}>
                <CloseGlyph size={appTheme.icon.feature} color={theme.colors.text} />
              </Pressable>
            </View>
            {/* `handled`: a press on a row answers with the keyboard up, and a touch on anything else in the body puts the keyboard away. */}
            <ScrollView {...drag.scrollProps} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 14 }}>
              {content.gallery ? (
                /* A subject is all of its pictures; the sheet draws each, as the model is given each. */
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 9 }} testID="subject-details-gallery">
                  {content.gallery.map((image) => <ReferenceMediaPreview key={image.id} media={image} size={132} />)}
                </ScrollView>
              ) : (
                /* The whole reference, centred across the sheet: it is what the model is given, so none of it is cropped away. */
                <MediaPreview url={shownUrl} kind={shown.kind === 'video' ? 'video' : 'image'} height={300} radius={22} letterbox playerHeld={!arrived} />
              )}
              <View style={{ gap: 7 }}>
                <Text style={{ color: theme.colors.muted, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }}>{`${nounLabel} name`}</Text>
                <TextInput
                  accessibilityLabel={`${nounLabel} name for ${accessibleName}`}
                  value={shown.displayName}
                  onChangeText={handleRename}
                  onBlur={renameStatus === 'saving' ? markRenameSaved : undefined}
                  placeholder={`${nounLabel} name`}
                  placeholderTextColor={theme.colors.faint}
                  style={{ minHeight: 52, borderRadius: 16, borderWidth: 1, borderColor: theme.colors.borderStrong, backgroundColor: theme.colors.surfaceInset, color: theme.colors.text, paddingHorizontal: 14, fontSize: 14, fontWeight: '700' }}
                />
                {renameStatus !== 'idle' ? (
                  <Text accessibilityLiveRegion="polite" style={{ color: renameStatus === 'saved' ? theme.colors.image : theme.colors.muted, fontSize: 11, fontWeight: '700' }}>
                    {renameStatus === 'saved' ? 'Saved to draft' : 'Saving…'}
                  </Text>
                ) : null}
              </View>
              {content.asset !== undefined ? (
                <View style={{ gap: 7 }} testID="seedance-asset-row">
                  <Text style={{ color: theme.colors.muted, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }}>Seedance asset</Text>
                  <Text accessibilityLiveRegion="polite" style={{ color: content.asset?.status === 'failed' ? theme.colors.danger : theme.colors.textSecondary, fontSize: 12, lineHeight: 17 }}>
                    {seedanceAssetStatusLine(content.asset)}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${seedanceAssetActionLabel(content.asset, content.isPreparingAsset)} for ${accessibleName}`}
                    accessibilityState={{ disabled: content.isPreparingAsset }}
                    disabled={content.isPreparingAsset}
                    onPress={content.asset?.status === 'processing' ? onRefreshAsset : onPrepareAsset}
                    style={({ pressed }) => ({ minHeight: 52, borderRadius: appTheme.radii.pill, borderWidth: 1, borderColor: theme.colors.borderStrong, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, opacity: content.isPreparingAsset ? 0.55 : pressed ? appTheme.opacity.pressed : 1 })}
                  >
                    {content.isPreparingAsset ? <ActivityIndicator size="small" color={theme.colors.text} /> : <Sparkles size={16} color={theme.colors.text} />}
                    <Text style={{ color: theme.colors.text, fontSize: 13, fontWeight: '800' }}>{seedanceAssetActionLabel(content.asset, content.isPreparingAsset)}</Text>
                  </Pressable>
                </View>
              ) : null}
              {shown.handle && content.insertsHandle ? <SecondaryButton label={`Insert ${shown.handle}`} onPress={() => onUseHandle?.(shown.handle!)} /> : null}
              {content.replaces ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Replace ${accessibleName}`}
                  accessibilityState={{ disabled: content.isReplacing }}
                  disabled={content.isReplacing}
                  onPress={onReplace}
                  style={({ pressed }) => ({ minHeight: 52, borderRadius: appTheme.radii.pill, borderWidth: 1, borderColor: theme.colors.borderStrong, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, opacity: content.isReplacing ? 0.55 : pressed ? appTheme.opacity.pressed : 1 })}
                >
                  {content.isReplacing ? <ActivityIndicator size="small" color={theme.colors.text} /> : <RefreshCw size={16} color={theme.colors.text} />}
                  <Text style={{ color: theme.colors.text, fontSize: 13, fontWeight: '800' }}>
                    {content.isReplacing ? 'Replacing…' : `Replace media${shown.handle ? ` · keeps ${shown.handle}` : ''}`}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${accessibleName}`} onPress={confirmRemove} style={({ pressed }) => ({ minHeight: 52, borderRadius: appTheme.radii.pill, borderWidth: 1, borderColor: hexWithAlpha(theme.colors.danger, 0.34), alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, opacity: pressed ? appTheme.opacity.pressed : 1 })}>
                <Trash2 size={17} color={theme.colors.danger} />
                <Text style={{ color: theme.colors.danger, fontSize: 13, fontWeight: '800' }}>{`Remove ${content.noun}`}</Text>
              </Pressable>
            </ScrollView>
          </SheetPanel>
        </KeyboardAvoidingArea>
      </View>
      </LocalReferencePreviews.Provider>
      </UnavailableReferences.Provider>
      </ReferenceLinkRenewal.Provider>
    </Overlay>
  );
}

function CreatorPersistentBar({
  bottom,
  summary,
  blocker,
  quoteStatus,
  awaitingInputs = false,
  cost,
  retryLabel = 'Retry quote',
  action,
  disabled,
  onOpenParameters,
  onRetryQuote,
  onAction,
}: {
  bottom: number;
  summary: string;
  blocker: string | null;
  quoteStatus: 'idle' | 'pending' | 'ready' | 'error';
  /** No quote is asked for until the inputs it prices are there, so nothing is being calculated. */
  awaitingInputs?: boolean;
  cost: number | null;
  retryLabel?: string;
  action: 'generate' | 'progress' | 'result';
  disabled: boolean;
  onOpenParameters: () => void;
  onRetryQuote: () => void;
  onAction: () => void;
}) {
  const theme = useAppTheme();
  const actionLabel = action === 'result'
    ? 'View result'
    : action === 'progress'
      ? 'View progress'
      : quoteStatus === 'pending' || quoteStatus === 'idle'
        ? awaitingInputs ? 'Generate' : 'Calculating…'
        : quoteStatus === 'ready'
          // Shared with the workspace's Try again / Generate again, so the same
          // spend is never announced two different ways — and so "1 credits"
          // cannot come back.
          ? withCreditCost('Generate', cost ?? 0)
          : retryLabel;
  const actionDisabled = disabled && !(action === 'generate' && quoteStatus === 'error');
  return (
    <View testID="creator-persistent-bar" pointerEvents="box-none" style={{ position: 'absolute', left: 14, right: 14, bottom, zIndex: 8, gap: 7 }}>
      {blocker ? (
        <View testID="creator-contextual-blocker" accessibilityRole="alert" style={{ minHeight: 40, borderRadius: 14, borderWidth: 1, borderColor: hexWithAlpha(theme.colors.amber, 0.28), backgroundColor: theme.colors.panelSoft, paddingHorizontal: 12, paddingVertical: 9, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.amber }} />
          <Text numberOfLines={2} style={{ flex: 1, color: theme.colors.textSecondary, fontSize: 11, fontWeight: '700', lineHeight: 15 }}>{blocker}</Text>
          {/* The creator stack has no tab bar and no balance in its header, so this was a dead end;
              the web shows "Top Up Credits" here. */}
          {blocker.startsWith('Insufficient credits') ? <GetCreditsButton onPress={() => router.push('/(tabs)/pricing' as never)} /> : null}
        </View>
      ) : null}
      <View style={{ minHeight: 72, borderRadius: 24, borderCurve: 'continuous', borderWidth: 1, borderColor: theme.colors.borderStrong, backgroundColor: theme.colors.panel, padding: 8, flexDirection: 'row', alignItems: 'center', gap: 8, boxShadow: theme.shadow.floating.boxShadow }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Generation parameters. ${summary}`}
          onPress={onOpenParameters}
          style={({ pressed }) => ({ minHeight: 54, flex: 0.9, borderRadius: 18, backgroundColor: pressed ? theme.colors.pressed : theme.colors.surfaceStrong, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, opacity: pressed ? appTheme.opacity.pressed : 1 })}
        >
          <Settings2 size={16} color={theme.colors.textSecondary} />
          <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 12, fontWeight: '800' }}>{summary}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          accessibilityState={{ disabled: actionDisabled }}
          disabled={actionDisabled}
          onPress={action === 'generate' && quoteStatus === 'error' ? onRetryQuote : onAction}
          style={({ pressed }) => ({ minHeight: 54, flex: 1.2, borderRadius: 18, backgroundColor: actionDisabled ? theme.colors.surfaceStrong : theme.colors.primaryFill, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', opacity: actionDisabled ? 0.58 : pressed ? appTheme.opacity.pressed : 1 })}
        >
          <Text accessibilityLiveRegion="polite" numberOfLines={1} style={{ color: actionDisabled ? theme.colors.muted : theme.colors.onPrimary, fontSize: 12, fontWeight: '900' }}>{actionLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** The way from a credits blocker to the pricing page, on the bar and in the parameter sheet alike. */
function GetCreditsButton({ onPress }: { onPress: () => void }) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Get credits"
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => ({ minHeight: 32, paddingHorizontal: 10, borderRadius: 10, backgroundColor: theme.colors.primaryFill, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
    >
      <Text style={{ color: theme.colors.onPrimary, fontSize: 11, fontWeight: '900' }}>Get credits</Text>
    </Pressable>
  );
}

/**
 * The sheet a creation screen's model chip opens: a search field over the
 * list of models.
 *
 * Through the overlay host, not a `Modal`, because it holds a text field. As a
 * Modal it had nothing that gave way to the keyboard on either platform: the
 * field near its top stayed in view, but the list ran on behind the keys, and
 * its last three rows of sixteen could not be scrolled above them (Pixel 9a
 * emulator and iPhone simulator, 2026-10-05). A search that left more rows
 * than fitted above the keys hid the rest the same way.
 *
 * In the app's own window the area below follows the keyboard. On Android it
 * shortens, the panel is 78% of what is left and the list ends above the keys;
 * on iOS the panel stays and the list makes the room itself. Being an ordinary
 * view, the sheet owns what a Modal gave for free: its entrance and exit,
 * Android's back key, and taking the keyboard from the page as it opens.
 */
function SearchableModelPickerSheet({
  visible,
  items,
  value,
  onClose,
  onChange,
  loading,
  pendingId = null,
  error,
  onRetry,
}: {
  visible: boolean;
  loading?: boolean;
  /** A model whose details are loading before the pick lands: its row turns, and no other takes a press. */
  pendingId?: string | null;
  error?: string;
  onRetry?: () => void;
  items: ModelCatalogSummary[];
  value: string;
  onClose: () => void;
  onChange: (modelId: string) => void;
}) {
  const theme = useAppTheme();
  const [query, setQuery] = useState('');
  const reducedMotion = useReducedMotion();
  // The panel takes a touch only once it is a pull. Held from its start, as a
  // sheet in a Modal must, the touch is taken from the list on Android at the
  // finger's next movement (see `takesTouchDown`).
  const drag = useSheetDismissDrag({ onDismiss: onClose, visible, takesTouchDown: false });
  const presentation = useSheetPresentation({
    visible,
    reducedMotion,
    // The search goes once the sheet has gone. Cleared as it closed, the list
    // would grow back to every model under its own exit. A Modal's `onDismiss`
    // did this on iOS only: on Android the picker reopened on its last search.
    onExited: () => setQuery(''),
  });
  // An overlay is an ordinary view: unlike a Modal it has no native claim on
  // Android's back key, so it takes one (Modality: always an obvious way out).
  useHardwareBack(visible, onClose);

  // The keyboard goes with whatever had it. Opening over the prompt while it
  // is being typed in takes the keyboard from it, as a Modal's window did by
  // taking the focus; left up, the sheet would open already shortened, with
  // the keys still typing into the prompt behind it. Closing puts the search
  // field's keyboard away as the sheet leaves rather than after it has gone.
  const wasVisibleRef = useRef(visible);
  useEffect(() => {
    if (wasVisibleRef.current === visible) return;
    wasVisibleRef.current = visible;
    Keyboard.dismiss();
  }, [visible]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredItems = useMemo(() => items.filter((item) => (
    !normalizedQuery || `${item.displayName} ${item.description} ${item.badge ?? ''}`.toLowerCase().includes(normalizedQuery)
  )), [items, normalizedQuery]);
  const motion = sheetMotion(drag, presentation);

  return (
    <Overlay visible={presentation.rendered}>
      {/* Answered once: while the exit plays the sheet is still drawn, and a press on it must not land. */}
      <View pointerEvents={visible ? 'auto' : 'none'} style={{ flex: 1 }}>
        <KeyboardAvoidingArea iosScrollViewAdjustsInsets followsKeyboard={presentation.settled} testID="model-picker-keyboard-area" style={{ justifyContent: 'flex-end' }}>
          <SheetBackdrop drag={drag} style={motion.backdrop} color={hexWithAlpha(theme.dim.color, 0.7 * theme.dim.scale)} onPress={onClose} />
          <SheetPanel {...drag.contentPanHandlers} accessibilityViewIsModal onLayout={presentation.onPanelLayout} style={[{ height: '78%', borderTopLeftRadius: 30, borderTopRightRadius: 30, backgroundColor: theme.colors.panel, paddingHorizontal: 20, paddingTop: 6, paddingBottom: 20, gap: 12 }, motion.panel]}>
            <SheetGrabber drag={drag} />
            {/* The title takes a pull as the grabber does, wherever the list is scrolled to. The panel's own
                drag waits for the list to be at its top, so a pull from here did nothing once it had scrolled. */}
            <View {...drag.panHandlers} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: theme.colors.text, fontSize: 21, fontWeight: '800' }}>Choose model</Text>
                <Text style={{ color: theme.colors.muted, fontSize: 12 }}>Defaults and quote update after selection.</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="Close model picker" onPress={onClose} style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 24, backgroundColor: theme.colors.surfaceStrong, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}>
                <CloseGlyph size={appTheme.icon.feature} color={theme.colors.text} />
              </Pressable>
            </View>
            <View style={{ minHeight: 52, borderRadius: 17, borderWidth: 1, borderColor: theme.colors.borderStrong, backgroundColor: theme.colors.surfaceInset, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 9 }}>
              <Search size={18} color={theme.colors.muted} />
              <TextInput accessibilityLabel="Search model names" value={query} onChangeText={setQuery} placeholder="Search models" placeholderTextColor={theme.colors.faint} autoCapitalize="none" autoCorrect={false} spellCheck={false} returnKeyType="search" clearButtonMode="while-editing" style={{ flex: 1, color: theme.colors.text, fontSize: 14, paddingVertical: 12 }} />
            </View>
            {/* `handled`: a press on a model answers with the keyboard up, and a touch on anything else in the list puts the keyboard away. */}
            <ScrollView {...drag.scrollProps} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8, paddingBottom: 28 }}>
              {filteredItems.map((item) => {
                const selected = item.id === value;
                const pending = item.id === pendingId;
                return (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected, busy: pending, disabled: pendingId !== null }}
                    accessibilityLabel={`${item.displayName}. ${item.description}`}
                    disabled={pendingId !== null}
                    onPress={() => onChange(item.id)}
                    style={({ pressed }) => ({ minHeight: 76, borderRadius: 20, borderCurve: 'continuous', borderWidth: 1, borderColor: selected ? hexWithAlpha(theme.colors.image, 0.55) : theme.colors.border, backgroundColor: selected ? hexWithAlpha(theme.colors.image, 0.1) : theme.colors.surfaceStrong, padding: 13, flexDirection: 'row', alignItems: 'center', gap: 12, opacity: pressed ? appTheme.opacity.pressed : 1 })}
                  >
                    <View style={{ width: 40, height: 40, borderRadius: 14, backgroundColor: selected ? hexWithAlpha(theme.colors.image, 0.18) : theme.colors.surfaceInset, alignItems: 'center', justifyContent: 'center' }}>
                      <ImageIcon size={19} color={selected ? theme.colors.image : theme.colors.muted} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                        <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.text, fontSize: 14, fontWeight: '800' }}>{item.displayName}</Text>
                        {item.badge ? <Text style={{ color: theme.colors.image, fontSize: 11, fontWeight: '800' }}>{item.badge}</Text> : null}
                      </View>
                      <Text numberOfLines={2} style={{ color: theme.colors.muted, fontSize: 11, lineHeight: 15 }}>{item.description}</Text>
                    </View>
                    {pending
                      ? <ActivityIndicator testID="model-picker-row-loading" color={theme.colors.image} size="small" />
                      : selected ? <Check size={19} color={theme.colors.image} /> : null}
                  </Pressable>
                );
              })}
              {loading ? <Text accessibilityRole="text" style={{ color: theme.colors.muted, paddingVertical: 12 }}>Loading models…</Text> : null}
              {error ? <Pressable accessibilityRole="button" onPress={onRetry} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: theme.colors.text }}>{error} Tap to retry.</Text></Pressable> : null}
              {!loading && !error && filteredItems.length === 0 ? <Text style={{ color: theme.colors.muted, textAlign: 'center', paddingVertical: 28 }}>No models found.</Text> : null}
            </ScrollView>
          </SheetPanel>
        </KeyboardAvoidingArea>
      </View>
    </Overlay>
  );
}

function CreatorParameterSheet({
  visible,
  bottomInset,
  catalog,
  model,
  draft,
  quoteStatus,
  awaitingInputs = false,
  cost,
  availableCredits,
  blocker,
  retryLabel = 'Retry quote',
  hiddenControlKeys = [],
  sourceDurationSeconds,
  onClose,
  onRetryQuote,
  onGetCredits,
  onChange,
  onGenerate,
  generateDisabled,
}: {
  visible: boolean;
  bottomInset: number;
  catalog: GenerationModelCatalog | null;
  model: ReturnType<typeof getCatalogModels>[number] | null;
  draft: CreationDraft;
  quoteStatus: 'idle' | 'pending' | 'ready' | 'error';
  /** No quote is asked for until the inputs it prices are there. */
  awaitingInputs?: boolean;
  cost: number | null;
  availableCredits: number | null;
  blocker: string | null;
  retryLabel?: string;
  hiddenControlKeys?: readonly string[];
  sourceDurationSeconds?: number | null;
  onClose: () => void;
  onRetryQuote: () => void;
  /** Leaves the sheet for the pricing page; the bar offers the same from its credits blocker. */
  onGetCredits: () => void;
  onChange: (draft: CreationDraft) => void;
  onGenerate: () => void;
  generateDisabled: boolean;
}) {
  const theme = useAppTheme();
  const reducedMotion = useReducedMotion();
  // Still a Modal, so its panel keeps taking a touch-down that nothing below it wanted (see
  // `takesTouchDown`, and what that costs a list on Android: a slow drag that begins on a label or in
  // a gap of this one scrolls nothing. Pixel 9a emulator, 2026-10-07; not what this change is for).
  const drag = useSheetDismissDrag({ onDismiss: onClose, visible });
  const quoteLabel = quoteStatus === 'ready'
    ? formatCreditCost(cost ?? 0)
    : quoteStatus === 'error' ? 'Unavailable' : awaitingInputs ? 'Needs both inputs' : 'Calculating…';
  // Grouped as every balance is, and counted as formatCreditCost counts: a balance of 1 read "1 credits".
  const balanceLabel = typeof availableCredits === 'number'
    ? formatCreditCost(availableCredits).replace(/^\S+/, formatCreditAmount(availableCredits))
    : 'Unavailable';
  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType={reducedMotion ? 'none' : 'slide'} onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <SheetBackdrop drag={drag} color={hexWithAlpha(theme.dim.color, 0.7 * theme.dim.scale)} onPress={onClose} />
        <SheetPanel {...drag.contentPanHandlers} testID="creator-parameter-sheet" accessibilityViewIsModal style={[{ maxHeight: '88%', borderTopLeftRadius: 30, borderTopRightRadius: 30, backgroundColor: theme.colors.panel, paddingTop: 6, paddingBottom: bottomInset + 12 }, drag.dragStyle]}>
          <SheetGrabber drag={drag} />
          {/* The title takes a pull as the grabber does, wherever the list is scrolled to. The panel's own
              drag waits for the list to be at its top, so a pull from here did nothing once it had scrolled. */}
          <View {...drag.panHandlers} style={{ paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: theme.colors.text, fontSize: 21, fontWeight: '800' }}>Generation parameters</Text>
              <Text numberOfLines={1} style={{ color: theme.colors.muted, fontSize: 12 }}>{model?.displayName ?? `${TOOL_META[draft.tool].title} settings`}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close generation parameters" onPress={onClose} style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 24, backgroundColor: theme.colors.surfaceStrong, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}>
              <CloseGlyph size={appTheme.icon.feature} color={theme.colors.text} />
            </Pressable>
          </View>
          <ScrollView {...drag.scrollProps} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 18 }}>
            {!catalog || !model ? (
              <View style={{ minHeight: 100, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                <ActivityIndicator color={theme.colors.image} />
                <Text style={{ color: theme.colors.muted }}>Loading parameters…</Text>
              </View>
            ) : (
              <>
                <CatalogEssentialControls model={model} draft={draft} onChange={onChange} hiddenControlKeys={hiddenControlKeys} />
                {draft.tool === 'motion' ? (
                  <OptionRow title="Source duration">
                    <ReadOnlyParameterValue value={sourceDurationSeconds ? `${sourceDurationSeconds}s from motion video` : 'Add motion video'} />
                  </OptionRow>
                ) : null}
                <View style={{ height: 1, backgroundColor: theme.colors.border }} />
                {draft.tool === 'image' && !model.controls.some((control) => control.key === 'outputFormat') ? (
                  <OptionRow title="Output format">
                    <ReadOnlyParameterValue value={draft.outputFormat.toUpperCase()} />
                  </OptionRow>
                ) : null}
                <CatalogAdvancedControls model={model} draft={draft} onChange={onChange} hiddenControlKeys={hiddenControlKeys} />
              </>
            )}
            {blocker ? (
              <View testID="parameter-sheet-blocker" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text accessibilityRole="alert" style={{ flex: 1, color: theme.colors.danger, fontSize: 12, fontWeight: '700', lineHeight: 17 }}>{blocker}</Text>
                {/* The bar's way out of a short balance, here too: this sheet's Generate is disabled by it. */}
                {blocker.startsWith('Insufficient credits') ? <GetCreditsButton onPress={onGetCredits} /> : null}
              </View>
            ) : null}
          </ScrollView>
          <View style={{ paddingHorizontal: 20, paddingTop: 12, borderTopWidth: 1, borderTopColor: theme.colors.border, gap: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ color: theme.colors.muted, fontSize: 12, fontWeight: '700' }}>Live quote</Text>
              <Text accessibilityLiveRegion="polite" style={{ color: quoteStatus === 'error' ? theme.colors.danger : theme.colors.text, fontSize: 13, fontWeight: '800' }}>{quoteLabel}</Text>
            </View>
            <View
              accessibilityRole="text"
              accessibilityLabel={`Available balance, ${balanceLabel}`}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <Text style={{ color: theme.colors.muted, fontSize: 12, fontWeight: '700' }}>Available balance</Text>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{balanceLabel}</Text>
            </View>
            <PrimaryButton
              label={quoteStatus === 'ready' ? withCreditCost('Generate', cost ?? 0) : quoteStatus === 'error' ? retryLabel : awaitingInputs ? 'Generate' : quoteLabel}
              onPress={quoteStatus === 'error' ? onRetryQuote : onGenerate}
              disabled={quoteStatus === 'error' ? false : generateDisabled}
            />
          </View>
        </SheetPanel>
      </View>
    </Modal>
  );
}

/**
 * Seconds since `startedAt`, ticking while the run is live and `null` when it
 * is not. One interval, cleared the moment the wait ends — the workspace stays
 * mounted after the run finishes, so a timer keyed on mount would never stop.
 */
function useGenerationElapsedSeconds(startedAt: number | null) {
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    if (startedAt === null) {
      setElapsed(null);
      return;
    }
    const read = () => setElapsed(Math.max(0, (Date.now() - startedAt) / 1000));
    read();
    const timer = setInterval(read, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  return elapsed;
}

function GenerationWorkspace({
  visible,
  tool,
  status,
  isGenerating,
  outputUrl,
  outputUrls,
  generationId,
  settingsSummary,
  startedAt,
  retryCost,
  retryHeld = false,
  refusalAction = null,
  notice = null,
  error,
  pollingInterrupted,
  onResumePolling,
  attemptUnconfirmed,
  onCheckAttempt,
  onStartNewRun,
  onMinimize,
  onOpenAlerts,
  onRetry,
  onBack,
  onPost,
  onShare,
  onReport,
  onCreateAnother,
}: {
  visible: boolean;
  tool: CreatorToolId;
  status: GenerationStatusResponse | null;
  isGenerating: boolean;
  /** The primary output: the one Post to feed publishes. */
  outputUrl: string | null;
  /** Every output, the primary first; a run that made several is paged through here. */
  outputUrls: string[];
  generationId: string | null;
  settingsSummary: string;
  /** When the run started, so minimizing and returning does not restart the clock. */
  startedAt: number | null;
  /** What another run of the same draft costs, or null while the quote is unsettled. */
  retryCost: number | null;
  /** The same draft would be refused again as it was (an app out of date for it): no Try again. */
  retryHeld?: boolean;
  /**
   * What to do first about a start the server refused outright, where sending it again would
   * only be refused again (Edit prompt, Get credits, …); Try again stays, second.
   */
  refusalAction?: { label: string; onPress: () => void } | null;
  /** A line under the failure, such as the credits a failed run's settlement returned. */
  notice?: string | null;
  error: string | null | undefined;
  pollingInterrupted: boolean;
  onResumePolling: () => void;
  /** A start whose response was lost: checking replays it under its key; a new run is a separate choice. */
  attemptUnconfirmed: boolean;
  onCheckAttempt: () => void;
  onStartNewRun: () => void;
  onMinimize: () => void;
  onOpenAlerts: () => void;
  onRetry: () => void;
  onBack: () => void;
  onPost: () => void;
  /** Posts the creation, then opens the share sheet on its public link. */
  onShare: () => void;
  /** Sends the result to the safety team, after asking: open to a guest, whose own run it is. */
  onReport: () => void;
  onCreateAnother: () => void;
}) {
  const theme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const safeAreaInsets = useSafeAreaInsets();
  const succeeded = Boolean(outputUrl);
  const outputs = outputUrls.length > 0 ? outputUrls : outputUrl ? [outputUrl] : [];
  // Which output is on screen, kept for this run's outputs only: the next run opens on its primary.
  const outputsKey = outputs.join('\n');
  const [shownOutput, setShownOutput] = useState({ outputsKey, index: 0 });
  const shownIndex = shownOutput.outputsKey === outputsKey ? Math.min(shownOutput.index, Math.max(0, outputs.length - 1)) : 0;
  const shownUrl = outputs[shownIndex] ?? outputUrl;
  const showOutput = (index: number) => setShownOutput({ outputsKey, index });
  const failed = status?.status === 'failed' || (!isGenerating && !succeeded && Boolean(error) && !pollingInterrupted);
  const medium = tool === 'image' ? 'image' : tool === 'video' ? 'video' : 'motion video';
  const previewKind = tool === 'image' ? 'image' : 'video';
  // A start that could not be confirmed is not a live run, whether or not its
  // message is still showing, so the clock stops for it too.
  const waiting = visible && !succeeded && !failed && !pollingInterrupted && !attemptUnconfirmed;
  const elapsedSeconds = useGenerationElapsedSeconds(waiting ? startedAt : null);
  const waitPhase = generationWaitPhase(status?.status);
  const waitTitle = generationWaitTitle(waitPhase, medium);
  const waitDetail = generationWaitDetail(waitPhase, elapsedSeconds);
  // The time as the clock last read it: the tick that moves the elapsed line
  // moves the estimate too, and render never asks for the time itself.
  const waitNowMs = startedAt !== null && elapsedSeconds !== null ? startedAt + elapsedSeconds * 1000 : null;
  const waitTiming = readGenerationWaitTiming(status?.timing);
  const waitCountdown = generationWaitCountdownLabel(waitTiming, waitNowMs);
  const waitPercent = generationWaitProgressPercent(waitTiming, waitNowMs);
  return (
    <Modal visible={visible} animationType={reducedMotion ? 'none' : 'slide'} presentationStyle="fullScreen" onRequestClose={onMinimize}>
      <View testID="generation-workspace" accessibilityViewIsModal style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <View style={{ minHeight: safeAreaInsets.top + 60, paddingTop: safeAreaInsets.top, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: theme.colors.text, fontSize: 20, fontWeight: '800' }}>
              {succeeded ? `Your ${medium}` : pollingInterrupted ? 'Generation is still running' : attemptUnconfirmed ? 'Generation not confirmed' : failed ? 'Generation failed' : `Creating ${medium}`}
            </Text>
            <Text numberOfLines={1} style={{ color: theme.colors.muted, fontSize: 11 }}>{settingsSummary}</Text>
          </View>
          {/* Over an outcome the ✕ is Close: it keeps the outcome a tap away (the bar's View result),
              where the panel's "Back to creator" clears it, so the two are not one name (A3, 2026-10-21). */}
          <Pressable accessibilityRole="button" accessibilityLabel={succeeded || failed || attemptUnconfirmed ? 'Close' : 'Minimize generation'} onPress={onMinimize} style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 24, backgroundColor: theme.colors.surfaceStrong, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}>
            <CloseGlyph size={appTheme.icon.feature} color={theme.colors.text} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 18, paddingBottom: safeAreaInsets.bottom + 18, gap: 18 }}>
          {succeeded && outputUrl ? (
            <>
              {/* The whole result, whatever its shape: cropping it to fill
                  would hide part of what was just made. */}
              <MediaPreview url={shownUrl ?? outputUrl} kind={previewKind} height={480} radius={26} nativeControls={previewKind === 'video'} letterbox />
              {outputs.length > 1 ? (
                // A run can return several options (Grok Imagine); each is kept, and Post to feed
                // publishes the first, as the web creator says.
                <View testID="result-output-pager" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                  {/* Words rather than chevrons: a left chevron is the app's Back glyph. */}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Previous output"
                    accessibilityState={{ disabled: shownIndex === 0 }}
                    disabled={shownIndex === 0}
                    onPress={() => showOutput(shownIndex - 1)}
                    style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 16, borderRadius: appTheme.radii.pill, backgroundColor: theme.colors.surfaceStrong, alignItems: 'center', justifyContent: 'center', opacity: shownIndex === 0 ? 0.4 : pressed ? appTheme.opacity.pressed : 1 })}
                  >
                    <Text style={{ color: theme.colors.text, fontSize: 13, fontWeight: '800' }}>Previous</Text>
                  </Pressable>
                  <Text accessibilityLiveRegion="polite" style={{ minWidth: 64, textAlign: 'center', color: theme.colors.textSecondary, fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] }}>
                    {`${shownIndex + 1} of ${outputs.length}`}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Next output"
                    accessibilityState={{ disabled: shownIndex >= outputs.length - 1 }}
                    disabled={shownIndex >= outputs.length - 1}
                    onPress={() => showOutput(shownIndex + 1)}
                    style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 16, borderRadius: appTheme.radii.pill, backgroundColor: theme.colors.surfaceStrong, alignItems: 'center', justifyContent: 'center', opacity: shownIndex >= outputs.length - 1 ? 0.4 : pressed ? appTheme.opacity.pressed : 1 })}
                  >
                    <Text style={{ color: theme.colors.text, fontSize: 13, fontWeight: '800' }}>Next</Text>
                  </Pressable>
                </View>
              ) : null}
              <View style={{ gap: 10 }}>
                {generationId ? <PrimaryButton label="Post to feed" onPress={onPost} /> : null}
                {generationId ? <SecondaryButton label="Share" onPress={onShare} /> : null}
                {/* Generative AI asks for controls like Edit, Undo, Retry or
                    Adjust *near* generated content — the result had none, so
                    running the same draft again meant leaving this view first.
                    Priced, because it spends the same credits Generate does. */}
                <SecondaryButton label={withCreditCost('Generate again', retryCost)} onPress={onRetry} />
                <SecondaryButton label="Back to creator" onPress={onCreateAnother} />
                <SecondaryButton label="Open Alerts" onPress={onOpenAlerts} />
                {/* Reporting an offensive result without leaving it: before this
                    it lived only in the library reel, which a guest could not
                    open, so a guest who generated had no way to flag one (02-2). */}
                {generationId ? (
                  <SecondaryButton
                    label="Report AI output"
                    accessibilityHint="Sends this result to the safety team"
                    onPress={onReport}
                  />
                ) : null}
              </View>
            </>
          ) : pollingInterrupted ? (
            <View style={{ flex: 1, minHeight: 560, justifyContent: 'center', gap: 18 }}>
              <View style={{ height: 310, borderRadius: 28, borderWidth: 1, borderColor: hexWithAlpha(theme.colors.amber, 0.24), backgroundColor: theme.colors.panel, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 28 }}>
                <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: hexWithAlpha(theme.colors.amber, 0.12), alignItems: 'center', justifyContent: 'center' }}>
                  <Sparkles size={28} color={theme.colors.amber} />
                </View>
                <Text style={{ color: theme.colors.text, fontSize: 20, fontWeight: '800', textAlign: 'center' }}>Progress check interrupted</Text>
                <Text accessibilityRole="alert" selectable style={{ color: theme.colors.muted, fontSize: 13, lineHeight: 19, textAlign: 'center' }}>
                  {error || 'The generation may still be running. Check its existing job instead of starting another one.'}
                </Text>
              </View>
              <PrimaryButton label="Retry status check" onPress={onResumePolling} />
              <SecondaryButton label="Back to creator" onPress={onMinimize} />
            </View>
          ) : attemptUnconfirmed ? (
            <View style={{ flex: 1, minHeight: 560, justifyContent: 'center', gap: 18 }}>
              <View style={{ height: 310, borderRadius: 28, borderWidth: 1, borderColor: theme.colors.borderStrong, backgroundColor: theme.colors.panel, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 28 }}>
                <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: theme.colors.surfaceStrong, alignItems: 'center', justifyContent: 'center' }}>
                  <Sparkles size={28} color={theme.colors.amber} />
                </View>
                <Text style={{ color: theme.colors.text, fontSize: 20, fontWeight: '800', textAlign: 'center' }}>We couldn’t confirm this {medium} started</Text>
                <Text accessibilityRole="alert" selectable style={{ color: theme.colors.muted, fontSize: 13, lineHeight: 19, textAlign: 'center' }}>
                  {error || GENERATION_ATTEMPT_UNCONFIRMED_MESSAGE}
                </Text>
              </View>
              {/* Checking replays the same request under the same key, so it can
                  only find the run or start it once. A new run is priced, because
                  it may be a second charge. */}
              <PrimaryButton label="Check again" onPress={onCheckAttempt} />
              <SecondaryButton label={withCreditCost('Start a new run', retryCost)} onPress={onStartNewRun} />
              <SecondaryButton label="Back to creator" onPress={onMinimize} />
            </View>
          ) : failed ? (
            <View style={{ flex: 1, minHeight: 560, justifyContent: 'center', gap: 18 }}>
              <View style={{ height: 310, borderRadius: 28, borderWidth: 1, borderColor: hexWithAlpha(theme.colors.danger, 0.24), backgroundColor: theme.colors.panel, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 28 }}>
                <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: hexWithAlpha(theme.colors.danger, 0.12), alignItems: 'center', justifyContent: 'center' }}>
                  <X size={28} color={theme.colors.danger} />
                </View>
                <Text style={{ color: theme.colors.text, fontSize: 20, fontWeight: '800', textAlign: 'center' }}>We couldn’t create this {medium}</Text>
                <Text accessibilityRole="alert" selectable style={{ color: theme.colors.muted, fontSize: 13, lineHeight: 19, textAlign: 'center' }}>{error || 'Your inputs are preserved. Try again when you’re ready.'}</Text>
                {notice ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.textSecondary, fontSize: 13, fontWeight: '700', textAlign: 'center' }}>{notice}</Text> : null}
              </View>
              {refusalAction ? <PrimaryButton label={refusalAction.label} onPress={refusalAction.onPress} /> : null}
              {/* "Retry" ran a full new paid generation behind a bare verb,
                  where every other route to that spend states the price. */}
              {retryHeld ? null : refusalAction
                ? <SecondaryButton label={withCreditCost('Try again', retryCost)} onPress={onRetry} />
                : <PrimaryButton label={withCreditCost('Try again', retryCost)} onPress={onRetry} />}
              <SecondaryButton label="Back to creator" onPress={onBack} />
            </View>
          ) : (
            <View style={{ flex: 1, minHeight: 620, gap: 18 }}>
              <View accessibilityRole="progressbar" accessibilityLabel={`${TOOL_META[tool].title} generation in progress`} accessibilityValue={{ text: waitDetail }} style={{ flex: 1, minHeight: 430, borderRadius: 28, borderWidth: 1, borderColor: theme.colors.borderStrong, backgroundColor: theme.colors.panel, alignItems: 'center', justifyContent: 'center', gap: 18 }}>
                <View style={{ width: 82, height: 82, borderRadius: 28, backgroundColor: hexWithAlpha(theme.colors.primary, 0.12), alignItems: 'center', justifyContent: 'center' }}>
                  <Sparkles size={38} color={theme.colors.primary} />
                </View>
                <Text style={{ color: theme.colors.text, fontSize: 21, fontWeight: '800' }}>{waitTitle}</Text>
                {waitCountdown !== null && waitPercent !== null ? (
                  // Progress indicators: switch from indeterminate to determinate
                  // once the duration can be told. The server's estimate for this
                  // model and these settings is that duration; a run without one
                  // keeps the spinner.
                  <View testID="generation-wait-estimate" style={{ alignSelf: 'stretch', paddingHorizontal: 40, gap: 10 }}>
                    <View style={{ height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: theme.colors.borderStrong }}>
                      <View testID="generation-wait-bar" style={{ width: `${waitPercent}%`, height: '100%', borderRadius: 3, backgroundColor: theme.colors.primary }} />
                    </View>
                    <Text style={{ color: theme.colors.text, fontSize: 15, fontWeight: '800', textAlign: 'center', fontVariant: ['tabular-nums'] }}>{waitCountdown}</Text>
                  </View>
                ) : (
                  <ActivityIndicator color={theme.colors.primary} size="large" />
                )}
                {/* Under the spinner or the bar alike: how long it has run is
                    true whatever an estimate says. Progress indicators: a vague
                    status "seldom adds value", and knowing how long it has run
                    is what lets someone decide whether to keep waiting when the
                    provider reports no progress. */}
                <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.muted, fontSize: 12, textAlign: 'center', paddingHorizontal: 40, lineHeight: 18 }}>{waitDetail}</Text>
                <Text style={{ color: theme.colors.faint, fontSize: 12, textAlign: 'center', paddingHorizontal: 40 }}>You can minimize this view. Generation will continue in the background.</Text>
              </View>
              {/* Offered while the wait is happening, the one moment a
                  notification plainly helps: most creations take about a
                  minute. Keyed by the run, so a minimized and reopened
                  workspace shows the same offer rather than a new one. */}
              {startedAt !== null ? (
                <PushOfferCard key={`creation:${startedAt}`} moment="creation" occasion={`creation:${startedAt}`} />
              ) : null}
              {/* The header's ✕ minimizes, as the line under the wait says. */}
              <SecondaryButton label="Open Alerts" onPress={onOpenAlerts} />
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const GUIDED_PROMPTS: Record<CreatorToolId, string[]> = {
  image: [
    'Premium product photo on a clean studio set with soft natural shadows',
    'Bold social campaign visual with cinematic lighting and clear subject focus',
    'Editorial lifestyle image with warm light and authentic texture',
  ],
  video: [
    'A polished product reveal with a slow camera push and soft studio light',
    'A fast social ad with three clear beats, energetic motion, and a strong finish',
    'A cinematic lifestyle clip with soft handheld movement and warm evening light',
  ],
  motion: [
    'Match the reference movement naturally while keeping the character consistent',
    'Use smooth confident movement with stable framing and realistic timing',
    'Follow the reference motion closely with subtle expression and clean transitions',
  ],
};

function ToolSwitcher({ value, onChange }: { value: CreatorToolId; onChange: (tool: CreatorToolId) => void }) {
  const theme = useAppTheme();
  return (
    <View
      style={{
        minHeight: 48,
        flexDirection: 'row',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      {(['image', 'video', 'motion'] as const).map((tool) => {
        const active = value === tool;
        const meta = TOOL_META[tool];
        const color = accentColor(meta.accent, theme.colors);
        return (
          <Pressable
            key={tool}
            accessibilityRole="button"
            accessibilityLabel={meta.title}
            accessibilityState={{ selected: active }}
            onPress={() => onChange(tool)}
            style={({ pressed }) => ({
              minHeight: 48,
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <Text
              style={{
                color: active ? theme.colors.text : theme.colors.muted,
                fontSize: 14,
                fontWeight: active ? '900' : '700',
              }}
            >
              {meta.title}
            </Text>
            {active ? (
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: 18,
                  right: 18,
                  bottom: -1,
                  height: 2,
                  borderRadius: 1,
                  backgroundColor: color,
                }}
              />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function CatalogEssentialControls({
  model,
  draft,
  onChange,
  hiddenControlKeys = [],
}: {
  model: ReturnType<typeof getCatalogModels>[number];
  draft: CreationDraft;
  onChange: (draft: CreationDraft) => void;
  hiddenControlKeys?: readonly string[];
}) {
  const controls = model.controls.filter((control) => (
    ['aspectRatio', 'resolution', 'duration'].includes(control.key) && !hiddenControlKeys.includes(control.key) && catalogConditionsMatch(control.conditions, getCatalogDraftSettings(draft, model), buildCatalogQuoteRequest(draft, model, 'conditions').inputCounts ?? {})
  ));
  return (
    <>
      {controls.map((control) => {
        if (control.type === 'choice') {
          const current = String(readCatalogControlDraftValue(draft, control));
          const options = control.key === 'aspectRatio' ? orderAspectRatioOptions(control.options) : control.options;
          return (
            <OptionRow key={control.key} title={control.label}>
              {control.key === 'aspectRatio' ? (
                <AspectRatioOptions
                  options={options}
                  value={current}
                  accent={draft.tool}
                  onChange={(value) => onChange(writeCatalogControlDraftValue(draft, control, value))}
                />
              ) : (
                <ParameterChoiceOptions
                  controlKey={control.key}
                  controlLabel={control.label}
                  options={options.map((option) => ({
                    ...option,
                    label: control.key === 'duration' ? `${option.label}s` : option.label,
                  }))}
                  value={current}
                  accent={draft.tool}
                  onChange={(value) => onChange(writeCatalogControlDraftValue(
                    draft,
                    control,
                    control.key === 'duration' ? Number(value) : value,
                  ))}
                />
              )}
            </OptionRow>
          );
        }
        if (control.type === 'integer') {
          const draftValue = readCatalogControlDraftValue(draft, control);
          const current = typeof draftValue === 'number' ? draftValue : control.defaultValue;
          return (
            <OptionRow key={control.key} title={control.label}>
              <ParameterStepper
                controlKey={control.key}
                controlLabel={control.label}
                value={`${current}${control.unit === 'seconds' ? 's' : ''}`}
                accent={draft.tool}
                decrementDisabled={current <= control.min}
                incrementDisabled={current >= control.max}
                onDecrement={() => onChange(writeCatalogControlDraftValue(
                  draft,
                  control,
                  Math.max(control.min, current - control.step),
                ))}
                onIncrement={() => onChange(writeCatalogControlDraftValue(
                  draft,
                  control,
                  Math.min(control.max, current + control.step),
                ))}
              />
            </OptionRow>
          );
        }
        return null;
      })}
    </>
  );
}

function PreparedReferenceIds({
  title,
  accessibilityLabel,
  placeholder,
  items,
  max,
  onChange,
}: {
  title: string;
  accessibilityLabel: string;
  placeholder: string;
  items: string[];
  max: number;
  onChange: (items: string[]) => void;
}) {
  const theme = useAppTheme();
  const [draft, setDraft] = useState('');
  const add = () => {
    const value = draft.trim();
    if (!/^[A-Za-z0-9._:-]{3,256}$/.test(value) || items.includes(value) || items.length >= max) return;
    onChange([...items, value]);
    setDraft('');
  };

  return (
    <View style={{ gap: 10 }}>
      <AppText variant="label" color="secondary">{title} ({items.length}/{max})</AppText>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput
          accessibilityLabel={accessibilityLabel}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={add}
          submitBehavior="submit"
          returnKeyType="done"
          placeholder={placeholder}
          placeholderTextColor={theme.colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          style={{
            flex: 1,
            minHeight: appTheme.touch.default,
            borderRadius: 16,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: hexWithAlpha(theme.colors.text, 0.12),
            backgroundColor: theme.colors.surfaceInset,
            color: theme.colors.text,
            paddingHorizontal: 12,
            fontSize: 13,
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Add ${title.toLowerCase()}`}
          onPress={add}
          disabled={items.length >= max}
          style={({ pressed }) => ({
            minWidth: 64,
            minHeight: appTheme.touch.default,
            borderRadius: 16,
            borderCurve: 'continuous',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: hexWithAlpha(theme.colors.primary, 0.16),
            borderWidth: 1,
            borderColor: hexWithAlpha(theme.colors.primary, 0.38),
            opacity: pressed ? appTheme.opacity.pressed : (items.length >= max ? 0.45 : 1),
          })}
        >
          <AppText variant="label">Add</AppText>
        </Pressable>
      </View>
      {items.map((item) => (
        <View key={item} style={{ minHeight: 46, borderRadius: 15, borderCurve: 'continuous', borderWidth: 1, borderColor: hexWithAlpha(theme.colors.text, 0.08), backgroundColor: hexWithAlpha(theme.colors.text, 0.035), paddingLeft: 12, paddingRight: 6, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text selectable numberOfLines={1} style={{ flex: 1, color: theme.colors.textSecondary, fontFamily: 'monospace', fontSize: 12 }}>{item}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${item}`} onPress={() => onChange(items.filter((value) => value !== item))} hitSlop={8} style={({ pressed }) => ({ padding: 9, opacity: pressed ? appTheme.opacity.pressed : 1 })}>
            <Trash2 size={16} color={theme.colors.muted} />
          </Pressable>
        </View>
      ))}
      <AppText variant="caption" color="muted">Use IDs created by Gemini Omni’s voice or character preparation endpoints.</AppText>
    </View>
  );
}

function CatalogAdvancedControls({ model, draft, onChange, hiddenControlKeys = [] }: {
  model: ReturnType<typeof getCatalogModels>[number];
  draft: CreationDraft;
  onChange: (draft: CreationDraft) => void;
  hiddenControlKeys?: readonly string[];
}) {
  const controls = model.controls.filter((control) => (
    !['aspectRatio', 'resolution', 'duration'].includes(control.key) && !hiddenControlKeys.includes(control.key) && catalogConditionsMatch(control.conditions, getCatalogDraftSettings(draft, model), buildCatalogQuoteRequest(draft, model, 'conditions').inputCounts ?? {})
  ));
  return (
    <>
      {controls.map((control) => {
        if (control.type === 'boolean') {
          return (
            <ToggleRow
              key={control.key}
              title={control.label}
              value={Boolean(readCatalogControlDraftValue(draft, control))}
              onValueChange={(value) => onChange(writeCatalogControlDraftValue(draft, control, value))}
            />
          );
        }
        if (control.type === 'choice') {
          const current = String(readCatalogControlDraftValue(draft, control));
          if (control.key === 'outputFormat' && control.options.length <= 1) {
            const selectedOption = control.options.find((option) => option.value === current) ?? control.options[0];
            return (
              <OptionRow key={control.key} title={control.label}>
                <ReadOnlyParameterValue value={(selectedOption?.label ?? current).toUpperCase()} />
              </OptionRow>
            );
          }
          return (
            <OptionRow key={control.key} title={control.label}>
              <ParameterChoiceOptions
                controlKey={control.key}
                controlLabel={control.label}
                options={control.options}
                value={current}
                accent={draft.tool}
                onChange={(value) => onChange(writeCatalogControlDraftValue(draft, control, value))}
              />
            </OptionRow>
          );
        }
        const draftValue = readCatalogControlDraftValue(draft, control);
        const current = typeof draftValue === 'number' ? draftValue : control.defaultValue;
        return (
          <OptionRow key={control.key} title={control.label}>
            <ParameterStepper
              controlKey={control.key}
              controlLabel={control.label}
              value={`${current}${control.unit === 'seconds' ? 's' : ''}`}
              accent={draft.tool}
              decrementDisabled={current <= control.min}
              incrementDisabled={current >= control.max}
              onDecrement={() => onChange(writeCatalogControlDraftValue(
                draft,
                control,
                Math.max(control.min, current - control.step),
              ))}
              onIncrement={() => onChange(writeCatalogControlDraftValue(
                draft,
                control,
                Math.min(control.max, current + control.step),
              ))}
            />
          </OptionRow>
        );
      })}
    </>
  );
}

function OptionRow({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useAppTheme();
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.colors.muted, fontSize: 12, fontWeight: '800', textTransform: 'uppercase' }}>{title}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{children}</View>
    </View>
  );
}

function aspectRatioPreviewSize(value: string) {
  const [widthValue, heightValue] = value.split(':').map(Number);
  if (!Number.isFinite(widthValue) || !Number.isFinite(heightValue) || widthValue <= 0 || heightValue <= 0) return null;
  const maximum = 20;
  const minimum = 6;
  if (widthValue >= heightValue) {
    return { width: maximum, height: Math.max(minimum, maximum * (heightValue / widthValue)) };
  }
  return { width: Math.max(minimum, maximum * (widthValue / heightValue)), height: maximum };
}

function parameterChoiceWidth(options: Array<{ label: string }>) {
  if (options.length <= 1) return '100%';
  if (options.length === 2 || options.some((option) => option.label.length > 8)) return '48.5%';
  if (options.length === 3) return '31%';
  return '23%';
}

function ParameterChoiceOptions({
  controlKey,
  controlLabel,
  options,
  value,
  accent,
  onChange,
}: {
  controlKey: string;
  controlLabel: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  accent: ToolAccent;
  onChange: (value: string) => void;
}) {
  const theme = useAppTheme();
  const color = accentColor(accent, theme.colors);
  const width = parameterChoiceWidth(options);
  return (
    <View testID={`parameter-choice-options-${controlKey}`} style={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            testID={`parameter-choice-${controlKey}-${option.value}`}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityHint={`Selects ${option.label} for ${controlLabel.toLowerCase()}`}
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => ({
              width,
              minWidth: options.length <= 2 ? 120 : 68,
              minHeight: 48,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: active ? `${color}8a` : theme.colors.border,
              backgroundColor: active ? `${color}20` : pressed ? theme.colors.pressed : theme.colors.surfaceStrong,
              paddingHorizontal: 10,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <Text numberOfLines={2} style={{ color: active ? theme.colors.text : theme.colors.muted, fontSize: 12, lineHeight: 16, fontWeight: active ? '800' : '700', textAlign: 'center' }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ParameterStepper({
  controlKey,
  controlLabel,
  value,
  accent,
  decrementDisabled,
  incrementDisabled,
  onDecrement,
  onIncrement,
}: {
  controlKey: string;
  controlLabel: string;
  value: string;
  accent: ToolAccent;
  decrementDisabled: boolean;
  incrementDisabled: boolean;
  onDecrement: () => void;
  onIncrement: () => void;
}) {
  const theme = useAppTheme();
  const color = accentColor(accent, theme.colors);
  const buttonStyle = (disabled: boolean, pressed: boolean) => ({
    width: '31%' as const,
    minWidth: 68,
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: pressed ? theme.colors.pressed : theme.colors.surfaceStrong,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    opacity: disabled ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
  });
  return (
    <View testID={`parameter-stepper-${controlKey}`} style={{ width: '100%', flexDirection: 'row', gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Decrease ${controlLabel.toLowerCase()}`}
        disabled={decrementDisabled}
        onPress={onDecrement}
        style={({ pressed }) => buttonStyle(decrementDisabled, pressed)}
      >
        <Text style={{ color: theme.colors.muted, fontSize: 18, fontWeight: '700' }}>−</Text>
      </Pressable>
      <View
        accessibilityRole="text"
        accessibilityLabel={`${controlLabel}, ${value}`}
        style={{ width: '31%', minWidth: 68, minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: `${color}8a`, backgroundColor: `${color}20`, alignItems: 'center', justifyContent: 'center' }}
      >
        <Text style={{ color: theme.colors.text, fontSize: 12, fontWeight: '800' }}>{value}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Increase ${controlLabel.toLowerCase()}`}
        disabled={incrementDisabled}
        onPress={onIncrement}
        style={({ pressed }) => buttonStyle(incrementDisabled, pressed)}
      >
        <Text style={{ color: theme.colors.muted, fontSize: 18, fontWeight: '700' }}>+</Text>
      </Pressable>
    </View>
  );
}

function AspectRatioOptions({
  options,
  value,
  accent,
  onChange,
}: {
  options: Array<{ value: string; label: string }>;
  value: string;
  accent: ToolAccent;
  onChange: (value: string) => void;
}) {
  const theme = useAppTheme();
  const color = accentColor(accent, theme.colors);
  return (
    <View testID="aspect-ratio-options" style={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((option) => {
        const active = option.value === value;
        const previewSize = option.value.toLowerCase() === 'auto' ? null : aspectRatioPreviewSize(option.value);
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityHint={previewSize ? `Uses a ${option.label} aspect ratio` : 'Lets the model choose the aspect ratio'}
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => ({
              width: '23%',
              minWidth: 68,
              minHeight: 48,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: active ? `${color}8a` : theme.colors.border,
              backgroundColor: active ? `${color}20` : pressed ? theme.colors.pressed : theme.colors.surfaceStrong,
              paddingHorizontal: 6,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            {previewSize ? (
              <View
                testID={`aspect-ratio-preview-${option.value}`}
                accessible={false}
                style={{
                  width: previewSize.width,
                  height: previewSize.height,
                  borderRadius: 2,
                  borderWidth: 1.5,
                  borderColor: active ? color : theme.colors.textSecondary,
                }}
              />
            ) : null}
            <Text numberOfLines={1} style={{ color: active ? theme.colors.text : theme.colors.muted, fontSize: 11, fontWeight: active ? '800' : '700' }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ReadOnlyParameterValue({ value }: { value: string }) {
  const theme = useAppTheme();
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`${value}. Fixed for this model`}
      testID="read-only-parameter-value"
      style={{ width: '100%', minHeight: 48, borderRadius: 16, backgroundColor: theme.colors.surfaceInset, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
    >
      <Text style={{ color: theme.colors.text, fontSize: 13, fontWeight: '800' }}>{value}</Text>
      <Text style={{ color: theme.colors.muted, fontSize: 11, fontWeight: '700' }}>Fixed for this model</Text>
    </View>
  );
}

function Chip({ label, active, onPress, accent = 'motion' }: { label: string; active: boolean; onPress: () => void; accent?: ToolAccent }) {
  return (
    <ChoiceChip
      label={label}
      active={active}
      onPress={onPress}
      accent={accent}
      compact
    />
  );
}

function ToggleRow({ title, value, onValueChange }: { title: string; value: boolean; onValueChange: (value: boolean) => void }) {
  const theme = useAppTheme();
  return (
    <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Text style={{ color: theme.colors.text, fontSize: 15, fontWeight: '800' }}>{title}</Text>
      <Pressable
        testID="compact-toggle-control"
        accessibilityRole="switch"
        accessibilityLabel={title}
        accessibilityHint={`Turns ${title.toLowerCase()} ${value ? 'off' : 'on'}`}
        accessibilityState={{ checked: value }}
        onPress={() => onValueChange(!value)}
        style={({ pressed }) => ({
          width: 56,
          minHeight: 48,
          alignItems: 'flex-end',
          justifyContent: 'center',
          opacity: pressed ? appTheme.opacity.pressed : 1,
        })}
      >
        <Switch
          testID="compact-toggle-visual"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no"
          pointerEvents="none"
          value={value}
          style={{ transform: [{ scale: 0.76 }] }}
          thumbColor={value ? theme.colors.onPrimary : theme.colors.switchThumbOff}
          trackColor={{ false: theme.colors.switchTrackOff, true: theme.colors.primaryFill }}
        />
      </Pressable>
    </View>
  );
}

/** Renews a reference's link from where it came from. The creator screen supplies it. */
const ReferenceLinkRenewal = createContext<((media: MediaDraft) => Promise<string>) | null>(null);

/** Storage paths of staged uploads the server has swept. The creator screen supplies them. */
const UnavailableReferences = createContext<ReadonlySet<string>>(new Set());

/** The picker's own copy of each upload made this session, by storage path. The creator screen supplies them. */
const LocalReferencePreviews = createContext<ReadonlyMap<string, string>>(new Map());

/**
 * What a reference is drawn from: the picker's copy on the phone while this session lasts, the
 * signed link otherwise. The link is the whole upload, fetched again for a 72pt tile; the run
 * still sends the link, which is all the draft keeps.
 */
function useReferencePreviewUrl(media: MediaDraft) {
  const localPreviews = useContext(LocalReferencePreviews);
  return (media.storagePath ? localPreviews.get(media.storagePath) : undefined) ?? media.url;
}

/**
 * A prompt's length against its model's own limit, as web's counter shows it ("4,812 / 5,000"):
 * the limit Kie sets for that model (Z-Image 1,000, a Kling 3.0 shot 500), or the route's where it
 * sets none (10,000, motion 2,500). Muted with room, amber in the limit's last tenth, danger past it.
 * The box never cuts what is past it (its maxLength stays the route's): the run waits, and the
 * blocker beside Generate says why in the start's own words.
 */
function PromptLengthCounter({ meter, testID = 'prompt-length' }: { meter: PromptLengthMeter; testID?: string }) {
  const theme = useAppTheme();
  const color = meter.state === 'over' ? theme.colors.danger : meter.state === 'near' ? theme.colors.amber : theme.colors.muted;
  return (
    <Text
      testID={testID}
      accessibilityLabel={`${groupDigits(meter.length)} of ${groupDigits(meter.limit)} characters${meter.state === 'over' ? ', over the limit' : ''}`}
      style={{ alignSelf: 'flex-end', color, fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'], paddingHorizontal: 16, paddingBottom: 10 }}
    >
      {meter.label}
    </Text>
  );
}

/**
 * What the enhancer noticed about the prompt it wrote, such as a length past what the model reads:
 * the web shows these as "Prompt quality notes", and the app dropped them.
 */
function PromptQualityNotes({ warnings }: { warnings: PromptEnhancementWarning[] }) {
  const theme = useAppTheme();
  if (warnings.length === 0) return null;
  return (
    <View testID="prompt-quality-notes" style={{ marginHorizontal: 16, marginBottom: 12, borderRadius: 14, borderWidth: 1, borderColor: hexWithAlpha(theme.colors.amber, 0.28), backgroundColor: hexWithAlpha(theme.colors.amber, 0.08), paddingHorizontal: 12, paddingVertical: 10, gap: 4 }}>
      <Text style={{ color: theme.colors.text, fontSize: 12, fontWeight: '800' }}>Prompt quality notes</Text>
      {warnings.map((warning, index) => (
        <Text key={`${warning.code}:${index}`} style={{ color: theme.colors.textSecondary, fontSize: 12, lineHeight: 17 }}>{warning.message}</Text>
      ))}
    </View>
  );
}

/**
 * A subject's tile: its pictures in a two-by-two collage. One picture would read as
 * one reference, and a subject is its several pictures together.
 */
function SubjectPreview({ subject, size = 72 }: { subject: SubjectDraft; size?: number }) {
  const theme = useAppTheme();
  const renewLink = useContext(ReferenceLinkRenewal);
  const gap = 2;
  const cell = (size - gap) / 2;
  return (
    <View
      testID={`subject-preview-${subject.id}`}
      style={{ width: size, height: size, borderRadius: 16, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: theme.colors.surfaceStrong, flexDirection: 'row', flexWrap: 'wrap', gap }}
    >
      {subject.images.slice(0, 4).map((image) => (
        <SubjectPicture key={image.id} image={image} size={cell} renewLink={renewLink} />
      ))}
    </View>
  );
}

function SubjectPicture({ image, size, renewLink }: { image: MediaDraft; size: number; renewLink: ((media: MediaDraft) => Promise<string>) | null }) {
  const theme = useAppTheme();
  const unavailable = useContext(UnavailableReferences);
  const url = useReferencePreviewUrl(image);
  if (image.storagePath && unavailable.has(image.storagePath)) {
    // Swept from storage: nothing is left to draw, and the subject is added again.
    return (
      <View
        testID={`reference-unavailable-${image.id}`}
        style={{ width: size, height: size, borderWidth: 1, borderStyle: 'dashed', borderColor: hexWithAlpha(theme.colors.amber, 0.5), backgroundColor: hexWithAlpha(theme.colors.amber, 0.08) }}
      />
    );
  }
  return (
    <StableMediaImage
      url={url}
      cacheKey={`reference-thumbnail:${image.id}:${url}`}
      contentFit="cover"
      transition={80}
      style={{ width: size, height: size }}
      resolveRetryUrl={renewLink ? () => renewLink(image) : undefined}
    />
  );
}

function ReferenceMediaPreview({ media, size }: { media: MediaDraft; size?: number }) {
  const theme = useAppTheme();
  // A saved link can have run out. Retrying the thumbnail then fetches a fresh
  // one instead of asking for the dead link again.
  const renewLink = useContext(ReferenceLinkRenewal);
  const unavailable = useContext(UnavailableReferences);
  const previewUrl = useReferencePreviewUrl(media);
  const resolveRetryUrl = renewLink ? () => renewLink(media) : undefined;
  const width = size ?? 58;
  const height = size ?? 72;
  if (media.storagePath && unavailable.has(media.storagePath)) {
    // Nothing is left to draw or retry: the upload has to be added again.
    return (
      <View
        testID={`reference-unavailable-${media.id}`}
        style={{
          width,
          height,
          borderRadius: 16,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderStyle: 'dashed',
          borderColor: hexWithAlpha(theme.colors.amber, 0.5),
          backgroundColor: hexWithAlpha(theme.colors.amber, 0.08),
          alignItems: 'center',
          justifyContent: 'center',
          padding: 6,
        }}
      >
        {width >= 56 ? (
          <Text numberOfLines={3} style={{ color: theme.colors.amber, fontSize: 11, fontWeight: '800', lineHeight: 14, textAlign: 'center' }}>Add this reference again</Text>
        ) : null}
      </View>
    );
  }
  if (media.kind === 'audio') {
    return (
      <View
        style={{
          width,
          height,
          borderRadius: 16,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: hexWithAlpha(theme.colors.motion, 0.26),
          backgroundColor: theme.colors.pressed,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
        }}
      >
        <AudioLines size={22} color={theme.colors.motion} />
        <Text style={{ color: theme.colors.motion, fontSize: 11, fontWeight: '800' }}>Audio</Text>
      </View>
    );
  }

  const kind = media.kind === 'video' ? 'video' : 'image';

  return (
    <View
      style={{
        width,
        height,
        borderRadius: 16,
        borderCurve: 'continuous',
        overflow: 'hidden',
        backgroundColor: theme.colors.surfaceStrong,
      }}
    >
      {kind === 'image' ? (
        <StableMediaImage
          url={previewUrl}
          cacheKey={`reference-thumbnail:${media.id}:${previewUrl}`}
          contentFit="cover"
          transition={80}
          style={{ width: '100%', height: '100%' }}
          resolveRetryUrl={resolveRetryUrl}
        />
      ) : (
        <MediaPreview
          url={previewUrl}
          kind={kind}
          height={height}
          radius={16}
          nativeControls={false}
          // Fills the tile, with the clip centred in it. A 4:5 card of this
          // height is narrower than a square tile and sits against its left edge.
          letterbox
          resolveRetryUrl={resolveRetryUrl}
        />
      )}
      {kind === 'video' ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 6,
            bottom: 6,
            width: 24,
            height: 24,
            borderRadius: 12,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: hexWithAlpha(mediaColors.mediaGround, 0.58),
          }}
        >
          <Play size={13} color={mediaColors.onMedia} fill={mediaColors.onMedia} />
        </View>
      ) : null}
    </View>
  );
}
