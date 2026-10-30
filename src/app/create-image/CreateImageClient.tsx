'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, Loader2, Download, Image as ImageIcon, Plus } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import { catalogRunQuoteInput, GENERATION_PROMPT_MAX_LENGTH } from '../../../ugc-mobile/lib/model-catalog/protocol';
import {
    creatorPromptViolation,
    promptLengthMeter,
    promptLimitFor,
} from '../../../ugc-mobile/lib/model-catalog/provider-prompt-limits';
import {
    StudioBackgroundProcessingNotice,
    StudioElementHandleList,
    StudioGenerationStatus,
    StudioMediaPreviewModal,
    StudioModelNotice,
    StudioOutOfDatePageNotice,
    StudioQuoteRetry,
    StudioRemixHydrationNotice,
    StudioRemixNotice,
} from '@/components/CreatorStudio';
import {
    CreatorAddTile,
    CreatorBackgroundRunLine,
    CreatorBalanceNote,
    CreatorBarAction,
    CreatorCanvas,
    parseAspectRatio,
    CreatorCanvasFrame,
    CreatorCanvasStage,
    CreatorColumnBar,
    CreatorColumnLayout,
    CreatorMentionPanel,
    CreatorModelChip,
    CreatorOverBalanceLegend,
    CreatorPendingStartNotice,
    CreatorReferenceRow,
    CreatorRunFailed,
    CreatorRunFailedLine,
    CreatorRunWaitLines,
    CreatorSettingChoices,
    CreatorSettingsFootNote,
    CreatorSettingSwitch,
    CreatorTemplatesTile,
    CreatorToolTabs,
    CreatorTopUpNotice,
    CreatorVisitorNote,
    CREATOR_VISITOR_CANVAS_HINT,
    creatorCanvasChip,
    describeRunFailure,
} from '@/components/CreatorColumn';
import { CreatorEmptyCanvas, CreatorStartPostsStrip, CreatorWhileYouWait, type StartPostsSource } from '@/components/CreatorStartPosts';
import CreatorModelPickerRows, { CreatorModelPickerFoot, type PickerModelRow } from '@/components/CreatorModelPickerRows';
import { referenceKeepWords, samePriceForEach } from '../../../ugc-mobile/lib/creator-run-fit/creator-run-fit';
import {
    fitImageFormToModel,
    imageRunOnModel,
    imageRunSummary,
    type ImageFormSettings,
    type ImageRunOnModel,
} from '@/lib/creator-image-candidates';
import {
    listedFromQuote,
    NO_SETTINGS_VARIANTS,
    optionPricesOf,
    settingsVariants,
    smallestOverBalance,
    useQuotePrices,
} from '@/lib/use-quote-prices';
import CreatorSignUpSheet, { type CreatorSignUpReason } from '@/components/CreatorSignUpSheet';
import CreatorWelcomeCard, { type CreatorWelcome } from '@/components/CreatorWelcomeCard';
import { VISITOR_DRAFT_OWNER } from '@/lib/creator-visitor-draft';
import { isRetryableProviderFailure } from '@/lib/provider-failure-messages';
import { useCreatorDraftOwner } from '@/lib/use-creator-draft-owner';
import { getAccentClasses } from '@/components/DesignSystem';
import StudioModelPicker from '@/components/StudioModelPicker';
import CatalogAdditionalControls, { useAdditionalCatalogSettings } from '@/components/CatalogAdditionalControls';
import { CreatorDoneLayout, CreatorDownloadButton, CreatorPostedNext, CreatorPublishPanel, useCreatorPublish } from '@/components/CreatorPublish';
import { creatorCanvasFollowsRun, creatorCanvasPhase, creatorCanvasSettledStatus, creatorCanvasTitle } from '@/lib/creator-canvas-phase';
import EnhancePromptButton from '@/components/EnhancePromptButton';
import PromptLengthCounter from '@/components/PromptLengthCounter';
import { useAuth } from '@/components/AuthProvider';
import type { RemixSourceBundle } from '@/lib/remix-source';
import { hasCreatorEditedPromptDuringRemix } from '@/lib/remix-source';
import {
    createRemixElementSeeds,
    getRemixReferenceCapWarning,
    joinRemixRestoreWarnings,
    createRemixResultReferenceElement,
    getRemixRestoreWarning,
    getRemixResultReferenceLabel,
} from '@/lib/remix-source-client';
import {
    getPersistedImageElementRecords,
    PERSISTED_MEDIA_KEYS,
    purgeLegacyPersistedMedia,
    scopedPersistedMediaKey,
    setPersistedImageElementRecords,
    type PersistedStagedUpload,
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
    useAnnounceRunOnPage,
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
import { planImageRunInputs, type ImageRunInput } from '@/lib/creator-run-inputs';
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
    WebCatalogRequestError,
    webCatalogStartRequest,
    type PendingWebStart,
    type WebGenerationStartResponse,
} from '@/lib/generation-model-client';
import { RECLAIM_AFTER_HOURS } from '@/lib/media-upload-reclaim';
import { useCreatorQuote } from '@/lib/use-creator-quote';
import { openingCost, openingSetting, type CreatorOpening } from '@/lib/creator-opening';
import { reloadBroughtBackThisBuild, reloadForNewerBuild, useDeploymentRefresh } from '@/lib/use-deployment-refresh';
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

/** An element's file as this page last staged it in `uploads`, kept with the element across reloads. */
type StagedElementUpload = PersistedStagedUpload;

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
async function stageElementFile(file: File, staged: StagedElementUpload | null): Promise<StagedElementUpload & { signedUrl: string }> {
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

export interface CreateImagePrefill {
    remixId?: string | null;
    remixPostId?: string | null;
    prompt?: string | null;
    model?: string | null;
    aspectRatio?: string | null;
}

const CATALOG_HANDLED_KEYS = ['aspectRatio', 'resolution', 'qualityMode', 'googleSearch'] as const;

/** A run's model as its chip names it, where all the page knows of the run is its model: a start sent before, a run picked up on load. */
function imageModelName(modelId: unknown): string | null {
    return typeof modelId === 'string' ? (IMAGE_MODELS as Record<string, { displayName: string } | undefined>)[modelId]?.displayName ?? null : null;
}

export default function CreateImageClient({
    prefill,
    welcome = null,
    handoverNonce = null,
    visitorWelcomeCredits = null,
    opening = null,
    startPosts = null,
}: {
    prefill: CreateImagePrefill;
    /** Back from the sign-up a visitor opened here: the card that adds the welcome credits. */
    welcome?: CreatorWelcome | null;
    /** The sign-up sheet's `?handover=` nonce on the way back: the visitor's draft moves to the account by it. */
    handoverNonce?: string | null;
    /** What a new account starts with, told to a signed-out visitor. */
    visitorWelcomeCredits?: number | null;
    /**
     * The run the server read the page opens on: its model, settings and price are drawn from the
     * first paint, until the first pick and the page's own price.
     */
    opening?: CreatorOpening | null;
    /** The shelf's posts for the empty canvas, still on their way; none for a remix. */
    startPosts?: StartPostsSource;
}) {
    const router = useRouter();
    const { credits: userCredits, isLoading: isLoadingUser, session, updateCredits } = useAuth();
    const userId = session?.user?.id ?? null;
    // The visitor's draft until someone signs in, then the account's, which takes
    // the visitor's when sign-up was opened here.
    const { owner: draftOwner, carriedDraft } = useCreatorDraftOwner('image', userId, handoverNonce);
    // A page that opened signed out works up to Generate, which asks for an account
    // (owner, 2026-10-28). One whose session lapsed is not a visitor's: it keeps its
    // signed-in face, and its Generate signs in again on the login page.
    const isVisitor = draftOwner === VISITOR_DRAFT_OWNER;
    const [signUpReason, setSignUpReason] = useState<CreatorSignUpReason | null>(null);
    const [selectedModel, setSelectedModel] = useState<ModelId>((opening?.modelId ?? 'nano-banana-2') as ModelId);
    const [prompt, setPrompt] = useState('');

    // Mirrors the live prompt so the remix restore below can tell whether the
    // creator typed while /api/remix-source was still in flight.
    const promptRef = useRef(prompt);
    useEffect(() => {
        promptRef.current = prompt;
    }, [prompt]);
    const [elements, setElements] = useState<ImageElementDraft[]>([]);
    // The opening's published settings until the first pick; the page's own where it publishes none.
    const [aspectRatio, setAspectRatio] = useState(() => openingSetting<string>(opening, 'aspectRatio', 'auto'));
    const [resolution, setResolution] = useState(() => openingSetting<string>(opening, 'resolution', '1K') as ImageResolution);
    const [qualityMode, setQualityMode] = useState(() => openingSetting<string>(opening, 'qualityMode', 'standard') as ImageQualityMode);
    const [googleSearch, setGoogleSearch] = useState(() => openingSetting<boolean>(opening, 'googleSearch', false));
    const [isDragging, setIsDragging] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [generationTiming, setGenerationTiming] = useState<GenerationTiming | null>(null);
    const [outputImage, setOutputImage] = useState<string | null>(null);
    const [outputImages, setOutputImages] = useState<string[]>([]);
    const [latestGenerationId, setLatestGenerationId] = useState<string | null>(null);
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
    const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
    const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
    // Open settings price each of their options; the bar says when they open and close.
    const [settingsOpen, setSettingsOpen] = useState(false);
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
    // Bumped once a run the creator started is under way: the canvas then comes into view.
    const [canvasRevealKey, setCanvasRevealKey] = useState(0);
    // The run in flight, which the canvas names while the form changes: its frame's shape, its
    // settings' line, the credits it holds, and whether its start answered (the run is the
    // server's, so the page may be left).
    const [runShape, setRunShape] = useState<{ aspectRatio: string | null; label: string | null; cost: number | null; answered: boolean } | null>(null);
    // A run the provider failed, said on the canvas with its cause (the artboard Failed).
    const [runFailure, setRunFailure] = useState<{ message: string; cost: number | null } | null>(null);
    // Bumped when a run this page followed ends, done or failed: the canvas takes the focus.
    const [runEndKey, setRunEndKey] = useState(0);
    const [activeMentionQuery, setActiveMentionQuery] = useState<{
        query: string;
        replaceStart: number;
        replaceEnd: number;
    } | null>(null);

    // Remix State
    const remixId = prefill.remixId ?? null;
    const remixPostId = prefill.remixPostId ?? null;
    // Publishing on the canvas: the form's details, the remix's original (credited with Follow,
    // owner 2026-10-28), Posted, and a publish in flight, which Generate waits for.
    const canvasPublish = useCreatorPublish({
        generationId: latestGenerationId,
        done: Boolean(outputImage),
        accessToken: session?.access_token,
        remixPostId,
        viewerUserId: userId,
    });
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
    // The owner whose saved draft has been read back; a remix keeps none.
    const [draftRestoredFor, setDraftRestoredFor] = useState<string | null>(null);
    const isDraftRestoreSettled = Boolean(remixId) || (draftOwner !== null && draftRestoredFor === draftOwner);
    const restoredDraftModelRef = useRef(false);
    // Saved settings for a model whose controls have not loaded yet.
    const pendingDraftSettingsRef = useRef<{ modelId: string; values: Record<string, CatalogPrimitive> } | null>(null);
    const unsavedDraftRef = useRef<{ owner: string; draft: ImageCreatorDraft } | null>(null);

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
        if (!modelCatalog.catalog || !isDraftRestoreSettled) return;
        // The first pick waits for the revision the network confirms, as the video page's does: a catalog
        // read back from the browser can name an earlier default than the one the page was drawn on.
        if (!hasResolvedInitialCatalogModel.current && modelCatalog.isCheckingRevision) return;
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
    }, [isDraftRestoreSettled, modelCatalog.catalog, modelCatalog.isCheckingRevision, selectedModel, prefillModel, remixId]);

    // A route's own prompt, model or frame wins over the saved one, and a model's
    // settings come back only with that model.
    useEffect(() => {
        if (remixId || !draftOwner) return;
        let cancelled = false;
        const promptWhenRestoreStarted = promptRef.current;
        void loadCreatorDraft<Partial<ImageCreatorDraft>>('image', draftOwner)
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
                if (!cancelled) setDraftRestoredFor(draftOwner);
            });
        return () => {
            cancelled = true;
        };
    }, [prefillAspectRatio, prefillModel, prefillPrompt, remixId, draftOwner]);

    useEffect(() => {
        // What the creators saved before media was kept per account belonged to no one in particular.
        void purgeLegacyPersistedMedia().catch(() => undefined);
    }, []);

    const persistUploadedImageElements = useCallback(async (nextElements: ImageElementDraft[]) => {
        if (remixId || !draftOwner) {
            return;
        }

        const persistableElements = nextElements
            .filter((element) => element.file && element.source === 'upload')
            .map((element) => ({
                id: element.id,
                displayName: element.displayName,
                handle: element.handle,
                file: element.file as File,
                staged: element.staged,
            }));

        await setPersistedImageElementRecords(
            scopedPersistedMediaKey(PERSISTED_MEDIA_KEYS.createImageElements, draftOwner),
            persistableElements
        );
    }, [remixId, draftOwner]);

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

    // When model or aspect changes, clamp model-specific controls, by the rule the model
    // list prices each model with (`fitImageFormToModel`).
    useEffect(() => {
        if (!modelCatalog.detailsReady) return;
        const fitted = fitImageFormToModel(selectedModel, { aspectRatio, resolution, qualityMode, googleSearch });
        if (!fitted) return;
        if (fitted.aspectRatio !== aspectRatio || fitted.resolution !== resolution) {
            setCatalogNotice('Model settings changed. Unsupported choices were reset; your prompt and references are preserved.');
        }
        if (fitted.aspectRatio !== aspectRatio) setAspectRatio(fitted.aspectRatio);
        if (fitted.resolution !== resolution) setResolution(fitted.resolution as ImageResolution);
        if (fitted.googleSearch !== googleSearch) setGoogleSearch(fitted.googleSearch);
        if (fitted.qualityMode !== qualityMode) setQualityMode(fitted.qualityMode as ImageQualityMode);
    }, [aspectRatio, googleSearch, modelCatalog.detailsReady, qualityMode, resolution, selectedModel]);

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
                // A model whose cap fell since the run gets its first references back, and says so.
                const capWarning = getRemixReferenceCapWarning(
                    bundle.inputs.image?.elements ?? [],
                    IMAGE_MODELS[nextModelId].maxImages,
                    IMAGE_MODELS[nextModelId].displayName,
                );
                if (capWarning) setRemixRestoreWarning((current) => joinRemixRestoreWarnings(current, capWarning));

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
        if (remixId || !draftOwner) {
            return;
        }

        try {
            const savedElementRecords = await getPersistedImageElementRecords(
                scopedPersistedMediaKey(PERSISTED_MEDIA_KEYS.createImageElements, draftOwner)
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
                    staged: element.staged ?? null,
                }))
            ));
        } catch (err) {
            console.error('Error loading persisted image elements:', err);
        }
    }, [commitElements, remixId, draftOwner]);

    useEffect(() => {
        if (!draftOwner || restoredPersistedMediaForUserRef.current === draftOwner) return;
        restoredPersistedMediaForUserRef.current = draftOwner;

        void loadPersistedElements();
    }, [loadPersistedElements, draftOwner]);

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
    // Only what the request carries is priced and sent: a model that takes fewer pictures
    // (none, when it is prompt-only) leaves the rest on the grid unsent. The price is the
    // server's quote of these inputs, as the server quotes the run it starts, and the run
    // is posted from them; the quote counted every picture on the grid.
    const runInputs = useMemo(() => planImageRunInputs(elements, model.maxImages), [elements, model.maxImages]);
    const quoteRequest = useMemo(() => modelCatalog.catalog && modelCatalog.detailsReady ? catalogRunQuoteInput({
        kind: 'image' as const,
        modelId: selectedModel,
        catalogRevision: modelCatalog.catalog.revision,
        settings: generationSettings,
        inputs: runInputs,
    }) : null, [generationSettings, modelCatalog.catalog, modelCatalog.detailsReady, runInputs, selectedModel]);

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
        if (remixId || !draftOwner || !isDraftRestoreSettled) {
            unsavedDraftRef.current = null;
            return;
        }
        const entry = { owner: draftOwner, draft: getDraftToSave() };
        unsavedDraftRef.current = entry;
        const timer = window.setTimeout(() => {
            if (unsavedDraftRef.current === entry) unsavedDraftRef.current = null;
            void saveCreatorDraft('image', entry.owner, entry.draft).catch(() => undefined);
        }, CREATOR_DRAFT_SAVE_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [getDraftToSave, isDraftRestoreSettled, remixId, draftOwner]);
    useEffect(() => () => {
        // Leaving inside the wait, through the Top Up link say, still keeps the last edit.
        const entry = unsavedDraftRef.current;
        if (entry) void saveCreatorDraft('image', entry.owner, entry.draft).catch(() => undefined);
    }, []);
    const saveDraftNow = async () => {
        if (remixId || !draftOwner) return;
        unsavedDraftRef.current = null;
        await Promise.allSettled([
            isDraftRestoreSettled ? saveCreatorDraft('image', draftOwner, getDraftToSave()) : Promise.resolve(),
            persistUploadedImageElements(elementRefs.current),
        ]);
    };
    /** Asks a visitor to sign up for what they pressed, with the form saved for the way back. */
    const openSignUp = async (reason: CreatorSignUpReason) => {
        // The text only: the pictures were saved as each was added, and writing every
        // one again held the sheet back on a phone.
        if (!remixId && draftOwner && isDraftRestoreSettled) {
            unsavedDraftRef.current = null;
            await saveCreatorDraft('image', draftOwner, getDraftToSave()).catch(() => undefined);
        }
        setSignUpReason(reason);
    };
    /** Onto the current build, with the draft saved first: it comes back after the reload. */
    const reloadPage = async () => {
        await saveDraftNow();
        reloadForNewerBuild();
    };
    const quoteState = useCreatorQuote(quoteRequest, session?.access_token);
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
    // The price under the bar: the page's own, or until it is in, the server's for the run the page opened on.
    const notedCost = currentCost ?? openingCost(opening, {
        run: { modelId: selectedModel, settings: generationSettings, inputs: runInputs },
        quoteStatus: quoteState.status,
        confirmedRevision: modelCatalog.isCheckingRevision ? null : modelCatalog.revision,
        catalogFailed: Boolean(modelCatalog.error) || modelCatalog.missingIds.includes(selectedModel),
    });
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

    // The model list and the settings priced (owner, 2026-10-28): every model at this run's
    // settings, as the page lands on it, and every option of the settings, read against the
    // balance or a visitor's welcome credits.
    const listBalance = isVisitor ? visitorWelcomeCredits : userCredits;
    const pageForm = useMemo<ImageFormSettings>(() => ({
        aspectRatio, resolution, qualityMode, googleSearch: model.supportsGoogleSearch ? googleSearch : false,
    }), [aspectRatio, resolution, qualityMode, googleSearch, model.supportsGoogleSearch]);
    const imageModelIdsKey = imageModelOptions.map((option) => option.id).join(',');
    const ensureModelDetails = modelCatalog.ensureDetails;
    useEffect(() => {
        if (isModelDropdownOpen && imageModelIdsKey) ensureModelDetails?.(imageModelIdsKey.split(','));
    }, [ensureModelDetails, isModelDropdownOpen, imageModelIdsKey]);
    const modelRuns = useMemo(() => {
        const catalog = modelCatalog.catalog;
        const runs = new Map<string, ImageRunOnModel<ImageElementDraft>>();
        if (!isModelDropdownOpen || !catalog || !imageModelIdsKey) return runs;
        const detailed = new Set(catalog.models.map((detail) => detail.id));
        for (const id of imageModelIdsKey.split(',')) {
            if (id === selectedModel || !detailed.has(id)) continue;
            const run = imageRunOnModel({ modelId: id, catalogRevision: catalog.revision, form: pageForm, elements });
            if (run) runs.set(id, run);
        }
        return runs;
    }, [isModelDropdownOpen, modelCatalog.catalog, imageModelIdsKey, selectedModel, pageForm, elements]);
    // Each option is the run with that option, as the clamp would leave it: a ratio moves
    // the resolution where the model ties the two (GPT Image 2's 4K is 16:9's alone).
    const settingsAxes = useMemo<Array<readonly [string, readonly CatalogPrimitive[]]>>(() => [
        ['aspectRatio', model.aspectRatios],
        showResolutionControl ? ['resolution', availableResolutions] : ['qualityMode', qualityModes],
    ], [model.aspectRatios, showResolutionControl, availableResolutions, qualityModes]);
    const variants = useMemo(() => (settingsOpen ? settingsVariants(quoteRequest, settingsAxes, (settings) => ({
        ...settings,
        ...fitImageFormToModel(selectedModel, settings as ImageFormSettings),
    })) : NO_SETTINGS_VARIANTS), [settingsOpen, quoteRequest, settingsAxes, selectedModel]);
    const priceOf = useQuotePrices([...[...modelRuns.values()].map((run) => run.quoteInput), ...variants.values()]);
    const optionPrice = optionPricesOf(variants, priceOf, listBalance, isVisitor ? 'the free credits' : 'your balance');
    const sameRatioPrice = samePriceForEach(model.aspectRatios.map((ratio) => optionPrice('aspectRatio', ratio)?.cost ?? null));
    const smallestOver = smallestOverBalance(optionPrice, sameRatioPrice ? settingsAxes.slice(1) : settingsAxes);
    // A page the start keeps refusing at its own price waits for a reload, not another press.
    const quotePending = quoteUi.blocksGenerate || quoteState.pageOutOfDate;
    const quoteRetry = quoteState.status === 'error' ? <StudioQuoteRetry message={quoteUi.message} onRetry={quoteState.retry} /> : null;
    // Only what the request carries can be mentioned: the server refuses a mention
    // of a picture it was not sent.
    const sentElements = runInputs.map((input) => input.element);
    const sentElementHandles = sentElements.map((element) => element.handle);
    const referencedElementHandles = extractPromptHandles(prompt).filter((handle) => sentElementHandles.includes(handle));
    const isElementEnhancementLocked = referencedElementHandles.length > 0;
    const staleElementMentions = findUnknownPromptHandles(prompt, sentElementHandles);
    // The selected model's own prompt limit (Kie refuses past it), counted as the run
    // sends the prompt. Text past it is kept and marked over, after a paste or a switch to
    // a model with a lower limit alike, and the run waits with the start's own words.
    const hasReferenceImages = sentElements.length > 0;
    const promptMeter = promptLengthMeter(prompt, promptLimitFor(selectedModel, { hasReferenceImages }).maxLength);
    const promptLimitMessage = prompt.trim()
        ? creatorPromptViolation(selectedModel, model.displayName, { prompt, hasReferenceImages })
        : null;
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

    // The run's settings read back as the app's bar reads them: "1K · AUTO · JPG". The format is the
    // model's descriptor's; until that is in, the opening's for the model the page opened on.
    const outputFormat = additionalSettings.settings.outputFormat
        ?? (selectedModel === opening?.modelId ? opening.settings.outputFormat : undefined);
    const settingsSummary = [
        showResolutionControl
            ? resolution
            : qualityModes.length > 0
                // Grok prices an edit apart from its quality modes.
                ? `${qualityMode}${isGrokImageModel && elements.length > 0 ? ' edit' : ''}`
                : null,
        aspectRatio,
        typeof outputFormat === 'string' ? outputFormat : null,
    ]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .map((value) => value.toUpperCase())
        .join(' · ') || 'Settings';

    const forgetPendingStart = () => {
        clearPendingWebStart('image');
        setPendingStart(null);
        setPendingStartNotice(null);
    };

    const handleStartRefusal = (refusal: unknown, run: CatalogGenerationRequestPayload) => {
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
            void persistUploadedImageElements(elementRefs.current);
        }
        setError(message);
        if (code === 'prompt_blocked' || code === 'INVALID_GENERATION_REQUEST') {
            promptTextareaRef.current?.focus();
        } else if (code === 'cost_changed') {
            // Priced again at once: Generate shows what the run costs now, and the
            // next press sends that price.
            quoteState.costChanged(run);
        }
    };

    const followRun = async (
        predictionId: string,
        // `followed`: the creator started this run here, so its end moves the focus; a run picked up on load leaves the page be.
        run: { startedAtMs: number; estimatedTotalMs: number | null; cost: number | null; generationId: string | null; followed: boolean },
    ) => {
        const held = run.cost;
        setRunShape((current) => (current ? { ...current, cost: held ?? current.cost, answered: true } : current));
        try {
            const result = await pollPrediction(predictionId, run.startedAtMs, run.estimatedTotalMs);
            setOutputImage(result.output);
            setOutputImages(result.outputs);
            if (run.followed) setRunEndKey((key) => key + 1);
            if (result.timing) {
                setGenerationTiming(result.timing);
            }
        } catch (err) {
            if (isGenerationStatusAbortError(err)) return;
            if (err instanceof Error && err.message === BACKGROUND_PROCESSING_ERROR) {
                handoffToBackgroundProcessing(run.startedAtMs);
                return;
            }
            if (err instanceof ImageRunFailedError) {
                // The failure returned the credits; the balance on screen still has them spent.
                window.dispatchEvent(new Event('credits_updated'));
                setRunFailure({ message: err.message, cost: run.cost });
                if (run.followed) setRunEndKey((key) => key + 1);
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
    const runStart = async (
        start: PendingWebStart,
        timing: { startedAtMs: number; estimatedTotalMs: number | null },
        { reveal }: { reveal: boolean },
    ) => {
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
            handleStartRefusal(startError, start.body as CatalogGenerationRequestPayload);
            return;
        }
        forgetPendingStart();
        quoteState.started(start.body as CatalogGenerationRequestPayload);
        setLatestGenerationId(started.generationId ?? null);
        announceGenerationStarted();
        updateCredits(started.remainingCredits);
        // Only now, and only for a press: a refusal is said in the bar, which a
        // scroll to the canvas would take out of view, and a run resumed on load
        // leaves the page where it opened.
        if (reveal) setCanvasRevealKey((key) => key + 1);
        await followRun(started.predictionId, {
            ...timing,
            cost: started.cost,
            generationId: started.generationId ?? null,
            followed: reveal,
        });
    };

    const replayPendingStart = async (start: PendingWebStart, { reveal }: { reveal: boolean }) => {
        if (activeGenerationRequestKeyRef.current) return;
        activeGenerationRequestKeyRef.current = start.idempotencyKey;
        const createdAtMs = Date.parse(start.createdAt);
        const startedAtMs = Number.isNaN(createdAtMs) ? Date.now() : createdAtMs;
        setIsGenerating(true);
        setError(null);
        setRunFailure(null);
        setCreditRefusal(null);
        setSubmittedPrompt(typeof start.body.prompt === 'string' ? start.body.prompt : '');
        setRunShape((current) => current ?? {
            aspectRatio: null,
            label: imageModelName(start.body.modelId),
            cost: typeof start.body.expectedCostCredits === 'number' ? start.body.expectedCostCredits : null,
            answered: false,
        });
        setGenerationTiming(createLocalGenerationTiming({
            kind: 'image',
            phaseLabel: 'Checking your last run',
            startedAtMs,
            estimatedTotalMs: null,
        }));
        try {
            await runStart(start, { startedAtMs, estimatedTotalMs: null }, { reveal });
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
                await replayPendingStart(pendingWebStart, { reveal: false });
                return;
            }

            const { data, error: pendingError } = await supabase
                .from('generations')
                .select('id, prediction_id, status, created_at, prompt, cost, model')
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
            setSubmittedPrompt(typeof data.prompt === 'string' ? data.prompt : '');
            setRunShape({ aspectRatio: null, label: imageModelName(data.model), cost: typeof data.cost === 'number' ? data.cost : null, answered: true });
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
                    followed: false,
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
        requestInputs: ImageRunInput<ImageElementDraft>[],
        startedAtMs: number,
        estimatedTotalMs: number | null,
    ): Promise<NonNullable<CatalogGenerationRequestPayload['inputs']>> => {
        if (requestInputs.length === 0) return [];
        const requestElements = requestInputs.map((input) => input.element);
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
            // Saved now: a reload runs no cleanup, so this is the copy's only way past one.
            void persistUploadedImageElements(elementRefs.current);
        }

        const prepared = results.map((result) => {
            if (result.status === 'rejected') throw result.reason;
            return result.value;
        });
        return prepared.map(({ element, url, storagePath, sourceGenerationId }, index) => ({
            slot: requestInputs[index].slot,
            kind: requestInputs[index].kind,
            url,
            label: element.displayName ?? `Reference ${index + 1}`,
            handle: element.handle ?? null,
            storagePath,
            sourceGenerationId,
        }));
    };

    const handleGenerate = async () => {
        if (activeGenerationRequestKeyRef.current) return;
        // A new run takes the publish form away: a publish in flight is let finish first.
        if (canvasPublish.inFlight) return;
        const submitted = prompt.trim();
        if (!submitted) { setError('Please enter a prompt'); return; }
        if (staleElementMentions.length > 0) {
            setError(`Unknown element mention${staleElementMentions.length > 1 ? 's' : ''}: ${staleElementMentions.join(', ')}`);
            return;
        }
        if (referenceLimitMessage || promptLimitMessage) return;
        if (newBuildAvailable && !remixId) {
            // A page older than the server may send what it no longer takes. The draft
            // is saved and comes back after the reload; a remix keeps no draft, so it
            // sends from this page instead.
            await reloadPage();
            return;
        }
        if (isVisitor) {
            // Signed out: the sign-up comes back here, on this page's own link, with the
            // draft saved, and nothing runs until Generate is pressed again.
            await openSignUp('generate');
            return;
        }

        const idempotencyKey = createGenerationIdempotencyKey('image');
        activeGenerationRequestKeyRef.current = idempotencyKey;
        setIsGenerating(true);
        setError(null);
        setRunFailure(null);
        setCreditRefusal(null);
        setOutputImage(null);
        setOutputImages([]);
        setResultPreviewImage(null);
        setIsResultPreviewOpen(false);
        setLatestGenerationId(null);
        setSubmittedPrompt(submitted);
        setRunShape({ aspectRatio, label: `${model.displayName} · ${settingsSummary}`, cost: currentCost, answered: false });
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

            const inputs = await stageReferenceInputs(runInputs, startedAtMs, estimatedTotalMs);

            setGenerationTiming(createLocalGenerationTiming({
                kind: 'image',
                phaseLabel: 'Submitting image run',
                startedAtMs,
                estimatedTotalMs,
            }));

            // The price on Generate goes with the run when it is this run's own quote.
            const body = webCatalogStartRequest({
                kind: 'image',
                modelId: selectedModel,
                prompt: submitted,
                settings: generationSettings,
                inputs,
                sourceGenerationId: remixId || undefined,
                catalogRevision: modelCatalog.catalog?.revision ?? '',
            }, quoteState);
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
            await runStart(start, { startedAtMs, estimatedTotalMs }, { reveal: true });
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

    // Where the run is, as the canvas says it (read before the sign-in check below returns early,
    // as every hook is): what it shows of the run goes to the shell's run toasts, which would only
    // say its end again, over Publish.
    const canvasPhase = creatorCanvasPhase({ hasResult: Boolean(outputImage), isGenerating, isBackgroundProcessing, hasFailure: runFailure !== null });
    useAnnounceRunOnPage(latestGenerationId, creatorCanvasFollowsRun(canvasPhase), creatorCanvasSettledStatus(canvasPhase));

    if (isLoadingUser) {
        return (
            <div className="ui-page min-h-screen text-[var(--ui-text-primary)] flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-zinc-500" />
            </div>
        );
    }

    const displayedOutputImages = outputImages.length > 0
        ? outputImages
        : (outputImage ? [outputImage] : []);

    // The canvas says where the run is (the artboards Main, Generating, Failed and Result),
    // and its chip what the run is and holds.
    const canvasTitle = creatorCanvasTitle(canvasPhase, { making: 'Making your image', waiting: 'Your image' });
    const canvasChip = creatorCanvasChip(canvasPhase, runShape?.label, runShape?.cost);
    const showsEmptyCanvas = canvasPhase === 'empty';
    const showsRunFailure = canvasPhase === 'failed';

    // What the run needs, as the column's cards ask for it.
    const emptyCanvasHint = model.maxImages > 0
        ? 'Write a prompt, add reference images if you like, then Generate.'
        : 'Write a prompt, then Generate.';
    const canAddReferences = elements.length < model.maxImages;
    const imageAccent = getAccentClasses('image');
    // A visitor's press needs no price: it checks the form, then asks for an account.
    const generateBlocked = !prompt.trim()
        || (!isVisitor && quotePending)
        || staleElementMentions.length > 0
        || Boolean(referenceLimitMessage)
        || Boolean(promptLimitMessage);
    const isAwaitingStartCheck = Boolean(pendingStart) && !isGenerating;

    // What stops or explains a run, said just above the bar. Progress is drawn on
    // the canvas; a run in the background is named here too, beside Generate.
    const runStatus = isGenerating ? null : isBackgroundProcessing ? (
        <CreatorBackgroundRunLine title={backgroundProcessingCopy.title} />
    ) : pendingStart ? (
        <CreatorPendingStartNotice
            message={pendingStartNotice ?? START_UNCONFIRMED_MESSAGE}
            costLabel={quoteUi.costLabel}
            hasPrice={currentCost !== null}
            disabled={generateBlocked}
            onStartNew={handleStartNewRun}
        />
    ) : referenceLimitMessage ? (
        <p className="text-red-400">{referenceLimitMessage}</p>
    ) : promptLimitMessage ? (
        <p className="text-red-400">{promptLimitMessage}</p>
    ) : quoteState.pageOutOfDate ? (
        // In place of the start's refusal it stands for.
        <StudioOutOfDatePageNotice
            isRemix={Boolean(remixId)}
            reloadDidNotHelp={reloadBroughtBackThisBuild()}
            onReload={() => void reloadPage()}
        />
    ) : error ? (
        // A price that could not be read since (asked again after
        // `cost_changed`, say) keeps its Retry under the error:
        // Generate waits for a price.
        <div className="space-y-2">
            <p className="text-red-400">{error}</p>
            {quoteRetry}
        </div>
    ) : staleElementMentions.length > 0 ? (
        <p className="text-rose-300">
            Resolve the unknown element mention{staleElementMentions.length > 1 ? 's' : ''} before generating:{' '}
            <StudioElementHandleList handles={staleElementMentions} />
        </p>
    ) : quoteState.status === 'error' ? (
        quoteRetry
    ) : null;
    const topUpNotice = showTopUp && !isAwaitingStartCheck && !isGenerating ? (
        <CreatorTopUpNotice cost={currentCost} balance={userCredits} message={creditRefusalMessage} />
    ) : null;
    const barStatus = topUpNotice || runStatus ? (
        <div className="space-y-3">
            {topUpNotice}
            {runStatus}
        </div>
    ) : null;

    const barAction = (
        <CreatorBarAction
            awaitingCheck={isAwaitingStartCheck}
            onCheckAgain={() => {
                if (pendingStart) void replayPendingStart(pendingStart, { reveal: true });
            }}
            showTopUp={showTopUp}
            isGenerating={isGenerating}
            disabled={generateBlocked || canvasPublish.inFlight}
            costLabel={quoteUi.costLabel}
            hasPrice={currentCost !== null}
            onGenerate={handleGenerate}
            signUp={isVisitor}
        />
    );

    // The model list's rows: each model's price at this run's settings, what it is for, and
    // what it keeps of the run's pictures.
    const selectedPrice = listedFromQuote(quoteState);
    const pickerRows: PickerModelRow[] = filteredImageModelOptions.map((option) => {
        const run = modelRuns.get(option.id);
        const isSelected = option.id === selectedModel;
        // What each model sends of the pictures on the grid, which stay there for a model that takes them.
        const kept = isSelected ? runInputs.length : run?.inputs.length ?? null;
        return {
            id: option.id,
            name: option.displayName,
            description: option.description,
            price: isSelected
                ? selectedPrice
                : run
                    ? priceOf(run.quoteInput)
                    : { status: modelCatalog.error || modelCatalog.missingIds.includes(option.id) ? 'unavailable' : 'pending' },
            summary: isSelected ? imageRunSummary({ resolution, aspectRatio }) : run?.summary ?? null,
            keeps: kept === null ? null : referenceKeepWords(elements.length, kept),
        };
    });

    const settingsPanel = (
        <div className="space-y-5">
            <CreatorSettingChoices
                label="Aspect ratio"
                hint={sameRatioPrice ? 'Same price for each' : undefined}
                options={model.aspectRatios}
                value={aspectRatio}
                onChange={setAspectRatio}
                columns={5}
                optionPrice={sameRatioPrice ? undefined : (value) => optionPrice('aspectRatio', value)}
            />

            {showResolutionControl ? (
                <CreatorSettingChoices
                    label="Resolution"
                    hint="Higher detail costs more credits."
                    options={availableResolutions}
                    value={resolution}
                    onChange={setResolution}
                    columns={3}
                    optionPrice={(value) => optionPrice('resolution', value)}
                />
            ) : qualityModes.length > 0 ? (
                <CreatorSettingChoices
                    // The descriptor already labels this control per model ("Speed" for the
                    // Ideogram tiers, "Quality" elsewhere), so a new model with quality modes
                    // no longer lands under a heading naming a different vendor.
                    label={imageAffordances?.qualityModeLabel
                        ? `Generation ${imageAffordances.qualityModeLabel.toLowerCase()}`
                        : (selectedModel === 'ideogram-v3' ? 'Generation speed' : 'Grok quality')}
                    hint={selectedModel === 'grok-imagine-image'
                        ? 'Quality applies to prompt-only Grok runs; edits use fixed image-to-image pricing.'
                        : 'Choose faster drafts or spend more credits for final-detail output.'}
                    options={qualityModes}
                    value={qualityMode}
                    onChange={setQualityMode}
                    columns={qualityModes.length === 3 ? 3 : 2}
                    capitalize
                    optionPrice={(value) => optionPrice('qualityMode', value)}
                />
            ) : null}

            {model.supportsGoogleSearch ? (
                <CreatorSettingSwitch
                    label="Google Search grounding"
                    description="Allow the model to pull in live context when it helps."
                    checked={googleSearch}
                    onChange={setGoogleSearch}
                />
            ) : null}

            <CreatorOverBalanceLegend over={smallestOver} balance={listBalance} isVisitor={isVisitor} offersTopUp={!isVisitor} />

            <CatalogAdditionalControls appearance="panel" descriptor={catalogDescriptor} handledKeys={CATALOG_HANDLED_KEYS} settings={{ aspectRatio, resolution, qualityMode, googleSearch, ...additionalSettings.settings }} inputCounts={{ images: elements.length, videos: 0, audios: 0 }} onChange={additionalSettings.onChange} />
        </div>
    );

    // Done (the artboard Result): the picture, its download, and the publish form beside it; Posted once it went.
    const imageDownload = outputImage ? {
        href: outputImageDownloadUrl ?? outputImage,
        fileName: `generated-image.${getImageFileExtension(outputImage)}`,
        label: 'Download image',
    } : null;
    const publishPanel = canvasPublish.panel && imageDownload ? (
        <CreatorPublishPanel
            key={canvasPublish.panel.generationId}
            {...canvasPublish.panel}
            sourceSurface="create-image"
            download={imageDownload}
            next={userCredits !== null ? (
                <CreatorPostedNext
                    balance={userCredits}
                    runCost={runShape?.cost ?? currentCost}
                    onMakeAnother={() => promptTextareaRef.current?.focus()}
                />
            ) : null}
        />
    ) : null;

    return (
        <div className="ui-page ui-page-ambient min-h-screen py-4 text-[var(--ui-text-primary)] sm:py-6 font-[family-name:var(--font-geist-sans)]">
            <CreatorColumnLayout
                resultFirst={canvasPhase === 'done'}
                title="Create image"
                column={
                    <>
                        <CreatorToolTabs currentToolId="image" />
                        {welcome && !isVisitor ? <CreatorWelcomeCard welcome={welcome} carriedDraft={carriedDraft} /> : null}

                        <div className="flex items-start gap-2">
                        <div className="relative min-w-0 flex-1" ref={dropdownRef}>
                            <CreatorModelChip
                                name={model.displayName}
                                badge={model.badge}
                                badgeClassName={model.badgeColor}
                                isOpen={isModelDropdownOpen}
                                onToggle={() => {
                                    if (isModelDropdownOpen) setModelSearchQuery('');
                                    setIsModelDropdownOpen(!isModelDropdownOpen);
                                }}
                            />

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
                                footer={<CreatorModelPickerFoot />}
                            >
                                <CreatorModelPickerRows
                                    rows={pickerRows}
                                    selectedId={selectedModel}
                                    balance={listBalance}
                                    balanceLabel={isVisitor ? `the ${listBalance} free credits` : `your ${listBalance} credits`}
                                    accent="image"
                                    onSelect={(id) => {
                                        // A notice about the previous model no longer applies.
                                        if (id !== selectedModel) setCatalogNotice(null);
                                        // The creator's pick is the first pick: the catalog's default no longer replaces it.
                                        hasResolvedInitialCatalogModel.current = true;
                                        setSelectedModel(id as ModelId);
                                        setIsModelDropdownOpen(false);
                                        setModelSearchQuery('');
                                    }}
                                />
                            </StudioModelPicker>
                        </div>
                        </div>
                        {/* Until the first run this visit: back over the prompt after one, it pushed the field the creator went to. */}
                        {showsEmptyCanvas && canvasRevealKey === 0 ? <CreatorStartPostsStrip source={startPosts} tool="image" balance={listBalance} /> : null}

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

                        <div className={`rounded-ui-2xl border bg-[var(--ui-surface-1)] transition-colors duration-150 ${imageAccent.outline}`}>
                            <label htmlFor="create-image-prompt" className="ui-kicker block px-4 pt-4">
                                Prompt
                            </label>
                            <textarea
                                id="create-image-prompt"
                                ref={promptTextareaRef}
                                value={prompt}
                                onChange={(e) => handlePromptChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
                                onClick={syncPromptCaretState}
                                onKeyUp={syncPromptCaretState}
                                placeholder="Describe the image you want to create..."
                                maxLength={GENERATION_PROMPT_MAX_LENGTH}
                                aria-invalid={promptMeter.state === 'over' || undefined}
                                className="block min-h-[176px] w-full resize-y bg-transparent px-4 pb-2 pt-2 text-sm leading-6 text-[var(--ui-text-primary)] outline-none placeholder:text-[var(--ui-text-faint)]"
                            />
                            <div className="flex items-center justify-between gap-3 px-4 pb-3 text-xs">
                                <PromptLengthCounter meter={promptMeter} suffix=" characters" />
                                {staleElementMentions.length > 0 ? (
                                    <p className="min-w-0 text-right text-rose-300">
                                        Unknown element mention{staleElementMentions.length > 1 ? 's' : ''}:{' '}
                                        <StudioElementHandleList handles={staleElementMentions} />
                                    </p>
                                ) : null}
                            </div>
                        </div>

                        {activeMentionQuery ? (
                            <CreatorMentionPanel
                                title="Insert element"
                                hint={mentionSuggestions.length > 0 ? 'Pick an element to insert its @mention.' : 'No matching elements yet.'}
                                query={activeMentionQuery.query}
                                suggestions={mentionSuggestions}
                                handleClassName={() => 'text-sky-300'}
                                onInsert={handleInsertElementHandle}
                            />
                        ) : null}

                        <EnhancePromptButton
                            variant="toolbar"
                            leading={<CreatorTemplatesTile />}
                            prompt={prompt}
                            onEnhanced={(text) => setPrompt(text)}
                            onCreditsUpdate={updateCredits}
                            onRequireAccount={isVisitor ? () => void openSignUp('enhance') : undefined}
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

                        {/* Elements kept from another model stay here with their remove
                            buttons, even on a prompt-only model: the limit message asks the
                            creator to remove the extras, and this is the only place to do it. */}
                        {model.maxImages > 0 || elements.length > 0 ? (
                            <section
                                aria-labelledby="create-image-references"
                                // A drop is taken only while one more fits: at the cap, or on a
                                // prompt-only model keeping references, nothing can be added.
                                onDragOver={canAddReferences ? handleDragOver : undefined}
                                onDragLeave={canAddReferences ? (event) => {
                                    // Leaving a row for the section is not leaving the section.
                                    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                                    handleDragLeave(event);
                                } : undefined}
                                onDrop={canAddReferences ? handleDrop : undefined}
                                className={isDragging ? `rounded-ui-2xl border p-4 ${imageAccent.tileActive}` : 'ui-card p-4'}
                            >
                                <div className="mb-1 flex items-center justify-between gap-3">
                                    <h2 id="create-image-references" className="text-xs font-bold text-[var(--ui-text-muted)]">Reference images</h2>
                                    <span className="text-xs font-bold tabular-nums text-[var(--ui-text-faint)]">
                                        {elements.length}/{model.maxImages}
                                    </span>
                                </div>
                                {model.maxImages > 0 ? (
                                    <p className="mb-3 text-xs text-[var(--ui-text-faint)]">Type @ in the prompt to use one by its name.</p>
                                ) : (
                                    <p className="mb-3 mt-2 text-sm text-[var(--ui-text-muted)]">
                                        {model.displayName} does not take reference images. These are kept for another model; remove them to generate here.
                                    </p>
                                )}

                                {elements.length > 0 ? (
                                    <ul className="mb-3 space-y-2">
                                        {elements.map((element) => (
                                            <CreatorReferenceRow
                                                key={element.id}
                                                accent="image"
                                                preview={
                                                    <button
                                                        type="button"
                                                        onClick={() => setUploadPreview({
                                                            type: 'image',
                                                            src: element.previewUrl,
                                                            alt: element.displayName,
                                                            title: element.displayName,
                                                        })}
                                                        aria-label={`Preview ${element.displayName}`}
                                                        className="ui-focus-ring group relative h-16 w-16 shrink-0 overflow-hidden rounded-ui-md border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)]"
                                                    >
                                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                                        <img
                                                            src={element.previewUrl}
                                                            alt={element.displayName}
                                                            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.04]"
                                                        />
                                                    </button>
                                                }
                                                displayName={element.displayName}
                                                nameDraft={elementNames.drafts[element.id]}
                                                placeholder="Rename element"
                                                onNameChange={(value) => handleElementDraftChange(element.id, value)}
                                                onNameCommit={() => void commitElementDraft(element.id)}
                                                onNameCancel={() => elementNames.dropDraft(element.id)}
                                                onRemove={() => void handleRemoveElement(element.id)}
                                                handle={element.handle}
                                                handleClassName="text-sky-300"
                                                onInsert={() => handleInsertElementHandle(element.handle)}
                                            />
                                        ))}
                                    </ul>
                                ) : null}

                                {canAddReferences ? (
                                    <CreatorAddTile
                                        accent="image"
                                        icon={Plus}
                                        label={isDragging ? 'Drop element images here' : 'Add reference images'}
                                        input={{ accept: 'image/*', multiple: true, onChange: handleImageUpload }}
                                        dragging={isDragging}
                                    />
                                ) : null}
                                {elementPickNotice ? (
                                    <p role="status" className="mt-3 text-sm text-amber-200">{elementPickNotice}</p>
                                ) : null}
                            </section>
                        ) : (
                            <div className="ui-card flex items-start gap-3 p-4 text-sm text-[var(--ui-text-secondary)]">
                                <ImageIcon aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 ${imageAccent.mark}`} />
                                <div>
                                    <div className="font-semibold text-[var(--ui-text-primary)]">Prompt-only model</div>
                                    <p className="mt-1 leading-relaxed text-[var(--ui-text-muted)]">
                                        {model.displayName} does not accept reference images. Switch models whenever you need identity, product, or style anchors.
                                    </p>
                                </div>
                            </div>
                        )}

                        <CreatorColumnBar
                            holdsFootUnderColumn={!(publishPanel && !canvasPublish.posted)}
                            settingsSummary={settingsSummary}
                            settings={settingsPanel}
                            settingsFootNote={<CreatorSettingsFootNote cost={currentCost} costLabel={quoteUi.costLabel} balance={listBalance} isVisitor={isVisitor} />}
                            settingsOpen={settingsOpen}
                            onSettingsOpenChange={setSettingsOpen}
                            status={barStatus}
                            narrowStatus={showsRunFailure ? (
                                <CreatorRunFailedLine returnedCredits={runFailure?.cost ?? null} onSeeWhy={() => setRunEndKey((key) => key + 1)} />
                            ) : null}
                            action={barAction}
                            note={isVisitor
                                ? <CreatorVisitorNote welcomeCredits={visitorWelcomeCredits} cost={notedCost} />
                                : userCredits !== null ? <CreatorBalanceNote balance={userCredits} cost={notedCost} /> : undefined}
                        />
                    </>
                }
                canvas={
                    <CreatorCanvas
                        title={canvasTitle}
                        chip={canvasChip}
                        revealKey={canvasRevealKey}
                        focusKey={runEndKey}
                        flow={canvasPhase !== 'failed' && canvasPhase !== 'background'}
                        showStudioLink={!isVisitor}
                    >
                        {outputImage ? (
                            <CreatorDoneLayout
                                key={outputImage}
                                ratio={parseAspectRatio(runShape?.aspectRatio ?? aspectRatio)}
                                media={(
                                    <div className={displayedOutputImages.length > 1 ? 'grid w-full grid-cols-2 gap-3' : 'flex w-full justify-center'}>
                                        {displayedOutputImages.map((imageUrl, index) => (
                                            <div key={`${imageUrl}-${index}`} className="relative flex min-w-0 items-center justify-center">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setResultPreviewImage(imageUrl);
                                                        setIsResultPreviewOpen(true);
                                                    }}
                                                    className="ui-focus-ring flex w-full items-center justify-center rounded-ui-xl"
                                                    aria-label={`Preview generated image ${index + 1}`}
                                                >
                                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                                    <img
                                                        src={imageUrl}
                                                        alt={`Generated image ${index + 1}`}
                                                        className="max-h-[60svh] w-auto max-w-full rounded-ui-xl object-contain min-[1120px]:max-h-[calc(100dvh-var(--app-shell-topbar-height)-17rem)]"
                                                    />
                                                </button>
                                                {displayedOutputImages.length > 1 ? (
                                                    <a
                                                        href={getOutputImageDownloadUrl(imageUrl, index) ?? imageUrl}
                                                        download={`generated-image-${index + 1}.${getImageFileExtension(imageUrl)}`}
                                                        aria-label={`Download result ${index + 1}`}
                                                        className="ui-focus-ring absolute bottom-2 right-2 inline-flex h-12 w-12 items-center justify-center rounded-full bg-black/65 text-white transition-colors hover:bg-black/85"
                                                    >
                                                        <Download className="h-4 w-4" />
                                                    </a>
                                                ) : null}
                                            </div>
                                        ))}
                                    </div>
                                )}
                                mediaFoot={imageDownload ? (
                                    <div className="space-y-2">
                                        {submittedPrompt ? <p className="line-clamp-2 text-xs leading-5 text-[var(--ui-text-faint)]">{submittedPrompt}</p> : null}
                                        {displayedOutputImages.length > 1 ? (
                                            <p className="text-center text-xs text-[var(--ui-text-faint)]">{displayedOutputImages.length} options. The first is the one you publish.</p>
                                        ) : null}
                                        <CreatorDownloadButton {...imageDownload} />
                                    </div>
                                ) : null}
                                panel={publishPanel}
                            />
                        ) : isGenerating ? (
                            <>
                                <CreatorCanvasStage>
                                    <CreatorCanvasFrame aspectRatio={runShape?.aspectRatio ?? aspectRatio} busy>
                                        <ImageIcon aria-hidden className="h-6 w-6 text-[var(--ui-primary)]" />
                                        {generationTiming ? (
                                            <div className="w-full max-w-72">
                                                <StudioGenerationStatus accent={model.accentColor} timing={generationTiming} nowMs={nowMs} />
                                            </div>
                                        ) : (
                                            <p role="status" className="text-sm font-semibold text-[var(--ui-text-primary)]">Building your image</p>
                                        )}
                                    </CreatorCanvasFrame>
                                </CreatorCanvasStage>
                                {runShape?.answered ? <CreatorRunWaitLines noun="image" heldCredits={runShape.cost} /> : null}
                                <CreatorWhileYouWait source={startPosts} tool="image" />
                            </>
                        ) : isBackgroundProcessing ? (
                            <div className="w-full max-w-md">
                                <StudioBackgroundProcessingNotice
                                    accent={model.accentColor}
                                    label="image"
                                    phaseLabel={backgroundTiming?.phaseLabel ?? null}
                                    timingLabel={backgroundTimingLabel}
                                />
                            </div>
                        ) : runFailure ? (
                            <CreatorRunFailed
                                cause={describeRunFailure(runFailure.message, 'image')}
                                returnedCredits={runFailure.cost}
                                retryLabel={currentCost !== null ? `Try again · ${quoteUi.costLabel}` : 'Try again'}
                                retryDisabled={generateBlocked || showTopUp}
                                onRetry={() => void handleGenerate()}
                                retryable={isRetryableProviderFailure(runFailure.message)}
                                onPickModel={() => setIsModelDropdownOpen(true)}
                                onChangePrompt={() => {
                                    setRunFailure(null);
                                    promptTextareaRef.current?.focus();
                                }}
                            />
                        ) : (
                            <CreatorEmptyCanvas
                                source={startPosts}
                                tool="image"
                                balance={listBalance}
                                icon={ImageIcon}
                                title={isVisitor ? 'Try it before you sign up' : 'Your image will appear here'}
                                hint={`${isVisitor ? CREATOR_VISITOR_CANVAS_HINT : emptyCanvasHint} Or remix a post below.`}
                                frame={(
                                    <CreatorCanvasStage>
                                        <CreatorCanvasFrame aspectRatio={aspectRatio}>
                                            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)]">
                                                <ImageIcon className="h-5 w-5 text-[var(--ui-text-muted)]" />
                                            </span>
                                            <p className="text-sm font-semibold text-[var(--ui-text-secondary)]">{isVisitor ? 'Try it before you sign up' : 'Your image will appear here'}</p>
                                            <p className="text-xs leading-5 text-[var(--ui-text-faint)]">{isVisitor ? CREATOR_VISITOR_CANVAS_HINT : emptyCanvasHint}</p>
                                        </CreatorCanvasFrame>
                                    </CreatorCanvasStage>
                                )}
                            />
                        )}
                    </CreatorCanvas>
                }
            />

            <CreatorSignUpSheet
                reason={signUpReason}
                handsOverDraft={draftOwner === VISITOR_DRAFT_OWNER}
                tool="image"
                welcomeCredits={visitorWelcomeCredits}
                runCost={currentCost}
                modelName={model.displayName}
                settingsSummary={settingsSummary}
                keepsPrompt={Boolean(prompt.trim())}
                keepsImages={elements.length > 0}
                onClose={() => setSignUpReason(null)}
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
