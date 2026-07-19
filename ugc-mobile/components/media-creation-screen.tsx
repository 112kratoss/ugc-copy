import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import {
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  Image as ImageIcon,
  Layers,
  Play,
  Search,
  Sparkles,
  Trash2,
  Video,
  Wand2,
} from 'lucide-react-native';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Modal,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MediaPreview } from '@/components/media-preview';
import {
  AppText,
  ChoiceChip,
  DisclosureSection,
  MetricCard,
  PrimaryButton,
  ReadinessRow,
  SecondaryButton,
  SurfaceSection,
} from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { clearPersistedCreationDrafts, loadPersistedCreationDrafts, persistCreationDrafts } from '@/lib/creation-draft-resume';
import { useReducedMotion } from '@/lib/motion';
import { trackOnboardingEvent } from '@/lib/onboarding';
import { getGenerationOutput, pollGenerationStatus } from '@/lib/generation';
import {
  applyCatalogModelDefaults,
  buildCatalogGenerationPayload,
  buildCatalogQuoteRequest,
  getCatalogCreationSectionSummary,
  validateCatalogCreationDraft,
} from '@/lib/generation-model-draft';
import {
  getCatalogModel,
  getCatalogModels,
  type CatalogPrimitive,
  type GenerationModelCatalog,
} from '@/lib/generation-model-catalog';
import {
  applyModelDefaults,
  buildPromptEnhancementRequest,
  createDefaultCreationDraft,
  createMediaDraftFromUpload,
  getCreationReadiness,
  getCreationSectionOrder,
  getCreationSectionSummary,
  getMotionDuration,
  getVisibleGenerationCheckMessages,
  hydrateCreationDraftFromRemixSource,
  REMIX_RESTORE_WARNING_MESSAGE,
  renameMediaDraft,
  type CreationSectionId,
  type CreationDraft,
  type CreationReadinessCostStatus,
  type CreationValidationResult,
  type ImageCreationDraft,
  type ImageModelId,
  type MediaDraft,
  type MotionCreationDraft,
  type MotionModelId,
  type VideoCreationDraft,
  type VideoModelId,
} from '@/lib/media-creation-view-model';
import { pickAudioDocument, pickMedia, pickMediaList, uploadPickedMedia } from '@/lib/media';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { accentColor, appTheme, type ToolAccent } from '@/lib/theme';
import type { CreatorToolId, GenerationStartResponse, GenerationStatusResponse } from '@/lib/types';
import { useGenerationModelCatalog } from '@/lib/use-generation-model-catalog';

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

const FLOATING_REVIEW_BAR_HEIGHT = 96;

function isTool(value: unknown): value is CreatorToolId {
  return value === 'image' || value === 'video' || value === 'motion';
}

function appendHandle(prompt: string, handle: string) {
  if (prompt.includes(handle)) return prompt;
  return `${prompt.trim()} ${handle}`.trim();
}

function assetDurationSeconds(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value > 1000 ? value / 1000 : value;
}

function mediaSummary(media: MediaDraft) {
  const bits = [media.fileName];
  if (typeof media.durationSeconds === 'number') {
    bits.push(`${Math.ceil(media.durationSeconds)}s`);
  }
  return bits.join(' • ');
}

function renameMediaInList(items: MediaDraft[], id: string, displayName: string) {
  return items.map((media) => (media.id === id ? renameMediaDraft(media, displayName) : media));
}

function renameOptionalMedia(media: MediaDraft | null, id: string, displayName: string) {
  return media?.id === id ? renameMediaDraft(media, displayName) : media;
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
}: {
  initialTool?: CreatorToolId;
  insideTab?: boolean;
  initialPrompt?: string | null;
  remixSource?: {
    generationId?: string | null;
    postId?: string | null;
  };
  guided?: boolean;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { user, api, credits, updateCredits } = useAuth();
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
  const [isGenerating, setIsGenerating] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [status, setStatus] = useState<GenerationStatusResponse | null>(null);
  const [lastGenerationId, setLastGenerationId] = useState<string | null>(null);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [guidedReferencesExpanded, setGuidedReferencesExpanded] = useState(false);
  const [draftsHydrated, setDraftsHydrated] = useState(false);
  const [showNotificationPrompt, setShowNotificationPrompt] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [promptMessage, setPromptMessage] = useState<string | null>(null);
  const [isPromptFocused, setIsPromptFocused] = useState(false);
  const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
  const [remixRestoreWarning, setRemixRestoreWarning] = useState<string | null>(null);
  const modelSelectionTouched = useRef<Record<CreatorToolId, boolean>>({ image: false, video: false, motion: false });
  const activeGenerationRequestKeyRef = useRef<string | null>(null);
  const generationPollControllerRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => () => {
    generationPollControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    let active = true;
    if (initialPrompt || remixSource?.generationId) {
      setDraftsHydrated(true);
      return () => {
        active = false;
      };
    }
    void loadPersistedCreationDrafts().then((persisted) => {
      if (!active) return;
      if (persisted) {
        setImageDraft(persisted.image);
        setVideoDraft(persisted.video);
        setMotionDraft(persisted.motion);
      }
      setDraftsHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [initialPrompt, remixSource?.generationId]);

  useEffect(() => {
    if (!draftsHydrated) return;
    const timer = setTimeout(() => {
      void persistCreationDrafts({ image: imageDraft, video: videoDraft, motion: motionDraft });
    }, 350);
    return () => clearTimeout(timer);
  }, [draftsHydrated, imageDraft, motionDraft, videoDraft]);

  useEffect(() => {
    if (!catalog) return;
    const reconcile = <T extends CreationDraft>(
      kind: CreatorToolId,
      defaultId: string | null,
      setter: (updater: (draft: T) => T) => void
    ) => {
      setter((draft) => {
        const selected = getCatalogModel(catalog, draft.model);
        const fallback = defaultId ? getCatalogModel(catalog, defaultId) : null;
        if (!fallback || fallback.kind !== kind) return draft;
        if (selected) {
          if (modelSelectionTouched.current[kind] || hasStartedCreationDraft(draft) || selected.id === fallback.id) return draft;
          return applyCatalogModelDefaults(draft, fallback) as T;
        }
        setCatalogNotice(`Your previous ${kind} model is no longer available. Switched to ${fallback.displayName}.`);
        return applyCatalogModelDefaults(draft, fallback) as T;
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
  }, [api, quoteKey, refetchCatalog]);

  const activeQuote = quoteState.key === quoteKey
    ? quoteState
    : { status: 'pending' as const, cost: null, error: null, normalizedSettings: null };
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
            errors: catalogQuery.error ? ['Model settings unavailable. Retry before generating.'] : [],
            warnings: [],
            cost: 0,
            canGenerate: false,
          },
    [activeQuote.cost, catalog, catalogQuery.error, currentCatalogModel, currentDraft, credits]
  );
  const costReadinessStatus: CreationReadinessCostStatus = currentCatalogModel
    ? activeQuote.status === 'ready'
      ? 'ready'
      : activeQuote.status === 'error'
        ? 'unavailable'
        : 'pending'
    : catalog || catalogQuery.error
      ? 'unavailable'
      : 'pending';
  const costUnavailableMessage = activeQuote.status === 'error'
    ? activeQuote.error ?? 'Could not calculate generation cost.'
    : 'Retry model settings before generating.';
  const sectionOrder = useMemo(() => getCreationSectionOrder(currentDraft), [currentDraft]);
  const sectionSummary = useMemo(
    () => currentCatalogModel
      ? getCatalogCreationSectionSummary(currentDraft, currentCatalogModel)
      : catalog
        ? {
            essentials: 'Refreshing model settings',
            references: 'Attached media is preserved',
            advanced: 'Review the refreshed options',
          }
        : getCreationSectionSummary(currentDraft),
    [catalog, currentCatalogModel, currentDraft]
  );
  const readiness = useMemo(
    () => getCreationReadiness(currentDraft, validation, sectionSummary, {
      costStatus: costReadinessStatus,
      costUnavailableMessage,
    }),
    [costReadinessStatus, costUnavailableMessage, currentDraft, sectionSummary, validation]
  );
  const outputUrl = useMemo(() => (status ? getGenerationOutput(status) : null), [status]);
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const tabBarMetrics = getMagicTabBarMetrics(width, bottomInset);
  const isCompact = width < 380;
  const meta = TOOL_META[activeTool];
  const showFloatingReviewBar = insideTab && hasStartedCreationDraft(currentDraft) && !isPromptFocused;
  const contentTopPadding = insideTab ? topInset + 14 : appTheme.spacing.screen;
  const contentBottomPadding = insideTab
    ? tabBarMetrics.contentBottomOverlapPadding + appTheme.spacing.section + (showFloatingReviewBar ? FLOATING_REVIEW_BAR_HEIGHT + appTheme.spacing.gap : 0)
    : bottomInset + 36;
  const issueCount = validation.errors.length + validation.warnings.length + (message ? 1 : 0) + (remixRestoreWarning ? 1 : 0);
  const generateDisabled = isGenerating || isUploading || !catalog || activeQuote.status !== 'ready' || validation.errors.length > 0;
  const openAuthForCurrentDraft = () => {
    router.push({
      pathname: '/auth',
      params: {
        returnTo: `/create/${currentDraft.tool}${guided ? '?guided=1' : ''}`,
      },
    } as never);
  };

  const changeTool = (tool: CreatorToolId) => {
    if (isGenerating) {
      setMessage('This generation is still running. You can switch tools when it finishes or leave and follow it in Alerts.');
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
    const normalized = catalogModel ? applyCatalogModelDefaults(draft, catalogModel) : applyModelDefaults(draft);
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
    return (model ? applyCatalogModelDefaults(draft, model) : applyModelDefaults(draft)) as T;
  };

  useEffect(() => {
    const generationId = remixSource?.generationId?.trim();
    if (!generationId) return;
    if (!user) {
      setRemixRestoreWarning('Sign in to restore remix source media.');
      return;
    }

    const targetTool = isTool(initialTool) ? initialTool : 'image';
    let isCancelled = false;
    setRemixRestoreWarning(null);
    setMessage(null);
    setPromptMessage(null);

    void api.getRemixSourceBundle(generationId, { postId: remixSource?.postId ?? null })
      .then((bundle) => {
        if (isCancelled) return;
        setActiveTool(targetTool);
        if (targetTool === 'image') {
          const { draft, warning } = hydrateCreationDraftFromRemixSource(createDefaultCreationDraft('image'), bundle);
          setImageDraft(draft);
          setRemixRestoreWarning(warning);
        } else if (targetTool === 'video') {
          const { draft, warning } = hydrateCreationDraftFromRemixSource(createDefaultCreationDraft('video'), bundle);
          setVideoDraft(draft);
          setRemixRestoreWarning(warning);
        } else {
          const { draft, warning } = hydrateCreationDraftFromRemixSource(createDefaultCreationDraft('motion'), bundle);
          setMotionDraft(draft);
          setRemixRestoreWarning(warning);
        }
      })
      .catch((error) => {
        if (isCancelled) return;
        setRemixRestoreWarning(error instanceof Error ? error.message : REMIX_RESTORE_WARNING_MESSAGE);
      });

    return () => {
      isCancelled = true;
    };
  }, [api, initialTool, remixSource?.generationId, remixSource?.postId, user]);

  const updatePrompt = (prompt: string) => {
    if (activeTool === 'image') setImageDraft((draft) => ({ ...draft, prompt }));
    if (activeTool === 'video') setVideoDraft((draft) => ({ ...draft, prompt }));
    if (activeTool === 'motion') setMotionDraft((draft) => ({ ...draft, prompt }));
    if (promptMessage) setPromptMessage(null);
  };

  const uploadImageReferences = async (tool: 'image' | 'video') => {
    setMessage(null);
    setPromptMessage(null);
    setIsUploading(true);
    try {
      const picked = await pickMediaList('image', { allowsMultipleSelection: true });
      if (picked.length === 0) return;
      const uploaded: MediaDraft[] = [];
      for (const asset of picked) {
        const media = await uploadPickedMedia(asset.uri, {
          api,
          fileName: asset.fileName,
          mimeType: asset.mimeType,
          kind: 'image',
          sizeBytes: asset.fileSize ?? null,
        });
        uploaded.push(createMediaDraftFromUpload(media));
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
        setVideoDraft((draft) => normalizeCatalogDraft({ ...draft, referenceVideos: [...draft.referenceVideos, media] }));
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
    if (!user) {
      openAuthForCurrentDraft();
      return;
    }
    setMessage(null);
    setPromptMessage(null);
    setIsEnhancing(true);
    try {
      const result = await api.enhancePrompt(buildPromptEnhancementRequest(currentDraft));
      updatePrompt(result.enhancedPrompt);
      if (typeof result.remainingCredits === 'number') updateCredits(result.remainingCredits);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      setPromptMessage(error instanceof Error ? error.message : 'Prompt enhancement failed.');
      setMessage(null);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsEnhancing(false);
    }
  };

  const generate = async () => {
    if (activeGenerationRequestKeyRef.current) return;
    if (!user) {
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
    const idempotencyKey = createMobileGenerationIdempotencyKey(currentDraft.tool);
    activeGenerationRequestKeyRef.current = idempotencyKey;
    generationPollControllerRef.current?.abort();
    const pollController = new AbortController();
    generationPollControllerRef.current = pollController;
    setIsGenerating(true);
    if (guided) void trackOnboardingEvent(api, 'first_generation_started', { goal: currentDraft.tool, step: 'creator' });
    try {
      let started: GenerationStartResponse;
      let finalStatus: GenerationStatusResponse;
      if (currentDraft.tool === 'image') {
        started = await api.startImageGeneration(
          buildCatalogGenerationPayload(currentDraft, currentCatalogModel, catalog?.revision ?? '', activeQuote.normalizedSettings ?? undefined),
          idempotencyKey
        );
        setLastGenerationId(started.generationId ?? null);
        if (typeof started.remainingCredits === 'number') updateCredits(started.remainingCredits);
        finalStatus = await pollGenerationStatus(() => api.getImageGeneration(started.predictionId), { onTick: setStatus, signal: pollController.signal, waitUntilReady: waitUntilAppActive });
      } else if (currentDraft.tool === 'video') {
        started = await api.startVideoGeneration(
          buildCatalogGenerationPayload(currentDraft, currentCatalogModel, catalog?.revision ?? '', activeQuote.normalizedSettings ?? undefined),
          idempotencyKey
        );
        setLastGenerationId(started.generationId ?? null);
        if (typeof started.remainingCredits === 'number') updateCredits(started.remainingCredits);
        finalStatus = await pollGenerationStatus(() => api.getVideoGeneration(started.predictionId), { onTick: setStatus, signal: pollController.signal, waitUntilReady: waitUntilAppActive });
      } else {
        started = await api.startMotionGeneration(
          buildCatalogGenerationPayload(currentDraft, currentCatalogModel, catalog?.revision ?? '', activeQuote.normalizedSettings ?? undefined),
          idempotencyKey
        );
        setLastGenerationId(started.generationId ?? null);
        if (typeof started.remainingCredits === 'number') updateCredits(started.remainingCredits);
        finalStatus = await pollGenerationStatus(() => api.getMotionGeneration(started.predictionId), { onTick: setStatus, signal: pollController.signal, waitUntilReady: waitUntilAppActive });
      }
      setStatus(finalStatus);
      if (finalStatus.status === 'failed') {
        setMessage(finalStatus.error?.trim() || 'Generation failed. Your inputs are still here, so you can adjust them and retry.');
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } else {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        void clearPersistedCreationDrafts();
        if (guided) {
          setShowNotificationPrompt(true);
          void trackOnboardingEvent(api, 'first_generation_succeeded', { goal: currentDraft.tool, step: 'creator' });
        }
      }
    } catch (error) {
      if (pollController.signal.aborted) return;
      const details = error && typeof error === 'object' && 'details' in error
        ? (error as { details?: { code?: string } }).details
        : null;
      if (details?.code === 'CATALOG_CHANGED' || details?.code === 'MODEL_UNAVAILABLE') {
        void refetchCatalog();
        setMessage('The model catalog changed before generation started. Review the refreshed options and generate again.');
      } else {
        setMessage(error instanceof Error ? error.message : 'Generation failed.');
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      if (generationPollControllerRef.current === pollController) {
        generationPollControllerRef.current = null;
      }
      activeGenerationRequestKeyRef.current = null;
      setIsGenerating(false);
    }
  };

  const renderCreationSection = (section: CreationSectionId) => {
    if (section === 'prompt') {
      return (
        <PromptPanel
          draft={currentDraft}
          isEnhancing={isEnhancing}
          message={promptMessage}
          onPromptChange={updatePrompt}
          onEnhance={enhancePrompt}
          onFocus={() => setIsPromptFocused(true)}
          onBlur={() => setIsPromptFocused(false)}
        />
      );
    }

    if (section === 'essentials') {
      return (
        <SurfaceSection
          eyebrow={activeTool === 'motion' ? 'Required setup' : 'Step 2'}
          title="Settings"
          body={sectionSummary.essentials}
          accent={meta.accent}
        >
          <CreationEssentials
            catalog={catalog}
            catalogLoading={catalogQuery.isLoading}
            catalogError={catalogQuery.error}
            onRetryCatalog={() => void catalogQuery.refetch()}
            activeTool={activeTool}
            imageDraft={imageDraft}
            videoDraft={videoDraft}
            motionDraft={motionDraft}
            onChange={replaceDraft}
          />
        </SurfaceSection>
      );
    }

    if (section === 'references') {
      if (guided) {
        return (
          <DisclosureSection
            title="References (optional)"
            body="Add product, face, style, frame, or motion references when you need tighter creative control."
            accent={activeTool === 'image' ? 'image' : activeTool === 'video' ? 'video' : 'motion'}
            expanded={guidedReferencesExpanded}
            onToggle={() => setGuidedReferencesExpanded((expanded) => !expanded)}
          >
            <CreationReferences
              catalog={catalog}
              activeTool={activeTool}
              imageDraft={imageDraft}
              videoDraft={videoDraft}
              motionDraft={motionDraft}
              onImageChange={setImageDraft}
              onVideoChange={setVideoDraft}
              onMotionChange={setMotionDraft}
              onUploadImageReferences={() => uploadImageReferences('image')}
              onUploadVideoReferences={() => uploadImageReferences('video')}
              onUploadStart={() => uploadSingleImage('start')}
              onUploadEnd={() => uploadSingleImage('end')}
              onUploadCharacter={() => uploadSingleImage('character')}
              onUploadMotionReference={() => uploadReferenceVideo('motion')}
              onUseImageHandle={(handle) => setImageDraft((draft) => ({ ...draft, prompt: appendHandle(draft.prompt, handle) }))}
              onUseVideoHandle={(handle) => setVideoDraft((draft) => ({ ...draft, prompt: appendHandle(draft.prompt, handle), referenceMode: 'elements' }))}
              isUploading={isUploading}
            />
          </DisclosureSection>
        );
      }
      return (
        <SurfaceSection
          eyebrow={activeTool === 'motion' ? 'Required media' : 'Step 1'}
          title="References"
          body={activeTool === 'image' ? 'Optional creative input for style, pose, product, or face consistency.' : sectionSummary.references}
          accent={activeTool === 'image' ? 'image' : activeTool === 'video' ? 'video' : 'motion'}
        >
          <CreationReferences
            catalog={catalog}
            activeTool={activeTool}
            imageDraft={imageDraft}
            videoDraft={videoDraft}
            motionDraft={motionDraft}
            onImageChange={setImageDraft}
            onVideoChange={setVideoDraft}
            onMotionChange={setMotionDraft}
            onUploadImageReferences={() => uploadImageReferences('image')}
            onUploadVideoReferences={() => uploadImageReferences('video')}
            onUploadStart={() => uploadSingleImage('start')}
            onUploadEnd={() => uploadSingleImage('end')}
            onUploadCharacter={() => uploadSingleImage('character')}
            onUploadMotionReference={() => uploadReferenceVideo('motion')}
            onUseImageHandle={(handle) => {
              setPromptMessage(null);
              setImageDraft((draft) => ({ ...draft, prompt: appendHandle(draft.prompt, handle) }));
            }}
            onUseVideoHandle={(handle) => {
              setPromptMessage(null);
              setVideoDraft((draft) => ({ ...draft, prompt: appendHandle(draft.prompt, handle), referenceMode: 'elements' }));
            }}
            isUploading={isUploading}
          />
        </SurfaceSection>
      );
    }

    if (section === 'advanced') {
      return (
        <DisclosureSection
          title="Advanced"
          body={sectionSummary.advanced}
          accent={meta.accent}
          expanded={advancedExpanded}
          onToggle={() => setAdvancedExpanded((expanded) => !expanded)}
        >
          <CreationAdvanced
            catalog={catalog}
            activeTool={activeTool}
            imageDraft={imageDraft}
            videoDraft={videoDraft}
            motionDraft={motionDraft}
            onChange={replaceDraft}
            onVideoChange={setVideoDraft}
            onUploadVideo={() => uploadReferenceVideo('video')}
            onUploadAudio={uploadReferenceAudio}
            onRemoveReferenceVideo={(id) => setVideoDraft((draft) => ({ ...draft, referenceVideos: draft.referenceVideos.filter((media) => media.id !== id) }))}
            onRemoveReferenceAudio={(id) => setVideoDraft((draft) => ({ ...draft, referenceAudios: draft.referenceAudios.filter((media) => media.id !== id) }))}
            isUploading={isUploading}
          />
        </DisclosureSection>
      );
    }

    return (
      <SurfaceSection
        eyebrow="Ready check"
        title="Generate"
        body="Review cost and blockers before starting the run."
        accent={meta.accent}
      >
        {readiness.map((item) => (
          <ReadinessRow key={item.id} label={item.label} body={item.body} state={item.state} />
        ))}
        <ReviewIssuesPanel validation={validation} message={message} />
        <View style={{ flexDirection: 'row', gap: appTheme.spacing.gap }}>
          <MetricCard
            label="Credits"
            value={String(credits ?? 0)}
            body="available"
            accent="amber"
            compact
            onPress={() => router.push('/(tabs)/pricing')}
          />
          <MetricCard
            label="Cost"
            value={activeQuote.status === 'ready' ? String(activeQuote.cost ?? 0) : '...'}
            body={activeQuote.status === 'error' ? 'Retry after changing a setting' : activeQuote.status === 'pending' ? 'Calculating...' : `${meta.title.toLowerCase()} run`}
            accent={meta.accent}
            compact
          />
        </View>
        <PrimaryButton
          label={isGenerating ? 'Generating...' : `Generate ${meta.title}`}
          accent="primary"
          disabled={generateDisabled}
          loading={isGenerating}
          onPress={generate}
        />
      </SurfaceSection>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
      <View style={{ position: 'absolute', inset: 0, backgroundColor: appTheme.colors.background }} />
      {insideTab ? <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: topInset, backgroundColor: appTheme.colors.background, zIndex: 3 }} /> : null}
      <ScrollView
        ref={scrollRef}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: contentTopPadding,
          paddingHorizontal: isCompact ? 16 : 20,
          paddingBottom: contentBottomPadding,
          gap: 18,
        }}
      >
        <CreateHeader meta={meta} activeTool={activeTool} onChange={changeTool} />

        {guided ? (
          <GuidedCreatorIntro
            tool={activeTool}
            prompt={currentDraft.prompt}
            onSelectPrompt={updatePrompt}
          />
        ) : null}

        {insideTab && !guided ? <TemplateCatalogEntry /> : null}

        {catalogNotice ? (
          <SurfaceSection eyebrow="Catalog update" title="Model updated" body={catalogNotice} accent={meta.accent}>
            <SecondaryButton label="Dismiss" onPress={() => setCatalogNotice(null)} />
          </SurfaceSection>
        ) : null}

        {remixRestoreWarning ? (
          <SurfaceSection eyebrow="Remix source" title="Source partially restored" body={remixRestoreWarning} accent={meta.accent}>
            <SecondaryButton label="Dismiss" onPress={() => setRemixRestoreWarning(null)} />
          </SurfaceSection>
        ) : null}

        {sectionOrder.map((section) => (
          <Fragment key={section}>
            {renderCreationSection(section)}
          </Fragment>
        ))}

        {status && status.status !== 'succeeded' ? (
          <SurfaceSection
            eyebrow="Progress"
            title={status.status === 'failed' ? 'Generation failed' : `Generation ${status.status}`}
            body={status.status === 'failed'
              ? status.error?.trim() || 'Your inputs are preserved. Adjust anything you need, then retry.'
              : 'You can leave this screen and follow progress in Alerts.'}
            accent={meta.accent}
          >
            {status.status === 'failed' ? (
              <SecondaryButton label={`Retry ${meta.title}`} onPress={generate} disabled={generateDisabled} />
            ) : null}
          </SurfaceSection>
        ) : null}

        {outputUrl ? (
          <ResultPanel
            outputUrl={outputUrl}
            kind={activeTool === 'image' ? 'image' : 'video'}
            generationId={lastGenerationId}
            accent={meta.accent}
            onPost={() => {
              if (!lastGenerationId) return;
              router.push({
                pathname: '/post/new',
                params: { generationId: lastGenerationId },
              } as never);
            }}
            onOpenAlerts={() => router.push('/(tabs)/studio')}
            onCreateAnother={() => {
              setStatus(null);
              setLastGenerationId(null);
              setMessage(null);
              setPromptMessage(null);
            }}
          />
        ) : null}

        {showNotificationPrompt ? (
          <SurfaceSection
            eyebrow="Stay in the loop"
            title="Know when longer creations finish"
            body="Magicbooklet only asks for notification permission after you choose Enable."
            accent="primary"
          >
            <PrimaryButton
              label="Enable notifications"
              onPress={() => {
                void import('@/lib/notifications').then(({ registerForMobilePushNotifications }) => (
                  registerForMobilePushNotifications(api, { requestPermission: true })
                ));
                setShowNotificationPrompt(false);
              }}
            />
            <SecondaryButton label="Not now" onPress={() => setShowNotificationPrompt(false)} />
          </SurfaceSection>
        ) : null}
      </ScrollView>
      {showFloatingReviewBar ? (
        <FloatingGenerateReviewBar
          bottom={tabBarMetrics.contentBottomPadding + 8}
          credits={credits ?? 0}
          cost={activeQuote.status === 'ready' ? activeQuote.cost : null}
          disabled={generateDisabled}
          isGenerating={isGenerating}
          issueCount={issueCount}
          toolTitle={meta.title}
          onGenerate={generate}
        />
      ) : null}
    </View>
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

function GuidedCreatorIntro({
  tool,
  prompt,
  onSelectPrompt,
}: {
  tool: CreatorToolId;
  prompt: string;
  onSelectPrompt: (prompt: string) => void;
}) {
  const meta = TOOL_META[tool];
  return (
    <SurfaceSection
      eyebrow="Your first creation"
      title={`Start with a ${meta.title.toLowerCase()} idea`}
      body="Choose a starter or write your own. Nothing runs or spends credits until you press Generate."
      accent={meta.accent}
    >
      <View style={{ gap: 8 }}>
        {GUIDED_PROMPTS[tool].map((starter, index) => {
          const active = prompt === starter;
          const color = accentColor(meta.accent);
          return (
            <Pressable
              key={starter}
              accessibilityRole="button"
              accessibilityLabel={`Starter ${index + 1}. ${starter}`}
              accessibilityState={{ selected: active }}
              onPress={() => onSelectPrompt(starter)}
              style={({ pressed }) => ({
                minHeight: 58,
                borderRadius: appTheme.radii.lg,
                borderCurve: 'continuous',
                borderWidth: active ? 2 : 1,
                borderColor: active ? `${color}8a` : appTheme.colors.border,
                backgroundColor: active ? `${color}18` : appTheme.colors.surfaceStrong,
                paddingHorizontal: 14,
                paddingVertical: 11,
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <AppText variant="caption" color={active ? color : appTheme.colors.textSecondary}>
                {starter}
              </AppText>
            </Pressable>
          );
        })}
      </View>
      <ReadinessRow label="Tip 1" body="Describe the subject, setting, lighting, and camera or motion in one clear sentence." state="neutral" />
      <ReadinessRow label="Tip 2" body="Review the live credit cost in the Generate section before starting." state="neutral" />
    </SurfaceSection>
  );
}

function TemplateCatalogEntry() {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Browse viral templates"
      accessibilityHint="Opens ready-made video formats"
      onPress={() => router.push('/templates' as never)}
      style={({ pressed }) => ({
        minHeight: 74,
        borderRadius: appTheme.radii.xl,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(255,122,89,0.38)',
        backgroundColor: appTheme.colors.surfaceInset,
        paddingHorizontal: 16,
        paddingVertical: 13,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <View style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.pressed }}>
        <Layers size={21} color={appTheme.colors.primary} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <AppText variant="label">Use a viral template</AppText>
        <AppText variant="caption" color="muted" numberOfLines={1}>Add your photos, approve the frames, generate.</AppText>
      </View>
      <ChevronRight size={20} color={appTheme.colors.primary} />
    </Pressable>
  );
}

function CreateHeader({
  meta,
  activeTool,
  onChange,
}: {
  meta: { title: string; accent: ToolAccent; subtitle: string };
  activeTool: CreatorToolId;
  onChange: (tool: CreatorToolId) => void;
}) {
  return (
    <View style={{ gap: 12 }}>
      <View style={{ gap: 4 }}>
        <AppText variant="label" color={accentColor(meta.accent)} style={{ letterSpacing: 1.2, textTransform: 'uppercase' }}>
          Magicbooklet
        </AppText>
        <AppText variant="pageTitle">Create</AppText>
        <AppText variant="bodySm" color="muted">{meta.title} generation · {meta.subtitle}</AppText>
      </View>
      <ToolSwitcher value={activeTool} onChange={onChange} />
    </View>
  );
}

function FloatingGenerateReviewBar({
  bottom,
  credits,
  cost,
  disabled,
  isGenerating,
  issueCount,
  toolTitle,
  onGenerate,
}: {
  bottom: number;
  credits: number;
  cost: number | null;
  disabled: boolean;
  isGenerating: boolean;
  issueCount: number;
  toolTitle: string;
  onGenerate: () => void;
}) {
  const status = issueCount > 0 ? `${issueCount} issue${issueCount === 1 ? '' : 's'}` : 'Ready';
  const costLabel = typeof cost === 'number' ? String(cost) : '...';

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 20,
        right: 20,
        bottom,
        zIndex: 4,
      }}
    >
      <View
        style={{
          minHeight: 78,
          borderRadius: 26,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: appTheme.colors.borderStrong,
          backgroundColor: 'rgba(12,12,16,0.96)',
          padding: 12,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          boxShadow: '0 18px 48px rgba(0,0,0,0.34)',
        }}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text style={{ color: '#ffffff', fontSize: 14, fontWeight: '800' }}>Review and generate</Text>
          <Text numberOfLines={1} style={{ color: appTheme.colors.muted, fontSize: 12, fontWeight: '700' }}>
            {credits} credits · {costLabel} cost · {status}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isGenerating ? `Generating ${toolTitle}` : `Generate ${toolTitle}`}
          accessibilityHint={`${credits} credits available. ${costLabel} credits required.`}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={onGenerate}
          style={{
            minHeight: 48,
            borderRadius: appTheme.radii.pill,
            backgroundColor: disabled ? appTheme.colors.surfaceStrong : appTheme.colors.primary,
            paddingHorizontal: 18,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: disabled ? 0.62 : 1,
          }}
        >
          <Text style={{ color: disabled ? appTheme.colors.muted : appTheme.colors.onPrimary, fontSize: 13, fontWeight: '800' }}>
            {isGenerating ? 'Generating...' : `Generate ${toolTitle}`}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function ToolSwitcher({ value, onChange }: { value: CreatorToolId; onChange: (tool: CreatorToolId) => void }) {
  return (
    <View style={{ flexDirection: 'row', backgroundColor: appTheme.colors.surfaceInset, borderRadius: appTheme.radii.pill, padding: 4, gap: 4 }}>
      {(['image', 'video', 'motion'] as const).map((tool) => {
        const active = value === tool;
        const meta = TOOL_META[tool];
        return (
          <ChoiceChip
            key={tool}
            label={meta.title}
            active={active}
            onPress={() => onChange(tool)}
            accent={meta.accent}
            grow
          />
        );
      })}
    </View>
  );
}

function PromptPanel({
  draft,
  isEnhancing,
  message,
  onPromptChange,
  onEnhance,
  onFocus,
  onBlur,
}: {
  draft: CreationDraft;
  isEnhancing: boolean;
  message?: string | null;
  onPromptChange: (value: string) => void;
  onEnhance: () => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const optional = draft.tool === 'motion';
  const body = draft.tool === 'motion'
    ? 'Optional direction after required media is attached.'
    : draft.tool === 'video' && draft.isMultiShot
      ? 'Shot prompts below drive multi-shot mode.'
      : 'Use @handles after adding named references.';
  return (
    <SurfaceSection
      eyebrow="Prompt"
      title="Prompt"
      body={body}
      accent={draft.tool === 'image' ? 'image' : draft.tool === 'video' ? 'video' : 'motion'}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText variant="label" color="muted">{optional ? 'Optional for motion' : 'Required'}</AppText>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Enhance prompt"
          accessibilityState={{ disabled: isEnhancing, busy: isEnhancing }}
          onPress={onEnhance}
          disabled={isEnhancing}
          style={{
            minHeight: 48,
            borderRadius: appTheme.radii.pill,
            borderWidth: 1,
            borderColor: 'rgba(255,122,89,0.5)',
            paddingHorizontal: 12,
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'row',
            gap: 7,
            flexShrink: 0,
            opacity: isEnhancing ? 0.6 : 1,
          }}
        >
          {isEnhancing ? <ActivityIndicator color="#F6F3EC" size="small" /> : <Wand2 size={16} color="#FF7A59" />}
          <Text style={{ color: '#F6F3EC', fontWeight: '700', fontSize: 13 }}>Enhance</Text>
        </Pressable>
      </View>
      {message ? <Text selectable style={{ color: appTheme.colors.danger, fontWeight: '800', lineHeight: 20 }}>{message}</Text> : null}
      <TextInput
        accessibilityLabel={optional ? 'Optional motion prompt' : 'Generation prompt'}
        value={draft.prompt}
        onChangeText={onPromptChange}
        multiline
        textAlignVertical="top"
        placeholder={draft.tool === 'image' ? 'Describe the final image...' : draft.tool === 'video' ? 'Describe action, camera, lighting, sound...' : 'Optional motion direction...'}
        placeholderTextColor="#8E918C"
        onFocus={onFocus}
        onBlur={onBlur}
        style={{
          minHeight: 132,
          borderRadius: 22,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.12)',
          backgroundColor: '#0B0C0C',
          color: '#F6F3EC',
          fontSize: 15,
          lineHeight: 22,
          paddingHorizontal: 14,
          paddingVertical: 14,
        }}
      />
    </SurfaceSection>
  );
}

function CreationEssentials({
  catalog,
  catalogLoading,
  catalogError,
  onRetryCatalog,
  activeTool,
  imageDraft,
  videoDraft,
  motionDraft,
  onChange,
}: {
  catalog: GenerationModelCatalog | null;
  catalogLoading: boolean;
  catalogError: Error | null;
  onRetryCatalog: () => void;
  activeTool: CreatorToolId;
  imageDraft: ImageCreationDraft;
  videoDraft: VideoCreationDraft;
  motionDraft: MotionCreationDraft;
  onChange: (draft: CreationDraft) => void;
}) {
  if (!catalog) {
    return (
      <View style={{ gap: 10, alignItems: 'flex-start' }}>
        {catalogLoading ? <ActivityIndicator color={accentColor(activeTool)} /> : null}
        <AppText variant="bodySm" color="muted">
          {catalogError ? 'Model settings are unavailable. Check your connection and try again.' : 'Loading model settings...'}
        </AppText>
        {catalogError ? <SecondaryButton label="Retry" onPress={onRetryCatalog} /> : null}
      </View>
    );
  }

  if (activeTool === 'image') {
    const models = getCatalogModels(catalog, 'image');
    const model = getCatalogModel(catalog, imageDraft.model) ?? models[0];
    return (
      <View style={{ gap: appTheme.spacing.gap }}>
        <SectionLabel title="Model" icon={<ImageIcon size={17} color={accentColor('image')} />} />
        <ModelPicker
          items={models}
          value={model?.id ?? imageDraft.model}
          accent="image"
          onChange={(modelId) => onChange({ ...imageDraft, model: modelId as ImageModelId })}
        />
        {model ? <CatalogEssentialControls model={model} draft={imageDraft} onChange={onChange} /> : null}
      </View>
    );
  }

  if (activeTool === 'video') {
    const models = getCatalogModels(catalog, 'video');
    const model = getCatalogModel(catalog, videoDraft.model) ?? models[0];
    return (
      <View style={{ gap: appTheme.spacing.gap }}>
        <SectionLabel title="Model" icon={<Video size={17} color={accentColor('video')} />} />
        <ModelPicker
          items={models}
          value={model?.id ?? videoDraft.model}
          accent="video"
          onChange={(modelId) => {
            onChange({ ...videoDraft, model: modelId as VideoModelId });
          }}
        />
        {model ? <CatalogEssentialControls model={model} draft={videoDraft} onChange={onChange} /> : null}
      </View>
    );
  }

  const models = getCatalogModels(catalog, 'motion');
  const model = getCatalogModel(catalog, motionDraft.model) ?? models[0];

  return (
    <View style={{ gap: appTheme.spacing.gap }}>
      <SectionLabel title="Model" icon={<Sparkles size={17} color={accentColor('motion')} />} />
      <ModelPicker
        items={models}
        value={model?.id ?? motionDraft.model}
        accent="motion"
        onChange={(modelId) => onChange({ ...motionDraft, model: modelId as MotionModelId })}
      />
      {model ? <CatalogEssentialControls model={model} draft={motionDraft} onChange={onChange} /> : null}
    </View>
  );
}

function CatalogEssentialControls({
  model,
  draft,
  onChange,
}: {
  model: ReturnType<typeof getCatalogModels>[number];
  draft: CreationDraft;
  onChange: (draft: CreationDraft) => void;
}) {
  const controls = model.controls.filter((control) => ['aspectRatio', 'resolution', 'duration'].includes(control.key));
  return (
    <>
      {controls.map((control) => {
        const draftRecord = draft as unknown as Record<string, unknown>;
        const draftKey = draft.tool === 'motion' && control.key === 'resolution' ? 'mode' : control.key;
        if (control.type === 'choice') {
          const current = String(draftRecord[draftKey] ?? control.defaultValue);
          return (
            <OptionRow key={control.key} title={control.label}>
              {control.options.map((option) => (
                <Chip
                  key={option.value}
                  label={control.key === 'duration' ? `${option.label}s` : option.label}
                  active={current === option.value}
                  onPress={() => onChange({ ...draft, [draftKey]: control.key === 'duration' ? Number(option.value) : option.value } as CreationDraft)}
                />
              ))}
            </OptionRow>
          );
        }
        if (control.type === 'integer') {
          const current = typeof draftRecord[draftKey] === 'number' ? draftRecord[draftKey] as number : control.defaultValue;
          return (
            <OptionRow key={control.key} title={control.label}>
              <Chip label="-" active={false} onPress={() => onChange({ ...draft, [draftKey]: Math.max(control.min, current - control.step) } as CreationDraft)} />
              <Chip label={`${current}${control.unit === 'seconds' ? 's' : ''}`} active onPress={() => undefined} />
              <Chip label="+" active={false} onPress={() => onChange({ ...draft, [draftKey]: Math.min(control.max, current + control.step) } as CreationDraft)} />
            </OptionRow>
          );
        }
        return null;
      })}
    </>
  );
}

function CreationReferences({
  catalog,
  activeTool,
  imageDraft,
  videoDraft,
  motionDraft,
  onImageChange,
  onVideoChange,
  onMotionChange,
  onUploadImageReferences,
  onUploadVideoReferences,
  onUploadStart,
  onUploadEnd,
  onUploadCharacter,
  onUploadMotionReference,
  onUseImageHandle,
  onUseVideoHandle,
  isUploading,
}: {
  catalog: GenerationModelCatalog | null;
  activeTool: CreatorToolId;
  imageDraft: ImageCreationDraft;
  videoDraft: VideoCreationDraft;
  motionDraft: MotionCreationDraft;
  onImageChange: (updater: (draft: ImageCreationDraft) => ImageCreationDraft) => void;
  onVideoChange: (updater: (draft: VideoCreationDraft) => VideoCreationDraft) => void;
  onMotionChange: (updater: (draft: MotionCreationDraft) => MotionCreationDraft) => void;
  onUploadImageReferences: () => void;
  onUploadVideoReferences: () => void;
  onUploadStart: () => void;
  onUploadEnd: () => void;
  onUploadCharacter: () => void;
  onUploadMotionReference: () => void;
  onUseImageHandle: (handle: string) => void;
  onUseVideoHandle: (handle: string) => void;
  isUploading: boolean;
}) {
  if (activeTool === 'image') {
    const model = catalog ? getCatalogModel(catalog, imageDraft.model) : null;
    const maxImages = model?.inputs.imageReferences?.max ?? 0;
    return (
      <View style={{ gap: appTheme.spacing.gap }}>
        <UploadBlock
          title="Reference images"
          badge={`${imageDraft.references.length} / ${maxImages}`}
          body="Optional: style, pose, product, or face guide."
          actionLabel="Add reference"
          onPress={onUploadImageReferences}
          disabled={isUploading}
        />
        <MediaList
          items={imageDraft.references}
          onRemove={(id) => onImageChange((draft) => ({ ...draft, references: draft.references.filter((media) => media.id !== id) }))}
          onRename={(id, displayName) => onImageChange((draft) => ({ ...draft, references: renameMediaInList(draft.references, id, displayName) }))}
          onUseHandle={onUseImageHandle}
        />
      </View>
    );
  }

  if (activeTool === 'video') {
    const model = catalog ? getCatalogModel(catalog, videoDraft.model) : null;
    const elementLimit = model?.inputs.imageReferences?.max ?? 0;
    const supportsElements = elementLimit > 0 && !videoDraft.isMultiShot;
    const supportsFrames = Boolean(model?.inputs.startFrame || model?.inputs.endFrame);
    const referenceMode = videoDraft.referenceMode === 'elements' && supportsElements
      ? 'elements'
      : supportsFrames ? 'frames' : 'elements';
    return (
      <View style={{ gap: appTheme.spacing.gap }}>
        {supportsFrames && supportsElements ? (
          <OptionRow title="Reference mode">
            <Chip label="Start / end" active={referenceMode === 'frames'} onPress={() => onVideoChange((draft) => ({ ...draft, referenceMode: 'frames' }))} />
            <Chip label="Reusable refs" active={referenceMode === 'elements'} onPress={() => onVideoChange((draft) => ({ ...draft, referenceMode: 'elements' }))} />
          </OptionRow>
        ) : null}
        {referenceMode === 'frames' && supportsFrames ? (
          <View style={{ gap: 10 }}>
            {model?.inputs.startFrame ? <UploadBlock title={model.id === 'hailuo-2.3' ? 'Start frame · required' : 'Start frame'} actionLabel={videoDraft.startFrame ? 'Replace start' : 'Add start'} onPress={onUploadStart} disabled={isUploading} /> : null}
            {model?.inputs.startFrame && videoDraft.startFrame ? (
              <MediaList
                items={[videoDraft.startFrame]}
                onRemove={() => onVideoChange((draft) => ({ ...draft, startFrame: null }))}
                onRename={(id, displayName) => onVideoChange((draft) => ({ ...draft, startFrame: renameOptionalMedia(draft.startFrame, id, displayName) }))}
              />
            ) : null}
            {model?.inputs.endFrame ? <UploadBlock title="End frame" actionLabel={videoDraft.endFrame ? 'Replace end' : 'Add end'} onPress={onUploadEnd} disabled={isUploading || videoDraft.isMultiShot} /> : null}
            {model?.inputs.endFrame && videoDraft.endFrame ? (
              <MediaList
                items={[videoDraft.endFrame]}
                onRemove={() => onVideoChange((draft) => ({ ...draft, endFrame: null }))}
                onRename={(id, displayName) => onVideoChange((draft) => ({ ...draft, endFrame: renameOptionalMedia(draft.endFrame, id, displayName) }))}
              />
            ) : null}
          </View>
        ) : supportsElements ? (
          <View style={{ gap: 10 }}>
            <UploadBlock
              title="Reusable image references"
              badge={`${videoDraft.references.length} / ${elementLimit}`}
              body="Keep characters, products, or styles consistent and mention them by name in the prompt."
              actionLabel="Add references"
              onPress={onUploadVideoReferences}
              disabled={isUploading}
            />
            <MediaList
              items={videoDraft.references}
              onRemove={(id) => onVideoChange((draft) => ({ ...draft, references: draft.references.filter((media) => media.id !== id) }))}
              onRename={(id, displayName) => onVideoChange((draft) => ({ ...draft, references: renameMediaInList(draft.references, id, displayName) }))}
              onUseHandle={onUseVideoHandle}
            />
            {model?.inputs.combineFramesWithReferences && model.inputs.startFrame ? (
              <>
                <UploadBlock
                  title="First frame · optional"
                  body="Wan can combine this frame with reusable image, video, and voice references."
                  actionLabel={videoDraft.startFrame ? 'Replace frame' : 'Add first frame'}
                  onPress={onUploadStart}
                  disabled={isUploading}
                />
                {videoDraft.startFrame ? (
                  <MediaList
                    items={[videoDraft.startFrame]}
                    onRemove={() => onVideoChange((draft) => ({ ...draft, startFrame: null }))}
                    onRename={(id, displayName) => onVideoChange((draft) => ({ ...draft, startFrame: renameOptionalMedia(draft.startFrame, id, displayName) }))}
                  />
                ) : null}
              </>
            ) : null}
          </View>
        ) : <AppText variant="bodySm" color="muted">This model does not accept image references.</AppText>}
      </View>
    );
  }

  const duration = getMotionDuration(motionDraft);
  return (
    <View style={{ gap: appTheme.spacing.gap }}>
      <UploadBlock title="Character image" actionLabel={motionDraft.characterImage ? 'Replace image' : 'Add image'} onPress={onUploadCharacter} disabled={isUploading} />
      {motionDraft.characterImage ? (
        <MediaList
          items={[motionDraft.characterImage]}
          onRemove={() => onMotionChange((draft) => ({ ...draft, characterImage: null }))}
          onRename={(id, displayName) => onMotionChange((draft) => ({ ...draft, characterImage: renameOptionalMedia(draft.characterImage, id, displayName) }))}
        />
      ) : null}
      <UploadBlock title={`Reference motion video${duration ? ` • ${duration}s` : ''}`} actionLabel={motionDraft.referenceVideo ? 'Replace video' : 'Add video'} onPress={onUploadMotionReference} disabled={isUploading} />
      {motionDraft.referenceVideo ? (
        <MediaList
          items={[motionDraft.referenceVideo]}
          onRemove={() => onMotionChange((draft) => ({ ...draft, referenceVideo: null }))}
          onRename={(id, displayName) => onMotionChange((draft) => ({ ...draft, referenceVideo: renameOptionalMedia(draft.referenceVideo, id, displayName) }))}
        />
      ) : null}
    </View>
  );
}

function CreationAdvanced({
  catalog,
  activeTool,
  imageDraft,
  videoDraft,
  motionDraft,
  onChange,
  onVideoChange,
  onUploadVideo,
  onUploadAudio,
  onRemoveReferenceVideo,
  onRemoveReferenceAudio,
  isUploading,
}: {
  catalog: GenerationModelCatalog | null;
  activeTool: CreatorToolId;
  imageDraft: ImageCreationDraft;
  videoDraft: VideoCreationDraft;
  motionDraft: MotionCreationDraft;
  onChange: (draft: CreationDraft) => void;
  onVideoChange: (updater: (draft: VideoCreationDraft) => VideoCreationDraft) => void;
  onUploadVideo: () => void;
  onUploadAudio: () => void;
  onRemoveReferenceVideo: (id: string) => void;
  onRemoveReferenceAudio: (id: string) => void;
  isUploading: boolean;
}) {
  const draft: CreationDraft = activeTool === 'image' ? imageDraft : activeTool === 'video' ? videoDraft : motionDraft;
  const model = catalog ? getCatalogModel(catalog, draft.model) : null;
  if (!model) return <AppText variant="bodySm" color="muted">Model settings are unavailable.</AppText>;

  return (
    <View style={{ gap: appTheme.spacing.gap }}>
      <CatalogAdvancedControls model={model} draft={draft} onChange={onChange} />
      {draft.tool === 'video' && draft.isMultiShot ? <ShotEditor draft={draft} onChange={(nextDraft) => onChange(nextDraft)} /> : null}
      {draft.tool === 'video' && draft.referenceMode === 'elements' && model.inputs.videoReferences ? (
        <View style={{ gap: 10 }}>
          <UploadBlock title={`Reference videos (${draft.referenceVideos.length}/${model.inputs.videoReferences.max})`} actionLabel="Add video" onPress={onUploadVideo} disabled={isUploading} />
          <MediaList
            items={draft.referenceVideos}
            onRemove={onRemoveReferenceVideo}
            onRename={(id, displayName) => onVideoChange((current) => ({ ...current, referenceVideos: renameMediaInList(current.referenceVideos, id, displayName) }))}
          />
        </View>
      ) : null}
      {draft.tool === 'video' && draft.referenceMode === 'elements' && model.inputs.audioReferences ? (
        <View style={{ gap: 10 }}>
          <UploadBlock title={`Reference audio (${draft.referenceAudios.length}/${model.inputs.audioReferences.max})`} actionLabel="Add audio" onPress={onUploadAudio} disabled={isUploading} />
          <MediaList
            items={draft.referenceAudios}
            onRemove={onRemoveReferenceAudio}
            onRename={(id, displayName) => onVideoChange((current) => ({ ...current, referenceAudios: renameMediaInList(current.referenceAudios, id, displayName) }))}
          />
        </View>
      ) : null}
      {draft.tool === 'video' && draft.referenceMode === 'elements' && model.inputs.preparedAudioReferences ? (
        <PreparedReferenceIds
          title="Prepared voice IDs"
          accessibilityLabel="Gemini Omni voice ID"
          placeholder="Paste prepared voice ID"
          items={draft.preparedAudioIds}
          max={model.inputs.preparedAudioReferences.max}
          onChange={(items) => onVideoChange((current) => ({ ...current, preparedAudioIds: items }))}
        />
      ) : null}
      {draft.tool === 'video' && draft.referenceMode === 'elements' && model.inputs.characterReferences ? (
        <PreparedReferenceIds
          title="Prepared character IDs"
          accessibilityLabel="Gemini Omni character ID"
          placeholder="Paste prepared character ID"
          items={draft.characterIds}
          max={model.inputs.characterReferences.max}
          onChange={(items) => onVideoChange((current) => ({ ...current, characterIds: items }))}
        />
      ) : null}
    </View>
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
          placeholder={placeholder}
          placeholderTextColor={appTheme.colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
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
          style={{
            minWidth: 64,
            minHeight: appTheme.touch.default,
            borderRadius: 16,
            borderCurve: 'continuous',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(255,122,89,0.16)',
            borderWidth: 1,
            borderColor: 'rgba(255,122,89,0.38)',
            opacity: items.length >= max ? 0.45 : 1,
          }}
        >
          <AppText variant="label">Add</AppText>
        </Pressable>
      </View>
      {items.map((item) => (
        <View key={item} style={{ minHeight: 46, borderRadius: 15, borderCurve: 'continuous', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', backgroundColor: 'rgba(255,255,255,0.035)', paddingLeft: 12, paddingRight: 6, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text selectable numberOfLines={1} style={{ flex: 1, color: appTheme.colors.textSecondary, fontFamily: 'monospace', fontSize: 12 }}>{item}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${item}`} onPress={() => onChange(items.filter((value) => value !== item))} hitSlop={8} style={{ padding: 9 }}>
            <Trash2 size={16} color={appTheme.colors.muted} />
          </Pressable>
        </View>
      ))}
      <AppText variant="caption" color="muted">Use IDs created by Gemini Omni’s voice or character preparation endpoints.</AppText>
    </View>
  );
}

function CatalogAdvancedControls({ model, draft, onChange }: {
  model: ReturnType<typeof getCatalogModels>[number];
  draft: CreationDraft;
  onChange: (draft: CreationDraft) => void;
}) {
  const controls = model.controls.filter((control) => !['aspectRatio', 'resolution', 'duration'].includes(control.key));
  const draftRecord = draft as unknown as Record<string, unknown>;
  return (
    <>
      {controls.map((control) => {
        const key = draft.tool === 'motion' && control.key === 'resolution' ? 'mode' : control.key;
        if (control.type === 'boolean') {
          return <ToggleRow key={control.key} title={control.label} value={Boolean(draftRecord[key] ?? control.defaultValue)} onValueChange={(value) => onChange({ ...draft, [key]: value } as CreationDraft)} />;
        }
        if (control.type === 'choice') {
          const current = String(draftRecord[key] ?? control.defaultValue);
          return (
            <OptionRow key={control.key} title={control.label}>
              {control.options.map((option) => (
                <Chip key={option.value} label={option.label} active={current === option.value} onPress={() => onChange({ ...draft, [key]: option.value } as CreationDraft)} />
              ))}
            </OptionRow>
          );
        }
        return null;
      })}
    </>
  );
}

function ResultPanel({
  outputUrl,
  kind,
  generationId,
  accent,
  onPost,
  onOpenAlerts,
  onCreateAnother,
}: {
  outputUrl: string;
  kind: 'image' | 'video';
  generationId: string | null;
  accent: ToolAccent;
  onPost: () => void;
  onOpenAlerts: () => void;
  onCreateAnother: () => void;
}) {
  return (
    <SurfaceSection
      eyebrow="Result"
      title="Your generation is ready"
      body="Continue into post setup to choose caption, visibility, references, and optional resources."
      accent={accent}
    >
      <MediaPreview url={outputUrl} kind={kind} />
      <View style={{ gap: appTheme.spacing.gap }}>
        {generationId ? (
          <>
            <ReadinessRow
              label="Post setup next"
              body="Post this opens the composer first. Nothing publishes until you review the post."
              state="ready"
            />
            <PrimaryButton label="Post this" onPress={onPost} accent="primary" />
          </>
        ) : null}
        <View style={{ flexDirection: 'row', gap: appTheme.spacing.gap }}>
          <View style={{ flex: 1 }}>
            <SecondaryButton label="Open Alerts" onPress={onOpenAlerts} />
          </View>
          <View style={{ flex: 1 }}>
            <SecondaryButton label="Create another" onPress={onCreateAnother} />
          </View>
        </View>
      </View>
    </SurfaceSection>
  );
}

function ModelPicker({
  items,
  value,
  accent,
  onChange,
}: {
  items: Array<{ id: string; displayName: string; description: string; badge?: string | null }>;
  value: string;
  accent: ToolAccent;
  onChange: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const selected = items.find((item) => item.id === value) ?? items[0];
  const normalizedQuery = query.trim().toLowerCase();
  const filteredItems = useMemo(() => {
    if (!normalizedQuery) return items;
    return items.filter((item) => {
      const searchable = `${item.displayName} ${item.description} ${item.badge ?? ''}`.toLowerCase();
      return searchable.includes(normalizedQuery);
    });
  }, [items, normalizedQuery]);

  const toggleExpanded = () => {
    if (!expanded) setQuery('');
    setExpanded(!expanded);
  };

  return (
    <View style={{ gap: 10 }}>
      <View
        style={{
          minHeight: 74,
          borderRadius: 20,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: `${accentColor(accent)}AA`,
          backgroundColor: `${accentColor(accent)}18`,
          padding: 12,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Selected model ${selected.displayName}. ${expanded ? 'Hide model choices' : 'Change model'}`}
          accessibilityState={{ expanded }}
          onPress={toggleExpanded}
          style={{ flex: 1, minWidth: 0, gap: 3, alignSelf: 'stretch', justifyContent: 'center' }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ color: accentColor(accent), fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }}>
              Selected model
            </Text>
            {selected.badge ? (
              <Text style={{ color: accentColor(accent), fontSize: 10, fontWeight: '800' }}>{selected.badge}</Text>
            ) : null}
          </View>
          <Text numberOfLines={1} style={{ color: '#ffffff', fontSize: 16, fontWeight: '800' }}>
            {selected.displayName}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Hide model choices' : 'Search model choices'}
          accessibilityState={{ expanded }}
          onPress={toggleExpanded}
          hitSlop={10}
          style={{
            minHeight: appTheme.touch.compact,
            borderRadius: appTheme.radii.pill,
            backgroundColor: `${accentColor(accent)}22`,
            paddingHorizontal: 14,
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'row',
            gap: 5,
          }}
        >
          <Text style={{ color: '#ffffff', fontSize: 12, fontWeight: '800' }}>{expanded ? 'Hide' : 'Change'}</Text>
          <ChevronDown size={14} color="#ffffff" style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }} />
        </Pressable>
      </View>

      {expanded ? (
        <View
          style={{
            borderRadius: 18,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.1)',
            backgroundColor: 'rgba(0,0,0,0.24)',
            padding: 8,
            gap: 8,
          }}
        >
          <View
            style={{
              minHeight: appTheme.touch.compact,
              borderRadius: 14,
              borderCurve: 'continuous',
              borderWidth: 1,
              borderColor: `${accentColor(accent)}44`,
              backgroundColor: 'rgba(255,255,255,0.055)',
              paddingHorizontal: 10,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 7,
            }}
          >
            <Search size={15} color={appTheme.colors.muted} />
            <TextInput
              accessibilityLabel="Search model names"
              value={query}
              onChangeText={setQuery}
              placeholder="Search models"
              placeholderTextColor={appTheme.colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                flex: 1,
                color: '#ffffff',
                fontSize: 13,
                fontWeight: '700',
                paddingVertical: 7,
              }}
            />
          </View>

          <ScrollView
            accessibilityLabel="Available generation models"
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
            style={{ maxHeight: 340 }}
            contentContainerStyle={{ gap: 2 }}
          >
            {filteredItems.map((item) => {
            const active = item.id === value;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => {
                  onChange(item.id);
                  setExpanded(false);
                  setQuery('');
                }}
                style={({ pressed }) => ({
                  minHeight: appTheme.touch.compact,
                  borderRadius: 14,
                  borderCurve: 'continuous',
                  borderWidth: 1,
                  borderColor: active ? `${accentColor(accent)}66` : 'transparent',
                  backgroundColor: active ? `${accentColor(accent)}12` : 'transparent',
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  opacity: pressed ? 0.78 : 1,
                })}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Text numberOfLines={1} style={{ flex: 1, color: '#ffffff', fontSize: 14, fontWeight: '800' }}>
                    {item.displayName}
                  </Text>
                  {item.badge ? (
                    <Text style={{ color: accentColor(accent), fontSize: 10, fontWeight: '800' }}>{item.badge}</Text>
                  ) : null}
                  {active ? (
                    <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: `${accentColor(accent)}20` }}>
                      <Check size={14} color={accentColor(accent)} />
                    </View>
                  ) : (
                    <View style={{ width: 22 }} />
                  )}
                </View>
              </Pressable>
            );
            })}
            {filteredItems.length === 0 ? (
              <View style={{ minHeight: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.045)', padding: 10 }}>
                <Text style={{ color: appTheme.colors.muted, fontSize: 12, fontWeight: '800' }}>No models found</Text>
              </View>
            ) : null}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

function ShotEditor({ draft, onChange }: { draft: VideoCreationDraft; onChange: (draft: VideoCreationDraft) => void }) {
  const updateShot = (id: string, patch: Partial<{ prompt: string; duration: number }>) => {
    onChange({
      ...draft,
      multiPrompts: draft.multiPrompts.map((shot) => (shot.id === id ? { ...shot, ...patch } : shot)),
    });
  };

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <Text style={{ color: '#ffffff', fontWeight: '800' }}>Shots</Text>
        <SecondaryAction
          label="Add shot"
          compact
          onPress={() => onChange({
            ...draft,
            multiPrompts: [...draft.multiPrompts, { id: `shot-${draft.multiPrompts.length + 1}`, prompt: '', duration: 5 }],
          })}
        />
      </View>
      {draft.multiPrompts.map((shot, index) => (
        <View
          key={shot.id}
          style={{
            borderRadius: 18,
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.1)',
            backgroundColor: 'rgba(255,255,255,0.04)',
            padding: 12,
            gap: 10,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <Text style={{ color: '#ffffff', fontWeight: '800' }}>Shot {index + 1}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove shot ${index + 1}`}
              accessibilityState={{ disabled: draft.multiPrompts.length <= 1 }}
              disabled={draft.multiPrompts.length <= 1}
              onPress={() => onChange({ ...draft, multiPrompts: draft.multiPrompts.filter((item) => item.id !== shot.id) })}
              style={({ pressed }) => ({
                width: 48,
                height: 48,
                borderRadius: 24,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: pressed ? appTheme.colors.pressed : appTheme.colors.surface,
                opacity: draft.multiPrompts.length <= 1 ? 0.35 : 1,
              })}
            >
              <Trash2 size={18} color={appTheme.colors.muted} />
            </Pressable>
          </View>
          <TextInput
            value={shot.prompt}
            onChangeText={(prompt) => updateShot(shot.id, { prompt })}
            multiline
            textAlignVertical="top"
            placeholder="Describe this shot..."
            placeholderTextColor="rgba(255,255,255,0.32)"
            style={{
              minHeight: 78,
              color: '#ffffff',
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.1)',
              borderRadius: 16,
              padding: 12,
              backgroundColor: 'rgba(0,0,0,0.22)',
            }}
          />
          <OptionRow title="Duration">
            {[3, 4, 5, 6, 8, 10, 12].map((duration) => (
              <Chip key={duration} label={`${duration}s`} active={shot.duration === duration} onPress={() => updateShot(shot.id, { duration })} />
            ))}
          </OptionRow>
        </View>
      ))}
    </View>
  );
}

function SectionLabel({ title, icon }: { title: string; icon: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {icon}
      <Text style={{ color: '#ffffff', fontSize: 17, fontWeight: '800' }}>{title}</Text>
    </View>
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

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <ChoiceChip
      label={label}
      active={active}
      onPress={onPress}
      accent="motion"
      compact
    />
  );
}

function ToggleRow({ title, value, onValueChange }: { title: string; value: boolean; onValueChange: (value: boolean) => void }) {
  return (
    <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Text style={{ color: '#ffffff', fontSize: 15, fontWeight: '800' }}>{title}</Text>
      <Switch
        accessibilityLabel={title}
        value={value}
        onValueChange={onValueChange}
        thumbColor={value ? '#1A0D08' : '#CAC6BD'}
        trackColor={{ false: '#343838', true: '#FF7A59' }}
      />
    </View>
  );
}

function UploadBlock({
  title,
  badge,
  body = 'Upload from your phone',
  actionLabel,
  onPress,
  disabled,
}: {
  title: string;
  badge?: string;
  body?: string;
  actionLabel: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <View
      style={{
        minHeight: 70,
        borderRadius: 20,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        backgroundColor: 'rgba(255,255,255,0.04)',
        padding: 12,
        gap: 12,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.pressed }}>
          <Layers size={20} color={appTheme.colors.primary} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text numberOfLines={1} style={{ color: '#ffffff', fontWeight: '800', flexShrink: 1 }}>{title}</Text>
            {badge ? (
              <Text style={{ color: appTheme.colors.muted, fontSize: 11, fontWeight: '800', flexShrink: 0 }}>
                {badge}
              </Text>
            ) : null}
          </View>
          <Text numberOfLines={2} style={{ color: appTheme.colors.muted, fontSize: 12, lineHeight: 16 }}>{body}</Text>
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={actionLabel}
        disabled={disabled}
        onPress={onPress}
        style={{
          minHeight: appTheme.touch.compact,
          borderRadius: appTheme.radii.pill,
          paddingHorizontal: 12,
          alignItems: 'center',
          justifyContent: 'center',
          alignSelf: 'flex-start',
          backgroundColor: 'rgba(255,255,255,0.09)',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Text style={{ color: '#ffffff', fontWeight: '800', fontSize: 12 }}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

function MediaList({
  items,
  onRemove,
  onRename,
  onUseHandle,
}: {
  items: MediaDraft[];
  onRemove: (id: string) => void;
  onRename?: (id: string, displayName: string) => void;
  onUseHandle?: (handle: string) => void;
}) {
  const [previewMedia, setPreviewMedia] = useState<MediaDraft | null>(null);

  if (items.length === 0) return null;

  return (
    <View style={{ gap: 8 }}>
      {items.map((media) => (
        <View
          key={media.id}
          style={{
            minHeight: 92,
            borderRadius: 18,
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.08)',
            backgroundColor: 'rgba(0,0,0,0.2)',
            padding: 10,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Preview ${media.displayName}`}
            onPress={() => setPreviewMedia(media)}
            style={({ pressed }) => ({
              borderRadius: 16,
              opacity: pressed ? 0.78 : 1,
            })}
          >
            <ReferenceMediaPreview media={media} />
          </Pressable>
          <View style={{ flex: 1, minWidth: 0, gap: 7 }}>
            <TextInput
              accessibilityLabel={`Reference name for ${media.displayName}`}
              value={media.displayName}
              onChangeText={(displayName) => onRename?.(media.id, displayName)}
              editable={Boolean(onRename)}
              placeholder="Reference name"
              placeholderTextColor={appTheme.colors.faint}
              style={{
                minHeight: appTheme.touch.compact,
                borderRadius: 12,
                borderCurve: 'continuous',
                borderWidth: 1,
                borderColor: 'rgba(255,255,255,0.1)',
                backgroundColor: 'rgba(255,255,255,0.045)',
                color: '#ffffff',
                fontSize: 13,
                fontWeight: '800',
                paddingHorizontal: 10,
                paddingVertical: 7,
              }}
            />
            <Text numberOfLines={1} style={{ color: appTheme.colors.muted, fontSize: 11 }}>{mediaSummary(media)}</Text>
          </View>
          {media.handle && onUseHandle ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Use ${media.handle}`}
              onPress={() => onUseHandle(media.handle!)}
              style={{ minHeight: appTheme.touch.compact, borderRadius: appTheme.radii.pill, backgroundColor: `${appTheme.colors.image}1f`, paddingHorizontal: 9, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ color: '#7dd3fc', fontSize: 11, fontWeight: '800' }}>{media.handle}</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${media.displayName}`}
            onPress={() => onRemove(media.id)}
            style={{ width: appTheme.touch.compact, height: appTheme.touch.compact, alignItems: 'center', justifyContent: 'center' }}
          >
            <Trash2 size={17} color={appTheme.colors.muted} />
          </Pressable>
        </View>
      ))}
      <ReferencePreviewModal media={previewMedia} onClose={() => setPreviewMedia(null)} />
    </View>
  );
}

function ReferencePreviewModal({ media, onClose }: { media: MediaDraft | null; onClose: () => void }) {
  const { height } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const previewHeight = Math.min(360, Math.max(240, Math.round(height - 300)));

  if (!media) return null;

  return (
    <Modal
      animationType={reducedMotion ? 'none' : 'fade'}
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible
    >
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.82)',
          justifyContent: 'center',
          padding: 20,
        }}
      >
        <Pressable
          accessible={false}
          onPress={onClose}
          style={{ position: 'absolute', inset: 0 }}
        />
        <View
          style={{
            borderRadius: 28,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.14)',
            backgroundColor: 'rgba(18,18,22,0.96)',
            padding: 16,
            gap: 14,
            boxShadow: '0 24px 80px rgba(0,0,0,0.46)',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: appTheme.colors.muted, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }}>Reference preview</Text>
              <Text numberOfLines={1} style={{ color: '#ffffff', fontSize: 18, fontWeight: '800' }}>{media.displayName}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close reference preview"
              onPress={onClose}
              style={{
                minHeight: appTheme.touch.compact,
                borderRadius: appTheme.radii.pill,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'rgba(255,255,255,0.09)',
                paddingHorizontal: 14,
              }}
            >
              <Text style={{ color: '#ffffff', fontSize: 12, fontWeight: '800' }}>Close</Text>
            </Pressable>
          </View>

          {media.kind === 'audio' ? (
            <View
              style={{
                height: previewHeight,
                borderRadius: 22,
                borderCurve: 'continuous',
                borderWidth: 1,
                borderColor: 'rgba(240,171,252,0.26)',
                backgroundColor: appTheme.colors.pressed,
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
              }}
            >
              <AudioLines size={36} color={appTheme.colors.motion} />
              <Text style={{ color: '#f5d0fe', fontSize: 14, fontWeight: '800' }}>Audio reference</Text>
            </View>
          ) : (
            <MediaPreview
              url={media.url}
              kind={media.kind === 'video' ? 'video' : 'image'}
              height={previewHeight}
              radius={22}
              nativeControls={media.kind === 'video'}
            />
          )}

          <Text selectable numberOfLines={2} style={{ color: appTheme.colors.muted, fontSize: 12, lineHeight: 18 }}>{mediaSummary(media)}</Text>
        </View>
      </View>
    </Modal>
  );
}

function ReferenceMediaPreview({ media }: { media: MediaDraft }) {
  if (media.kind === 'audio') {
    return (
      <View
        style={{
          width: 58,
          height: 72,
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
        <Text style={{ color: '#f5d0fe', fontSize: 10, fontWeight: '800' }}>Audio</Text>
      </View>
    );
  }

  const kind = media.kind === 'video' ? 'video' : 'image';

  return (
    <View
      style={{
        width: 58,
        height: 72,
        borderRadius: 16,
        borderCurve: 'continuous',
        overflow: 'hidden',
        backgroundColor: '#050506',
      }}
    >
      <MediaPreview
        url={media.url}
        kind={kind}
        height={72}
        radius={16}
        nativeControls={false}
      />
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

function SecondaryAction({
  label,
  onPress,
  compact,
}: {
  label: string;
  onPress: () => void;
  compact?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        minHeight: compact ? 34 : 46,
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.16)',
        paddingHorizontal: compact ? 12 : 16,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 6,
      }}
    >
      <Text style={{ color: '#ffffff', fontWeight: '800', fontSize: compact ? 12 : 14 }}>{label}</Text>
      <ChevronRight size={compact ? 14 : 16} color="#ffffff" />
    </Pressable>
  );
}

function ReviewIssuesPanel({
  validation,
  message,
}: {
  validation: CreationValidationResult;
  message: string | null;
}) {
  const visible = getVisibleGenerationCheckMessages(validation, message);

  if (!visible.message && visible.errors.length === 0 && visible.warnings.length === 0) {
    return null;
  }

  return (
    <View
      style={{
        borderRadius: 18,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(251,113,133,0.34)',
        backgroundColor: 'rgba(251,113,133,0.08)',
        padding: 12,
        gap: 8,
      }}
    >
      <Text selectable style={{ color: '#fb7185', fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1.1 }}>
        Review issues
      </Text>
      {visible.message ? <Text selectable style={{ color: appTheme.colors.danger, fontWeight: '800', lineHeight: 20 }}>{visible.message}</Text> : null}
      {visible.errors.map((error) => (
        <Text selectable key={error} style={{ color: appTheme.colors.danger, lineHeight: 20 }}>{error}</Text>
      ))}
      {visible.warnings.map((warning) => (
        <Text selectable key={`${warning.code}-${warning.message}`} style={{ color: warning.severity === 'blocking' ? appTheme.colors.danger : appTheme.colors.amber, lineHeight: 20 }}>
          {warning.message}
        </Text>
      ))}
      {visible.errors.some((error) => error.startsWith('Unknown element mention:')) ? (
        <Text selectable style={{ color: appTheme.colors.muted, fontSize: 12, lineHeight: 18 }}>
          Remove the unknown @handle or add a named reference before generating.
        </Text>
      ) : null}
    </View>
  );
}
