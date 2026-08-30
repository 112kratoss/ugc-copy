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
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Modal, Pressable, ScrollView, Switch, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { MediaPreview, StableMediaImage } from '@/components/media-preview';
import {
  AppText,
  ChoiceChip,
  PrimaryButton,
  SecondaryButton,
} from '@/components/ui';
import { showConfirmDialog } from '@/lib/dialog';
import { useAuth } from '@/lib/auth';
import { clearPersistedCreationDrafts, loadPersistedCreationDrafts, persistCreationDrafts, remixDraftScope } from '@/lib/creation-draft-resume';
import { createDraftSaveQueue } from '@/lib/draft-save-queue';
import { SheetGrabber, SheetPanel, useSheetDismissDrag } from '@/components/sheet-chrome';
import { useReducedMotion } from '@/lib/motion';
import { CloseGlyph } from '@/lib/platform-glyphs';
import { trackOnboardingEvent } from '@/lib/onboarding';
import { getGenerationOutput, pollGenerationStatus } from '@/lib/generation';
import {
  applyCatalogModelInitialDefaults,
  applyCatalogModelDefaults,
  buildCatalogGenerationPayload,
  buildCatalogQuoteRequest,
  buildUnifiedCatalogGenerationRequest,
  getCatalogDraftSettings,
  hasCreatorEditedPromptDuringRemix,
  hydrateCatalogCreationDraftFromRemixSource,
  reconcileCreationDraftWithCatalog,
  validateCatalogCreationDraft,
} from '@/lib/generation-model-draft';
import {
  getActiveCatalogInputSlots,
  getCatalogModel,
  getCatalogModels,
  type CatalogControl,
  type CatalogInputSlot,
  type CatalogPrimitive,
  type GenerationModelCatalog,
} from '@/lib/generation-model-catalog';
import {
  applyModelDefaults,
  buildPromptEnhancementRequest,
  createDefaultCreationDraft,
  createMediaDraftFromUpload,
  getMotionDuration,
  REMIX_RESTORE_WARNING_MESSAGE,
  renameMediaDraft,
  replaceMediaDraftMedia,
  type CreationDraft,
  type ImageCreationDraft,
  type ImageModelId,
  type MediaDraft,
  type MotionCreationDraft,
  type MotionModelId,
  type VideoCreationDraft,
  type VideoModelId,
} from '@/lib/media-creation-view-model';
import { assetDurationSeconds, pickAudioDocument, pickMedia, pickMediaList, uploadPickedMedia } from '@/lib/media';
import {
  findActiveReferenceMention,
  insertHandleAtSelection,
  normalizeTextSelection,
  type TextSelection,
} from '@/lib/reference-mentions';
import { formatCreditAmount } from '@/lib/pricing';
import { withCreditCost } from '@/lib/generation-action-label';
import { generationWaitDetail, generationWaitPhase, generationWaitTitle } from '@/lib/generation-wait';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { accentColor, appTheme, type ToolAccent } from '@/lib/theme';
import type { CreatorToolId, GenerationStartResponse, GenerationStatusResponse, PromptEnhancementLevel } from '@/lib/types';
import { useGenerationModelCatalog } from '@/lib/use-generation-model-catalog';
import { verticalHitSlop } from '@/lib/hit-target';
import { haptic } from '@/lib/haptics';

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

function catalogDraftInputCounts(
  model: CreatorCatalogModel,
  draft: CreationDraft,
): Record<string, number> {
  const countForSlot = (slot: CatalogInputSlot) => {
    const catalogAssets = draft.catalogInputSlots?.[slot.key];
    if (catalogAssets) return catalogAssets.length;
    if (slot.role === 'startFrame') return draft.tool === 'video' && draft.startFrame ? 1 : 0;
    if (slot.role === 'endFrame') return draft.tool === 'video' && draft.endFrame ? 1 : 0;
    if (slot.kind === 'image') {
      if (draft.tool === 'image' || draft.tool === 'video') return draft.references.length;
      return draft.characterImage ? 1 : 0;
    }
    if (slot.kind === 'video') {
      if (draft.tool === 'video') return draft.referenceVideos.length;
      return draft.tool === 'motion' && draft.referenceVideo ? 1 : 0;
    }
    if (slot.kind === 'audio') return draft.tool === 'video' ? draft.referenceAudios.length : 0;
    if (slot.kind === 'preparedVoice') return draft.tool === 'video' ? draft.preparedAudioIds.length : 0;
    return draft.tool === 'video' ? draft.characterIds.length : 0;
  };

  return Object.fromEntries((model.inputModes ?? [])
    .flatMap((mode) => mode.slots)
    .map((slot) => [slot.key, countForSlot(slot)]));
}

function activeCatalogInputSlots(
  model: CreatorCatalogModel | null,
  draft: CreationDraft,
) {
  if (!model?.inputModes) return null;
  const settings = {
    ...getCatalogDraftSettings(draft, model),
    ...(draft.tool === 'video'
      ? { referenceMode: draft.referenceMode, isMultiShot: draft.isMultiShot }
      : {}),
  };
  return getActiveCatalogInputSlots(model, settings, catalogDraftInputCounts(model, draft));
}

function catalogInputSlot(
  model: CreatorCatalogModel | null,
  draft: CreationDraft,
  key: string,
): CatalogInputSlot | null {
  return activeCatalogInputSlots(model, draft)?.find((slot) => slot.key === key) ?? null;
}

function catalogInputLimit(
  model: CreatorCatalogModel | null,
  draft: CreationDraft,
  key: string,
  legacyMax: number,
) {
  if (!model?.inputModes) return legacyMax;
  return catalogInputSlot(model, draft, key)?.max ?? 0;
}

function catalogInputSupported(
  model: CreatorCatalogModel | null,
  draft: CreationDraft,
  key: string,
  legacySupported: boolean,
) {
  if (!model?.inputModes) return legacySupported;
  return Boolean(catalogInputSlot(model, draft, key));
}

function supportsReusableVideoInputs(
  model: CreatorCatalogModel | null,
  draft: VideoCreationDraft,
) {
  if (!model) return false;
  if (model.inputModes) {
    return (activeCatalogInputSlots(model, draft) ?? []).some((slot) => (
      slot.role === 'reference'
      && ['image', 'video', 'audio', 'character', 'preparedVoice'].includes(slot.kind)
    ));
  }
  return Boolean(
    model.inputs.imageReferences
    || model.inputs.videoReferences
    || model.inputs.audioReferences
    || model.inputs.preparedAudioReferences
    || model.inputs.characterReferences
  );
}

function creatorParameterSummary(draft: CreationDraft, model: CreatorCatalogModel | null) {
  if (draft.tool === 'image') {
    return [draft.resolution, draft.aspectRatio, draft.outputFormat.toUpperCase()].filter(Boolean).join(' · ');
  }
  if (draft.tool === 'video') {
    const totalDuration = draft.isMultiShot
      ? draft.multiPrompts.reduce((total, shot) => total + Math.max(1, Math.round(shot.duration || 0)), 0)
      : draft.duration;
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

function mediaAccessibleName(media: MediaDraft) {
  return media.displayName.trim() || media.fileName.trim() || 'unnamed reference';
}

function renameMediaInList(items: MediaDraft[], id: string, displayName: string) {
  return items.map((media) => (media.id === id ? renameMediaDraft(media, displayName) : media));
}

function replaceMediaInList(items: MediaDraft[], id: string, upload: Parameters<typeof replaceMediaDraftMedia>[1]) {
  return items.map((media) => (media.id === id ? replaceMediaDraftMedia(media, upload) : media));
}

function hasStartedCreationDraft(draft: CreationDraft) {
  if (draft.prompt.trim()) return true;
  if (draft.tool === 'image') return draft.references.length > 0;
  if (draft.tool === 'video') {
    return draft.references.length > 0
      || draft.referenceVideos.length > 0
      || draft.referenceAudios.length > 0
      || Boolean(draft.startFrame)
      || Boolean(draft.endFrame)
      || draft.multiPrompts.some((shot) => shot.prompt.trim());
  }
  return Boolean(draft.characterImage) || Boolean(draft.referenceVideo);
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

export function MediaCreationScreen({
  initialTool = 'image',
  insideTab = false,
  initialPrompt,
  remixSource,
  guided = false,
  onClose,
  registerBeforeClose,
  onDirtyChange,
}: {
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
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // `user` still gates remix restore, which pulls another creator's source
  // media out of the community feed. Generating and enhancing key off
  // `identityUserId` so a guest can spend the credits they just bought.
  const { user, identityUserId, api, credits, updateCredits } = useAuth();
  const catalogQuery = useGenerationModelCatalog(api);
  const catalog = catalogQuery.catalog;
  const refetchCatalog = catalogQuery.refetch;
  const [activeTool, setActiveTool] = useState<CreatorToolId>(isTool(initialTool) ? initialTool : 'image');
  const [imageDraft, setImageDraft] = useState<ImageCreationDraft>(() => ({
    ...createDefaultCreationDraft('image'),
    prompt: initialTool === 'image' ? initialPrompt ?? '' : '',
  }));
  const [videoDraft, setVideoDraft] = useState<VideoCreationDraft>(() => ({
    ...createDefaultCreationDraft('video'),
    prompt: initialTool === 'video' ? initialPrompt ?? '' : '',
  }));
  const [motionDraft, setMotionDraft] = useState<MotionCreationDraft>(() => ({
    ...createDefaultCreationDraft('motion'),
    prompt: initialTool === 'motion' ? initialPrompt ?? '' : '',
  }));
  const [isUploading, setIsUploading] = useState(false);
  const [replacingReferenceId, setReplacingReferenceId] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [enhanceLevel, setEnhanceLevel] = useState<'cinematic' | 'faithful'>('cinematic');
  const [enhanceUndo, setEnhanceUndo] = useState<{ previous: string; enhanced: string } | null>(null);
  const [status, setStatus] = useState<GenerationStatusResponse | null>(null);
  const [lastGenerationId, setLastGenerationId] = useState<string | null>(null);
  const [lastPredictionId, setLastPredictionId] = useState<string | null>(null);
  const [generationTool, setGenerationTool] = useState<CreatorToolId | null>(null);
  const [pollingInterrupted, setPollingInterrupted] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [guidedReferencesExpanded, setGuidedReferencesExpanded] = useState(false);
  const [draftsHydrated, setDraftsHydrated] = useState(false);
  const [draftLoadError, setDraftLoadError] = useState(false);
  const [draftLoadAttempt, setDraftLoadAttempt] = useState(0);
  const [draftSaveError, setDraftSaveError] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const closingRef = useRef(false);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumedRemixRef = useRef(false);
  const remixResolvedRef = useRef(false);
  const [remixRetry, setRemixRetry] = useState(0);
  const [remixRestoreFailed, setRemixRestoreFailed] = useState(false);
  const draftScope = remixDraftScope(identityUserId, remixSource);
  const draftWriter = useMemo(() => createDraftSaveQueue((drafts: { image: ImageCreationDraft; video: VideoCreationDraft; motion: MotionCreationDraft; remixRestored?: boolean; remixEditedKeys?: Partial<Record<CreatorToolId, string[]>> }) => persistCreationDrafts(drafts, draftScope)), [draftScope]);
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

  const [showNotificationPrompt, setShowNotificationPrompt] = useState(false);
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

  useEffect(() => {
    let active = true;
    setDraftsHydrated(false);
    setDraftLoadError(false);
    resumedRemixRef.current = false;
    remixResolvedRef.current = false;
    // A prompt-only entry has its own seed; a remix can resume its own session.
    const load = initialPrompt && !draftScope ? Promise.resolve(null) : loadPersistedCreationDrafts(draftScope);
    void load.then((persisted) => {
      if (!active) return;
      if (persisted) {
        setImageDraft(persisted.image);
        setVideoDraft(persisted.video);
        setMotionDraft(persisted.motion);
        resumedRemixRef.current = Boolean(draftScope && persisted.remixRestored);
        remixResolvedRef.current = resumedRemixRef.current;
        savedRemixEdits.current = persisted.remixEditedKeys ?? {};
      }
      lastSavedFingerprint.current = JSON.stringify(persisted ? { image: persisted.image, video: persisted.video, motion: persisted.motion } : latestDrafts.current);
      setDraftsHydrated(true);
    }).catch(() => { if (active) setDraftLoadError(true); });
    return () => { active = false; };
  }, [draftScope, initialPrompt, draftLoadAttempt]);

  const saveLatestDraft = async () => {
    if (!draftsHydrated) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = null;
    // If a keystroke lands during a slow write, flush that newer snapshot too.
    let saved: typeof latestDrafts.current;
    do {
      saved = latestDrafts.current;
      const fingerprint = JSON.stringify(saved);
      if (fingerprint === lastSavedFingerprint.current) return;
      const remixEditedKeys = Object.fromEntries((['image', 'video', 'motion'] as const).map((tool) => [tool,
        Object.keys(saved[tool]).filter((key) => JSON.stringify((saved[tool] as unknown as Record<string, unknown>)[key]) !== JSON.stringify((remixBaseline.current[tool] as unknown as Record<string, unknown>)[key])),
      ]));
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
      defaultId: string | null,
      setter: (updater: (draft: T) => T) => void
    ) => {
      setter((draft) => {
        const fallback = defaultId ? getCatalogModel(catalog, defaultId) : null;
        const current = getCatalogModel(catalog, draft.model);
        const currentIsCompatible = Boolean(
          current?.kind === kind
          && current.minClientSchemaVersion <= catalog.schemaVersion
          && (Number(catalog.schemaVersion) === 1 || current.availability?.mobile)
        );
        const shouldUseUntouchedDefault = Boolean(
          fallback?.kind === kind
          && currentIsCompatible
          && !draft.catalogRevision
          && !modelSelectionTouched.current[kind]
          && !hasStartedCreationDraft(draft)
        );
        if (shouldUseUntouchedDefault && fallback) {
          return applyCatalogModelInitialDefaults(
            draft,
            fallback,
            catalog.revision,
          ) as T;
        }
        const result = reconcileCreationDraftWithCatalog(draft, catalog);
        if (result.warning) setCatalogNotice(result.warning);
        return result.draft as T;
      });
    };
    reconcile<ImageCreationDraft>('image', catalog.defaults.image, setImageDraft);
    reconcile<VideoCreationDraft>('video', catalog.defaults.video, setVideoDraft);
    reconcile<MotionCreationDraft>('motion', catalog.defaults.motion, setMotionDraft);
  }, [catalog]);

  const currentDraft: CreationDraft = activeTool === 'image' ? imageDraft : activeTool === 'video' ? videoDraft : motionDraft;
  const currentCatalogModel = useMemo(
    () => catalog ? getCatalogModel(catalog, currentDraft.model) : null,
    [catalog, currentDraft.model]
  );
  const quoteRequest = useMemo(
    () => currentCatalogModel && catalog
      ? buildCatalogQuoteRequest(currentDraft, currentCatalogModel, catalog.revision)
      : null,
    [catalog, currentCatalogModel, currentDraft]
  );
  const quoteKey = quoteRequest ? JSON.stringify(quoteRequest) : null;
  const [quoteState, setQuoteState] = useState<{
    key: string | null;
    status: 'idle' | 'pending' | 'ready' | 'error';
    cost: number | null;
    error: string | null;
    normalizedSettings: Record<string, CatalogPrimitive> | null;
  }>({ key: null, status: 'idle', cost: null, error: null, normalizedSettings: null });
  const [quoteRetryNonce, setQuoteRetryNonce] = useState(0);

  useEffect(() => {
    if (!quoteRequest || !quoteKey) {
      setQuoteState({ key: null, status: 'idle', cost: null, error: null, normalizedSettings: null });
      return;
    }
    const controller = new AbortController();
    setQuoteState({ key: quoteKey, status: 'pending', cost: null, error: null, normalizedSettings: null });
    const timer = setTimeout(() => {
      void api.quoteGenerationModel(quoteRequest, controller.signal)
        .then((quote) => {
          if (!controller.signal.aborted) setQuoteState({
            key: quoteKey,
            status: 'ready',
            cost: quote.costCredits,
            error: null,
            normalizedSettings: quote.normalizedSettings,
          });
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
          setQuoteState({
            key: quoteKey,
            status: 'error',
            cost: null,
            error: error instanceof Error ? error.message : 'Could not calculate generation cost.',
            normalizedSettings: null,
          });
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, quoteKey, quoteRetryNonce, refetchCatalog]);

  const activeQuote = quoteState.key === quoteKey
    ? quoteState
    : { status: 'pending' as const, cost: null, error: null, normalizedSettings: null };
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
    setQuoteRetryNonce((value) => value + 1);
  };
  const validation = useMemo(
    () => currentCatalogModel
      ? validateCatalogCreationDraft(currentDraft, currentCatalogModel, { credits, quotedCost: activeQuote.cost })
      : catalog
        ? {
            errors: ['This model is no longer available. Review the refreshed settings.'],
            warnings: [],
            cost: 0,
            canGenerate: false,
          }
        : {
            errors: catalogUnavailable ? ['Model settings unavailable. Retry before generating.'] : [],
            warnings: [],
            cost: 0,
            canGenerate: false,
          },
    [activeQuote.cost, catalog, catalogUnavailable, currentCatalogModel, currentDraft, credits]
  );
  const outputUrl = useMemo(() => (status ? getGenerationOutput(status) : null), [status]);
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
  const generateDisabled = !draftsHydrated || isRestoringRemix || remixRestoreFailed || isClosing || isGenerating || pollingInterrupted || isUploading || !catalog || activeQuote.status !== 'ready' || validation.errors.length > 0;
  const openAuthForCurrentDraft = () => {
    router.push({
      pathname: '/auth',
      params: {
        returnTo: `/create/${currentDraft.tool}${guided ? '?guided=1' : ''}`,
      },
    } as never);
  };

  const changeTool = (tool: CreatorToolId) => {
    if (isGenerating || pollingInterrupted) {
      setMessage('This generation is still running. You can switch tools when it finishes or leave and follow it in Alerts.');
      setWorkspaceVisible(true);
      return;
    }
    setActiveTool(tool);
    setAdvancedExpanded(false);
    setGuidedReferencesExpanded(false);
    setMessage(null);
    setPromptMessage(null);
    setIsPromptFocused(false);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  };

  const replaceDraft = (draft: CreationDraft) => {
    const catalogModel = catalog ? getCatalogModel(catalog, draft.model) : null;
    const normalized = catalogModel
      ? applyCatalogModelDefaults(draft, catalogModel, catalog?.revision ?? null)
      : applyModelDefaults(draft);
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
    return (model
      ? applyCatalogModelDefaults(draft, model, catalog?.revision ?? null)
      : applyModelDefaults(draft)) as T;
  };

  useEffect(() => {
    const generationId = remixSource?.generationId?.trim();
    if (!generationId || !catalog || !draftsHydrated || resumedRemixRef.current || remixHydrationKeyRef.current === generationId) return;
    if (!user) {
      setRemixRestoreWarning('Sign in to restore remix source media.');
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
    const draftWhenRemixStarted = latestDrafts.current[targetTool];

    void api.getRemixSourceBundle(generationId, { postId: remixSource?.postId ?? null })
      .then((bundle) => {
        if (isCancelled) return;
        const baseDraft = targetTool === 'image'
          ? createDefaultCreationDraft('image')
          : targetTool === 'video'
            ? createDefaultCreationDraft('video')
            : createDefaultCreationDraft('motion');
        const restored = hydrateCatalogCreationDraftFromRemixSource(baseDraft, bundle, catalog);
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
        const merged = 'model' in edits
          ? { ...current, sourceGenerationId: restored.draft.sourceGenerationId }
          : { ...restored.draft, ...edits, prompt: restoredPrompt };
        remixBaseline.current = { ...remixBaseline.current, [targetTool]: restored.draft };
        lastSavedFingerprint.current = JSON.stringify(remixBaseline.current);
        if (restored.draft.tool === 'image') setImageDraft(merged as ImageCreationDraft);
        if (restored.draft.tool === 'video') setVideoDraft(merged as VideoCreationDraft);
        if (restored.draft.tool === 'motion') setMotionDraft(merged as MotionCreationDraft);
        remixResolvedRef.current = true;
        setRemixRestoreWarning(restored.warning);
      })
      .catch((error) => {
        if (isCancelled) return;
        remixHydrationKeyRef.current = null;
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
    };
  }, [api, catalog, draftsHydrated, initialTool, remixSource?.generationId, remixSource?.postId, remixRetry, user]);

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
      const uploaded: MediaDraft[] = [];
      for (const asset of picked.slice(0, remainingSlots)) {
        const media = await uploadPickedMedia(asset.uri, {
          api,
          fileName: asset.fileName,
          mimeType: asset.mimeType,
          kind: 'image',
          sizeBytes: asset.fileSize ?? null,
        });
        uploaded.push(createMediaDraftFromUpload(media));
      }
      if (picked.length > remainingSlots) {
        setMessage(`Added ${remainingSlots} reference${remainingSlots === 1 ? '' : 's'} to stay within this model's ${maxImages}-image limit.`);
      }
      if (tool === 'image') {
        setImageDraft((draft) => normalizeCatalogDraft({ ...draft, references: [...draft.references, ...uploaded] }));
      } else {
        setVideoDraft((draft) => normalizeCatalogDraft({ ...draft, references: [...draft.references, ...uploaded], referenceMode: 'elements' }));
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
      const uploaded = await uploadPickedMedia(picked.uri, {
        api,
        fileName: picked.fileName,
        mimeType: picked.mimeType,
        kind: 'image',
        sizeBytes: picked.fileSize ?? null,
      });
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
    const slotKey = target === 'video' ? 'videoReferences' : 'referenceVideo';
    const currentCount = target === 'video' ? videoDraft.referenceVideos.length : motionDraft.referenceVideo ? 1 : 0;
    const legacyLimit = target === 'video' ? selectedModel?.inputs.videoReferences?.max ?? 0 : 1;
    const maxVideos = catalogInputLimit(selectedModel, selectedDraft, slotKey, legacyLimit);
    if (currentCount >= maxVideos) {
      setMessage(maxVideos > 0
        ? `This model supports up to ${maxVideos} reference video${maxVideos === 1 ? '' : 's'}.`
        : 'This model does not support reference videos.');
      return;
    }
    setIsUploading(true);
    try {
      const picked = await pickMedia('video');
      if (!picked) return;
      const uploaded = await uploadPickedMedia(picked.uri, {
        api,
        fileName: picked.fileName,
        mimeType: picked.mimeType,
        kind: 'video',
        durationSeconds: assetDurationSeconds(picked.duration),
        sizeBytes: picked.fileSize ?? null,
      });
      const media = createMediaDraftFromUpload(uploaded, {
        displayName: target === 'motion' ? 'Reference Motion' : 'Reference Video',
      });
      if (target === 'motion') {
        setMotionDraft((draft) => ({ ...draft, referenceVideo: media, duration: Math.ceil(media.durationSeconds ?? draft.duration) }));
      } else {
        setVideoDraft((draft) => {
          const nextMedia = draft.model === 'kling-3.0-video'
            ? withUniqueReferenceHandle(media, draft.referenceVideos)
            : media;
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
      const uploaded = await uploadPickedMedia(picked.uri, {
        api,
        fileName: picked.name,
        mimeType: picked.mimeType,
        kind: 'audio',
        sizeBytes: picked.size ?? null,
      });
      const media = createMediaDraftFromUpload(uploaded, { displayName: 'Reference Audio' });
      setVideoDraft((draft) => normalizeCatalogDraft({ ...draft, referenceAudios: [...draft.referenceAudios, media] }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Upload failed.');
    } finally {
      setIsUploading(false);
    }
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
    setMessage(null);
    setPromptMessage(null);
    setIsEnhancing(true);
    try {
      const previousPrompt = currentDraft.prompt;
      const result = await api.enhancePrompt(buildPromptEnhancementRequest(currentDraft, { level: enhanceLevel }));
      updatePrompt(result.enhancedPrompt);
      setEnhanceUndo({ previous: previousPrompt, enhanced: result.enhancedPrompt });
      if (typeof result.remainingCredits === 'number') updateCredits(result.remainingCredits);
      haptic.success();
    } catch (error) {
      setPromptMessage(error instanceof Error ? error.message : 'Prompt enhancement failed.');
      setMessage(null);
      haptic.error();
    } finally {
      setIsEnhancing(false);
    }
  };

  const handleUndoEnhance = () => {
    if (enhanceUndo && enhanceUndo.enhanced === currentDraft.prompt) {
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
    { onTick: setStatus, signal: controller.signal, waitUntilReady: waitUntilAppActive },
  );

  const finishGenerationPolling = async (finalStatus: GenerationStatusResponse, tool: CreatorToolId) => {
    setStatus(finalStatus);
    setPollingInterrupted(false);
    setLastPredictionId(null);
    if (finalStatus.status === 'failed') {
      setMessage(finalStatus.error?.trim() || 'Generation failed. Your inputs are still here, so you can adjust them and retry.');
      haptic.error();
      return;
    }

    setMessage(null);
    haptic.success();
    void clearPersistedCreationDrafts(draftScope).catch(() => undefined);
    if (guided) {
      setShowNotificationPrompt(true);
      void trackOnboardingEvent(api, 'first_generation_succeeded', { goal: tool, step: 'creator' });
    }
  };

  const resumeGenerationPolling = async () => {
    if (!lastPredictionId || !generationTool || isGenerating || activeGenerationRequestKeyRef.current) return;
    const requestKey = `poll:${generationTool}:${lastPredictionId}`;
    activeGenerationRequestKeyRef.current = requestKey;
    generationPollControllerRef.current?.abort();
    const pollController = new AbortController();
    generationPollControllerRef.current = pollController;
    setWorkspaceVisible(true);
    setPollingInterrupted(false);
    setMessage(null);
    setIsGenerating(true);
    try {
      const finalStatus = await pollGenerationForTool(generationTool, lastPredictionId, pollController);
      await finishGenerationPolling(finalStatus, generationTool);
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

  const generate = async () => {
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
    const nextValidation = validateCatalogCreationDraft(currentDraft, currentCatalogModel, { credits, quotedCost: activeQuote.cost });
    if (nextValidation.errors.length > 0) {
      const promptError = promptValidationMessage(nextValidation.errors[0]);
      if (promptError) {
        setPromptMessage(promptError);
        setMessage(null);
      } else {
        setMessage(nextValidation.errors[0]);
        setPromptMessage(null);
      }
      return;
    }
    setMessage(null);
    setPromptMessage(null);
    setStatus(null);
    setLastGenerationId(null);
    setLastPredictionId(null);
    setPollingInterrupted(false);
    setGenerationTool(currentDraft.tool);
    // Stamped here rather than when the workspace becomes visible: minimizing
    // and coming back must not restart the clock the wait is reporting.
    setGenerationStartedAt(Date.now());
    setWorkspaceVisible(true);
    const idempotencyKey = createMobileGenerationIdempotencyKey(currentDraft.tool);
    activeGenerationRequestKeyRef.current = idempotencyKey;
    generationPollControllerRef.current?.abort();
    const pollController = new AbortController();
    generationPollControllerRef.current = pollController;
    setIsGenerating(true);
    if (guided) void trackOnboardingEvent(api, 'first_generation_started', { goal: currentDraft.tool, step: 'creator' });
    let startedPredictionId: string | null = null;
    try {
      let started: GenerationStartResponse;
      if (api.startGeneration) {
        started = await api.startGeneration(
          buildUnifiedCatalogGenerationRequest(
            currentDraft,
            currentCatalogModel,
            catalog?.revision ?? '',
            activeQuote.normalizedSettings ?? undefined,
          ),
          idempotencyKey,
        );
      } else if (currentDraft.tool === 'image') {
        started = await api.startImageGeneration(
          buildCatalogGenerationPayload(currentDraft, currentCatalogModel, catalog?.revision ?? '', activeQuote.normalizedSettings ?? undefined),
          idempotencyKey
        );
      } else if (currentDraft.tool === 'video') {
        started = await api.startVideoGeneration(
          buildCatalogGenerationPayload(currentDraft, currentCatalogModel, catalog?.revision ?? '', activeQuote.normalizedSettings ?? undefined),
          idempotencyKey
        );
      } else {
        started = await api.startMotionGeneration(
          buildCatalogGenerationPayload(currentDraft, currentCatalogModel, catalog?.revision ?? '', activeQuote.normalizedSettings ?? undefined),
          idempotencyKey
        );
      }
      startedPredictionId = started.predictionId;
      setLastPredictionId(started.predictionId);
      setLastGenerationId(started.generationId ?? null);
      if (typeof started.remainingCredits === 'number') updateCredits(started.remainingCredits);
      const finalStatus = await pollGenerationForTool(currentDraft.tool, started.predictionId, pollController);
      await finishGenerationPolling(finalStatus, currentDraft.tool);
    } catch (error) {
      if (pollController.signal.aborted) return;
      const details = error && typeof error === 'object' && 'details' in error
        ? (error as { details?: { code?: string } }).details
        : null;
      if (startedPredictionId) {
        setPollingInterrupted(true);
        setMessage(error instanceof Error ? error.message : 'Could not refresh generation progress.');
      } else if (details?.code === 'CATALOG_CHANGED' || details?.code === 'MODEL_UNAVAILABLE') {
        void refetchCatalog();
        setMessage('The model catalog changed before generation started. Review the refreshed options and generate again.');
      } else {
        setMessage(error instanceof Error ? error.message : 'Generation failed.');
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

  if (activeTool !== 'image') {
    const creatorModels = catalog ? getCatalogModels(catalog, activeTool) : [];
    const selectedCreatorModel = currentCatalogModel?.kind === activeTool
      ? currentCatalogModel
      : creatorModels[0] ?? null;
    const activeGenerationStatus = generationTool === activeTool ? status : null;
    const activeOutputUrl = generationTool === activeTool ? outputUrl : null;
    const parameterSummary = creatorParameterSummary(currentDraft, selectedCreatorModel);
    const visibleValidationError = isRestoringRemix ? undefined : validation.errors.find((error) => (
      !isReferenceMentionActive || !error.startsWith('Unknown element mention:')
    ));
    const blocker = (promptMessage
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
      : isGenerating || activeGenerationStatus || (pollingInterrupted && generationTool === activeTool)
        ? 'progress'
        : 'generate';
    const contentBottom = bottomInset + 108;

    return (
      <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
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
            modelName={selectedCreatorModel?.displayName ?? 'Loading models'}
            modelDisabled={!selectedCreatorModel}
            onChangeTool={changeTool}
            onOpenModels={() => setModelPickerVisible(true)}
            onClose={onClose ? () => void closeCreator() : undefined}
            closing={isClosing}
            remix={Boolean(remixSource)}
          />
          {remixSource ? (
            <View accessibilityLabel="Remix source post" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              {remixSource.thumbnailUrl ? <StableMediaImage url={remixSource.thumbnailUrl} cacheKey={`remix-source:${remixSource.postId ?? remixSource.generationId}`} style={{ width: 40, height: 40, borderRadius: 10 }} /> : null}
              <View style={{ flex: 1, gap: 2 }}>
                <Text numberOfLines={1} style={{ color: appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '700' }}>{remixSource.title || 'Source creation'}</Text>
                <Text numberOfLines={1} style={{ color: appTheme.colors.muted, ...appTheme.type.caption }}>{remixSource.creatorLabel ? `By ${remixSource.creatorLabel}` : 'Make your own version'}</Text>
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
          {remixRestoreWarning ? (
            <View style={{ gap: 8 }}>
              <SlimCreatorBanner label="Remix source" body={remixRestoreWarning} />
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <SecondaryButton label="Retry restore" onPress={() => { remixHydrationKeyRef.current = null; setRemixRetry((value) => value + 1); }} />
                <SecondaryButton label="Use available inputs" onPress={() => { remixResolvedRef.current = true; setRemixRestoreFailed(false); setRemixRestoreWarning(null); }} />
              </View>
            </View>
          ) : null}
          {draftLoadError ? <View style={{ gap: 8 }}><SlimCreatorBanner label="Draft unavailable" body="Your saved draft could not be read. Retry to continue without overwriting it." /><SecondaryButton label="Retry loading draft" onPress={() => setDraftLoadAttempt((value) => value + 1)} /></View> : null}
          {draftSaveError ? <View style={{ gap: 8 }}><SlimCreatorBanner label="Draft not saved" body={draftSaveError} /><SecondaryButton label="Retry saving draft" onPress={() => { void saveLatestDraft().then(() => setDraftSaveError(null), () => undefined); }} /></View> : null}
          {referenceNotice ? (
            <SlimCreatorBanner label="Reference updated" body={referenceNotice} onDismiss={() => setReferenceNotice(null)} />
          ) : null}

          {activeTool === 'video' ? (
            <VideoCreatorComposer
              draft={videoDraft}
              model={selectedCreatorModel}
              isEnhancing={isEnhancing}
              isUploading={isUploading}
              promptMessage={promptMessage}
              validationErrors={validation.errors}
              onPromptChange={updatePrompt}
              onEnhance={enhancePrompt}
              enhanceLevel={enhanceLevel}
              onEnhanceLevelChange={setEnhanceLevel}
              canUndoEnhance={enhanceUndo !== null && enhanceUndo.enhanced === currentDraft.prompt}
              onUndoEnhance={handleUndoEnhance}
              onChange={(draft) => replaceDraft(draft)}
              onUploadImages={() => uploadImageReferences('video')}
              onUploadStart={() => uploadSingleImage('start')}
              onUploadEnd={() => uploadSingleImage('end')}
              onUploadVideo={() => uploadReferenceVideo('video')}
              onUploadAudio={uploadReferenceAudio}
              onReplaceReference={(id) => {
                void replaceImageReference('video', id);
              }}
              replacingReferenceId={replacingReferenceId}
              onReferenceNotice={setReferenceNotice}
              onFocus={() => setIsPromptFocused(true)}
              onBlur={() => setIsPromptFocused(false)}
              onMentionStateChange={setIsReferenceMentionActive}
            />
          ) : (
            <MotionCreatorComposer
              draft={motionDraft}
              model={selectedCreatorModel}
              isEnhancing={isEnhancing}
              isUploading={isUploading}
              promptMessage={promptMessage}
              validationErrors={validation.errors}
              onPromptChange={updatePrompt}
              onEnhance={enhancePrompt}
              enhanceLevel={enhanceLevel}
              onEnhanceLevelChange={setEnhanceLevel}
              canUndoEnhance={enhanceUndo !== null && enhanceUndo.enhanced === currentDraft.prompt}
              onUndoEnhance={handleUndoEnhance}
              onChange={(draft) => replaceDraft(draft)}
              onUploadCharacter={() => uploadSingleImage('character')}
              onUploadMotion={() => uploadReferenceVideo('motion')}
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

        <SearchableModelPickerModal
          visible={modelPickerVisible}
          items={creatorModels}
          value={currentDraft.model}
          onClose={() => setModelPickerVisible(false)}
          onChange={(modelId) => {
            if (activeTool === 'video') replaceDraft({ ...videoDraft, model: modelId as VideoModelId });
            else replaceDraft({ ...motionDraft, model: modelId as MotionModelId });
            setModelPickerVisible(false);
          }}
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
          cost={activeQuote.cost}
          availableCredits={credits}
          blocker={blocker}
          retryLabel={creatorRetryLabel}
          onClose={() => setParametersVisible(false)}
          onRetryQuote={retryCreatorQuote}
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
          generationId={generationTool === activeTool ? lastGenerationId : null}
          settingsSummary={`${selectedCreatorModel?.displayName ?? meta.title} · ${parameterSummary}`}
          startedAt={generationStartedAt}
          retryCost={activeQuote.status === 'ready' ? activeQuote.cost : null}
          error={activeGenerationStatus?.status === 'failed' ? activeGenerationStatus.error?.trim() || message : message}
          pollingInterrupted={pollingInterrupted && generationTool === activeTool}
          onResumePolling={() => void resumeGenerationPolling()}
          showNotificationPrompt={showNotificationPrompt}
          onEnableNotifications={() => {
            void import('@/lib/notifications').then(({ registerForMobilePushNotifications }) => (
              registerForMobilePushNotifications(api, { requestPermission: true })
            ));
            setShowNotificationPrompt(false);
          }}
          onDismissNotifications={() => setShowNotificationPrompt(false)}
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
          }}
          onPost={() => {
            if (!lastGenerationId) return;
            setWorkspaceVisible(false);
            router.push({ pathname: '/post/new', params: { generationId: lastGenerationId } } as never);
          }}
          onCreateAnother={() => {
            setWorkspaceVisible(false);
            setStatus(null);
            setLastGenerationId(null);
            setLastPredictionId(null);
            setPollingInterrupted(false);
            setGenerationTool(null);
            setMessage(null);
            setPromptMessage(null);
          }}
        />
      </View>
    );
  }

  if (activeTool === 'image') {
    const imageModels = catalog ? getCatalogModels(catalog, 'image') : [];
    const selectedImageModel = currentCatalogModel?.kind === 'image' ? currentCatalogModel : imageModels[0] ?? null;
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
    const blocker = (promptMessage
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

    return (
      <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
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
            modelName={selectedImageModel?.displayName ?? 'Loading models'}
            modelDisabled={!selectedImageModel}
            onChangeTool={changeTool}
            onOpenModels={() => setModelPickerVisible(true)}
            onClose={onClose ? () => void closeCreator() : undefined}
            closing={isClosing}
            remix={Boolean(remixSource)}
          />
          {remixSource ? (
            <View accessibilityLabel="Remix source post" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              {remixSource.thumbnailUrl ? <StableMediaImage url={remixSource.thumbnailUrl} cacheKey={`remix-source:${remixSource.postId ?? remixSource.generationId}`} style={{ width: 40, height: 40, borderRadius: 10 }} /> : null}
              <View style={{ flex: 1, gap: 2 }}>
                <Text numberOfLines={1} style={{ color: appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '700' }}>{remixSource.title || 'Source creation'}</Text>
                <Text numberOfLines={1} style={{ color: appTheme.colors.muted, ...appTheme.type.caption }}>{remixSource.creatorLabel ? `By ${remixSource.creatorLabel}` : 'Make your own version'}</Text>
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
          {remixRestoreWarning ? (
            <View style={{ gap: 8 }}>
              <SlimCreatorBanner label="Remix source" body={remixRestoreWarning} />
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <SecondaryButton label="Retry restore" onPress={() => { remixHydrationKeyRef.current = null; setRemixRetry((value) => value + 1); }} />
                <SecondaryButton label="Use available inputs" onPress={() => { remixResolvedRef.current = true; setRemixRestoreFailed(false); setRemixRestoreWarning(null); }} />
              </View>
            </View>
          ) : null}
          {draftLoadError ? <View style={{ gap: 8 }}><SlimCreatorBanner label="Draft unavailable" body="Your saved draft could not be read. Retry to continue without overwriting it." /><SecondaryButton label="Retry loading draft" onPress={() => setDraftLoadAttempt((value) => value + 1)} /></View> : null}
          {draftSaveError ? <View style={{ gap: 8 }}><SlimCreatorBanner label="Draft not saved" body={draftSaveError} /><SecondaryButton label="Retry saving draft" onPress={() => { void saveLatestDraft().then(() => setDraftSaveError(null), () => undefined); }} /></View> : null}
          {referenceNotice ? (
            <SlimCreatorBanner label="Reference updated" body={referenceNotice} onDismiss={() => setReferenceNotice(null)} />
          ) : null}

          <ImagePromptComposer
            draft={imageDraft}
            maxReferences={catalogInputLimit(
              selectedImageModel,
              imageDraft,
              'imageReferences',
              selectedImageModel?.inputs.imageReferences?.max ?? 0,
            )}
            isEnhancing={isEnhancing}
            isUploading={isUploading}
            promptMessage={promptMessage}
            onPromptChange={updatePrompt}
            onEnhance={enhancePrompt}
            enhanceLevel={enhanceLevel}
            onEnhanceLevelChange={setEnhanceLevel}
            canUndoEnhance={enhanceUndo !== null && enhanceUndo.enhanced === currentDraft.prompt}
            onUndoEnhance={handleUndoEnhance}
            onUploadReferences={() => uploadImageReferences('image')}
            onRenameReference={(id, displayName) => setImageDraft((draft) => {
              const currentReference = draft.references.find((media) => media.id === id);
              const renamedReference = currentReference ? renameMediaDraft(currentReference, displayName) : null;
              const nextPrompt = currentReference?.handle && promptContainsHandle(draft.prompt, currentReference.handle)
                ? replacePromptHandle(draft.prompt, currentReference.handle, renamedReference?.handle ?? '')
                : draft.prompt;
              return {
                ...draft,
                prompt: nextPrompt,
                references: renameMediaInList(draft.references, id, displayName),
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

        <SearchableModelPickerModal
          visible={modelPickerVisible}
          items={imageModels}
          value={imageDraft.model}
          onClose={() => setModelPickerVisible(false)}
          onChange={(modelId) => {
            replaceDraft({ ...imageDraft, model: modelId as ImageModelId });
            setModelPickerVisible(false);
          }}
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
          generationId={generationTool === 'image' ? lastGenerationId : null}
          settingsSummary={`${selectedImageModel?.displayName ?? 'Image'} · ${parameterSummary || 'Default settings'}`}
          startedAt={generationStartedAt}
          retryCost={activeQuote.status === 'ready' ? activeQuote.cost : null}
          error={status?.status === 'failed' ? status.error?.trim() || message : message}
          pollingInterrupted={pollingInterrupted && generationTool === 'image'}
          onResumePolling={() => void resumeGenerationPolling()}
          showNotificationPrompt={showNotificationPrompt}
          onEnableNotifications={() => {
            void import('@/lib/notifications').then(({ registerForMobilePushNotifications }) => (
              registerForMobilePushNotifications(api, { requestPermission: true })
            ));
            setShowNotificationPrompt(false);
          }}
          onDismissNotifications={() => setShowNotificationPrompt(false)}
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
          }}
          onPost={() => {
            if (!lastGenerationId) return;
            setWorkspaceVisible(false);
            router.push({ pathname: '/post/new', params: { generationId: lastGenerationId } } as never);
          }}
          onCreateAnother={() => {
            setWorkspaceVisible(false);
            setStatus(null);
            setLastGenerationId(null);
            setLastPredictionId(null);
            setPollingInterrupted(false);
            setGenerationTool(null);
            setMessage(null);
            setPromptMessage(null);
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
  const modelAccent = accentColor(TOOL_META[activeTool].accent);
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
                backgroundColor: pressed ? appTheme.colors.pressed : appTheme.colors.surfaceStrong,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <CloseGlyph size={appTheme.icon.feature} color={appTheme.colors.textSecondary} />
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
          <Text numberOfLines={1} style={{ flexShrink: 1, color: appTheme.colors.text, fontSize: 13, fontWeight: '800' }}>
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
              borderColor: active ? 'rgba(115,191,242,0.58)' : appTheme.colors.border,
              backgroundColor: active ? 'rgba(115,191,242,0.12)' : appTheme.colors.surfaceStrong,
              paddingHorizontal: 14,
              justifyContent: 'center',
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            {/* Two lines, not one: a starter is an example of what to write,
                and "Premium product photo on a cl…" is an example of a third of
                one. Generative AI asks for "diverse, predefined example inputs
                that hint at what's possible". */}
            <Text numberOfLines={2} style={{ color: active ? appTheme.colors.image : appTheme.colors.textSecondary, fontSize: 12, lineHeight: 16, fontWeight: '700' }}>
              {starter}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function SlimCreatorBanner({ label, body, loading, onDismiss }: { label: string; body: string; loading?: boolean; onDismiss?: () => void }) {
  return (
    <View
      style={{
        minHeight: 56,
        borderRadius: 18,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(255,122,89,0.28)',
        backgroundColor: 'rgba(255,122,89,0.08)',
        paddingLeft: 13,
        paddingRight: 5,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={{ color: appTheme.colors.primary, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }}>{label}</Text>
        <Text numberOfLines={2} style={{ color: appTheme.colors.textSecondary, fontSize: 12, lineHeight: 16 }}>{body}</Text>
      </View>
      {loading ? (
        <View style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={appTheme.colors.primary} size="small" />
        </View>
      ) : onDismiss ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Dismiss ${label}`}
          onPress={onDismiss}
          style={({ pressed }) => ({ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
        >
          <X size={17} color={appTheme.colors.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

function ImagePromptComposer({
  draft,
  maxReferences,
  isEnhancing,
  isUploading,
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
  isEnhancing: boolean;
  isUploading: boolean;
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
      const normalizedHandle = media.handle.slice(1).toLowerCase();
      return normalizedHandle.includes(query) || media.displayName.toLowerCase().includes(query);
    });
  }, [activeMention, draft.references]);

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
          borderColor: 'rgba(115,191,242,0.2)',
          backgroundColor: appTheme.colors.panel,
          overflow: 'hidden',
        }}
      >
        <View
          testID="prompt-heading-inset"
          style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, backgroundColor: appTheme.colors.panel, zIndex: 1 }}
        >
          <Text style={{ color: appTheme.colors.image, fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' }}>Prompt</Text>
        </View>
        <View testID="prompt-scroll-viewport" style={{ height: 190, overflow: 'hidden' }}>
          <TextInput
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
            placeholderTextColor={appTheme.colors.faint}
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
              color: appTheme.colors.text,
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
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 16, backgroundColor: appTheme.colors.panel }}
          />
        </View>
        {promptMessage ? (
          <Text accessibilityRole="alert" selectable style={{ color: appTheme.colors.danger, fontSize: 12, fontWeight: '700', paddingHorizontal: 16, paddingBottom: 10 }}>
            {promptMessage}
          </Text>
        ) : null}
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
          <ComposerToolbarButton icon={<ImageIcon size={16} color={appTheme.colors.text} />} label="Reference" onPress={onUploadReferences} disabled={isUploading || referenceLimitReached} />
          <ComposerToolbarButton icon={<Layers size={15} color={appTheme.colors.muted} />} label="Templates" onPress={() => router.push('/templates' as never)} quiet />
          <ComposerToolbarButton icon={<Wand2 size={16} color={appTheme.colors.primary} />} label={isEnhancing ? 'Enhancing' : 'Enhance'} onPress={onEnhance} disabled={isEnhancing} accent />
        </View>

        <EnhanceControlsRow
          level={enhanceLevel}
          onLevelChange={onEnhanceLevelChange}
          canUndo={canUndoEnhance}
          onUndo={onUndoEnhance}
          disabled={isEnhancing}
        />

        <View
          testID="image-reference-rail"
          style={{
            borderRadius: 24,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: 'rgba(115,191,242,0.13)',
            backgroundColor: appTheme.colors.panel,
            paddingTop: 14,
            paddingBottom: 14,
            overflow: 'hidden',
            gap: 10,
          }}
        >
          <View style={{ paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <Text style={{ color: appTheme.colors.muted, fontSize: 11, fontWeight: '700' }}>Reference images</Text>
            <Text style={{ color: appTheme.colors.faint, fontSize: 11, fontWeight: '700' }}>{draft.references.length} / {maxReferences}</Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 9, paddingHorizontal: 16, paddingRight: 16 }}>
            {draft.references.map((media) => (
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
              accessibilityLabel="Add reference images"
              accessibilityState={{ disabled: isUploading || referenceLimitReached }}
              disabled={isUploading || referenceLimitReached}
              onPress={onUploadReferences}
              style={({ pressed }) => ({
                width: 72,
                height: 72,
                borderRadius: 16,
                borderWidth: 1,
                borderStyle: 'dashed',
                borderColor: 'rgba(115,191,242,0.42)',
                backgroundColor: 'rgba(115,191,242,0.08)',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: isUploading || referenceLimitReached ? 0.38 : pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              {isUploading ? <ActivityIndicator color={appTheme.colors.image} size="small" /> : <Plus size={22} color={appTheme.colors.image} />}
            </Pressable>
          </ScrollView>
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
  onAdd: () => void;
  onOpen: () => void;
}) {
  const action = media ? onOpen : onAdd;
  const label = media ? `Open details for ${mediaAccessibleName(media)}` : `Add ${title.toLowerCase()}`;
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
        borderColor: media ? 'rgba(115,191,242,0.28)' : 'rgba(115,191,242,0.38)',
        backgroundColor: media ? appTheme.colors.surfaceStrong : 'rgba(115,191,242,0.055)',
        padding: 11,
        gap: 9,
        opacity: isUploading || disabled ? 0.45 : pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <View style={{ minHeight: required ? 29 : 16, alignItems: 'flex-start', justifyContent: 'flex-start', gap: 1 }}>
        <Text numberOfLines={1} style={{ width: '100%', color: appTheme.colors.text, fontSize: 12, fontWeight: '800' }}>{title}</Text>
        {required ? <Text style={{ color: appTheme.colors.primary, fontSize: 11, fontWeight: '900', textTransform: 'uppercase' }}>Required</Text> : null}
      </View>
      {media ? (
        <>
          <ReferenceMediaPreview media={media} size={78} />
          <Text numberOfLines={1} style={{ color: appTheme.colors.muted, fontSize: 11, fontWeight: '700' }}>{media.displayName}</Text>
        </>
      ) : (
        <View style={{ flex: 1, minHeight: 82, alignItems: 'center', justifyContent: 'center', gap: 7 }}>
          {isUploading ? <ActivityIndicator color={appTheme.colors.image} size="small" /> : <Plus size={23} color={appTheme.colors.image} />}
          <Text numberOfLines={2} style={{ color: appTheme.colors.muted, fontSize: 11, lineHeight: 14, textAlign: 'center' }}>{helper ?? 'Tap to add media'}</Text>
        </View>
      )}
    </Pressable>
  );
}

function CompactShotEditor({
  draft,
  onChange,
  onFocus,
  onBlur,
}: {
  draft: VideoCreationDraft;
  onChange: (draft: VideoCreationDraft) => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const [selectedId, setSelectedId] = useState(draft.multiPrompts[0]?.id ?? '');
  const selectedShot = draft.multiPrompts.find((shot) => shot.id === selectedId) ?? draft.multiPrompts[0] ?? null;
  const totalDuration = draft.multiPrompts.reduce((total, shot) => total + Math.max(1, Math.round(shot.duration || 0)), 0);

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
          <Text style={{ color: appTheme.colors.video, fontSize: 11, fontWeight: '900', letterSpacing: 1, textTransform: 'uppercase' }}>Multi-shot story</Text>
          <Text style={{ color: appTheme.colors.muted, fontSize: 11 }}>{draft.multiPrompts.length} shots · {totalDuration}s total</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add shot"
          onPress={() => {
            const id = `shot-${Date.now().toString(36)}`;
            onChange({ ...draft, multiPrompts: [...draft.multiPrompts, { id, prompt: '', duration: 5 }] });
            setSelectedId(id);
          }}
          style={({ pressed }) => ({ minHeight: 48, borderRadius: 16, paddingHorizontal: 13, backgroundColor: pressed ? appTheme.colors.pressed : appTheme.colors.surfaceStrong, flexDirection: 'row', alignItems: 'center', gap: 6, opacity: pressed ? appTheme.opacity.pressed : 1 })}
        >
          <Plus size={16} color={appTheme.colors.video} />
          <Text style={{ color: appTheme.colors.text, fontSize: 11, fontWeight: '800' }}>Add shot</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 8 }}>
        {draft.multiPrompts.map((shot, index) => {
          const active = shot.id === selectedShot?.id;
          return (
            <Pressable
              key={shot.id}
              accessibilityRole="button"
              accessibilityLabel={`Edit shot ${index + 1}`}
              accessibilityState={{ selected: active }}
              onPress={() => setSelectedId(shot.id)}
              style={({ pressed }) => ({ minWidth: 76, minHeight: 48, borderRadius: 16, borderWidth: 1, borderColor: active ? 'rgba(115,191,242,0.55)' : appTheme.colors.border, backgroundColor: active ? 'rgba(115,191,242,0.12)' : appTheme.colors.surfaceStrong, alignItems: 'center', justifyContent: 'center', gap: 2, opacity: pressed ? appTheme.opacity.pressed : 1 })}
            >
              <Text style={{ color: active ? appTheme.colors.text : appTheme.colors.muted, fontSize: 11, fontWeight: '900' }}>Shot {index + 1}</Text>
              <Text style={{ color: appTheme.colors.faint, fontSize: 11 }}>{shot.duration}s</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {selectedShot ? (
        <View style={{ borderRadius: 24, borderCurve: 'continuous', borderWidth: 1, borderColor: 'rgba(115,191,242,0.2)', backgroundColor: appTheme.colors.panel, overflow: 'hidden' }}>
          <TextInput
            testID="selected-shot-prompt"
            accessibilityLabel="Selected shot prompt"
            value={selectedShot.prompt}
            onChangeText={(prompt) => updateSelected({ prompt })}
            multiline
            scrollEnabled
            textAlignVertical="top"
            placeholder="Describe action, camera movement, and the beat for this shot…"
            placeholderTextColor={appTheme.colors.faint}
            onFocus={onFocus}
            onBlur={onBlur}
            style={{ height: 154, color: appTheme.colors.text, fontSize: 14, lineHeight: 20, paddingHorizontal: 15, paddingTop: 15, paddingBottom: 22 }}
          />
          <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}>
            <Text style={{ color: appTheme.colors.muted, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }}>Shot duration</Text>
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
            style={({ pressed }) => ({ width: 48, height: 48, position: 'absolute', right: 6, top: 6, borderRadius: 24, backgroundColor: pressed ? appTheme.colors.pressed : 'rgba(11,12,12,0.78)', alignItems: 'center', justifyContent: 'center', opacity: draft.multiPrompts.length <= 1 ? 0.35 : 1 })}
          >
            <Trash2 size={17} color={appTheme.colors.muted} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function VideoCreatorComposer({
  draft,
  model,
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
  onUploadImages,
  onUploadStart,
  onUploadEnd,
  onUploadVideo,
  onUploadAudio,
  onReplaceReference,
  replacingReferenceId,
  onReferenceNotice,
  onFocus,
  onBlur,
  onMentionStateChange,
}: {
  draft: VideoCreationDraft;
  model: CreatorCatalogModel | null;
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
  onChange: (draft: VideoCreationDraft) => void;
  onUploadImages: () => void;
  onUploadStart: () => void;
  onUploadEnd: () => void;
  onUploadVideo: () => void;
  onUploadAudio: () => void;
  onReplaceReference: (id: string) => void;
  replacingReferenceId: string | null;
  onReferenceNotice: (message: string | null) => void;
  onFocus: () => void;
  onBlur: () => void;
  onMentionStateChange: (active: boolean) => void;
}) {
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
  const supportsReusable = !draft.isMultiShot && supportsReusableVideoInputs(model, draft);
  const referenceMode = supportsFrames && (draft.referenceMode === 'frames' || !supportsReusable) ? 'frames' : 'elements';
  const imageLimit = catalogInputLimit(
    model,
    draft,
    'imageReferences',
    model?.inputs.imageReferences?.max ?? 0,
  );
  const videoLimit = catalogInputLimit(
    model,
    draft,
    'videoReferences',
    model?.inputs.videoReferences?.max ?? 0,
  );
  const audioLimit = catalogInputLimit(
    model,
    draft,
    'audioReferences',
    model?.inputs.audioReferences?.max ?? 0,
  );
  const preparedVoiceLimit = catalogInputLimit(
    model,
    draft,
    'preparedVoices',
    model?.inputs.preparedAudioReferences?.max ?? 0,
  );
  const characterLimit = catalogInputLimit(
    model,
    draft,
    'characters',
    model?.inputs.characterReferences?.max ?? 0,
  );
  const frameModeLabel = model?.inputModes?.find((mode) => (
    mode.slots.some((slot) => slot.role === 'startFrame' || slot.role === 'endFrame')
  ))?.label ?? 'Frames';
  const reusableModeLabel = model?.inputModes?.find((mode) => (
    mode.slots.some((slot) => slot.role === 'reference')
  ))?.label ?? 'Reusable';
  const selectedReference = [
    ...draft.references,
    ...draft.referenceVideos,
    draft.startFrame,
    draft.endFrame,
  ].find((media): media is MediaDraft => Boolean(media && media.id === referenceId)) ?? null;
  const detectedMention = useMemo(
    () => !draft.isMultiShot && promptFocused ? findActiveReferenceMention(draft.prompt, promptSelection) : null,
    [draft.isMultiShot, draft.prompt, promptFocused, promptSelection],
  );
  const mentionKey = detectedMention ? `${draft.prompt}:${promptSelection.start}:${promptSelection.end}` : null;
  const activeMention = detectedMention && mentionKey !== dismissedMentionKey ? detectedMention : null;
  const mentionReferences = useMemo(() => {
    if (!activeMention) return [];
    const query = activeMention.query.toLowerCase();
    const namedReferences = model?.id === 'kling-3.0-video'
      ? [...draft.references, ...draft.referenceVideos]
      : draft.references;
    return namedReferences.filter((media) => media.handle && (
      media.handle.slice(1).toLowerCase().includes(query) || media.displayName.toLowerCase().includes(query)
    ));
  }, [activeMention, draft.referenceVideos, draft.references, model?.id]);

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

  const renameSelectedReference = (displayName: string) => {
    if (!selectedReference) return;
    const renamed = renameMediaDraft(selectedReference, displayName);
    if (draft.references.some((media) => media.id === selectedReference.id)) {
      const prompt = selectedReference.handle && promptContainsHandle(draft.prompt, selectedReference.handle)
        ? replacePromptHandle(draft.prompt, selectedReference.handle, renamed.handle ?? '')
        : draft.prompt;
      onChange({ ...draft, prompt, references: renameMediaInList(draft.references, selectedReference.id, displayName) });
      return;
    }
    if (draft.referenceVideos.some((media) => media.id === selectedReference.id)) {
      const prompt = selectedReference.handle && promptContainsHandle(draft.prompt, selectedReference.handle)
        ? replacePromptHandle(draft.prompt, selectedReference.handle, renamed.handle ?? '')
        : draft.prompt;
      onChange({ ...draft, prompt, referenceVideos: renameMediaInList(draft.referenceVideos, selectedReference.id, displayName) });
      return;
    }
    if (draft.startFrame?.id === selectedReference.id) onChange({ ...draft, startFrame: renameMediaDraft(selectedReference, displayName) });
    if (draft.endFrame?.id === selectedReference.id) onChange({ ...draft, endFrame: renameMediaDraft(selectedReference, displayName) });
  };

  const removeSelectedReference = () => {
    if (!selectedReference) return;
    if (draft.references.some((media) => media.id === selectedReference.id)) {
      const handleUsed = promptContainsHandle(draft.prompt, selectedReference.handle);
      onReferenceNotice(handleUsed && selectedReference.handle
        ? `${selectedReference.displayName} and ${selectedReference.handle} were removed from this draft.`
        : `${selectedReference.displayName} was removed from this draft.`);
      onChange({
        ...draft,
        prompt: handleUsed && selectedReference.handle ? replacePromptHandle(draft.prompt, selectedReference.handle) : draft.prompt,
        references: draft.references.filter((media) => media.id !== selectedReference.id),
      });
    } else if (draft.referenceVideos.some((media) => media.id === selectedReference.id)) {
      const handleUsed = promptContainsHandle(draft.prompt, selectedReference.handle);
      onReferenceNotice(handleUsed && selectedReference.handle
        ? `${selectedReference.displayName} and ${selectedReference.handle} were removed from this draft.`
        : `${selectedReference.displayName} was removed from this draft.`);
      onChange({
        ...draft,
        prompt: handleUsed && selectedReference.handle ? replacePromptHandle(draft.prompt, selectedReference.handle) : draft.prompt,
        referenceVideos: draft.referenceVideos.filter((media) => media.id !== selectedReference.id),
      });
    } else if (draft.startFrame?.id === selectedReference.id) {
      onChange({ ...draft, startFrame: null });
    } else if (draft.endFrame?.id === selectedReference.id) {
      onChange({ ...draft, endFrame: null });
    }
    setReferenceId(null);
  };

  const primaryReferenceAction = referenceMode === 'elements'
    ? imageLimit > 0 ? onUploadImages : videoLimit > 0 ? onUploadVideo : onUploadAudio
    : draft.isMultiShot
      ? onUploadStart
      : !draft.startFrame && supportsStartFrame ? onUploadStart : !draft.endFrame && supportsEndFrame ? onUploadEnd : onUploadStart;
  const referenceActionDisabled = isUploading || (!supportsFrames && !supportsReusable);
  const frameError = validationErrors.find((error) => /start image|start frame|end frame/i.test(error));

  return (
    <View testID="video-creator-composer" style={{ gap: 12 }}>
      {model?.capabilities.multiShot ? (
        <View testID="video-shot-mode" style={{ minHeight: 48, borderRadius: 18, backgroundColor: appTheme.colors.surfaceStrong, padding: 4, flexDirection: 'row', gap: 4 }}>
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
              style={({ pressed }) => ({ flex: 1, minHeight: 40, borderRadius: 14, backgroundColor: draft.isMultiShot === option.value ? 'rgba(115,191,242,0.14)' : pressed ? appTheme.colors.pressed : 'transparent', alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
            >
              <Text style={{ color: draft.isMultiShot === option.value ? appTheme.colors.text : appTheme.colors.muted, fontSize: 12, fontWeight: '800' }}>{option.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {draft.isMultiShot ? (
        <CompactShotEditor draft={draft} onChange={onChange} onFocus={onFocus} onBlur={onBlur} />
      ) : (
        <View style={{ borderRadius: 28, borderCurve: 'continuous', borderWidth: 1, borderColor: 'rgba(115,191,242,0.2)', backgroundColor: appTheme.colors.panel, overflow: 'hidden' }}>
          <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 }}>
            <Text style={{ color: appTheme.colors.video, fontSize: 11, fontWeight: '900', letterSpacing: 1, textTransform: 'uppercase' }}>Prompt</Text>
          </View>
          <TextInput
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
            placeholderTextColor={appTheme.colors.faint}
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
            style={{ height: 188, color: appTheme.colors.text, fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 28 }}
          />
          {promptMessage ? <Text accessibilityRole="alert" style={{ color: appTheme.colors.danger, fontSize: 12, fontWeight: '700', paddingHorizontal: 16, paddingBottom: 11 }}>{promptMessage}</Text> : null}
        </View>
      )}

      {activeMention ? (
        <ReferenceMentionSuggestions references={mentionReferences} prompt={draft.prompt} query={activeMention.query} onSelect={(handle) => insertReferenceHandle(handle, activeMention)} />
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'stretch', gap: 8 }}>
        <ComposerToolbarButton icon={<ImageIcon size={16} color={appTheme.colors.text} />} label="Reference" onPress={primaryReferenceAction} disabled={referenceActionDisabled} />
        <ComposerToolbarButton icon={<Layers size={15} color={appTheme.colors.muted} />} label="Templates" onPress={() => router.push('/templates' as never)} quiet />
        <ComposerToolbarButton icon={<Wand2 size={16} color={appTheme.colors.primary} />} label={isEnhancing ? 'Enhancing' : 'Enhance'} onPress={onEnhance} disabled={isEnhancing || draft.isMultiShot} accent />
      </View>

        <EnhanceControlsRow
          level={enhanceLevel}
          onLevelChange={onEnhanceLevelChange}
          canUndo={canUndoEnhance}
          onUndo={onUndoEnhance}
          disabled={isEnhancing}
        />

      <View testID="video-reference-section" style={{ borderRadius: 24, borderCurve: 'continuous', borderWidth: 1, borderColor: 'rgba(115,191,242,0.13)', backgroundColor: appTheme.colors.panel, padding: 14, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <View style={{ gap: 2 }}>
            <Text style={{ color: appTheme.colors.text, fontSize: 12, fontWeight: '800' }}>{draft.isMultiShot ? 'Story inputs' : 'Visual inputs'}</Text>
            <Text style={{ color: appTheme.colors.muted, fontSize: 11 }}>
              {referenceMode === 'frames' ? draft.isMultiShot ? 'Start frame for the story' : 'Start and end frames' : 'Reusable references'}
            </Text>
          </View>
          {supportsFrames && supportsReusable ? (
            <View testID="video-reference-mode" style={{ flexDirection: 'row', borderRadius: 14, backgroundColor: appTheme.colors.surfaceStrong, padding: 3 }}>
              {(['frames', 'elements'] as const).map((mode) => (
                <Pressable
                  key={mode}
                  accessibilityRole="button"
                  accessibilityLabel={mode === 'frames' ? frameModeLabel : reusableModeLabel}
                  accessibilityState={{ selected: referenceMode === mode }}
                  onPress={() => onChange({ ...draft, referenceMode: mode })}
                  hitSlop={verticalHitSlop(42)}
                  style={({ pressed }) => ({ minHeight: 42, borderRadius: 11, paddingHorizontal: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: referenceMode === mode ? 'rgba(115,191,242,0.14)' : pressed ? appTheme.colors.pressed : 'transparent', opacity: pressed ? appTheme.opacity.pressed : 1 })}
                >
                  <Text style={{ color: referenceMode === mode ? appTheme.colors.text : appTheme.colors.muted, fontSize: 11, fontWeight: '800' }}>{mode === 'frames' ? frameModeLabel : reusableModeLabel}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>

        {referenceMode === 'frames' && supportsFrames ? (
          <>
            <View testID="video-frame-slots" style={{ flexDirection: 'row', gap: 9 }}>
              {supportsStartFrame ? (
                <CompactReferenceSlot testID="video-start-frame-slot" title={startFrameSlot?.label ?? 'Start frame'} helper="First visual" media={draft.startFrame} required={(startFrameSlot?.min ?? (model?.id === 'hailuo-2.3' ? 1 : 0)) > 0} isUploading={isUploading} onAdd={onUploadStart} onOpen={() => setReferenceId(draft.startFrame?.id ?? null)} />
              ) : null}
              {supportsEndFrame ? (
                <CompactReferenceSlot
                  testID="video-end-frame-slot"
                  title={endFrameSlot?.label ?? 'End frame'}
                  helper={draft.isMultiShot ? 'Single shot only' : 'Optional finish'}
                  media={draft.endFrame}
                  required={(endFrameSlot?.min ?? 0) > 0}
                  disabled={draft.isMultiShot && !draft.endFrame}
                  isUploading={isUploading}
                  onAdd={onUploadEnd}
                  onOpen={() => setReferenceId(draft.endFrame?.id ?? null)}
                />
              ) : null}
            </View>
            {frameError ? <Text accessibilityRole="alert" style={{ color: appTheme.colors.amber, fontSize: 11, fontWeight: '700', lineHeight: 15 }}>{frameError}</Text> : null}
          </>
        ) : supportsReusable ? (
          <View testID="video-reusable-reference-rail" style={{ gap: 10 }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 9, paddingRight: 6 }}>
              {draft.references.map((media) => (
                <Pressable key={media.id} accessibilityRole="button" accessibilityLabel={`Open details for ${mediaAccessibleName(media)}`} onPress={() => setReferenceId(media.id)} style={({ pressed }) => ({ width: 72, gap: 5, opacity: pressed ? appTheme.opacity.pressed : 1 })}>
                  <ReferenceMediaPreview media={media} size={72} />
                  <Text numberOfLines={1} style={{ color: appTheme.colors.muted, fontSize: 11, fontWeight: '700', textAlign: 'center' }}>{media.displayName}</Text>
                </Pressable>
              ))}
              {draft.referenceVideos.map((media) => (
                <Pressable key={media.id} accessibilityRole="button" accessibilityLabel={`Open details for ${mediaAccessibleName(media)}`} onPress={() => setReferenceId(media.id)} style={({ pressed }) => ({ width: 72, gap: 5, opacity: pressed ? appTheme.opacity.pressed : 1 })}>
                  <ReferenceMediaPreview media={media} size={72} />
                  <Text numberOfLines={1} style={{ color: appTheme.colors.muted, fontSize: 11, fontWeight: '700', textAlign: 'center' }}>{media.displayName}</Text>
                </Pressable>
              ))}
              {draft.referenceAudios.map((media) => (
                <View key={media.id} style={{ width: 72, gap: 4 }}>
                  <ReferenceMediaPreview media={media} size={72} />
                  <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${mediaAccessibleName(media)}`} onPress={() => onChange({ ...draft, referenceAudios: draft.referenceAudios.filter((item) => item.id !== media.id) })} style={({ pressed }) => ({ minHeight: 48, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}>
                    <Text style={{ color: appTheme.colors.danger, fontSize: 11, fontWeight: '800' }}>Remove</Text>
                  </Pressable>
                </View>
              ))}
              {imageLimit > 0 ? <CompactRailAddButton label={`Images ${draft.references.length}/${imageLimit}`} onPress={onUploadImages} disabled={isUploading || draft.references.length >= imageLimit} /> : null}
              {videoLimit > 0 ? <CompactRailAddButton label={`Video ${draft.referenceVideos.length}/${videoLimit}`} onPress={onUploadVideo} disabled={isUploading || draft.referenceVideos.length >= videoLimit} icon="video" /> : null}
              {audioLimit > 0 ? <CompactRailAddButton label={`Audio ${draft.referenceAudios.length}/${audioLimit}`} onPress={onUploadAudio} disabled={isUploading || draft.referenceAudios.length >= audioLimit} icon="audio" /> : null}
            </ScrollView>
            {model?.inputs.combineFramesWithReferences && supportsStartFrame ? (
              <View style={{ maxWidth: 170 }}>
                <CompactReferenceSlot testID="video-optional-first-frame-slot" title="First frame" helper="Optional with reusable refs" media={draft.startFrame} isUploading={isUploading} onAdd={onUploadStart} onOpen={() => setReferenceId(draft.startFrame?.id ?? null)} />
              </View>
            ) : null}
            {preparedVoiceLimit > 0 ? (
              <PreparedReferenceIds title="Prepared voice IDs" accessibilityLabel="Prepared voice ID" placeholder="Paste prepared voice ID" items={draft.preparedAudioIds} max={preparedVoiceLimit} onChange={(items) => onChange({ ...draft, preparedAudioIds: items })} />
            ) : null}
            {characterLimit > 0 ? (
              <PreparedReferenceIds title="Prepared character IDs" accessibilityLabel="Prepared character ID" placeholder="Paste prepared character ID" items={draft.characterIds} max={characterLimit} onChange={(items) => onChange({ ...draft, characterIds: items })} />
            ) : null}
          </View>
        ) : (
          <Text style={{ color: appTheme.colors.muted, fontSize: 11 }}>This model creates from text without reference media.</Text>
        )}
      </View>

      <ReferenceDetailsOverlay
        media={selectedReference}
        handleUsedInPrompt={promptContainsHandle(draft.prompt, selectedReference?.handle)}
        onClose={() => setReferenceId(null)}
        onRename={renameSelectedReference}
        onUseHandle={selectedReference && (
          draft.references.some((media) => media.id === selectedReference.id)
          || (model?.id === 'kling-3.0-video' && draft.referenceVideos.some((media) => media.id === selectedReference.id))
        )
          ? (handle) => {
              insertReferenceHandle(handle, lastPromptSelectionRef.current, 280);
              setReferenceId(null);
            }
          : undefined}
        onReplace={selectedReference && draft.references.some((media) => media.id === selectedReference.id)
          ? () => onReplaceReference(selectedReference.id)
          : undefined}
        isReplacing={selectedReference != null && replacingReferenceId === selectedReference.id}
        onRemove={removeSelectedReference}
      />
    </View>
  );
}

function CompactRailAddButton({ label, icon = 'image', onPress, disabled }: { label: string; icon?: 'image' | 'video' | 'audio'; onPress: () => void; disabled: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Add ${label}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ width: 80, minHeight: 96, borderRadius: 16, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(115,191,242,0.38)', backgroundColor: 'rgba(115,191,242,0.055)', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 6, opacity: disabled ? 0.38 : pressed ? appTheme.opacity.pressed : 1 })}
    >
      {icon === 'video' ? <Video size={20} color={appTheme.colors.video} /> : icon === 'audio' ? <AudioLines size={20} color={appTheme.colors.motion} /> : <Plus size={21} color={appTheme.colors.image} />}
      <Text numberOfLines={2} style={{ color: appTheme.colors.muted, fontSize: 11, fontWeight: '800', lineHeight: 14, textAlign: 'center' }}>{label}</Text>
    </Pressable>
  );
}

function MotionCreatorComposer({
  draft,
  model,
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
  onFocus,
  onBlur,
}: {
  draft: MotionCreationDraft;
  model: CreatorCatalogModel | null;
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
  onUploadMotion: () => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const [selectedRole, setSelectedRole] = useState<'character' | 'motion' | null>(null);
  const selectedMedia = selectedRole === 'character' ? draft.characterImage : selectedRole === 'motion' ? draft.referenceVideo : null;
  const duration = draft.referenceVideo ? getMotionDuration(draft) : null;
  const characterError = validationErrors.find((error) => /character image/i.test(error));
  const motionError = validationErrors.find((error) => /reference video|motion video|between 1 and/i.test(error));
  const characterSlot = catalogInputSlot(model, draft, 'characterImage');
  const motionSlot = catalogInputSlot(model, draft, 'referenceVideo');
  const supportsCharacter = catalogInputSupported(model, draft, 'characterImage', true);
  const supportsMotion = catalogInputSupported(model, draft, 'referenceVideo', true);

  return (
    <View testID="motion-creator-composer" style={{ gap: 12 }}>
      {supportsCharacter || supportsMotion ? <View testID="motion-required-inputs" style={{ borderRadius: 26, borderCurve: 'continuous', borderWidth: 1, borderColor: 'rgba(240,171,252,0.18)', backgroundColor: appTheme.colors.panel, padding: 14, gap: 12 }}>
        <View style={{ gap: 3 }}>
          <Text style={{ color: appTheme.colors.motion, fontSize: 11, fontWeight: '900', letterSpacing: 1, textTransform: 'uppercase' }}>Required inputs</Text>
          <Text style={{ color: appTheme.colors.muted, fontSize: 11, lineHeight: 15 }}>Choose the character to preserve and the movement to transfer.</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 9 }}>
          {supportsCharacter ? <CompactReferenceSlot testID="motion-character-slot" title={characterSlot?.label ?? 'Character image'} helper="Who should move?" media={draft.characterImage} required={(characterSlot?.min ?? 1) > 0} isUploading={isUploading} onAdd={onUploadCharacter} onOpen={() => setSelectedRole('character')} /> : null}
          {supportsMotion ? <CompactReferenceSlot testID="motion-video-slot" title={motionSlot?.label ?? 'Motion video'} helper="How should they move?" media={draft.referenceVideo} required={(motionSlot?.min ?? 1) > 0} isUploading={isUploading} onAdd={onUploadMotion} onOpen={() => setSelectedRole('motion')} /> : null}
        </View>
        <View style={{ gap: 4 }}>
          {characterError ? <Text accessibilityRole="alert" style={{ color: appTheme.colors.amber, fontSize: 11, fontWeight: '700' }}>{characterError}</Text> : null}
          {motionError ? <Text accessibilityRole="alert" style={{ color: appTheme.colors.amber, fontSize: 11, fontWeight: '700' }}>{motionError}</Text> : null}
          {duration ? <Text style={{ color: appTheme.colors.textSecondary, fontSize: 11, fontWeight: '700' }}>Detected motion length · {duration}s</Text> : null}
        </View>
      </View> : null}

      <View style={{ borderRadius: 26, borderCurve: 'continuous', borderWidth: 1, borderColor: 'rgba(240,171,252,0.16)', backgroundColor: appTheme.colors.panel, overflow: 'hidden' }}>
        <View style={{ paddingHorizontal: 16, paddingTop: 15, paddingBottom: 7, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: appTheme.colors.motion, fontSize: 11, fontWeight: '900', letterSpacing: 1, textTransform: 'uppercase' }}>Optional direction</Text>
          <Text style={{ color: appTheme.colors.faint, fontSize: 11, fontWeight: '800' }}>Optional</Text>
        </View>
        <TextInput
          testID="motion-prompt-input"
          accessibilityLabel="Optional motion prompt"
          value={draft.prompt}
          onChangeText={onPromptChange}
          multiline
          scrollEnabled
          textAlignVertical="top"
          placeholder="Add expression, timing, camera, or framing guidance…"
          placeholderTextColor={appTheme.colors.faint}
          onFocus={onFocus}
          onBlur={onBlur}
          style={{ height: 128, color: appTheme.colors.text, fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 22 }}
        />
        {promptMessage ? <Text accessibilityRole="alert" style={{ color: appTheme.colors.danger, fontSize: 12, fontWeight: '700', paddingHorizontal: 16, paddingBottom: 11 }}>{promptMessage}</Text> : null}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'stretch', gap: 8 }}>
        <ComposerToolbarButton icon={<Layers size={16} color={appTheme.colors.text} />} label="Inputs" onPress={!draft.characterImage ? onUploadCharacter : onUploadMotion} disabled={isUploading} />
        <ComposerToolbarButton icon={<Layers size={15} color={appTheme.colors.muted} />} label="Templates" onPress={() => router.push('/templates' as never)} quiet />
        <ComposerToolbarButton icon={<Wand2 size={16} color={appTheme.colors.primary} />} label={isEnhancing ? 'Enhancing' : 'Enhance'} onPress={onEnhance} disabled={isEnhancing || !draft.prompt.trim()} accent />
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
        onRemove={() => {
          if (selectedRole === 'character') onChange({ ...draft, characterImage: null });
          if (selectedRole === 'motion') onChange({ ...draft, referenceVideo: null });
          setSelectedRole(null);
        }}
      />
      {!model ? <Text style={{ color: appTheme.colors.muted, fontSize: 11 }}>Loading motion settings…</Text> : null}
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
        borderColor: 'rgba(115,191,242,0.26)',
        backgroundColor: appTheme.colors.surfaceStrong,
        overflow: 'hidden',
      }}
    >
      <View style={{ minHeight: 40, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, borderBottomWidth: 1, borderBottomColor: appTheme.colors.border }}>
        <Text style={{ color: appTheme.colors.textSecondary, fontSize: 12, fontWeight: '800' }}>References</Text>
        <Text accessibilityLiveRegion="polite" style={{ color: appTheme.colors.faint, fontSize: 11, fontWeight: '700' }}>{matchLabel}</Text>
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
                  borderBottomColor: appTheme.colors.border,
                  backgroundColor: pressed ? appTheme.colors.pressed : 'transparent',
                  opacity: used ? 0.58 : pressed ? appTheme.opacity.pressed : 1,
                })}
              >
                <ReferenceMediaPreview media={media} size={38} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text numberOfLines={1} style={{ color: appTheme.colors.text, fontSize: 13, fontWeight: '800' }}>{media.displayName}</Text>
                  <Text numberOfLines={1} style={{ color: appTheme.colors.image, fontSize: 11, fontWeight: '700' }}>{handle}</Text>
                </View>
                {used ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Check size={14} color={appTheme.colors.image} />
                    <Text style={{ color: appTheme.colors.muted, fontSize: 11, fontWeight: '800' }}>Added</Text>
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : (
        <Text accessibilityLiveRegion="polite" style={{ color: appTheme.colors.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 14, paddingVertical: 16 }}>
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
}: {
  level: PromptEnhancementLevel;
  onLevelChange: (level: PromptEnhancementLevel) => void;
  canUndo: boolean;
  onUndo: () => void;
  disabled?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={{ flexDirection: 'row', borderRadius: appTheme.radii.pill, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', padding: 2 }}>
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
                ? 'rgba(255,122,89,0.18)'
                : pressed ? appTheme.colors.surfaceStrong : 'transparent',
              opacity: disabled ? 0.5 : pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <Text style={{ color: level === value ? '#FFB09C' : '#8E918C', fontWeight: '700', fontSize: 12 }}>{label}</Text>
          </Pressable>
        ))}
      </View>
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
            borderColor: 'rgba(255,255,255,0.12)',
            alignItems: 'center',
            justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
        >
          <Text style={{ color: '#B9BDB7', fontWeight: '700', fontSize: 12 }}>Undo</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ComposerToolbarButton({ icon, label, onPress, disabled, accent, quiet }: { icon: React.ReactNode; label: string; onPress: () => void; disabled?: boolean; accent?: boolean; quiet?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 60,
        flex: 1,
        borderRadius: 18,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: accent ? 'rgba(255,122,89,0.3)' : quiet ? 'rgba(255,255,255,0.055)' : appTheme.colors.border,
        backgroundColor: accent ? 'rgba(255,122,89,0.11)' : pressed ? appTheme.colors.pressed : quiet ? 'rgba(255,255,255,0.025)' : appTheme.colors.surfaceStrong,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 4,
        opacity: disabled ? 0.45 : pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      {icon}
      <Text style={{ color: accent ? appTheme.colors.primary : quiet ? appTheme.colors.muted : appTheme.colors.textSecondary, fontSize: quiet ? 10 : 11, fontWeight: '800' }}>{label}</Text>
    </Pressable>
  );
}

function ReferenceDetailsOverlay({
  media,
  handleUsedInPrompt,
  onClose,
  onRename,
  onUseHandle,
  onReplace,
  isReplacing,
  onRemove,
}: {
  media: MediaDraft | null;
  handleUsedInPrompt: boolean;
  onClose: () => void;
  onRename: (displayName: string) => void;
  onUseHandle?: (handle: string) => void;
  /** Swap the underlying media while keeping the name and @handle. */
  onReplace?: () => void;
  isReplacing?: boolean;
  onRemove: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const drag = useSheetDismissDrag({ onDismiss: onClose });
  const [renameStatus, setRenameStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const renameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setRenameStatus('idle');
    if (renameTimerRef.current) clearTimeout(renameTimerRef.current);
    return () => {
      if (renameTimerRef.current) clearTimeout(renameTimerRef.current);
    };
  }, [media?.id]);

  if (!media) return null;
  const accessibleName = mediaAccessibleName(media);

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

  const confirmRemove = () => {
    void showConfirmDialog({
      title: 'Remove reference?',
      message: handleUsedInPrompt && media.handle
        ? `${accessibleName} and ${media.handle} will be removed from this draft.`
        : `${accessibleName} will be removed from this draft.`,
      confirmLabel: 'Remove',
      destructive: true,
    }).then((remove) => {
      if (remove) onRemove();
    });
  };

  return (
    <Modal visible transparent statusBarTranslucent animationType={reducedMotion ? 'none' : 'slide'} onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.68)' }}>
        <Pressable accessible={false} onPress={onClose} style={{ position: 'absolute', inset: 0 }} />
        <SheetPanel accessibilityViewIsModal style={[{ maxHeight: '88%', borderTopLeftRadius: 30, borderTopRightRadius: 30, backgroundColor: appTheme.colors.panel, paddingHorizontal: 20, paddingTop: 6, paddingBottom: 30, gap: 14 }, drag.dragStyle]}>
          <SheetGrabber drag={drag} />
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ color: appTheme.colors.text, fontSize: 20, fontWeight: '800' }}>Reference details</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close reference details" onPress={onClose} style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 24, backgroundColor: appTheme.colors.surfaceStrong, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}>
              <CloseGlyph size={appTheme.icon.feature} color={appTheme.colors.text} />
            </Pressable>
          </View>
          <MediaPreview url={media.url} kind={media.kind === 'video' ? 'video' : 'image'} height={300} radius={22} />
          <View style={{ gap: 7 }}>
            <Text style={{ color: appTheme.colors.muted, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }}>Reference name</Text>
            <TextInput
              accessibilityLabel={`Reference name for ${accessibleName}`}
              value={media.displayName}
              onChangeText={handleRename}
              onBlur={renameStatus === 'saving' ? markRenameSaved : undefined}
              placeholder="Reference name"
              placeholderTextColor={appTheme.colors.faint}
              style={{ minHeight: 52, borderRadius: 16, borderWidth: 1, borderColor: appTheme.colors.borderStrong, backgroundColor: appTheme.colors.surfaceInset, color: appTheme.colors.text, paddingHorizontal: 14, fontSize: 14, fontWeight: '700' }}
            />
            {renameStatus !== 'idle' ? (
              <Text accessibilityLiveRegion="polite" style={{ color: renameStatus === 'saved' ? appTheme.colors.image : appTheme.colors.muted, fontSize: 11, fontWeight: '700' }}>
                {renameStatus === 'saved' ? 'Saved to draft' : 'Saving…'}
              </Text>
            ) : null}
          </View>
          {media.handle && onUseHandle ? <SecondaryButton label={`Insert ${media.handle}`} onPress={() => onUseHandle(media.handle!)} /> : null}
          {onReplace ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Replace ${accessibleName}`}
              accessibilityState={{ disabled: Boolean(isReplacing) }}
              disabled={isReplacing}
              onPress={onReplace}
              style={({ pressed }) => ({ minHeight: 52, borderRadius: appTheme.radii.pill, borderWidth: 1, borderColor: appTheme.colors.borderStrong, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, opacity: isReplacing ? 0.55 : pressed ? appTheme.opacity.pressed : 1 })}
            >
              {isReplacing ? <ActivityIndicator size="small" color={appTheme.colors.text} /> : <RefreshCw size={16} color={appTheme.colors.text} />}
              <Text style={{ color: appTheme.colors.text, fontSize: 13, fontWeight: '800' }}>
                {isReplacing ? 'Replacing…' : `Replace media${media.handle ? ` · keeps ${media.handle}` : ''}`}
              </Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${accessibleName}`} onPress={confirmRemove} style={({ pressed }) => ({ minHeight: 52, borderRadius: appTheme.radii.pill, borderWidth: 1, borderColor: 'rgba(251,113,133,0.34)', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, opacity: pressed ? appTheme.opacity.pressed : 1 })}>
            <Trash2 size={17} color={appTheme.colors.danger} />
            <Text style={{ color: appTheme.colors.danger, fontSize: 13, fontWeight: '800' }}>Remove reference</Text>
          </Pressable>
        </SheetPanel>
      </View>
    </Modal>
  );
}

function CreatorPersistentBar({
  bottom,
  summary,
  blocker,
  quoteStatus,
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
  cost: number | null;
  retryLabel?: string;
  action: 'generate' | 'progress' | 'result';
  disabled: boolean;
  onOpenParameters: () => void;
  onRetryQuote: () => void;
  onAction: () => void;
}) {
  const actionLabel = action === 'result'
    ? 'View result'
    : action === 'progress'
      ? 'View progress'
      : quoteStatus === 'pending' || quoteStatus === 'idle'
        ? 'Calculating…'
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
        <View testID="creator-contextual-blocker" accessibilityRole="alert" style={{ minHeight: 40, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(251,191,36,0.28)', backgroundColor: 'rgba(34,29,20,0.97)', paddingHorizontal: 12, paddingVertical: 9, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: appTheme.colors.amber }} />
          <Text numberOfLines={2} style={{ flex: 1, color: appTheme.colors.textSecondary, fontSize: 11, fontWeight: '700', lineHeight: 15 }}>{blocker}</Text>
        </View>
      ) : null}
      <View style={{ minHeight: 72, borderRadius: 24, borderCurve: 'continuous', borderWidth: 1, borderColor: appTheme.colors.borderStrong, backgroundColor: 'rgba(20,20,23,0.98)', padding: 8, flexDirection: 'row', alignItems: 'center', gap: 8, boxShadow: '0 16px 46px rgba(0,0,0,0.42)' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Generation parameters. ${summary}`}
          onPress={onOpenParameters}
          style={({ pressed }) => ({ minHeight: 54, flex: 0.9, borderRadius: 18, backgroundColor: pressed ? appTheme.colors.pressed : appTheme.colors.surfaceStrong, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, opacity: pressed ? appTheme.opacity.pressed : 1 })}
        >
          <Settings2 size={16} color={appTheme.colors.textSecondary} />
          <Text numberOfLines={1} style={{ color: appTheme.colors.text, fontSize: 12, fontWeight: '800' }}>{summary}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          accessibilityState={{ disabled: actionDisabled }}
          disabled={actionDisabled}
          onPress={action === 'generate' && quoteStatus === 'error' ? onRetryQuote : onAction}
          style={({ pressed }) => ({ minHeight: 54, flex: 1.2, borderRadius: 18, backgroundColor: actionDisabled ? appTheme.colors.surfaceStrong : appTheme.colors.primary, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', opacity: actionDisabled ? 0.58 : pressed ? appTheme.opacity.pressed : 1 })}
        >
          <Text accessibilityLiveRegion="polite" numberOfLines={1} style={{ color: actionDisabled ? appTheme.colors.muted : appTheme.colors.onPrimary, fontSize: 12, fontWeight: '900' }}>{actionLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function SearchableModelPickerModal({
  visible,
  items,
  value,
  onClose,
  onChange,
}: {
  visible: boolean;
  items: ReturnType<typeof getCatalogModels>;
  value: string;
  onClose: () => void;
  onChange: (modelId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const reducedMotion = useReducedMotion();
  const drag = useSheetDismissDrag({ onDismiss: onClose, visible });
  const normalizedQuery = query.trim().toLowerCase();
  const filteredItems = useMemo(() => items.filter((item) => (
    !normalizedQuery || `${item.displayName} ${item.description} ${item.badge ?? ''}`.toLowerCase().includes(normalizedQuery)
  )), [items, normalizedQuery]);

  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType={reducedMotion ? 'none' : 'slide'} onRequestClose={onClose} onDismiss={() => setQuery('')}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.7)' }}>
        <Pressable accessible={false} onPress={onClose} style={{ position: 'absolute', inset: 0 }} />
        <SheetPanel accessibilityViewIsModal style={[{ height: '78%', borderTopLeftRadius: 30, borderTopRightRadius: 30, backgroundColor: appTheme.colors.panel, paddingHorizontal: 20, paddingTop: 6, paddingBottom: 20, gap: 12 }, drag.dragStyle]}>
          <SheetGrabber drag={drag} />
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: appTheme.colors.text, fontSize: 21, fontWeight: '800' }}>Choose model</Text>
              <Text style={{ color: appTheme.colors.muted, fontSize: 12 }}>Defaults and quote update after selection.</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close model picker" onPress={onClose} style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 24, backgroundColor: appTheme.colors.surfaceStrong, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}>
              <CloseGlyph size={appTheme.icon.feature} color={appTheme.colors.text} />
            </Pressable>
          </View>
          <View style={{ minHeight: 52, borderRadius: 17, borderWidth: 1, borderColor: appTheme.colors.borderStrong, backgroundColor: appTheme.colors.surfaceInset, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 9 }}>
            <Search size={18} color={appTheme.colors.muted} />
            <TextInput accessibilityLabel="Search model names" value={query} onChangeText={setQuery} placeholder="Search models" placeholderTextColor={appTheme.colors.faint} autoCapitalize="none" autoCorrect={false} spellCheck={false} returnKeyType="search" clearButtonMode="while-editing" style={{ flex: 1, color: appTheme.colors.text, fontSize: 14, paddingVertical: 12 }} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8, paddingBottom: 28 }}>
            {filteredItems.map((item) => {
              const selected = item.id === value;
              return (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${item.displayName}. ${item.description}`}
                  onPress={() => onChange(item.id)}
                  style={({ pressed }) => ({ minHeight: 76, borderRadius: 20, borderCurve: 'continuous', borderWidth: 1, borderColor: selected ? 'rgba(115,191,242,0.55)' : appTheme.colors.border, backgroundColor: selected ? 'rgba(115,191,242,0.1)' : appTheme.colors.surfaceStrong, padding: 13, flexDirection: 'row', alignItems: 'center', gap: 12, opacity: pressed ? appTheme.opacity.pressed : 1 })}
                >
                  <View style={{ width: 40, height: 40, borderRadius: 14, backgroundColor: selected ? 'rgba(115,191,242,0.18)' : appTheme.colors.surfaceInset, alignItems: 'center', justifyContent: 'center' }}>
                    <ImageIcon size={19} color={selected ? appTheme.colors.image : appTheme.colors.muted} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                      <Text numberOfLines={1} style={{ flexShrink: 1, color: appTheme.colors.text, fontSize: 14, fontWeight: '800' }}>{item.displayName}</Text>
                      {item.badge ? <Text style={{ color: appTheme.colors.image, fontSize: 11, fontWeight: '800' }}>{item.badge}</Text> : null}
                    </View>
                    <Text numberOfLines={2} style={{ color: appTheme.colors.muted, fontSize: 11, lineHeight: 15 }}>{item.description}</Text>
                  </View>
                  {selected ? <Check size={19} color={appTheme.colors.image} /> : null}
                </Pressable>
              );
            })}
            {filteredItems.length === 0 ? <Text style={{ color: appTheme.colors.muted, textAlign: 'center', paddingVertical: 28 }}>No models found.</Text> : null}
          </ScrollView>
        </SheetPanel>
      </View>
    </Modal>
  );
}

function CreatorParameterSheet({
  visible,
  bottomInset,
  catalog,
  model,
  draft,
  quoteStatus,
  cost,
  availableCredits,
  blocker,
  retryLabel = 'Retry quote',
  hiddenControlKeys = [],
  sourceDurationSeconds,
  onClose,
  onRetryQuote,
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
  cost: number | null;
  availableCredits: number | null;
  blocker: string | null;
  retryLabel?: string;
  hiddenControlKeys?: readonly string[];
  sourceDurationSeconds?: number | null;
  onClose: () => void;
  onRetryQuote: () => void;
  onChange: (draft: CreationDraft) => void;
  onGenerate: () => void;
  generateDisabled: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const drag = useSheetDismissDrag({ onDismiss: onClose, visible });
  const quoteLabel = quoteStatus === 'ready' ? `${cost ?? 0} credits` : quoteStatus === 'error' ? 'Unavailable' : 'Calculating…';
  const balanceLabel = typeof availableCredits === 'number'
    ? `${formatCreditAmount(availableCredits)} credits`
    : 'Unavailable';
  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType={reducedMotion ? 'none' : 'slide'} onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.7)' }}>
        <Pressable accessible={false} onPress={onClose} style={{ position: 'absolute', inset: 0 }} />
        <SheetPanel testID="creator-parameter-sheet" accessibilityViewIsModal style={[{ maxHeight: '88%', borderTopLeftRadius: 30, borderTopRightRadius: 30, backgroundColor: appTheme.colors.panel, paddingTop: 6, paddingBottom: bottomInset + 12 }, drag.dragStyle]}>
          <SheetGrabber drag={drag} />
          <View style={{ paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: appTheme.colors.text, fontSize: 21, fontWeight: '800' }}>Generation parameters</Text>
              <Text numberOfLines={1} style={{ color: appTheme.colors.muted, fontSize: 12 }}>{model?.displayName ?? `${TOOL_META[draft.tool].title} settings`}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close generation parameters" onPress={onClose} style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 24, backgroundColor: appTheme.colors.surfaceStrong, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}>
              <CloseGlyph size={appTheme.icon.feature} color={appTheme.colors.text} />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 18 }}>
            {!catalog || !model ? (
              <View style={{ minHeight: 100, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                <ActivityIndicator color={appTheme.colors.image} />
                <Text style={{ color: appTheme.colors.muted }}>Loading parameters…</Text>
              </View>
            ) : (
              <>
                <CatalogEssentialControls model={model} draft={draft} onChange={onChange} hiddenControlKeys={hiddenControlKeys} />
                {draft.tool === 'motion' ? (
                  <OptionRow title="Source duration">
                    <ReadOnlyParameterValue value={sourceDurationSeconds ? `${sourceDurationSeconds}s from motion video` : 'Add motion video'} />
                  </OptionRow>
                ) : null}
                <View style={{ height: 1, backgroundColor: appTheme.colors.border }} />
                {draft.tool === 'image' && !model.controls.some((control) => control.key === 'outputFormat') ? (
                  <OptionRow title="Output format">
                    <ReadOnlyParameterValue value={draft.outputFormat.toUpperCase()} />
                  </OptionRow>
                ) : null}
                <CatalogAdvancedControls model={model} draft={draft} onChange={onChange} hiddenControlKeys={hiddenControlKeys} />
              </>
            )}
            {blocker ? <Text accessibilityRole="alert" style={{ color: appTheme.colors.danger, fontSize: 12, fontWeight: '700', lineHeight: 17 }}>{blocker}</Text> : null}
          </ScrollView>
          <View style={{ paddingHorizontal: 20, paddingTop: 12, borderTopWidth: 1, borderTopColor: appTheme.colors.border, gap: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ color: appTheme.colors.muted, fontSize: 12, fontWeight: '700' }}>Live quote</Text>
              <Text accessibilityLiveRegion="polite" style={{ color: quoteStatus === 'error' ? appTheme.colors.danger : appTheme.colors.text, fontSize: 13, fontWeight: '800' }}>{quoteLabel}</Text>
            </View>
            <View
              accessibilityRole="text"
              accessibilityLabel={`Available balance, ${balanceLabel}`}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <Text style={{ color: appTheme.colors.muted, fontSize: 12, fontWeight: '700' }}>Available balance</Text>
              <Text style={{ color: appTheme.colors.textSecondary, fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{balanceLabel}</Text>
            </View>
            <PrimaryButton
              label={quoteStatus === 'ready' ? `Generate · ${cost ?? 0} credits` : quoteStatus === 'error' ? retryLabel : quoteLabel}
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
  generationId,
  settingsSummary,
  startedAt,
  retryCost,
  error,
  pollingInterrupted,
  onResumePolling,
  showNotificationPrompt,
  onEnableNotifications,
  onDismissNotifications,
  onMinimize,
  onOpenAlerts,
  onRetry,
  onBack,
  onPost,
  onCreateAnother,
}: {
  visible: boolean;
  tool: CreatorToolId;
  status: GenerationStatusResponse | null;
  isGenerating: boolean;
  outputUrl: string | null;
  generationId: string | null;
  settingsSummary: string;
  /** When the run started, so minimizing and returning does not restart the clock. */
  startedAt: number | null;
  /** What another run of the same draft costs, or null while the quote is unsettled. */
  retryCost: number | null;
  error: string | null | undefined;
  pollingInterrupted: boolean;
  onResumePolling: () => void;
  showNotificationPrompt: boolean;
  onEnableNotifications: () => void;
  onDismissNotifications: () => void;
  onMinimize: () => void;
  onOpenAlerts: () => void;
  onRetry: () => void;
  onBack: () => void;
  onPost: () => void;
  onCreateAnother: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const safeAreaInsets = useSafeAreaInsets();
  const succeeded = Boolean(outputUrl);
  const failed = status?.status === 'failed' || (!isGenerating && !succeeded && Boolean(error) && !pollingInterrupted);
  const medium = tool === 'image' ? 'image' : tool === 'video' ? 'video' : 'motion video';
  const previewKind = tool === 'image' ? 'image' : 'video';
  const waiting = visible && !succeeded && !failed && !pollingInterrupted;
  const elapsedSeconds = useGenerationElapsedSeconds(waiting ? startedAt : null);
  const waitPhase = generationWaitPhase(status?.status);
  const waitTitle = generationWaitTitle(waitPhase, medium);
  const waitDetail = generationWaitDetail(waitPhase, elapsedSeconds);
  return (
    <Modal visible={visible} animationType={reducedMotion ? 'none' : 'slide'} presentationStyle="fullScreen" onRequestClose={onMinimize}>
      <View testID="generation-workspace" accessibilityViewIsModal style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
        <View style={{ minHeight: safeAreaInsets.top + 60, paddingTop: safeAreaInsets.top, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: appTheme.colors.text, fontSize: 20, fontWeight: '800' }}>
              {succeeded ? `Your ${medium}` : pollingInterrupted ? 'Generation is still running' : failed ? 'Generation failed' : `Creating ${medium}`}
            </Text>
            <Text numberOfLines={1} style={{ color: appTheme.colors.muted, fontSize: 11 }}>{settingsSummary}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={succeeded || failed ? 'Back to creator' : 'Minimize generation'} onPress={onMinimize} style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 24, backgroundColor: appTheme.colors.surfaceStrong, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}>
            <CloseGlyph size={appTheme.icon.feature} color={appTheme.colors.text} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 18, paddingBottom: safeAreaInsets.bottom + 18, gap: 18 }}>
          {succeeded && outputUrl ? (
            <>
              <MediaPreview url={outputUrl} kind={previewKind} height={480} radius={26} nativeControls={previewKind === 'video'} />
              <View style={{ gap: 10 }}>
                {showNotificationPrompt ? (
                  <View style={{ borderRadius: 18, borderWidth: 1, borderColor: 'rgba(255,122,89,0.28)', backgroundColor: appTheme.colors.surfaceStrong, padding: 13, gap: 10 }}>
                    <View style={{ gap: 3 }}>
                      <Text style={{ color: appTheme.colors.text, fontSize: 14, fontWeight: '800' }}>Know when longer creations finish</Text>
                      <Text style={{ color: appTheme.colors.muted, fontSize: 11, lineHeight: 16 }}>Notifications are only requested after you choose Enable.</Text>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <View style={{ flex: 1 }}><SecondaryButton label="Not now" onPress={onDismissNotifications} /></View>
                      <View style={{ flex: 1 }}><PrimaryButton label="Enable" onPress={onEnableNotifications} /></View>
                    </View>
                  </View>
                ) : null}
                {generationId ? <PrimaryButton label="Post to feed" onPress={onPost} /> : null}
                {/* Generative AI asks for controls like Edit, Undo, Retry or
                    Adjust *near* generated content — the result had none, so
                    running the same draft again meant leaving this view first.
                    Priced, because it spends the same credits Generate does. */}
                <SecondaryButton label={withCreditCost('Generate again', retryCost)} onPress={onRetry} />
                <SecondaryButton label="Back to creator" onPress={onCreateAnother} />
                <SecondaryButton label="Open Alerts" onPress={onOpenAlerts} />
              </View>
            </>
          ) : pollingInterrupted ? (
            <View style={{ flex: 1, minHeight: 560, justifyContent: 'center', gap: 18 }}>
              <View style={{ height: 310, borderRadius: 28, borderWidth: 1, borderColor: 'rgba(251,191,36,0.24)', backgroundColor: appTheme.colors.panel, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 28 }}>
                <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(251,191,36,0.12)', alignItems: 'center', justifyContent: 'center' }}>
                  <Sparkles size={28} color={appTheme.colors.amber} />
                </View>
                <Text style={{ color: appTheme.colors.text, fontSize: 20, fontWeight: '800', textAlign: 'center' }}>Progress check interrupted</Text>
                <Text accessibilityRole="alert" selectable style={{ color: appTheme.colors.muted, fontSize: 13, lineHeight: 19, textAlign: 'center' }}>
                  {error || 'The generation may still be running. Check its existing job instead of starting another one.'}
                </Text>
              </View>
              <PrimaryButton label="Retry status check" onPress={onResumePolling} />
              <SecondaryButton label="Back to creator" onPress={onMinimize} />
            </View>
          ) : failed ? (
            <View style={{ flex: 1, minHeight: 560, justifyContent: 'center', gap: 18 }}>
              <View style={{ height: 310, borderRadius: 28, borderWidth: 1, borderColor: 'rgba(251,113,133,0.24)', backgroundColor: appTheme.colors.panel, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 28 }}>
                <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(251,113,133,0.12)', alignItems: 'center', justifyContent: 'center' }}>
                  <X size={28} color={appTheme.colors.danger} />
                </View>
                <Text style={{ color: appTheme.colors.text, fontSize: 20, fontWeight: '800', textAlign: 'center' }}>We couldn’t create this {medium}</Text>
                <Text accessibilityRole="alert" selectable style={{ color: appTheme.colors.muted, fontSize: 13, lineHeight: 19, textAlign: 'center' }}>{error || 'Your inputs are preserved. Try again when you’re ready.'}</Text>
              </View>
              {/* "Retry" ran a full new paid generation behind a bare verb,
                  where every other route to that spend states the price. */}
              <PrimaryButton label={withCreditCost('Try again', retryCost)} onPress={onRetry} />
              <SecondaryButton label="Back to creator" onPress={onBack} />
            </View>
          ) : (
            <View style={{ flex: 1, minHeight: 620, gap: 18 }}>
              <View accessibilityRole="progressbar" accessibilityLabel={`${TOOL_META[tool].title} generation in progress`} accessibilityValue={{ text: waitDetail }} style={{ flex: 1, minHeight: 430, borderRadius: 28, borderWidth: 1, borderColor: appTheme.colors.borderStrong, backgroundColor: appTheme.colors.panel, alignItems: 'center', justifyContent: 'center', gap: 18 }}>
                <View style={{ width: 82, height: 82, borderRadius: 28, backgroundColor: 'rgba(255,122,89,0.12)', alignItems: 'center', justifyContent: 'center' }}>
                  <Sparkles size={38} color={appTheme.colors.primary} />
                </View>
                <Text style={{ color: appTheme.colors.text, fontSize: 21, fontWeight: '800' }}>{waitTitle}</Text>
                <ActivityIndicator color={appTheme.colors.primary} size="large" />
                {/* The one thing on screen that changes while nothing else does.
                    Progress indicators: a vague status "seldom adds value", and
                    knowing how long it has run is what lets someone decide
                    whether to keep waiting when the provider reports no progress. */}
                <Text accessibilityLiveRegion="polite" style={{ color: appTheme.colors.muted, fontSize: 12, textAlign: 'center', paddingHorizontal: 40, lineHeight: 18 }}>{waitDetail}</Text>
                <Text style={{ color: appTheme.colors.faint, fontSize: 12, textAlign: 'center', paddingHorizontal: 40 }}>You can minimize this view. Generation will continue in the background.</Text>
              </View>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}><SecondaryButton label="Minimize" onPress={onMinimize} /></View>
                <View style={{ flex: 1 }}><SecondaryButton label="Open Alerts" onPress={onOpenAlerts} /></View>
              </View>
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
    'A polished product reveal with a slow camera push and natural sound',
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
  return (
    <View
      style={{
        minHeight: 48,
        flexDirection: 'row',
        borderBottomWidth: 1,
        borderBottomColor: appTheme.colors.border,
      }}
    >
      {(['image', 'video', 'motion'] as const).map((tool) => {
        const active = value === tool;
        const meta = TOOL_META[tool];
        const color = accentColor(meta.accent);
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
                color: active ? appTheme.colors.text : appTheme.colors.muted,
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
    ['aspectRatio', 'resolution', 'duration'].includes(control.key) && !hiddenControlKeys.includes(control.key)
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
          placeholderTextColor={appTheme.colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          style={{
            flex: 1,
            minHeight: appTheme.touch.default,
            borderRadius: 16,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.12)',
            backgroundColor: '#0B0C0C',
            color: '#ffffff',
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
            backgroundColor: 'rgba(255,122,89,0.16)',
            borderWidth: 1,
            borderColor: 'rgba(255,122,89,0.38)',
            opacity: pressed ? appTheme.opacity.pressed : (items.length >= max ? 0.45 : 1),
          })}
        >
          <AppText variant="label">Add</AppText>
        </Pressable>
      </View>
      {items.map((item) => (
        <View key={item} style={{ minHeight: 46, borderRadius: 15, borderCurve: 'continuous', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', backgroundColor: 'rgba(255,255,255,0.035)', paddingLeft: 12, paddingRight: 6, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text selectable numberOfLines={1} style={{ flex: 1, color: appTheme.colors.textSecondary, fontFamily: 'monospace', fontSize: 12 }}>{item}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${item}`} onPress={() => onChange(items.filter((value) => value !== item))} hitSlop={8} style={({ pressed }) => ({ padding: 9, opacity: pressed ? appTheme.opacity.pressed : 1 })}>
            <Trash2 size={16} color={appTheme.colors.muted} />
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
    !['aspectRatio', 'resolution', 'duration'].includes(control.key) && !hiddenControlKeys.includes(control.key)
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
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: appTheme.colors.muted, fontSize: 12, fontWeight: '800', textTransform: 'uppercase' }}>{title}</Text>
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
  const color = accentColor(accent);
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
              borderColor: active ? `${color}8a` : appTheme.colors.border,
              backgroundColor: active ? `${color}20` : pressed ? appTheme.colors.pressed : appTheme.colors.surfaceStrong,
              paddingHorizontal: 10,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <Text numberOfLines={2} style={{ color: active ? appTheme.colors.text : appTheme.colors.muted, fontSize: 12, lineHeight: 16, fontWeight: active ? '800' : '700', textAlign: 'center' }}>
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
  const color = accentColor(accent);
  const buttonStyle = (disabled: boolean, pressed: boolean) => ({
    width: '31%' as const,
    minWidth: 68,
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: appTheme.colors.border,
    backgroundColor: pressed ? appTheme.colors.pressed : appTheme.colors.surfaceStrong,
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
        <Text style={{ color: appTheme.colors.muted, fontSize: 18, fontWeight: '700' }}>−</Text>
      </Pressable>
      <View
        accessibilityRole="text"
        accessibilityLabel={`${controlLabel}, ${value}`}
        style={{ width: '31%', minWidth: 68, minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: `${color}8a`, backgroundColor: `${color}20`, alignItems: 'center', justifyContent: 'center' }}
      >
        <Text style={{ color: appTheme.colors.text, fontSize: 12, fontWeight: '800' }}>{value}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Increase ${controlLabel.toLowerCase()}`}
        disabled={incrementDisabled}
        onPress={onIncrement}
        style={({ pressed }) => buttonStyle(incrementDisabled, pressed)}
      >
        <Text style={{ color: appTheme.colors.muted, fontSize: 18, fontWeight: '700' }}>+</Text>
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
  const color = accentColor(accent);
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
              borderColor: active ? `${color}8a` : appTheme.colors.border,
              backgroundColor: active ? `${color}20` : pressed ? appTheme.colors.pressed : appTheme.colors.surfaceStrong,
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
                  borderColor: active ? color : appTheme.colors.textSecondary,
                }}
              />
            ) : null}
            <Text numberOfLines={1} style={{ color: active ? appTheme.colors.text : appTheme.colors.muted, fontSize: 11, fontWeight: active ? '800' : '700' }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ReadOnlyParameterValue({ value }: { value: string }) {
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`${value}. Fixed for this model`}
      testID="read-only-parameter-value"
      style={{ width: '100%', minHeight: 48, borderRadius: 16, backgroundColor: appTheme.colors.surfaceInset, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
    >
      <Text style={{ color: appTheme.colors.text, fontSize: 13, fontWeight: '800' }}>{value}</Text>
      <Text style={{ color: appTheme.colors.muted, fontSize: 11, fontWeight: '700' }}>Fixed for this model</Text>
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
  return (
    <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Text style={{ color: '#ffffff', fontSize: 15, fontWeight: '800' }}>{title}</Text>
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
          thumbColor={value ? '#1A0D08' : '#CAC6BD'}
          trackColor={{ false: '#343838', true: '#FF7A59' }}
        />
      </Pressable>
    </View>
  );
}

function ReferenceMediaPreview({ media, size }: { media: MediaDraft; size?: number }) {
  const width = size ?? 58;
  const height = size ?? 72;
  if (media.kind === 'audio') {
    return (
      <View
        style={{
          width,
          height,
          borderRadius: 16,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: 'rgba(240,171,252,0.26)',
          backgroundColor: appTheme.colors.pressed,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
        }}
      >
        <AudioLines size={22} color={appTheme.colors.motion} />
        <Text style={{ color: '#f5d0fe', fontSize: 11, fontWeight: '800' }}>Audio</Text>
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
        backgroundColor: appTheme.colors.surfaceStrong,
      }}
    >
      {kind === 'image' ? (
        <StableMediaImage
          url={media.url}
          cacheKey={`reference-thumbnail:${media.id}:${media.url}`}
          contentFit="cover"
          transition={80}
          style={{ width: '100%', height: '100%' }}
        />
      ) : (
        <MediaPreview
          url={media.url}
          kind={kind}
          height={height}
          radius={16}
          nativeControls={false}
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
            backgroundColor: 'rgba(0,0,0,0.58)',
          }}
        >
          <Play size={13} color="#ffffff" fill="#ffffff" />
        </View>
      ) : null}
    </View>
  );
}
