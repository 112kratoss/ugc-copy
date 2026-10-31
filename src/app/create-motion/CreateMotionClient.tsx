'use client';

import { readVideoDurationSeconds } from '@/lib/video-metadata-probe';
import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import GenerationResultVideo from '@/components/GenerationResultVideo';
import { Loader2, Check, Play, Image as ImageIcon, Video } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import {
    StudioBackgroundProcessingNotice,
    StudioGenerationStatus,
    StudioMediaPreviewModal,
    StudioModelNotice,
    StudioOutOfDatePageNotice,
    StudioQuoteRetry,
    StudioRemixHydrationNotice,
    StudioRemixNotice,
} from '@/components/CreatorStudio';
import {
    CreatorBackgroundRunLine,
    CreatorBalanceNote,
    CreatorBarAction,
    CreatorCanvas,
    CreatorCanvasFrame,
    CreatorCanvasMedia,
    CreatorCanvasStage,
    CreatorColumnBar,
    CreatorColumnLayout,
    CreatorModelChip,
    CreatorOverBalanceLegend,
    CreatorPendingStartNotice,
    CreatorRunFailed,
    CreatorRunFailedLine,
    CreatorRunWaitLines,
    CreatorSettingChoices,
    CreatorSettingsFootNote,
    CreatorTemplatesTile,
    CreatorToolTabs,
    CreatorTopUpNotice,
    CreatorUploadSlot,
    CreatorVisitorNote,
    creatorCanvasChip,
    describeRunFailure,
} from '@/components/CreatorColumn';
import { CreatorEmptyCanvas, CreatorStartPostsStrip, CreatorWhileYouWait, type StartPostsSource } from '@/components/CreatorStartPosts';
import {
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
import { motionSettingsSummary } from '../../../ugc-mobile/lib/creator-settings-summary/creator-settings-summary';
import StudioModelPicker from '@/components/StudioModelPicker';
import CatalogAdditionalControls, { catalogChoiceDefault, useAdditionalCatalogSettings } from '@/components/CatalogAdditionalControls';
import { CreatorDoneLayout, CreatorDownloadButton, CreatorPostedNext, CreatorPublishPanel, useCreatorPublish } from '@/components/CreatorPublish';
import { creatorCanvasFollowsRun, creatorCanvasPhase, creatorCanvasSettledStatus, creatorCanvasTitle } from '@/lib/creator-canvas-phase';
import EnhancePromptButton from '@/components/EnhancePromptButton';
import { useAuth } from '@/components/AuthProvider';
import type { RemixMediaAssetDescriptor, RemixSourceBundle } from '@/lib/remix-source';
import { hasCreatorEditedPromptDuringRemix } from '@/lib/remix-source';
import {
    createRestoredRemixAssetState,
    getRemixRestoreWarning,
} from '@/lib/remix-source-client';
import type { CatalogGenerationRequestPayload } from '@/lib/generation-model-adapters';
import {
    getPersistedFile,
    PERSISTED_MEDIA_KEYS,
    purgeLegacyPersistedMedia,
    removePersistedMedia,
    scopedPersistedMediaKey,
    setPersistedFile,
} from '@/lib/persisted-media';
import { loadCreatorDraft, saveCreatorDraft } from '@/lib/persisted-creator-draft';
import { RECLAIM_AFTER_HOURS } from '@/lib/media-upload-reclaim';
import { BACKGROUND_PROCESSING_ERROR, getBackgroundProcessingCopy } from '@/lib/generation-feedback';
import { createGenerationIdempotencyKey } from '@/lib/generation-idempotency-client';
import {
    announceGenerationStarted,
    fetchCreatorActiveRun,
    fetchGenerationStatusWithRetry,
    GenerationStatusRequestError,
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
import { useCreatorQuote } from '@/lib/use-creator-quote';
import { openingSetting, type CreatorOpening } from '@/lib/creator-opening';
import { reloadBroughtBackThisBuild, reloadForNewerBuild, useDeploymentRefresh } from '@/lib/use-deployment-refresh';
import { heldLengthNote, lengthReading, motionRunClipSlot, planMotionRunInputs } from '@/lib/creator-run-inputs';
import type { CatalogPrimitive } from '@/lib/generation-model-catalog';
// Kie's motion cap; the motion start refuses a longer prompt before anything is held.
import { catalogInputTooShort, catalogRunQuoteInput, MOTION_CLIP_NAME, MOTION_PROMPT_MAX_LENGTH } from '../../../ugc-mobile/lib/model-catalog/protocol';
import { useTicker } from '@/lib/use-ticker';
import {
    refreshTemporaryMediaUrl,
    TEMPORARY_MEDIA_UPLOAD_LIMITS,
    uploadMediaToTemporaryStorage,
} from '@/lib/temporary-media-upload';
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
// The shared mirror is the single client-side registry: it is pinned to the
// server registry by model-registry-parity.test.ts and hydrated in place by
// useWebGenerationModelCatalog when the catalog arrives.
import { MOTION_MODELS } from '@/lib/client-generation-models';

type ModelId = keyof typeof MOTION_MODELS;

interface MotionWorkflowSettings {
    model?: ModelId;
    mode?: '720p' | '1080p';
    characterOrientation?: 'video' | 'image';
    characterImage?: RemixMediaAssetDescriptor;
    referenceVideo?: RemixMediaAssetDescriptor;
}

export interface CreateMotionPrefill {
    remixId?: string | null;
    remixPostId?: string | null;
    prompt?: string | null;
    model?: string | null;
}

interface UploadPreviewState {
    type: 'image' | 'video';
    src: string;
    alt: string;
    title: string;
}

const CATALOG_HANDLED_KEYS = ['resolution', 'characterOrientation', 'duration'] as const;

/** Kie's motion-control limit for the clip, stricter than the sign step's 250 MB. */
const MAX_REFERENCE_VIDEO_BYTES = 100 * 1024 * 1024;
/**
 * How long an uploaded input is sent again by its staged path instead of being
 * uploaded again: the sweep deletes a staged object a run has used
 * RECLAIM_AFTER_HOURS after it was signed, and this leaves eight hours spare.
 */
const STAGED_UPLOAD_REUSE_MS = (RECLAIM_AFTER_HOURS - 8) * 60 * 60 * 1000;
const MOTION_DRAFT_SAVE_DELAY_MS = 500;
const MOTION_INPUTS_HINT = 'Add a character image and a motion clip to see the cost.';
const UNCONFIRMED_START_MESSAGE = 'We couldn’t confirm your generation started. Check again — that can’t start a second run.';

type MotionMode = '720p' | '1080p';
type MotionCharacterOrientation = 'video' | 'image';

/** The text half of a motion draft; its two files are kept beside it in persisted media. */
interface MotionTextDraft {
    prompt: string;
    /** Left out until a model is chosen: the page's placeholder must not pin itself over the catalog default. */
    modelId?: string;
    duration: number;
    characterOrientation: MotionCharacterOrientation;
    mode: MotionMode;
    /**
     * The ?prompt= and ?model= the draft was edited under. Reloading that same
     * link (a deploy, a lost session) restores the draft over them; a new link
     * still sets its own prompt and model.
     */
    linkPrefill?: { prompt: string | null; model: string | null };
}

interface StagedMotionUpload {
    signedUrl: string;
    storagePath: string;
    uploadedAt: number;
}

/** A run that reached a failed status. Its hold is always returned. */
class MotionRunFailedError extends Error {}

/** A run's model as its chip names it, where all the page knows of the run is its model: a start sent before, a run picked up on load. */
function motionModelName(modelId: unknown): string | null {
    return typeof modelId === 'string' ? (MOTION_MODELS as Record<string, { displayName: string } | undefined>)[modelId]?.displayName ?? null : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** What the sign step (and, for the clip, Kie) would refuse, said when the file is picked. */
function describeRefusedMotionPick(file: File, kind: 'image' | 'video'): string | null {
    const name = file.name || (kind === 'image' ? 'This image' : 'This video');
    if (!TEMPORARY_MEDIA_UPLOAD_LIMITS.isAllowedMimeType(kind, file.type)) {
        return kind === 'image'
            ? `"${name}" isn't a supported image. Use a JPG, PNG or WEBP file.`
            : `"${name}" isn't a supported video. Use an MP4 or MOV file.`;
    }
    const maxBytes = kind === 'image' ? TEMPORARY_MEDIA_UPLOAD_LIMITS.maxBytesByKind.image : MAX_REFERENCE_VIDEO_BYTES;
    if (file.size > maxBytes) {
        return `"${name}" is over ${Math.round(maxBytes / (1024 * 1024))} MB. Please upload a smaller ${kind}.`;
    }
    return null;
}

export default function CreateMotionClient({
    prefill,
    returnTo = '/create-motion',
    welcome = null,
    handoverNonce = null,
    visitorWelcomeCredits = null,
    opening = null,
    startPosts = null,
}: {
    prefill: CreateMotionPrefill;
    /** This page with its params, for the sign-in round trip. */
    returnTo?: string;
    /** Back from the sign-up a visitor opened here: the card that adds the welcome credits. */
    welcome?: CreatorWelcome | null;
    /** The sign-up sheet's `?handover=` nonce on the way back: the visitor's draft moves to the account by it. */
    handoverNonce?: string | null;
    /** What a new account starts with, told to a signed-out visitor. */
    visitorWelcomeCredits?: number | null;
    /**
     * The run the server read the page opens on: its model and settings are drawn from the first
     * paint, in place of Kling 3.0's, until the first pick. A motion run is priced by its clip.
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
    const { owner: draftOwner, carriedDraft } = useCreatorDraftOwner('motion', userId, handoverNonce);
    // A page that opened signed out works up to Generate, which asks for an account
    // (owner, 2026-10-28). One whose session lapsed is not a visitor's: it keeps its
    // signed-in face, and its Generate signs in again on the login page.
    const isVisitor = draftOwner === VISITOR_DRAFT_OWNER;
    const [signUpReason, setSignUpReason] = useState<CreatorSignUpReason | null>(null);
    const [selectedModel, setSelectedModel] = useState<ModelId>((opening?.modelId ?? 'kling-3.0') as ModelId);
    const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
    // Open settings price each of their options; the bar says when they open and close.
    const [settingsOpen, setSettingsOpen] = useState(false);
    const modelCatalog = useWebGenerationModelCatalog({ kind: 'motion', selectedIds: [selectedModel], pickerOpen: isModelDropdownOpen });
    const catalogDescriptor = modelCatalog.catalog?.models.find(item => item.id === selectedModel);
    const refetchModelCatalog = modelCatalog.refetch;
    const [modelSearchQuery, setModelSearchQuery] = useState('');
    const dropdownRef = useRef<HTMLDivElement>(null);
    const hasResolvedInitialCatalogModel = useRef(false);
    const activeGenerationRequestKeyRef = useRef<string | null>(null);
    const generationPollAbortControllerRef = useRef<AbortController | null>(null);
    // The look, as the page opens, for a run already at work.
    const activeRunLookupRef = useRef<AbortController | null>(null);

    const [characterImage, setCharacterImage] = useState<string | null>(null);
    const [characterImageFile, setCharacterImageFile] = useState<File | null>(null);
    const [characterImageDescriptor, setCharacterImageDescriptor] = useState<RemixMediaAssetDescriptor | null>(null);
    const [referenceVideo, setReferenceVideo] = useState<string | null>(null);
    const [referenceVideoFile, setReferenceVideoFile] = useState<File | null>(null);
    const [referenceVideoDescriptor, setReferenceVideoDescriptor] = useState<RemixMediaAssetDescriptor | null>(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [generationTiming, setGenerationTiming] = useState<GenerationTiming | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
    const [videoError, setVideoError] = useState<string | null>(null);
    const [outputVideo, setOutputVideo] = useState<string | null>(null);
    const [resolvedOutputVideo, setResolvedOutputVideo] = useState<{ outputUrl: string; url: string } | null>(null);
    const [latestGenerationId, setLatestGenerationId] = useState<string | null>(null);
    const [duration, setDuration] = useState<number>(0);
    const [characterOrientation, setCharacterOrientation] = useState(() => openingSetting<string>(opening, 'characterOrientation', 'video') as 'video' | 'image');
    const [mode, setMode] = useState(() => openingSetting<string>(opening, 'resolution', '720p') as '720p' | '1080p');
    // Bumped once a start the creator pressed is confirmed: the result canvas comes into view.
    const [canvasRevealKey, setCanvasRevealKey] = useState(0);
    // The run in flight's model and settings, which the canvas names while the form changes.
    const [runLabel, setRunLabel] = useState<string | null>(null);
    // What the run in flight holds of the balance, for its canvas.
    const [runCost, setRunCost] = useState<number | null>(null);
    // Whether the run's start answered: the run is the server's, so the page may be left.
    const [runAnswered, setRunAnswered] = useState(false);
    // A run the provider failed, said on the canvas with its cause (the artboard Failed).
    const [runFailure, setRunFailure] = useState<{ message: string; cost: number | null } | null>(null);
    // Bumped when a run this page followed ends, done or failed: the canvas takes the focus.
    const [runEndKey, setRunEndKey] = useState(0);
    // The prompt the run was sent with: the caption under its clip, whatever the form holds by then.
    const [runPrompt, setRunPrompt] = useState<string | null>(null);
    // The settings chip, read as the app's ("720P · 8s", or "Add motion" until a clip is attached:
    // a run picked up on load gives a length with no clip in the form).
    const settingsSummary = motionSettingsSummary({
        quality: mode,
        referenceSeconds: referenceVideo || referenceVideoFile ? duration : null,
    });
    const [prompt, setPrompt] = useState<string>("No distortion, the character's movements are consistent with the video.");
    const [imagePickError, setImagePickError] = useState<string | null>(null);
    const [videoPickError, setVideoPickError] = useState<string | null>(null);
    const [unconfirmedStart, setUnconfirmedStart] = useState(false);
    const [creditRefusal, setCreditRefusal] = useState<{ message: string; balance: number | null; cost: number | null } | null>(null);
    // The owner whose saved draft has been read. A remix page keeps no draft,
    // so nothing waits for one there.
    const [draftRestoredFor, setDraftRestoredFor] = useState<string | null>(null);
    const isDraftReady = Boolean(prefill.remixId) || (draftOwner !== null && draftRestoredFor === draftOwner);
    // The start sent without an answer. Also in sessionStorage, which a browser
    // can refuse, so a retry from this page still reuses its key.
    const pendingStartRef = useRef<PendingWebStart | null>(null);
    // By File: a picked file is uploaded once and then sent again by its staged path.
    const stagedUploadsRef = useRef(new WeakMap<File, StagedMotionUpload>());
    const promptInputRef = useRef<HTMLTextAreaElement>(null);
    const promptEditedRef = useRef(false);
    const restoredDraftModelRef = useRef(false);
    // The longest length known for the attached clip, so a reread of the same
    // clip keeps what the server measured for it.
    const measuredClipFloorRef = useRef<{ url: string; seconds: number } | null>(null);
    const latestRunCostRef = useRef<number | null>(null);
    const pendingDraftSaveRef = useRef<{ owner: string; draft: MotionTextDraft } | null>(null);

    // Mirrors the live prompt so the remix restore below can tell whether the
    // creator typed while /api/remix-source was still in flight.
    const promptRef = useRef(prompt);
    useEffect(() => {
        promptRef.current = prompt;
    }, [prompt]);
    const [isDraggingImage, setIsDraggingImage] = useState(false);
    const [isDraggingVideo, setIsDraggingVideo] = useState(false);

    // Remix State
    const remixId = prefill.remixId ?? null;
    const remixPostId = prefill.remixPostId ?? null;
    // Publishing on the canvas: the form's details, the remix's original (credited with Follow,
    // owner 2026-10-28), Posted, and a publish in flight, which Generate waits for.
    const canvasPublish = useCreatorPublish({
        generationId: latestGenerationId,
        done: Boolean(outputVideo),
        accessToken: session?.access_token,
        remixPostId,
        viewerUserId: userId,
    });
    const prefillPrompt = prefill.prompt ?? null;
    const prefillModel = prefill.model ?? null;
    const [isRemixLoading, setIsRemixLoading] = useState(!!remixId);
    const [remixTitle, setRemixTitle] = useState<string | null>(null);
    const [remixVideoUrl, setRemixVideoUrl] = useState<string | null>(null);
    const [remixSourceBundle, setRemixSourceBundle] = useState<RemixSourceBundle | null>(null);
    const [remixRestoreWarning, setRemixRestoreWarning] = useState<string | null>(null);
    const [uploadPreview, setUploadPreview] = useState<UploadPreviewState | null>(null);
    const nowMs = useTicker(isGenerating) ?? undefined;

    useEffect(() => () => {
        generationPollAbortControllerRef.current?.abort();
    }, []);

    useEffect(() => {
        if (remixId) return;
        // A route prefill intentionally seeds the editable form once it is available.
        if (prefillPrompt) setPrompt(prefillPrompt);
        if (prefillModel) setSelectedModel(prefillModel as ModelId);
    }, [prefillPrompt, prefillModel, remixId]);


    // Derived, not kept in `catalogNotice`: a retired model or a failed load shows only
    // while it still applies, so choosing another model or a successful reload clears
    // it. It takes the notice slot ahead of a one-off notice, which can be dismissed.
    const catalogProblem = modelCatalog.missingIds.includes(selectedModel)
        ? remixId
            ? 'This model is no longer available. Your prompt and references stay on this page; choose another model.'
            : 'This model is no longer available. Your draft is saved; choose another model.'
        : modelCatalog.error?.message || null;
    const modelNotice = catalogProblem ?? catalogNotice;
    const model = MOTION_MODELS[selectedModel] ?? MOTION_MODELS['kling-3.0'];
    const motionModelOptions = modelCatalog.summaries.filter(item => item.kind === 'motion').map(item => ({ ...(MOTION_MODELS as unknown as Record<string, typeof MOTION_MODELS[keyof typeof MOTION_MODELS]>)[item.id], ...item, badge: item.badge ?? '' }));
    const normalizedModelSearchQuery = modelSearchQuery.trim().toLowerCase();
    const filteredMotionModelOptions = normalizedModelSearchQuery
        ? motionModelOptions.filter((motionModel) => [
            motionModel.displayName,
            motionModel.description,
            motionModel.badge,
            'motion transfer character animation video image 720p 1080p',
        ].join(' ').toLowerCase().includes(normalizedModelSearchQuery))
        : motionModelOptions;
    const maxVideoDuration = Number((model as unknown as { maxVideoDuration?: number; maxDuration?: number }).maxVideoDuration ?? (model as unknown as { maxDuration?: number }).maxDuration ?? 30);
    useEffect(() => {
        // The saved draft names the model first: resolving before it lands would
        // replace the creator's model with the catalog default.
        if (!modelCatalog.catalog || !isDraftReady) return;
        // The first pick waits for the revision the network confirms, as the video page's does: a catalog
        // read back from the browser can name an earlier default than the one the page was drawn on.
        if (!hasResolvedInitialCatalogModel.current && modelCatalog.isCheckingRevision) return;
        const preferDefault = !hasResolvedInitialCatalogModel.current && !remixId && !prefillModel && !restoredDraftModelRef.current;
        const nextModelId = resolveCatalogModelId(modelCatalog.catalog, 'motion', selectedModel, { preferDefault });
        if (!nextModelId) return;
        hasResolvedInitialCatalogModel.current = true;
        if (nextModelId && nextModelId !== selectedModel) {
            const nextModel = (MOTION_MODELS as unknown as Record<string, typeof model>)[nextModelId];
            setSelectedModel(nextModelId as ModelId);
            if (!preferDefault) {
                setCatalogNotice(`Your previous motion model is no longer available. Switched to ${nextModel?.displayName ?? nextModelId}.`);
            }
        }
    }, [isDraftReady, modelCatalog.catalog, modelCatalog.isCheckingRevision, selectedModel, model, prefillModel, remixId]);
    useEffect(() => {
        if (!modelCatalog.detailsReady) return;
        let changed = false;
        if (!(model.resolutions as readonly string[]).includes(mode)) {
            setMode(catalogChoiceDefault(catalogDescriptor, 'resolution', model.resolutions[0]) as typeof mode);
            changed = true;
        }
        if (!(model.characterOrientations as readonly string[]).includes(characterOrientation)) {
            setCharacterOrientation(catalogChoiceDefault(catalogDescriptor, 'characterOrientation', model.characterOrientations[0]) as typeof characterOrientation);
            changed = true;
        }
        if (changed) setCatalogNotice('Model settings changed. Unsupported choices were reset; your prompt and references are preserved.');
    }, [catalogDescriptor, characterOrientation, mode, model, modelCatalog.detailsReady]);

    const revokeObjectUrl = (url: string | null) => {
        if (url?.startsWith('blob:')) {
            URL.revokeObjectURL(url);
        }
    };

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

    // Per account, and never on a remix page: a remix restores its own inputs,
    // and saving them under the ordinary keys replaced the creator's own draft.
    const getPersistedMediaKey = (key: string) => (draftOwner && !remixId ? scopedPersistedMediaKey(key, draftOwner) : null);

    const processImageFile = async (file: File) => {
        const refusal = describeRefusedMotionPick(file, 'image');
        if (refusal) {
            setImagePickError(refusal);
            return;
        }
        setImagePickError(null);
        setCharacterImageFile(file);
        const url = URL.createObjectURL(file);
        setCharacterImage(url);
        setCharacterImageDescriptor(null);
        const persistedKey = getPersistedMediaKey(PERSISTED_MEDIA_KEYS.createMotionCharacterImage);
        if (persistedKey) await setPersistedFile(persistedKey, file);
    };

    const processVideoFile = async (file: File) => {
        // A refused pick leaves the attached clip as it was.
        const refusal = describeRefusedMotionPick(file, 'video');
        if (refusal) {
            setVideoPickError(refusal);
            return;
        }
        setVideoPickError(null);
        setVideoError(null);
        // No quote until the new clip's length is read.
        setDuration(0);
        setReferenceVideoFile(file);
        const url = URL.createObjectURL(file);
        setReferenceVideo(url);
        setReferenceVideoDescriptor(null);
        const persistedKey = getPersistedMediaKey(PERSISTED_MEDIA_KEYS.createMotionReferenceVideo);
        if (persistedKey) await setPersistedFile(persistedKey, file);
    };

    const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) { await processImageFile(file); e.target.value = ''; }
    };

    const handleVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) { await processVideoFile(file); e.target.value = ''; }
    };

    const handleDragOver = (e: React.DragEvent, setDragging: (v: boolean) => void) => {
        e.preventDefault(); e.stopPropagation(); setDragging(true);
    };
    const handleDragLeave = (e: React.DragEvent, setDragging: (v: boolean) => void) => {
        e.preventDefault(); e.stopPropagation(); setDragging(false);
    };

    const handleImageDrop = async (e: React.DragEvent) => {
        e.preventDefault(); e.stopPropagation(); setIsDraggingImage(false);
        const file = e.dataTransfer.files?.[0];
        if (file) await processImageFile(file);
    };

    const handleVideoDrop = async (e: React.DragEvent) => {
        e.preventDefault(); e.stopPropagation(); setIsDraggingVideo(false);
        const file = e.dataTransfer.files?.[0];
        if (file) await processVideoFile(file);
    };

    const handleClearImage = async () => {
        setCharacterImageFile(null); setCharacterImage(null);
        setCharacterImageDescriptor(null);
        setImagePickError(null);
        const persistedKey = getPersistedMediaKey(PERSISTED_MEDIA_KEYS.createMotionCharacterImage);
        if (persistedKey) await removePersistedMedia(persistedKey);
    };

    const handleClearVideo = async () => {
        setReferenceVideoFile(null); setReferenceVideo(null);
        setReferenceVideoDescriptor(null);
        setDuration(0); setVideoError(null); setVideoPickError(null);
        measuredClipFloorRef.current = null;
        const persistedKey = getPersistedMediaKey(PERSISTED_MEDIA_KEYS.createMotionReferenceVideo);
        if (persistedKey) await removePersistedMedia(persistedKey);
    };

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
                setRemixVideoUrl(bundle.result?.mediaType === 'video' ? bundle.result.url : null);
                setRemixRestoreWarning(getRemixRestoreWarning(bundle.restoreIssues));

                const settings = bundle.workflowSettings as MotionWorkflowSettings | null;
                if (settings?.model && MOTION_MODELS[settings.model]) {
                    setSelectedModel(settings.model);
                }
                if (settings?.mode) setMode(settings.mode);
                if (settings?.characterOrientation) setCharacterOrientation(settings.characterOrientation);

                const restoredMotionInputs = bundle.inputs.motion;
                const restoredCharacterImage = createRestoredRemixAssetState(
                    restoredMotionInputs?.characterImage ?? null
                );
                const restoredReferenceVideo = createRestoredRemixAssetState(
                    restoredMotionInputs?.referenceVideo ?? null
                );

                setCharacterImageFile(null);
                setCharacterImage(restoredCharacterImage?.url ?? null);
                setCharacterImageDescriptor(restoredCharacterImage?.descriptor ?? null);
                setReferenceVideoFile(null);
                setReferenceVideo(restoredReferenceVideo?.url ?? null);
                setReferenceVideoDescriptor(restoredReferenceVideo?.descriptor ?? null);
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
    }, [remixId, remixPostId, session?.access_token]);

    const handleUseOriginalResultAsReferenceVideo = () => {
        if (remixSourceBundle?.result?.mediaType !== 'video' || !remixSourceBundle.result.url) {
            return;
        }

        setReferenceVideoFile(null);
        setReferenceVideo(remixSourceBundle.result.url);
        setReferenceVideoDescriptor({
            kind: 'video',
            label: 'Original result video',
            storagePath: null,
            sourceGenerationId: remixSourceBundle.generation.id,
        });
        setDuration(0);
        setVideoError(null);
        setVideoPickError(null);
    };

    useEffect(() => {
        if (!referenceVideo) {
            return;
        }

        const controller = new AbortController();
        void readVideoDurationSeconds(referenceVideo, controller.signal).then(readSeconds => {
            if (controller.signal.aborted) return;
            if (readSeconds === null) {
                setVideoError('We could not read the reference video. Please try another clip.');
                return;
            }
            // The browser can round a frame short of ffmpeg: a longer length the
            // server measured for this same clip stays.
            const floor = measuredClipFloorRef.current;
            const seconds = floor?.url === referenceVideo ? Math.max(readSeconds, floor.seconds) : readSeconds;
            setDuration(seconds);
            setVideoError(seconds > maxVideoDuration
                ? `Reference video exceeds ${maxVideoDuration}s. Please choose a shorter clip.`
                : null);
        });
        return () => controller.abort();
    }, [maxVideoDuration, referenceVideo]);

    // Generation Recovery & Persistence
    // One effect per URL: a shared cleanup revoked the image's URL when the
    // clip was added after it, and "Preview image" opened a broken image.
    useEffect(() => () => revokeObjectUrl(characterImage), [characterImage]);
    useEffect(() => () => revokeObjectUrl(referenceVideo), [referenceVideo]);

    useEffect(() => {
        void purgeLegacyPersistedMedia();
    }, []);

    // A reload of the link the draft was edited under brings the edits back; a
    // different link keeps the prompt and model it carries.
    const applySavedDraft = (draft: MotionTextDraft) => {
        const savedLink = draft.linkPrefill ?? { prompt: null, model: null };
        const continuesLink = savedLink.prompt === prefillPrompt && savedLink.model === prefillModel;
        if (typeof draft.prompt === 'string' && (continuesLink || !prefillPrompt) && !promptEditedRef.current) {
            setPrompt(draft.prompt);
        }
        if (typeof draft.modelId === 'string' && draft.modelId && (continuesLink || !prefillModel)) {
            restoredDraftModelRef.current = true;
            setSelectedModel(draft.modelId as ModelId);
        }
        if (draft.characterOrientation === 'video' || draft.characterOrientation === 'image') {
            setCharacterOrientation(draft.characterOrientation);
        }
        if (draft.mode === '720p' || draft.mode === '1080p') setMode(draft.mode);
    };

    // The saved draft and its two files, read before the catalog picks a model.
    useEffect(() => {
        if (remixId || !draftOwner) return;
        let cancelled = false;
        void (async () => {
            const [draft, savedImageFile, savedVideoFile] = await Promise.all([
                loadCreatorDraft<MotionTextDraft>('motion', draftOwner).catch(() => null),
                getPersistedFile(scopedPersistedMediaKey(PERSISTED_MEDIA_KEYS.createMotionCharacterImage, draftOwner)).catch(() => null),
                getPersistedFile(scopedPersistedMediaKey(PERSISTED_MEDIA_KEYS.createMotionReferenceVideo, draftOwner)).catch(() => null),
            ]);
            if (cancelled) return;
            if (draft) applySavedDraft(draft);
            if (savedImageFile) {
                setCharacterImageFile(savedImageFile);
                setCharacterImage(URL.createObjectURL(savedImageFile));
            }
            if (savedVideoFile) {
                const url = URL.createObjectURL(savedVideoFile);
                if (draft && typeof draft.duration === 'number' && draft.duration > 0) {
                    measuredClipFloorRef.current = { url, seconds: draft.duration };
                }
                setReferenceVideoFile(savedVideoFile);
                setReferenceVideo(url);
            }
            setDraftRestoredFor(draftOwner);
        })();
        return () => {
            cancelled = true;
        };
        // Once per owner: applySavedDraft reads this page's prefill, which does not change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [remixId, draftOwner]);

    // Prompt, model and settings per owner, a moment after each edit. A remix
    // page saves none: it restores from its source.
    useEffect(() => {
        if (remixId || !draftOwner || !isDraftReady) return;
        const modelIsChosen = hasResolvedInitialCatalogModel.current || restoredDraftModelRef.current || Boolean(prefillModel);
        const pendingSave = {
            owner: draftOwner,
            draft: {
                prompt,
                ...(modelIsChosen ? { modelId: selectedModel } : {}),
                duration,
                characterOrientation,
                mode,
                linkPrefill: { prompt: prefillPrompt, model: prefillModel },
            } satisfies MotionTextDraft,
        };
        pendingDraftSaveRef.current = pendingSave;
        const timer = window.setTimeout(() => {
            if (pendingDraftSaveRef.current === pendingSave) pendingDraftSaveRef.current = null;
            void saveCreatorDraft('motion', pendingSave.owner, pendingSave.draft).catch(() => undefined);
        }, MOTION_DRAFT_SAVE_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [characterOrientation, duration, isDraftReady, mode, prefillModel, prefillPrompt, prompt, remixId, selectedModel, draftOwner]);

    /** Writes the draft at once, for a page about to go away. */
    const flushDraftSave = async () => {
        const pendingSave = pendingDraftSaveRef.current;
        if (!pendingSave) return;
        pendingDraftSaveRef.current = null;
        try {
            await saveCreatorDraft('motion', pendingSave.owner, pendingSave.draft);
        } catch {
            // Storage refused: the files are saved already, and the page goes on.
        }
    };

    const redirectToSignIn = async () => {
        await flushDraftSave();
        router.push(`/login?returnUrl=${encodeURIComponent(returnTo)}`);
    };

    /** Asks a visitor to sign up for what they pressed, with the form saved for the way back. */
    const openSignUp = async (reason: CreatorSignUpReason) => {
        await flushDraftSave();
        setSignUpReason(reason);
    };

    /** Onto the current build, with the draft saved first: it comes back after the reload. */
    const reloadPage = async () => {
        await flushDraftSave();
        reloadForNewerBuild();
    };

    // Read for every request: a run can outlive the token it started with.
    const readAccessToken = async () => {
        const { data: { session: currentSession } } = await supabase.auth.getSession();
        return currentSession?.access_token ?? null;
    };

    function getMotionGenerationEstimate(durationSeconds = duration, modelId: string = selectedModel, resolution: string = mode) {
        return estimateGenerationDurationMs({
            kind: 'motion',
            model: modelId,
            resolution,
            durationSeconds: Math.ceil(durationSeconds),
        });
    }

    function handoffToBackgroundProcessing(startedAtMs: number) {
        setError(BACKGROUND_PROCESSING_ERROR);
        setGenerationTiming((current) => freezeGenerationTiming(
            current ?? createLocalGenerationTiming({
                kind: 'motion',
                phaseLabel: 'Generating motion render',
                startedAtMs,
                estimatedTotalMs: getMotionGenerationEstimate(),
            }),
            Date.now()
        ));
    }

    async function pollPrediction(
        predictionId: string,
        startedAtMs: number,
        estimatedTotalMs: number | null
    ): Promise<{ output: string; timing: GenerationTiming | null }> {
        const pollController = new AbortController();
        generationPollAbortControllerRef.current?.abort();
        generationPollAbortControllerRef.current = pollController;
        const pollingStartedAt = Date.now();

        try {
            while (Date.now() - pollingStartedAt < 20 * 60 * 1000) {
                let data: GenerationStatusResponse;
                try {
                    data = await fetchGenerationStatusWithRetry({
                        url: `/api/generate?id=${predictionId}`,
                        getAccessToken: readAccessToken,
                        signal: pollController.signal,
                    });
                } catch (statusError) {
                    if (pollController.signal.aborted || isGenerationStatusAbortError(statusError)) throw statusError;
                    if (statusError instanceof GenerationStatusRequestError && statusError.status === 404) throw statusError;
                    // The run goes on with its credits whether or not this page can
                    // read it: hand it to the background rather than end it in an error.
                    throw new Error(BACKGROUND_PROCESSING_ERROR);
                }

                if (data.timing) {
                    setGenerationTiming(data.timing.estimatedTotalMs ? data.timing : {
                        ...data.timing,
                        estimatedTotalMs,
                    });
                } else {
                    setGenerationTiming((current) => current ?? createLocalGenerationTiming({
                        kind: 'motion',
                        phaseLabel: 'Waiting for provider',
                        startedAtMs,
                        estimatedTotalMs,
                    }));
                }

                if (data.status === 'succeeded') {
                    return {
                        output: data.output || '',
                        timing: data.timing ?? null,
                    };
                }

                if (data.status === 'failed') {
                    throw new MotionRunFailedError(data.error || 'Generation failed');
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
    }

    /**
     * How a started or resumed run that did not succeed ends on this page. `followed`: the
     * creator started it here, so its end moves the focus; a run picked up on load leaves the page be.
     */
    function settleRunError(runError: unknown, startedAtMs: number, followed = false) {
        const message = runError instanceof Error ? runError.message : 'Something went wrong';
        if (message === BACKGROUND_PROCESSING_ERROR) {
            handoffToBackgroundProcessing(startedAtMs);
            return;
        }
        setGenerationTiming(null);
        if (runError instanceof MotionRunFailedError) {
            // A failed run's hold is always returned: show the balance that is true now.
            window.dispatchEvent(new Event('credits_updated'));
            setRunFailure({ message, cost: latestRunCostRef.current });
            if (followed) setRunEndKey((key) => key + 1);
            return;
        }
        setError(message);
    }

    const beginRunView = (startedAtMs: number, estimatedTotalMs: number | null, phaseLabel: string) => {
        setIsGenerating(true);
        setError(null);
        setRunFailure(null);
        setCreditRefusal(null);
        setOutputVideo(null);
        setLatestGenerationId(null);
        latestRunCostRef.current = null;
        setRunCost(null);
        setRunAnswered(false);
        setGenerationTiming(createLocalGenerationTiming({
            kind: 'motion',
            phaseLabel,
            startedAtMs,
            estimatedTotalMs,
        }));
    };

    const forgetPendingStart = () => {
        pendingStartRef.current = null;
        clearPendingWebStart('motion');
        setUnconfirmedStart(false);
    };

    // The server measured a longer clip than the browser read, and the price
    // rose: quote with its length, which the refusal carries.
    const applyMeasuredClipLength = (details: Readonly<Record<string, unknown>>) => {
        const measuredInputs = Array.isArray(details.inputs) ? details.inputs.filter(isRecord) : [];
        // The start names each length it measured by the input's place in the run, and a
        // motion run sends its clip second, in whichever slot its model gives it.
        const clip = measuredInputs.find((input) => input.index === 1);
        const measured = clip && typeof clip.durationSeconds === 'number' && Number.isFinite(clip.durationSeconds) && clip.durationSeconds > 0
            ? Math.ceil(clip.durationSeconds)
            : null;
        if (measured === null) return;
        if (referenceVideo) measuredClipFloorRef.current = { url: referenceVideo, seconds: measured };
        setDuration(measured);
        setVideoError(measured > maxVideoDuration
            ? `Reference video exceeds ${maxVideoDuration}s. Please choose a shorter clip.`
            : null);
    };

    /** A definitive refusal: nothing is running and nothing is held. `code` picks what to offer. */
    const handleStartRefusal = async (refusal: unknown, run: CatalogGenerationRequestPayload) => {
        const requestError = refusal instanceof WebCatalogRequestError ? refusal : null;
        const code = requestError?.code;
        const message = refusal instanceof Error && refusal.message ? refusal.message : 'Failed to start generation.';
        if (code === 'UNAUTHORIZED' || requestError?.status === 401) {
            await redirectToSignIn();
            return;
        }
        if (code === 'insufficient_credits') {
            // The balance on screen was out of date: read it again and offer the top-up.
            window.dispatchEvent(new Event('credits_updated'));
            setCreditRefusal({ message, balance: userCredits, cost: estimatedCost });
            return;
        }
        if (code === 'CATALOG_CHANGED' || code === 'MODEL_UNAVAILABLE') {
            setCatalogNotice('Model settings changed. Review the refreshed options before generating.');
            refetchModelCatalog();
        }
        if (code === 'REFERENCE_DURATION_CHANGED' && requestError) {
            applyMeasuredClipLength(requestError.details);
        }
        setError(message);
        const fieldKeys = Object.keys(requestError?.fieldErrors ?? {});
        if (
            code === 'prompt_blocked'
            || (code === 'INVALID_GENERATION_REQUEST' && (fieldKeys.length === 0 || fieldKeys.some((key) => key.startsWith('prompt'))))
        ) {
            promptInputRef.current?.focus();
        } else if (code === 'cost_changed') {
            // Priced again at once: Generate shows what the run costs now, and the
            // next press sends that price.
            quoteState.costChanged(run);
        }
    };

    /**
     * Sends a start, new or unanswered, under its key and follows the run it answers with.
     * With `reveal`, the result canvas comes into view once the start is confirmed: a
     * refusal is said in the column's bar and must stay in view, and a run picked up on
     * load leaves the page where it is.
     */
    const sendStart = async (
        start: PendingWebStart,
        startedAtMs: number,
        estimatedTotalMs: number | null,
        { reveal = false }: { reveal?: boolean } = {},
    ) => {
        const accessToken = await readAccessToken();
        if (!accessToken) {
            setGenerationTiming(null);
            await redirectToSignIn();
            return;
        }
        let started: WebGenerationStartResponse;
        try {
            started = await requestWebGenerationStart(start.body as CatalogGenerationRequestPayload, {
                accessToken,
                idempotencyKey: start.idempotencyKey,
            });
        } catch (startError) {
            setGenerationTiming(null);
            if (isAmbiguousWebStartFailure(startError)) {
                // It may have started. The key stays, so checking again answers
                // with that run instead of paying for a second one.
                setUnconfirmedStart(true);
                return;
            }
            forgetPendingStart();
            await handleStartRefusal(startError, start.body as CatalogGenerationRequestPayload);
            return;
        }
        forgetPendingStart();
        quoteState.started(start.body as CatalogGenerationRequestPayload);
        latestRunCostRef.current = started.cost;
        setRunCost(started.cost);
        setRunAnswered(true);
        setLatestGenerationId(started.generationId ?? null);
        announceGenerationStarted();
        updateCredits(started.remainingCredits);
        if (reveal) setCanvasRevealKey((key) => key + 1);

        const result = await pollPrediction(started.predictionId, startedAtMs, estimatedTotalMs);
        setOutputVideo(result.output);
        if (reveal) setRunEndKey((key) => key + 1);
        if (result.timing) {
            setGenerationTiming(result.timing);
        }
    };

    /** Check again: the unanswered start, sent exactly as it was. */
    const replayPendingStart = async (start: PendingWebStart, { reveal = false }: { reveal?: boolean } = {}) => {
        if (activeGenerationRequestKeyRef.current) return;
        activeGenerationRequestKeyRef.current = start.idempotencyKey;
        setRunPrompt(typeof start.body.prompt === 'string' && start.body.prompt.trim() ? start.body.prompt.trim() : null);
        const createdAtMs = Date.parse(start.createdAt);
        const startedAtMs = Number.isFinite(createdAtMs) ? createdAtMs : getCurrentTimestampMs();
        const sentSettings = isRecord(start.body.settings) ? start.body.settings : {};
        const estimatedTotalMs = getMotionGenerationEstimate(
            typeof sentSettings.duration === 'number' ? sentSettings.duration : duration,
            typeof start.body.modelId === 'string' ? start.body.modelId : selectedModel,
            typeof sentSettings.resolution === 'string' ? sentSettings.resolution : mode,
        );
        beginRunView(startedAtMs, estimatedTotalMs, 'Checking your last motion run');
        setRunLabel((current) => current ?? motionModelName(start.body.modelId));
        setUnconfirmedStart(false);
        try {
            await sendStart(start, startedAtMs, estimatedTotalMs, { reveal });
        } catch (runError) {
            settleRunError(runError, startedAtMs, reveal);
        } finally {
            activeGenerationRequestKeyRef.current = null;
            setIsGenerating(false);
        }
    };

    const isStagedUploadReusable = (file: File) => {
        const staged = stagedUploadsRef.current.get(file);
        return Boolean(staged && Date.now() - staged.uploadedAt < STAGED_UPLOAD_REUSE_MS);
    };

    /** The file's staged path and a fresh link: uploaded on the first press, reused on the next ones. */
    const stageMotionFile = async (file: File) => {
        const staged = stagedUploadsRef.current.get(file);
        if (staged && isStagedUploadReusable(file)) {
            try {
                return { signedUrl: await refreshTemporaryMediaUrl(staged.storagePath), storagePath: staged.storagePath };
            } catch {
                // The staged copy is gone or could not be signed again: upload the file again.
                stagedUploadsRef.current.delete(file);
            }
        }
        const upload = await uploadMediaToTemporaryStorage(file);
        stagedUploadsRef.current.set(file, { ...upload, uploadedAt: Date.now() });
        return upload;
    };

    const startFreshRun = async () => {
        if (activeGenerationRequestKeyRef.current) return;
        const idempotencyKey = createGenerationIdempotencyKey('motion');
        activeGenerationRequestKeyRef.current = idempotencyKey;
        activeRunLookupRef.current?.abort();
        const startedAtMs = getCurrentTimestampMs();
        const estimatedTotalMs = getMotionGenerationEstimate(runSettings.duration);
        beginRunView(startedAtMs, estimatedTotalMs, 'Preparing inputs');
        setRunLabel(`${model.displayName} · ${settingsSummary}`);
        setRunPrompt(prompt.trim() || null);

        try {
            // Before any upload: a lapsed session goes to sign-in with this page's params.
            if (!(await readAccessToken())) {
                setGenerationTiming(null);
                await redirectToSignIn();
                return;
            }

            let imageUrl = characterImage;
            let videoUrl = referenceVideo;
            let nextCharacterImageDescriptor = characterImageDescriptor;
            let nextReferenceVideoDescriptor = referenceVideoDescriptor;

            if (characterImageFile) {
                if (!isStagedUploadReusable(characterImageFile)) {
                    setGenerationTiming(createLocalGenerationTiming({
                        kind: 'motion',
                        phaseLabel: 'Uploading character image',
                        startedAtMs,
                        estimatedTotalMs,
                    }));
                }
                const upload = await stageMotionFile(characterImageFile);
                imageUrl = upload.signedUrl;
                nextCharacterImageDescriptor = {
                    kind: 'image',
                    label: 'Character image',
                    storagePath: upload.storagePath,
                    sourceGenerationId: null,
                };
            }

            if (referenceVideoFile) {
                if (!isStagedUploadReusable(referenceVideoFile)) {
                    setGenerationTiming(createLocalGenerationTiming({
                        kind: 'motion',
                        phaseLabel: 'Uploading reference video',
                        startedAtMs,
                        estimatedTotalMs,
                    }));
                }
                const upload = await stageMotionFile(referenceVideoFile);
                videoUrl = upload.signedUrl;
                nextReferenceVideoDescriptor = {
                    kind: 'video',
                    label: 'Reference video',
                    storagePath: upload.storagePath,
                    sourceGenerationId: null,
                };
            }

            setGenerationTiming(createLocalGenerationTiming({
                kind: 'motion',
                phaseLabel: 'Submitting motion run',
                startedAtMs,
                estimatedTotalMs,
            }));
            const sent = {
                image: {
                    url: imageUrl,
                    label: nextCharacterImageDescriptor?.label ?? 'Character image',
                    storagePath: nextCharacterImageDescriptor?.storagePath ?? null,
                    sourceGenerationId: nextCharacterImageDescriptor?.sourceGenerationId ?? null,
                },
                video: {
                    url: videoUrl,
                    label: nextReferenceVideoDescriptor?.label ?? 'Reference video',
                    storagePath: nextReferenceVideoDescriptor?.storagePath ?? null,
                    sourceGenerationId: nextReferenceVideoDescriptor?.sourceGenerationId ?? null,
                },
            };
            // Posted from the inputs and settings its price was quoted from, with that price
            // when it is this run's own quote.
            const body = webCatalogStartRequest({
                kind: 'motion',
                modelId: selectedModel,
                settings: runSettings,
                prompt,
                inputs: runInputs.map((input) => ({ ...input, ...sent[input.kind] })),
                sourceGenerationId: remixId || undefined,
                catalogRevision: modelCatalog.catalog?.revision ?? '',
            }, quoteState);
            const start: PendingWebStart = {
                version: 1,
                tool: 'motion',
                idempotencyKey,
                body,
                catalogRevision: body.catalogRevision,
                createdAt: new Date(startedAtMs).toISOString(),
                userId,
            };
            // Kept before it is sent: an answer that never arrives is checked
            // again under this key, on this page or after a reload.
            pendingStartRef.current = start;
            savePendingWebStart(start);
            await sendStart(start, startedAtMs, estimatedTotalMs, { reveal: true });
        } catch (runError) {
            settleRunError(runError, startedAtMs, true);
        } finally {
            activeGenerationRequestKeyRef.current = null;
            setIsGenerating(false);
        }
    };

    const handleGenerate = async () => {
        if (activeGenerationRequestKeyRef.current) return;
        // A new run takes the publish form away: a publish in flight is let finish first.
        if (canvasPublish.inFlight) return;
        // While a start is unconfirmed, a press checks it: a new key could pay for a second run.
        const pending = pendingStartRef.current ?? (userId ? loadPendingWebStart('motion', userId) : null);
        if (pending) {
            pendingStartRef.current = pending;
            await replayPendingStart(pending, { reveal: true });
            return;
        }
        // The button is disabled until both inputs and a duration exist.
        if (!canGenerate) return;
        // A newer build is out: send from it rather than from this page. The
        // draft and both files are saved, so the reload loses nothing.
        if (newBuildAvailable && !remixId) {
            await reloadPage();
            return;
        }
        if (isVisitor) {
            // Signed out: the sign-up comes back here, on this page's own link, with the
            // draft saved, and nothing runs until Generate is pressed again.
            await openSignUp('generate');
            return;
        }
        await startFreshRun();
    };

    /** The explicit choice to run again while the unconfirmed start may exist. */
    const startNewRunInstead = async () => {
        if (activeGenerationRequestKeyRef.current) return;
        forgetPendingStart();
        await handleGenerate();
    };

    // An unanswered start is checked first, under its own key: it may be the
    // very run the newest-run lookup would otherwise find.
    const resumeNewestMotionRun = async (signal: AbortSignal) => {
        const { data: { session: currentSession } } = await supabase.auth.getSession();
        if (!currentSession) return;
        // Asked of the server: the browser may not read a run's prompt, cost or model.
        const run = await fetchCreatorActiveRun({ tool: 'motion', accessToken: currentSession.access_token, signal });

        if (!run || signal.aborted || activeGenerationRequestKeyRef.current) return;
        activeGenerationRequestKeyRef.current = `resume:${run.predictionId}`;
        const startedAtMs = Number.isNaN(Date.parse(run.createdAt)) ? Date.now() : Date.parse(run.createdAt);
        setIsGenerating(true);
        setError(null);
        setLatestGenerationId(run.id);
        setRunPrompt(run.prompt?.trim() || null);
        setRunLabel(motionModelName(run.model));
        latestRunCostRef.current = run.cost;
        setRunCost(latestRunCostRef.current);
        setRunAnswered(true);
        setGenerationTiming(createLocalGenerationTiming({
            kind: 'motion',
            phaseLabel: 'Resuming active run',
            startedAtMs,
            appStatus: run.status,
        }));
        if (run.duration !== null) {
            // A clip the form already holds keeps the length measured from it.
            const runSeconds = run.duration;
            setDuration((measured) => (measured > 0 ? measured : runSeconds));
        }

        try {
            const result = await pollPrediction(run.predictionId, startedAtMs, null);
            setOutputVideo(result.output);
            if (result.timing) {
                setGenerationTiming(result.timing);
            }
        } catch (err) {
            settleRunError(err, startedAtMs);
        } finally {
            activeGenerationRequestKeyRef.current = null;
            setIsGenerating(false);
        }
    };

    useEffect(() => {
        const pending = userId ? loadPendingWebStart('motion', userId) : null;
        if (pending) {
            pendingStartRef.current = pending;
            void replayPendingStart(pending);
            return;
        }
        // Dropped when the page goes (development's Strict Mode mounts it twice) and at a
        // press: a run it found then would get a follower nothing stops, or take the page
        // from the creator's own run.
        const lookup = new AbortController();
        activeRunLookupRef.current = lookup;
        void resumeNewestMotionRun(lookup.signal);
        return () => lookup.abort();
        // Recovery is intentionally a mount-only lookup; changing form settings must not restart it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const additionalSettings = useAdditionalCatalogSettings(catalogDescriptor, CATALOG_HANDLED_KEYS);
    // One settings object for the price and the run. Whole seconds: the duration control is
    // an integer, and a 7.3 s clip made the quote a 422 with no reason shown.
    const runSettings = useMemo(() => ({
        duration: Math.ceil(duration),
        characterOrientation,
        resolution: mode,
        ...additionalSettings.settings,
    }), [additionalSettings.settings, characterOrientation, duration, mode]);
    // The picture and the clip, each in the slot this model's descriptor opens for it.
    const runInputs = useMemo(() => planMotionRunInputs(catalogDescriptor, runSettings), [catalogDescriptor, runSettings]);
    const hasCharacterImage = Boolean(characterImage || characterImageFile);
    const hasReferenceVideo = Boolean(referenceVideo || referenceVideoFile);
    // The server refuses a quote without both inputs and a length, so a fresh
    // page opened on that refusal and a Retry that could not help.
    const motionInputsReady = hasCharacterImage && hasReferenceVideo && duration > 0;
    // The clip against the shortest the slot it is sent in takes (Kie's motion control refuses one
    // under 3 seconds). The start refused such a run before any hold, but only once Generate was
    // pressed; the run now waits, in the start's words (the model by the name it gives it, the clip
    // as MOTION_CLIP_NAME), for as long as it holds. A length the page has not read is left to the
    // start, which measures it.
    const clipSlot = useMemo(() => motionRunClipSlot(catalogDescriptor, runSettings), [catalogDescriptor, runSettings]);
    const shortClipMessage = hasReferenceVideo && clipSlot
        ? catalogInputTooShort(model.displayName, clipSlot, { label: MOTION_CLIP_NAME, durationSeconds: duration })
        : null;
    const hasCatalogSettings = Boolean(modelCatalog.catalog && modelCatalog.detailsReady);
    // The price is the server's own quote of the run the page posts, as the start quotes
    // the run it is sent (catalogRunQuoteInput of its inputs, each in its slot).
    const quoteRequest = useMemo(() => modelCatalog.catalog && modelCatalog.detailsReady && motionInputsReady ? catalogRunQuoteInput({
        kind: 'motion' as const,
        modelId: selectedModel,
        catalogRevision: modelCatalog.catalog.revision,
        settings: runSettings,
        inputs: runInputs,
    }) : null, [modelCatalog.catalog, modelCatalog.detailsReady, motionInputsReady, runInputs, runSettings, selectedModel]);
    const quoteState = useCreatorQuote(quoteRequest, session?.access_token);
    useEffect(() => {
        if (quoteState.error?.code !== 'CATALOG_CHANGED' && quoteState.error?.code !== 'MODEL_UNAVAILABLE') return;
        // The quote response is the external signal that the local catalog is stale.
        setCatalogNotice('Model settings changed. Review the refreshed options before generating.');
        refetchModelCatalog();
    }, [refetchModelCatalog, quoteState.error?.code]);
    const quoteUi = hasCatalogSettings && !motionInputsReady
        ? {
            costCredits: null,
            costLabel: hasCharacterImage && hasReferenceVideo ? 'Calculating...' : 'Add both inputs',
            blocksGenerate: true,
            message: hasCharacterImage && hasReferenceVideo ? 'Reading the motion clip’s length…' : MOTION_INPUTS_HINT,
        }
        : resolveWebGenerationQuoteUi({
            hasCatalog: hasCatalogSettings,
            catalogLoading: !modelCatalog.detailsReady && !modelCatalog.error && !modelCatalog.missingIds.includes(selectedModel),
            quoteStatus: quoteState.status,
            quotedCost: quoteState.quote?.costCredits,
            quoteErrorMessage: quoteState.error?.message,
        });
    const estimatedCost = quoteUi.costCredits;
    // A page the start keeps refusing at its own price waits for a reload, not another press.
    const quotePending = quoteUi.blocksGenerate || quoteState.pageOutOfDate;
    const quoteRetry = quoteState.status === 'error' ? <StudioQuoteRetry message={quoteUi.message} onRetry={quoteState.retry} /> : null;
    const insufficientCredits = userCredits !== null && estimatedCost !== null && estimatedCost > 0 && userCredits < estimatedCost;
    // Every option of the open settings priced (owner, 2026-10-28), once the run can be:
    // a motion run's price waits for its clip.
    const listBalance = isVisitor ? visitorWelcomeCredits : userCredits;
    const settingsAxes = useMemo<Array<readonly [string, readonly CatalogPrimitive[]]>>(() => [
        ['resolution', model.resolutions],
        ['characterOrientation', model.characterOrientations],
    ], [model.resolutions, model.characterOrientations]);
    const variants = useMemo(
        () => (settingsOpen ? settingsVariants(quoteRequest, settingsAxes) : NO_SETTINGS_VARIANTS),
        [settingsOpen, quoteRequest, settingsAxes],
    );
    const priceOf = useQuotePrices([...variants.values()]);
    const optionPrice = optionPricesOf(variants, priceOf, listBalance, isVisitor ? 'the free credits' : 'your balance');
    const smallestOver = smallestOverBalance(optionPrice, settingsAxes);
    // The server's refusal holds until the balance or the price on screen moves.
    const creditRefusalMessage = creditRefusal && creditRefusal.balance === userCredits && creditRefusal.cost === estimatedCost
        ? creditRefusal.message
        : null;
    const showTopUp = insufficientCredits || Boolean(creditRefusalMessage);
    const canGenerate = motionInputsReady && !videoError && !shortClipMessage;
    const isBackgroundProcessing = error === BACKGROUND_PROCESSING_ERROR;
    const backgroundProcessingCopy = getBackgroundProcessingCopy('motion');
    // Watched only while idle, so a reload never lands mid-request. A remix page
    // keeps no draft, so it is never reloaded under the creator.
    const { newBuildAvailable } = useDeploymentRefresh(!isGenerating && !isBackgroundProcessing && !remixId);

    // Where the run is, as the canvas says it (read before the sign-in check below returns early,
    // as every hook is): what it shows of the run goes to the shell's run toasts, which would only
    // say its end again, over Publish.
    const canvasPhase = creatorCanvasPhase({ hasResult: Boolean(outputVideo), isGenerating, isBackgroundProcessing, hasFailure: runFailure !== null });
    useAnnounceRunOnPage(latestGenerationId, creatorCanvasFollowsRun(canvasPhase), creatorCanvasSettledStatus(canvasPhase));

    if (isLoadingUser) {
        return (
            <div className="ui-page min-h-screen text-[var(--ui-text-primary)] flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-zinc-500" />
            </div>
        );
    }

    const backgroundTiming = generationTiming ? freezeGenerationTiming(generationTiming, nowMs) : null;
    const backgroundTimingLabel = backgroundTiming ? getGenerationTimingSummaryLabel(backgroundTiming, nowMs) : null;
    const canUseOriginalResultAsReferenceVideo =
        remixSourceBundle?.result?.mediaType === 'video' && Boolean(remixSourceBundle.result.url);
    const isUsingOriginalResultAsReferenceVideo = Boolean(
        remixSourceBundle &&
        referenceVideoDescriptor?.sourceGenerationId === remixSourceBundle.generation.id
    );

    // The canvas says where the run is (the artboards Main, Generating, Failed and Result),
    // and its chip what the run is and holds.
    const canvasTitle = creatorCanvasTitle(canvasPhase, { making: 'Animating your character', waiting: 'Your motion clip' });
    const canvasChip = creatorCanvasChip(canvasPhase, runLabel, runCost);
    const showsEmptyCanvas = canvasPhase === 'empty';
    const showsRunFailure = canvasPhase === 'failed';
    const emptyCanvasHint = isVisitor
        ? 'Add a character image and a reference video first. When you sign up, your prompt, settings and files stay.'
        : 'Add a character image and a reference video, then Generate.';

    const isAwaitingStartCheck = unconfirmedStart && !isGenerating;
    // What stops or explains a run, said just above the bar. Progress is drawn on the
    // canvas; a run in the background is named here too, beside Generate.
    const runStatus = isGenerating ? null : isBackgroundProcessing ? (
        <CreatorBackgroundRunLine title={backgroundProcessingCopy.title} />
    ) : unconfirmedStart ? (
        <CreatorPendingStartNotice
            message={UNCONFIRMED_START_MESSAGE}
            costLabel={quoteUi.costLabel}
            hasPrice={estimatedCost !== null}
            disabled={!canGenerate || quotePending}
            onStartNew={() => void startNewRunInstead()}
        />
    ) : videoError ? (
        <p className="text-rose-300">{videoError}</p>
    ) : quoteState.pageOutOfDate ? (
        <StudioOutOfDatePageNotice
            isRemix={Boolean(remixId)}
            reloadDidNotHelp={reloadBroughtBackThisBuild()}
            onReload={() => void reloadPage()}
        />
    ) : error ? (
        // A price that could not be read since (asked again after `cost_changed`,
        // say) keeps its Retry under the error: Generate waits for a price.
        <div className="space-y-2">
            <p className="text-rose-300">{error}</p>
            {quoteRetry}
        </div>
    ) : quoteState.status === 'error' ? (
        quoteRetry
    ) : hasCatalogSettings && !motionInputsReady ? (
        // Why Generate waits: the price is asked for once both inputs are in.
        <p className="text-[var(--ui-text-muted)]">{quoteUi.message}</p>
    ) : null;
    const topUpNotice = showTopUp && !isAwaitingStartCheck && !isGenerating ? (
        <CreatorTopUpNotice cost={estimatedCost} balance={userCredits} message={creditRefusalMessage} />
    ) : null;
    // A line of its own, so no other status (an unanswered start, a price that failed) hides why
    // Generate is off.
    const shortClipLine = shortClipMessage && !isGenerating ? (
        <p className="text-rose-300">{shortClipMessage}</p>
    ) : null;
    const barStatus = topUpNotice || runStatus || shortClipLine ? (
        <div className="space-y-3">
            {topUpNotice}
            {runStatus}
            {shortClipLine}
        </div>
    ) : null;

    // Generate checks an unanswered start first, so Check again is the same press.
    const barAction = (
        <CreatorBarAction
            awaitingCheck={isAwaitingStartCheck}
            onCheckAgain={() => void handleGenerate()}
            showTopUp={showTopUp}
            isGenerating={isGenerating}
            // A visitor's press needs no price: it checks the form, then asks for an account.
            disabled={!canGenerate || (!isVisitor && quotePending) || canvasPublish.inFlight}
            costLabel={quoteUi.costLabel}
            hasPrice={estimatedCost !== null}
            onGenerate={() => void handleGenerate()}
            signUp={isVisitor}
        />
    );

    const settingsPanel = (
        <div className="space-y-5">
            <CreatorSettingChoices
                label="Character orientation"
                hint="Which one the clip keeps to."
                options={model.characterOrientations}
                optionLabel={(option) => (option === 'video' ? 'Follow video' : 'Favor image')}
                value={characterOrientation}
                onChange={setCharacterOrientation}
                columns={2}
                accent="motion"
                optionPrice={(option) => optionPrice('characterOrientation', option)}
            />
            <CreatorSettingChoices
                label="Quality mode"
                options={model.resolutions}
                optionLabel={(quality) => (quality === '720p' ? 'Standard 720p' : quality === '1080p' ? 'Pro 1080p' : quality)}
                value={mode}
                onChange={setMode}
                columns={2}
                accent="motion"
                optionPrice={(quality) => optionPrice('resolution', quality)}
            />
            <CreatorOverBalanceLegend over={smallestOver} balance={listBalance} isVisitor={isVisitor} offersTopUp={!isVisitor} />
            <CatalogAdditionalControls
                appearance="panel"
                descriptor={catalogDescriptor}
                handledKeys={CATALOG_HANDLED_KEYS}
                settings={{ resolution: mode, characterOrientation, duration, ...additionalSettings.settings }}
                inputCounts={{ images: characterImage ? 1 : 0, videos: referenceVideo ? 1 : 0, audios: 0 }}
                onChange={additionalSettings.onChange}
            />
        </div>
    );

    // Done (the artboard Result): the clip, its download, and the publish form beside it; Posted once it went.
    const motionDownload = outputVideo ? {
        href: resolvedOutputVideo?.outputUrl === outputVideo ? resolvedOutputVideo.url : outputVideo,
        fileName: 'generated-video.mp4',
        label: 'Download video',
        newTab: true,
    } : null;
    const publishPanel = canvasPublish.panel && motionDownload ? (
        <CreatorPublishPanel
            key={canvasPublish.panel.generationId}
            {...canvasPublish.panel}
            sourceSurface="create-motion"
            download={motionDownload}
            next={userCredits !== null ? (
                <CreatorPostedNext
                    balance={userCredits}
                    runCost={runCost ?? estimatedCost}
                    onMakeAnother={() => promptInputRef.current?.focus()}
                />
            ) : null}
        />
    ) : null;

    const motionAccent = getAccentClasses('motion');

    return (
        <div className="ui-page ui-page-ambient min-h-screen py-4 text-[var(--ui-text-primary)] sm:py-6 font-[family-name:var(--font-geist-sans)]">
            <CreatorColumnLayout
                resultFirst={canvasPhase === 'done'}
                title="Create motion"
                column={
                    <>
                        <CreatorToolTabs currentToolId="motion" />
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
                                    searchLabel="Search motion models"
                                    searchPlaceholder="Search motion models..."
                                    resultListLabel="Motion models"
                                    resultCount={filteredMotionModelOptions.length}
                                    accent="violet"
                                >
                                    {filteredMotionModelOptions.map((motionModel) => {
                                        const isActive = selectedModel === motionModel.id;

                                        return (
                                            <button
                                                key={motionModel.id}
                                                type="button"
                                                role="option"
                                                aria-selected={isActive}
                                                onClick={() => {
                                                    // A notice about the previous model no longer applies.
                                                    if (motionModel.id !== selectedModel) setCatalogNotice(null);
                                                    // The creator's pick is the first pick: the catalog's default no longer replaces it.
                                                    hasResolvedInitialCatalogModel.current = true;
                                                    setSelectedModel(motionModel.id as ModelId);
                                                    setIsModelDropdownOpen(false);
                                                    setModelSearchQuery('');
                                                }}
                                                className={`flex w-full items-center gap-3 px-5 py-4 text-left transition ${isActive ? 'bg-white/5' : 'hover:bg-white/[0.03]'}`}
                                            >
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <span className={`text-sm font-semibold ${isActive ? 'text-white' : 'text-zinc-300'}`}>
                                                            {motionModel.displayName}
                                                        </span>
                                                        <span className={`rounded-full bg-gradient-to-r px-2 py-0.5 text-[10px] font-bold text-white ${motionModel.badgeColor}`}>
                                                            {motionModel.badge}
                                                        </span>
                                                    </div>
                                                    <p className="mt-1 text-sm text-zinc-400">{motionModel.description}</p>
                                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                                        <span className="rounded-full border border-white/5 bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-500">
                                                            Max {Number((motionModel as unknown as { maxVideoDuration?: number; maxDuration?: number }).maxVideoDuration ?? (motionModel as unknown as { maxDuration?: number }).maxDuration ?? 30)}s
                                                        </span>
                                                        <span className="rounded-full border border-white/5 bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-500">
                                                            {(motionModel.resolutions as readonly string[]).join(' / ')}
                                                        </span>
                                                    </div>
                                                </div>
                                                {isActive ? <Check className={`h-4 w-4 shrink-0 ${motionAccent.mark}`} /> : null}
                                            </button>
                                        );
                                    })}
                                </StudioModelPicker>
                            </div>
                        </div>
                        {/* Until the first run this visit: back over the prompt after one, it pushed the field the creator went to. */}
                        {showsEmptyCanvas && canvasRevealKey === 0 ? <CreatorStartPostsStrip source={startPosts} tool="motion" balance={listBalance} /> : null}

                        <AnimatePresence>
                            {modelNotice ? (
                                <motion.div key="model-notice" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}>
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
                                <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}>
                                    <StudioRemixNotice
                                        description={`${`Settings pre-filled from ${remixTitle ? `"${remixTitle}"` : 'the original creation'}.`}${remixRestoreWarning ? ` ${remixRestoreWarning}` : ''}`}
                                        original={remixVideoUrl ? {
                                            mediaType: 'video',
                                            src: remixVideoUrl,
                                            onOpen: () => setUploadPreview({ type: 'video', src: remixVideoUrl, alt: 'Original creation', title: 'Original Creation' }),
                                        } : null}
                                        action={
                                            canUseOriginalResultAsReferenceVideo ? (
                                                <button
                                                    type="button"
                                                    onClick={handleUseOriginalResultAsReferenceVideo}
                                                    disabled={isUsingOriginalResultAsReferenceVideo}
                                                    className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition ${isUsingOriginalResultAsReferenceVideo
                                                        ? 'cursor-default border border-emerald-400/20 bg-emerald-500/10 text-emerald-100'
                                                        : 'border border-[#ff7a59]/25 bg-[#ff7a59]/10 text-[#ffb09c] hover:border-[#ff7a59]/45 hover:bg-[#ff7a59]/15'}`}
                                                >
                                                    <Play className="h-4 w-4" />
                                                    {isUsingOriginalResultAsReferenceVideo ? 'Using original result' : 'Use as reference video'}
                                                </button>
                                            ) : undefined
                                        }
                                    />
                                </motion.div>
                            )}
                        </AnimatePresence>

                        <div role="group" aria-labelledby="create-motion-inputs" className="ui-card p-4">
                            <h2 id="create-motion-inputs" className="text-xs font-bold text-[var(--ui-text-muted)]">Required inputs</h2>
                            <p className="mb-3 mt-1 text-xs text-[var(--ui-text-faint)]">Choose the character to keep and the movement to transfer.</p>
                            <div className="grid grid-cols-2 gap-3">
                                <CreatorUploadSlot
                                    accent="motion"
                                    title="Character image"
                                    hint="Who should move?"
                                    height="tall"
                                    mediaType="image"
                                    src={characterImage}
                                    alt="Character image"
                                    previewHint="Preview image"
                                    fit="contain"
                                    icon={ImageIcon}
                                    emptyLabel={isDraggingImage ? 'Drop image here' : 'Add the character image'}
                                    emptyHint="A clean, full-body still works best."
                                    input={{ id: 'motion-character-image-input', accept: 'image/*', onChange: handleImageUpload }}
                                    onPreview={() => {
                                        if (characterImage) setUploadPreview({ type: 'image', src: characterImage, alt: 'Character image', title: 'Character Image' });
                                    }}
                                    onRemove={() => void handleClearImage()}
                                    dragging={isDraggingImage}
                                    onDragOver={(event) => handleDragOver(event, setIsDraggingImage)}
                                    onDragLeave={(event) => handleDragLeave(event, setIsDraggingImage)}
                                    onDrop={handleImageDrop}
                                />
                                <CreatorUploadSlot
                                    accent="motion"
                                    title="Reference video"
                                    hint="How should they move?"
                                    height="tall"
                                    mediaType="video"
                                    src={referenceVideo}
                                    alt="Reference video"
                                    previewHint="Preview video"
                                    fit="contain"
                                    icon={Video}
                                    emptyLabel={isDraggingVideo ? 'Drop video here' : 'Add the motion clip'}
                                    emptyHint={`MP4 or MOV, up to 100MB and ${maxVideoDuration}s.`}
                                    input={{ id: 'motion-reference-video-input', accept: 'video/*', onChange: handleVideoUpload }}
                                    onPreview={() => {
                                        if (referenceVideo) setUploadPreview({ type: 'video', src: referenceVideo, alt: 'Reference video', title: 'Reference Video' });
                                    }}
                                    onRemove={() => void handleClearVideo()}
                                    dragging={isDraggingVideo}
                                    onDragOver={(event) => handleDragOver(event, setIsDraggingVideo)}
                                    onDragLeave={(event) => handleDragLeave(event, setIsDraggingVideo)}
                                    onDrop={handleVideoDrop}
                                />
                            </div>

                            <p className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-[var(--ui-text-muted)]">
                                {/* Read toward the limit the clip is past, as the start's words give it; a held clip says so. */}
                                {shortClipMessage && clipSlot?.minDurationSeconds ? (
                                    <span className="text-rose-300">{`Reference length: ${heldLengthNote(duration, clipSlot.minDurationSeconds)}`}</span>
                                ) : (
                                    <span>
                                        {duration > 0
                                            ? `Reference length: ${lengthReading(duration, { minDurationSeconds: clipSlot?.minDurationSeconds, maxDurationSeconds: clipSlot?.maxDurationSeconds ?? maxVideoDuration })}s`
                                            : 'Reference length will appear after upload.'}
                                    </span>
                                )}
                                <span className="tabular-nums">Limit: {maxVideoDuration}s</span>
                            </p>

                            {imagePickError ? (
                                <p role="alert" className="mt-3 text-sm text-rose-300">{imagePickError}</p>
                            ) : null}
                            {videoPickError ? (
                                <p role="alert" className="mt-3 text-sm text-rose-300">{videoPickError}</p>
                            ) : null}
                            {videoError ? (
                                <p className="mt-3 text-sm text-rose-300">{videoError}</p>
                            ) : null}
                        </div>

                        <div className={`rounded-ui-2xl border bg-[var(--ui-surface-1)] transition-colors duration-150 ${motionAccent.outline}`}>
                            <div className="flex items-baseline justify-between gap-3 px-4 pt-4">
                                <label htmlFor="create-motion-prompt" className="ui-kicker">
                                    Prompt
                                </label>
                                <span className="text-xs text-[var(--ui-text-faint)]">Optional</span>
                            </div>
                            <textarea
                                id="create-motion-prompt"
                                ref={promptInputRef}
                                value={prompt}
                                onChange={(event) => {
                                    promptEditedRef.current = true;
                                    setPrompt(event.target.value);
                                }}
                                placeholder="Describe the kind of movement, pacing, and constraints you want to preserve."
                                maxLength={MOTION_PROMPT_MAX_LENGTH}
                                className="block min-h-[120px] w-full resize-y bg-transparent px-4 pb-2 pt-2 text-sm leading-6 text-[var(--ui-text-primary)] outline-none placeholder:text-[var(--ui-text-faint)]"
                            />
                            <div className="px-4 pb-3 text-xs tabular-nums text-[var(--ui-text-faint)]">{prompt.length}/{MOTION_PROMPT_MAX_LENGTH}</div>
                        </div>

                        <EnhancePromptButton
                            variant="toolbar"
                            leading={<CreatorTemplatesTile />}
                            prompt={prompt}
                            onEnhanced={(text) => {
                                promptEditedRef.current = true;
                                setPrompt(text);
                            }}
                            onCreditsUpdate={updateCredits}
                            medium="motion"
                            selectedModel={selectedModel}
                            context={{
                                modelId: selectedModel,
                                characterOrientation,
                                mode,
                                hasReferenceVideo: Boolean(referenceVideoFile || referenceVideo),
                            }}
                            disabled={isGenerating}
                            onRequireAccount={isVisitor ? () => void openSignUp('enhance') : undefined}
                        />

                        <CreatorColumnBar
                            holdsFootUnderColumn={!(publishPanel && !canvasPublish.posted)}
                            settingsSummary={settingsSummary}
                            settings={settingsPanel}
                            settingsFootNote={<CreatorSettingsFootNote cost={estimatedCost} costLabel={quoteUi.costLabel} balance={listBalance} isVisitor={isVisitor} />}
                            settingsOpen={settingsOpen}
                            onSettingsOpenChange={setSettingsOpen}
                            status={barStatus}
                            narrowStatus={showsRunFailure ? (
                                <CreatorRunFailedLine returnedCredits={runFailure?.cost ?? null} onSeeWhy={() => setRunEndKey((key) => key + 1)} />
                            ) : null}
                            action={barAction}
                            note={isVisitor
                                ? <CreatorVisitorNote welcomeCredits={visitorWelcomeCredits} cost={estimatedCost} />
                                : userCredits !== null ? <CreatorBalanceNote balance={userCredits} cost={estimatedCost} /> : undefined}
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
                        {outputVideo ? (
                            <CreatorDoneLayout
                                key={outputVideo}
                                // A motion clip takes its reference's shape, read from the clip once it loads.
                                ratio={null}
                                media={(
                                    <CreatorCanvasMedia aspectRatio="auto">
                                        <GenerationResultVideo generationId={latestGenerationId} outputUrl={outputVideo} accessToken={session?.access_token} onOriginalResolved={setResolvedOutputVideo} loop={false} />
                                    </CreatorCanvasMedia>
                                )}
                                mediaFoot={motionDownload ? (
                                    <div className="space-y-3">
                                        {runPrompt ? <p className="line-clamp-2 text-xs leading-5 text-[var(--ui-text-faint)]">{runPrompt}</p> : null}
                                        <CreatorDownloadButton {...motionDownload} />
                                    </div>
                                ) : null}
                                panel={publishPanel}
                            />
                        ) : isGenerating ? (
                            <>
                                <CreatorCanvasStage>
                                    <CreatorCanvasFrame aspectRatio="auto" accent="motion" busy>
                                        <Play aria-hidden className="h-6 w-6 text-[var(--ui-primary)]" />
                                        {generationTiming ? (
                                            <div className="w-full max-w-72">
                                                <StudioGenerationStatus accent="violet" timing={generationTiming} nowMs={nowMs} />
                                            </div>
                                        ) : (
                                            <p role="status" className="text-sm font-semibold text-[var(--ui-text-primary)]">Transferring the motion</p>
                                        )}
                                    </CreatorCanvasFrame>
                                </CreatorCanvasStage>
                                {runAnswered ? <CreatorRunWaitLines noun="motion clip" heldCredits={runCost} /> : null}
                                <CreatorWhileYouWait source={startPosts} tool="motion" />
                            </>
                        ) : isBackgroundProcessing ? (
                            <div className="w-full max-w-md">
                                <StudioBackgroundProcessingNotice
                                    accent="violet"
                                    label="motion render"
                                    phaseLabel={backgroundTiming?.phaseLabel ?? null}
                                    timingLabel={backgroundTimingLabel}
                                />
                            </div>
                        ) : runFailure ? (
                            <CreatorRunFailed
                                cause={describeRunFailure(runFailure.message, 'motion clip')}
                                returnedCredits={runFailure.cost}
                                retryLabel={estimatedCost !== null ? `Try again · ${quoteUi.costLabel}` : 'Try again'}
                                retryDisabled={!canGenerate || quotePending || showTopUp}
                                onRetry={() => void handleGenerate()}
                                retryable={isRetryableProviderFailure(runFailure.message)}
                                onPickModel={() => setIsModelDropdownOpen(true)}
                                onChangePrompt={() => {
                                    setRunFailure(null);
                                    promptInputRef.current?.focus();
                                }}
                            />
                        ) : (
                            <CreatorEmptyCanvas
                                source={startPosts}
                                tool="motion"
                                balance={listBalance}
                                icon={Play}
                                title={isVisitor ? 'Try it before you sign up' : 'Your motion clip will appear here'}
                                hint={`${emptyCanvasHint} Or remix a post below.`}
                                frame={(
                                    <CreatorCanvasStage>
                                        <CreatorCanvasFrame aspectRatio="auto" accent="motion">
                                            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)]">
                                                <Play className="h-5 w-5 text-[var(--ui-text-muted)]" />
                                            </span>
                                            <p className="text-sm font-semibold text-[var(--ui-text-secondary)]">{isVisitor ? 'Try it before you sign up' : 'Your motion clip will appear here'}</p>
                                            <p className="text-xs leading-5 text-[var(--ui-text-faint)]">{emptyCanvasHint}</p>
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
                tool="motion"
                welcomeCredits={visitorWelcomeCredits}
                runCost={estimatedCost}
                modelName={model.displayName}
                settingsSummary={settingsSummary}
                keepsPrompt={Boolean(prompt.trim())}
                keepsImages={Boolean(characterImageFile || referenceVideoFile)}
                onClose={() => setSignUpReason(null)}
            />

            <StudioMediaPreviewModal
                isOpen={Boolean(uploadPreview)}
                onClose={() => setUploadPreview(null)}
                mediaType={uploadPreview?.type ?? 'image'}
                src={uploadPreview?.src ?? null}
                alt={uploadPreview?.alt ?? 'Uploaded preview'}
                title={uploadPreview?.title ?? 'Media Preview'}
            />

        </div>
    );
}
