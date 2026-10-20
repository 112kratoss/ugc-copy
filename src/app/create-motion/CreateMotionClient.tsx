'use client';

import { readVideoDurationSeconds } from '@/lib/video-metadata-probe';
import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import GenerationResultVideo from '@/components/GenerationResultVideo';
import { Upload, Sparkles, Loader2, Download, Zap, ChevronDown, Check, Play, Share2, Images } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import {
    StudioBackgroundProcessingNotice,
    StudioGenerationStatus,
    GeneratorPageHeader,
    MediaStudioShell,
    StudioControlCard,
    StudioMediaPreviewModal,
    StudioModelNotice,
    StudioRemixHydrationNotice,
    StudioRemixNotice,
    StudioRunPanel,
    StudioUploadedMediaPreview,
    StudioWorkspacePanel,
} from '@/components/CreatorStudio';
import StudioModelPicker from '@/components/StudioModelPicker';
import CatalogAdditionalControls, { catalogChoiceDefault, useAdditionalCatalogSettings } from '@/components/CatalogAdditionalControls';
import PublicShareButton from '@/components/PublicShareButton';
import PublishToShowcaseModal from '@/components/PublishToShowcaseModal';
import EnhancePromptButton from '@/components/EnhancePromptButton';
import { useAuth } from '@/components/AuthProvider';
import type { RemixMediaAssetDescriptor, RemixSourceBundle } from '@/lib/remix-source';
import { hasCreatorEditedPromptDuringRemix } from '@/lib/remix-source';
import {
    createRestoredRemixAssetState,
    getRemixRestoreWarning,
} from '@/lib/remix-source-client';
import { buildShowcaseDetailPath } from '@/lib/share';
import type { GenerationPaywallPrefill } from '@/lib/generation-paywall';
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
    fetchGenerationStatusWithRetry,
    GenerationStatusRequestError,
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
import { useDeploymentRefresh } from '@/lib/use-deployment-refresh';
import { planMotionRunInputs } from '@/lib/creator-run-inputs';
// Kie's motion cap; the motion start refuses a longer prompt before anything is held.
import { catalogRunQuoteInput, MOTION_PROMPT_MAX_LENGTH } from '../../../ugc-mobile/lib/model-catalog/protocol';
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
    useWebGenerationModelQuote,
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

interface MotionPublishPrefill {
    generationId: string;
    title: string;
    paywallPrefill: GenerationPaywallPrefill | null;
}

/** A run that reached a failed status. Its hold is always returned. */
class MotionRunFailedError extends Error {}

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

function readPublishPrefill(generationId: string, payload: unknown): MotionPublishPrefill | null {
    const generations = isRecord(payload) && Array.isArray(payload.generations) ? payload.generations : [];
    const generation = generations.find((item): item is Record<string, unknown> => isRecord(item) && item.id === generationId);
    if (!generation) return null;
    const prefill = generation.paywallPrefill;
    return {
        generationId,
        title: typeof generation.title === 'string' ? generation.title : '',
        paywallPrefill: isRecord(prefill) && Array.isArray(prefill.resourceKinds) && typeof prefill.allowRemix === 'boolean'
            ? prefill as unknown as GenerationPaywallPrefill
            : null,
    };
}

function withSentenceEnd(message: string) {
    return /[.!?]$/.test(message.trim()) ? message.trim() : `${message.trim()}.`;
}

export default function CreateMotionClient({
    prefill,
    returnTo = '/create-motion',
}: {
    prefill: CreateMotionPrefill;
    /** This page with its params, for the sign-in round trip. */
    returnTo?: string;
}) {
    const router = useRouter();
    const { credits: userCredits, isLoading: isLoadingUser, session, updateCredits } = useAuth();
    const userId = session?.user?.id ?? null;
    const [selectedModel, setSelectedModel] = useState<ModelId>('kling-3.0');
    const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
    const modelCatalog = useWebGenerationModelCatalog({ kind: 'motion', selectedIds: [selectedModel], pickerOpen: isModelDropdownOpen });
    const catalogDescriptor = modelCatalog.catalog?.models.find(item => item.id === selectedModel);
    const refetchModelCatalog = modelCatalog.refetch;
    const [modelSearchQuery, setModelSearchQuery] = useState('');
    const dropdownRef = useRef<HTMLDivElement>(null);
    const hasResolvedInitialCatalogModel = useRef(false);
    const activeGenerationRequestKeyRef = useRef<string | null>(null);
    const generationPollAbortControllerRef = useRef<AbortController | null>(null);
    const characterImageInputRef = useRef<HTMLInputElement>(null);
    const referenceVideoInputRef = useRef<HTMLInputElement>(null);

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
    const [latestIsPublic, setLatestIsPublic] = useState(false);
    const [publishedMeta, setPublishedMeta] = useState<{ title: string; description: string } | null>(null);
    const [isPublishModalOpen, setIsPublishModalOpen] = useState(false);
    const [duration, setDuration] = useState<number>(0);
    const [characterOrientation, setCharacterOrientation] = useState<'video' | 'image'>('video');
    const [mode, setMode] = useState<'720p' | '1080p'>('720p');
    const [prompt, setPrompt] = useState<string>("No distortion, the character's movements are consistent with the video.");
    const [imagePickError, setImagePickError] = useState<string | null>(null);
    const [videoPickError, setVideoPickError] = useState<string | null>(null);
    const [unconfirmedStart, setUnconfirmedStart] = useState(false);
    const [creditRefusal, setCreditRefusal] = useState<{ message: string; balance: number | null; cost: number | null } | null>(null);
    const [publishPrefill, setPublishPrefill] = useState<MotionPublishPrefill | null>(null);
    // The account whose saved draft has been read. A remix page keeps no draft,
    // so nothing waits for one there.
    const [draftRestoredFor, setDraftRestoredFor] = useState<string | null>(null);
    const isDraftReady = Boolean(prefill.remixId) || !userId || draftRestoredFor === userId;
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
    const pendingDraftSaveRef = useRef<{ userId: string; draft: MotionTextDraft } | null>(null);

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
    }, [isDraftReady, modelCatalog.catalog, selectedModel, model, prefillModel, remixId]);
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
    const getPersistedMediaKey = (key: string) => (userId && !remixId ? scopedPersistedMediaKey(key, userId) : null);

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
        if (remixId || !userId) return;
        let cancelled = false;
        void (async () => {
            const [draft, savedImageFile, savedVideoFile] = await Promise.all([
                loadCreatorDraft<MotionTextDraft>('motion', userId).catch(() => null),
                getPersistedFile(scopedPersistedMediaKey(PERSISTED_MEDIA_KEYS.createMotionCharacterImage, userId)).catch(() => null),
                getPersistedFile(scopedPersistedMediaKey(PERSISTED_MEDIA_KEYS.createMotionReferenceVideo, userId)).catch(() => null),
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
            setDraftRestoredFor(userId);
        })();
        return () => {
            cancelled = true;
        };
        // Once per account: applySavedDraft reads this page's prefill, which does not change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [remixId, userId]);

    // Prompt, model and settings per account, a moment after each edit. A remix
    // page saves none: it restores from its source.
    useEffect(() => {
        if (remixId || !userId || !isDraftReady) return;
        const modelIsChosen = hasResolvedInitialCatalogModel.current || restoredDraftModelRef.current || Boolean(prefillModel);
        const pendingSave = {
            userId,
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
            void saveCreatorDraft('motion', pendingSave.userId, pendingSave.draft).catch(() => undefined);
        }, MOTION_DRAFT_SAVE_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [characterOrientation, duration, isDraftReady, mode, prefillModel, prefillPrompt, prompt, remixId, selectedModel, userId]);

    /** Writes the draft at once, for a page about to go away. */
    const flushDraftSave = async () => {
        const pendingSave = pendingDraftSaveRef.current;
        if (!pendingSave) return;
        pendingDraftSaveRef.current = null;
        try {
            await saveCreatorDraft('motion', pendingSave.userId, pendingSave.draft);
        } catch {
            // Storage refused: the files are saved already, and the page goes on.
        }
    };

    const redirectToSignIn = async () => {
        await flushDraftSave();
        router.push(`/login?returnUrl=${encodeURIComponent(returnTo)}`);
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

    /** How a started or resumed run that did not succeed ends on this page. */
    function settleRunError(runError: unknown, startedAtMs: number) {
        const message = runError instanceof Error ? runError.message : 'Something went wrong';
        if (message === BACKGROUND_PROCESSING_ERROR) {
            handoffToBackgroundProcessing(startedAtMs);
            return;
        }
        setGenerationTiming(null);
        if (runError instanceof MotionRunFailedError) {
            // A failed run's hold is always returned: show the balance that is true now.
            window.dispatchEvent(new Event('credits_updated'));
            const cost = latestRunCostRef.current;
            setError(cost !== null && cost > 0
                ? `${withSentenceEnd(message)} Your ${cost} ${cost === 1 ? 'credit was' : 'credits were'} returned.`
                : message);
            return;
        }
        setError(message);
    }

    const beginRunView = (startedAtMs: number, estimatedTotalMs: number | null, phaseLabel: string) => {
        setIsGenerating(true);
        setError(null);
        setCreditRefusal(null);
        setOutputVideo(null);
        setLatestGenerationId(null);
        setLatestIsPublic(false);
        setPublishedMeta(null);
        setPublishPrefill(null);
        latestRunCostRef.current = null;
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
    const handleStartRefusal = async (refusal: unknown) => {
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
            // Priced again at once: the run panel shows what the run costs now, and the
            // next press sends that price.
            setQuoteAttempt((current) => current + 1);
        }
    };

    /** Sends a start, new or unanswered, under its key and follows the run it answers with. */
    const sendStart = async (start: PendingWebStart, startedAtMs: number, estimatedTotalMs: number | null) => {
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
            await handleStartRefusal(startError);
            return;
        }
        forgetPendingStart();
        latestRunCostRef.current = started.cost;
        setLatestGenerationId(started.generationId ?? null);
        setLatestIsPublic(false);
        announceGenerationStarted();
        updateCredits(started.remainingCredits);

        const result = await pollPrediction(started.predictionId, startedAtMs, estimatedTotalMs);
        setOutputVideo(result.output);
        if (result.timing) {
            setGenerationTiming(result.timing);
        }
    };

    /** Check again: the unanswered start, sent exactly as it was. */
    const replayPendingStart = async (start: PendingWebStart) => {
        if (activeGenerationRequestKeyRef.current) return;
        activeGenerationRequestKeyRef.current = start.idempotencyKey;
        const createdAtMs = Date.parse(start.createdAt);
        const startedAtMs = Number.isFinite(createdAtMs) ? createdAtMs : getCurrentTimestampMs();
        const sentSettings = isRecord(start.body.settings) ? start.body.settings : {};
        const estimatedTotalMs = getMotionGenerationEstimate(
            typeof sentSettings.duration === 'number' ? sentSettings.duration : duration,
            typeof start.body.modelId === 'string' ? start.body.modelId : selectedModel,
            typeof sentSettings.resolution === 'string' ? sentSettings.resolution : mode,
        );
        beginRunView(startedAtMs, estimatedTotalMs, 'Checking your last motion run');
        setUnconfirmedStart(false);
        try {
            await sendStart(start, startedAtMs, estimatedTotalMs);
        } catch (runError) {
            settleRunError(runError, startedAtMs);
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
        const startedAtMs = getCurrentTimestampMs();
        const estimatedTotalMs = getMotionGenerationEstimate(runSettings.duration);
        beginRunView(startedAtMs, estimatedTotalMs, 'Preparing inputs');

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
            await sendStart(start, startedAtMs, estimatedTotalMs);
        } catch (runError) {
            settleRunError(runError, startedAtMs);
        } finally {
            activeGenerationRequestKeyRef.current = null;
            setIsGenerating(false);
        }
    };

    const handleGenerate = async () => {
        if (activeGenerationRequestKeyRef.current) return;
        // While a start is unconfirmed, a press checks it: a new key could pay for a second run.
        const pending = pendingStartRef.current ?? (userId ? loadPendingWebStart('motion', userId) : null);
        if (pending) {
            pendingStartRef.current = pending;
            await replayPendingStart(pending);
            return;
        }
        // The button is disabled until both inputs and a duration exist.
        if (!canGenerate) return;
        // A newer build is out: send from it rather than from this page. The
        // draft and both files are saved, so the reload loses nothing.
        if (newBuildAvailable && !remixId) {
            await flushDraftSave();
            window.location.reload();
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
    const resumeNewestMotionRun = async () => {
        const { data: { session: currentSession } } = await supabase.auth.getSession();
        if (!currentSession) return;
        const { data } = await supabase
            .from('generations')
            .select('id, prediction_id, status, created_at, duration')
            .eq('user_id', currentSession.user.id)
            .eq('category', 'video')
            .eq('creation_mode', 'motion')
            .in('status', ['processing', 'waiting'])
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (!data?.prediction_id || activeGenerationRequestKeyRef.current) return;
        activeGenerationRequestKeyRef.current = `resume:${data.prediction_id}`;
        const startedAtMs = Number.isNaN(Date.parse(data.created_at)) ? Date.now() : Date.parse(data.created_at);
        setIsGenerating(true);
        setError(null);
        setLatestGenerationId(data.id ?? null);
        setLatestIsPublic(false);
        latestRunCostRef.current = null;
        setGenerationTiming(createLocalGenerationTiming({
            kind: 'motion',
            phaseLabel: 'Resuming active run',
            startedAtMs,
            appStatus: data.status === 'waiting' ? 'waiting' : 'processing',
        }));
        if (typeof data.duration === 'number') {
            setDuration(data.duration);
        }

        try {
            const result = await pollPrediction(data.prediction_id, startedAtMs, null);
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
        void resumeNewestMotionRun();
        // Recovery is intentionally a mount-only lookup; changing form settings must not restart it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The quick-publish modal starts from the creation's own title and recipe.
    useEffect(() => {
        if (!outputVideo || !latestGenerationId) return;
        const generationId = latestGenerationId;
        const controller = new AbortController();
        void (async () => {
            try {
                const { data: { session: currentSession } } = await supabase.auth.getSession();
                if (!currentSession?.access_token || controller.signal.aborted) return;
                const response = await fetch(`/api/generations?${new URLSearchParams({
                    id: generationId,
                    includeArchived: 'true',
                    limit: '1',
                })}`, {
                    headers: { Authorization: `Bearer ${currentSession.access_token}` },
                    signal: controller.signal,
                });
                if (!response.ok) return;
                const nextPrefill = readPublishPrefill(generationId, await response.json());
                if (nextPrefill && !controller.signal.aborted) setPublishPrefill(nextPrefill);
            } catch {
                // Without it the modal publishes the media alone, as it did before.
            }
        })();
        return () => controller.abort();
    }, [latestGenerationId, outputVideo]);

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
    const [quoteAttempt, setQuoteAttempt] = useState(0);
    const quoteState = useWebGenerationModelQuote(quoteRequest, session?.access_token, quoteAttempt);
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
    const quotePending = quoteUi.blocksGenerate;
    // The price could not be read: Generate waits for one, and this asks again.
    const quoteRetry = quoteState.status === 'error' ? (
        <p className="text-sm text-amber-300">{quoteUi.message}<button type="button" onClick={() => setQuoteAttempt((current) => current + 1)} className="ml-2 underline underline-offset-2 hover:text-amber-100">Retry quote</button></p>
    ) : null;
    const insufficientCredits = userCredits !== null && estimatedCost !== null && estimatedCost > 0 && userCredits < estimatedCost;
    // The server's refusal holds until the balance or the price on screen moves.
    const creditRefusalMessage = creditRefusal && creditRefusal.balance === userCredits && creditRefusal.cost === estimatedCost
        ? creditRefusal.message
        : null;
    const showTopUp = (insufficientCredits || Boolean(creditRefusalMessage)) && !unconfirmedStart;
    const canGenerate = motionInputsReady && !videoError;
    const isBackgroundProcessing = error === BACKGROUND_PROCESSING_ERROR;
    const backgroundProcessingCopy = getBackgroundProcessingCopy('motion');
    // Watched only while idle, so a reload never lands mid-request. A remix page
    // keeps no draft, so it is never reloaded under the creator.
    const { newBuildAvailable } = useDeploymentRefresh(!isGenerating && !isBackgroundProcessing && !remixId);

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

    const workspaceTitle = outputVideo
        ? 'Latest motion result'
        : isGenerating
            ? 'Animating your character'
            : isBackgroundProcessing
                ? backgroundProcessingCopy.title
            : 'Ready to transfer motion';

    const workspaceDescription = outputVideo
        ? 'Your newest motion render stays here until you start another run.'
        : isGenerating
            ? 'Track the active generation here while the model maps movement and finishes the clip.'
            : isBackgroundProcessing
                ? backgroundProcessingCopy.description
            : 'Upload a character still and a motion reference. The active run and latest result will take over this workspace.';
    const shareTitle = publishedMeta?.title || prompt.trim() || `${model.displayName} motion clip`;
    const shareDescription = publishedMeta?.description || prompt.trim() || null;
    const publicResultPath = latestGenerationId && latestIsPublic ? buildShowcaseDetailPath(latestGenerationId) : null;

    return (
        <div className="ui-page ui-page-ambient min-h-screen py-6 text-[var(--ui-text-primary)] sm:py-8 font-[family-name:var(--font-geist-sans)]">
            <MediaStudioShell
                currentToolId="motion"
                header={
                    <GeneratorPageHeader
                        currentToolId="motion"
                        title="Create motion"
                        eyebrow={`Creator studio / ${model.displayName}`}
                        description="Upload the character, match it to reference movement, and let the workspace track the active motion render from setup to final clip."
                        credits={userCredits}
                    />
                }
                controls={
                    <>
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
                                        action={
                                            remixVideoUrl || canUseOriginalResultAsReferenceVideo ? (
                                                <div className="flex flex-wrap gap-2">
                                                    {remixVideoUrl ? (
                                                        <a
                                                            href={remixVideoUrl}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.08] hover:text-white"
                                                        >
                                                            <Play className="h-4 w-4" />
                                                            View original
                                                        </a>
                                                    ) : null}
                                                    {canUseOriginalResultAsReferenceVideo ? (
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
                            className="relative"
                            ref={dropdownRef}
                        >
                            <StudioControlCard title="Motion model" description="Choose the engine and quality ceiling for this run.">
                                <button
                                    onClick={() => {
                                        if (isModelDropdownOpen) setModelSearchQuery('');
                                        setIsModelDropdownOpen(!isModelDropdownOpen);
                                    }}
                                    aria-expanded={isModelDropdownOpen}
                                    aria-haspopup="listbox"
                                    className="w-full flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/40 px-4 py-4 text-left transition hover:border-white/15 hover:bg-black/55"
                                >
                                    <div className="flex items-center gap-3">
                                        <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-sky-400/20 bg-sky-400/10 text-sky-200">
                                            <Zap className="h-4 w-4" />
                                        </div>
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-semibold text-white">{model.displayName}</span>
                                                <span className={`rounded-full bg-gradient-to-r px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-white ${model.badgeColor}`}>
                                                    {model.badge}
                                                </span>
                                            </div>
                                            <p className="mt-1 text-sm text-zinc-400">{model.description}</p>
                                        </div>
                                    </div>
                                    <ChevronDown className={`h-4 w-4 text-zinc-400 transition-transform ${isModelDropdownOpen ? 'rotate-180' : ''}`} />
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
                                    searchLabel="Search motion models"
                                    searchPlaceholder="Search motion models..."
                                    resultListLabel="Motion models"
                                    resultCount={filteredMotionModelOptions.length}
                                    accent="violet"
                                    desktopInset="card"
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
                                                                <span className={`rounded-full bg-gradient-to-r px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-white ${motionModel.badgeColor}`}>
                                                                    {motionModel.badge}
                                                                </span>
                                                            </div>
                                                            <p className="mt-1 text-sm text-zinc-400">{motionModel.description}</p>
                                                            <div className="mt-2 flex flex-wrap gap-1.5">
                                                                <span className="rounded-full border border-white/8 bg-white/[0.03] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                                                                    Max {Number((motionModel as unknown as { maxVideoDuration?: number; maxDuration?: number }).maxVideoDuration ?? (motionModel as unknown as { maxDuration?: number }).maxDuration ?? 30)}s
                                                                </span>
                                                                <span className="rounded-full border border-white/8 bg-white/[0.03] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                                                                    {(motionModel.resolutions as readonly string[]).join(' / ')}
                                                                </span>
                                                            </div>
                                                        </div>
                                                        {isActive ? <Check className="h-4 w-4 shrink-0 text-[#ff9a80]" /> : null}
                                                    </button>
                                                );
                                            })}
                                </StudioModelPicker>
                            <CatalogAdditionalControls descriptor={catalogDescriptor} handledKeys={CATALOG_HANDLED_KEYS} settings={{ resolution: mode, characterOrientation, duration, ...additionalSettings.settings }} inputCounts={{ images: characterImage ? 1 : 0, videos: referenceVideo ? 1 : 0, audios: 0 }} onChange={additionalSettings.onChange} />
                            </StudioControlCard>
                        </motion.div>

                        <StudioControlCard
                            title="Character image"
                            description="A clear still works best. The model uses this as the identity anchor."
                            meta={<span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Step 1</span>}
                        >
                            {characterImage ? (
                                <div className="h-[280px]">
                                    <StudioUploadedMediaPreview
                                        mediaType="image"
                                        src={characterImage}
                                        alt="Character image"
                                        fit="contain"
                                        previewHint="Preview image"
                                        onPreview={() => setUploadPreview({
                                            type: 'image',
                                            src: characterImage,
                                            alt: 'Character image',
                                            title: 'Character Image',
                                        })}
                                        onReplace={() => characterImageInputRef.current?.click()}
                                        onRemove={() => void handleClearImage()}
                                    />
                                </div>
                            ) : (
                                <label
                                    htmlFor="motion-character-image-input"
                                    className={`group flex h-[280px] w-full cursor-pointer flex-col items-center justify-center overflow-hidden rounded-[24px] border-2 border-dashed bg-black/40 transition ${isDraggingImage
                                        ? 'border-sky-400 bg-sky-500/10 shadow-[0_0_30px_-5px_rgba(56,189,248,0.24)]'
                                        : 'border-zinc-700/50 hover:border-sky-500/50 hover:bg-sky-500/5'
                                        }`}
                                    onDragOver={(event) => handleDragOver(event, setIsDraggingImage)}
                                    onDragLeave={(event) => handleDragLeave(event, setIsDraggingImage)}
                                    onDrop={handleImageDrop}
                                >
                                    <div className="flex flex-col items-center gap-3 text-center text-zinc-500">
                                        <Upload className={`h-8 w-8 transition-colors ${isDraggingImage ? 'text-sky-300' : ''}`} />
                                        <div>
                                            <p className="text-sm font-medium text-zinc-300">
                                                {isDraggingImage ? 'Drop image here' : 'Click or drag in the character image'}
                                            </p>
                                            <p className="mt-1 text-xs text-zinc-500">JPG, PNG, WEBP. Use a clean full-body frame when possible.</p>
                                        </div>
                                    </div>
                                </label>
                            )}
                            <input
                                ref={characterImageInputRef}
                                id="motion-character-image-input"
                                type="file"
                                accept="image/*"
                                onChange={handleImageUpload}
                                className="hidden"
                            />
                            {imagePickError ? (
                                <div className="mt-4 rounded-[20px] border border-rose-500/20 bg-rose-500/10 px-4 py-3">
                                    <p className="text-sm text-rose-300">{imagePickError}</p>
                                </div>
                            ) : null}
                        </StudioControlCard>

                        <StudioControlCard
                            title="Reference video"
                            description="This clip drives the movement timing and overall energy."
                            meta={<span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Step 2</span>}
                        >
                            <div className="space-y-4">
                                {referenceVideo ? (
                                    <div className="h-[280px]">
                                        <StudioUploadedMediaPreview
                                            mediaType="video"
                                            src={referenceVideo}
                                            alt="Reference video"
                                            fit="contain"
                                            previewHint="Preview video"
                                            onPreview={() => setUploadPreview({
                                                type: 'video',
                                                src: referenceVideo,
                                                alt: 'Reference video',
                                                title: 'Reference Video',
                                            })}
                                            onReplace={() => referenceVideoInputRef.current?.click()}
                                            onRemove={() => void handleClearVideo()}
                                        />
                                    </div>
                                ) : (
                                    <label
                                        htmlFor="motion-reference-video-input"
                                        className={`group flex h-[280px] w-full cursor-pointer flex-col items-center justify-center overflow-hidden rounded-[24px] border-2 border-dashed bg-black/40 transition ${isDraggingVideo
                                            ? 'border-[#ff7a59] bg-[#ff7a59]/10 shadow-[0_0_30px_-5px_rgba(255,122,89,0.24)]'
                                            : 'border-zinc-700/50 hover:border-[#ff7a59]/50 hover:bg-[#ff7a59]/5'
                                            }`}
                                        onDragOver={(event) => handleDragOver(event, setIsDraggingVideo)}
                                        onDragLeave={(event) => handleDragLeave(event, setIsDraggingVideo)}
                                        onDrop={handleVideoDrop}
                                    >
                                        <div className="flex flex-col items-center gap-3 text-center text-zinc-500">
                                            <Upload className={`h-8 w-8 transition-colors ${isDraggingVideo ? 'text-[#ff9a80]' : ''}`} />
                                            <div>
                                                <p className="text-sm font-medium text-zinc-300">
                                                    {isDraggingVideo ? 'Drop video here' : 'Click or drag in the motion reference'}
                                                </p>
                                                <p className="mt-1 text-xs text-zinc-500">MP4 or MOV, up to 100MB and {maxVideoDuration}s.</p>
                                            </div>
                                        </div>
                                    </label>
                                )}
                                <input
                                    ref={referenceVideoInputRef}
                                    id="motion-reference-video-input"
                                    type="file"
                                    accept="video/*"
                                    onChange={handleVideoUpload}
                                    className="hidden"
                                />

                                <div className="flex flex-wrap items-center justify-between gap-3 rounded-[20px] border border-white/8 bg-black/30 px-4 py-3 text-sm text-zinc-400">
                                    <span>{duration > 0 ? `Reference length: ${duration.toFixed(1)}s` : 'Reference length will appear after upload.'}</span>
                                    <span>Limit: {maxVideoDuration}s</span>
                                </div>

                                {videoPickError ? (
                                    <div className="rounded-[20px] border border-rose-500/20 bg-rose-500/10 px-4 py-3">
                                        <p className="text-sm text-rose-300">{videoPickError}</p>
                                    </div>
                                ) : null}
                                {videoError ? (
                                    <div className="rounded-[20px] border border-rose-500/20 bg-rose-500/10 px-4 py-3">
                                        <p className="text-sm text-rose-300">{videoError}</p>
                                    </div>
                                ) : null}
                            </div>
                        </StudioControlCard>

                        <StudioControlCard title="Prompt" description="Guide the performance, energy, and cleanup details for the transfer.">
                            <EnhancePromptButton
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
                            />
                            <textarea
                                ref={promptInputRef}
                                value={prompt}
                                onChange={(event) => {
                                    promptEditedRef.current = true;
                                    setPrompt(event.target.value);
                                }}
                                placeholder="Describe the kind of movement, pacing, and constraints you want to preserve."
                                maxLength={MOTION_PROMPT_MAX_LENGTH}
                                className="mt-3 min-h-[140px] w-full resize-y rounded-2xl border border-white/10 bg-black/50 p-5 text-sm leading-relaxed text-white outline-none transition focus:border-[#ff7a59]/50 focus:ring-4 focus:ring-[#ff7a59]/10"
                            />
                            <div className="mt-3 flex justify-end text-xs text-zinc-500">{prompt.length}/{MOTION_PROMPT_MAX_LENGTH}</div>
                        </StudioControlCard>

                        <StudioControlCard title="Output settings" description="Set how closely the result follows the reference and the fidelity you want.">
                            <div className="grid gap-5 sm:grid-cols-2">
                                <div>
                                    <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Character orientation</div>
                                    <div className="grid grid-cols-2 gap-2">
                                        {model.characterOrientations.map((option) => (
                                            <button
                                                key={option}
                                                onClick={() => setCharacterOrientation(option)}
                                                className={`rounded-2xl px-4 py-3 text-sm font-semibold transition ${characterOrientation === option
                                                    ? 'border border-sky-500/30 bg-sky-500/15 text-sky-100'
                                                    : 'border border-white/8 bg-black/40 text-zinc-400 hover:bg-white/[0.05] hover:text-white'
                                                    }`}
                                            >
                                                {option === 'video' ? 'Follow video' : 'Favor image'}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div>
                                    <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Quality mode</div>
                                    <div className="grid grid-cols-2 gap-2">
                                        {model.resolutions.map((quality) => (
                                            <button
                                                key={quality}
                                                onClick={() => setMode(quality)}
                                                className={`rounded-2xl px-4 py-3 text-sm font-semibold transition ${mode === quality
                                                    ? 'border border-[#ff7a59]/30 bg-[#ff7a59]/15 text-[#ffc1b2]'
                                                    : 'border border-white/8 bg-black/40 text-zinc-400 hover:bg-white/[0.05] hover:text-white'
                                                    }`}
                                            >
                                                {quality === '720p' ? 'Standard 720p' : quality === '1080p' ? 'Pro 1080p' : quality}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </StudioControlCard>
                    </>
                }
                workspace={
                    <>
                        <StudioRunPanel
                            title={isGenerating ? 'Motion run in progress' : 'Ready to animate'}
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
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Reference</div>
                                        <div className="mt-1 text-zinc-200">{duration > 0 ? `${duration.toFixed(1)}s` : 'Not loaded'}</div>
                                    </div>
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Quality</div>
                                        <div className="mt-1 text-zinc-200">{mode}</div>
                                    </div>
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Orientation</div>
                                        <div className="mt-1 text-zinc-200">{characterOrientation === 'video' ? 'Follow video' : 'Favor image'}</div>
                                    </div>
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Credits left</div>
                                        <div className="mt-1 text-zinc-200">{userCredits ?? '...'}</div>
                                    </div>
                                </div>
                            }
                            action={
                                showTopUp ? (
                                    <div className="space-y-4">
                                        <div className="rounded-[22px] border border-rose-500/20 bg-rose-500/10 p-4">
                                            <p className="text-sm font-semibold text-white">Not enough credits</p>
                                            {insufficientCredits ? (
                                                <p className="mt-2 text-sm text-zinc-400">
                                                    This run costs <strong className="text-white">{estimatedCost} credits</strong> but you only have <strong className="text-white">{userCredits}</strong>.
                                                </p>
                                            ) : (
                                                <p className="mt-2 text-sm text-zinc-400">{creditRefusalMessage}</p>
                                            )}
                                        </div>
                                        <Link href="/pricing" className="ui-focus-ring flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-6 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985]">
                                            <Sparkles className="h-4 w-4" />
                                            Top Up Credits
                                        </Link>
                                    </div>
                                ) : (
                                    <button
                                        onClick={() => void handleGenerate()}
                                        disabled={isGenerating || (!unconfirmedStart && (!canGenerate || quotePending))}
                                        className="ui-focus-ring flex min-h-14 w-full items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-6 py-4 text-base font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        {isGenerating ? (
                                            <>
                                                <Loader2 className="h-5 w-5 animate-spin" />
                                                Generating...
                                            </>
                                        ) : unconfirmedStart ? (
                                            <>
                                                <Sparkles className="h-5 w-5" />
                                                Check again
                                            </>
                                        ) : (
                                            <>
                                                <Sparkles className="h-5 w-5" />
                                                Generate motion
                                            </>
                                        )}
                                    </button>
                                )
                            }
                            status={
                                <>
                                    {isGenerating && generationTiming ? (
                                        <StudioGenerationStatus
                                            accent="violet"
                                            timing={generationTiming}
                                            nowMs={nowMs}
                                        />
                                    ) : isBackgroundProcessing ? (
                                        <StudioBackgroundProcessingNotice
                                            accent="violet"
                                            label="motion render"
                                            phaseLabel={backgroundTiming?.phaseLabel ?? null}
                                            timingLabel={backgroundTimingLabel}
                                        />
                                    ) : unconfirmedStart ? (
                                        <div className="space-y-2">
                                            <p className="text-sm text-amber-300">{UNCONFIRMED_START_MESSAGE}</p>
                                            <button
                                                type="button"
                                                onClick={() => void startNewRunInstead()}
                                                disabled={!canGenerate || quotePending}
                                                className="text-sm text-zinc-300 underline underline-offset-2 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                {estimatedCost !== null ? `Start a new run · ${estimatedCost} ${estimatedCost === 1 ? 'credit' : 'credits'}` : 'Start a new run'}
                                            </button>
                                        </div>
                                    ) : videoError ? (
                                        <p className="text-sm text-rose-300">{videoError}</p>
                                    ) : error ? (
                                        // A price that could not be read since (asked again after
                                        // `cost_changed`, say) keeps its Retry under the error:
                                        // Generate waits for a price.
                                        <div className="space-y-2">
                                            <p className="text-sm text-rose-300">{error}</p>
                                            {quoteRetry}
                                        </div>
                                    ) : quoteState.status === 'error' ? (
                                        quoteRetry
                                    ) : hasCatalogSettings && !motionInputsReady ? (
                                        <p className="text-sm text-zinc-400">{quoteUi.message}</p>
                                    ) : (
                                        <p className="text-sm text-zinc-500">Upload both inputs, confirm the orientation, and the latest motion render will replace this workspace.</p>
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
                            {outputVideo ? (
                                <div className="space-y-5">
                                    <div className="aspect-video overflow-hidden rounded-[26px] border border-white/8 bg-black/60">
                                        <GenerationResultVideo generationId={latestGenerationId} outputUrl={outputVideo} accessToken={session?.access_token} onOriginalResolved={setResolvedOutputVideo} />
                                    </div>
                                    <div className="flex flex-wrap gap-3">
                                        <a
                                            href={resolvedOutputVideo?.outputUrl === outputVideo ? resolvedOutputVideo.url : outputVideo}
                                            download="generated-video.mp4"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-2 rounded-full bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500"
                                        >
                                            <Download className="h-4 w-4" />
                                            Download video
                                        </a>
                                        {latestGenerationId ? (
                                            latestIsPublic ? (
                                                <>
                                                    <PublicShareButton
                                                        generationId={latestGenerationId}
                                                        viewerIsOwner
                                                        title={shareTitle}
                                                        description={shareDescription}
                                                        sourceSurface="create-motion"
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
                                                    onClick={() => setIsPublishModalOpen(true)}
                                                    className="ui-focus-ring inline-flex items-center gap-2 rounded-full bg-[var(--ui-primary)] px-5 py-3 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985]"
                                                >
                                                    <Share2 className="h-4 w-4" />
                                                    Publish & share
                                                </button>
                                            )
                                        ) : null}
                                        <button
                                            onClick={() => {
                                                setOutputVideo(null);
                                                setLatestGenerationId(null);
                                                setLatestIsPublic(false);
                                                setPublishedMeta(null);
                                                setError(null);
                                                setGenerationTiming(null);
                                            }}
                                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-5 py-3 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                                        >
                                            Start another run
                                        </button>
                                    </div>
                                </div>
                            ) : isGenerating ? (
                                <div className="flex min-h-[520px] flex-col items-center justify-center gap-5 rounded-[26px] border border-dashed border-white/10 bg-black/40 p-10 text-center">
                                    <div className="flex h-16 w-16 items-center justify-center rounded-full border border-[#ff7a59]/25 bg-[#ff7a59]/10">
                                        <Loader2 className="h-7 w-7 animate-spin text-[#ff9a80]" />
                                    </div>
                                    <div>
                                        <h3 className="text-xl font-semibold text-white">Transferring the motion</h3>
                                        <p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">
                                            The workspace will switch from progress to preview as soon as the current render finishes.
                                        </p>
                                    </div>
                                </div>
                            ) : isBackgroundProcessing ? (
                                <StudioBackgroundProcessingNotice
                                    accent="violet"
                                    label="motion render"
                                    variant="workspace"
                                    phaseLabel={backgroundTiming?.phaseLabel ?? null}
                                    timingLabel={backgroundTimingLabel}
                                />
                            ) : (
                                <div className="flex min-h-[520px] flex-col items-center justify-center gap-5 rounded-[26px] border border-dashed border-white/10 bg-black/40 p-10 text-center">
                                    <div className="flex h-16 w-16 items-center justify-center rounded-full border border-[#ff7a59]/25 bg-[#ff7a59]/10">
                                        <Play className="h-7 w-7 text-[#ff9a80]" />
                                    </div>
                                    <div>
                                        <h3 className="text-xl font-semibold text-white">No motion run yet</h3>
                                        <p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">
                                            Add the character image, the motion reference, and the prompt. The latest rendered clip will take over this workspace.
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
                mediaType={uploadPreview?.type ?? 'image'}
                src={uploadPreview?.src ?? null}
                alt={uploadPreview?.alt ?? 'Uploaded preview'}
                title={uploadPreview?.title ?? 'Media Preview'}
            />

            <PublishToShowcaseModal
                isOpen={isPublishModalOpen}
                onClose={() => setIsPublishModalOpen(false)}
                generationId={latestGenerationId}
                accessToken={session?.access_token ?? null}
                defaultTitle={publishPrefill?.generationId === latestGenerationId ? publishPrefill.title : ''}
                paywallPrefill={publishPrefill?.generationId === latestGenerationId ? publishPrefill.paywallPrefill : null}
                shareAfterPublish={latestGenerationId ? {
                    title: shareTitle,
                    description: shareDescription,
                    sourceSurface: 'create-motion',
                } : undefined}
                onPublished={(payload) => {
                    setLatestIsPublic(true);
                    setPublishedMeta(payload);
                    setIsPublishModalOpen(false);
                }}
            />
        </div>
    );
}
