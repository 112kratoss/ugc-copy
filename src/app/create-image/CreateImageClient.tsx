'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Sparkles, Loader2, Download, X, Image as ImageIcon, Images, Zap, ChevronDown, Check, Share2, Expand } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import { GENERATION_PROMPT_MAX_LENGTH } from '../../../ugc-mobile/lib/model-catalog/protocol';
import {
    GeneratorPageHeader,
    MediaStudioShell,
    StudioBackgroundProcessingNotice,
    StudioElementChip,
    StudioElementHandle,
    StudioElementHandleList,
    StudioGenerationStatus,
    StudioMediaPreviewModal,
    StudioModelNotice,
    StudioRemixHydrationNotice,
    StudioRemixNotice,
    StudioRunPanel,
    StudioWorkspacePanel,
} from '@/components/CreatorStudio';
import StudioModelPicker from '@/components/StudioModelPicker';
import CatalogAdditionalControls, { catalogChoiceDefault, useAdditionalCatalogSettings } from '@/components/CatalogAdditionalControls';
import PublicShareButton from '@/components/PublicShareButton';
import PublishToShowcaseModal from '@/components/PublishToShowcaseModal';
import EnhancePromptButton from '@/components/EnhancePromptButton';
import { useAuth } from '@/components/AuthProvider';
import type { RemixSourceBundle } from '@/lib/remix-source';
import { hasCreatorEditedPromptDuringRemix } from '@/lib/remix-source';
import {
    createRemixElementSeeds,
    createRemixResultReferenceElement,
    getRemixRestoreWarning,
    getRemixResultReferenceLabel,
} from '@/lib/remix-source-client';
import { buildShowcaseDetailPath } from '@/lib/share';
import {
    getPersistedImageElementRecords,
    PERSISTED_MEDIA_KEYS,
    purgeLegacyPersistedMedia,
    scopedPersistedMediaKey,
    setPersistedImageElementRecords,
} from '@/lib/persisted-media';
import { loadCreatorDraft, saveCreatorDraft } from '@/lib/persisted-creator-draft';
import {
    assignElementHandles,
    createElementHandleReplacementMap,
    createElementId,
    extractPromptHandles,
    findUnknownPromptHandles,
    getMentionQueryAtCaret,
    insertHandleIntoPrompt,
    replacePromptHandles,
    type ImageElementDescriptor,
} from '@/lib/image-elements';
import { BACKGROUND_PROCESSING_ERROR, getBackgroundProcessingCopy } from '@/lib/generation-feedback';
import { createGenerationIdempotencyKey } from '@/lib/generation-idempotency-client';
import {
    announceGenerationStarted,
    fetchGenerationStatusWithRetry,
    isGenerationStatusAbortError,
    waitForNextGenerationStatusPoll,
    type GenerationStatusResponse,
} from '@/lib/generation-status-client';
import {
    createLocalGenerationTiming,
    estimateGenerationDurationMs,
    freezeGenerationTiming,
    getCurrentTimestampMs,
    getGenerationTimingSummaryLabel,
    type GenerationTiming,
} from '@/lib/generation-timing';
import { buildMediaProxyUrl, getStoredMediaLocation } from '@/lib/media-urls';
import {
    getImageQualityModes,
    getImageResolutionOptions,
    IMAGE_MODELS,
    supportsImageResolutionControl,
    type ImageModelId,
    type ImageQualityMode,
    type ImageResolution,
} from '@/lib/client-generation-models';
import { getImageInputAffordances } from '@/lib/generation-model-affordances';
import type { CatalogPrimitive, GenerationModelDescriptor } from '@/lib/generation-model-catalog';
import type { CatalogGenerationRequestPayload } from '@/lib/generation-model-adapters';
import {
    clearPendingWebStart,
    isAmbiguousWebStartFailure,
    loadPendingWebStart,
    requestWebGenerationStart,
    resolveCatalogModelId,
    resolveWebGenerationQuoteUi,
    savePendingWebStart,
    useWebGenerationModelCatalog,
    useWebGenerationModelQuote,
    WebCatalogRequestError,
    type PendingWebStart,
    type WebGenerationStartResponse,
} from '@/lib/generation-model-client';
import type { GenerationPaywallPrefill } from '@/lib/generation-paywall';
import { RECLAIM_AFTER_HOURS } from '@/lib/media-upload-reclaim';
import { useDeploymentRefresh } from '@/lib/use-deployment-refresh';
import { useNameDrafts } from '@/lib/use-name-drafts';
import { useTicker } from '@/lib/use-ticker';
import {
    refreshTemporaryMediaUrl,
    TEMPORARY_MEDIA_UPLOAD_LIMITS,
    uploadMediaToTemporaryStorage,
} from '@/lib/temporary-media-upload';

type ModelId = ImageModelId;

interface ImageWorkflowSettings {
    model?: ModelId;
    aspectRatio?: string;
    resolution?: string;
    qualityMode?: ImageQualityMode;
    googleSearch?: boolean;
    elements?: ImageElementDescriptor[];
    promptMode?: 'element-mentions-v1';
    compiledPrompt?: string;
}

interface UploadPreviewState {
    type: 'image';
    src: string;
    alt: string;
    title: string;
}

/** An element's file as this page last staged it in `uploads`. */
type StagedElementUpload = {
    storagePath: string;
    signedUrl: string;
    uploadedAt: number;
};

type ImageElementDraft = ImageElementDescriptor & {
    file: File | null;
    previewUrl: string;
    providerUrl: string | null;
    source: 'upload' | 'remix';
    sourceGenerationId?: string | null;
    staged: StagedElementUpload | null;
};

type ImageElementSeed = {
    id?: string;
    displayName?: string;
    handle?: string | null;
    file?: File | null;
    previewUrl: string;
    providerUrl?: string | null;
    storagePath?: string | null;
    source?: 'upload' | 'remix';
    sourceGenerationId?: string | null;
    staged?: StagedElementUpload | null;
};

/**
 * How long a staged copy is sent again instead of its file. The sweep deletes a
 * staged object a run has used RECLAIM_AFTER_HOURS after it was signed; eight
 * hours short of that leaves room for a long session.
 */
const STAGED_UPLOAD_REUSE_MS = (RECLAIM_AFTER_HOURS - 8) * 60 * 60 * 1000;

/** What a reload, a top-up round trip or a lost session must not take away. */
type ImageCreatorDraft = {
    prompt: string;
    modelId: string;
    aspectRatio: string;
    resolution: string;
    qualityMode: string;
    googleSearch: boolean;
    additionalSettings: Record<string, CatalogPrimitive>;
};

const CREATOR_DRAFT_SAVE_DELAY_MS = 500;

const START_UNCONFIRMED_MESSAGE = 'We couldn’t confirm your generation started. Check again — that can’t start a second run.';

type CreationPublishDetails = {
    title: string;
    paywallPrefill: GenerationPaywallPrefill | null;
};

const EMPTY_PUBLISH_DETAILS: CreationPublishDetails = { title: '', paywallPrefill: null };
/** How long the publish button waits for the creation's details before opening without them. */
const PUBLISH_DETAILS_WAIT_MS = 3_000;

const IMAGE_FILE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic', 'heif']);

/** The run ended failed: its message is the provider's reason. */
class ImageRunFailedError extends Error {}

function revokePreviewUrl(url: string | null | undefined) {
    if (url?.startsWith('blob:')) {
        URL.revokeObjectURL(url);
    }
}

function hydrateImageElements(seeds: ImageElementSeed[]): ImageElementDraft[] {
    return assignElementHandles(seeds).map((seed) => ({
        id: seed.id ?? createElementId(),
        displayName: seed.displayName,
        handle: seed.handle,
        file: seed.file ?? null,
        previewUrl: seed.previewUrl,
        providerUrl: seed.providerUrl ?? null,
        storagePath: seed.storagePath ?? null,
        source: seed.source ?? 'upload',
        sourceGenerationId: seed.sourceGenerationId ?? null,
        staged: seed.staged ?? null,
    }));
}

function readAccessToken(): Promise<string | null> {
    return supabase.auth.getSession().then(({ data }) => data.session?.access_token ?? null);
}

/** Back to this page with its params, so a remix or a prefilled prompt survives the sign-in. */
function getLoginPathForThisPage(): string {
    return `/login?returnUrl=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`;
}

/**
 * The element's copy in `uploads`: the one this page staged, while the sweep
 * still keeps it, under a fresh link; else a new upload of the file. Each run
 * used to upload every element again.
 */
async function stageElementFile(file: File, staged: StagedElementUpload | null): Promise<StagedElementUpload> {
    if (staged && Date.now() - staged.uploadedAt < STAGED_UPLOAD_REUSE_MS) {
        try {
            return { ...staged, signedUrl: await refreshTemporaryMediaUrl(staged.storagePath) };
        } catch {
            // Gone from storage, or the link could not be renewed: the file goes up again.
        }
    }
    const upload = await uploadMediaToTemporaryStorage(file);
    return { storagePath: upload.storagePath, signedUrl: upload.signedUrl, uploadedAt: Date.now() };
}

function readDraftSettings(value: unknown): Record<string, CatalogPrimitive> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return Object.fromEntries(Object.entries(value).filter(([, setting]) => (
        typeof setting === 'string'
        || typeof setting === 'boolean'
        || (typeof setting === 'number' && Number.isFinite(setting))
    ))) as Record<string, CatalogPrimitive>;
}

/** A failed run is refunded in the step that marks it failed. */
function withCreditsReturned(message: string, cost: number | null): string {
    if (!cost || cost <= 0) return message;
    const trimmed = message.trim();
    const sentence = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
    return `${sentence} Your ${cost} credit${cost === 1 ? ' was' : 's were'} returned.`;
}

/** The output's own extension, for its download name: a PNG run is not a .jpg. */
function getImageFileExtension(imageUrl: string | null | undefined): string {
    if (!imageUrl) return 'jpg';
    let filePath = getStoredMediaLocation(imageUrl)?.filePath ?? '';
    if (!filePath) {
        try {
            const url = new URL(imageUrl, 'https://magicbooklet.invalid');
            filePath = url.searchParams.get('path') ?? url.pathname;
        } catch {
            filePath = '';
        }
    }
    const extension = filePath.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
    if (!IMAGE_FILE_EXTENSIONS.has(extension)) return 'jpg';
    return extension === 'jpeg' ? 'jpg' : extension;
}

/** The creation's title and recipe prefill as Studio reads them, for the quick-publish modal. */
async function fetchCreationPublishDetails(generationId: string): Promise<CreationPublishDetails | null> {
    const accessToken = await readAccessToken();
    if (!accessToken) return null;
    const params = new URLSearchParams({ id: generationId, includeArchived: 'true', limit: '1' });
    const response = await fetch(`/api/generations?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const payload = await response.json() as { generations?: Array<Record<string, unknown> | null> };
    const generation = Array.isArray(payload.generations)
        ? payload.generations.find((item) => item?.id === generationId)
        : null;
    if (!generation) return null;
    const prefill = generation.paywallPrefill;
    return {
        title: typeof generation.title === 'string' ? generation.title : '',
        paywallPrefill: prefill && typeof prefill === 'object' && Array.isArray((prefill as { resourceKinds?: unknown }).resourceKinds)
            ? prefill as GenerationPaywallPrefill
            : null,
    };
}

export interface CreateImagePrefill {
    remixId?: string | null;
    remixPostId?: string | null;
    prompt?: string | null;
    model?: string | null;
    aspectRatio?: string | null;
}

const CATALOG_HANDLED_KEYS = ['aspectRatio', 'resolution', 'qualityMode', 'googleSearch'] as const;

export default function CreateImageClient({ prefill }: { prefill: CreateImagePrefill }) {
    const router = useRouter();
    const { credits: userCredits, isLoading: isLoadingUser, session, updateCredits } = useAuth();
    const userId = session?.user?.id ?? null;
    const [selectedModel, setSelectedModel] = useState<ModelId>('nano-banana-2');
    const [prompt, setPrompt] = useState('');

    // Mirrors the live prompt so the remix restore below can tell whether the
    // creator typed while /api/remix-source was still in flight.
    const promptRef = useRef(prompt);
    useEffect(() => {
        promptRef.current = prompt;
    }, [prompt]);
    const [elements, setElements] = useState<ImageElementDraft[]>([]);
    const [aspectRatio, setAspectRatio] = useState('auto');
    const [resolution, setResolution] = useState<ImageResolution>('1K');
    const [qualityMode, setQualityMode] = useState<ImageQualityMode>('standard');
    const [googleSearch, setGoogleSearch] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [generationTiming, setGenerationTiming] = useState<GenerationTiming | null>(null);
    const [outputImage, setOutputImage] = useState<string | null>(null);
    const [outputImages, setOutputImages] = useState<string[]>([]);
    const [latestGenerationId, setLatestGenerationId] = useState<string | null>(null);
    const [latestIsPublic, setLatestIsPublic] = useState(false);
    const [publishedMeta, setPublishedMeta] = useState<{ title: string; description: string } | null>(null);
    const [isPublishModalOpen, setIsPublishModalOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const isBackgroundProcessing = error === BACKGROUND_PROCESSING_ERROR;
    // Watches for a newer deploy only while nothing is in flight; a press then
    // reloads onto it instead of sending from the old page.
    const { newBuildAvailable } = useDeploymentRefresh(!isGenerating && !isBackgroundProcessing);
    // The prompt the run on screen was made from: later edits must not rename it.
    const [submittedPrompt, setSubmittedPrompt] = useState('');
    // A start sent and never answered, kept until "Check again" settles it.
    const [pendingStart, setPendingStart] = useState<PendingWebStart | null>(null);
    const [pendingStartNotice, setPendingStartNotice] = useState<string | null>(null);
    const [creditRefusal, setCreditRefusal] = useState<{ message: string; credits: number | null; cost: number | null } | null>(null);
    const [elementPickNotice, setElementPickNotice] = useState<string | null>(null);
    const [publishModalDefaults, setPublishModalDefaults] = useState<CreationPublishDetails>(EMPTY_PUBLISH_DETAILS);
    const [isPreparingPublish, setIsPreparingPublish] = useState(false);
    const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
    const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
    const modelCatalog = useWebGenerationModelCatalog({ kind: 'image', selectedIds: [selectedModel], pickerOpen: isModelDropdownOpen });
    const catalogDescriptor = modelCatalog.catalog?.models.find(item => item.id === selectedModel);
    const refetchModelCatalog = modelCatalog.refetch;
    const [modelSearchQuery, setModelSearchQuery] = useState('');
    const dropdownRef = useRef<HTMLDivElement>(null);
    const hasResolvedInitialCatalogModel = useRef(false);
    // The account whose saved media this page has read in.
    const restoredPersistedMediaForUserRef = useRef<string | null>(null);
    const activeGenerationRequestKeyRef = useRef<string | null>(null);
    const generationPollAbortControllerRef = useRef<AbortController | null>(null);
    const elementRefs = useRef<ImageElementDraft[]>([]);
    const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
    const [activeMentionQuery, setActiveMentionQuery] = useState<{
        query: string;
        replaceStart: number;
        replaceEnd: number;
    } | null>(null);

    // Remix State
    const remixId = prefill.remixId ?? null;
    const remixPostId = prefill.remixPostId ?? null;
    const prefillPrompt = prefill.prompt ?? null;
    const prefillModel = prefill.model ?? null;
    const prefillAspectRatio = prefill.aspectRatio ?? null;
    const [isRemixLoading, setIsRemixLoading] = useState(!!remixId);
    const [remixTitle, setRemixTitle] = useState<string | null>(null);
    const [remixImageUrl, setRemixImageUrl] = useState<string | null>(null);
    const [remixSourceBundle, setRemixSourceBundle] = useState<RemixSourceBundle | null>(null);
    const [remixRestoreWarning, setRemixRestoreWarning] = useState<string | null>(null);
    const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false);
    const [isResultPreviewOpen, setIsResultPreviewOpen] = useState(false);
    const [uploadPreview, setUploadPreview] = useState<UploadPreviewState | null>(null);
    const elementNames = useNameDrafts();
    const [resultPreviewImage, setResultPreviewImage] = useState<string | null>(null);
    const nowMs = useTicker(isGenerating) ?? undefined;
    // The text draft is read before the catalog settles the model, so a saved model
    // is not swapped for the catalog's default. A remix keeps no draft.
    const [isDraftRestoreSettled, setIsDraftRestoreSettled] = useState(Boolean(remixId));
    const restoredDraftModelRef = useRef(false);
    // Saved settings for a model whose controls have not loaded yet.
    const pendingDraftSettingsRef = useRef<{ modelId: string; values: Record<string, CatalogPrimitive> } | null>(null);
    const unsavedDraftRef = useRef<{ userId: string; draft: ImageCreatorDraft } | null>(null);
    const publishDetailsRef = useRef<{ generationId: string; request: Promise<CreationPublishDetails | null> } | null>(null);

    useEffect(() => () => {
        generationPollAbortControllerRef.current?.abort();
    }, []);


    useEffect(() => {
        if (remixId) return;
        // A route prefill intentionally seeds the editable form once it is available.
        if (prefillPrompt) setPrompt(prefillPrompt);
        if (prefillModel) setSelectedModel(prefillModel as ModelId);
        if (prefillAspectRatio) setAspectRatio(prefillAspectRatio);
    }, [prefillPrompt, prefillModel, prefillAspectRatio, remixId]);


    // Derived, not kept in `catalogNotice`: a retired model or a failed load shows only
    // while it still applies, so choosing another model or a successful reload clears
    // it. It takes the notice slot ahead of a one-off notice, which can be dismissed.
    const catalogProblem = modelCatalog.missingIds.includes(selectedModel)
        ? remixId
            ? 'This model is no longer available. Your prompt and references stay here; choose another model.'
            : 'This model is no longer available. Your draft is saved; choose another model.'
        : modelCatalog.error?.message || null;
    const modelNotice = catalogProblem ?? catalogNotice;
    const model = IMAGE_MODELS[selectedModel] ?? IMAGE_MODELS['nano-banana-2'];
    const imageModelOptions = modelCatalog.summaries.filter(item => item.kind === 'image').map(item => ({ ...(IMAGE_MODELS as unknown as Record<string, typeof IMAGE_MODELS[keyof typeof IMAGE_MODELS]>)[item.id], ...item, badge: item.badge ?? '' }));
    const normalizedModelSearchQuery = modelSearchQuery.trim().toLowerCase();
    const filteredImageModelOptions = normalizedModelSearchQuery
        ? imageModelOptions.filter((imageModel) => [
            imageModel.displayName,
            imageModel.description,
            imageModel.badge,
            imageModel.supportsGoogleSearch ? 'google search grounded grounding' : '',
            imageModel.maxImages > 0 ? `reference images ${imageModel.maxImages}` : 'prompt only',
        ].join(' ').toLowerCase().includes(normalizedModelSearchQuery))
        : imageModelOptions;

    useEffect(() => {
        if (!modelCatalog.catalog || (userId && !isDraftRestoreSettled)) return;
        const preferDefault = !hasResolvedInitialCatalogModel.current
            && !remixId
            && !prefillModel
            && !restoredDraftModelRef.current;
        const nextModelId = resolveCatalogModelId(modelCatalog.catalog, 'image', selectedModel, { preferDefault });
        if (!nextModelId) return;
        hasResolvedInitialCatalogModel.current = true;
        if (nextModelId && nextModelId !== selectedModel) {
            const nextModel = (IMAGE_MODELS as unknown as Record<string, typeof model>)[nextModelId];
            setSelectedModel(nextModelId as ModelId);
            if (!preferDefault) {
                setCatalogNotice(`Your previous image model is no longer available. Switched to ${nextModel?.displayName ?? nextModelId}.`);
            }
        }
    }, [isDraftRestoreSettled, modelCatalog.catalog, selectedModel, prefillModel, remixId, userId]);

    // A route's own prompt, model or frame wins over the saved one, and a model's
    // settings come back only with that model.
    useEffect(() => {
        if (remixId || !userId) return;
        let cancelled = false;
        const promptWhenRestoreStarted = promptRef.current;
        void loadCreatorDraft<Partial<ImageCreatorDraft>>('image', userId)
            .then((draft) => {
                if (cancelled || !draft) return;
                if (
                    !prefillPrompt
                    && typeof draft.prompt === 'string'
                    && !hasCreatorEditedPromptDuringRemix(promptRef.current, promptWhenRestoreStarted)
                ) {
                    setPrompt(draft.prompt);
                }
                const draftModelId = typeof draft.modelId === 'string'
                    && (IMAGE_MODELS as unknown as Record<string, unknown>)[draft.modelId]
                    ? draft.modelId as ModelId
                    : null;
                if (!draftModelId || (prefillModel && prefillModel !== draftModelId)) return;
                if (!prefillModel) {
                    restoredDraftModelRef.current = true;
                    setSelectedModel(draftModelId);
                }
                if (!prefillAspectRatio && typeof draft.aspectRatio === 'string') setAspectRatio(draft.aspectRatio);
                if (typeof draft.resolution === 'string') setResolution(draft.resolution as ImageResolution);
                if (typeof draft.qualityMode === 'string') setQualityMode(draft.qualityMode as ImageQualityMode);
                if (typeof draft.googleSearch === 'boolean') setGoogleSearch(draft.googleSearch);
                const additionalDraftSettings = readDraftSettings(draft.additionalSettings);
                if (additionalDraftSettings) {
                    pendingDraftSettingsRef.current = { modelId: draftModelId, values: additionalDraftSettings };
                }
            })
            .catch(() => {
                // An unreadable draft leaves the form as it opened.
            })
            .finally(() => {
                if (!cancelled) setIsDraftRestoreSettled(true);
            });
        return () => {
            cancelled = true;
        };
    }, [prefillAspectRatio, prefillModel, prefillPrompt, remixId, userId]);

    useEffect(() => {
        // What the creators saved before media was kept per account belonged to no one in particular.
        void purgeLegacyPersistedMedia().catch(() => undefined);
    }, []);

    const persistUploadedImageElements = useCallback(async (nextElements: ImageElementDraft[]) => {
        if (remixId || !userId) {
            return;
        }

        const persistableElements = nextElements
            .filter((element) => element.file && element.source === 'upload')
            .map((element) => ({
                id: element.id,
                displayName: element.displayName,
                handle: element.handle,
                file: element.file as File,
            }));

        await setPersistedImageElementRecords(
            scopedPersistedMediaKey(PERSISTED_MEDIA_KEYS.createImageElements, userId),
            persistableElements
        );
    }, [remixId, userId]);

    const commitElements = useCallback((nextElements: ImageElementDraft[]) => {
        elementRefs.current = nextElements;
        setElements(nextElements);
    }, []);

    const updateMentionState = (nextPrompt: string, caretIndex?: number) => {
        const fallbackCaret = typeof caretIndex === 'number'
            ? caretIndex
            : (promptTextareaRef.current?.selectionStart ?? nextPrompt.length);
        setActiveMentionQuery(getMentionQueryAtCaret(nextPrompt, fallbackCaret));
    };

    // When model or aspect changes, clamp model-specific controls.
    useEffect(() => {
        if (!modelCatalog.detailsReady) return;

        const nextAspectRatio = (model.aspectRatios as readonly string[]).includes(aspectRatio)
            ? aspectRatio
            : catalogChoiceDefault(catalogDescriptor, 'aspectRatio', model.aspectRatios[0]);
        if (nextAspectRatio !== aspectRatio) {
            setAspectRatio(nextAspectRatio);
            setCatalogNotice('Model settings changed. Unsupported choices were reset; your prompt and references are preserved.');
        }

        const nextResolutionOptions = getImageResolutionOptions(selectedModel, nextAspectRatio);
        if (!nextResolutionOptions.includes(resolution)) {
            const preferred = catalogChoiceDefault(catalogDescriptor, 'resolution', nextResolutionOptions[0]) as ImageResolution;
            setResolution(nextResolutionOptions.includes(preferred) ? preferred : nextResolutionOptions[0]);
            setCatalogNotice('Model settings changed. Unsupported choices were reset; your prompt and references are preserved.');
        }
        if (!model.supportsGoogleSearch) {
            setGoogleSearch(false);
        }
        const qualityModes = getImageQualityModes(selectedModel);
        if (qualityModes.length > 0 && !qualityModes.includes(qualityMode)) {
            setQualityMode(catalogChoiceDefault(catalogDescriptor, 'qualityMode', qualityModes[0]) as ImageQualityMode);
        }
    }, [aspectRatio, catalogDescriptor, model, modelCatalog.detailsReady, qualityMode, resolution, selectedModel]);

    // Close dropdown on click outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setIsModelDropdownOpen(false);
                setModelSearchQuery('');
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Handle Remix Pre-fill
    useEffect(() => {
        if (!remixId) return;
        if (!session?.access_token) return;

        let isCancelled = false;
        const promptWhenRemixStarted = promptRef.current;

        const fetchRemixData = async () => {
            try {
                const remixSourceParams = new URLSearchParams({ id: remixId });
                if (remixPostId) {
                    remixSourceParams.set('postId', remixPostId);
                }

                const response = await fetch(`/api/remix-source?${remixSourceParams.toString()}`, {
                    headers: {
                        Authorization: `Bearer ${session.access_token}`,
                    },
                });
                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.error || 'Failed to load remix data');
                }

                const bundle = data as RemixSourceBundle;
                if (isCancelled) {
                    return;
                }

                setRemixSourceBundle(bundle);
                setRemixTitle(bundle.generation.title);
                if (!hasCreatorEditedPromptDuringRemix(promptRef.current, promptWhenRemixStarted)) {
                    setPrompt(bundle.generation.prompt);
                }
                setRemixImageUrl(bundle.result?.mediaType === 'image' ? bundle.result.url : null);
                setRemixRestoreWarning(getRemixRestoreWarning(bundle.restoreIssues));

                const settings = bundle.workflowSettings as ImageWorkflowSettings | null;
                const nextModelId =
                    settings?.model && IMAGE_MODELS[settings.model] ? settings.model : 'nano-banana-2';

                if (settings?.model && IMAGE_MODELS[settings.model]) {
                    setSelectedModel(settings.model);
                }
                if (settings?.aspectRatio) setAspectRatio(settings.aspectRatio);
                if (
                    settings?.resolution &&
                    getImageResolutionOptions(nextModelId, settings.aspectRatio).includes(settings.resolution as ImageResolution)
                ) {
                    setResolution(settings.resolution as ImageResolution);
                }
                if (settings?.qualityMode && getImageQualityModes(nextModelId).includes(settings.qualityMode)) {
                    setQualityMode(settings.qualityMode);
                }
                if (settings?.googleSearch !== undefined) setGoogleSearch(settings.googleSearch);

                const restoredSeeds = createRemixElementSeeds(
                    bundle.inputs.image?.elements ?? [],
                    IMAGE_MODELS[nextModelId].maxImages
                );

                if (restoredSeeds.length > 0) {
                    commitElements(hydrateImageElements(restoredSeeds));
                }
            } catch (err) {
                console.error('Error fetching remix:', err);
                if (!isCancelled) {
                    setRemixRestoreWarning(
                        'Some source media could not be restored automatically, so you may need to re-add a few references.'
                    );
                }
            } finally {
                if (!isCancelled) {
                    setIsRemixLoading(false);
                }
            }
        };

        void fetchRemixData();

        return () => {
            isCancelled = true;
        };
    }, [commitElements, remixId, remixPostId, session?.access_token]);

    useEffect(() => {
        elementRefs.current = elements;
    }, [elements]);

    useEffect(() => {
        return () => {
            elementRefs.current.forEach((element) => {
                revokePreviewUrl(element.previewUrl);
            });
        };
    }, []);

    const loadPersistedElements = useCallback(async () => {
        if (remixId || !userId) {
            return;
        }

        try {
            const savedElementRecords = await getPersistedImageElementRecords(
                scopedPersistedMediaKey(PERSISTED_MEDIA_KEYS.createImageElements, userId)
            );
            if (savedElementRecords.length === 0) return;

            commitElements(hydrateImageElements(
                savedElementRecords.map((element) => ({
                    id: element.id,
                    displayName: element.displayName,
                    handle: element.handle,
                    file: element.file,
                    previewUrl: URL.createObjectURL(element.file),
                    source: 'upload',
                }))
            ));
        } catch (err) {
            console.error('Error loading persisted image elements:', err);
        }
    }, [commitElements, remixId, userId]);

    useEffect(() => {
        if (!userId || restoredPersistedMediaForUserRef.current === userId) return;
        restoredPersistedMediaForUserRef.current = userId;

        void loadPersistedElements();
    }, [loadPersistedElements, userId]);

    useEffect(() => {
        if (remixId) return;

        const restoreWhenReturning = () => {
            if (document.visibilityState === 'visible' && elementRefs.current.length === 0) {
                void loadPersistedElements();
            }
        };

        window.addEventListener('focus', restoreWhenReturning);
        document.addEventListener('visibilitychange', restoreWhenReturning);

        return () => {
            window.removeEventListener('focus', restoreWhenReturning);
            document.removeEventListener('visibilitychange', restoreWhenReturning);
        };
    }, [loadPersistedElements, remixId]);

    // Leaving writes with the callback of the last render, so a sign-out that has
    // just cleared this account's media does not get it written back.
    const persistElementsOnLeaveRef = useRef(persistUploadedImageElements);
    useEffect(() => {
        persistElementsOnLeaveRef.current = persistUploadedImageElements;
    }, [persistUploadedImageElements]);
    useEffect(() => () => {
        if (elementRefs.current.length > 0) {
            void persistElementsOnLeaveRef.current(elementRefs.current);
        }
    }, []);

    const processImageFiles = async (files: FileList | File[]) => {
        const pickedFiles = Array.from(files);
        if (pickedFiles.length === 0) return;

        // The sign step's own limits, checked as a file is added: a refused file
        // used to wait in the rail and fail every Generate without its name.
        const refusals: string[] = [];
        const maxImageMegabytes = Math.round(TEMPORARY_MEDIA_UPLOAD_LIMITS.maxBytesByKind.image / (1024 * 1024));
        const validFiles = pickedFiles.filter((file) => {
            const fileName = file.name || 'This file';
            if (!TEMPORARY_MEDIA_UPLOAD_LIMITS.isAllowedMimeType('image', file.type)) {
                refusals.push(`“${fileName}” isn’t a JPEG, PNG, WebP, GIF, AVIF or HEIC image.`);
                return false;
            }
            if (file.size > TEMPORARY_MEDIA_UPLOAD_LIMITS.maxBytesByKind.image) {
                refusals.push(`“${fileName}” is larger than ${maxImageMegabytes} MB.`);
                return false;
            }
            return true;
        });

        const currentElements = elementRefs.current;
        const availableSlots = Math.max(0, model.maxImages - currentElements.length);
        const filesToAdd = validFiles.slice(0, availableSlots);
        if (filesToAdd.length < validFiles.length) {
            refusals.push(filesToAdd.length > 0
                ? `Added ${filesToAdd.length} of ${validFiles.length} images to stay within this model’s ${model.maxImages}-image limit.`
                : `This model takes up to ${model.maxImages} image${model.maxImages === 1 ? '' : 's'}. Remove one to add another.`);
        }
        setElementPickNotice(refusals.length > 0 ? refusals.join(' ') : null);

        if (filesToAdd.length === 0) {
            return;
        }

        const newElements = hydrateImageElements(filesToAdd.map((file, index) => ({
            displayName: `Element ${currentElements.length + index + 1}`,
            file,
            previewUrl: URL.createObjectURL(file),
            source: 'upload',
        })));

        const nextElements = hydrateImageElements([...currentElements, ...newElements]);
        commitElements(nextElements);
        await persistUploadedImageElements(nextElements);
    };

    const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files?.length) {
            await processImageFiles(e.target.files);
            e.target.value = '';
        }
    };

    const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
    const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };
    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault(); setIsDragging(false);
        if (e.dataTransfer.files?.length) await processImageFiles(e.dataTransfer.files);
    };

    const handleRemoveElement = async (elementId: string) => {
        const currentElements = elementRefs.current;
        const removedElement = currentElements.find((element) => element.id === elementId);
        if (removedElement) {
            revokePreviewUrl(removedElement.previewUrl);
        }

        const nextElements = hydrateImageElements(
            currentElements.filter((element) => element.id !== elementId)
        );
        elementNames.dropDraft(elementId);
        setElementPickNotice(null);
        commitElements(nextElements);
        await persistUploadedImageElements(nextElements);
    };

    const handleElementRename = async (elementId: string, nextDisplayName: string) => {
        const currentElements = elementRefs.current;
        const nextElements = hydrateImageElements(
            currentElements.map((element) => (
                element.id === elementId
                    // Without its handle, the element takes the handle of its new name.
                    ? { ...element, displayName: nextDisplayName, handle: null }
                    : element
            ))
        );
        const replacements = createElementHandleReplacementMap(currentElements, nextElements);

        commitElements(nextElements);
        await persistUploadedImageElements(nextElements);
        if (replacements.size > 0) {
            setPrompt((currentPrompt) => {
                const nextPrompt = replacePromptHandles(currentPrompt, replacements);
                requestAnimationFrame(() => updateMentionState(nextPrompt));
                return nextPrompt;
            });
            return;
        }

        requestAnimationFrame(() => updateMentionState(prompt));
    };

    const handleElementDraftChange = (elementId: string, nextValue: string) => {
        elementNames.setDraft(elementId, nextValue);
    };

    const commitElementDraft = async (elementId: string) => {
        const draftValue = elementNames.takeDraft(elementId);
        if (draftValue === undefined) {
            return;
        }

        const trimmed = draftValue.trim();
        if (!trimmed) {
            return;
        }

        const currentElement = elementRefs.current.find((element) => element.id === elementId);
        if (!currentElement || currentElement.displayName === trimmed) {
            return;
        }

        await handleElementRename(elementId, trimmed);
    };

    const handlePromptChange = (value: string, caretIndex?: number) => {
        setPrompt(value);
        updateMentionState(value, caretIndex);
    };

    const handleInsertElementHandle = (handle: string) => {
        const textarea = promptTextareaRef.current;
        const selectionStart = textarea?.selectionStart ?? prompt.length;
        const selectionEnd = textarea?.selectionEnd ?? prompt.length;
        const nextValue = insertHandleIntoPrompt(
            prompt,
            handle,
            selectionStart,
            selectionEnd,
            activeMentionQuery
        );

        setPrompt(nextValue.prompt);
        setActiveMentionQuery(null);

        requestAnimationFrame(() => {
            textarea?.focus();
            textarea?.setSelectionRange(nextValue.caretIndex, nextValue.caretIndex);
        });
    };

    const syncPromptCaretState = () => {
        updateMentionState(prompt);
    };

    const handleUseOriginalResultAsReference = () => {
        if (!remixSourceBundle) {
            return;
        }

        if (elementRefs.current.length >= model.maxImages) {
            setError(`This model supports up to ${model.maxImages} reference image${model.maxImages === 1 ? '' : 's'}.`);
            return;
        }

        const nextElement = createRemixResultReferenceElement(remixSourceBundle);
        if (!nextElement) {
            return;
        }

        const resultLabel = getRemixResultReferenceLabel(remixSourceBundle.generation.title);
        const alreadyAdded = elementRefs.current.some(
            (element) =>
                element.displayName === resultLabel &&
                element.sourceGenerationId === remixSourceBundle.generation.id
        );

        if (alreadyAdded) {
            return;
        }

        const nextElements = hydrateImageElements([...elementRefs.current, nextElement]);
        commitElements(nextElements);
        void persistUploadedImageElements(nextElements);
    };

    const handoffToBackgroundProcessing = (startedAtMs: number) => {
        setError(BACKGROUND_PROCESSING_ERROR);
        setGenerationTiming((current) => freezeGenerationTiming(
            current ?? createLocalGenerationTiming({
                kind: 'image',
                phaseLabel: 'Generating image',
                startedAtMs,
                estimatedTotalMs: estimateGenerationDurationMs({
                    kind: 'image',
                    model: selectedModel,
                    resolution,
                    referenceCount: elements.length,
                }),
            }),
            Date.now()
        ));
    };

    const pollPrediction = async (
        predictionId: string,
        startedAtMs: number,
        estimatedTotalMs: number | null
    ): Promise<{ output: string; outputs: string[]; timing: GenerationTiming | null }> => {
        const pollController = new AbortController();
        generationPollAbortControllerRef.current?.abort();
        generationPollAbortControllerRef.current = pollController;
        const pollingStartedAt = Date.now();

        try {
            while (Date.now() - pollingStartedAt < 5 * 60 * 1000) {
                let data: GenerationStatusResponse;
                try {
                    // The token is read for every check: a run can outlive the one it started with.
                    data = await fetchGenerationStatusWithRetry({
                        url: `/api/generate-image?id=${predictionId}`,
                        getAccessToken: readAccessToken,
                        signal: pollController.signal,
                    });
                } catch (statusError) {
                    if (isGenerationStatusAbortError(statusError)) throw statusError;
                    // Checks that keep failing say nothing about the run, which goes on with
                    // the credits it took: Studio follows it from here.
                    throw new Error(BACKGROUND_PROCESSING_ERROR);
                }

                if (data.timing) {
                    setGenerationTiming(data.timing.estimatedTotalMs ? data.timing : {
                        ...data.timing,
                        estimatedTotalMs,
                    });
                } else {
                    setGenerationTiming((current) => current ?? createLocalGenerationTiming({
                        kind: 'image',
                        phaseLabel: 'Waiting for provider',
                        startedAtMs,
                        estimatedTotalMs,
                    }));
                }

                if (data.status === 'succeeded') {
                    const outputs = Array.isArray(data.outputs) && data.outputs.length > 0
                        ? data.outputs.filter((url): url is string => typeof url === 'string' && url.length > 0)
                        : (data.output ? [data.output] : []);

                    return {
                        output: data.output || outputs[0] || '',
                        outputs,
                        timing: data.timing ?? null,
                    };
                }

                if (data.status === 'failed') {
                    throw new ImageRunFailedError(data.error || 'Image generation failed');
                }

                await waitForNextGenerationStatusPoll(data.retryAfterMs, {
                    signal: pollController.signal,
                });
            }
        } finally {
            if (generationPollAbortControllerRef.current === pollController) {
                generationPollAbortControllerRef.current = null;
            }
        }

        throw new Error(BACKGROUND_PROCESSING_ERROR);
    };

    const additionalSettings = useAdditionalCatalogSettings(catalogDescriptor, CATALOG_HANDLED_KEYS);
    // One settings object for the price and the run. The start used to send a fixed
    // list with JPG written in, so an output format that was chosen and quoted was dropped.
    const generationSettings = useMemo(() => ({
        aspectRatio,
        resolution,
        qualityMode,
        googleSearch: model.supportsGoogleSearch ? googleSearch : false,
        ...additionalSettings.settings,
    }), [additionalSettings.settings, aspectRatio, googleSearch, model.supportsGoogleSearch, qualityMode, resolution]);
    const quoteRequest = useMemo(() => modelCatalog.catalog && modelCatalog.detailsReady ? {
        kind: 'image' as const,
        modelId: selectedModel,
        settings: generationSettings,
        inputCounts: { images: elements.length, videos: 0, audios: 0 },
        catalogRevision: modelCatalog.catalog.revision,
    } : null, [elements.length, generationSettings, modelCatalog.catalog, modelCatalog.detailsReady, selectedModel]);

    const applyRestoredAdditionalSetting = additionalSettings.onChange;
    useEffect(() => {
        const pending = pendingDraftSettingsRef.current;
        if (!pending || catalogDescriptor?.id !== pending.modelId) return;
        pendingDraftSettingsRef.current = null;
        for (const [key, value] of Object.entries(pending.values)) {
            applyRestoredAdditionalSetting(key, value);
        }
    }, [applyRestoredAdditionalSetting, catalogDescriptor]);

    const imageCreatorDraft = useMemo<ImageCreatorDraft>(() => ({
        prompt,
        modelId: selectedModel,
        aspectRatio,
        resolution,
        qualityMode,
        googleSearch,
        additionalSettings: additionalSettings.settings,
    }), [additionalSettings.settings, aspectRatio, googleSearch, prompt, qualityMode, resolution, selectedModel]);
    const getDraftToSave = useCallback((): ImageCreatorDraft => {
        const pending = pendingDraftSettingsRef.current;
        return pending && pending.modelId === imageCreatorDraft.modelId
            ? { ...imageCreatorDraft, additionalSettings: pending.values }
            : imageCreatorDraft;
    }, [imageCreatorDraft]);
    useEffect(() => {
        if (remixId || !userId || !isDraftRestoreSettled) {
            unsavedDraftRef.current = null;
            return;
        }
        const entry = { userId, draft: getDraftToSave() };
        unsavedDraftRef.current = entry;
        const timer = window.setTimeout(() => {
            if (unsavedDraftRef.current === entry) unsavedDraftRef.current = null;
            void saveCreatorDraft('image', entry.userId, entry.draft).catch(() => undefined);
        }, CREATOR_DRAFT_SAVE_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [getDraftToSave, isDraftRestoreSettled, remixId, userId]);
    useEffect(() => () => {
        // Leaving inside the wait, through the Top Up link say, still keeps the last edit.
        const entry = unsavedDraftRef.current;
        if (entry) void saveCreatorDraft('image', entry.userId, entry.draft).catch(() => undefined);
    }, []);
    const saveDraftNow = async () => {
        if (remixId || !userId) return;
        unsavedDraftRef.current = null;
        await Promise.allSettled([
            isDraftRestoreSettled ? saveCreatorDraft('image', userId, getDraftToSave()) : Promise.resolve(),
            persistUploadedImageElements(elementRefs.current),
        ]);
    };
    const [quoteAttempt, setQuoteAttempt] = useState(0);
    const quoteState = useWebGenerationModelQuote(quoteRequest, session?.access_token, quoteAttempt);
    useEffect(() => {
        if (quoteState.error?.code !== 'CATALOG_CHANGED' && quoteState.error?.code !== 'MODEL_UNAVAILABLE') return;
        // The quote response is the external signal that the local catalog is stale.
        setCatalogNotice('Model settings changed. Review the refreshed options before generating.');
        refetchModelCatalog();
    }, [refetchModelCatalog, quoteState.error?.code]);
    const quoteUi = resolveWebGenerationQuoteUi({
        hasCatalog: Boolean(modelCatalog.catalog && modelCatalog.detailsReady),
        catalogLoading: !modelCatalog.detailsReady && !modelCatalog.error && !modelCatalog.missingIds.includes(selectedModel),
        quoteStatus: quoteState.status,
        quotedCost: quoteState.quote?.costCredits,
        quoteErrorMessage: quoteState.error?.message,
    });
    const currentCost = quoteUi.costCredits;
    const availableResolutions = getImageResolutionOptions(selectedModel, aspectRatio);
    // Descriptor-derived where the catalog is available: a resolution control offering a
    // single value is a fixed setting, not a choice worth rendering. Falls back to the
    // per-model list before the catalog loads.
    const imageAffordances = getImageInputAffordances(
        (model as { catalogDescriptor?: GenerationModelDescriptor }).catalogDescriptor,
    );
    const showResolutionControl = imageAffordances?.showResolutionControl
        ?? supportsImageResolutionControl(selectedModel);
    const isGrokImageModel = selectedModel === 'grok-imagine-image';
    const qualityModes = getImageQualityModes(selectedModel);
    const insufficientCredits = userCredits !== null && currentCost !== null && userCredits < currentCost;
    // The server's own refusal, shown until the balance or the price on screen moves:
    // the balance read again then speaks for itself.
    const creditRefusalMessage = creditRefusal
        && creditRefusal.credits === userCredits
        && creditRefusal.cost === currentCost
        ? creditRefusal.message
        : null;
    const showTopUp = insufficientCredits || Boolean(creditRefusalMessage);
    const quotePending = quoteUi.blocksGenerate;
    // Only what the request carries can be mentioned. A model that takes fewer
    // pictures (none, when it is prompt-only) leaves the rest on the grid unsent,
    // and the server refuses a mention of a picture it was not sent.
    const sentElements = elements.slice(0, Math.max(0, model.maxImages));
    const sentElementHandles = sentElements.map((element) => element.handle);
    const referencedElementHandles = extractPromptHandles(prompt).filter((handle) => sentElementHandles.includes(handle));
    const isElementEnhancementLocked = referencedElementHandles.length > 0;
    const staleElementMentions = findUnknownPromptHandles(prompt, sentElementHandles);
    // Derived, not kept in `error`: it clears the moment the references fit the model
    // again, instead of lingering until the next generation.
    const referenceLimitMessage = modelCatalog.detailsReady && elements.length > model.maxImages
        ? model.maxImages > 0
            ? `This model now supports ${model.maxImages} reference image${model.maxImages === 1 ? '' : 's'}. Your references are preserved; remove extras or choose another model.`
            : `${model.displayName} does not take reference images. Your references are preserved; remove them or choose another model.`
        : null;
    const mentionSuggestions = activeMentionQuery
        ? sentElements.filter((element) => {
            const normalizedQuery = activeMentionQuery.query.toLowerCase();
            if (!normalizedQuery) return true;

            return (
                element.handle.toLowerCase().includes(`@${normalizedQuery}`) ||
                element.displayName.toLowerCase().includes(normalizedQuery)
            );
        })
        : [];

    const forgetPendingStart = () => {
        clearPendingWebStart('image');
        setPendingStart(null);
        setPendingStartNotice(null);
    };

    const loadPublishDetails = (generationId: string): Promise<CreationPublishDetails | null> => {
        const cached = publishDetailsRef.current;
        if (cached?.generationId === generationId) return cached.request;
        const request = fetchCreationPublishDetails(generationId).catch(() => null);
        publishDetailsRef.current = { generationId, request };
        void request.then((details) => {
            // A failed read is tried again at the next open.
            if (!details && publishDetailsRef.current?.request === request) publishDetailsRef.current = null;
        });
        return request;
    };

    const handleStartRefusal = (refusal: unknown) => {
        if (refusal instanceof WebCatalogRequestError && refusal.status === 401) {
            // The session lapsed after the press: back through sign-in, with the draft kept.
            void saveDraftNow().then(() => router.push(getLoginPathForThisPage()));
            return;
        }
        const message = refusal instanceof Error && refusal.message ? refusal.message : 'Failed to start generation';
        const code = refusal instanceof WebCatalogRequestError ? refusal.code : undefined;
        if (code === 'CATALOG_CHANGED' || code === 'MODEL_UNAVAILABLE') {
            setCatalogNotice('Model settings changed. Review the refreshed options before generating.');
            refetchModelCatalog();
        }
        if (code === 'insufficient_credits') {
            // The balance on screen was out of date: read it again, and offer the top-up.
            window.dispatchEvent(new Event('credits_updated'));
            setCreditRefusal({ message, credits: userCredits, cost: currentCost });
            return;
        }
        if (code === 'invalid_input_media') {
            // A staged copy the server could not use goes up again from its file next time.
            commitElements(elementRefs.current.map((element) => (element.staged ? { ...element, staged: null } : element)));
        }
        setError(message);
        if (code === 'prompt_blocked' || code === 'INVALID_GENERATION_REQUEST') {
            promptTextareaRef.current?.focus();
        }
    };

    const followRun = async (
        predictionId: string,
        run: { startedAtMs: number; estimatedTotalMs: number | null; cost: number | null; generationId: string | null },
    ) => {
        try {
            const result = await pollPrediction(predictionId, run.startedAtMs, run.estimatedTotalMs);
            setOutputImage(result.output);
            setOutputImages(result.outputs);
            if (result.timing) {
                setGenerationTiming(result.timing);
            }
            if (run.generationId) void loadPublishDetails(run.generationId);
        } catch (err) {
            if (isGenerationStatusAbortError(err)) return;
            if (err instanceof Error && err.message === BACKGROUND_PROCESSING_ERROR) {
                handoffToBackgroundProcessing(run.startedAtMs);
                return;
            }
            if (err instanceof ImageRunFailedError) {
                // The failure returned the credits; the balance on screen still has them spent.
                window.dispatchEvent(new Event('credits_updated'));
                setError(withCreditsReturned(err.message, run.cost));
            } else {
                setError(err instanceof Error ? err.message : 'Something went wrong');
            }
            setGenerationTiming(null);
        }
    };

    /**
     * Sends a kept start, the first time or again under its own key. An answer
     * that leaves it open keeps the key, so "Check again" finds the run it started
     * or starts it once; a refusal or a started run settles it.
     */
    const runStart = async (start: PendingWebStart, timing: { startedAtMs: number; estimatedTotalMs: number | null }) => {
        let started: WebGenerationStartResponse;
        try {
            started = await requestWebGenerationStart(start.body as CatalogGenerationRequestPayload, {
                accessToken: await readAccessToken(),
                idempotencyKey: start.idempotencyKey,
            });
        } catch (startError) {
            setGenerationTiming(null);
            if (isAmbiguousWebStartFailure(startError)) {
                setPendingStart(start);
                // A held submission's own words say what happens to its credits.
                setPendingStartNotice(startError instanceof WebCatalogRequestError && startError.code === 'submission_pending'
                    ? startError.message
                    : START_UNCONFIRMED_MESSAGE);
                return;
            }
            forgetPendingStart();
            handleStartRefusal(startError);
            return;
        }
        forgetPendingStart();
        setLatestGenerationId(started.generationId ?? null);
        setLatestIsPublic(false);
        announceGenerationStarted();
        updateCredits(started.remainingCredits);
        await followRun(started.predictionId, {
            ...timing,
            cost: started.cost,
            generationId: started.generationId ?? null,
        });
    };

    const replayPendingStart = async (start: PendingWebStart) => {
        if (activeGenerationRequestKeyRef.current) return;
        activeGenerationRequestKeyRef.current = start.idempotencyKey;
        const createdAtMs = Date.parse(start.createdAt);
        const startedAtMs = Number.isNaN(createdAtMs) ? Date.now() : createdAtMs;
        setIsGenerating(true);
        setError(null);
        setCreditRefusal(null);
        setSubmittedPrompt(typeof start.body.prompt === 'string' ? start.body.prompt : '');
        setGenerationTiming(createLocalGenerationTiming({
            kind: 'image',
            phaseLabel: 'Checking your last run',
            startedAtMs,
            estimatedTotalMs: null,
        }));
        try {
            await runStart(start, { startedAtMs, estimatedTotalMs: null });
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Something went wrong');
            setGenerationTiming(null);
        } finally {
            activeGenerationRequestKeyRef.current = null;
            setIsGenerating(false);
        }
    };

    useEffect(() => {
        const resumePendingGeneration = async () => {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) return;

            // A start this tab sent and never heard back about goes first: sending it
            // again finds the run it started, or starts it once.
            const pendingWebStart = loadPendingWebStart('image', session.user.id);
            if (pendingWebStart) {
                await replayPendingStart(pendingWebStart);
                return;
            }

            const { data, error: pendingError } = await supabase
                .from('generations')
                .select('id, prediction_id, status, created_at, prompt, cost')
                .eq('user_id', session.user.id)
                .eq('category', 'image')
                .in('status', ['processing', 'waiting'])
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (pendingError || !data?.prediction_id) {
                return;
            }

            const startedAtMs = Number.isNaN(Date.parse(data.created_at)) ? Date.now() : Date.parse(data.created_at);

            setIsGenerating(true);
            setError(null);
            setLatestGenerationId(data.id ?? null);
            setLatestIsPublic(false);
            setSubmittedPrompt(typeof data.prompt === 'string' ? data.prompt : '');
            setGenerationTiming(createLocalGenerationTiming({
                kind: 'image',
                phaseLabel: 'Resuming active run',
                startedAtMs,
                appStatus: data.status === 'waiting' ? 'waiting' : 'processing',
            }));

            try {
                await followRun(data.prediction_id, {
                    startedAtMs,
                    estimatedTotalMs: null,
                    cost: typeof data.cost === 'number' ? data.cost : null,
                    generationId: data.id ?? null,
                });
            } finally {
                setIsGenerating(false);
            }
        };

        void resumePendingGeneration();
        // Recovery is intentionally a mount-only lookup; changing form settings must not restart it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const stageReferenceInputs = async (
        requestElements: ImageElementDraft[],
        startedAtMs: number,
        estimatedTotalMs: number | null,
    ): Promise<NonNullable<CatalogGenerationRequestPayload['inputs']>> => {
        if (requestElements.length === 0) return [];
        const uploadCount = requestElements.filter((element) => (
            element.file && !(element.staged && Date.now() - element.staged.uploadedAt < STAGED_UPLOAD_REUSE_MS)
        )).length;
        if (uploadCount > 0) {
            setGenerationTiming(createLocalGenerationTiming({
                kind: 'image',
                phaseLabel: uploadCount === 1 ? 'Uploading 1 reference' : `Uploading ${uploadCount} references`,
                startedAtMs,
                estimatedTotalMs,
            }));
        }

        const results = await Promise.allSettled(requestElements.map(async (element) => {
            if (element.file) {
                const staged = await stageElementFile(element.file, element.staged);
                return {
                    element,
                    staged,
                    url: staged.signedUrl,
                    storagePath: staged.storagePath as string | null,
                    sourceGenerationId: null as string | null,
                };
            }

            if (!element.providerUrl) {
                throw new Error(`Missing media for ${element.displayName}`);
            }

            return {
                element,
                staged: null,
                url: element.providerUrl,
                storagePath: element.storagePath ?? null,
                sourceGenerationId: element.sourceGenerationId ?? null,
            };
        }));

        // Every file that went up stays on its element, so the next press sends the
        // staged copy instead of uploading it again, even when another file failed.
        const stagedById = new Map<string, StagedElementUpload>();
        results.forEach((result) => {
            if (result.status === 'fulfilled' && result.value.staged) {
                stagedById.set(result.value.element.id, result.value.staged);
            }
        });
        if (stagedById.size > 0) {
            commitElements(elementRefs.current.map((element) => {
                const staged = stagedById.get(element.id);
                return staged ? { ...element, staged } : element;
            }));
        }

        const prepared = results.map((result) => {
            if (result.status === 'rejected') throw result.reason;
            return result.value;
        });
        return prepared.map(({ element, url, storagePath, sourceGenerationId }, index) => ({
            slot: 'imageReferences',
            kind: 'image' as const,
            url,
            label: element.displayName ?? `Reference ${index + 1}`,
            handle: element.handle ?? null,
            storagePath,
            sourceGenerationId,
        }));
    };

    const handleGenerate = async () => {
        if (activeGenerationRequestKeyRef.current) return;
        const submitted = prompt.trim();
        if (!submitted) { setError('Please enter a prompt'); return; }
        if (staleElementMentions.length > 0) {
            setError(`Unknown element mention${staleElementMentions.length > 1 ? 's' : ''}: ${staleElementMentions.join(', ')}`);
            return;
        }
        if (referenceLimitMessage) return;
        if (newBuildAvailable && !remixId) {
            // A page older than the server may send what it no longer takes. The draft
            // is saved and comes back after the reload; a remix keeps no draft, so it
            // sends from this page instead.
            await saveDraftNow();
            window.location.reload();
            return;
        }

        const idempotencyKey = createGenerationIdempotencyKey('image');
        activeGenerationRequestKeyRef.current = idempotencyKey;
        setIsGenerating(true);
        setError(null);
        setCreditRefusal(null);
        setOutputImage(null);
        setOutputImages([]);
        setResultPreviewImage(null);
        setIsResultPreviewOpen(false);
        setLatestGenerationId(null);
        setLatestIsPublic(false);
        setPublishedMeta(null);
        setSubmittedPrompt(submitted);
        const startedAtMs = getCurrentTimestampMs();
        const estimatedTotalMs = estimateGenerationDurationMs({
            kind: 'image',
            model: selectedModel,
            resolution,
            referenceCount: sentElements.length,
        });
        setGenerationTiming(createLocalGenerationTiming({
            kind: 'image',
            phaseLabel: 'Preparing inputs',
            startedAtMs,
            estimatedTotalMs,
        }));

        try {
            // Before any upload, which would fail first and hide the way back.
            const { data: { session: currentSession } } = await supabase.auth.getSession();
            if (!currentSession) {
                await saveDraftNow();
                setGenerationTiming(null);
                router.push(getLoginPathForThisPage());
                return;
            }

            const inputs = await stageReferenceInputs(sentElements, startedAtMs, estimatedTotalMs);

            setGenerationTiming(createLocalGenerationTiming({
                kind: 'image',
                phaseLabel: 'Submitting image run',
                startedAtMs,
                estimatedTotalMs,
            }));

            const body: CatalogGenerationRequestPayload = {
                kind: 'image',
                modelId: selectedModel,
                prompt: submitted,
                settings: generationSettings,
                inputs,
                sourceGenerationId: remixId || undefined,
                catalogRevision: modelCatalog.catalog?.revision ?? '',
            };
            const start: PendingWebStart = {
                version: 1,
                tool: 'image',
                idempotencyKey,
                body,
                catalogRevision: body.catalogRevision,
                createdAt: new Date().toISOString(),
                userId: currentSession.user.id,
            };
            // Kept before it is sent: an answer that never arrives is replayed under this key.
            savePendingWebStart(start);
            await runStart(start, { startedAtMs, estimatedTotalMs });
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Something went wrong');
            setGenerationTiming(null);
        } finally {
            activeGenerationRequestKeyRef.current = null;
            setIsGenerating(false);
        }
    };

    const handleStartNewRun = () => {
        // The creator's own choice, priced on the button: the last start may still be running.
        forgetPendingStart();
        void handleGenerate();
    };

    const handleOpenPublish = async () => {
        if (!latestGenerationId || isPreparingPublish) return;
        setIsPreparingPublish(true);
        const details = await Promise.race([
            loadPublishDetails(latestGenerationId),
            new Promise<null>((resolve) => {
                window.setTimeout(() => resolve(null), PUBLISH_DETAILS_WAIT_MS);
            }),
        ]);
        setPublishModalDefaults(details ?? EMPTY_PUBLISH_DETAILS);
        setIsPreparingPublish(false);
        setIsPublishModalOpen(true);
    };

    const accentStyles = {
        blue: {
            ring: 'focus:border-blue-500/50 focus:ring-blue-500/10',
            button: 'bg-blue-500/20 text-blue-300 border-blue-500/50 shadow-[0_0_12px_-3px_rgba(59,130,246,0.4)]',
            toggle: 'bg-blue-500',
            generate: 'from-blue-600 to-cyan-600 shadow-[0_0_30px_-8px_rgba(59,130,246,0.4)]',
            progress: 'from-blue-500 to-cyan-500',
        },
        amber: {
            ring: 'focus:border-amber-500/50 focus:ring-amber-500/10',
            button: 'bg-amber-500/20 text-amber-200 border-amber-500/50 shadow-[0_0_12px_-3px_rgba(245,158,11,0.4)]',
            toggle: 'bg-amber-500',
            generate: 'from-amber-500 to-orange-600 shadow-[0_0_30px_-8px_rgba(245,158,11,0.4)]',
            progress: 'from-amber-500 to-orange-500',
        },
    }[model.accentColor];
    const backgroundProcessingCopy = getBackgroundProcessingCopy('image');
    const backgroundTiming = generationTiming ? freezeGenerationTiming(generationTiming, nowMs) : null;
    const backgroundTimingLabel = backgroundTiming ? getGenerationTimingSummaryLabel(backgroundTiming, nowMs) : null;
    const remixResultReferenceLabel = remixSourceBundle
        ? getRemixResultReferenceLabel(remixSourceBundle.generation.title)
        : null;
    const canUseOriginalResultAsReference =
        remixSourceBundle?.result?.mediaType === 'image' && Boolean(remixSourceBundle.result.url);
    const hasOriginalResultReference = Boolean(
        remixResultReferenceLabel &&
        remixSourceBundle &&
        elements.some(
            (element) =>
                element.displayName === remixResultReferenceLabel &&
                element.sourceGenerationId === remixSourceBundle.generation.id
        )
    );
    const getOutputImageDownloadUrl = (imageUrl: string | null, index = 0) => {
        if (!imageUrl) {
            return null;
        }

        const location = getStoredMediaLocation(imageUrl);
        if (!location) {
            return imageUrl;
        }

        const extension = getImageFileExtension(imageUrl);
        return buildMediaProxyUrl(location.bucket, location.filePath, {
            download: true,
            filename: outputImages.length > 1 ? `generated-image-${index + 1}.${extension}` : `generated-image.${extension}`,
        });
    };
    const outputImageDownloadUrl = getOutputImageDownloadUrl(outputImage, 0);

    if (isLoadingUser) {
        return (
            <div className="ui-page min-h-screen text-[var(--ui-text-primary)] flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-zinc-500" />
            </div>
        );
    }

    const workspaceTitle = outputImage
        ? outputImages.length > 1 ? 'Latest image results' : 'Latest image result'
        : isGenerating
            ? 'Creating your image'
            : isBackgroundProcessing
                ? backgroundProcessingCopy.title
                : 'Ready for your next still';

    const workspaceDescription = outputImage
        ? outputImages.length > 1
            ? 'Grok returned multiple options. The first image stays primary for sharing and publishing.'
            : 'Your newest image stays here until you start another run.'
        : isGenerating
            ? 'Watch the current run here while the model handles generation.'
            : isBackgroundProcessing
                ? backgroundProcessingCopy.description
                : 'The workspace stays focused on the active run and latest result once you generate.';
    const shareTitle = publishedMeta?.title || submittedPrompt || `${model.displayName} image`;
    const shareDescription = publishedMeta?.description || submittedPrompt || null;
    const publicResultPath = latestGenerationId && latestIsPublic ? buildShowcaseDetailPath(latestGenerationId) : null;
    const displayedOutputImages = outputImages.length > 0
        ? outputImages
        : (outputImage ? [outputImage] : []);

    return (
        <div className="ui-page ui-page-ambient min-h-screen py-6 text-[var(--ui-text-primary)] sm:py-8 font-[family-name:var(--font-geist-sans)]">
            <MediaStudioShell
                currentToolId="image"
                header={
                    <GeneratorPageHeader
                        currentToolId="image"
                        title="Create image"
                        eyebrow={`Creator studio / ${model.displayName}`}
                        description="Start with a still when you need the fastest route to a polished product visual, concept frame, or campaign hook."
                        credits={userCredits}
                        showPathSwitcher={false}
                    />
                }
                controls={
                    <>
                        <AnimatePresence>
                            {modelNotice ? (
                                <motion.div
                                    key="model-notice"
                                    initial={{ opacity: 0, y: 12 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -12 }}
                                >
                                    <StudioModelNotice
                                        description={modelNotice}
                                        onDismiss={catalogProblem ? undefined : () => setCatalogNotice(null)}
                                    />
                                </motion.div>
                            ) : null}
                            {remixId && isRemixLoading && (
                                <motion.div
                                    initial={{ opacity: 0, y: 12 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -12 }}
                                >
                                    <StudioRemixHydrationNotice />
                                </motion.div>
                            )}
                            {remixId && !isRemixLoading && (
                                <motion.div
                                    initial={{ opacity: 0, y: 12 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -12 }}
                                >
                                    <StudioRemixNotice
                                        description={`${`Settings pre-filled from ${remixTitle ? `"${remixTitle}"` : 'the original creation'}.`}${remixRestoreWarning ? ` ${remixRestoreWarning}` : ''}`}
                                        action={
                                            remixImageUrl || canUseOriginalResultAsReference ? (
                                                <div className="flex flex-wrap gap-2">
                                                    {remixImageUrl ? (
                                                        <button
                                                            onClick={() => setIsPreviewModalOpen(true)}
                                                            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.08] hover:text-white"
                                                        >
                                                            <ImageIcon className="h-4 w-4" />
                                                            View original
                                                        </button>
                                                    ) : null}
                                                    {canUseOriginalResultAsReference ? (
                                                        <button
                                                            type="button"
                                                            onClick={handleUseOriginalResultAsReference}
                                                            disabled={hasOriginalResultReference}
                                                            className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition ${hasOriginalResultReference
                                                                ? 'cursor-default border border-emerald-400/20 bg-emerald-500/10 text-emerald-100'
                                                                : 'border border-blue-400/20 bg-blue-500/10 text-blue-100 hover:border-blue-300/40 hover:bg-blue-500/15'}`}
                                                        >
                                                            <Sparkles className="h-4 w-4" />
                                                            {hasOriginalResultReference ? 'Using original result' : 'Use as reference'}
                                                        </button>
                                                    ) : null}
                                                </div>
                                            ) : undefined
                                        }
                                    />
                                </motion.div>
                            )}
                        </AnimatePresence>

                        <motion.div
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="relative rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(20,20,24,0.96),rgba(9,9,11,0.94))] p-5 shadow-[0_24px_90px_-56px_rgba(0,0,0,0.95)] sm:p-6"
                            ref={dropdownRef}
                        >
                            <p className="mb-3 text-xs font-bold uppercase tracking-widest text-zinc-500">Model</p>
                            <button
                                onClick={() => {
                                    if (isModelDropdownOpen) setModelSearchQuery('');
                                    setIsModelDropdownOpen(!isModelDropdownOpen);
                                }}
                                aria-expanded={isModelDropdownOpen}
                                aria-haspopup="listbox"
                                className="w-full flex items-center justify-between gap-3 px-5 py-4 bg-zinc-900/50 border border-white/10 rounded-2xl hover:bg-zinc-900/70 hover:border-white/15 transition-all backdrop-blur-sm"
                            >
                                <div className="flex items-center gap-3">
                                    <Zap className="w-4 h-4 text-white" />
                                    <div className="text-left">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-bold text-white">{model.displayName}</span>
                                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full bg-gradient-to-r ${model.badgeColor} text-white`}>
                                                {model.badge}
                                            </span>
                                        </div>
                                        <p className="text-xs text-zinc-500 mt-0.5">{model.description}</p>
                                    </div>
                                </div>
                                <ChevronDown className={`w-4 h-4 text-zinc-400 transition-transform duration-200 ${isModelDropdownOpen ? 'rotate-180' : ''}`} />
                            </button>

                            <StudioModelPicker
                                isOpen={isModelDropdownOpen}
                                loading={modelCatalog.isLoadingModels}
                                error={modelCatalog.error?.message}
                                onRetry={modelCatalog.refetch}
                                query={modelSearchQuery}
                                onQueryChange={setModelSearchQuery}
                                onDismiss={() => {
                                    setIsModelDropdownOpen(false);
                                    setModelSearchQuery('');
                                }}
                                searchLabel="Search image models"
                                searchPlaceholder="Search image models..."
                                resultListLabel="Image models"
                                resultCount={filteredImageModelOptions.length}
                                accent="blue"
                                desktopInset="card"
                            >
                                        {filteredImageModelOptions.map((m) => {
                                            const isActive = selectedModel === m.id;
                                            return (
                                                <button
                                                    key={m.id}
                                                    type="button"
                                                    role="option"
                                                    aria-selected={isActive}
                                                    onClick={() => {
                                                        // A notice about the previous model no longer applies.
                                                        if (m.id !== selectedModel) setCatalogNotice(null);
                                                        setSelectedModel(m.id as ModelId);
                                                        setIsModelDropdownOpen(false);
                                                        setModelSearchQuery('');
                                                    }}
                                                    className={`w-full text-left px-5 py-4 flex items-center gap-3 transition-all ${
                                                        isActive ? 'bg-white/5' : 'hover:bg-white/[0.03]'
                                                    }`}
                                                >
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2">
                                                            <span className={`text-sm font-bold ${isActive ? 'text-white' : 'text-zinc-300'}`}>
                                                                {m.displayName}
                                                            </span>
                                                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full bg-gradient-to-r ${m.badgeColor} text-white`}>
                                                                {m.badge}
                                                            </span>
                                                        </div>
                                                        <p className="text-xs text-zinc-500 mt-0.5">{m.description}</p>
                                                        <div className="flex flex-wrap gap-1.5 mt-2">
                                                            {m.supportsGoogleSearch && (
                                                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
                                                                    Google Search
                                                                </span>
                                                            )}
                                                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-500 border border-white/5">
                                                                {m.maxImages > 0 ? `Up to ${m.maxImages} ref images` : 'Prompt only'}
                                                            </span>
                                                        </div>
                                                    </div>
                                                    {isActive && <Check className="w-4 h-4 text-blue-400 shrink-0" />}
                                                </button>
                                            );
                                        })}
                            </StudioModelPicker>
                            <CatalogAdditionalControls descriptor={catalogDescriptor} handledKeys={CATALOG_HANDLED_KEYS} settings={{ aspectRatio, resolution, qualityMode, googleSearch, ...additionalSettings.settings }} inputCounts={{ images: elements.length, videos: 0, audios: 0 }} onChange={additionalSettings.onChange} />
                        </motion.div>

                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(20,20,24,0.96),rgba(9,9,11,0.94))] p-5 shadow-[0_24px_90px_-56px_rgba(0,0,0,0.95)] sm:p-6"
                        >
                            <h2 className="text-sm font-semibold text-white mb-1">Prompt</h2>
                            <p className="text-sm text-zinc-400 mb-4">Describe the still you want to produce.</p>
                            <EnhancePromptButton
                                prompt={prompt}
                                onEnhanced={(text) => setPrompt(text)}
                                onCreditsUpdate={updateCredits}
                                medium="image"
                                selectedModel={selectedModel}
                                label={isElementEnhancementLocked ? 'Polish' : 'Enhance'}
                                showLevelToggle={!isElementEnhancementLocked}
                                helperText={
                                    isElementEnhancementLocked
                                        ? 'Named elements stay locked. This only adds light visual polish around your original @element sentence.'
                                        : undefined
                                }
                                context={{
                                    modelId: selectedModel,
                                    aspectRatio,
                                    resolution,
                                    googleSearch,
                                    referenceImageCount: sentElements.length,
                                    elementEnhancementMode: isElementEnhancementLocked ? 'append-only' : undefined,
                                    elementReferences: sentElements.map((element) => ({
                                        handle: element.handle,
                                        displayName: element.displayName,
                                    })),
                                }}
                                disabled={isGenerating}
                            />
                            {model.maxImages > 0 && (
                                <div className="mb-4 mt-4 space-y-3">
                                    <div className="flex items-center justify-between gap-3">
                                        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                                            Named elements
                                        </p>
                                        <span className="text-xs text-zinc-500">
                                            Type <span className="font-semibold text-zinc-300">@</span> to reference them in the prompt.
                                        </span>
                                    </div>
                                    {sentElements.length > 0 ? (
                                        <div className="flex flex-wrap gap-2">
                                            {sentElements.map((element) => (
                                                <StudioElementChip
                                                    key={element.id}
                                                    displayName={element.displayName}
                                                    handle={element.handle}
                                                    handleClassName="text-sky-300"
                                                    onInsert={() => handleInsertElementHandle(element.handle)}
                                                />
                                            ))}
                                        </div>
                                    ) : (
                                        <p className="text-sm text-zinc-500">
                                            Upload one or more element images below to mention them by name in the prompt.
                                        </p>
                                    )}
                                </div>
                            )}
                            <textarea
                                ref={promptTextareaRef}
                                value={prompt}
                                onChange={(e) => handlePromptChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
                                onClick={syncPromptCaretState}
                                onKeyUp={syncPromptCaretState}
                                placeholder="Describe the image you want to create..."
                                maxLength={GENERATION_PROMPT_MAX_LENGTH}
                                className={`w-full bg-black/50 text-white rounded-2xl p-5 border border-white/10 ${accentStyles.ring} focus:ring-4 outline-none resize-y min-h-[150px] placeholder:text-zinc-600 transition-all text-sm leading-relaxed`}
                            />
                            <div className="mt-2 flex items-center justify-between gap-3 text-xs">
                                <p className="text-zinc-600">{prompt.length}/{GENERATION_PROMPT_MAX_LENGTH} characters</p>
                                {staleElementMentions.length > 0 ? (
                                    <p className="min-w-0 text-right text-rose-300">
                                        Unknown element mention{staleElementMentions.length > 1 ? 's' : ''}:{' '}
                                        <StudioElementHandleList handles={staleElementMentions} />
                                    </p>
                                ) : null}
                            </div>
                            {activeMentionQuery ? (
                                <div className="mt-4 rounded-[20px] border border-white/8 bg-black/35 p-4">
                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                        <div className="min-w-[min(50%_-_0.75rem,10rem)] flex-1">
                                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                                                Insert element
                                            </p>
                                            <p className="mt-1 text-sm text-zinc-400">
                                                {mentionSuggestions.length > 0
                                                    ? 'Pick an element to insert its @mention.'
                                                    : 'No matching elements yet.'}
                                            </p>
                                        </div>
                                        {activeMentionQuery.query ? (
                                            <StudioElementHandle
                                                handle={`@${activeMentionQuery.query}`}
                                                className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold text-zinc-300"
                                            />
                                        ) : null}
                                    </div>
                                    {mentionSuggestions.length > 0 ? (
                                        <div className="mt-3 flex flex-wrap gap-2">
                                            {mentionSuggestions.map((element) => (
                                                <StudioElementChip
                                                    key={element.id}
                                                    displayName={element.displayName}
                                                    handle={element.handle}
                                                    handleClassName="text-sky-300"
                                                    onInsert={() => handleInsertElementHandle(element.handle)}
                                                />
                                            ))}
                                        </div>
                                    ) : null}
                                </div>
                            ) : null}
                        </motion.div>

                        {/* Elements kept from another model stay here with their remove
                            buttons, even on a prompt-only model: the limit message asks the
                            creator to remove the extras, and this is the only place to do it. */}
                        {model.maxImages > 0 || elements.length > 0 ? (
                            <motion.div
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: 0.04 }}
                                className="rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(20,20,24,0.96),rgba(9,9,11,0.94))] p-5 shadow-[0_24px_90px_-56px_rgba(0,0,0,0.95)] sm:p-6"
                            >
                            <div className="mb-4 flex items-start justify-between gap-3">
                                <div>
                                    <h2 className="text-sm font-semibold text-white">Elements</h2>
                                    <p className="mt-1 text-sm text-zinc-400">
                                        {model.maxImages > 0
                                            ? 'Upload visual anchors, rename them, and reference them directly in the prompt.'
                                            : `${model.displayName} does not take reference images. These are kept for another model; remove them to generate here.`}
                                    </p>
                                </div>
                                <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-300">
                                    {elements.length}/{model.maxImages}
                                </span>
                            </div>

                            {elements.length > 0 ? (
                                <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                    {elements.map((element) => (
                                        <div key={element.id} className="overflow-hidden rounded-[24px] border border-zinc-700/40 bg-black/35">
                                            <div className="relative aspect-square group">
                                                <button
                                                    type="button"
                                                    onClick={() => setUploadPreview({
                                                        type: 'image',
                                                        src: element.previewUrl,
                                                        alt: element.displayName,
                                                        title: element.displayName,
                                                    })}
                                                    className="block h-full w-full"
                                                >
                                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                                    <img
                                                        src={element.previewUrl}
                                                        alt={element.displayName}
                                                        className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                                                    />
                                                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
                                                    <div className="pointer-events-none absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/60 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/90 backdrop-blur-md">
                                                        Preview
                                                    </div>
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleRemoveElement(element.id)}
                                                    className="absolute right-2 top-2 z-10 rounded-full bg-black/60 p-1.5 text-white backdrop-blur-md transition hover:bg-red-500"
                                                >
                                                    <X className="h-3 w-3" />
                                                </button>
                                            </div>
                                            <div className="space-y-3 p-3">
                                                <div>
                                                    <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
                                                        Element name
                                                    </label>
                                                    <input
                                                        type="text"
                                                        value={elementNames.drafts[element.id] ?? element.displayName}
                                                        onChange={(event) => handleElementDraftChange(element.id, event.target.value)}
                                                        onBlur={() => void commitElementDraft(element.id)}
                                                        onKeyDown={(event) => {
                                                            if (event.key === 'Enter') {
                                                                event.preventDefault();
                                                                void commitElementDraft(element.id);
                                                                event.currentTarget.blur();
                                                            }

                                                            if (event.key === 'Escape') {
                                                                elementNames.dropDraft(element.id);
                                                                event.currentTarget.blur();
                                                            }
                                                        }}
                                                        className="w-full rounded-2xl border border-white/10 bg-black/45 px-3 py-2.5 text-sm text-white outline-none transition focus:border-blue-500/40"
                                                        placeholder="Rename element"
                                                    />
                                                </div>
                                                <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2">
                                                    <StudioElementHandle handle={element.handle} className="text-xs font-semibold text-sky-300" />
                                                    <button
                                                        type="button"
                                                        onClick={() => handleInsertElementHandle(element.handle)}
                                                        className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-100 transition hover:bg-white/[0.08]"
                                                    >
                                                        Insert
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : null}

                            {elements.length < model.maxImages && (
                                <label
                                    className={`group flex flex-col items-center justify-center w-full h-[120px] border-2 border-dashed rounded-2xl cursor-pointer transition-all bg-black/40 overflow-hidden relative ${isDragging
                                        ? 'border-cyan-400 bg-cyan-500/10 shadow-[0_0_30px_-5px_rgba(6,182,212,0.3)]'
                                        : 'border-zinc-700/50 hover:border-cyan-500/50 hover:bg-cyan-500/5'
                                        }`}
                                    onDragOver={handleDragOver}
                                    onDragLeave={handleDragLeave}
                                    onDrop={handleDrop}
                                >
                                    <div className="flex flex-col items-center gap-2 text-zinc-500">
                                        <ImageIcon className={`w-6 h-6 transition-colors ${isDragging ? 'text-cyan-400' : ''}`} />
                                        <span className="text-sm">{isDragging ? 'Drop element images here' : 'Drop element images or click'}</span>
                                    </div>
                                    <input type="file" accept="image/*" multiple onChange={handleImageUpload} className="hidden" />
                                </label>
                            )}
                            {elementPickNotice ? (
                                <p role="status" className="mt-3 text-sm text-amber-200">{elementPickNotice}</p>
                            ) : null}
                            </motion.div>
                        ) : (
                            <div className="flex items-start gap-3 rounded-[24px] border border-blue-400/15 bg-blue-400/[0.06] p-4 text-sm text-blue-100">
                                <ImageIcon className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" />
                                <div>
                                    <div className="font-semibold">Prompt-only model</div>
                                    <p className="mt-1 leading-relaxed text-blue-100/70">
                                        {model.displayName} does not accept reference images. Switch models whenever you need identity, product, or style anchors.
                                    </p>
                                </div>
                            </div>
                        )}

                        <div className="grid gap-4 sm:grid-cols-2">
                            <motion.div
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: 0.06 }}
                                className="rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(20,20,24,0.96),rgba(9,9,11,0.94))] p-5 shadow-[0_24px_90px_-56px_rgba(0,0,0,0.95)] sm:p-6"
                            >
                                <h2 className="text-sm font-semibold text-white mb-1">Aspect ratio</h2>
                                <p className="text-sm text-zinc-400 mb-4">Choose the output frame before you run.</p>
                                <div className="flex flex-wrap gap-2">
                                    {model.aspectRatios.map(ratio => (
                                        <button
                                            key={ratio}
                                            onClick={() => setAspectRatio(ratio)}
                                            className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-200 ${aspectRatio === ratio
                                                ? accentStyles.button + ' border'
                                                : 'bg-black/50 text-zinc-500 border border-white/5 hover:bg-zinc-800 hover:text-zinc-300'
                                                }`}
                                        >
                                            {ratio}
                                        </button>
                                    ))}
                                </div>
                            </motion.div>

                            {showResolutionControl ? (
                                <motion.div
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: 0.08 }}
                                    className="rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(20,20,24,0.96),rgba(9,9,11,0.94))] p-5 shadow-[0_24px_90px_-56px_rgba(0,0,0,0.95)] sm:p-6"
                                >
                                    <h2 className="text-sm font-semibold text-white mb-1">Resolution</h2>
                                    <p className="text-sm text-zinc-400 mb-4">Higher detail costs more credits.</p>
                                    <div className="flex gap-3">
                                        {availableResolutions.map(res => (
                                            <button
                                                key={res}
                                                onClick={() => setResolution(res)}
                                                className={`flex-1 py-3 rounded-xl text-sm font-semibold transition-all duration-200 ${resolution === res
                                                    ? accentStyles.button + ' border'
                                                    : 'bg-black/50 text-zinc-500 border border-white/5 hover:bg-zinc-800 hover:text-zinc-300'
                                                    }`}
                                            >
                                                {res}
                                            </button>
                                        ))}
                                    </div>
                                </motion.div>
                            ) : qualityModes.length > 0 ? (
                                <motion.div
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: 0.08 }}
                                    className="rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(20,20,24,0.96),rgba(9,9,11,0.94))] p-5 shadow-[0_24px_90px_-56px_rgba(0,0,0,0.95)] sm:p-6"
                                >
                                    <h2 className="text-sm font-semibold text-white mb-1">
                                        {/* The descriptor already labels this control per model ("Speed" for the
                                            Ideogram tiers, "Quality" elsewhere), so a new model with quality modes
                                            no longer lands under a heading naming a different vendor. */}
                                        {imageAffordances?.qualityModeLabel
                                            ? `Generation ${imageAffordances.qualityModeLabel.toLowerCase()}`
                                            : (selectedModel === 'ideogram-v3' ? 'Generation speed' : 'Grok quality')}
                                    </h2>
                                    <p className="text-sm text-zinc-400 mb-4">
                                        {selectedModel === 'grok-imagine-image'
                                            ? 'Quality applies to prompt-only Grok runs; edits use fixed image-to-image pricing.'
                                            : 'Choose faster drafts or spend more credits for final-detail output.'}
                                    </p>
                                    <div className={`grid gap-3 ${qualityModes.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
                                        {qualityModes.map((mode) => (
                                            <button
                                                key={mode}
                                                onClick={() => setQualityMode(mode)}
                                                className={`rounded-xl px-4 py-3 text-sm font-semibold capitalize transition-all duration-200 ${qualityMode === mode
                                                    ? accentStyles.button + ' border'
                                                    : 'border border-white/5 bg-black/50 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
                                                    }`}
                                            >
                                                {mode}
                                            </button>
                                        ))}
                                    </div>
                                </motion.div>
                            ) : null}
                        </div>

                        <AnimatePresence>
                            {model.supportsGoogleSearch && (
                                <motion.div
                                    key="google-search"
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    exit={{ opacity: 0, height: 0 }}
                                    transition={{ duration: 0.25 }}
                                    className="rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(20,20,24,0.96),rgba(9,9,11,0.94))] p-5 shadow-[0_24px_90px_-56px_rgba(0,0,0,0.95)] sm:p-6 overflow-hidden"
                                >
                                    <div className="flex items-center justify-between cursor-pointer" onClick={() => setGoogleSearch(!googleSearch)}>
                                        <div>
                                            <h2 className="text-sm font-semibold text-white mb-1">Google Search grounding</h2>
                                            <p className="text-sm text-zinc-400">Allow the model to pull in live context when it helps.</p>
                                        </div>
                                        <div className={`w-12 h-6 rounded-full p-1 transition-all ${googleSearch ? accentStyles.toggle : 'bg-zinc-800'}`}>
                                            <div className={`bg-white w-4 h-4 rounded-full shadow-md transition-transform ${googleSearch ? 'translate-x-6' : 'translate-x-0'}`} />
                                        </div>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </>
                }
                workspace={
                    <>
                        <StudioRunPanel
                            title={isGenerating ? 'Image run in progress' : 'Ready to generate'}
                            summary={
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="rounded-[20px] border border-white/8 bg-black/30 p-4">
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Model</div>
                                        <div className="mt-2 text-sm font-semibold text-white">{model.displayName}</div>
                                    </div>
                                    <div className="rounded-[20px] border border-white/8 bg-black/30 p-4">
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Cost</div>
                                        <div className="mt-2 text-sm font-semibold text-white">{quoteUi.costLabel}</div>
                                    </div>
                                </div>
                            }
                            details={
                                <div className="grid grid-cols-2 gap-3 text-sm">
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Frame</div>
                                        <div className="mt-1 text-zinc-200">{aspectRatio}</div>
                                    </div>
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
                                            {showResolutionControl ? 'Resolution' : 'Quality'}
                                        </div>
                                        <div className="mt-1 text-zinc-200">
                                            {showResolutionControl ? resolution : `${qualityMode}${isGrokImageModel && elements.length > 0 ? ' edit' : ''}`}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Elements</div>
                                        <div className="mt-1 text-zinc-200">
                                            {model.maxImages > 0 ? `${elements.length}/${model.maxImages}` : 'Prompt only'}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Credits left</div>
                                        <div className="mt-1 text-zinc-200">{userCredits ?? '...'}</div>
                                    </div>
                                </div>
                            }
                            action={
                                pendingStart && !isGenerating ? (
                                    <div className="space-y-3">
                                        <button
                                            type="button"
                                            onClick={() => void replayPendingStart(pendingStart)}
                                            className="ui-focus-ring flex min-h-14 w-full items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-6 py-4 text-base font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985]"
                                        >
                                            Check again
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleStartNewRun}
                                            disabled={!prompt.trim() || quotePending || staleElementMentions.length > 0 || Boolean(referenceLimitMessage)}
                                            className="ui-focus-ring flex min-h-12 w-full items-center justify-center rounded-full border border-white/10 bg-white/[0.03] px-6 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            {currentCost !== null ? `Start a new run · ${quoteUi.costLabel}` : 'Start a new run'}
                                        </button>
                                    </div>
                                ) : showTopUp ? (
                                    <div className="space-y-4">
                                        <div className="rounded-[22px] border border-blue-500/20 bg-blue-500/10 p-4">
                                            <p className="text-sm font-semibold text-white">Not enough credits</p>
                                            <p className="mt-2 text-sm text-zinc-400">
                                                {insufficientCredits ? (
                                                    <>Image generation costs <strong className="text-white">{currentCost} credits</strong> but you only have <strong className="text-white">{userCredits}</strong>.</>
                                                ) : creditRefusalMessage}
                                            </p>
                                        </div>
                                        <Link href="/pricing" className="ui-focus-ring flex min-h-12 items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-6 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985]">
                                            <Sparkles className="h-4 w-4" />
                                            Top Up Credits
                                        </Link>
                                    </div>
                                ) : (
                                    <button
                                        onClick={handleGenerate}
                                        disabled={!prompt.trim() || isGenerating || quotePending || staleElementMentions.length > 0 || Boolean(referenceLimitMessage)}
                                        className="ui-focus-ring flex min-h-14 w-full items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-6 py-4 text-base font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        {isGenerating ? (
                                            <><Loader2 className="w-5 h-5 animate-spin" /> Generating...</>
                                        ) : (
                                            <><Sparkles className="w-5 h-5" /> Generate Image</>
                                        )}
                                    </button>
                                )
                            }
                            status={
                                <>
                                    {isGenerating && generationTiming ? (
                                        <StudioGenerationStatus
                                            accent={model.accentColor}
                                            timing={generationTiming}
                                            nowMs={nowMs}
                                        />
                                    ) : isBackgroundProcessing ? (
                                        <StudioBackgroundProcessingNotice
                                            accent={model.accentColor}
                                            label="image"
                                            phaseLabel={backgroundTiming?.phaseLabel ?? null}
                                            timingLabel={backgroundTimingLabel}
                                        />
                                    ) : pendingStart ? (
                                        <p role="alert" className="text-sm text-amber-200">{pendingStartNotice ?? START_UNCONFIRMED_MESSAGE}</p>
                                    ) : referenceLimitMessage ? (
                                        <p className="text-sm text-red-400">{referenceLimitMessage}</p>
                                    ) : error ? (
                                        <p className="text-sm text-red-400">{error}</p>
                                    ) : staleElementMentions.length > 0 ? (
                                        <p className="text-sm text-rose-300">
                                            Resolve the unknown element mention{staleElementMentions.length > 1 ? 's' : ''} before generating:{' '}
                                            <StudioElementHandleList handles={staleElementMentions} />
                                        </p>
                                    ) : quoteState.status === 'error' ? (
                                        <p className="text-sm text-amber-300">{quoteUi.message}<button type="button" onClick={() => setQuoteAttempt((current) => current + 1)} className="ml-2 underline underline-offset-2 hover:text-amber-100">Retry quote</button></p>
                                    ) : (
                                        <p className="text-sm text-zinc-500">Your latest image will appear in the workspace as soon as the run finishes.</p>
                                    )}
                                </>
                            }
                            footer={
                                <Link
                                    href="/creations"
                                    className="inline-flex items-center gap-2 text-sm font-medium text-zinc-300 transition hover:text-white"
                                >
                                    View Studio
                                    <Images className="h-4 w-4" />
                                </Link>
                            }
                        />

                        <StudioWorkspacePanel
                            title={workspaceTitle}
                            description={workspaceDescription}
                            action={
                                <Link
                                    href="/creations"
                                    className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-100 transition hover:bg-white/[0.06]"
                                >
                                    Studio
                                    <Images className="h-4 w-4" />
                                </Link>
                            }
                        >
                            {outputImage ? (
                                <div className="space-y-5">
                                    <div className={displayedOutputImages.length > 1 ? 'grid gap-3 sm:grid-cols-2' : ''}>
                                        {displayedOutputImages.map((imageUrl, index) => (
                                            <div key={`${imageUrl}-${index}`} className="space-y-3">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setResultPreviewImage(imageUrl);
                                                        setIsResultPreviewOpen(true);
                                                    }}
                                                    className="group relative block w-full overflow-hidden rounded-[26px] border border-white/8 bg-black/50 text-left transition hover:border-blue-300/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300/35"
                                                    aria-label={`Preview generated image ${index + 1}`}
                                                >
                                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                                    <img src={imageUrl} alt={`Generated image ${index + 1}`} className="block h-auto w-full object-cover transition duration-300 group-hover:scale-[1.01]" />
                                                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/65 via-black/5 to-transparent opacity-80 transition group-hover:opacity-100" />
                                                    <div className="pointer-events-none absolute bottom-4 left-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/65 px-3.5 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-white backdrop-blur-md">
                                                        <Expand className="h-3.5 w-3.5" />
                                                        {index === 0 ? 'Primary result' : `Result ${index + 1}`}
                                                    </div>
                                                </button>
                                                {displayedOutputImages.length > 1 ? (
                                                    <a
                                                        href={getOutputImageDownloadUrl(imageUrl, index) ?? imageUrl}
                                                        download={`generated-image-${index + 1}.${getImageFileExtension(imageUrl)}`}
                                                        className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-4 py-2.5 text-xs font-semibold text-emerald-100 transition hover:border-emerald-400/40 hover:bg-emerald-500/15"
                                                    >
                                                        <Download className="h-3.5 w-3.5" />
                                                        Download result {index + 1}
                                                    </a>
                                                ) : null}
                                            </div>
                                        ))}
                                    </div>
                                    <div className="flex flex-wrap gap-3">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setResultPreviewImage(outputImage);
                                                setIsResultPreviewOpen(true);
                                            }}
                                            className="inline-flex items-center gap-2 rounded-full border border-blue-400/20 bg-blue-500/10 px-5 py-3 text-sm font-semibold text-blue-100 transition hover:border-blue-300/35 hover:bg-blue-500/15"
                                        >
                                            <Expand className="h-4 w-4" />
                                            Preview primary
                                        </button>
                                        <a
                                            href={outputImageDownloadUrl ?? outputImage}
                                            download={`generated-image.${getImageFileExtension(outputImage)}`}
                                            className="inline-flex items-center gap-2 rounded-full bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500"
                                        >
                                            <Download className="h-4 w-4" />
                                            Download image
                                        </a>
                                        {latestGenerationId ? (
                                            latestIsPublic ? (
                                                <>
                                                    <PublicShareButton
                                                        generationId={latestGenerationId}
                                                        viewerIsOwner
                                                        title={shareTitle}
                                                        description={shareDescription}
                                                        sourceSurface="create-image"
                                                        accessToken={session?.access_token ?? null}
                                                        className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-5 py-3 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                                                    />
                                                    {publicResultPath ? (
                                                        <Link
                                                            href={publicResultPath}
                                                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-5 py-3 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                                                        >
                                                            Open public page
                                                        </Link>
                                                    ) : null}
                                                </>
                                            ) : (
                                                <button
                                                    type="button"
                                                    onClick={() => void handleOpenPublish()}
                                                    disabled={isPreparingPublish}
                                                    className="ui-focus-ring inline-flex items-center gap-2 rounded-full bg-[var(--ui-primary)] px-5 py-3 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985] disabled:cursor-wait disabled:opacity-70"
                                                >
                                                    {isPreparingPublish ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
                                                    Publish & share
                                                </button>
                                            )
                                        ) : null}
                                        <button
                                            onClick={() => {
                                                setOutputImage(null);
                                                setOutputImages([]);
                                                setResultPreviewImage(null);
                                                setIsResultPreviewOpen(false);
                                                setLatestGenerationId(null);
                                                setLatestIsPublic(false);
                                                setPublishedMeta(null);
                                            }}
                                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-5 py-3 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                                        >
                                            Start another run
                                        </button>
                                    </div>
                                </div>
                            ) : isGenerating ? (
                                <div className="flex min-h-[520px] flex-col items-center justify-center gap-5 rounded-[26px] border border-dashed border-white/10 bg-black/40 p-10 text-center">
                                    <div className={`flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-r ${accentStyles.progress}`}>
                                        <Loader2 className="h-7 w-7 animate-spin text-white" />
                                    </div>
                                    <div>
                                        <h3 className="text-xl font-semibold text-white">Building your next still</h3>
                                        <p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">
                                            The workspace will switch from status to output as soon as the model finishes the current run.
                                        </p>
                                    </div>
                                </div>
                            ) : isBackgroundProcessing ? (
                                <StudioBackgroundProcessingNotice
                                    accent={model.accentColor}
                                    label="image"
                                    variant="workspace"
                                    phaseLabel={backgroundTiming?.phaseLabel ?? null}
                                    timingLabel={backgroundTimingLabel}
                                />
                            ) : (
                                <div className="flex min-h-[520px] flex-col items-center justify-center gap-5 rounded-[26px] border border-dashed border-white/10 bg-black/40 p-10 text-center">
                                    <div className={`flex h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-gradient-to-br ${
                                        model.accentColor === 'amber'
                                            ? 'from-amber-500/30 to-orange-500/10'
                                            : 'from-blue-500/30 to-cyan-500/10'
                                    }`}>
                                        <ImageIcon className="h-7 w-7 text-white" />
                                    </div>
                                    <div>
                                        <h3 className="text-xl font-semibold text-white">No image yet</h3>
                                        <p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">
                                            {model.maxImages > 0
                                                ? 'Write the prompt, optionally add a few named elements, then generate. The latest result will take over this workspace.'
                                                : 'Write the prompt, then generate. The latest result will take over this workspace.'}
                                        </p>
                                    </div>
                                </div>
                            )}
                        </StudioWorkspacePanel>
                    </>
                }
            />

            <StudioMediaPreviewModal
                isOpen={Boolean(uploadPreview)}
                onClose={() => setUploadPreview(null)}
                mediaType="image"
                src={uploadPreview?.src ?? null}
                alt={uploadPreview?.alt ?? 'Reference image'}
                title={uploadPreview?.title ?? 'Reference Preview'}
            />

            <StudioMediaPreviewModal
                isOpen={isResultPreviewOpen}
                onClose={() => setIsResultPreviewOpen(false)}
                mediaType="image"
                src={resultPreviewImage ?? outputImage}
                alt="Generated image preview"
                title="Generated Image Preview"
                footer={
                    <div className="flex flex-col gap-2">
                        <div className="text-xs font-bold uppercase tracking-wider text-zinc-500">Prompt</div>
                        <p className="max-h-32 overflow-y-auto whitespace-pre-wrap pr-2 text-sm leading-relaxed text-zinc-300 [overflow-wrap:anywhere] custom-scrollbar">
                            {submittedPrompt || 'No prompt available'}
                        </p>
                    </div>
                }
            />

            <PublishToShowcaseModal
                isOpen={isPublishModalOpen}
                onClose={() => setIsPublishModalOpen(false)}
                generationId={latestGenerationId}
                accessToken={session?.access_token ?? null}
                defaultTitle={publishModalDefaults.title}
                paywallPrefill={publishModalDefaults.paywallPrefill}
                shareAfterPublish={latestGenerationId ? {
                    title: shareTitle,
                    description: shareDescription,
                    sourceSurface: 'create-image',
                } : undefined}
                onPublished={(payload) => {
                    setLatestIsPublic(true);
                    setPublishedMeta(payload);
                    setIsPublishModalOpen(false);
                }}
            />

            <StudioMediaPreviewModal
                isOpen={isPreviewModalOpen}
                onClose={() => setIsPreviewModalOpen(false)}
                mediaType="image"
                src={remixImageUrl}
                alt="Original creation"
                title="Original Creation"
                footer={
                    <div className="flex flex-col gap-2">
                        <div className="text-xs font-bold uppercase tracking-wider text-zinc-500">Prompt</div>
                        <p className="max-h-32 overflow-y-auto pr-2 text-sm leading-relaxed text-zinc-300 custom-scrollbar">
                            {remixSourceBundle?.generation.prompt || 'No prompt available'}
                        </p>
                    </div>
                }
            />
        </div>
    );
}
