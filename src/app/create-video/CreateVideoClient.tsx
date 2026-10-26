'use client';

import RecoverableMediaAudio from '@/components/RecoverableMediaAudio';
import InlineMediaVideo from '@/components/InlineMediaVideo';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import GenerationResultVideo from '@/components/GenerationResultVideo';
import { Sparkles, Loader2, Download, X, Image as ImageIcon, Video, Plus, Trash2, Volume2, Play, Check, Share2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import {
    CREATOR_BAR_PRIMARY_CLASS,
    CreatorCanvas,
    CreatorCanvasFrame,
    CreatorCanvasMedia,
    CreatorColumnBar,
    CreatorColumnLayout,
    CreatorModelChip,
    CreatorPhoneBalance,
    CreatorSettingChoices,
    CreatorSettingSwitch,
    CreatorTemplatesTile,
    CreatorToolTabs,
} from '@/components/CreatorColumn';
import { IconButton } from '@/components/DesignSystem';
import { videoSettingsSummary } from '@/lib/creator-settings-summary';
import {
    StudioBackgroundProcessingNotice,
    StudioElementChip,
    StudioElementHandle,
    StudioElementHandleList,
    StudioElementHandleText,
    StudioGenerationStatus,
    StudioMediaPreviewModal,
    StudioModelNotice,
    StudioOutOfDatePageNotice,
    StudioQuoteRetry,
    StudioRemixHydrationNotice,
    StudioRemixNotice,
    StudioUploadedMediaPreview,
} from '@/components/CreatorStudio';
import StudioModelPicker from '@/components/StudioModelPicker';
import CatalogAdditionalControls, { catalogChoiceDefault, useAdditionalCatalogSettings } from '@/components/CatalogAdditionalControls';
import PublicShareButton from '@/components/PublicShareButton';
import PublishToShowcaseModal from '@/components/PublishToShowcaseModal';
import { readCreationTitleSource, type CreationTitleSource } from '@/lib/creation-post-title';
import EnhancePromptButton from '@/components/EnhancePromptButton';
import { ALWAYS_ON_AUDIO_VIDEO_MODELS, clampVideoDuration, getDefaultVideoDuration, getVideoDurationRange, isValidVideoDuration, VIDEO_MODELS, VideoModelId } from '@/lib/client-generation-models';
import { getVideoInputAffordances, getVideoRunAffordances } from '@/lib/generation-model-affordances';
import { planVideoRunInputs, type VideoRunInput } from '@/lib/creator-run-inputs';
import type { CatalogGenerationInputAsset, CatalogGenerationRequestPayload } from '@/lib/generation-model-adapters';
import type { CatalogPrimitive, GenerationModelDescriptor } from '@/lib/generation-model-catalog';
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
import type { GenerationPaywallPrefill } from '@/lib/generation-paywall';
import { catalogRunQuoteInput, GENERATION_PROMPT_MAX_LENGTH } from '../../../ugc-mobile/lib/model-catalog/protocol';
import {
    creatorPromptViolation,
    promptLengthMeter,
    promptLimitFor,
} from '../../../ugc-mobile/lib/model-catalog/provider-prompt-limits';
import PromptLengthCounter from '@/components/PromptLengthCounter';
import { useAuth } from '@/components/AuthProvider';
import type { RemixMediaAssetDescriptor, RemixResolvedAsset, RemixSourceBundle } from '@/lib/remix-source';
import { hasCreatorEditedPromptDuringRemix } from '@/lib/remix-source';
import {
    createRemixElementSeeds,
    getRemixReferenceCapWarning,
    joinRemixRestoreWarnings,
    REMIX_RESTORE_WARNING,
    createRestoredRemixAssetState,
    getRemixRestoreWarning,
} from '@/lib/remix-source-client';
import { buildShowcaseDetailPath } from '@/lib/share';
import {
    getPersistedFile,
    getPersistedImageElementRecords,
    getPersistedMediaRecords,
    getPersistedSubjectRecords,
    getPersistedValue,
    PERSISTED_MEDIA_KEYS,
    purgeLegacyPersistedMedia,
    removePersistedMedia,
    scopedPersistedMediaKey,
    setPersistedFile,
    setPersistedImageElementRecords,
    setPersistedMediaRecords,
    setPersistedSubjectRecords,
    setPersistedValue,
} from '@/lib/persisted-media';
import { loadCreatorDraft, saveCreatorDraft } from '@/lib/persisted-creator-draft';
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
    assignElementHandles,
    assignSubjectHandles,
    createElementHandleReplacementMap,
    createElementId,
    extractPromptHandles,
    findUnknownPromptHandles,
    getMentionQueryAtCaret,
    insertHandleIntoPrompt,
    replacePromptHandles,
    type ImageElementDescriptor,
} from '@/lib/image-elements';
import {
    createSeedanceAssetMetadata,
    getSeedanceAssetSourceName,
    getSeedanceAssetStatusLabel,
    isSeedance2VideoModelId,
    type SeedanceAssetCollections,
    type SeedanceAssetKind,
    type SeedanceAssetMetadata,
} from '@/lib/seedance-assets';
import {
    createLocalGenerationTiming,
    estimateGenerationDurationMs,
    freezeGenerationTiming,
    getCurrentTimestampMs,
    getGenerationTimingSummaryLabel,
    type GenerationTiming,
} from '@/lib/generation-timing';
import { useCreatorQuote } from '@/lib/use-creator-quote';
import { reloadBroughtBackThisBuild, reloadForNewerBuild, useDeploymentRefresh } from '@/lib/use-deployment-refresh';
import { useNameDrafts } from '@/lib/use-name-drafts';
import { useTicker } from '@/lib/use-ticker';
import {
    inspectPromptQuality,
    type PromptEnhancementWarning,
} from '@/lib/prompt-quality';
import type { StorageMediaKind } from '@/lib/storage-upload-mime-policy';
import {
    refreshTemporaryMediaUrl,
    TEMPORARY_MEDIA_UPLOAD_LIMITS,
    TemporaryMediaReadUrlError,
    uploadMediaToTemporaryStorage,
} from '@/lib/temporary-media-upload';
import { readVideoDurationSeconds } from '@/lib/video-metadata-probe';
import { RECLAIM_AFTER_HOURS } from '@/lib/media-upload-reclaim';

interface MultiShot {
    id: string;
    prompt: string;
    duration: number;
}

const KLING_VIDEO_ELEMENT_LIMIT = 3;
const KLING_VIDEO_ELEMENT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Shots per multi-shot run: Kie's multi_prompt takes at most 5 for Kling 3.0 and 6 for
 * Kling O3. The prompt check refuses a run past them with the same numbers
 * (src/lib/prompt-quality.ts), and the app holds its shot editor to them too
 * (catalogMultiShotLimits); no descriptor publishes them yet.
 */
const MULTI_SHOT_MAX_SHOTS: Readonly<Partial<Record<string, number>>> = {
    'kling-3.0-video': 5,
    'kling-o3': 6,
};

/** A multi-shot run's length, as the server derives it from the shots: each one whole and at least a second. */
function multiShotTotalDuration(shots: readonly { duration: number }[]): number {
    return shots.reduce((total, shot) => total + Math.max(1, Math.round(shot.duration)), 0);
}

/**
 * How long a file uploaded for a run is sent again by its staged path rather than
 * uploaded once more. The reclaim sweep deletes a staged object a run has used
 * RECLAIM_AFTER_HOURS after it was signed; eight hours short of that stays clear of it.
 */
const STAGED_UPLOAD_REUSE_MS = (RECLAIM_AFTER_HOURS - 8) * 60 * 60 * 1000;

/** Where a reference's file was uploaded for a run, and when. */
type StagedUpload = { storagePath: string; signedUrl: string; uploadedAt: number };

/**
 * A reference file staged for a run: the object uploaded for an earlier run, under a
 * fresh link, while it is younger than STAGED_UPLOAD_REUSE_MS, or a new upload. Every
 * press used to upload every reference again, each one a sign request against the
 * limit of 60 a user per 10 minutes. An object the sweep took anyway answers
 * MEDIA_OBJECT_NOT_FOUND, and the file goes up again.
 */
async function stageReferenceFile(file: File, staged: StagedUpload | null | undefined): Promise<StagedUpload> {
    if (staged && Date.now() - staged.uploadedAt < STAGED_UPLOAD_REUSE_MS) {
        try {
            return { ...staged, signedUrl: await refreshTemporaryMediaUrl(staged.storagePath) };
        } catch (refreshError) {
            if (!(refreshError instanceof TemporaryMediaReadUrlError && refreshError.code === 'MEDIA_OBJECT_NOT_FOUND')) {
                throw refreshError;
            }
        }
    }
    const upload = await uploadMediaToTemporaryStorage(file);
    return { storagePath: upload.storagePath, signedUrl: upload.signedUrl, uploadedAt: Date.now() };
}

const PICKED_FILE_RULES: Record<StorageMediaKind, { use: string; limitFor: string }> = {
    image: { use: 'a JPEG, PNG, WebP, GIF, AVIF or HEIC image', limitFor: 'an image' },
    video: { use: 'an MP4, MOV, WebM or M4V video', limitFor: 'a video' },
    audio: { use: 'an MP3, AAC, WAV, OGG or WebM audio file', limitFor: 'an audio file' },
};

/**
 * The picked files the upload step will take, and a sentence naming each one it would
 * refuse. A refused file used to be kept and saved, and every Generate then failed on
 * it without saying which file it was.
 */
function screenPickedFiles(files: File[], kind: StorageMediaKind): { accepted: File[]; refusal: string | null } {
    const maxBytes = TEMPORARY_MEDIA_UPLOAD_LIMITS.maxBytesByKind[kind];
    const rules = PICKED_FILE_RULES[kind];
    const refusals: string[] = [];
    const accepted = files.filter((file) => {
        const name = file.name || 'This file';
        if (!TEMPORARY_MEDIA_UPLOAD_LIMITS.isAllowedMimeType(kind, file.type)) {
            refusals.push(`${name} can’t be used: add ${rules.use}.`);
            return false;
        }
        if (file.size > maxBytes) {
            refusals.push(`${name} is over the ${Math.round(maxBytes / (1024 * 1024))} MB limit for ${rules.limitFor}.`);
            return false;
        }
        return true;
    });
    return { accepted, refusal: refusals.length > 0 ? refusals.join(' ') : null };
}

/** What the run panel says when picks were left out because the model takes no more. */
function droppedPicksNotice(added: number, picked: number, limit: number, noun: string): string | null {
    if (added >= picked) return null;
    return `Added ${added} of ${picked}: this model takes up to ${limit} ${noun}${limit === 1 ? '' : 's'}.`;
}

const START_UNCONFIRMED_MESSAGE = 'We couldn’t confirm your generation started. Check again — that can’t start a second run.';

/**
 * The link a remixed clip or track is sent by: its own, or for an asset id that an
 * older run kept in its place, the link the asset was prepared from. The server
 * measures it, so only an https link will do.
 */
function measurableRemixLink(value: string, asset: SeedanceAssetMetadata | undefined): string | null {
    const url = /^https:\/\//i.test(value) ? value : asset?.sourceUrl ?? null;
    return url && /^https:\/\//i.test(url) ? url : null;
}

/** A run the provider ended as failed. Every failed settlement returns the run's credits. */
class VideoRunFailedError extends Error {}

function creditsReturnedSentence(cost: number | null | undefined): string {
    return typeof cost === 'number' && cost > 0
        ? ` Your ${cost} credit${cost === 1 ? ' was' : 's were'} returned.`
        : '';
}

/** The measured lengths a REFERENCE_DURATION_CHANGED refusal carries, by the place of each input in the request. */
function readMeasuredInputDurations(details: Readonly<Record<string, unknown>>): Array<{ index: number; durationSeconds: number }> {
    const inputs = details.inputs;
    if (!Array.isArray(inputs)) return [];
    return inputs.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const { index, durationSeconds } = entry as { index?: unknown; durationSeconds?: unknown };
        return typeof index === 'number' && Number.isInteger(index) && index >= 0
            && typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0
            ? [{ index, durationSeconds }]
            : [];
    });
}

/**
 * What the form keeps through a reload, a top-up round trip or a lost session, per
 * account (persisted-creator-draft.ts). Only the files used to come back; the prompt,
 * the model and every setting were lost. The reference mode is not kept: the page
 * reads it from what is attached.
 */
type VideoCreatorDraft = {
    prompt: string;
    modelId: string;
    mode: string;
    aspectRatio: string;
    sound: boolean;
    resolution: string;
    fixedLens: boolean;
    isMultiShot: boolean;
    shots: MultiShot[];
    duration: number;
    additionalSettings: { modelId: string; values: Record<string, CatalogPrimitive> };
};

/**
 * A saved draft, field by field: a build that saved it may have shaped it otherwise,
 * and a field this build cannot read is left at what the page has.
 */
function readVideoCreatorDraft(value: unknown): Partial<VideoCreatorDraft> {
    if (!value || typeof value !== 'object') return {};
    const stored = value as Record<string, unknown>;
    const text = (key: string) => (typeof stored[key] === 'string' ? stored[key] as string : undefined);
    const flag = (key: string) => (typeof stored[key] === 'boolean' ? stored[key] as boolean : undefined);
    const modelId = text('modelId');
    const shots = Array.isArray(stored.shots)
        ? stored.shots.flatMap((shot, index): MultiShot[] => {
            if (!shot || typeof shot !== 'object') return [];
            const { id, prompt, duration } = shot as Record<string, unknown>;
            return typeof prompt === 'string' && typeof duration === 'number' && Number.isFinite(duration)
                ? [{ id: typeof id === 'string' && id ? id : `${index + 1}`, prompt, duration: Math.min(12, Math.max(1, Math.round(duration))) }]
                : [];
        })
        : undefined;
    const additional = stored.additionalSettings as { modelId?: unknown; values?: unknown } | undefined;
    const additionalValues = additional && typeof additional.values === 'object' && additional.values !== null
        ? Object.fromEntries(Object.entries(additional.values as Record<string, unknown>).filter(([, setting]) => (
            typeof setting === 'string' || typeof setting === 'number' || typeof setting === 'boolean'
        ))) as Record<string, CatalogPrimitive>
        : null;
    const duration = typeof stored.duration === 'number' && Number.isFinite(stored.duration) ? stored.duration : undefined;
    return {
        prompt: text('prompt')?.slice(0, GENERATION_PROMPT_MAX_LENGTH),
        modelId: modelId && modelId in VIDEO_MODELS ? modelId : undefined,
        mode: text('mode'),
        aspectRatio: text('aspectRatio'),
        sound: flag('sound'),
        resolution: text('resolution'),
        fixedLens: flag('fixedLens'),
        isMultiShot: flag('isMultiShot'),
        shots: shots && shots.length > 0 ? shots : undefined,
        duration,
        additionalSettings: additionalValues && typeof additional?.modelId === 'string'
            ? { modelId: additional.modelId, values: additionalValues }
            : undefined,
    };
}

function isPaywallPrefill(value: unknown): value is GenerationPaywallPrefill {
    return Boolean(value) && typeof value === 'object' && Array.isArray((value as { resourceKinds?: unknown }).resourceKinds);
}

type CreationPublishDefaults = {
    generationId: string;
    title: string;
    paywallPrefill: GenerationPaywallPrefill | null;
    /** What the modal suggests a title from when the creation has none. */
    creation: CreationTitleSource | null;
};

/**
 * The creation's own title and recipe, for the quick-publish modal: opened without
 * them it published the media alone, while the same creation from Studio offered its
 * recipe. Read from the owner's library entry, as Studio reads it.
 */
async function loadCreationPublishDefaults(generationId: string, accessToken: string | null | undefined): Promise<CreationPublishDefaults> {
    const fallback: CreationPublishDefaults = { generationId, title: '', paywallPrefill: null, creation: null };
    if (!accessToken) return fallback;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(`/api/generations?${new URLSearchParams({ id: generationId, includeArchived: 'true', limit: '1' })}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            cache: 'no-store',
            signal: controller.signal,
        });
        if (!response.ok) return fallback;
        const payload = await response.json() as { generations?: Array<{ id?: unknown; title?: unknown; paywallPrefill?: unknown }> };
        const generation = Array.isArray(payload.generations)
            ? payload.generations.find((item) => item?.id === generationId)
            : undefined;
        return {
            generationId,
            title: typeof generation?.title === 'string' ? generation.title : '',
            paywallPrefill: isPaywallPrefill(generation?.paywallPrefill) ? generation.paywallPrefill : null,
            creation: readCreationTitleSource(generation),
        };
    } catch {
        // Without them the modal still publishes the media; nothing is lost but the prefill.
        return fallback;
    } finally {
        clearTimeout(timeout);
    }
}

/** Single shot or multi-shot, as the app's segmented control offers them. */
const SHOT_MODES = ['single', 'multi'] as const;

/** A settings group's columns: its options on one row where up to five fit. */
function choiceColumns(count: number): 3 | 4 | 5 {
    return count <= 3 ? 3 : count === 4 ? 4 : 5;
}

function PromptQualityWarnings({ warnings }: { warnings: PromptEnhancementWarning[] }) {
    if (warnings.length === 0) {
        return null;
    }

    return (
        <div className="mb-3 rounded-ui-lg border border-amber-500/20 bg-amber-500/10 p-3">
            <p className="text-xs font-semibold text-amber-200">Prompt quality</p>
            <div className="mt-2 space-y-2">
                {warnings.slice(0, 4).map((warning) => (
                    <div key={warning.code} className="text-sm text-amber-100">
                        <p>{warning.message}</p>
                        {warning.fixHint ? (
                            <p className="mt-0.5 text-xs text-amber-200/70">{warning.fixHint}</p>
                        ) : null}
                    </div>
                ))}
            </div>
        </div>
    );
}

interface UploadPreviewState {
    type: 'image' | 'video';
    src: string;
    alt: string;
    title: string;
}

interface VideoWorkflowSettings {
    model?: VideoModelId;
    isMultiShot?: boolean;
    multiPrompts?: MultiShot[];
    mode?: string;
    aspectRatio?: string;
    sound?: boolean;
    duration?: number;
    resolution?: string;
    fixedLens?: boolean;
    elements?: ImageElementDescriptor[];
    promptMode?: 'element-mentions-v1';
    compiledPrompt?: string;
    referenceMode?: 'frames' | 'elements' | 'references';
    startFrame?: RemixMediaAssetDescriptor;
    endFrame?: RemixMediaAssetDescriptor;
    referenceVideoUrls?: string[];
    referenceAudioUrls?: string[];
    preparedAudioIds?: string[];
    characterIds?: string[];
    klingVideoElements?: KlingVideoElementDescriptor[];
    seedanceAssets?: SeedanceAssetCollections;
}

function revokeObjectUrl(url: string | null) {
    if (url?.startsWith('blob:')) {
        URL.revokeObjectURL(url);
    }
}

type VideoElementDraft = ImageElementDescriptor & {
    file: File | null;
    previewUrl: string;
    providerUrl: string | null;
    source: 'upload' | 'remix';
    sourceGenerationId?: string | null;
    seedanceAsset: SeedanceAssetMetadata;
    /** The upload of `file` an earlier run or preparation made, sent again while it lasts. */
    staged: StagedUpload | null;
};

type VideoElementSeed = {
    id?: string;
    displayName?: string;
    handle?: string | null;
    file: File | null;
    previewUrl: string;
    providerUrl?: string | null;
    storagePath?: string | null;
    source?: 'upload' | 'remix';
    sourceGenerationId?: string | null;
    seedanceAsset?: Partial<SeedanceAssetMetadata>;
    staged?: StagedUpload | null;
};

type SeedanceMediaReferenceDraft = {
    id: string;
    displayName: string;
    file: File | null;
    previewUrl: string;
    providerUrl: string | null;
    storagePath: string | null;
    source: 'upload' | 'remix';
    sourceGenerationId?: string | null;
    durationSeconds?: number | null;
    seedanceAsset: SeedanceAssetMetadata;
    staged: StagedUpload | null;
};

type SeedanceMediaReferenceSeed = {
    id?: string;
    displayName?: string;
    file: File | null;
    previewUrl: string;
    providerUrl?: string | null;
    storagePath?: string | null;
    source?: 'upload' | 'remix';
    sourceGenerationId?: string | null;
    durationSeconds?: number | null;
    seedanceAsset?: Partial<SeedanceAssetMetadata>;
    staged?: StagedUpload | null;
};

type KlingVideoElementDescriptor = {
    id?: string | null;
    url?: string | null;
    handle?: string | null;
    displayName?: string | null;
    storagePath?: string | null;
    sourceGenerationId?: string | null;
};

type KlingVideoElementDraft = {
    id: string;
    displayName: string;
    handle: string;
    file: File | null;
    previewUrl: string;
    providerUrl: string | null;
    storagePath: string | null;
    source: 'upload' | 'remix';
    sourceGenerationId?: string | null;
    durationSeconds?: number | null;
    staged: StagedUpload | null;
};

type KlingSubjectImageDraft = {
    id: string;
    file: File | null;
    previewUrl: string;
    remoteUrl: string | null;
    storagePath: string | null;
    staged?: StagedUpload | null;
};

// A Kling O3 named multi-image subject: 2–4 images fused into one identity the
// prompt references as @handle. The handle is kept with the subject, as an
// element's is: see assignSubjectHandles.
type KlingSubjectDraft = {
    id: string;
    displayName: string;
    handle: string;
    images: KlingSubjectImageDraft[];
};

// A subject on its way in: a new one, a saved one, or one just renamed, which
// has given up its handle to take the handle of its new name.
type KlingSubjectSeed = Omit<KlingSubjectDraft, 'handle'> & { handle?: string | null };

// What this page's draft fills a run's slots from, and the inputs a run sends as
// planned from it before any upload (creator-run-inputs.ts).
type PageVideoRunMedia = {
    imageReference: VideoElementDraft;
    reference: SeedanceMediaReferenceDraft;
    videoElement: KlingVideoElementDraft;
    subjectImage: KlingSubjectImageDraft;
};
type PageVideoRunInput = VideoRunInput<PageVideoRunMedia>;

// How many subjects a run takes, and how many pictures make one. Read off the model's
// catalog descriptor, which is how the native creator reads them too.
type SubjectLimits = { maxNamed: number; imagesPerSubject: { min: number; max: number } };

function KlingSubjectsEditor({
    subjects,
    limits,
    disabled,
    onChange,
    onRename,
    onRefusedFiles,
}: {
    subjects: KlingSubjectDraft[];
    limits: SubjectLimits;
    disabled: boolean;
    onChange: (next: KlingSubjectSeed[]) => void;
    onRename: (subjectId: string, displayName: string) => void;
    onRefusedFiles: (message: string | null) => void;
}) {
    const KLING_SUBJECT_LIMIT = limits.maxNamed;
    const KLING_SUBJECT_MIN_IMAGES = limits.imagesPerSubject.min;
    const KLING_SUBJECT_MAX_IMAGES = limits.imagesPerSubject.max;
    // A name while it is being typed. It becomes the subject's name, and the
    // handle and the prompt follow it, when the field is left or Enter is pressed.
    const names = useNameDrafts();

    const commitNameDraft = (subject: KlingSubjectDraft) => {
        const draftValue = names.takeDraft(subject.id);
        if (draftValue === undefined) return;

        const trimmed = draftValue.trim();
        if (!trimmed || trimmed === subject.displayName) return;

        onRename(subject.id, trimmed);
    };

    const addSubject = () => {
        if (subjects.length >= KLING_SUBJECT_LIMIT) return;
        onChange([...subjects, {
            id: `subject-${crypto.randomUUID()}`,
            displayName: `Subject ${subjects.length + 1}`,
            images: [],
        }]);
    };

    const updateSubject = (subjectId: string, updates: Partial<KlingSubjectDraft>) => {
        onChange(subjects.map((subject) => (subject.id === subjectId ? { ...subject, ...updates } : subject)));
    };

    const removeSubject = (subjectId: string) => {
        const subject = subjects.find((candidate) => candidate.id === subjectId);
        subject?.images.forEach((image) => revokeObjectUrl(image.previewUrl));
        names.dropDraft(subjectId);
        onChange(subjects.filter((candidate) => candidate.id !== subjectId));
    };

    const addImages = (subjectId: string, files: FileList | null) => {
        if (!files || files.length === 0) return;
        const subject = subjects.find((candidate) => candidate.id === subjectId);
        if (!subject) return;
        const availableSlots = Math.max(0, KLING_SUBJECT_MAX_IMAGES - subject.images.length);
        const { accepted, refusal } = screenPickedFiles(Array.from(files), 'image');
        const added = accepted.slice(0, availableSlots);
        onRefusedFiles([
            refusal,
            accepted.length > added.length
                ? `Added ${added.length} of ${accepted.length}: a subject takes up to ${KLING_SUBJECT_MAX_IMAGES} images.`
                : null,
        ].filter(Boolean).join(' ') || null);
        if (added.length === 0) return;
        const nextImages = added.map((file) => ({
            id: `subject-image-${crypto.randomUUID()}`,
            file,
            previewUrl: URL.createObjectURL(file),
            remoteUrl: null,
            storagePath: null,
        }));
        updateSubject(subjectId, { images: [...subject.images, ...nextImages] });
    };

    const removeImage = (subjectId: string, imageId: string) => {
        const subject = subjects.find((candidate) => candidate.id === subjectId);
        if (!subject) return;
        const image = subject.images.find((candidate) => candidate.id === imageId);
        if (image) revokeObjectUrl(image.previewUrl);
        updateSubject(subjectId, { images: subject.images.filter((candidate) => candidate.id !== imageId) });
    };

    return (
        <div>
            <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                    <h2 className="text-sm font-semibold text-white">Named subjects</h2>
                    <p className="mt-1 text-sm text-zinc-400">
                        Give each subject 2–4 images of the same person or product, then mention its @handle in the prompt or shot prompts.
                    </p>
                </div>
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-300">
                    {subjects.length}/{KLING_SUBJECT_LIMIT}
                </span>
            </div>

            {subjects.length > 0 && (
                <div className="mb-4 space-y-3">
                    {subjects.map((subject) => {
                        const imageCountOk = subject.images.length >= KLING_SUBJECT_MIN_IMAGES
                            && subject.images.length <= KLING_SUBJECT_MAX_IMAGES;
                        return (
                            <div key={subject.id} className="rounded-[24px] border border-zinc-700/40 bg-black/35 p-3">
                                {/* The handle is made from the name, so a long name gives a long handle.
                                    It stays beside the name field while it takes no more than half of
                                    their line, and leaves the field 10rem on a wide one. A longer handle
                                    takes the next line, whole. The remove button is outside that pair,
                                    so it stays at the end of the field's line; its top margin, half of
                                    what the field's height has over its own, keeps it level with the field. */}
                                <div className="mb-3 flex items-start gap-2">
                                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                                        <input
                                            type="text"
                                            value={names.drafts[subject.id] ?? subject.displayName}
                                            disabled={disabled}
                                            onChange={(event) => names.setDraft(subject.id, event.target.value)}
                                            onBlur={() => commitNameDraft(subject)}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter') {
                                                    event.preventDefault();
                                                    commitNameDraft(subject);
                                                    event.currentTarget.blur();
                                                }

                                                if (event.key === 'Escape') {
                                                    names.dropDraft(subject.id);
                                                    event.currentTarget.blur();
                                                }
                                            }}
                                            className="min-w-[min(50%_-_0.5rem,10rem)] flex-1 rounded-2xl border border-white/10 bg-black/45 px-3 py-2 text-sm text-white outline-none transition focus:border-emerald-500/40"
                                            placeholder="Subject name"
                                        />
                                        <StudioElementHandle
                                            handle={subject.handle}
                                            className="rounded-full border border-white/8 bg-white/[0.03] px-2.5 py-1 text-xs font-semibold text-emerald-300"
                                        />
                                    </div>
                                    <button
                                        type="button"
                                        disabled={disabled}
                                        onClick={() => removeSubject(subject.id)}
                                        className="mt-[calc(0.375rem+1px)] shrink-0 rounded-full bg-black/60 p-1.5 text-white transition hover:bg-red-500"
                                        aria-label={`Remove ${subject.displayName}`}
                                    >
                                        <X className="h-3 w-3" />
                                    </button>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                    {subject.images.map((image) => (
                                        <div key={image.id} className="relative h-16 w-16 overflow-hidden rounded-xl border border-white/10 bg-black">
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img src={image.previewUrl || image.remoteUrl || undefined} alt="" className="h-full w-full object-cover" />
                                            <button
                                                type="button"
                                                disabled={disabled}
                                                onClick={() => removeImage(subject.id, image.id)}
                                                className="absolute right-0.5 top-0.5 rounded-full bg-black/70 p-0.5 text-white transition hover:bg-red-500"
                                                aria-label="Remove subject image"
                                            >
                                                <X className="h-2.5 w-2.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {subject.images.length < KLING_SUBJECT_MAX_IMAGES && (
                                        <label className={`flex h-16 w-16 cursor-pointer items-center justify-center rounded-xl border border-dashed border-white/15 text-zinc-400 transition hover:border-emerald-500/40 hover:text-emerald-300 ${disabled ? 'pointer-events-none opacity-50' : ''}`}>
                                            <Plus className="h-4 w-4" />
                                            <input
                                                type="file"
                                                accept="image/*"
                                                multiple
                                                disabled={disabled}
                                                className="hidden"
                                                onChange={(event) => {
                                                    addImages(subject.id, event.target.files);
                                                    event.target.value = '';
                                                }}
                                            />
                                        </label>
                                    )}
                                </div>
                                <p className={`mt-2 text-[11px] font-semibold uppercase tracking-[0.14em] ${imageCountOk ? 'text-zinc-500' : 'text-amber-300'}`}>
                                    {subject.images.length}/{KLING_SUBJECT_MAX_IMAGES} images{imageCountOk ? '' : ` — add at least ${KLING_SUBJECT_MIN_IMAGES}`}
                                </p>
                            </div>
                        );
                    })}
                </div>
            )}

            {subjects.length < KLING_SUBJECT_LIMIT && (
                <button
                    type="button"
                    disabled={disabled}
                    onClick={addSubject}
                    className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-white/[0.08]"
                >
                    Add subject
                </button>
            )}

            {subjects.length > 0 && (
                <p className="mt-3 text-xs text-zinc-500">
                    Named subjects replace frames and reference images for this run.
                </p>
            )}
        </div>
    );
}

type KlingVideoElementSeed = {
    id?: string | null;
    displayName?: string | null;
    handle?: string | null;
    file: File | null;
    previewUrl: string;
    providerUrl?: string | null;
    storagePath?: string | null;
    source?: 'upload' | 'remix';
    sourceGenerationId?: string | null;
    durationSeconds?: number | null;
    staged?: StagedUpload | null;
};

type PromptMentionCandidate = {
    id: string;
    displayName: string;
    handle: string;
    kind: 'image' | 'video';
};

function hydrateVideoElements(seeds: VideoElementSeed[]): VideoElementDraft[] {
    return assignElementHandles(seeds).map((seed) => ({
        id: seed.id ?? createElementId(),
        displayName: seed.displayName,
        handle: seed.handle,
        file: seed.file,
        previewUrl: seed.previewUrl,
        providerUrl: seed.providerUrl ?? null,
        storagePath: seed.storagePath ?? null,
        source: seed.source ?? 'upload',
        sourceGenerationId: seed.sourceGenerationId ?? null,
        seedanceAsset: createSeedanceAssetMetadata({
            assetType: 'Image',
            sourceUrl: seed.providerUrl ?? seed.previewUrl ?? null,
            ...seed.seedanceAsset,
        }),
        staged: seed.staged ?? null,
    }));
}

function hydrateSeedanceMediaReferences(
    assetType: SeedanceAssetKind,
    seeds: SeedanceMediaReferenceSeed[]
): SeedanceMediaReferenceDraft[] {
    return seeds.map((seed, index) => ({
        id: seed.id ?? createElementId(),
        displayName: seed.displayName ?? `${assetType} reference ${index + 1}`,
        file: seed.file,
        previewUrl: seed.previewUrl,
        providerUrl: seed.providerUrl ?? null,
        storagePath: seed.storagePath ?? null,
        source: seed.source ?? 'upload',
        sourceGenerationId: seed.sourceGenerationId ?? null,
        durationSeconds: typeof seed.durationSeconds === 'number' ? seed.durationSeconds : null,
        seedanceAsset: createSeedanceAssetMetadata({
            assetType,
            sourceUrl: seed.providerUrl ?? seed.previewUrl ?? null,
            ...seed.seedanceAsset,
        }),
        staged: seed.staged ?? null,
    }));
}

/**
 * How many reference clips and tracks a model takes: the limits it publishes, which
 * the panel and the run read for the model on screen. The remix restore asks for the
 * model it is about to show, so a remix attaches no clip or track that model has no
 * slot for. Kling 3.0's clips are its named video elements, a slot of their own, and
 * do not count here.
 */
function referenceMediaLimits(modelId: VideoModelId): { videos: number; audios: number } {
    const affordances = getVideoInputAffordances(
        (VIDEO_MODELS[modelId] as { catalogDescriptor?: GenerationModelDescriptor }).catalogDescriptor,
        modelId,
    );
    return { videos: affordances.referenceVideos.max, audios: affordances.referenceAudios.max };
}

/**
 * The reference clips or tracks a remixed run kept, as seeds for their cards.
 * The Seedance 2 family builds its own, which pair each one with its prepared asset.
 */
function keptReferenceSeeds(kept: RemixResolvedAsset[] | undefined): SeedanceMediaReferenceSeed[] {
    return (kept ?? []).flatMap((item) => item.url ? [{
        displayName: item.label ?? undefined,
        file: null,
        previewUrl: item.url,
        providerUrl: item.url,
        storagePath: item.storagePath ?? null,
        source: 'remix' as const,
        sourceGenerationId: item.sourceGenerationId ?? null,
        // The quote is told each clip's length, and only a fresh upload is measured here.
        durationSeconds: item.durationSeconds ?? null,
    }] : []);
}

function hydrateKlingVideoElements(seeds: KlingVideoElementSeed[]): KlingVideoElementDraft[] {
    return assignElementHandles(seeds).map((seed) => ({
        id: typeof seed.id === 'string' && seed.id.trim() ? seed.id : createElementId(),
        displayName: seed.displayName,
        handle: seed.handle,
        file: seed.file,
        previewUrl: seed.previewUrl,
        providerUrl: seed.providerUrl ?? null,
        storagePath: seed.storagePath ?? null,
        source: seed.source ?? 'upload',
        sourceGenerationId: seed.sourceGenerationId ?? null,
        durationSeconds: typeof seed.durationSeconds === 'number' ? seed.durationSeconds : null,
        staged: seed.staged ?? null,
    }));
}

function isSupportedKlingVideoFile(file: File): boolean {
    const normalizedType = file.type.toLowerCase();
    const normalizedName = file.name.toLowerCase();
    return (
        normalizedType === 'video/mp4' ||
        normalizedType === 'video/quicktime' ||
        normalizedName.endsWith('.mp4') ||
        normalizedName.endsWith('.mov')
    );
}

export interface CreateVideoPrefill {
    remixId?: string | null;
    remixPostId?: string | null;
    prompt?: string | null;
    model?: string | null;
    aspectRatio?: string | null;
    duration?: string | null;
}

const CATALOG_HANDLED_KEYS = ['mode', 'aspectRatio', 'sound', 'duration', 'resolution', 'fixedLens', 'isMultiShot', 'referenceMode'] as const;

// What a run carries of a kind of reference its model has no slot for.
const NO_RUN_ELEMENTS: readonly VideoElementDraft[] = [];
const NO_RUN_REFERENCES: readonly SeedanceMediaReferenceDraft[] = [];

/**
 * What the standby card says of the saved clips and tracks the selected model has no
 * slot for, or null when the draft holds none. A run leaves them out, and a creator is
 * told so before paying for it.
 */
function standbyClipAndTrackNotice(modelName: string, clips: number, tracks: number): string | null {
    if (clips + tracks === 0) return null;
    const saved = [
        ...(clips > 0 ? [clips === 1 ? 'clip' : 'clips'] : []),
        ...(tracks > 0 ? [tracks === 1 ? 'track' : 'tracks'] : []),
    ].join(' and ');
    const slots = [...(clips > 0 ? ['clip'] : []), ...(tracks > 0 ? ['track'] : [])].join(' or ');
    const one = clips + tracks === 1;
    return `Your saved ${saved} ${one ? 'stays' : 'stay'} saved. ${modelName} takes no reference ${slots}, so this run does not use ${one ? 'it' : 'them'}.`;
}

export default function CreateVideoClient({ prefill }: { prefill: CreateVideoPrefill }) {
    const router = useRouter();
    const { credits: userCredits, isLoading: isLoadingUser, session, updateCredits } = useAuth();
    const userId = session?.user?.id ?? null;
    const remixId = prefill.remixId ?? null;
    const remixPostId = prefill.remixPostId ?? null;
    const prefillPrompt = prefill.prompt ?? null;
    const prefillModel = prefill.model ?? null;
    const prefillAspectRatio = prefill.aspectRatio ?? null;
    const prefillDuration = prefill.duration ?? null;

    const [selectedModel, setSelectedModel] = useState<VideoModelId>('kling-3.0-video');
    const [isMultiShot, setIsMultiShot] = useState(false);
    const [prompt, setPrompt] = useState('');

    // Mirrors the live prompt so the remix restore below can tell whether the
    // creator typed while /api/remix-source was still in flight.
    const promptRef = useRef(prompt);
    useEffect(() => {
        promptRef.current = prompt;
    }, [prompt]);
    const [singleDuration, setSingleDuration] = useState(5);
    const [multiPrompts, setMultiPrompts] = useState<MultiShot[]>([
        { id: '1', prompt: '', duration: 5 },
    ]);
    const [elements, setElements] = useState<VideoElementDraft[]>([]);
    const [referenceVideos, setReferenceVideos] = useState<SeedanceMediaReferenceDraft[]>([]);
    const [referenceAudios, setReferenceAudios] = useState<SeedanceMediaReferenceDraft[]>([]);
    const [preparedAudioIds, setPreparedAudioIds] = useState<string[]>([]);
    const [characterIds, setCharacterIds] = useState<string[]>([]);
    const [preparedAudioIdDraft, setPreparedAudioIdDraft] = useState('');
    const [characterIdDraft, setCharacterIdDraft] = useState('');
    const [klingVideoElements, setKlingVideoElements] = useState<KlingVideoElementDraft[]>([]);
    const [klingSubjects, setKlingSubjects] = useState<KlingSubjectDraft[]>([]);
    const klingSubjectsRef = useRef<KlingSubjectDraft[]>([]);
    const elementNames = useNameDrafts();
    const klingVideoNames = useNameDrafts();
    const [startImageFile, setStartImageFile] = useState<File | null>(null);
    const [startImageUrl, setStartImageUrl] = useState<string | null>(null);
    const [startFrameDescriptor, setStartFrameDescriptor] = useState<RemixMediaAssetDescriptor | null>(null);
    const [endImageFile, setEndImageFile] = useState<File | null>(null);
    const [endImageUrl, setEndImageUrl] = useState<string | null>(null);
    const [endFrameDescriptor, setEndFrameDescriptor] = useState<RemixMediaAssetDescriptor | null>(null);
    // Each frame's upload for an earlier run, kept with the file it was made from: a
    // frame replaced since does not match, and is uploaded.
    const [startFrameStaged, setStartFrameStaged] = useState<{ file: File; staged: StagedUpload } | null>(null);
    const [endFrameStaged, setEndFrameStaged] = useState<{ file: File; staged: StagedUpload } | null>(null);
    const [mode, setMode] = useState('std');
    const [aspectRatio, setAspectRatio] = useState('16:9');
    const [sound, setSound] = useState(false);
    const [resolution, setResolution] = useState('720p');
    const [fixedLens, setFixedLens] = useState(false);

    const [isDraggingStart, setIsDraggingStart] = useState(false);
    const [isDraggingEnd, setIsDraggingEnd] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [generationTiming, setGenerationTiming] = useState<GenerationTiming | null>(null);
    const [outputVideo, setOutputVideo] = useState<string | null>(null);
    const [resolvedOutputVideo, setResolvedOutputVideo] = useState<{ outputUrl: string; url: string } | null>(null);
    const [latestGenerationId, setLatestGenerationId] = useState<string | null>(null);
    const [latestIsPublic, setLatestIsPublic] = useState(false);
    const [publishedMeta, setPublishedMeta] = useState<{ title: string; description: string } | null>(null);
    const [isPublishModalOpen, setIsPublishModalOpen] = useState(false);
    const [publishDefaults, setPublishDefaults] = useState<CreationPublishDefaults | null>(null);
    const [isPreparingPublish, setIsPreparingPublish] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Why files just picked were left out: their own line, so it never stands in for a
    // run's error or its background state.
    const [pickNotice, setPickNotice] = useState<string | null>(null);
    // A start sent without an answer that says whether it started. Until one comes, the
    // run panel offers to check again under the same key instead of starting another.
    const [unconfirmedStart, setUnconfirmedStart] = useState<PendingWebStart | null>(null);
    // The server's "not enough credits", for the balance and price it was given at. A
    // fresh balance or another price is a new question, so it applies only while both hold.
    const [creditRefusal, setCreditRefusal] = useState<{ message: string; credits: number | null; cost: number | null } | null>(null);
    // The account whose saved draft has been read back. Until then nothing is saved over
    // it, and the catalog does not pick its default model in place of the saved one.
    const [draftRestoredFor, setDraftRestoredFor] = useState<string | null>(null);
    const restoredDraftModelRef = useRef(false);
    const pendingAdditionalSettingsRef = useRef<VideoCreatorDraft['additionalSettings'] | null>(null);
    const unsavedDraftRef = useRef<{ userId: string; draft: VideoCreatorDraft } | null>(null);
    const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
    const [promptQualityWarnings, setPromptQualityWarnings] = useState<PromptEnhancementWarning[]>([]);
    const [multiPromptQualityWarnings, setMultiPromptQualityWarnings] = useState<Record<string, PromptEnhancementWarning[]>>({});
    const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
    const modelCatalog = useWebGenerationModelCatalog({ kind: 'video', selectedIds: [selectedModel], pickerOpen: isModelDropdownOpen });
    const catalogDescriptor = modelCatalog.catalog?.models.find(item => item.id === selectedModel);
    const refetchModelCatalog = modelCatalog.refetch;
    const [modelSearchQuery, setModelSearchQuery] = useState('');
    const modelDropdownRef = useRef<HTMLDivElement>(null);
    const hasResolvedInitialCatalogModel = useRef(false);
    const activeGenerationRequestKeyRef = useRef<string | null>(null);
    const generationPollAbortControllerRef = useRef<AbortController | null>(null);
    const startImageInputRef = useRef<HTMLInputElement>(null);
    const endImageInputRef = useRef<HTMLInputElement>(null);
    const elementInputRef = useRef<HTMLInputElement>(null);
    const referenceVideoInputRef = useRef<HTMLInputElement>(null);
    const referenceAudioInputRef = useRef<HTMLInputElement>(null);
    const klingVideoInputRef = useRef<HTMLInputElement>(null);
    const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
    const multiShotTextareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
    const elementsRef = useRef<VideoElementDraft[]>([]);
    const referenceVideosRef = useRef<SeedanceMediaReferenceDraft[]>([]);
    const referenceAudiosRef = useRef<SeedanceMediaReferenceDraft[]>([]);
    const klingVideoElementsRef = useRef<KlingVideoElementDraft[]>([]);
    const [isDraggingElements, setIsDraggingElements] = useState(false);
    const [isDraggingKlingVideos, setIsDraggingKlingVideos] = useState(false);
    const [activeSeedanceAssetKey, setActiveSeedanceAssetKey] = useState<string | null>(null);
    const [activeMentionQuery, setActiveMentionQuery] = useState<{
        query: string;
        replaceStart: number;
        replaceEnd: number;
    } | null>(null);
    const [focusedShotId, setFocusedShotId] = useState<string | null>(null);
    const [activeShotMentionQuery, setActiveShotMentionQuery] = useState<{
        shotId: string;
        query: string;
        replaceStart: number;
        replaceEnd: number;
    } | null>(null);

    const [isRemixLoading, setIsRemixLoading] = useState(!!remixId);
    const [remixTitle, setRemixTitle] = useState<string | null>(null);
    const [remixVideoUrl, setRemixVideoUrl] = useState<string | null>(null);
    const [remixRestoreWarning, setRemixRestoreWarning] = useState<string | null>(null);
    const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false);
    const [uploadPreview, setUploadPreview] = useState<UploadPreviewState | null>(null);
    // Bumped once a start the creator pressed is confirmed: the result canvas comes into view.
    const [canvasRevealKey, setCanvasRevealKey] = useState(0);
    // The run in flight's shape and settings, which its frame keeps while the form changes.
    const [runShape, setRunShape] = useState<{ aspectRatio: string; label: string } | null>(null);
    const nowMs = useTicker(isGenerating) ?? undefined;

    useEffect(() => () => {
        generationPollAbortControllerRef.current?.abort();
    }, []);

    useEffect(() => {
        if (remixId) return;
        // A route prefill intentionally seeds the editable form once it is available.
        if (prefillPrompt) setPrompt(prefillPrompt);
        if (prefillModel) setSelectedModel(prefillModel as VideoModelId);
        if (prefillAspectRatio) setAspectRatio(prefillAspectRatio);
        if (prefillDuration) {
            const nextDuration = Number(prefillDuration);
            if (!Number.isNaN(nextDuration)) setSingleDuration(nextDuration);
        }
    }, [prefillPrompt, prefillModel, prefillAspectRatio, prefillDuration, remixId]);


    // Derived, not kept in `catalogNotice`: a retired model or a failed load shows only
    // while it still applies, so choosing another model or a successful reload clears
    // it. It takes the notice slot ahead of a one-off notice, which can be dismissed.
    // A remix's form is not saved as a draft, so it is not promised one.
    const catalogProblem = modelCatalog.missingIds.includes(selectedModel)
        ? (remixId
            ? 'This model is no longer available. Choose another model; your settings stay on this page.'
            : 'This model is no longer available. Your draft is saved; choose another model.')
        : modelCatalog.error?.message || null;
    const modelNotice = catalogProblem ?? catalogNotice;
    const videoModel = VIDEO_MODELS[selectedModel] ?? VIDEO_MODELS['kling-3.0-video'];
    const videoModelOptions = modelCatalog.summaries.filter(item => item.kind === 'video').map(item => ({ ...(VIDEO_MODELS as unknown as Record<string, typeof VIDEO_MODELS[keyof typeof VIDEO_MODELS]>)[item.id], ...item, badge: item.badge ?? '' }));
    const normalizedModelSearchQuery = modelSearchQuery.trim().toLowerCase();
    const filteredVideoModelOptions = normalizedModelSearchQuery
        ? videoModelOptions.filter((modelOption) => {
            const searchableModelText = [
                modelOption.displayName,
                modelOption.description,
                modelOption.supportsMultiShot ? 'multi-shot multi shot' : '',
                modelOption.supportsSound ? 'sound audio' : '',
                modelOption.supportsFixedLens ? 'fixed lens' : '',
            ].join(' ').toLowerCase();

            return searchableModelText.includes(normalizedModelSearchQuery);
        })
        : videoModelOptions;
    const draftReady = Boolean(remixId) || !userId || draftRestoredFor === userId;
    useEffect(() => {
        if (!modelCatalog.catalog || !draftReady) return;
        const preferDefault = !hasResolvedInitialCatalogModel.current && !remixId && !prefillModel && !restoredDraftModelRef.current;
        const nextModelId = resolveCatalogModelId(modelCatalog.catalog, 'video', selectedModel, { preferDefault });
        if (!nextModelId) return;
        hasResolvedInitialCatalogModel.current = true;
        if (nextModelId && nextModelId !== selectedModel) {
            const nextModel = (VIDEO_MODELS as unknown as Record<string, typeof videoModel>)[nextModelId];
            setSelectedModel(nextModelId as VideoModelId);
            if (!preferDefault) {
                setCatalogNotice(`Your previous video model is no longer available. Switched to ${nextModel?.displayName ?? nextModelId}.`);
            }
        }
    }, [modelCatalog.catalog, selectedModel, videoModel, prefillModel, remixId, draftReady]);
    const isSeedance2Family = isSeedance2VideoModelId(selectedModel);
    const isKlingVideoModel = selectedModel === 'kling-3.0-video';
    const isKlingO3Model = selectedModel === 'kling-o3';
    const isWanVideoModel = selectedModel === 'wan-2.7';
    const isGeminiOmniVideoModel = selectedModel === 'gemini-omni-video';
    const commitElements = (nextElements: VideoElementDraft[]) => {
        elementsRef.current = nextElements;
        setElements(nextElements);
    };
    const commitReferenceVideos = (nextReferences: SeedanceMediaReferenceDraft[]) => {
        referenceVideosRef.current = nextReferences;
        setReferenceVideos(nextReferences);
    };
    const commitReferenceAudios = (nextReferences: SeedanceMediaReferenceDraft[]) => {
        referenceAudiosRef.current = nextReferences;
        setReferenceAudios(nextReferences);
    };
    const commitKlingVideoElements = (nextElements: KlingVideoElementDraft[]) => {
        klingVideoElementsRef.current = nextElements;
        setKlingVideoElements(nextElements);
    };
    // Staged files are saved under the account that added them, so the next account to
    // use this browser does not open them. A remix keeps none: it restores its source.
    const mediaKey = useCallback((key: string) => (
        !remixId && userId ? scopedPersistedMediaKey(key, userId) : null
    ), [remixId, userId]);
    const persistVideoElements = useCallback(async (nextElements: VideoElementDraft[]) => {
        const key = mediaKey(PERSISTED_MEDIA_KEYS.createVideoElements);
        if (!key) {
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

        await setPersistedImageElementRecords(key, persistableElements);
    }, [mediaKey]);
    const persistReferenceVideos = async (nextReferences: SeedanceMediaReferenceDraft[]) => {
        const key = mediaKey(PERSISTED_MEDIA_KEYS.createVideoReferenceVideos);
        if (!key) {
            return;
        }

        await setPersistedMediaRecords(
            key,
            nextReferences
                .filter((reference) => reference.file && reference.source === 'upload')
                .map((reference) => ({
                    id: reference.id,
                    displayName: reference.displayName,
                    durationSeconds: reference.durationSeconds ?? null,
                    file: reference.file as File,
                }))
        );
    };
    const persistReferenceAudios = async (nextReferences: SeedanceMediaReferenceDraft[]) => {
        const key = mediaKey(PERSISTED_MEDIA_KEYS.createVideoReferenceAudios);
        if (!key) {
            return;
        }

        await setPersistedMediaRecords(
            key,
            nextReferences
                .filter((reference) => reference.file && reference.source === 'upload')
                .map((reference) => ({
                    id: reference.id,
                    displayName: reference.displayName,
                    // A track's length prices some runs, and the server may correct it.
                    durationSeconds: reference.durationSeconds ?? null,
                    file: reference.file as File,
                }))
        );
    };
    const persistKlingVideoElements = async (nextElements: KlingVideoElementDraft[]) => {
        const key = mediaKey(PERSISTED_MEDIA_KEYS.createVideoKlingVideoElements);
        if (!key) {
            return;
        }

        await setPersistedMediaRecords(
            key,
            nextElements
                .filter((element) => element.file && element.source === 'upload')
                .map((element) => ({
                    id: element.id,
                    displayName: element.displayName,
                    handle: element.handle,
                    durationSeconds: element.durationSeconds ?? null,
                    file: element.file as File,
                }))
        );
    };
    const persistKlingSubjects = async (nextSubjects: KlingSubjectDraft[]) => {
        const key = mediaKey(PERSISTED_MEDIA_KEYS.createVideoKlingSubjects);
        if (!key) {
            return;
        }

        await setPersistedSubjectRecords(
            key,
            nextSubjects
                // Only locally-uploaded images can be restored from storage; a
                // subject with any unrestorable image is dropped whole so it
                // never comes back depicting a different set.
                .filter((subject) => subject.images.length > 0 && subject.images.every((image) => image.file))
                .map((subject) => ({
                    id: subject.id,
                    displayName: subject.displayName,
                    handle: subject.handle,
                    images: subject.images.map((image) => ({
                        id: image.id,
                        file: image.file as File,
                    })),
                }))
        );
    };
    const commitKlingSubjects = (nextSubjects: KlingSubjectSeed[]) => {
        // A subject that comes without a handle takes the handle of its name here.
        // Every other subject keeps the one it has.
        const subjectsWithHandles = assignSubjectHandles(nextSubjects);
        setKlingSubjects(subjectsWithHandles);
        klingSubjectsRef.current = subjectsWithHandles;
        void persistKlingSubjects(subjectsWithHandles);
        return subjectsWithHandles;
    };
    const persistSeedanceAssets = async (
        nextElements: VideoElementDraft[] = elementsRef.current,
        nextReferenceVideos: SeedanceMediaReferenceDraft[] = referenceVideosRef.current,
        nextReferenceAudios: SeedanceMediaReferenceDraft[] = referenceAudiosRef.current
    ) => {
        const key = mediaKey(PERSISTED_MEDIA_KEYS.createVideoSeedanceAssets);
        if (!key) {
            return;
        }

        await setPersistedValue<SeedanceAssetCollections>(
            key,
            {
                images: nextElements.map((element) => ({ ...element.seedanceAsset })),
                videos: nextReferenceVideos.map((reference) => ({ ...reference.seedanceAsset })),
                audios: nextReferenceAudios.map((reference) => ({ ...reference.seedanceAsset })),
            }
        );
    };
    const updateMentionState = (nextPrompt: string, caretIndex?: number) => {
        const fallbackCaret = typeof caretIndex === 'number'
            ? caretIndex
            : (promptTextareaRef.current?.selectionStart ?? nextPrompt.length);
        setActiveMentionQuery(getMentionQueryAtCaret(nextPrompt, fallbackCaret));
    };
    const updateShotMentionState = (shotId: string, nextPrompt: string, caretIndex?: number) => {
        const fallbackCaret = typeof caretIndex === 'number'
            ? caretIndex
            : (multiShotTextareaRefs.current[shotId]?.selectionStart ?? nextPrompt.length);
        const mentionQuery = getMentionQueryAtCaret(nextPrompt, fallbackCaret);
        setActiveShotMentionQuery(mentionQuery ? { shotId, ...mentionQuery } : null);
    };
    const currentMode = videoModel.modeOptions.length > 0 && videoModel.modeOptions.some((option) => option.value === mode)
        ? mode
        : (videoModel.modeOptions[0]?.value || '');
    const currentAspectRatio = (videoModel.aspectRatios as readonly string[]).includes(aspectRatio)
        ? aspectRatio
        : videoModel.aspectRatios[0];
    const currentResolution = videoModel.resolutions.length > 0 && (videoModel.resolutions as readonly string[]).includes(resolution)
        ? resolution
        : (videoModel.resolutions[0] || '');
    const singleShotDurationRange = getVideoDurationRange(selectedModel);
    const currentDuration = clampVideoDuration(selectedModel, singleDuration);
    const currentSound = videoModel.supportsSound ? sound : false;
    const currentFixedLens = videoModel.supportsFixedLens ? fixedLens : false;
    const currentIsMultiShot = videoModel.supportsMultiShot ? isMultiShot : false;
    const isGrokVideoModel = selectedModel === 'grok-imagine-video';
    // Capabilities come from the model's catalog descriptor, so what the picker offers
    // and what the server accepts cannot drift apart. Before the catalog loads the
    // module falls back to the previous hardcoded tables, keeping first paint identical.
    // Every input the model can take is on screen at once; which shape the run uses is
    // read back off what is attached rather than chosen from a mode toggle. Kie's own
    // playground lays the fields out flat this way, and a derived mode cannot disagree
    // with the attachments the way a separately persisted one could.
    const hasFrameAttachment = Boolean(startImageUrl || startImageFile || endImageUrl || endImageFile);
    // The browser keeps a creator's references when the model changes, so the draft can
    // hold an image, a clip or a track that the selected model has no slot for. Those
    // are on standby: saved for a model that takes them, and no part of this run. Only
    // what the run carries is counted, priced, uploaded and sent, and only that makes it
    // a references run. With every saved reference counted, the price quote refused
    // Kling 3.0 and Hailuo 2.3 for references their own page called unused, and the page
    // had no card to remove them by.
    const affordances = getVideoRunAffordances(
        (videoModel as { catalogDescriptor?: GenerationModelDescriptor }).catalogDescriptor,
        selectedModel,
        { mode: currentMode, isMultiShot: currentIsMultiShot },
        {
            // A multi-shot run sends its shots and no image reference, on every model.
            images: currentIsMultiShot ? 0 : elements.length,
            videos: referenceVideos.length,
            audios: referenceAudios.length,
        },
    );
    const runElements = affordances.carries.images ? elements : NO_RUN_ELEMENTS;
    const runReferenceVideos = affordances.carries.videos ? referenceVideos : NO_RUN_REFERENCES;
    const runReferenceAudios = affordances.carries.audios ? referenceAudios : NO_RUN_REFERENCES;
    // Gemini Omni's prepared voices and characters are not among them. Their slot stands
    // beside either shape, and the one model that has it has no frame for them to lock.
    const hasReferenceAttachment = runElements.length > 0
        || runReferenceVideos.length > 0
        || runReferenceAudios.length > 0;
    // Providers that cannot take both shapes in one request get a live mutual lock instead
    // of a hidden mode: the other group stays visible, greyed, with the reason on it.
    // Only ever lock the empty side. A draft can hold both — the previous surface kept the
    // frames while you worked in references — and locking each against the other leaves a
    // panel where nothing can be removed, so nothing can be unlocked either.
    const framesLockedByReferences = affordances.framesExcludeReferences && hasReferenceAttachment && !hasFrameAttachment;
    const referencesLockedByFrames = affordances.framesExcludeReferences && hasFrameAttachment && !hasReferenceAttachment;
    const framesAndReferencesConflict = affordances.framesExcludeReferences && hasFrameAttachment && hasReferenceAttachment;
    const videoElementSupport = {
        enabled: affordances.elements.enabled,
        maxElements: affordances.elements.maxTotal,
        maxNamed: affordances.elements.maxNamed,
        reason: affordances.elements.disabledReason,
    };
    const canUseVideoElements = affordances.elements.enabled;
    const activeReferenceMode = affordances.activeMode;
    const combinesFrameWithReferences = affordances.combineFramesWithReferences;
    const supportsStartFrame = affordances.frames.start;
    const supportsEndFrame = affordances.frames.end;
    const activeSupportsEndFrame = supportsEndFrame && !combinesFrameWithReferences;
    const referenceVideoLimit = affordances.referenceVideos.max;
    const referenceAudioLimit = affordances.referenceAudios.max;
    // The clip and track panel, the checks before a run and the run itself follow the
    // limits the model publishes. Two lists of models stood here before, and MiniMax H3
    // was on neither: it takes three clips and three tracks, and the page had no place
    // for one. Kling 3.0's clips are its named video elements, a slot of their own with
    // a panel of their own, so its limit here is zero.
    const supportsMultimodalReferences = referenceVideoLimit > 0 || referenceAudioLimit > 0;
    const supportsReferenceAudio = referenceAudioLimit > 0;
    // A multi-shot run is quoted and started at its shots' total, the length the server
    // derives from the shots; a body naming another length is refused.
    const totalDuration = currentIsMultiShot
        ? multiShotTotalDuration(multiPrompts)
        : (selectedModel === 'veo-3.1' ? videoModel.durations[0] : currentDuration);
    const multiShotMaxShots = MULTI_SHOT_MAX_SHOTS[selectedModel] ?? null;
    // The run's duration is the shots' total, so the most it may come to is the most
    // the duration control offers; the quote refuses anything longer.
    const multiShotMaxTotalSeconds = singleShotDurationRange?.max
        ?? (videoModel.durations.length > 0 ? Math.max(...videoModel.durations) : null);
    const canAddShot = (multiShotMaxShots === null || multiPrompts.length < multiShotMaxShots)
        && (multiShotMaxTotalSeconds === null || totalDuration < multiShotMaxTotalSeconds);
    const multiShotOverLength = multiShotMaxTotalSeconds !== null && totalDuration > multiShotMaxTotalSeconds;
    // The settings chip, read as the app's ("720P · 16:9 · 5s").
    const settingsSummary = videoSettingsSummary({
        modeLabel: videoModel.modeOptions.find((option) => option.value === currentMode)?.label ?? currentMode,
        resolution: currentResolution,
        aspectRatio: currentAspectRatio,
        durationSeconds: totalDuration,
    });
    const hasReferenceVideoForRun = (activeReferenceMode === 'elements' && runReferenceVideos.length > 0) || (isKlingVideoModel && klingVideoElements.length > 0);
    const frameReferenceCount = Number(Boolean(startImageUrl || startImageFile)) + (activeSupportsEndFrame ? Number(Boolean(endImageUrl || endImageFile)) : 0);
    const estimatedReferenceCount =
        activeReferenceMode === 'elements'
            ? runElements.length + runReferenceVideos.length + runReferenceAudios.length + (isGeminiOmniVideoModel ? preparedAudioIds.length + characterIds.length : 0) + (combinesFrameWithReferences && (startImageUrl || startImageFile) ? 1 : 0)
            : frameReferenceCount + (isKlingVideoModel ? klingVideoElements.length : 0);
    // Named subjects are offered on the models whose descriptor publishes them, which is
    // how the native creator finds them; a model id written here would reach one client
    // and not the other.
    const supportsNamedSubjects = affordances.subjects.enabled;
    const klingSubjectsActive = supportsNamedSubjects && klingSubjects.length > 0;
    const klingSubjectHandles = supportsNamedSubjects
        ? klingSubjects.map((subject) => subject.handle)
        : [];
    const additionalSettings = useAdditionalCatalogSettings(catalogDescriptor, CATALOG_HANDLED_KEYS);
    // One settings object for the price and the run, as the image creator has.
    const runSettings = useMemo(() => ({
        duration: totalDuration,
        mode: currentMode,
        aspectRatio: currentAspectRatio,
        sound: currentSound,
        resolution: currentResolution,
        fixedLens: currentFixedLens,
        isMultiShot: currentIsMultiShot,
        referenceMode: klingSubjectsActive ? 'subjects' : activeReferenceMode,
        ...additionalSettings.settings,
    }), [activeReferenceMode, additionalSettings.settings, currentAspectRatio, currentFixedLens, currentIsMultiShot, currentMode, currentResolution, currentSound, klingSubjectsActive, totalDuration]);
    // The inputs the run sends, before any upload. The price is the server's quote of
    // these (catalogRunQuoteInput, as the server quotes the run it starts) and the run is
    // posted from them, so the two count the same inputs: counted by the part each played,
    // Wan 2.7's start frame beside five references was left out of the price, and the
    // start refused the run for its sixth image.
    const runInputs = useMemo(() => planVideoRunInputs<PageVideoRunMedia>({
        activeReferenceMode,
        combinesFrameWithReferences,
        takesEndFrame: activeSupportsEndFrame,
        isMultiShot: currentIsMultiShot,
        imageReferences: runElements,
        videoReferences: runReferenceVideos,
        audioReferences: runReferenceAudios,
        videoElements: isKlingVideoModel ? klingVideoElements : [],
        subjects: klingSubjectsActive ? klingSubjects : [],
        hasStartFrame: Boolean(startImageUrl || startImageFile),
        hasEndFrame: Boolean(endImageUrl || endImageFile),
        preparedVoiceIds: isGeminiOmniVideoModel ? preparedAudioIds : [],
        characterIds: isGeminiOmniVideoModel ? characterIds : [],
    }), [activeReferenceMode, activeSupportsEndFrame, characterIds, combinesFrameWithReferences, currentIsMultiShot, endImageFile, endImageUrl, isGeminiOmniVideoModel, isKlingVideoModel, klingSubjects, klingSubjectsActive, klingVideoElements, preparedAudioIds, runElements, runReferenceAudios, runReferenceVideos, startImageFile, startImageUrl]);
    const quoteRequest = useMemo(() => modelCatalog.catalog && modelCatalog.detailsReady ? catalogRunQuoteInput({
        kind: 'video' as const,
        modelId: selectedModel,
        catalogRevision: modelCatalog.catalog.revision,
        settings: runSettings,
        inputs: runInputs,
    }) : null, [modelCatalog.catalog, modelCatalog.detailsReady, runInputs, runSettings, selectedModel]);
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
    const estimatedCost = quoteUi.costCredits;
    // A page the start keeps refusing at its own price waits for a reload, not another press.
    const quotePending = quoteUi.blocksGenerate || quoteState.pageOutOfDate;
    const quoteRetry = quoteState.status === 'error' ? <StudioQuoteRetry message={quoteUi.message} onRetry={quoteState.retry} /> : null;
    const estimatedGenerationTotalMs = estimateGenerationDurationMs({
        kind: 'video',
        model: selectedModel,
        mode: currentMode,
        resolution: currentResolution,
        durationSeconds: totalDuration,
        isMultiShot: currentIsMultiShot,
        shotCount: multiPrompts.length,
        referenceCount: estimatedReferenceCount,
        hasSound: currentSound,
        hasReferenceVideo: hasReferenceVideoForRun,
    });
    const insufficientCredits = userCredits !== null && estimatedCost !== null && userCredits < estimatedCost;
    // The balance and price a refusal answers, read when it comes: that can be long after
    // the render that sent it (a replay on mount).
    const creditContextRef = useRef({ credits: userCredits, cost: estimatedCost });
    useEffect(() => {
        creditContextRef.current = { credits: userCredits, cost: estimatedCost };
    }, [userCredits, estimatedCost]);
    const creditRefusalApplies = creditRefusal !== null
        && creditRefusal.credits === userCredits
        && creditRefusal.cost === estimatedCost;
    const showTopUp = insufficientCredits || creditRefusalApplies;
    // A single-shot prompt may mention only what its run sends: the server refuses any
    // other handle. A saved image the run leaves out is named as on standby, the rest as
    // unknown.
    const sentElements = activeReferenceMode === 'elements' ? runElements : NO_RUN_ELEMENTS;
    const elementHandles = elements.map((element) => element.handle);
    const klingVideoHandles = isKlingVideoModel ? klingVideoElements.map((element) => element.handle) : [];
    const sentPromptHandles = [...sentElements.map((element) => element.handle), ...klingVideoHandles, ...klingSubjectHandles];
    const promptHandles = extractPromptHandles(prompt);
    const knownElementMentions = promptHandles.filter((handle) => elementHandles.includes(handle));
    const knownKlingVideoMentions = promptHandles.filter((handle) => klingVideoHandles.includes(handle));
    const staleElementMentions = findUnknownPromptHandles(prompt, [...sentPromptHandles, ...elementHandles]);
    // What a shot prompt can mention: the references a multi-shot run sends with its
    // shots, which are Kling 3.0's video elements and Kling O3's named subjects. Image
    // references are not among them, because a multi-shot run does not send them. The
    // "@" panel under a shot, the check of the shot prompts before a run and a shot's
    // Enhance button all read this one list, so what the panel offers is what the
    // check accepts and what the enhancer is told to keep.
    const shotMentionCandidates: PromptMentionCandidate[] = [
        ...(isKlingVideoModel
            ? klingVideoElements.map((element) => ({
                id: element.id,
                displayName: element.displayName,
                handle: element.handle,
                kind: 'video' as const,
            }))
            : []),
        ...(supportsNamedSubjects
            ? klingSubjects.map((subject, index) => ({
                id: subject.id,
                displayName: subject.displayName,
                handle: klingSubjectHandles[index],
                kind: 'image' as const,
            }))
            : []),
    ];
    // The two models whose shot prompts take mentions. The server reads the shot
    // prompts of the same two for unknown ones (unknownShotHandles in generation-services.ts).
    const shotPromptsTakeMentions = isKlingVideoModel || isKlingO3Model;
    const shotMentionHandles = shotMentionCandidates.map((candidate) => candidate.handle);
    const multiShotUnknownMentions = shotPromptsTakeMentions && currentIsMultiShot
        ? Array.from(new Set(multiPrompts.flatMap((shot) => findUnknownPromptHandles(shot.prompt, shotMentionHandles))))
        : [];
    // The selected model's own limits on the prompt and each shot (Kie refuses past them),
    // counted as the run sends them: Kling 3.0 counts each mention of one of its video
    // elements as 37 characters. Text past a limit is kept and marked over, after a paste
    // or a switch to a model with a lower limit alike, and the run waits with the start's
    // own words.
    const runSendsImages = runInputs.some((input) => input.kind === 'image');
    const promptLimit = promptLimitFor(selectedModel, { hasReferenceImages: runSendsImages, kind: 'video' });
    const promptMeterOptions = { elementMentionLength: promptLimit.elementMentionLength, elementHandles: klingVideoHandles };
    const promptMeter = promptLengthMeter(prompt, promptLimit.maxLength, promptMeterOptions);
    const shotMeter = (shotPrompt: string) => promptLengthMeter(shotPrompt, promptLimit.shotMaxLength, promptMeterOptions);
    const promptLimitMessage = (currentIsMultiShot ? multiPrompts.some((shot) => shot.prompt.trim()) : prompt.trim())
        ? creatorPromptViolation(selectedModel, videoModel.displayName, {
            prompt,
            isMultiShot: currentIsMultiShot,
            shots: multiPrompts.map((shot) => shot.prompt),
            hasReferenceImages: runSendsImages,
            elementHandles: klingVideoHandles,
        })
        : null;
    const hasKnownElementMentions = knownElementMentions.length > 0;
    const hasKnownKlingVideoMentions = knownKlingVideoMentions.length > 0;
    // The saved references the prompt mentions that this run leaves out. The row under
    // the prompt and the refusal on Generate both name them.
    const standbyElementMentions = knownElementMentions.filter((handle) => !sentPromptHandles.includes(handle));
    const hasInactiveElementMentions = standbyElementMentions.length > 0;
    const promptMentionCandidates: PromptMentionCandidate[] = [
        ...sentElements.map((element) => ({
            id: element.id,
            displayName: element.displayName,
            handle: element.handle,
            kind: 'image' as const,
        })),
        ...shotMentionCandidates,
    ];
    const mentionSuggestions = activeMentionQuery
        ? promptMentionCandidates.filter((candidate) => {
            const normalizedQuery = activeMentionQuery.query.toLowerCase();
            if (!normalizedQuery) return true;

            return (
                candidate.handle.toLowerCase().includes(`@${normalizedQuery}`) ||
                candidate.displayName.toLowerCase().includes(normalizedQuery)
            );
        })
        : [];
    const shotMentionSuggestions = activeShotMentionQuery && shotPromptsTakeMentions
        ? shotMentionCandidates.filter((candidate) => {
            const normalizedQuery = activeShotMentionQuery.query.toLowerCase();
            if (!normalizedQuery) return true;

            return (
                candidate.handle.toLowerCase().includes(`@${normalizedQuery}`) ||
                candidate.displayName.toLowerCase().includes(normalizedQuery)
            );
        })
        : [];
    const shotMentionPanelCopy = isKlingO3Model
        ? { title: 'Insert subject', pick: 'Pick a named subject for this shot.', none: 'No matching subjects yet.' }
        : { title: 'Insert video element', pick: 'Pick a Kling video handle for this shot.', none: 'No matching video elements yet.' };
    const showKlingVideoElementEditor = isKlingVideoModel;
    const showElementEditor = !currentIsMultiShot && canUseVideoElements;
    const showFramesEditor = supportsStartFrame || supportsEndFrame;
    const showSavedElementNotice = !canUseVideoElements && !currentIsMultiShot && elements.length > 0;
    const savedClipAndTrackNotice = standbyClipAndTrackNotice(
        videoModel.displayName,
        affordances.carries.videos ? 0 : referenceVideos.length,
        affordances.carries.audios ? 0 : referenceAudios.length,
    );
    const showMultiShotElementNotice = currentIsMultiShot && (elements.length > 0 || (hasKnownElementMentions && !hasKnownKlingVideoMentions));
    // Enhance-time frame uploads, cached briefly so repeated enhance clicks on
    // the same attached file don't re-upload it every time.
    const enhanceFrameUploadCacheRef = useRef<Map<File, { url: string; at: number }>>(new Map());
    const ENHANCE_FRAME_CACHE_TTL_MS = 10 * 60 * 1000;

    const resolveEnhancerFrameUrl = async (file: File | null, url: string | null): Promise<string | null> => {
        if (url && url.startsWith('https://')) return url;
        if (!file) return null;
        const cached = enhanceFrameUploadCacheRef.current.get(file);
        if (cached && Date.now() - cached.at < ENHANCE_FRAME_CACHE_TTL_MS) {
            return cached.url;
        }
        const upload = await uploadMediaToTemporaryStorage(file);
        enhanceFrameUploadCacheRef.current.set(file, { url: upload.signedUrl, at: Date.now() });
        return upload.signedUrl;
    };

    // Sends the actual attached frames to the enhancer LLM as vision input so
    // image-to-video prompts describe real motion instead of imagining the frame.
    const prepareSinglePromptEnhancerContext = async () => {
        const base = buildSinglePromptQualityContext();
        if (!(activeReferenceMode === 'frames' || combinesFrameWithReferences)) {
            return base;
        }

        const frameImageUrls: string[] = [];
        const resolvedStartUrl = await resolveEnhancerFrameUrl(startImageFile, startImageUrl);
        if (resolvedStartUrl) frameImageUrls.push(resolvedStartUrl);
        if (activeReferenceMode === 'frames' && activeSupportsEndFrame) {
            const resolvedEndUrl = await resolveEnhancerFrameUrl(endImageFile, endImageUrl);
            if (resolvedEndUrl) frameImageUrls.push(resolvedEndUrl);
        }

        return frameImageUrls.length > 0 ? { ...base, frameImageUrls } : base;
    };

    const buildSinglePromptQualityContext = () => ({
        modelId: selectedModel,
        mode: currentMode,
        aspectRatio: currentAspectRatio,
        duration: totalDuration,
        sound: currentSound,
        fixedLens: currentFixedLens,
        resolution: currentResolution,
        isMultiShot: currentIsMultiShot,
        shotCount: multiPrompts.length,
        hasStartImage: (activeReferenceMode === 'frames' || combinesFrameWithReferences) && Boolean(startImageFile || startImageUrl),
        hasEndImage: activeReferenceMode === 'frames' && activeSupportsEndFrame && Boolean(endImageFile || endImageUrl),
        referenceImageCount: activeReferenceMode === 'elements' ? runElements.length : 0,
        hasReferenceVideo: hasReferenceVideoForRun,
        elementReferences: activeReferenceMode === 'elements' || klingVideoElements.length > 0 || klingSubjectsActive
            ? [
                ...(activeReferenceMode === 'elements' ? runElements : []),
                ...(isKlingVideoModel ? klingVideoElements : []),
            ].map((element) => ({
                handle: element.handle,
                displayName: element.displayName,
            })).concat(klingSubjectsActive
                ? klingSubjects.map((subject, index) => ({
                    handle: klingSubjectHandles[index],
                    displayName: subject.displayName,
                }))
                : [])
            : undefined,
    });
    const buildShotPromptQualityContext = (shot: MultiShot, index: number) => ({
        modelId: selectedModel,
        mode: currentMode,
        aspectRatio: currentAspectRatio,
        duration: shot.duration,
        sound: currentSound,
        fixedLens: currentFixedLens,
        shotIndex: index,
        isMultiShot: currentIsMultiShot,
        shotCount: multiPrompts.length,
        hasStartImage: Boolean(startImageFile || startImageUrl),
        hasEndImage: Boolean(endImageFile || endImageUrl),
        hasReferenceVideo: hasReferenceVideoForRun,
        elementReferences: shotMentionCandidates.length > 0
            ? shotMentionCandidates.map((candidate) => ({
                handle: candidate.handle,
                displayName: candidate.displayName,
            }))
            : undefined,
    });

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
                setIsModelDropdownOpen(false);
                setModelSearchQuery('');
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => () => {
        revokeObjectUrl(startImageUrl);
    }, [startImageUrl]);

    useEffect(() => () => {
        revokeObjectUrl(endImageUrl);
    }, [endImageUrl]);

    useEffect(() => {
        return () => {
            elementsRef.current.forEach((element) => revokeObjectUrl(element.previewUrl));
            referenceVideosRef.current.forEach((reference) => revokeObjectUrl(reference.previewUrl));
            referenceAudiosRef.current.forEach((reference) => revokeObjectUrl(reference.previewUrl));
            klingVideoElementsRef.current.forEach((element) => revokeObjectUrl(element.previewUrl));
            klingSubjectsRef.current.forEach((subject) => subject.images.forEach((image) => revokeObjectUrl(image.previewUrl)));
        };
    }, []);

    useEffect(() => {
        elementsRef.current = elements;
    }, [elements]);

    useEffect(() => {
        referenceVideosRef.current = referenceVideos;
    }, [referenceVideos]);

    useEffect(() => {
        referenceAudiosRef.current = referenceAudios;
    }, [referenceAudios]);

    useEffect(() => {
        klingVideoElementsRef.current = klingVideoElements;
        klingSubjectsRef.current = klingSubjects;
    }, [klingVideoElements, klingSubjects]);

    useEffect(() => {
        // A saved draft is read back first, so its settings are checked against its model
        // rather than replaced by the defaults of the model the page opened on.
        if (!modelCatalog.detailsReady || !draftReady) return;
        if (videoModel.modeOptions?.length) {
            if (!videoModel.modeOptions.some((option) => option.value === mode)) {
                // Switching models reconciles controls to values supported by the provider.
                setMode(catalogChoiceDefault(catalogDescriptor, 'mode', videoModel.modeOptions[0].value));
                setCatalogNotice('Model settings changed. Unsupported choices were reset; your prompt and references are preserved.');
            }
        } else if (mode !== '') {
            setMode('');
        }

        if (!(videoModel.aspectRatios as readonly string[]).includes(aspectRatio)) {
            setAspectRatio(catalogChoiceDefault(catalogDescriptor, 'aspectRatio', videoModel.aspectRatios[0]));
        }

        if (!isValidVideoDuration(selectedModel, singleDuration)) {
            const declared = catalogDescriptor?.controls.find(control => control.key === 'duration')?.defaultValue;
            setSingleDuration(typeof declared === 'number' || typeof declared === 'string' ? Number(declared) : getDefaultVideoDuration(selectedModel));
        }

        if (videoModel.resolutions?.length) {
            if (!(videoModel.resolutions as readonly string[]).includes(resolution)) {
                setResolution(catalogChoiceDefault(catalogDescriptor, 'resolution', videoModel.resolutions[0]));
            }
        } else if (resolution !== '') {
            setResolution('');
        }

        if (!videoModel.supportsSound) {
            setSound(false);
        }

        if (!videoModel.supportsFixedLens) {
            setFixedLens(false);
        }

        if (!videoModel.supportsMultiShot) {
            setIsMultiShot(false);
        }
    }, [selectedModel, videoModel, mode, aspectRatio, singleDuration, resolution, modelCatalog.detailsReady, catalogDescriptor, draftReady]);

    // Derived, not kept in `error`: it clears the moment the references fit the model
    // again, instead of lingering until the next generation.
    const referenceLimitMessage = canUseVideoElements && modelCatalog.detailsReady && runElements.length > videoElementSupport.maxElements
        ? `This model supports ${videoElementSupport.maxElements} reference image${videoElementSupport.maxElements === 1 ? '' : 's'}. Your references are preserved; remove extras or choose another model.`
        : null;

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

                setRemixTitle(bundle.generation.title);
                setRemixVideoUrl(bundle.result?.mediaType === 'video' ? bundle.result.url : null);
                setRemixRestoreWarning(getRemixRestoreWarning(bundle.restoreIssues));

                const settings = bundle.workflowSettings as VideoWorkflowSettings | null;
                const nextModelId =
                    settings?.model && settings.model in VIDEO_MODELS
                        ? settings.model
                        : 'kling-3.0-video';
                const nextIsMultiShot = Boolean(settings?.isMultiShot);
                const nextMode =
                    settings?.mode ||
                    VIDEO_MODELS[nextModelId].modeOptions[0]?.value ||
                    '';

                setSelectedModel(nextModelId);
                setIsMultiShot(nextIsMultiShot);

                if (nextIsMultiShot && settings?.multiPrompts?.length) {
                    setMultiPrompts(settings.multiPrompts.map((shot, index) => ({
                        id: shot.id || `${index + 1}`,
                        prompt: shot.prompt,
                        duration: shot.duration,
                    })));
                } else {
                    if (!hasCreatorEditedPromptDuringRemix(promptRef.current, promptWhenRemixStarted)) {
                        setPrompt(bundle.generation.prompt);
                    }
                    if (settings?.duration) setSingleDuration(settings.duration);
                }

                if (settings?.aspectRatio) setAspectRatio(settings.aspectRatio);
                if (settings?.sound !== undefined) setSound(settings.sound);
                if (settings?.resolution) setResolution(settings.resolution);
                if (settings?.fixedLens !== undefined) setFixedLens(settings.fixedLens);
                setPreparedAudioIds(settings?.preparedAudioIds?.filter((value) => typeof value === 'string' && value.trim()).slice(0, 3) ?? []);
                setCharacterIds(settings?.characterIds?.filter((value) => typeof value === 'string' && value.trim()).slice(0, 3) ?? []);
                setMode(nextMode);

                const restoredVideoInputs = bundle.inputs.video;
                const restoredSeedanceAssets = settings?.seedanceAssets ?? null;

                // Kling O3's named subjects come back under the handles the prompt
                // was written with. A picture is sent again as the file the run
                // kept: the server reads who may use that file from its path.
                setKlingSubjects(assignSubjectHandles((restoredVideoInputs?.subjects ?? []).map((subject) => ({
                    id: `subject-${crypto.randomUUID()}`,
                    displayName: subject.displayName,
                    handle: subject.handle,
                    images: subject.images.flatMap((image) => image.url ? [{
                        id: `subject-image-${crypto.randomUUID()}`,
                        // No file of the creator's own: the card draws the kept one.
                        file: null,
                        previewUrl: '',
                        remoteUrl: image.url,
                        storagePath: image.storagePath ?? null,
                    }] : []),
                }))));

                // How many references the restored model takes: its catalog descriptor
                // once the catalog has reached the registry, the fallback tables before,
                // read the way referenceMediaLimits reads its clip and track limits.
                const restoredElementSupport = getVideoInputAffordances(
                    (VIDEO_MODELS[nextModelId] as { catalogDescriptor?: GenerationModelDescriptor }).catalogDescriptor,
                    nextModelId,
                    { mode: nextMode, isMultiShot: nextIsMultiShot },
                ).elements;

                // A model whose cap fell since the run gets its first references back, and says
                // so. A multi-shot run takes none by design, so it says nothing.
                const capWarning = nextIsMultiShot ? null : getRemixReferenceCapWarning(
                    restoredVideoInputs?.elements ?? [],
                    restoredElementSupport.maxTotal,
                    VIDEO_MODELS[nextModelId].displayName,
                );
                if (capWarning) setRemixRestoreWarning((current) => joinRemixRestoreWarnings(current, capWarning));

                if (isSeedance2VideoModelId(nextModelId)) {
                    const restoredElements = restoredVideoInputs?.elements ?? [];
                    const restoredSeeds = createRemixElementSeeds(
                        restoredElements,
                        restoredElementSupport.maxTotal
                    ).map((seed) => ({
                        ...seed,
                        file: null,
                        // The saved assets follow the run's references, one that could not come
                        // back included, so each pairs by its place among them (as a draft's do).
                        seedanceAsset: restoredSeedanceAssets?.images?.[
                            restoredElements.findIndex((element) => element.id === seed.id)
                        ] ?? undefined,
                    }));

                    const legacyFrameSeeds = restoredSeeds.length === 0
                        ? [
                            createRestoredRemixAssetState(restoredVideoInputs?.startFrame ?? null),
                            createRestoredRemixAssetState(restoredVideoInputs?.endFrame ?? null),
                        ]
                            .filter((item): item is NonNullable<typeof item> => Boolean(item))
                            .map((item, index) => ({
                                displayName: `Image reference ${index + 1}`,
                                file: null,
                                previewUrl: item.url,
                                providerUrl: item.url,
                                storagePath: item.descriptor.storagePath ?? null,
                                source: 'remix' as const,
                                sourceGenerationId: item.descriptor.sourceGenerationId ?? null,
                                seedanceAsset: restoredSeedanceAssets?.images?.[index] ?? undefined,
                            }))
                        : [];

                    commitElements(hydrateVideoElements([...restoredSeeds, ...legacyFrameSeeds]));
                    const restoredReferenceVideos = restoredVideoInputs?.referenceVideos ?? [];
                    const restoredReferenceAudios = restoredVideoInputs?.referenceAudios ?? [];
                    let unrestorableReferences = 0;
                    const referenceVideoSeeds = restoredReferenceVideos.length > 0
                        ? restoredReferenceVideos
                            .flatMap((item, index) => item.url ? [{
                                displayName: item.label ?? `Video reference ${index + 1}`,
                                file: null,
                                previewUrl: item.url,
                                providerUrl: item.url,
                                storagePath: item.storagePath ?? null,
                                source: 'remix' as const,
                                sourceGenerationId: item.sourceGenerationId ?? null,
                                // The quote refuses a clip with no length, and only a
                                // fresh upload is measured here.
                                durationSeconds: item.durationSeconds ?? null,
                                seedanceAsset: restoredSeedanceAssets?.videos?.[index] ?? undefined,
                            }] : [])
                        : (settings?.referenceVideoUrls ?? []).flatMap((value, index) => {
                            // An older run kept a prepared clip's asset id in its list. The
                            // link it was prepared from is the one that can be measured, and
                            // a clip with neither cannot run: it is left out, and the notice says so.
                            const asset = restoredSeedanceAssets?.videos?.[index];
                            const url = measurableRemixLink(value, asset);
                            if (!url) unrestorableReferences += 1;
                            return url ? [{
                                displayName: `Video reference ${index + 1}`,
                                file: null,
                                previewUrl: url,
                                providerUrl: url,
                                source: 'remix' as const,
                                seedanceAsset: asset ?? undefined,
                            }] : [];
                        });
                    const referenceAudioSeeds = restoredReferenceAudios.length > 0
                        ? restoredReferenceAudios
                            .flatMap((item, index) => item.url ? [{
                                displayName: item.label ?? `Audio reference ${index + 1}`,
                                file: null,
                                previewUrl: item.url,
                                providerUrl: item.url,
                                storagePath: item.storagePath ?? null,
                                source: 'remix' as const,
                                sourceGenerationId: item.sourceGenerationId ?? null,
                                durationSeconds: item.durationSeconds ?? null,
                                seedanceAsset: restoredSeedanceAssets?.audios?.[index] ?? undefined,
                            }] : [])
                        : (settings?.referenceAudioUrls ?? []).flatMap((value, index) => {
                            const asset = restoredSeedanceAssets?.audios?.[index];
                            const url = measurableRemixLink(value, asset);
                            if (!url) unrestorableReferences += 1;
                            return url ? [{
                                displayName: `Audio reference ${index + 1}`,
                                file: null,
                                previewUrl: '',
                                providerUrl: url,
                                source: 'remix' as const,
                                seedanceAsset: asset ?? undefined,
                            }] : [];
                        });
	                    commitReferenceVideos(hydrateSeedanceMediaReferences('Video', referenceVideoSeeds));
	                    commitReferenceAudios(hydrateSeedanceMediaReferences('Audio', referenceAudioSeeds));
	                    commitKlingVideoElements([]);
	                    if (unrestorableReferences > 0) {
	                        // Said beside a cap notice too, and once if the bundle already said it.
	                        setRemixRestoreWarning((current) => joinRemixRestoreWarnings(current, REMIX_RESTORE_WARNING));
	                    }

	                    setStartImageFile(null);
                    setStartImageUrl(null);
                    setStartFrameDescriptor(null);
                    setEndImageFile(null);
                    setEndImageUrl(null);
                    setEndFrameDescriptor(null);
                } else {
                    // A run on any other model gets its references back too. Its
                    // image references come back under the handles the prompt
                    // mentions them by, as many as the model takes. A multi-shot run
                    // gets none: the page shows no reference card there and sends
                    // none. (The descriptor leaves Kling O3 on in multi-shot for its
                    // named subjects.)
                    commitElements(hydrateVideoElements(createRemixElementSeeds(
                        restoredVideoInputs?.elements ?? [],
                        nextIsMultiShot ? 0 : restoredElementSupport.maxTotal
                    ).map((seed) => ({ ...seed, file: null }))));
                    // Its clips and tracks come back where the model has a slot for
                    // them. Kling 3.0's clips are its video elements, restored below.
                    const mediaLimits = referenceMediaLimits(nextModelId);
                    commitReferenceVideos(mediaLimits.videos > 0
                        ? hydrateSeedanceMediaReferences('Video', keptReferenceSeeds(restoredVideoInputs?.referenceVideos))
                        : []);
                    commitReferenceAudios(mediaLimits.audios > 0
                        ? hydrateSeedanceMediaReferences('Audio', keptReferenceSeeds(restoredVideoInputs?.referenceAudios))
                        : []);
	                    const restoredReferenceVideos = restoredVideoInputs?.referenceVideos ?? [];
	                    const storedKlingVideoElements = Array.isArray(settings?.klingVideoElements)
	                        ? settings.klingVideoElements
	                        : [];
	                    const klingVideoSeeds = nextModelId === 'kling-3.0-video'
	                        ? (storedKlingVideoElements.length > 0
	                            ? storedKlingVideoElements.flatMap((element, index) => {
	                                const restoredReference = restoredReferenceVideos[index] ?? null;
	                                const url = restoredReference?.url || element.url || null;
	                                if (!url) return [];

	                                return [{
	                                    id: element.id ?? null,
	                                    displayName: element.displayName ?? restoredReference?.label ?? `Video element ${index + 1}`,
	                                    handle: element.handle ?? null,
	                                    file: null,
	                                    previewUrl: url,
	                                    providerUrl: url,
	                                    storagePath: element.storagePath ?? restoredReference?.storagePath ?? null,
	                                    source: 'remix' as const,
	                                    sourceGenerationId: element.sourceGenerationId ?? restoredReference?.sourceGenerationId ?? null,
	                                }];
	                            })
	                            : restoredReferenceVideos.flatMap((item, index) => item.url ? [{
	                                displayName: item.label ?? `Video element ${index + 1}`,
	                                file: null,
	                                previewUrl: item.url,
	                                providerUrl: item.url,
	                                storagePath: item.storagePath ?? null,
	                                source: 'remix' as const,
	                                sourceGenerationId: item.sourceGenerationId ?? null,
	                            }] : []))
	                        : [];
	                    commitKlingVideoElements(hydrateKlingVideoElements(klingVideoSeeds));

	                    const restoredStartFrame = createRestoredRemixAssetState(
                        restoredVideoInputs?.startFrame ?? null
                    );
                    const restoredEndFrame = createRestoredRemixAssetState(
                        restoredVideoInputs?.endFrame ?? null
                    );

                    setStartImageFile(null);
                    setStartImageUrl(restoredStartFrame?.url ?? null);
                    setStartFrameDescriptor(restoredStartFrame?.descriptor ?? null);
                    setEndImageFile(null);
                    setEndImageUrl(restoredEndFrame?.url ?? null);
                    setEndFrameDescriptor(restoredEndFrame?.descriptor ?? null);
                }
            } catch (fetchError) {
                console.error('Error fetching remix:', fetchError);
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

    useEffect(() => {
        // What the browser held before media was saved per account belongs to nobody in
        // particular. It goes once, on the first creator a page opens.
        void purgeLegacyPersistedMedia().catch(() => undefined);
    }, []);

    useEffect(() => {
        if (remixId || !userId) {
            return;
        }

        let isMounted = true;
        const key = (name: string) => scopedPersistedMediaKey(name, userId);

        const loadPersistedMedia = async () => {
            try {
	                const [
	                    savedStartImage,
	                    savedEndImage,
	                    savedElements,
	                    savedReferenceVideos,
	                    savedReferenceAudios,
	                    savedKlingVideoElements,
	                    savedKlingSubjects,
	                    savedSeedanceAssets,
	                ] = await Promise.all([
	                    getPersistedFile(key(PERSISTED_MEDIA_KEYS.createVideoStartImage)),
	                    getPersistedFile(key(PERSISTED_MEDIA_KEYS.createVideoEndImage)),
	                    getPersistedImageElementRecords(key(PERSISTED_MEDIA_KEYS.createVideoElements)),
	                    getPersistedMediaRecords(key(PERSISTED_MEDIA_KEYS.createVideoReferenceVideos)),
	                    getPersistedMediaRecords(key(PERSISTED_MEDIA_KEYS.createVideoReferenceAudios)),
	                    getPersistedMediaRecords(key(PERSISTED_MEDIA_KEYS.createVideoKlingVideoElements)),
	                    getPersistedSubjectRecords(key(PERSISTED_MEDIA_KEYS.createVideoKlingSubjects)),
	                    getPersistedValue<SeedanceAssetCollections>(key(PERSISTED_MEDIA_KEYS.createVideoSeedanceAssets)),
	                ]);

                if (!isMounted) return;

                if (savedStartImage) {
                    setStartImageFile(savedStartImage);
                    setStartImageUrl(URL.createObjectURL(savedStartImage));
                }

                if (savedEndImage) {
                    setEndImageFile(savedEndImage);
                    setEndImageUrl(URL.createObjectURL(savedEndImage));
                }

                if (savedElements.length > 0) {
                    commitElements(hydrateVideoElements(savedElements.map((element) => ({
                        id: element.id,
                        displayName: element.displayName,
                        handle: element.handle,
                        file: element.file,
                        previewUrl: URL.createObjectURL(element.file),
                        source: 'upload',
                        seedanceAsset: savedSeedanceAssets?.images?.[savedElements.indexOf(element)] ?? undefined,
                    }))));
                }

                if (savedReferenceVideos.length > 0) {
                    commitReferenceVideos(hydrateSeedanceMediaReferences(
                        'Video',
                        savedReferenceVideos.map((reference, index) => ({
                            id: reference.id,
                            displayName: reference.displayName,
                            durationSeconds: reference.durationSeconds ?? null,
                            file: reference.file,
                            previewUrl: URL.createObjectURL(reference.file),
                            source: 'upload',
                            seedanceAsset: savedSeedanceAssets?.videos?.[index] ?? undefined,
                        }))
                    ));
                }

	                if (savedReferenceAudios.length > 0) {
	                    commitReferenceAudios(hydrateSeedanceMediaReferences(
	                        'Audio',
                        savedReferenceAudios.map((reference, index) => ({
                            id: reference.id,
                            displayName: reference.displayName,
                            durationSeconds: reference.durationSeconds ?? null,
                            file: reference.file,
                            previewUrl: '',
                            source: 'upload',
                            seedanceAsset: savedSeedanceAssets?.audios?.[index] ?? undefined,
	                        }))
	                    ));
	                }

	                if (savedKlingVideoElements.length > 0) {
	                    commitKlingVideoElements(hydrateKlingVideoElements(
	                        savedKlingVideoElements.map((element) => ({
	                            id: element.id,
	                            displayName: element.displayName,
	                            handle: element.handle,
	                            durationSeconds: element.durationSeconds ?? null,
	                            file: element.file,
	                            previewUrl: URL.createObjectURL(element.file),
	                            source: 'upload',
	                        }))
	                    ));
	                }

	                if (savedKlingSubjects.length > 0) {
	                    // A subject saved before handles were kept has none, and takes
	                    // the handle of its name.
	                    setKlingSubjects(assignSubjectHandles(savedKlingSubjects.map((subject) => ({
	                        id: subject.id,
	                        displayName: subject.displayName,
	                        handle: subject.handle,
	                        images: subject.images.map((image) => ({
	                            id: image.id,
	                            file: image.file,
	                            previewUrl: URL.createObjectURL(image.file),
	                            remoteUrl: null,
	                            storagePath: null,
	                        })),
	                    }))));
	                }
            } catch (err) {
                console.error('Error loading persisted video media:', err);
            }
        };

        void loadPersistedMedia();

        return () => {
            isMounted = false;
        };
    }, [remixId, userId]);

    // The saved text draft, read back before the catalog checks the settings against a
    // model. A link's own prompt, model, ratio or length wins over it; what the link
    // leaves alone comes back. A remix restores its source instead.
    useEffect(() => {
        if (remixId || !userId) return;
        let cancelled = false;
        // The catalog waits for the draft, so a store that never answers must not hold
        // it: past this the page goes on without the draft, and a late one is ignored.
        let settled = false;
        const giveUp = window.setTimeout(() => {
            settled = true;
            if (!cancelled) setDraftRestoredFor(userId);
        }, 3000);
        void loadCreatorDraft<unknown>('video', userId)
            .then((stored) => {
                if (cancelled || settled || !stored) return;
                const draft = readVideoCreatorDraft(stored);
                if (draft.prompt !== undefined && !prefillPrompt) setPrompt(draft.prompt);
                if (draft.modelId && !prefillModel) {
                    restoredDraftModelRef.current = true;
                    setSelectedModel(draft.modelId as VideoModelId);
                }
                if (draft.mode !== undefined) setMode(draft.mode);
                if (draft.aspectRatio && !prefillAspectRatio) setAspectRatio(draft.aspectRatio);
                if (draft.sound !== undefined) setSound(draft.sound);
                if (draft.resolution !== undefined) setResolution(draft.resolution);
                if (draft.fixedLens !== undefined) setFixedLens(draft.fixedLens);
                if (draft.isMultiShot !== undefined) setIsMultiShot(draft.isMultiShot);
                if (draft.shots) setMultiPrompts(draft.shots);
                if (draft.duration !== undefined && !prefillDuration) setSingleDuration(draft.duration);
                if (draft.additionalSettings) pendingAdditionalSettingsRef.current = draft.additionalSettings;
            })
            .catch((draftError) => {
                console.error('Error loading the saved video draft:', draftError);
            })
            .finally(() => {
                window.clearTimeout(giveUp);
                settled = true;
                if (!cancelled) setDraftRestoredFor(userId);
            });
        return () => {
            cancelled = true;
            window.clearTimeout(giveUp);
        };
    }, [remixId, userId, prefillPrompt, prefillModel, prefillAspectRatio, prefillDuration]);

    // A model's extra settings can be set only once its descriptor is here.
    useEffect(() => {
        const pending = pendingAdditionalSettingsRef.current;
        if (!pending) return;
        if (selectedModel !== pending.modelId) {
            pendingAdditionalSettingsRef.current = null;
            return;
        }
        if (catalogDescriptor?.id !== pending.modelId) return;
        pendingAdditionalSettingsRef.current = null;
        for (const [key, value] of Object.entries(pending.values)) {
            additionalSettings.onChange(key, value);
        }
    }, [additionalSettings, catalogDescriptor, selectedModel]);

    const textDraft = useMemo<VideoCreatorDraft>(() => ({
        prompt,
        modelId: selectedModel,
        mode,
        aspectRatio,
        sound,
        resolution,
        fixedLens,
        isMultiShot,
        shots: multiPrompts,
        duration: singleDuration,
        additionalSettings: { modelId: selectedModel, values: additionalSettings.settings },
    }), [prompt, selectedModel, mode, aspectRatio, sound, resolution, fixedLens, isMultiShot, multiPrompts, singleDuration, additionalSettings.settings]);

    const flushTextDraft = useCallback(async () => {
        const unsaved = unsavedDraftRef.current;
        unsavedDraftRef.current = null;
        if (!unsaved) return;
        try {
            await saveCreatorDraft('video', unsaved.userId, {
                ...unsaved.draft,
                // Settings still waiting for their model's descriptor are the ones to keep.
                additionalSettings: pendingAdditionalSettingsRef.current ?? unsaved.draft.additionalSettings,
            });
        } catch (draftError) {
            // The form is unchanged; only its copy for the next visit is behind.
            console.error('Error saving the video draft:', draftError);
        }
    }, []);

    useEffect(() => {
        if (remixId || !userId || draftRestoredFor !== userId) {
            // Signed out, or not yet read back: nothing is written over an account's draft.
            unsavedDraftRef.current = null;
            return;
        }
        unsavedDraftRef.current = { userId, draft: textDraft };
        const timer = window.setTimeout(() => {
            void flushTextDraft();
        }, 500);
        return () => window.clearTimeout(timer);
    }, [draftRestoredFor, flushTextDraft, remixId, textDraft, userId]);

    // An edit made in the last half second is not lost when the page goes.
    useEffect(() => () => {
        void flushTextDraft();
    }, [flushTextDraft]);

    /** Saves the form now, for a reload or a sign-in round trip about to leave the page. */
    const saveTextDraftNow = async () => {
        if (!remixId && userId && draftRestoredFor === userId) {
            unsavedDraftRef.current = { userId, draft: textDraft };
        }
        await flushTextDraft();
    };
    /** Onto the current build, with the draft saved first: it comes back after the reload. */
    const reloadPage = async () => {
        await saveTextDraftNow();
        reloadForNewerBuild();
    };

    const addShot = () => {
        if (!canAddShot) return;
        // A new shot takes what is left of the run's length, up to the usual 5 s.
        const remaining = multiShotMaxTotalSeconds === null ? 5 : multiShotMaxTotalSeconds - totalDuration;
        setMultiPrompts([...multiPrompts, { id: Math.random().toString(), prompt: '', duration: Math.max(1, Math.min(5, remaining)) }]);
        setMultiPromptQualityWarnings({});
    };

    const removeShot = (id: string) => {
        if (multiPrompts.length > 1) {
            setMultiPrompts(multiPrompts.filter((shot) => shot.id !== id));
            if (focusedShotId === id) {
                setFocusedShotId(null);
            }
            if (activeShotMentionQuery?.shotId === id) {
                setActiveShotMentionQuery(null);
            }
            setMultiPromptQualityWarnings((current) => {
                const next = { ...current };
                delete next[id];
                return next;
            });
        }
    };

    const updateShot = (id: string, field: 'prompt' | 'duration', value: string | number) => {
        setMultiPrompts(multiPrompts.map((shot) => shot.id === id ? { ...shot, [field]: value } : shot));
        setMultiPromptQualityWarnings((current) => {
            const next = { ...current };
            delete next[id];
            return next;
        });
    };

    const handleShotPromptChange = (id: string, value: string, caretIndex?: number) => {
        updateShot(id, 'prompt', value);
        updateShotMentionState(id, value, caretIndex);
    };

    const syncShotPromptCaretState = (shot: MultiShot) => {
        setFocusedShotId(shot.id);
        updateShotMentionState(shot.id, shot.prompt);
    };

    const persistFrame = async (file: File, type: 'start' | 'end') => {
        const { refusal } = screenPickedFiles([file], 'image');
        setPickNotice(refusal);
        if (refusal) return;

        if (type === 'start') {
            revokeObjectUrl(startImageUrl);
            setStartImageFile(file);
            setStartImageUrl(URL.createObjectURL(file));
            setStartFrameDescriptor(null);
            const key = mediaKey(PERSISTED_MEDIA_KEYS.createVideoStartImage);
            if (key) {
                await setPersistedFile(key, file);
            }
            return;
        }

        revokeObjectUrl(endImageUrl);
        setEndImageFile(file);
        setEndImageUrl(URL.createObjectURL(file));
        setEndFrameDescriptor(null);
        const key = mediaKey(PERSISTED_MEDIA_KEYS.createVideoEndImage);
        if (key) {
            await setPersistedFile(key, file);
        }
    };

    const processElementFiles = async (files: FileList | File[]) => {
        const { accepted: validFiles, refusal } = screenPickedFiles(Array.from(files), 'image');
        const currentElements = elementsRef.current;
        const availableSlots = Math.max(0, videoElementSupport.maxElements - currentElements.length);
        const filesToAdd = validFiles.slice(0, availableSlots);
        setPickNotice([
            refusal,
            droppedPicksNotice(filesToAdd.length, validFiles.length, videoElementSupport.maxElements, 'image reference'),
        ].filter(Boolean).join(' ') || null);
        if (filesToAdd.length === 0) return;

        const newElements = hydrateVideoElements(filesToAdd.map((file, index) => ({
            displayName: `Element ${currentElements.length + index + 1}`,
            file,
            previewUrl: URL.createObjectURL(file),
            source: 'upload',
        })));

        const nextElements = hydrateVideoElements([...currentElements, ...newElements]);
        commitElements(nextElements);
        await persistVideoElements(nextElements);
        await persistSeedanceAssets(nextElements, referenceVideosRef.current, referenceAudiosRef.current);
    };

    const handleImageDrop = async (event: React.DragEvent, type: 'start' | 'end') => {
        event.preventDefault();
        if (type === 'start') {
            setIsDraggingStart(false);
        } else {
            setIsDraggingEnd(false);
        }

        const file = event.dataTransfer.files?.[0];
        if (file) {
            await persistFrame(file, type);
        }
    };

    const handleElementDrop = async (event: React.DragEvent) => {
        event.preventDefault();
        setIsDraggingElements(false);
        if (event.dataTransfer.files?.length) {
            await processElementFiles(event.dataTransfer.files);
        }
    };

    const handleKlingVideoElementDrop = async (event: React.DragEvent) => {
        event.preventDefault();
        setIsDraggingKlingVideos(false);
        if (event.dataTransfer.files?.length) {
            await processKlingVideoElementFiles(event.dataTransfer.files);
        }
    };

    const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>, type: 'start' | 'end') => {
        const file = event.target.files?.[0];
        if (file) {
            await persistFrame(file, type);
            event.target.value = '';
        }
    };

    const handleElementUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        if (event.target.files?.length) {
            await processElementFiles(event.target.files);
            event.target.value = '';
        }
    };

    const processReferenceVideoFiles = async (files: FileList | File[]) => {
        const { accepted: validFiles, refusal } = screenPickedFiles(Array.from(files), 'video');
        const availableSlots = Math.max(0, referenceVideoLimit - referenceVideosRef.current.length);
        const filesToAdd = validFiles.slice(0, availableSlots);
        setPickNotice([
            refusal,
            droppedPicksNotice(filesToAdd.length, validFiles.length, referenceVideoLimit, 'reference clip'),
        ].filter(Boolean).join(' ') || null);
        if (filesToAdd.length === 0) return;

        const seeds = await Promise.all(filesToAdd.map(async (file, index) => ({
            displayName: `Video reference ${referenceVideosRef.current.length + index + 1}`,
            file,
            previewUrl: URL.createObjectURL(file),
            source: 'upload' as const,
            durationSeconds: await readVideoDurationSeconds(file),
        })));

        const nextReferences = [...referenceVideosRef.current, ...hydrateSeedanceMediaReferences('Video', seeds)];
        commitReferenceVideos(nextReferences);
        await persistReferenceVideos(nextReferences);
        await persistSeedanceAssets(elementsRef.current, nextReferences, referenceAudiosRef.current);
    };

    const processKlingVideoElementFiles = async (files: FileList | File[]) => {
        const selectedFiles = Array.from(files);
        // Kling's own limits are narrower than the upload step's: MP4 or MOV, up to 50 MB.
        const isKlingClip = (file: File) => isSupportedKlingVideoFile(file) && file.size <= KLING_VIDEO_ELEMENT_MAX_BYTES;
        const validFiles = selectedFiles.filter(isKlingClip);
        const refusedNames = selectedFiles.filter((file) => !isKlingClip(file)).map((file) => file.name || 'This file');
        const availableSlots = Math.max(0, KLING_VIDEO_ELEMENT_LIMIT - klingVideoElementsRef.current.length);
        const filesToAdd = validFiles.slice(0, availableSlots);
        // Its own line: an error set here used to clear a run's error or background state.
        setPickNotice([
            refusedNames.length > 0
                ? `${refusedNames.join(', ')} can’t be used: Kling video elements are MP4 or MOV files up to 50 MB.`
                : null,
            droppedPicksNotice(filesToAdd.length, validFiles.length, KLING_VIDEO_ELEMENT_LIMIT, 'video element'),
        ].filter(Boolean).join(' ') || null);
        if (filesToAdd.length === 0) return;

        const seeds = await Promise.all(filesToAdd.map(async (file, index) => ({
            displayName: `Video element ${klingVideoElementsRef.current.length + index + 1}`,
            file,
            previewUrl: URL.createObjectURL(file),
            source: 'upload' as const,
            durationSeconds: await readVideoDurationSeconds(file),
        })));

        const nextElements = hydrateKlingVideoElements([...klingVideoElementsRef.current, ...seeds]);
        commitKlingVideoElements(nextElements);
        await persistKlingVideoElements(nextElements);
    };

    const processReferenceAudioFiles = async (files: FileList | File[]) => {
        const { accepted: validFiles, refusal } = screenPickedFiles(Array.from(files), 'audio');
        const availableSlots = Math.max(0, referenceAudioLimit - referenceAudiosRef.current.length);
        const filesToAdd = validFiles.slice(0, availableSlots);
        setPickNotice([
            refusal,
            droppedPicksNotice(filesToAdd.length, validFiles.length, referenceAudioLimit, 'reference track'),
        ].filter(Boolean).join(' ') || null);
        if (filesToAdd.length === 0) return;

        const seeds = await Promise.all(filesToAdd.map(async (file, index) => ({
            displayName: `Audio reference ${referenceAudiosRef.current.length + index + 1}`,
            file,
            previewUrl: '',
            source: 'upload' as const,
            // Kie caps the combined length of reference audio as it caps clips, and some
            // models price by it, so the quote is told each track's length. A media
            // element reads an audio file's length as it reads a clip's.
            durationSeconds: await readVideoDurationSeconds(file),
        })));

        const nextReferences = [...referenceAudiosRef.current, ...hydrateSeedanceMediaReferences('Audio', seeds)];
        commitReferenceAudios(nextReferences);
        await persistReferenceAudios(nextReferences);
        await persistSeedanceAssets(elementsRef.current, referenceVideosRef.current, nextReferences);
    };

    const handleReferenceVideoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        if (event.target.files?.length) {
            await processReferenceVideoFiles(event.target.files);
            event.target.value = '';
        }
    };

    const handleKlingVideoElementUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        if (event.target.files?.length) {
            await processKlingVideoElementFiles(event.target.files);
            event.target.value = '';
        }
    };

    const handleReferenceAudioUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        if (event.target.files?.length) {
            await processReferenceAudioFiles(event.target.files);
            event.target.value = '';
        }
    };

    const clearImage = async (type: 'start' | 'end') => {
        if (type === 'start') {
            revokeObjectUrl(startImageUrl);
            setStartImageFile(null);
            setStartImageUrl(null);
            setStartFrameDescriptor(null);
            const key = mediaKey(PERSISTED_MEDIA_KEYS.createVideoStartImage);
            if (key) {
                await removePersistedMedia(key);
            }
        } else {
            revokeObjectUrl(endImageUrl);
            setEndImageFile(null);
            setEndImageUrl(null);
            setEndFrameDescriptor(null);
            const key = mediaKey(PERSISTED_MEDIA_KEYS.createVideoEndImage);
            if (key) {
                await removePersistedMedia(key);
            }
        }
    };

    const handleRemoveElement = async (elementId: string) => {
        const currentElements = elementsRef.current;
        const removedElement = currentElements.find((element) => element.id === elementId);
        if (removedElement) {
            revokeObjectUrl(removedElement.previewUrl);
        }

        const nextElements = hydrateVideoElements(
            currentElements.filter((element) => element.id !== elementId)
        );

        elementNames.dropDraft(elementId);
        commitElements(nextElements);
        await persistVideoElements(nextElements);
        await persistSeedanceAssets(nextElements, referenceVideosRef.current, referenceAudiosRef.current);
    };

    const handleRemoveReferenceVideo = async (referenceId: string) => {
        const currentReferences = referenceVideosRef.current;
        const removedReference = currentReferences.find((reference) => reference.id === referenceId);
        if (removedReference) {
            revokeObjectUrl(removedReference.previewUrl);
        }

        const nextReferences = currentReferences.filter((reference) => reference.id !== referenceId);
        commitReferenceVideos(nextReferences);
        await persistReferenceVideos(nextReferences);
        await persistSeedanceAssets(elementsRef.current, nextReferences, referenceAudiosRef.current);
    };

    const handleRemoveKlingVideoElement = async (elementId: string) => {
        const currentElements = klingVideoElementsRef.current;
        const removedElement = currentElements.find((element) => element.id === elementId);
        if (removedElement) {
            revokeObjectUrl(removedElement.previewUrl);
        }

        const nextElements = hydrateKlingVideoElements(
            currentElements.filter((element) => element.id !== elementId)
        );
        klingVideoNames.dropDraft(elementId);
        commitKlingVideoElements(nextElements);
        await persistKlingVideoElements(nextElements);
    };

    const handleRemoveReferenceAudio = async (referenceId: string) => {
        const nextReferences = referenceAudiosRef.current.filter((reference) => reference.id !== referenceId);
        commitReferenceAudios(nextReferences);
        await persistReferenceAudios(nextReferences);
        await persistSeedanceAssets(elementsRef.current, referenceVideosRef.current, nextReferences);
    };

    const addPreparedReferenceId = (kind: 'audio' | 'character') => {
        const draft = (kind === 'audio' ? preparedAudioIdDraft : characterIdDraft).trim();
        if (!draft || !/^[A-Za-z0-9._:-]{3,256}$/.test(draft)) {
            setError(`Enter a valid prepared ${kind === 'audio' ? 'voice' : 'character'} ID.`);
            return;
        }
        const current = kind === 'audio' ? preparedAudioIds : characterIds;
        if (current.includes(draft)) {
            setError('That prepared reference is already added.');
            return;
        }
        if (current.length >= 3) {
            setError(`Gemini Omni supports up to 3 prepared ${kind === 'audio' ? 'voice' : 'character'} references.`);
            return;
        }
        if (kind === 'audio') {
            setPreparedAudioIds([...current, draft]);
            setPreparedAudioIdDraft('');
        } else {
            setCharacterIds([...current, draft]);
            setCharacterIdDraft('');
        }
        setError(null);
    };

    const handleElementRename = async (elementId: string, nextDisplayName: string) => {
        const currentElements = elementsRef.current;
        const nextElements = hydrateVideoElements(
            currentElements.map((element) => (
                element.id === elementId
                    // Without its handle, the element takes the handle of its new name.
                    ? { ...element, displayName: nextDisplayName, handle: null }
                    : element
            ))
        );
        const replacements = createElementHandleReplacementMap(currentElements, nextElements);

        commitElements(nextElements);
        await persistVideoElements(nextElements);
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

    const handleKlingVideoElementRename = async (elementId: string, nextDisplayName: string) => {
        const currentElements = klingVideoElementsRef.current;
        const nextElements = hydrateKlingVideoElements(
            currentElements.map((element) => (
                element.id === elementId
                    // Without its handle, the element takes the handle of its new name.
                    ? { ...element, displayName: nextDisplayName, handle: null }
                    : element
            ))
        );
        const replacements = createElementHandleReplacementMap(currentElements, nextElements);

        commitKlingVideoElements(nextElements);
        await persistKlingVideoElements(nextElements);
        if (replacements.size > 0) {
            setPrompt((currentPrompt) => {
                const nextPrompt = replacePromptHandles(currentPrompt, replacements);
                requestAnimationFrame(() => updateMentionState(nextPrompt));
                return nextPrompt;
            });
            setMultiPrompts((currentPrompts) => currentPrompts.map((shot) => ({
                ...shot,
                prompt: replacePromptHandles(shot.prompt, replacements),
            })));
            setActiveShotMentionQuery(null);
            return;
        }

        requestAnimationFrame(() => updateMentionState(prompt));
    };

    const handleKlingSubjectRename = (subjectId: string, nextDisplayName: string) => {
        const currentSubjects = klingSubjectsRef.current;
        const nextSubjects = commitKlingSubjects(
            currentSubjects.map((subject) => (
                subject.id === subjectId
                    // Without its handle, the subject takes the handle of its new name.
                    ? { ...subject, displayName: nextDisplayName, handle: null }
                    : subject
            ))
        );
        const replacements = createElementHandleReplacementMap(currentSubjects, nextSubjects);
        if (replacements.size === 0) {
            return;
        }

        setPrompt((currentPrompt) => replacePromptHandles(currentPrompt, replacements));
        setMultiPrompts((currentPrompts) => currentPrompts.map((shot) => ({
            ...shot,
            prompt: replacePromptHandles(shot.prompt, replacements),
        })));
        setActiveShotMentionQuery(null);
        // The rewritten prompt moves the mention at the caret, so it is read again
        // once the prompt is drawn. It is read from the prompt box, not from the
        // prompt as it stood here: the creator may have typed into it by then.
        requestAnimationFrame(() => {
            const promptBox = promptTextareaRef.current;
            if (promptBox) {
                updateMentionState(promptBox.value);
            }
        });
    };

    const handleElementDraftChange = (elementId: string, nextValue: string) => {
        elementNames.setDraft(elementId, nextValue);
    };

    const handleKlingVideoDraftChange = (elementId: string, nextValue: string) => {
        klingVideoNames.setDraft(elementId, nextValue);
    };

    const commitElementDraft = async (elementId: string) => {
        const draftValue = elementNames.takeDraft(elementId);
        if (draftValue === undefined) return;

        const trimmed = draftValue.trim();
        if (!trimmed) return;

        const currentElement = elementsRef.current.find((element) => element.id === elementId);
        if (!currentElement || currentElement.displayName === trimmed) {
            return;
        }

        await handleElementRename(elementId, trimmed);
    };

    const commitKlingVideoDraft = async (elementId: string) => {
        const draftValue = klingVideoNames.takeDraft(elementId);
        if (draftValue === undefined) return;

        const trimmed = draftValue.trim();
        if (!trimmed) return;

        const currentElement = klingVideoElementsRef.current.find((element) => element.id === elementId);
        if (!currentElement || currentElement.displayName === trimmed) {
            return;
        }

        await handleKlingVideoElementRename(elementId, trimmed);
    };

    const handlePromptChange = (value: string, caretIndex?: number) => {
        setPrompt(value);
        setPromptQualityWarnings([]);
        updateMentionState(value, caretIndex);
    };

    const syncPromptCaretState = () => {
        updateMentionState(prompt);
    };

    const handleInsertPromptHandle = (handle: string) => {
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

    const handleInsertElementHandle = (handle: string) => {
        handleInsertPromptHandle(handle);
    };

    const handleInsertKlingVideoHandle = (handle: string) => {
        if (currentIsMultiShot) {
            const targetShotId = focusedShotId || multiPrompts[0]?.id;
            if (targetShotId) {
                handleInsertShotHandle(targetShotId, handle);
            }
            return;
        }

        handleInsertPromptHandle(handle);
    };

    const handleInsertShotHandle = (shotId: string, handle: string) => {
        const targetShot = multiPrompts.find((shot) => shot.id === shotId);
        if (!targetShot) {
            return;
        }

        const textarea = multiShotTextareaRefs.current[shotId];
        const selectionStart = textarea?.selectionStart ?? targetShot.prompt.length;
        const selectionEnd = textarea?.selectionEnd ?? targetShot.prompt.length;
        const mentionQuery = activeShotMentionQuery?.shotId === shotId ? activeShotMentionQuery : null;
        const nextValue = insertHandleIntoPrompt(
            targetShot.prompt,
            handle,
            selectionStart,
            selectionEnd,
            mentionQuery
        );

        updateShot(shotId, 'prompt', nextValue.prompt);
        setFocusedShotId(shotId);
        setActiveShotMentionQuery(null);

        requestAnimationFrame(() => {
            textarea?.focus();
            textarea?.setSelectionRange(nextValue.caretIndex, nextValue.caretIndex);
        });
    };

    const createSeedanceAssetKey = (kind: 'image' | 'video' | 'audio', id: string) => `${kind}:${id}`;

    const requestSeedanceAsset = async (
        url: string,
        assetType: SeedanceAssetKind,
        assetId?: string | null
    ): Promise<SeedanceAssetMetadata> => {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            throw new Error('Please log in to prepare Seedance assets.');
        }

        const response = assetId
            ? await fetch(`/api/seedance-assets?assetId=${encodeURIComponent(assetId)}`, {
                headers: {
                    Authorization: `Bearer ${session.access_token}`,
                },
            })
            : await fetch('/api/seedance-assets', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${session.access_token}`,
                },
                body: JSON.stringify({
                    url,
                    assetType,
                }),
            });
        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'Seedance asset request failed');
        }

        return createSeedanceAssetMetadata({
            assetId: typeof data.assetId === 'string' ? data.assetId : null,
            assetType,
            status: data.status,
            sourceUrl: typeof data.sourceUrl === 'string' ? data.sourceUrl : url,
            error: typeof data.error === 'string' ? data.error : null,
            lastCheckedAt: typeof data.lastCheckedAt === 'string' ? data.lastCheckedAt : new Date().toISOString(),
        });
    };

    const ensureUploadedElement = async (element: VideoElementDraft): Promise<VideoElementDraft> => {
        if (!element.file) {
            return element;
        }

        const staged = await stageReferenceFile(element.file, element.staged);
        return {
            ...element,
            providerUrl: staged.signedUrl,
            storagePath: staged.storagePath,
            staged,
            seedanceAsset: {
                ...element.seedanceAsset,
                assetType: 'Image',
                sourceUrl: staged.signedUrl,
            },
        };
    };

    const ensureUploadedReference = async (
        reference: SeedanceMediaReferenceDraft,
        assetType: SeedanceAssetKind
    ): Promise<SeedanceMediaReferenceDraft> => {
        if (!reference.file) {
            return reference;
        }

        const staged = await stageReferenceFile(reference.file, reference.staged);
        return {
            ...reference,
            providerUrl: staged.signedUrl,
            storagePath: staged.storagePath,
            staged,
            seedanceAsset: {
                ...reference.seedanceAsset,
                assetType,
                sourceUrl: staged.signedUrl,
            },
        };
    };

    const ensureUploadedKlingVideoElement = async (
        element: KlingVideoElementDraft
    ): Promise<KlingVideoElementDraft> => {
        if (!element.file) {
            return element;
        }

        const staged = await stageReferenceFile(element.file, element.staged);
        return {
            ...element,
            providerUrl: staged.signedUrl,
            storagePath: staged.storagePath,
            staged,
        };
    };

    /**
     * Takes the uploads a run made back into the cards they were made for, so the next
     * press sends them again instead of uploading. A card whose file changed meanwhile
     * keeps its own.
     */
    const withStagedUploads = <T extends { id: string; file: File | null; providerUrl: string | null; storagePath?: string | null; staged: StagedUpload | null }>(
        current: T[],
        uploaded: readonly T[],
    ): T[] => current.map((item) => {
        const match = uploaded.find((candidate) => candidate.id === item.id && candidate.file === item.file);
        return match?.staged && item.file
            ? { ...item, providerUrl: match.providerUrl, storagePath: match.storagePath, staged: match.staged }
            : item;
    });

    const updateElementAsset = async (
        elementId: string,
        updater: (element: VideoElementDraft) => Promise<VideoElementDraft> | VideoElementDraft
    ) => {
        const currentElements = elementsRef.current;
        const nextElements = await Promise.all(currentElements.map(async (element) => (
            element.id === elementId ? await updater(element) : element
        )));
        commitElements(nextElements);
        await persistVideoElements(nextElements);
        await persistSeedanceAssets(nextElements, referenceVideosRef.current, referenceAudiosRef.current);
        return nextElements.find((element) => element.id === elementId) || null;
    };

    const updateReferenceVideoAsset = async (
        referenceId: string,
        updater: (reference: SeedanceMediaReferenceDraft) => Promise<SeedanceMediaReferenceDraft> | SeedanceMediaReferenceDraft
    ) => {
        const currentReferences = referenceVideosRef.current;
        const nextReferences = await Promise.all(currentReferences.map(async (reference) => (
            reference.id === referenceId ? await updater(reference) : reference
        )));
        commitReferenceVideos(nextReferences);
        await persistReferenceVideos(nextReferences);
        await persistSeedanceAssets(elementsRef.current, nextReferences, referenceAudiosRef.current);
        return nextReferences.find((reference) => reference.id === referenceId) || null;
    };

    const updateReferenceAudioAsset = async (
        referenceId: string,
        updater: (reference: SeedanceMediaReferenceDraft) => Promise<SeedanceMediaReferenceDraft> | SeedanceMediaReferenceDraft
    ) => {
        const currentReferences = referenceAudiosRef.current;
        const nextReferences = await Promise.all(currentReferences.map(async (reference) => (
            reference.id === referenceId ? await updater(reference) : reference
        )));
        commitReferenceAudios(nextReferences);
        await persistReferenceAudios(nextReferences);
        await persistSeedanceAssets(elementsRef.current, referenceVideosRef.current, nextReferences);
        return nextReferences.find((reference) => reference.id === referenceId) || null;
    };

    const prepareElementSeedanceAsset = async (elementId: string) => {
        const activeKey = createSeedanceAssetKey('image', elementId);
        setActiveSeedanceAssetKey(activeKey);

        try {
            const uploadedElement = await updateElementAsset(elementId, (element) => ensureUploadedElement(element));
            if (!uploadedElement) {
                throw new Error('Missing image reference.');
            }

            const sourceUrl = uploadedElement.storagePath || uploadedElement.providerUrl;
            if (!sourceUrl) {
                throw new Error('Missing image source URL.');
            }

            const asset = await requestSeedanceAsset(sourceUrl, 'Image');
            await updateElementAsset(elementId, (element) => ({
                ...element,
                seedanceAsset: asset,
            }));
        } finally {
            setActiveSeedanceAssetKey((current) => current === activeKey ? null : current);
        }
    };

    const refreshElementSeedanceAsset = async (elementId: string, assetId: string) => {
        const activeKey = createSeedanceAssetKey('image', elementId);
        setActiveSeedanceAssetKey(activeKey);

        try {
            const currentElement = elementsRef.current.find((element) => element.id === elementId);
            const sourceUrl = currentElement?.seedanceAsset.sourceUrl || currentElement?.storagePath || currentElement?.providerUrl || '';
            const asset = await requestSeedanceAsset(sourceUrl, 'Image', assetId);
            await updateElementAsset(elementId, (element) => ({
                ...element,
                seedanceAsset: asset,
            }));
        } finally {
            setActiveSeedanceAssetKey((current) => current === activeKey ? null : current);
        }
    };

    const prepareReferenceSeedanceAsset = async (
        kind: 'video' | 'audio',
        referenceId: string
    ) => {
        const activeKey = createSeedanceAssetKey(kind, referenceId);
        setActiveSeedanceAssetKey(activeKey);

        try {
            if (kind === 'video') {
                const uploadedReference = await updateReferenceVideoAsset(referenceId, (reference) => ensureUploadedReference(reference, 'Video'));
                if (!uploadedReference) {
                    throw new Error('Missing video reference.');
                }

                const sourceUrl = uploadedReference.storagePath || uploadedReference.providerUrl;
                if (!sourceUrl) {
                    throw new Error('Missing video source URL.');
                }

                const asset = await requestSeedanceAsset(sourceUrl, 'Video');
                await updateReferenceVideoAsset(referenceId, (reference) => ({
                    ...reference,
                    seedanceAsset: asset,
                }));
                return;
            }

            const uploadedReference = await updateReferenceAudioAsset(referenceId, (reference) => ensureUploadedReference(reference, 'Audio'));
            if (!uploadedReference) {
                throw new Error('Missing audio reference.');
            }

            const sourceUrl = uploadedReference.storagePath || uploadedReference.providerUrl;
            if (!sourceUrl) {
                throw new Error('Missing audio source URL.');
            }

            const asset = await requestSeedanceAsset(sourceUrl, 'Audio');
            await updateReferenceAudioAsset(referenceId, (reference) => ({
                ...reference,
                seedanceAsset: asset,
            }));
        } finally {
            setActiveSeedanceAssetKey((current) => current === activeKey ? null : current);
        }
    };

    const refreshReferenceSeedanceAsset = async (
        kind: 'video' | 'audio',
        referenceId: string,
        assetId: string
    ) => {
        const activeKey = createSeedanceAssetKey(kind, referenceId);
        setActiveSeedanceAssetKey(activeKey);

        try {
            const currentReference = (kind === 'video' ? referenceVideosRef.current : referenceAudiosRef.current)
                .find((reference) => reference.id === referenceId);
            const sourceUrl = currentReference?.seedanceAsset.sourceUrl || currentReference?.storagePath || currentReference?.providerUrl || '';
            const asset = await requestSeedanceAsset(sourceUrl, kind === 'video' ? 'Video' : 'Audio', assetId);

            if (kind === 'video') {
                await updateReferenceVideoAsset(referenceId, (reference) => ({
                    ...reference,
                    seedanceAsset: asset,
                }));
                return;
            }

            await updateReferenceAudioAsset(referenceId, (reference) => ({
                ...reference,
                seedanceAsset: asset,
            }));
        } finally {
            setActiveSeedanceAssetKey((current) => current === activeKey ? null : current);
        }
    };

    const handoffToBackgroundProcessing = (startedAtMs: number) => {
        setError(BACKGROUND_PROCESSING_ERROR);
        setGenerationTiming((current) => freezeGenerationTiming(
            current ?? createLocalGenerationTiming({
                kind: 'video',
                phaseLabel: 'Generating video',
                startedAtMs,
                estimatedTotalMs: estimatedGenerationTotalMs,
            }),
            Date.now()
        ));
    };

    const pollPrediction = async (
        predictionId: string,
        startedAtMs: number,
        estimatedTotalMs: number | null
    ): Promise<{ output: string; timing: GenerationTiming | null }> => {
        const pollController = new AbortController();
        generationPollAbortControllerRef.current?.abort();
        generationPollAbortControllerRef.current = pollController;
        const pollingStartedAt = Date.now();

        try {
            while (Date.now() - pollingStartedAt < 10 * 60 * 1000) {
                let data: GenerationStatusResponse;
                try {
                    data = await fetchGenerationStatusWithRetry({
                        url: `/api/generate-video?id=${predictionId}`,
                        // Read for every check: a run can outlive the token it started with.
                        getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
                        signal: pollController.signal,
                    });
                } catch (statusError) {
                    if (pollController.signal.aborted || isGenerationStatusAbortError(statusError)) {
                        throw statusError;
                    }
                    // Status reads that keep failing say nothing of the run, which goes on
                    // with its credits. Ending the view with an error invited a second,
                    // paid press; the background view says where the run will turn up.
                    throw new Error(BACKGROUND_PROCESSING_ERROR);
                }

                if (data.timing) {
                    setGenerationTiming(data.timing.estimatedTotalMs ? data.timing : {
                        ...data.timing,
                        estimatedTotalMs,
                    });
                } else {
                    setGenerationTiming((current) => current ?? createLocalGenerationTiming({
                        kind: 'video',
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
                    throw new VideoRunFailedError(data.error || 'Video generation failed');
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

    const handleRunFailure = (runError: unknown, startedAtMs: number, cost: number | null) => {
        // The page went away under the poll; the run is not this page's to report.
        if (isGenerationStatusAbortError(runError)) return;
        if (runError instanceof Error && runError.message === BACKGROUND_PROCESSING_ERROR) {
            handoffToBackgroundProcessing(startedAtMs);
            return;
        }
        if (runError instanceof VideoRunFailedError) {
            // A failed run is refunded, and the balance on screen is still the debited one.
            window.dispatchEvent(new Event('credits_updated'));
            setError(`${runError.message}${creditsReturnedSentence(cost)}`);
            setGenerationTiming(null);
            return;
        }
        setError(runError instanceof Error ? runError.message : 'Something went wrong');
        setGenerationTiming(null);
    };

    /**
     * The lengths the server measured, written onto the references they belong to, so
     * the quote is asked again with them and shows the price the run will be charged.
     * Each one is found by the storage path, or else the link, the request sent for it.
     */
    const applyMeasuredReferenceLengths = async (
        sentInputs: readonly CatalogGenerationInputAsset[],
        measured: ReadonlyArray<{ index: number; durationSeconds: number }>,
    ) => {
        const byPath = new Map<string, number>();
        const byUrl = new Map<string, number>();
        for (const { index, durationSeconds } of measured) {
            const input = sentInputs[index];
            if (input?.storagePath) byPath.set(input.storagePath, durationSeconds);
            if (input?.url) byUrl.set(input.url, durationSeconds);
        }
        const remeasured = <T extends { storagePath: string | null; providerUrl: string | null; durationSeconds?: number | null }>(items: T[]) => {
            let changed = false;
            const next = items.map((item) => {
                const length = (item.storagePath ? byPath.get(item.storagePath) : undefined)
                    ?? (item.providerUrl ? byUrl.get(item.providerUrl) : undefined);
                if (length === undefined || length === item.durationSeconds) return item;
                changed = true;
                return { ...item, durationSeconds: length };
            });
            return changed ? next : null;
        };

        const nextVideos = remeasured(referenceVideosRef.current);
        if (nextVideos) {
            commitReferenceVideos(nextVideos);
            await persistReferenceVideos(nextVideos);
        }
        const nextAudios = remeasured(referenceAudiosRef.current);
        if (nextAudios) {
            commitReferenceAudios(nextAudios);
            await persistReferenceAudios(nextAudios);
        }
        const nextKlingElements = remeasured(klingVideoElementsRef.current);
        if (nextKlingElements) {
            commitKlingVideoElements(nextKlingElements);
            await persistKlingVideoElements(nextKlingElements);
        }
    };

    /**
     * A start that did not answer with a run. An answer that may still mean it started
     * keeps the attempt, and the run panel offers to check again under its key. A
     * refusal clears it, and says what the creator can do about it.
     */
    const handleStartFailure = async (startError: unknown, attempt: PendingWebStart) => {
        setGenerationTiming(null);
        if (isAmbiguousWebStartFailure(startError)) {
            setUnconfirmedStart(attempt);
            setError(null);
            return;
        }

        clearPendingWebStart('video');
        setUnconfirmedStart(null);
        const message = startError instanceof Error && startError.message ? startError.message : 'Could not start generation.';
        const code = startError instanceof WebCatalogRequestError ? startError.code : undefined;
        if (code === 'insufficient_credits') {
            // The balance on screen was out of date. It is read again, and the run panel
            // offers a top-up instead of a Generate the server would refuse once more.
            window.dispatchEvent(new Event('credits_updated'));
            setCreditRefusal({ message, ...creditContextRef.current });
            setError(null);
            return;
        }

        setError(message);
        if (code === 'CATALOG_CHANGED' || code === 'MODEL_UNAVAILABLE') {
            setCatalogNotice('Model settings changed. Review the refreshed options before generating.');
            refetchModelCatalog();
        } else if (code === 'prompt_blocked' || code === 'INVALID_GENERATION_REQUEST') {
            (promptTextareaRef.current ?? Object.values(multiShotTextareaRefs.current).find(Boolean))?.focus();
        } else if (code === 'REFERENCE_DURATION_CHANGED' && startError instanceof WebCatalogRequestError) {
            const sentInputs = Array.isArray(attempt.body.inputs) ? attempt.body.inputs as CatalogGenerationInputAsset[] : [];
            await applyMeasuredReferenceLengths(sentInputs, readMeasuredInputDurations(startError.details));
        } else if (code === 'cost_changed') {
            quoteState.costChanged(attempt.body as CatalogGenerationRequestPayload);
        }
    };

    /**
     * Sends a saved start under its own key, and follows the run it answers with. With
     * `reveal`, the result canvas comes into view once the start is confirmed: a refusal is
     * said in the column's bar and must stay in view, and a run picked up on load leaves the
     * page where it is.
     */
    const sendStartAndFollow = async (
        attempt: PendingWebStart,
        startedAtMs: number,
        estimatedTotalMs: number | null,
        { reveal = false }: { reveal?: boolean } = {},
    ) => {
        let started: WebGenerationStartResponse;
        try {
            const { data: { session: activeSession } } = await supabase.auth.getSession();
            started = await requestWebGenerationStart(attempt.body as CatalogGenerationRequestPayload, {
                accessToken: activeSession?.access_token ?? null,
                idempotencyKey: attempt.idempotencyKey,
            });
        } catch (startError) {
            await handleStartFailure(startError, attempt);
            return;
        }

        // The answer names the run: the attempt has done its work.
        clearPendingWebStart('video');
        setUnconfirmedStart(null);
        quoteState.started(attempt.body as CatalogGenerationRequestPayload);
        try {
            setLatestGenerationId(started.generationId ?? null);
            setLatestIsPublic(false);
            announceGenerationStarted();
            updateCredits(started.remainingCredits);
            if (reveal) setCanvasRevealKey((key) => key + 1);

            const result = await pollPrediction(started.predictionId, startedAtMs, estimatedTotalMs);
            setOutputVideo(result.output);
            if (result.timing) {
                setGenerationTiming(result.timing);
            }
        } catch (runError) {
            handleRunFailure(runError, startedAtMs, started.cost);
        }
    };

    /** "Check again": the unanswered start, replayed with the exact body under the same key. */
    const replayPendingStart = async (attempt: PendingWebStart, { reveal = false }: { reveal?: boolean } = {}) => {
        if (activeGenerationRequestKeyRef.current) return;
        activeGenerationRequestKeyRef.current = attempt.idempotencyKey;
        const startedAtMs = getCurrentTimestampMs();
        setIsGenerating(true);
        setError(null);
        setCreditRefusal(null);
        setGenerationTiming(createLocalGenerationTiming({
            kind: 'video',
            phaseLabel: 'Checking your generation',
            startedAtMs,
            estimatedTotalMs: null,
        }));
        try {
            await sendStartAndFollow(attempt, startedAtMs, null, { reveal });
        } finally {
            activeGenerationRequestKeyRef.current = null;
            setIsGenerating(false);
        }
    };


    const handleSelectModel = (modelId: VideoModelId) => {
        const nextModel = VIDEO_MODELS[modelId];

        // A notice about the previous model no longer applies.
        if (modelId !== selectedModel) setCatalogNotice(null);
        setSelectedModel(modelId);
        setIsModelDropdownOpen(false);
        setModelSearchQuery('');
        setMode(nextModel.modeOptions[0]?.value || '');
        setAspectRatio(nextModel.aspectRatios[0]);
        setSingleDuration(getDefaultVideoDuration(modelId));
        setResolution(nextModel.resolutions[0] || '');
        setSound(false);
        setFixedLens(false);
        setPromptQualityWarnings([]);
        setMultiPromptQualityWarnings({});

        if (!nextModel.supportsMultiShot) {
            setIsMultiShot(false);
        }

        if (['grok-imagine-video', 'grok-imagine-video-1.5', 'kling-3.0-turbo', 'hailuo-2.3', 'happyhorse-1.1', 'gemini-omni-video'].includes(modelId) && endImageUrl) {
            void clearImage('end');
        }
    };

    useEffect(() => {
        const resumePendingGeneration = async () => {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) return;

            // A start this tab sent and never heard back from goes first. Replayed under
            // its own key, it answers with the run it started, or starts it once.
            const unanswered = loadPendingWebStart('video', session.user.id);
            if (unanswered) {
                await replayPendingStart(unanswered);
                return;
            }

            const { data, error: pendingError } = await supabase
                .from('generations')
                .select('id, prediction_id, status, created_at, cost')
                .eq('user_id', session.user.id)
                .eq('category', 'video')
                .is('creation_mode', null)
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
            setGenerationTiming(createLocalGenerationTiming({
                kind: 'video',
                phaseLabel: 'Resuming active run',
                startedAtMs,
                appStatus: data.status === 'waiting' ? 'waiting' : 'processing',
            }));

            try {
                const result = await pollPrediction(data.prediction_id, startedAtMs, null);
                setOutputVideo(result.output);
                if (result.timing) {
                    setGenerationTiming(result.timing);
                }
            } catch (generationError) {
                handleRunFailure(generationError, startedAtMs, typeof data.cost === 'number' ? data.cost : null);
            } finally {
                setIsGenerating(false);
            }
        };

        void resumePendingGeneration();
        // Recovery is intentionally a mount-only lookup; changing form settings must not restart it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const isBackgroundProcessing = error === BACKGROUND_PROCESSING_ERROR;
    // Watched while idle only: a reload mid-upload or mid-start lost the run's page. A page
    // left hidden reloads by itself; one in use reloads at the next press instead of sending.
    const { newBuildAvailable } = useDeploymentRefresh(!isGenerating && !isBackgroundProcessing);

    const handleGenerate = async ({ replacingUnconfirmed = false }: { replacingUnconfirmed?: boolean } = {}) => {
        if (activeGenerationRequestKeyRef.current) return;
        // An unanswered start is checked again under its own key before anything new is sent.
        if (unconfirmedStart && !replacingUnconfirmed) {
            await replayPendingStart(unconfirmedStart, { reveal: true });
            return;
        }
        setPickNotice(null);
        if (isMultiShot) {
            if (multiPrompts.some((shot) => !shot.prompt.trim())) {
                setError('All shots must have a prompt');
                return;
            }
        } else if (!prompt.trim()) {
            setError('Please enter a prompt');
            return;
        }

        // Said beside Generate for as long as it holds, so nothing is set here.
        if (promptLimitMessage) return;

        if (!currentIsMultiShot && staleElementMentions.length > 0) {
            setError(`Unknown element mention${staleElementMentions.length > 1 ? 's' : ''}: ${staleElementMentions.join(', ')}`);
            return;
        }

        if (currentIsMultiShot && multiShotUnknownMentions.length > 0) {
            setError(`Unknown element mention${multiShotUnknownMentions.length > 1 ? 's' : ''}: ${multiShotUnknownMentions.join(', ')}`);
            return;
        }

        if (!currentIsMultiShot && hasInactiveElementMentions) {
            setError(`${videoModel.displayName} cannot use ${standbyElementMentions.join(', ')}. Remove ${standbyElementMentions.length > 1 ? 'them' : 'it'} from the prompt, or pick a model that takes reusable references.`);
            return;
        }

        if (isKlingVideoModel && klingVideoElements.length > KLING_VIDEO_ELEMENT_LIMIT) {
            setError(`Kling 3.0 Video supports up to ${KLING_VIDEO_ELEMENT_LIMIT} video elements.`);
            return;
        }

        if (klingSubjectsActive) {
            const { maxNamed, imagesPerSubject } = affordances.subjects;
            if (klingSubjects.length > maxNamed) {
                setError(`${videoModel.displayName} supports up to ${maxNamed} named subjects per run.`);
                return;
            }
            const invalidSubject = klingSubjects.find((subject) =>
                subject.images.length < imagesPerSubject.min || subject.images.length > imagesPerSubject.max);
            if (invalidSubject) {
                setError(`${invalidSubject.displayName || 'Each subject'} needs ${imagesPerSubject.min}–${imagesPerSubject.max} images of the same subject.`);
                return;
            }
            if (frameReferenceCount > 0 || (activeReferenceMode === 'elements' && hasReferenceAttachment)) {
                setError('Named subjects replace frames and reference images for this run — remove one or the other.');
                return;
            }
        }

        if (supportsMultimodalReferences && activeReferenceMode === 'elements' && runReferenceVideos.length > referenceVideoLimit) {
            setError(`${videoModel.displayName} supports up to ${referenceVideoLimit} reference videos per run.`);
            return;
        }

        if (supportsMultimodalReferences && activeReferenceMode === 'elements' && runReferenceAudios.length > referenceAudioLimit) {
            setError(`${videoModel.displayName} supports up to ${referenceAudioLimit} reference audio file${referenceAudioLimit === 1 ? '' : 's'} per run.`);
            return;
        }

        if (isWanVideoModel && activeReferenceMode === 'elements' && runElements.length + runReferenceVideos.length + runReferenceAudios.length > 5) {
            setError('Wan 2.7 supports up to 5 reusable image, video, and audio references in total.');
            return;
        }

        if (isGeminiOmniVideoModel && activeReferenceMode === 'elements' && runElements.length + (runReferenceVideos.length * 2) > 7) {
            setError('Gemini Omni supports seven reference slots; a video uses two slots.');
            return;
        }
        if (isGeminiOmniVideoModel && preparedAudioIds.length > 3) {
            setError('Gemini Omni supports up to 3 prepared voice references.');
            return;
        }
        if (isGeminiOmniVideoModel && characterIds.length > 3) {
            setError('Gemini Omni supports up to 3 prepared character references.');
            return;
        }
        if (isGeminiOmniVideoModel && activeReferenceMode === 'elements' && runElements.length + (runReferenceVideos.length * 2) + characterIds.length > 7) {
            setError('Gemini Omni supports seven reference slots; videos use two and characters use one.');
            return;
        }

        if (selectedModel === 'hailuo-2.3' && !startImageFile && !startImageUrl) {
            setError('Hailuo 2.3 needs a start image to animate.');
            return;
        }

        // Combined reference-clip budget comes from the descriptor constraint, so the
        // pre-submit check and the server quote enforce the same number with the same
        // copy. The previous hardcoded 15 kept blocking Seedance 2.5 after its budget
        // grew to 30 seconds.
        const combinedDurationConstraint = affordances.activeConstraints.find(
            (constraint) => constraint.type === 'combined-duration',
        );
        if (combinedDurationConstraint) {
            const knownReferenceVideoDuration = runReferenceVideos.reduce((total, reference) => {
                return total + (typeof reference.durationSeconds === 'number' ? reference.durationSeconds : 0);
            }, 0);
            if (knownReferenceVideoDuration > combinedDurationConstraint.max) {
                setError(combinedDurationConstraint.message);
                return;
            }
        }

        if (currentIsMultiShot) {
            const nextWarnings = multiPrompts.reduce<Record<string, PromptEnhancementWarning[]>>((acc, shot, index) => {
                const inspection = inspectPromptQuality({
                    medium: 'video',
                    selectedModel,
                    prompt: shot.prompt,
                    context: buildShotPromptQualityContext(shot, index),
                });
                acc[shot.id] = inspection.warnings;
                return acc;
            }, {});
            setMultiPromptQualityWarnings(nextWarnings);

            const blockingWarning = Object.values(nextWarnings)
                .flat()
                .find((warning) => warning.severity === 'blocking');
            if (blockingWarning) {
                setError(blockingWarning.message);
                return;
            }
        } else {
            const inspection = inspectPromptQuality({
                medium: 'video',
                selectedModel,
                prompt,
                context: buildSinglePromptQualityContext(),
            });
            setPromptQualityWarnings(inspection.warnings);

            const blockingWarning = inspection.warnings.find((warning) => warning.severity === 'blocking');
            if (blockingWarning) {
                setError(blockingWarning.message);
                return;
            }
        }

        // Held from here, so a second click while the session is read sends nothing.
        const idempotencyKey = createGenerationIdempotencyKey('video');
        activeGenerationRequestKeyRef.current = idempotencyKey;

        // A newer build was deployed since this page loaded. The run is not sent from the
        // old one: the draft is saved and the page reloads onto the new build.
        if (newBuildAvailable) {
            await reloadPage();
            activeGenerationRequestKeyRef.current = null;
            return;
        }

        const { data: { session: activeSession } } = await supabase.auth.getSession();
        if (!activeSession) {
            // Back here after signing in, on this page's own link, with the draft saved.
            activeGenerationRequestKeyRef.current = null;
            await saveTextDraftNow();
            router.push(`/login?returnUrl=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
            return;
        }

        setIsGenerating(true);
        setError(null);
        setCreditRefusal(null);
        setOutputVideo(null);
        setLatestGenerationId(null);
        setLatestIsPublic(false);
        setPublishedMeta(null);
        setRunShape({ aspectRatio: currentAspectRatio, label: `${videoModel.displayName} · ${settingsSummary}` });
        const startedAtMs = getCurrentTimestampMs();
        const estimatedTotalMs = estimatedGenerationTotalMs;
        setGenerationTiming(createLocalGenerationTiming({
            kind: 'video',
            phaseLabel: 'Preparing inputs',
            startedAtMs,
            estimatedTotalMs,
        }));

        // A prepared Seedance asset goes as its id beside the file's own link: the server
        // measures the link and gives the provider the id. One still processing, or one
        // that failed, would fail at the provider after the credits were held.
        const preparedAssetId = (asset: SeedanceAssetMetadata) => {
            const assetId = asset.assetId?.trim();
            return isSeedance2Family && asset.status === 'active' && assetId ? assetId : null;
        };

        let attempt: PendingWebStart | null = null;
        try {
            // The run is posted from the inputs its price was quoted from (`runInputs`), each
            // made into what the server is sent once its file is up. One that was priced
            // and not made fails the run here rather than being left out of it.
            const sent = new Map<PageVideoRunInput, CatalogGenerationInputAsset>();
            const send = (input: PageVideoRunInput, asset: Omit<CatalogGenerationInputAsset, 'slot' | 'kind'>) => {
                sent.set(input, { slot: input.slot, kind: input.kind, ...asset });
            };
            const planned = <Slot extends PageVideoRunInput['slot']>(slot: Slot) => runInputs.filter(
                (input): input is Extract<PageVideoRunInput, { slot: Slot }> => input.slot === slot,
            );
            let nextStartFrameDescriptor = startFrameDescriptor;
            let nextEndFrameDescriptor = endFrameDescriptor;

            const imageReferenceInputs = planned('imageReferences');
            if (imageReferenceInputs.length > 0) {
                setGenerationTiming(createLocalGenerationTiming({
                    kind: 'video',
                    phaseLabel: imageReferenceInputs.length === 1 ? 'Uploading 1 image reference' : `Uploading ${imageReferenceInputs.length} image references`,
                    startedAtMs,
                    estimatedTotalMs,
                }));

                const preparedElements = await Promise.all(imageReferenceInputs.map((input) => ensureUploadedElement(input.element)));
                commitElements(withStagedUploads(elementsRef.current, preparedElements));
                preparedElements.forEach((preparedElement, index) => {
                    const imageUrl = preparedElement.providerUrl || preparedElement.previewUrl;
                    if (!imageUrl) {
                        throw new Error(`Missing media for ${preparedElement.displayName}`);
                    }
                    send(imageReferenceInputs[index], {
                        url: imageUrl,
                        assetId: preparedAssetId(preparedElement.seedanceAsset),
                        label: preparedElement.displayName,
                        handle: preparedElement.handle,
                        storagePath: preparedElement.storagePath ?? null,
                        sourceGenerationId: preparedElement.sourceGenerationId ?? null,
                    });
                });
            }

            const referenceVideoInputs = planned('videoReferences');
            if (referenceVideoInputs.length > 0) {
                setGenerationTiming(createLocalGenerationTiming({
                    kind: 'video',
                    phaseLabel: referenceVideoInputs.length === 1 ? 'Uploading 1 reference video' : `Uploading ${referenceVideoInputs.length} reference videos`,
                    startedAtMs,
                    estimatedTotalMs,
                }));
                const preparedReferences = await Promise.all(referenceVideoInputs.map((input) => ensureUploadedReference(input.reference, 'Video')));
                commitReferenceVideos(withStagedUploads(referenceVideosRef.current, preparedReferences));
                preparedReferences.forEach((preparedReference, index) => {
                    const sourceUrl = preparedReference.providerUrl || preparedReference.previewUrl;
                    if (!sourceUrl) {
                        throw new Error(`Missing media for ${preparedReference.displayName}`);
                    }
                    const input = referenceVideoInputs[index];
                    send(input, {
                        url: sourceUrl,
                        assetId: preparedAssetId(preparedReference.seedanceAsset),
                        label: preparedReference.displayName,
                        durationSeconds: input.durationSeconds,
                        storagePath: preparedReference.storagePath ?? null,
                        sourceGenerationId: preparedReference.sourceGenerationId ?? null,
                    });
                });
            }

            const referenceAudioInputs = planned('audioReferences');
            if (referenceAudioInputs.length > 0) {
                setGenerationTiming(createLocalGenerationTiming({
                    kind: 'video',
                    phaseLabel: referenceAudioInputs.length === 1 ? 'Uploading 1 reference audio clip' : `Uploading ${referenceAudioInputs.length} reference audio clips`,
                    startedAtMs,
                    estimatedTotalMs,
                }));
                const preparedReferences = await Promise.all(referenceAudioInputs.map((input) => ensureUploadedReference(input.reference, 'Audio')));
                commitReferenceAudios(withStagedUploads(referenceAudiosRef.current, preparedReferences));
                preparedReferences.forEach((preparedReference, index) => {
                    const sourceUrl = preparedReference.providerUrl || preparedReference.previewUrl;
                    if (!sourceUrl) {
                        throw new Error(`Missing media for ${preparedReference.displayName}`);
                    }
                    const input = referenceAudioInputs[index];
                    send(input, {
                        url: sourceUrl,
                        assetId: preparedAssetId(preparedReference.seedanceAsset),
                        label: preparedReference.displayName,
                        durationSeconds: input.durationSeconds,
                        storagePath: preparedReference.storagePath ?? null,
                        sourceGenerationId: preparedReference.sourceGenerationId ?? null,
                    });
                });
            }

            const videoElementInputs = planned('videoElements');
            if (videoElementInputs.length > 0) {
                setGenerationTiming(createLocalGenerationTiming({
                    kind: 'video',
                    phaseLabel: videoElementInputs.length === 1 ? 'Uploading 1 Kling video element' : `Uploading ${videoElementInputs.length} Kling video elements`,
                    startedAtMs,
                    estimatedTotalMs,
                }));

                const uploadedKlingElements = await Promise.all(videoElementInputs.map(async ({ element }) => {
                    const preparedElement = await ensureUploadedKlingVideoElement(element);
                    const sourceUrl = preparedElement.providerUrl || preparedElement.previewUrl;
                    if (!sourceUrl) {
                        throw new Error(`Missing media for ${element.displayName}`);
                    }

                    return {
                        ...preparedElement,
                        requestUrl: preparedElement.storagePath || sourceUrl,
                    };
                }));

                commitKlingVideoElements(withStagedUploads(klingVideoElementsRef.current, uploadedKlingElements));
                uploadedKlingElements.forEach((element, index) => {
                    send(videoElementInputs[index], {
                        url: element.requestUrl,
                        label: element.displayName,
                        handle: element.handle,
                        storagePath: element.storagePath ?? null,
                        sourceGenerationId: element.sourceGenerationId ?? null,
                    });
                });
            }

            const subjectImageInputs = planned('subjectImages');
            if (subjectImageInputs.length > 0) {
                setGenerationTiming(createLocalGenerationTiming({
                    kind: 'video',
                    phaseLabel: subjectImageInputs.length === 1 ? 'Uploading 1 subject image' : `Uploading ${subjectImageInputs.length} subject images`,
                    startedAtMs,
                    estimatedTotalMs,
                }));
                const uploadedImages = new Map<KlingSubjectImageDraft, KlingSubjectImageDraft>();
                for (const input of subjectImageInputs) {
                    const { image, subject } = input;
                    let remoteUrl = image.remoteUrl;
                    let storagePath = image.storagePath;
                    let staged = image.staged ?? null;
                    // A picture of the creator's own is staged; a remix's is the file the run kept.
                    if (image.file) {
                        staged = await stageReferenceFile(image.file, image.staged);
                        remoteUrl = staged.signedUrl;
                        storagePath = staged.storagePath;
                    }
                    if (!remoteUrl && !storagePath) {
                        throw new Error(`Missing media for ${subject.displayName}`);
                    }
                    uploadedImages.set(image, { ...image, remoteUrl, storagePath, staged });
                    send(input, {
                        url: storagePath || remoteUrl!,
                        label: subject.displayName,
                        handle: subject.handle,
                        storagePath: storagePath ?? null,
                        sourceGenerationId: null,
                    });
                }
                // Keep the uploaded URLs so a retry does not re-upload the set.
                commitKlingSubjects(klingSubjects.map((subject) => ({
                    ...subject,
                    images: subject.images.map((image) => uploadedImages.get(image) ?? image),
                })));
            }

            const [startFrameInput] = planned('startFrame');
            if (startFrameInput) {
                let startUrl = startImageUrl;
                if (startImageFile) {
                    setGenerationTiming(createLocalGenerationTiming({
                        kind: 'video',
                        phaseLabel: 'Uploading start frame',
                        startedAtMs,
                        estimatedTotalMs,
                    }));
                    const staged = await stageReferenceFile(
                        startImageFile,
                        startFrameStaged?.file === startImageFile ? startFrameStaged.staged : null,
                    );
                    setStartFrameStaged({ file: startImageFile, staged });
                    startUrl = staged.signedUrl;
                    nextStartFrameDescriptor = {
                        kind: 'image',
                        label: 'Start frame',
                        storagePath: staged.storagePath,
                        sourceGenerationId: null,
                    };
                }
                if (!startUrl) {
                    throw new Error('Missing media for Start frame');
                }
                send(startFrameInput, {
                    url: startUrl,
                    label: nextStartFrameDescriptor?.label ?? 'Start frame',
                    storagePath: nextStartFrameDescriptor?.storagePath ?? null,
                    sourceGenerationId: nextStartFrameDescriptor?.sourceGenerationId ?? null,
                });
            }

            const [endFrameInput] = planned('endFrame');
            if (endFrameInput) {
                let endUrl = endImageUrl;
                if (endImageFile) {
                    setGenerationTiming(createLocalGenerationTiming({
                        kind: 'video',
                        phaseLabel: 'Uploading end frame',
                        startedAtMs,
                        estimatedTotalMs,
                    }));
                    const staged = await stageReferenceFile(
                        endImageFile,
                        endFrameStaged?.file === endImageFile ? endFrameStaged.staged : null,
                    );
                    setEndFrameStaged({ file: endImageFile, staged });
                    endUrl = staged.signedUrl;
                    nextEndFrameDescriptor = {
                        kind: 'image',
                        label: 'End frame',
                        storagePath: staged.storagePath,
                        sourceGenerationId: null,
                    };
                }
                if (!endUrl) {
                    throw new Error('Missing media for End frame');
                }
                send(endFrameInput, {
                    url: endUrl,
                    label: nextEndFrameDescriptor?.label ?? 'End frame',
                    storagePath: nextEndFrameDescriptor?.storagePath ?? null,
                    sourceGenerationId: nextEndFrameDescriptor?.sourceGenerationId ?? null,
                });
            }

            for (const input of runInputs) {
                if (input.slot === 'preparedVoices' || input.slot === 'characters') {
                    send(input, { assetId: input.assetId });
                }
            }

            // The price on the run panel goes with the run when it is this run's own quote.
            const payload = webCatalogStartRequest({
                kind: 'video',
                modelId: selectedModel,
                prompt: prompt.trim(),
                shots: currentIsMultiShot
                    ? multiPrompts.map((shot) => ({
                        prompt: shot.prompt,
                        duration: Math.max(1, Math.round(shot.duration)),
                    }))
                    : [],
                settings: runSettings,
                inputs: runInputs.map((input) => {
                    const asset = sent.get(input);
                    if (!asset) {
                        throw new Error(`Missing media for ${input.slot}`);
                    }
                    return asset;
                }),
                ...(remixId ? { sourceGenerationId: remixId } : {}),
                catalogRevision: modelCatalog.catalog?.revision ?? '',
            }, quoteState);

            attempt = {
                version: 1,
                tool: 'video',
                idempotencyKey,
                body: payload,
                catalogRevision: payload.catalogRevision,
                createdAt: new Date().toISOString(),
                userId: activeSession.user.id,
            };
            // Kept before it is sent: with no answer, the next press and the next visit
            // replay this key and body instead of paying for a second run.
            savePendingWebStart(attempt);
        } catch (prepareError) {
            setError(prepareError instanceof Error ? prepareError.message : 'Something went wrong');
            setGenerationTiming(null);
            activeGenerationRequestKeyRef.current = null;
            setIsGenerating(false);
            return;
        }

        try {
            setGenerationTiming(createLocalGenerationTiming({
                kind: 'video',
                phaseLabel: 'Submitting video run',
                startedAtMs,
                estimatedTotalMs,
            }));
            await sendStartAndFollow(attempt, startedAtMs, estimatedTotalMs, { reveal: true });
        } finally {
            activeGenerationRequestKeyRef.current = null;
            setIsGenerating(false);
        }
    };

    // The creator's own choice to stop waiting, priced on its button: the unanswered
    // start may yet have started, so this can be a second run.
    const startNewRunInstead = () => {
        clearPendingWebStart('video');
        setUnconfirmedStart(null);
        void handleGenerate({ replacingUnconfirmed: true });
    };

    // What the run leaves out because the model has no slot for it, with a way to take
    // each off: the standby card used to say they were kept and offer no means to remove them.
    const standbyReferences: Array<{ kind: 'image' | 'video' | 'audio'; id: string; displayName: string; onRemove: () => void }> = [
        ...(showSavedElementNotice
            ? elements.map((element) => ({ kind: 'image' as const, id: element.id, displayName: element.displayName, onRemove: () => void handleRemoveElement(element.id) }))
            : []),
        ...(affordances.carries.videos
            ? []
            : referenceVideos.map((reference) => ({ kind: 'video' as const, id: reference.id, displayName: reference.displayName, onRemove: () => void handleRemoveReferenceVideo(reference.id) }))),
        ...(affordances.carries.audios
            ? []
            : referenceAudios.map((reference) => ({ kind: 'audio' as const, id: reference.id, displayName: reference.displayName, onRemove: () => void handleRemoveReferenceAudio(reference.id) }))),
    ];

    const openPublishModal = async () => {
        const generationId = latestGenerationId;
        if (!generationId) return;
        if (publishDefaults?.generationId !== generationId) {
            // Read before the modal opens: it seeds its title from these as it opens.
            setIsPreparingPublish(true);
            setPublishDefaults(await loadCreationPublishDefaults(generationId, session?.access_token));
            setIsPreparingPublish(false);
        }
        setIsPublishModalOpen(true);
    };

    if (isLoadingUser) {
        return (
            <div className="ui-page min-h-screen text-[var(--ui-text-primary)] flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-zinc-500" />
            </div>
        );
    }
    const backgroundProcessingCopy = getBackgroundProcessingCopy('video');
    const backgroundTiming = generationTiming ? freezeGenerationTiming(generationTiming, nowMs) : null;
    const backgroundTimingLabel = backgroundTiming ? getGenerationTimingSummaryLabel(backgroundTiming, nowMs) : null;

    const primarySharePrompt = publishedMeta?.description
        || prompt.trim()
        || multiPrompts.map((shot) => shot.prompt.trim()).find(Boolean)
        || null;
    const shareTitle = publishedMeta?.title
        || prompt.trim()
        || multiPrompts.map((shot) => shot.prompt.trim()).find(Boolean)
        || `${videoModel.displayName} video`;
    const publicResultPath = latestGenerationId && latestIsPublic ? buildShowcaseDetailPath(latestGenerationId) : null;

    const canvasTitle = outputVideo
        ? 'Your video'
        : isGenerating
            ? 'Creating your video'
            : isBackgroundProcessing
                ? 'Your video'
                : 'Result';
    const canvasSubtitle = outputVideo
        ? primarySharePrompt
        : isGenerating
            ? runShape?.label ?? `${videoModel.displayName} · ${settingsSummary}`
            : isBackgroundProcessing
                ? null
                : `${videoModel.displayName} · ${settingsSummary}`;
    const emptyCanvasHint = currentIsMultiShot
        ? 'Write each shot, then Generate.'
        : activeReferenceMode === 'elements'
            ? 'Write a prompt, add references if you like, then Generate.'
            : 'Write a prompt, add frames if you like, then Generate.';

    const isAwaitingStartCheck = Boolean(unconfirmedStart) && !isGenerating;
    // What stops or explains a run, said just above the bar. Progress is drawn on the
    // canvas; a run in the background is named here too, beside Generate.
    const runStatus = isGenerating ? null : isBackgroundProcessing ? (
        <p className="text-[var(--ui-text-secondary)]">
            {backgroundProcessingCopy.title}: it lands in{' '}
            <Link href="/creations" className="underline underline-offset-4 hover:text-[var(--ui-text-primary)]">Studio</Link>
            {' '}when it is done.
        </p>
    ) : unconfirmedStart ? (
        <div className="space-y-3">
            <p role="alert" className="text-amber-200">{START_UNCONFIRMED_MESSAGE}</p>
            <button
                type="button"
                onClick={startNewRunInstead}
                disabled={quotePending || Boolean(promptLimitMessage)}
                className="ui-button ui-button-secondary ui-focus-ring w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
                {estimatedCost !== null ? `Start a new run · ${quoteUi.costLabel}` : 'Start a new run'}
            </button>
        </div>
    ) : pickNotice ? (
        <p className="text-amber-200 [overflow-wrap:anywhere]">{pickNotice}</p>
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
        // The error can name a handle, and can print a subject's name or whatever the
        // server answered. A handle gets its own box; any other word that no line can
        // hold breaks where the line ends. A price that could not be read since (asked
        // again after `cost_changed`, say) keeps its Retry under the error: Generate
        // waits for a price.
        <div className="space-y-2">
            <p className="text-red-400 [overflow-wrap:anywhere]">
                <StudioElementHandleText text={error} />
            </p>
            {quoteRetry}
        </div>
    ) : quoteState.status === 'error' ? (
        quoteRetry
    ) : null;
    const topUpNotice = showTopUp && !isAwaitingStartCheck ? (
        <div>
            <p className="font-semibold text-[var(--ui-text-primary)]">Not enough credits</p>
            <p className="mt-1 text-[var(--ui-text-muted)]">
                {insufficientCredits ? (
                    <>This run costs <strong className="text-[var(--ui-text-primary)]">{estimatedCost} credits</strong> but you only have <strong className="text-[var(--ui-text-primary)]">{userCredits}</strong>.</>
                ) : creditRefusal?.message}
            </p>
        </div>
    ) : null;
    const barStatus = topUpNotice || runStatus ? (
        <div className="space-y-3">
            {topUpNotice}
            {runStatus}
        </div>
    ) : null;

    const barAction = isAwaitingStartCheck && unconfirmedStart ? (
        <button
            type="button"
            onClick={() => void replayPendingStart(unconfirmedStart, { reveal: true })}
            className={CREATOR_BAR_PRIMARY_CLASS}
        >
            Check again
        </button>
    ) : showTopUp ? (
        <Link href="/pricing" className={CREATOR_BAR_PRIMARY_CLASS}>
            <Sparkles className="h-4 w-4" />
            Top Up Credits
        </Link>
    ) : (
        <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={isGenerating || quotePending || Boolean(promptLimitMessage)}
            // The price stays in its name while the face says why it waits.
            aria-label={isGenerating ? undefined : `Generate · ${quoteUi.costLabel}`}
            className={CREATOR_BAR_PRIMARY_CLASS}
        >
            {isGenerating ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Generating...</>
            ) : estimatedCost !== null ? (
                `Generate · ${quoteUi.costLabel}`
            ) : (
                // As the app's bar: until there is a price the button says why it waits
                // ("Calculating...", "Unavailable"), and the line above offers a retry.
                <span className="truncate">{quoteUi.costLabel}</span>
            )}
        </button>
    );

    const settingsPanel = (
        <div className="space-y-5">
            {videoModel.modeOptions.length > 0 ? (
                <CreatorSettingChoices
                    label={selectedModel === 'veo-3.1' ? 'Model variant' : 'Quality mode'}
                    options={videoModel.modeOptions.map((option) => option.value)}
                    optionLabel={(value) => videoModel.modeOptions.find((option) => option.value === value)?.label ?? value}
                    value={currentMode}
                    onChange={setMode}
                    columns={videoModel.modeOptions.length === 2 ? 2 : 1}
                    accent="video"
                />
            ) : null}

            {currentIsMultiShot ? (
                <p className="text-xs text-[var(--ui-text-faint)]">Each shot sets its own length: {totalDuration}s in all.</p>
            ) : singleShotDurationRange ? (
                <div>
                    <div className="mb-2 flex items-baseline justify-between gap-3">
                        <label htmlFor="create-video-duration" className="text-xs font-bold text-[var(--ui-text-muted)]">Duration</label>
                        <span className="text-xs font-bold tabular-nums text-[var(--ui-text-primary)]">{currentDuration}s</span>
                    </div>
                    <input
                        id="create-video-duration"
                        type="range"
                        min={singleShotDurationRange.min}
                        max={singleShotDurationRange.max}
                        step="1"
                        value={currentDuration}
                        onChange={(event) => setSingleDuration(Number(event.target.value))}
                        className="ui-focus-ring w-full accent-[var(--ui-accent-video)]"
                    />
                    <div className="mt-1 flex justify-between text-xs tabular-nums text-[var(--ui-text-faint)]">
                        <span>{singleShotDurationRange.min}s</span>
                        <span>{singleShotDurationRange.max}s</span>
                    </div>
                </div>
            ) : videoModel.durations.length > 1 ? (
                <CreatorSettingChoices
                    label="Duration"
                    options={videoModel.durations.map(String)}
                    optionLabel={(value) => `${value}s`}
                    value={String(currentDuration)}
                    onChange={(value) => setSingleDuration(Number(value))}
                    columns={choiceColumns(videoModel.durations.length)}
                    accent="video"
                />
            ) : (
                <div className="flex items-baseline justify-between gap-3">
                    <p className="text-xs font-bold text-[var(--ui-text-muted)]">Duration</p>
                    <p className="text-sm font-semibold tabular-nums text-[var(--ui-text-primary)]">{videoModel.durations[0]}s, fixed</p>
                </div>
            )}

            {videoModel.resolutions.length > 0 ? (
                <CreatorSettingChoices
                    label="Resolution"
                    options={videoModel.resolutions as readonly string[]}
                    value={currentResolution}
                    onChange={setResolution}
                    columns={choiceColumns(videoModel.resolutions.length)}
                    accent="video"
                />
            ) : null}

            <CreatorSettingChoices
                label="Aspect ratio"
                options={videoModel.aspectRatios as readonly string[]}
                value={currentAspectRatio}
                onChange={setAspectRatio}
                columns={choiceColumns(videoModel.aspectRatios.length)}
                accent="video"
            />

            {videoModel.supportsFixedLens ? (
                <CreatorSettingSwitch
                    label="Fixed lens"
                    description="Keeps the camera still for the whole shot."
                    checked={currentFixedLens}
                    onChange={setFixedLens}
                    accent="video"
                />
            ) : null}

            {videoModel.supportsSound ? (
                <CreatorSettingSwitch
                    label="AI sound effects"
                    description="Adds sound made for the scene."
                    checked={currentSound}
                    onChange={setSound}
                    accent="video"
                />
            ) : ALWAYS_ON_AUDIO_VIDEO_MODELS.has(selectedModel) ? (
                <p className="flex items-start gap-2 rounded-ui-lg border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] px-4 py-3 text-xs leading-5 text-[var(--ui-text-muted)]">
                    <Volume2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ui-accent-video)]" />
                    This model always generates audio. Describe the sound you want in the prompt, or say “no music”.
                </p>
            ) : null}

            <CatalogAdditionalControls
                appearance="panel"
                descriptor={catalogDescriptor}
                handledKeys={CATALOG_HANDLED_KEYS}
                settings={{ mode: currentMode, aspectRatio: currentAspectRatio, sound: currentSound, duration: totalDuration, resolution: currentResolution, fixedLens: currentFixedLens, isMultiShot: currentIsMultiShot, referenceMode: activeReferenceMode, ...additionalSettings.settings }}
                onChange={additionalSettings.onChange}
            />
        </div>
    );

    const resultActionClass = 'ui-button ui-button-secondary ui-focus-ring';
    const canvasFooter = outputVideo ? (
        <div className="flex flex-wrap items-center gap-2">
            {latestGenerationId ? (
                latestIsPublic ? (
                    <>
                        <PublicShareButton
                            generationId={latestGenerationId}
                            viewerIsOwner
                            title={shareTitle}
                            description={primarySharePrompt}
                            sourceSurface="create-video"
                            accessToken={session?.access_token ?? null}
                            className={resultActionClass}
                        />
                        {publicResultPath ? (
                            <Link href={publicResultPath} className={resultActionClass}>
                                Open public page
                            </Link>
                        ) : null}
                    </>
                ) : (
                    <button
                        type="button"
                        onClick={() => void openPublishModal()}
                        disabled={isPreparingPublish}
                        className="ui-button ui-button-primary ui-focus-ring disabled:cursor-wait disabled:opacity-70"
                    >
                        {isPreparingPublish ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
                        Publish & share
                    </button>
                )
            ) : null}
            <a
                href={resolvedOutputVideo?.outputUrl === outputVideo ? resolvedOutputVideo.url : outputVideo}
                download="generated_video.mp4"
                target="_blank"
                rel="noopener noreferrer"
                className={resultActionClass}
            >
                <Download className="h-4 w-4" />
                Download video
            </a>
            <button
                type="button"
                onClick={() => {
                    setOutputVideo(null);
                    setLatestGenerationId(null);
                    setLatestIsPublic(false);
                    setPublishedMeta(null);
                }}
                className="ui-button ui-button-ghost ui-focus-ring"
            >
                Start another run
            </button>
        </div>
    ) : isGenerating && generationTiming ? (
        <StudioGenerationStatus
            accent="rose"
            timing={generationTiming}
            nowMs={nowMs}
        />
    ) : null;

    // The column's cards: the references the run can carry, each a row with its name,
    // its @handle and Insert, as on the image creator.
    const cardHeadingClass = 'text-xs font-bold text-[var(--ui-text-muted)]';
    const cardCountClass = 'text-xs font-bold tabular-nums text-[var(--ui-text-faint)]';
    const rowClass = 'flex items-start gap-3 rounded-ui-lg border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-2.5';
    const nameFieldClass = 'min-w-0 flex-1 rounded-ui-sm border border-transparent bg-transparent px-2 py-1.5 text-sm font-semibold text-[var(--ui-text-primary)] outline-none transition-colors hover:border-[var(--ui-border-default)] focus:border-[var(--ui-accent-video)]/50 focus:bg-[var(--ui-surface-2)]';
    const chipButtonClass = 'ui-focus-ring inline-flex min-h-9 shrink-0 items-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-3 text-xs font-semibold text-[var(--ui-text-primary)] transition-colors hover:bg-[var(--ui-surface-3)] disabled:cursor-not-allowed disabled:opacity-50';
    const addTileClass = (dragging: boolean) => `flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-full border border-dashed px-4 text-sm font-semibold transition-colors duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--ui-focus)]/55 has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-[var(--ui-bg-app)] ${dragging
        ? 'border-[var(--ui-accent-video)] text-[var(--ui-text-primary)]'
        : 'border-[var(--ui-accent-video)]/35 bg-[var(--ui-accent-video)]/5 text-[var(--ui-text-secondary)] hover:border-[var(--ui-accent-video)]/60 hover:text-[var(--ui-text-primary)]'}`;
    const frameTileClass = (dragging: boolean) => `flex h-[140px] w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-ui-xl border border-dashed text-xs font-semibold transition-colors duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--ui-focus)]/55 has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-[var(--ui-bg-app)] ${dragging
        ? 'border-[var(--ui-accent-video)] bg-[var(--ui-accent-video)]/10 text-[var(--ui-text-primary)]'
        : 'border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] text-[var(--ui-text-muted)] hover:border-[var(--ui-accent-video)]/50 hover:text-[var(--ui-text-secondary)]'}`;
    const standbyCardClass = 'rounded-ui-2xl border border-amber-500/20 bg-amber-500/10 p-4';

    const mentionPanel = (
        title: string,
        hint: string,
        query: string,
        suggestions: typeof mentionSuggestions,
        onInsert: (handle: string) => void,
    ) => (
        <div role="group" aria-label={title} className="rounded-ui-xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-[min(50%_-_0.75rem,10rem)] flex-1">
                    <p className="ui-kicker">{title}</p>
                    <p className="mt-1 text-sm text-[var(--ui-text-muted)]">{hint}</p>
                </div>
                {query ? (
                    <StudioElementHandle
                        handle={`@${query}`}
                        className="rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-3 py-1 text-xs font-semibold text-[var(--ui-text-secondary)]"
                    />
                ) : null}
            </div>
            {suggestions.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                    {suggestions.map((candidate) => (
                        <StudioElementChip
                            key={`${candidate.kind}-${candidate.id}`}
                            displayName={candidate.displayName}
                            handle={candidate.handle}
                            handleClassName={candidate.kind === 'video' ? 'text-emerald-300' : 'text-sky-300'}
                            onInsert={() => onInsert(candidate.handle)}
                        />
                    ))}
                </div>
            ) : null}
        </div>
    );

    return (
        <div className="ui-page ui-page-ambient min-h-screen py-4 text-[var(--ui-text-primary)] sm:py-6 font-[family-name:var(--font-geist-sans)]">
            <CreatorColumnLayout
                title="Create video"
                column={
                    <>
                        <CreatorToolTabs currentToolId="video" />

                        <div className="flex items-start gap-2">
                            <div className="relative min-w-0 flex-1" ref={modelDropdownRef}>
                                <CreatorModelChip
                                    name={videoModel.displayName}
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
                                    searchLabel="Search video models"
                                    searchPlaceholder="Search video models..."
                                    resultListLabel="Video models"
                                    resultCount={filteredVideoModelOptions.length}
                                    accent="rose"
                                >
                                    {filteredVideoModelOptions.map((modelOption) => {
                                        const isActive = selectedModel === modelOption.id;
                                        const modelOptionDurationRange = getVideoDurationRange(modelOption.id as VideoModelId);

                                        return (
                                            <button
                                                key={modelOption.id}
                                                type="button"
                                                role="option"
                                                aria-selected={isActive}
                                                onClick={() => handleSelectModel(modelOption.id as VideoModelId)}
                                                className={`w-full text-left px-5 py-4 flex items-center gap-3 transition-all ${isActive ? 'bg-white/5' : 'hover:bg-white/[0.03]'}`}
                                            >
                                                <div className="flex-1 min-w-0">
                                                    <span className={`text-sm font-bold ${isActive ? 'text-white' : 'text-zinc-300'}`}>
                                                        {modelOption.displayName}
                                                    </span>
                                                    <p className="text-xs text-zinc-500 mt-0.5">{modelOption.description}</p>
                                                    <div className="flex flex-wrap gap-1.5 mt-2">
                                                        {modelOption.supportsMultiShot && (
                                                            <span className="rounded-full border border-[#ff7a59]/20 bg-[#ff7a59]/10 px-2 py-0.5 text-[10px] text-[#ffb09c]">
                                                                Multi-shot
                                                            </span>
                                                        )}
                                                        {modelOption.supportsSound && (
                                                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                                                                Sound
                                                            </span>
                                                        )}
                                                        {modelOption.supportsFixedLens && (
                                                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20">
                                                                Fixed Lens
                                                            </span>
                                                        )}
                                                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-500 border border-white/5">
                                                            {modelOptionDurationRange
                                                                ? `${modelOptionDurationRange.min}-${modelOptionDurationRange.max}s`
                                                                : (modelOption.durations.length > 1
                                                                    ? `${modelOption.durations.join('/')}s`
                                                                    : `${modelOption.durations[0]}s fixed`)}
                                                        </span>
                                                    </div>
                                                </div>
                                                {isActive && <Check className="h-4 w-4 shrink-0 text-[#ff9a80]" />}
                                            </button>
                                        );
                                    })}
                                </StudioModelPicker>
                            </div>
                            <CreatorPhoneBalance credits={userCredits} />
                        </div>

                        <AnimatePresence>
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
                                            remixVideoUrl ? (
                                                <button
                                                    type="button"
                                                    onClick={() => setIsPreviewModalOpen(true)}
                                                    className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.08] hover:text-white"
                                                >
                                                    <Play className="h-4 w-4" />
                                                    View original
                                                </button>
                                            ) : undefined
                                        }
                                    />
                                </motion.div>
                            )}
                            {modelNotice ? (
                                <motion.div key="model-notice" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}>
                                    <StudioModelNotice
                                        description={modelNotice}
                                        onDismiss={catalogProblem ? undefined : () => setCatalogNotice(null)}
                                    />
                                </motion.div>
                            ) : null}
                        </AnimatePresence>

                        {videoModel.supportsMultiShot ? (
                            <CreatorSettingChoices
                                label="Shot mode"
                                labelHidden
                                options={SHOT_MODES}
                                optionLabel={(value) => (value === 'multi' ? 'Multi-shot' : 'Single shot')}
                                value={currentIsMultiShot ? 'multi' : 'single'}
                                onChange={(value) => setIsMultiShot(value === 'multi')}
                                columns={2}
                                accent="video"
                            />
                        ) : null}

                        {!currentIsMultiShot ? (
                            <>
                                <div className="rounded-ui-2xl border border-[var(--ui-accent-video)]/20 bg-[var(--ui-surface-1)] transition-colors duration-150 focus-within:border-[var(--ui-accent-video)]/60">
                                    <label htmlFor="create-video-prompt" className="ui-kicker block px-4 pt-4">
                                        Prompt
                                    </label>
                                    <textarea
                                        id="create-video-prompt"
                                        ref={promptTextareaRef}
                                        value={prompt}
                                        onChange={(event) => handlePromptChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
                                        onClick={syncPromptCaretState}
                                        onKeyUp={syncPromptCaretState}
                                        placeholder={`Describe the ${videoModel.displayName} scene in rich cinematic detail...`}
                                        maxLength={GENERATION_PROMPT_MAX_LENGTH}
                                        aria-invalid={promptMeter.state === 'over' || undefined}
                                        className="block min-h-[176px] w-full resize-y bg-transparent px-4 pb-2 pt-2 text-sm leading-6 text-[var(--ui-text-primary)] outline-none placeholder:text-[var(--ui-text-faint)]"
                                    />
                                    <div className="flex items-center justify-between gap-3 px-4 pb-3 text-xs">
                                        <PromptLengthCounter meter={promptMeter} />
                                        {staleElementMentions.length > 0 ? (
                                            <span className="min-w-0 text-right text-rose-300">
                                                Unknown element mention{staleElementMentions.length > 1 ? 's' : ''}:{' '}
                                                <StudioElementHandleList handles={staleElementMentions} />
                                            </span>
                                        ) : standbyElementMentions.length > 0 ? (
                                            // One line at a time, in the order Generate refuses a prompt.
                                            <span className="min-w-0 text-right text-amber-300">
                                                On standby here:{' '}
                                                <StudioElementHandleList handles={standbyElementMentions} />
                                            </span>
                                        ) : null}
                                    </div>
                                </div>

                                {activeMentionQuery
                                    ? mentionPanel(
                                        'Insert reference',
                                        mentionSuggestions.length > 0 ? 'Pick a reference to insert its @mention.' : 'No matching references yet.',
                                        activeMentionQuery.query,
                                        mentionSuggestions,
                                        handleInsertPromptHandle,
                                    )
                                    : null}

                                <EnhancePromptButton
                                    variant="toolbar"
                                    leading={<CreatorTemplatesTile />}
                                    prompt={prompt}
                                    onEnhanced={(text, result) => {
                                        setPrompt(text);
                                        setPromptQualityWarnings(result?.warnings ?? []);
                                        setActiveMentionQuery(null);
                                        requestAnimationFrame(() => updateMentionState(text));
                                    }}
                                    onCreditsUpdate={updateCredits}
                                    medium="video"
                                    selectedModel={selectedModel}
                                    helperText={
                                        activeReferenceMode === 'elements' && runElements.length > 0
                                            ? 'Reusable references keep their @handles. This enhances the scene while preserving those identities.'
                                            : undefined
                                    }
                                    context={buildSinglePromptQualityContext()}
                                    prepareContext={prepareSinglePromptEnhancerContext}
                                    disabled={isGenerating}
                                    showWarnings={false}
                                />
                                <PromptQualityWarnings warnings={promptQualityWarnings} />
                            </>
                        ) : (
                            <div className="flex flex-col gap-3">
                                {multiPrompts.map((shot, index) => (
                                    <div role="group"
                                        key={shot.id}
                                        aria-labelledby={`create-video-shot-${shot.id}`}
                                        className="rounded-ui-2xl border border-[var(--ui-accent-video)]/20 bg-[var(--ui-surface-1)] p-4 transition-colors duration-150 focus-within:border-[var(--ui-accent-video)]/60"
                                    >
                                        <div className="mb-2 flex items-center justify-between gap-3">
                                            <h2 id={`create-video-shot-${shot.id}`} className="ui-kicker">Shot {index + 1}</h2>
                                            {multiPrompts.length > 1 ? (
                                                <IconButton label={`Remove shot ${index + 1}`} icon={Trash2} onClick={() => removeShot(shot.id)} className="-my-2 -mr-2" />
                                            ) : null}
                                        </div>
                                        <EnhancePromptButton
                                            prompt={shot.prompt}
                                            onEnhanced={(text, result) => {
                                                updateShot(shot.id, 'prompt', text);
                                                setMultiPromptQualityWarnings((current) => ({
                                                    ...current,
                                                    [shot.id]: result?.warnings ?? [],
                                                }));
                                            }}
                                            onCreditsUpdate={updateCredits}
                                            medium="video"
                                            selectedModel={selectedModel}
                                            context={buildShotPromptQualityContext(shot, index)}
                                            disabled={isGenerating}
                                            showWarnings={false}
                                        />
                                        <PromptQualityWarnings warnings={multiPromptQualityWarnings[shot.id] ?? []} />
                                        <textarea
                                            ref={(element) => {
                                                multiShotTextareaRefs.current[shot.id] = element;
                                            }}
                                            value={shot.prompt}
                                            onChange={(event) => handleShotPromptChange(shot.id, event.target.value, event.target.selectionStart ?? event.target.value.length)}
                                            onFocus={() => {
                                                setFocusedShotId(shot.id);
                                                updateShotMentionState(shot.id, shot.prompt);
                                            }}
                                            onClick={() => syncShotPromptCaretState(shot)}
                                            onKeyUp={() => syncShotPromptCaretState(shot)}
                                            placeholder={`Describe shot ${index + 1}...`}
                                            maxLength={GENERATION_PROMPT_MAX_LENGTH}
                                            aria-label={`Shot ${index + 1} prompt`}
                                            aria-invalid={shotMeter(shot.prompt).state === 'over' || undefined}
                                            className="mb-3 block min-h-[100px] w-full resize-y rounded-ui-lg border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-3 text-sm leading-6 text-[var(--ui-text-primary)] outline-none transition-colors placeholder:text-[var(--ui-text-faint)] focus:border-[var(--ui-accent-video)]/50"
                                        />
                                        {activeShotMentionQuery?.shotId === shot.id && shotPromptsTakeMentions ? (
                                            <div className="mb-3">
                                                {mentionPanel(
                                                    shotMentionPanelCopy.title,
                                                    shotMentionSuggestions.length > 0 ? shotMentionPanelCopy.pick : shotMentionPanelCopy.none,
                                                    activeShotMentionQuery.query,
                                                    shotMentionSuggestions,
                                                    (handle) => handleInsertShotHandle(shot.id, handle),
                                                )}
                                            </div>
                                        ) : null}
                                        <div className="flex items-center gap-3">
                                            <label htmlFor={`create-video-shot-duration-${shot.id}`} className="text-xs font-bold text-[var(--ui-text-muted)]">
                                                Duration
                                            </label>
                                            <input
                                                id={`create-video-shot-duration-${shot.id}`}
                                                type="range"
                                                min="1"
                                                max="12"
                                                step="1"
                                                value={shot.duration}
                                                onChange={(event) => updateShot(shot.id, 'duration', parseInt(event.target.value))}
                                                className="ui-focus-ring w-32 accent-[var(--ui-accent-video)]"
                                            />
                                            <span className="text-xs font-bold tabular-nums text-[var(--ui-text-primary)]">{shot.duration}s</span>
                                            {/* The shot's own limit, which Kling 3.0 and Kling O3 set far below the prompt's. */}
                                            <PromptLengthCounter meter={shotMeter(shot.prompt)} className="ml-auto text-xs" />
                                        </div>
                                    </div>
                                ))}

                                <p className={`px-1 text-xs ${multiShotOverLength ? 'text-rose-300' : 'text-[var(--ui-text-faint)]'}`}>
                                    {`${multiPrompts.length}${multiShotMaxShots === null ? '' : ` of ${multiShotMaxShots}`} shot${multiPrompts.length === 1 && multiShotMaxShots === null ? '' : 's'} · ${totalDuration}s in total${multiShotMaxTotalSeconds === null ? '' : `, up to ${multiShotMaxTotalSeconds}s`}${multiShotOverLength ? '. Shorten a shot to generate.' : ''}`}
                                </p>
                                <button
                                    type="button"
                                    onClick={addShot}
                                    disabled={!canAddShot}
                                    className="ui-focus-ring flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-dashed border-[var(--ui-accent-video)]/35 bg-[var(--ui-accent-video)]/5 px-4 text-sm font-semibold text-[var(--ui-text-secondary)] transition-colors hover:border-[var(--ui-accent-video)]/60 hover:text-[var(--ui-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <Plus className="h-4 w-4 text-[var(--ui-accent-video)]" /> Add New Shot
                                </button>
                            </div>
                        )}

                        {!currentIsMultiShot && canUseVideoElements && affordances.framesExcludeReferences && (
                            <div className="rounded-ui-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] p-4">
                                <div className="flex items-start justify-between gap-3">
                                    <h2 className="text-sm font-semibold text-[var(--ui-text-primary)]">Frames or references</h2>
                                    <span className={cardCountClass}>{videoElementSupport.maxElements} references max</span>
                                </div>
                                <p className="mt-1 text-sm text-[var(--ui-text-muted)]">
                                    {framesAndReferencesConflict
                                        ? `${videoModel.displayName} cannot combine frames with references, and this draft holds both. Clear one — as it stands the run will use your references and ignore the frames.`
                                        : framesLockedByReferences
                                            ? `${videoModel.displayName} cannot combine frames with references. Clear your references to define a start or end frame instead.`
                                            : referencesLockedByFrames
                                                ? `${videoModel.displayName} cannot combine references with frames. Clear your frames to use reusable references instead.`
                                                : `${videoModel.displayName} takes either frames or references in a single run. Attach one and the other locks until you clear it.`}
                                </p>
                            </div>
                        )}

                        {supportsNamedSubjects && (
                            <div className="ui-card p-4">
                                <KlingSubjectsEditor
                                    subjects={klingSubjects}
                                    limits={affordances.subjects}
                                    disabled={isGenerating}
                                    onChange={commitKlingSubjects}
                                    onRename={handleKlingSubjectRename}
                                    onRefusedFiles={setPickNotice}
                                />
                            </div>
                        )}

                        {showKlingVideoElementEditor && (
                            <div role="group" aria-labelledby="create-video-kling-elements" className="ui-card p-4">
                                <div className="mb-1 flex items-center justify-between gap-3">
                                    <h2 id="create-video-kling-elements" className={cardHeadingClass}>Kling video elements</h2>
                                    <span className={cardCountClass}>{klingVideoElements.length}/{KLING_VIDEO_ELEMENT_LIMIT}</span>
                                </div>
                                <p className="mb-3 text-xs text-[var(--ui-text-faint)]">
                                    Named clips. Type @ in the prompt or a shot prompt to use one by its name.
                                </p>

                                <input
                                    ref={klingVideoInputRef}
                                    type="file"
                                    accept="video/mp4,video/quicktime,.mp4,.mov"
                                    multiple
                                    onChange={handleKlingVideoElementUpload}
                                    className="hidden"
                                />

                                {klingVideoElements.length > 0 ? (
                                    <ul className="mb-3 space-y-2">
                                        {klingVideoElements.map((element) => (
                                            <li key={element.id} className={rowClass}>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        const src = element.previewUrl || element.providerUrl;
                                                        if (src) setUploadPreview({ type: 'video', src, alt: element.displayName, title: element.displayName });
                                                    }}
                                                    aria-label={`Preview ${element.displayName}`}
                                                    className="ui-focus-ring relative h-16 w-24 shrink-0 overflow-hidden rounded-ui-md border border-[var(--ui-border-default)] bg-black"
                                                >
                                                    <InlineMediaVideo
                                                        src={element.previewUrl || element.providerUrl || undefined}
                                                        className="pointer-events-none h-full w-full object-cover"
                                                        muted
                                                        playsInline
                                                        preload="metadata"
                                                    />
                                                    <Play aria-hidden className="absolute bottom-1 right-1 h-3.5 w-3.5 text-white/90" />
                                                </button>
                                                <div className="min-w-0 flex-1 space-y-1">
                                                    <div className="flex items-center gap-1">
                                                        <input
                                                            type="text"
                                                            value={klingVideoNames.drafts[element.id] ?? element.displayName}
                                                            onChange={(event) => handleKlingVideoDraftChange(element.id, event.target.value)}
                                                            onBlur={() => void commitKlingVideoDraft(element.id)}
                                                            onKeyDown={(event) => {
                                                                if (event.key === 'Enter') {
                                                                    event.preventDefault();
                                                                    void commitKlingVideoDraft(element.id);
                                                                    event.currentTarget.blur();
                                                                }

                                                                if (event.key === 'Escape') {
                                                                    klingVideoNames.dropDraft(element.id);
                                                                    event.currentTarget.blur();
                                                                }
                                                            }}
                                                            aria-label={`Name of ${element.displayName}`}
                                                            placeholder="Rename video element"
                                                            className={nameFieldClass}
                                                        />
                                                        <IconButton
                                                            label={`Remove ${element.displayName}`}
                                                            icon={X}
                                                            onClick={() => void handleRemoveKlingVideoElement(element.id)}
                                                            className="shrink-0"
                                                        />
                                                    </div>
                                                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-2">
                                                        <StudioElementHandle handle={element.handle} className="text-xs font-semibold text-emerald-300" />
                                                        <div className="flex flex-wrap items-center gap-1.5">
                                                            <button
                                                                type="button"
                                                                onClick={() => {
                                                                    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                                                                        void navigator.clipboard.writeText(element.handle);
                                                                    }
                                                                }}
                                                                className={chipButtonClass}
                                                            >
                                                                Copy
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={() => handleInsertKlingVideoHandle(element.handle)}
                                                                className={chipButtonClass}
                                                            >
                                                                Insert
                                                            </button>
                                                        </div>
                                                    </div>
                                                    <p className="px-2 text-xs text-[var(--ui-text-faint)]">
                                                        {typeof element.durationSeconds === 'number' ? `${element.durationSeconds.toFixed(1)}s clip` : 'MP4 or MOV, 50MB max'}
                                                    </p>
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                ) : null}

                                {klingVideoElements.length < KLING_VIDEO_ELEMENT_LIMIT ? (
                                    <button
                                        type="button"
                                        onClick={() => klingVideoInputRef.current?.click()}
                                        onDragOver={(event) => { event.preventDefault(); setIsDraggingKlingVideos(true); }}
                                        onDragLeave={(event) => { event.preventDefault(); setIsDraggingKlingVideos(false); }}
                                        onDrop={handleKlingVideoElementDrop}
                                        className={`ui-focus-ring w-full ${addTileClass(isDraggingKlingVideos)}`}
                                    >
                                        <Video className="h-4 w-4 text-[var(--ui-accent-video)]" />
                                        {isDraggingKlingVideos ? 'Drop Kling video elements here' : 'Add video elements'}
                                        <span className="sr-only">, MP4 or MOV clips, one per element, 50MB max</span>
                                    </button>
                                ) : (
                                    <p className="text-sm text-[var(--ui-text-muted)]">
                                        Kling video elements are capped at {KLING_VIDEO_ELEMENT_LIMIT} clips in this version.
                                    </p>
                                )}
                            </div>
                        )}

                        {(showSavedElementNotice || savedClipAndTrackNotice) && (
                            <div className={standbyCardClass}>
                                <p className="text-sm font-semibold text-[var(--ui-text-primary)]">Saved references are on standby</p>
                                {showSavedElementNotice ? (
                                    <p className="mt-2 text-sm leading-6 text-[var(--ui-text-secondary)]">
                                        {`Your ${elements.length} saved image reference${elements.length === 1 ? ' remains' : 's remain'} available. `}
                                        {videoElementSupport.reason || `${videoModel.displayName} cannot use reusable references with the current settings.`}
                                        {' '}Use start / end frames for this run, or choose a supported single-shot mode to use reusable references.
                                    </p>
                                ) : null}
                                {savedClipAndTrackNotice ? (
                                    <p className="mt-2 text-sm leading-6 text-[var(--ui-text-secondary)]">{savedClipAndTrackNotice}</p>
                                ) : null}
                                {/* The model has no card for these, so they can be taken off here. */}
                                <ul aria-label="References on standby" className="mt-3 flex flex-wrap gap-2">
                                    {standbyReferences.map((reference) => (
                                        <li
                                            key={`${reference.kind}-${reference.id}`}
                                            className="inline-flex min-h-9 min-w-0 max-w-full items-center gap-1 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] py-0.5 pl-3 pr-0.5 text-xs text-[var(--ui-text-secondary)]"
                                        >
                                            <span className="min-w-0 truncate">{reference.displayName}</span>
                                            <button
                                                type="button"
                                                onClick={reference.onRemove}
                                                aria-label={`Remove ${reference.displayName}`}
                                                className="ui-focus-ring inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--ui-text-muted)] transition-colors hover:bg-rose-500/20 hover:text-rose-100"
                                            >
                                                <X className="h-3.5 w-3.5" />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {showMultiShotElementNotice && (
                            <div className={standbyCardClass}>
                                <p className="text-sm font-semibold text-[var(--ui-text-primary)]">Reusable references are paused in multi-shot</p>
                                <p className="mt-2 text-sm leading-6 text-[var(--ui-text-secondary)]">
                                    Your saved references stay available, but multi-shot runs use shot prompts only in v1. Switch back to single-shot to reuse them.
                                </p>
                            </div>
                        )}

                        {showFramesEditor && (
                            <div role="group" aria-labelledby="create-video-frames" className="ui-card p-4">
                                <h2 id="create-video-frames" className={`mb-3 ${cardHeadingClass}`}>Frames</h2>
                                <div
                                    aria-disabled={framesLockedByReferences}
                                    className={`grid gap-3 ${!currentIsMultiShot && activeSupportsEndFrame ? 'grid-cols-2' : ''} ${framesLockedByReferences ? 'pointer-events-none opacity-40' : ''}`}
                                >
                                    <div>
                                        <h3 className="mb-2 flex items-baseline justify-between gap-2 text-xs font-semibold text-[var(--ui-text-secondary)]">
                                            Start frame
                                            <span className="text-xs font-normal text-[var(--ui-text-faint)]">{selectedModel === 'hailuo-2.3' ? 'required' : 'optional'}</span>
                                        </h3>
                                        {startImageUrl ? (
                                            <div className="h-[140px]">
                                                <StudioUploadedMediaPreview
                                                    mediaType="image"
                                                    src={startImageUrl}
                                                    alt="Start frame"
                                                    fit="cover"
                                                    previewHint="Preview frame"
                                                    onPreview={() => setUploadPreview({
                                                        type: 'image',
                                                        src: startImageUrl,
                                                        alt: 'Start frame',
                                                        title: 'Start Frame',
                                                    })}
                                                    onReplace={() => startImageInputRef.current?.click()}
                                                    onRemove={() => void clearImage('start')}
                                                />
                                                <input
                                                    ref={startImageInputRef}
                                                    id="video-start-frame-input"
                                                    type="file"
                                                    accept="image/*"
                                                    onChange={(event) => handleImageUpload(event, 'start')}
                                                    className="hidden"
                                                />
                                            </div>
                                        ) : (
                                            <label
                                                className={frameTileClass(isDraggingStart)}
                                                onDragOver={(event) => { event.preventDefault(); setIsDraggingStart(true); }}
                                                onDragLeave={(event) => { event.preventDefault(); setIsDraggingStart(false); }}
                                                onDrop={(event) => handleImageDrop(event, 'start')}
                                            >
                                                <ImageIcon className="h-5 w-5" />
                                                Upload Start Frame
                                                <input
                                                    ref={startImageInputRef}
                                                    id="video-start-frame-input"
                                                    type="file"
                                                    accept="image/*"
                                                    onChange={(event) => handleImageUpload(event, 'start')}
                                                    className="sr-only"
                                                />
                                            </label>
                                        )}
                                    </div>

                                    {!currentIsMultiShot && activeSupportsEndFrame && (
                                        <div>
                                            <h3 className="mb-2 flex items-baseline justify-between gap-2 text-xs font-semibold text-[var(--ui-text-secondary)]">
                                                End frame
                                                <span className="text-xs font-normal text-[var(--ui-text-faint)]">optional</span>
                                            </h3>
                                            {endImageUrl ? (
                                                <div className="h-[140px]">
                                                    <StudioUploadedMediaPreview
                                                        mediaType="image"
                                                        src={endImageUrl}
                                                        alt="End frame"
                                                        fit="cover"
                                                        previewHint="Preview frame"
                                                        onPreview={() => setUploadPreview({
                                                            type: 'image',
                                                            src: endImageUrl,
                                                            alt: 'End frame',
                                                            title: 'End Frame',
                                                        })}
                                                        onReplace={() => endImageInputRef.current?.click()}
                                                        onRemove={() => void clearImage('end')}
                                                    />
                                                    <input
                                                        ref={endImageInputRef}
                                                        id="video-end-frame-input"
                                                        type="file"
                                                        accept="image/*"
                                                        onChange={(event) => handleImageUpload(event, 'end')}
                                                        className="hidden"
                                                    />
                                                </div>
                                            ) : (
                                                <label
                                                    className={frameTileClass(isDraggingEnd)}
                                                    onDragOver={(event) => { event.preventDefault(); setIsDraggingEnd(true); }}
                                                    onDragLeave={(event) => { event.preventDefault(); setIsDraggingEnd(false); }}
                                                    onDrop={(event) => handleImageDrop(event, 'end')}
                                                >
                                                    <ImageIcon className="h-5 w-5" />
                                                    Upload End Frame
                                                    <input
                                                        ref={endImageInputRef}
                                                        id="video-end-frame-input"
                                                        type="file"
                                                        accept="image/*"
                                                        onChange={(event) => handleImageUpload(event, 'end')}
                                                        className="sr-only"
                                                    />
                                                </label>
                                            )}
                                        </div>
                                    )}
                                </div>
                                {isGrokVideoModel ? (
                                    <p className="mt-3 rounded-ui-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm leading-6 text-amber-100">
                                        Grok image-to-video accepts one image reference per run.
                                    </p>
                                ) : null}
                                {combinesFrameWithReferences ? (
                                    <p className="mt-3 text-sm leading-6 text-[var(--ui-text-muted)]">
                                        Wan Reference-to-Video can use this first frame together with your reusable images, clips, and voice reference.
                                    </p>
                                ) : null}
                            </div>
                        )}

                        {showElementEditor && (
                            <div role="group"
                                aria-labelledby="create-video-references"
                                aria-disabled={referencesLockedByFrames}
                                className={`ui-card p-4 ${referencesLockedByFrames ? 'pointer-events-none opacity-40' : ''}`}
                            >
                                <div className="mb-1 flex items-center justify-between gap-3">
                                    <h2 id="create-video-references" className={cardHeadingClass}>Reusable image references</h2>
                                    <span className={cardCountClass}>{elements.length}/{videoElementSupport.maxElements}</span>
                                </div>
                                <p className="mb-3 text-xs text-[var(--ui-text-faint)]">Type @ in the prompt to use one by its name.</p>

                                {elements.length > 0 ? (
                                    <ul className="mb-3 space-y-2">
                                        {elements.map((element) => (
                                            <li key={element.id} className={rowClass}>
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
                                                <div className="min-w-0 flex-1 space-y-1">
                                                    <div className="flex items-center gap-1">
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
                                                            aria-label={`Name of ${element.displayName}`}
                                                            placeholder="Rename element"
                                                            className={nameFieldClass}
                                                        />
                                                        <IconButton
                                                            label={`Remove ${element.displayName}`}
                                                            icon={X}
                                                            onClick={() => void handleRemoveElement(element.id)}
                                                            className="shrink-0"
                                                        />
                                                    </div>
                                                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-2">
                                                        <StudioElementHandle handle={element.handle} className="text-xs font-semibold text-sky-300" />
                                                        <button
                                                            type="button"
                                                            onClick={() => handleInsertElementHandle(element.handle)}
                                                            className={chipButtonClass}
                                                        >
                                                            Insert
                                                        </button>
                                                    </div>
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                ) : null}

                                {elements.length < videoElementSupport.maxElements && (
                                    <label
                                        className={addTileClass(isDraggingElements)}
                                        onDragOver={(event) => { event.preventDefault(); setIsDraggingElements(true); }}
                                        onDragLeave={(event) => { event.preventDefault(); setIsDraggingElements(false); }}
                                        onDrop={handleElementDrop}
                                    >
                                        <Plus className="h-4 w-4 text-[var(--ui-accent-video)]" />
                                        {isDraggingElements ? 'Drop reference images here' : 'Add reference images'}
                                        <input
                                            ref={elementInputRef}
                                            type="file"
                                            accept="image/*"
                                            multiple
                                            onChange={handleElementUpload}
                                            className="sr-only"
                                        />
                                    </label>
                                )}
                            </div>
                        )}

                        {supportsMultimodalReferences && !currentIsMultiShot && (
                            <>
                                <div role="group"
                                    aria-labelledby="create-video-clips"
                                    aria-disabled={referencesLockedByFrames}
                                    className={`ui-card p-4 ${referencesLockedByFrames ? 'pointer-events-none opacity-40' : ''}`}
                                >
                                    <div className="mb-1 flex items-start justify-between gap-3">
                                        <h2 id="create-video-clips" className={cardHeadingClass}>{supportsReferenceAudio ? 'Video and audio references' : 'Video references'}</h2>
                                        <span className={cardCountClass}>{isWanVideoModel ? '5 total references max' : `${referenceVideoLimit} video refs max`}</span>
                                    </div>
                                    <p className="mb-3 text-xs text-[var(--ui-text-faint)]">
                                        {supportsReferenceAudio
                                            ? 'Add motion clips or timing and voice guidance alongside your reusable image references.'
                                            : 'Add one motion clip alongside your reusable image references.'}
                                    </p>

                                    <div className="space-y-4">
                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between gap-3">
                                                <h3 className="text-xs font-semibold text-[var(--ui-text-secondary)]">Reference videos</h3>
                                                <button
                                                    type="button"
                                                    onClick={() => referenceVideoInputRef.current?.click()}
                                                    disabled={referenceVideos.length >= referenceVideoLimit}
                                                    className={chipButtonClass}
                                                >
                                                    Add video
                                                </button>
                                            </div>
                                            <input
                                                ref={referenceVideoInputRef}
                                                type="file"
                                                accept="video/*"
                                                multiple
                                                onChange={handleReferenceVideoUpload}
                                                className="hidden"
                                            />
                                            {referenceVideos.length > 0 ? (
                                                <ul className="space-y-2">
                                                    {referenceVideos.map((reference) => (
                                                        <li key={reference.id} className="rounded-ui-lg border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-3">
                                                            <div className="flex items-start justify-between gap-3">
                                                                <div className="min-w-0">
                                                                    <div className="truncate text-sm font-semibold text-[var(--ui-text-primary)]">{reference.displayName}</div>
                                                                    <div className="mt-1 text-xs text-[var(--ui-text-faint)]">
                                                                        {typeof reference.durationSeconds === 'number'
                                                                            ? `${reference.durationSeconds.toFixed(1)}s clip`
                                                                            : 'Duration unavailable'}
                                                                    </div>
                                                                </div>
                                                                <IconButton
                                                                    label={`Remove ${reference.displayName}`}
                                                                    icon={X}
                                                                    onClick={() => void handleRemoveReferenceVideo(reference.id)}
                                                                    className="-my-1 -mr-1 shrink-0"
                                                                />
                                                            </div>
                                                            {reference.previewUrl || reference.providerUrl ? (
                                                                <InlineMediaVideo
                                                                    src={reference.previewUrl || reference.providerUrl || undefined}
                                                                    className="mt-3 h-40 w-full rounded-ui-md border border-[var(--ui-border-subtle)] bg-black object-cover"
                                                                    controls
                                                                    muted
                                                                    playsInline
                                                                />
                                                            ) : null}
                                                        </li>
                                                    ))}
                                                </ul>
                                            ) : (
                                                <p className="rounded-ui-lg border border-dashed border-[var(--ui-border-default)] px-4 py-4 text-sm text-[var(--ui-text-muted)]">
                                                    Add up to {referenceVideoLimit} short clips as motion and framing guidance.
                                                </p>
                                            )}
                                        </div>

                                        {supportsReferenceAudio ? (
                                            <div className="space-y-2">
                                                <div className="flex items-center justify-between gap-3">
                                                    <h3 className="text-xs font-semibold text-[var(--ui-text-secondary)]">Reference audio</h3>
                                                    <button
                                                        type="button"
                                                        onClick={() => referenceAudioInputRef.current?.click()}
                                                        disabled={referenceAudios.length >= referenceAudioLimit}
                                                        className={chipButtonClass}
                                                    >
                                                        Add audio
                                                    </button>
                                                </div>
                                                <input
                                                    ref={referenceAudioInputRef}
                                                    type="file"
                                                    accept="audio/*"
                                                    multiple
                                                    onChange={handleReferenceAudioUpload}
                                                    className="hidden"
                                                />
                                                {referenceAudios.length > 0 ? (
                                                    <ul className="space-y-2">
                                                        {referenceAudios.map((reference) => (
                                                            <li key={reference.id} className="rounded-ui-lg border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-3">
                                                                <div className="flex items-start justify-between gap-3">
                                                                    <div className="min-w-0">
                                                                        <div className="truncate text-sm font-semibold text-[var(--ui-text-primary)]">{reference.displayName}</div>
                                                                        {/* Only the Seedance 2 family prepares assets. On any other model the row says how long the track is. */}
                                                                        {isSeedance2Family ? (
                                                                            <div className="mt-1 text-xs text-[var(--ui-text-faint)]">
                                                                                {reference.seedanceAsset.assetId ? 'Prepared asset available' : 'Uses URL fallback until prepared'}
                                                                            </div>
                                                                        ) : typeof reference.durationSeconds === 'number' ? (
                                                                            <div className="mt-1 text-xs text-[var(--ui-text-faint)]">{`${reference.durationSeconds.toFixed(1)}s track`}</div>
                                                                        ) : null}
                                                                    </div>
                                                                    <IconButton
                                                                        label={`Remove ${reference.displayName}`}
                                                                        icon={X}
                                                                        onClick={() => void handleRemoveReferenceAudio(reference.id)}
                                                                        className="-my-1 -mr-1 shrink-0"
                                                                    />
                                                                </div>
                                                                {reference.providerUrl ? (
                                                                    <RecoverableMediaAudio
                                                                        src={reference.providerUrl}
                                                                        className="mt-3 w-full"
                                                                    />
                                                                ) : reference.previewUrl ? (
                                                                    <RecoverableMediaAudio
                                                                        src={reference.previewUrl}
                                                                        className="mt-3 w-full"
                                                                    />
                                                                ) : null}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                ) : (
                                                    <p className="rounded-ui-lg border border-dashed border-[var(--ui-border-default)] px-4 py-4 text-sm text-[var(--ui-text-muted)]">
                                                        Add up to {referenceAudioLimit} audio clip{referenceAudioLimit === 1 ? '' : 's'} for beat, voice, or dialogue timing guidance.
                                                    </p>
                                                )}
                                            </div>
                                        ) : null}
                                    </div>
                                </div>

                                {isGeminiOmniVideoModel ? (
                                    <div role="group" aria-labelledby="create-video-omni" className="ui-card p-4">
                                        <h2 id="create-video-omni" className={cardHeadingClass}>Prepared Omni references</h2>
                                        <p className="mb-3 mt-1 text-xs text-[var(--ui-text-faint)]">
                                            Add reusable voice and character IDs created with Gemini Omni. Characters count toward the seven-slot media limit; voices do not.
                                        </p>
                                        <div className="space-y-4">
                                            {([
                                                { kind: 'audio' as const, label: 'Voice IDs', value: preparedAudioIdDraft, setValue: setPreparedAudioIdDraft, items: preparedAudioIds },
                                                { kind: 'character' as const, label: 'Character IDs', value: characterIdDraft, setValue: setCharacterIdDraft, items: characterIds },
                                            ]).map((group) => (
                                                <div key={group.kind} className="space-y-2">
                                                    <div className="flex items-center justify-between gap-3">
                                                        <h3 className="text-xs font-semibold text-[var(--ui-text-secondary)]">{group.label}</h3>
                                                        <span className={cardCountClass}>{group.items.length}/3</span>
                                                    </div>
                                                    <div className="flex gap-2">
                                                        <input
                                                            aria-label={`Gemini Omni ${group.kind} ID`}
                                                            value={group.value}
                                                            onChange={(event) => group.setValue(event.target.value)}
                                                            onKeyDown={(event) => {
                                                                if (event.key === 'Enter') {
                                                                    event.preventDefault();
                                                                    addPreparedReferenceId(group.kind);
                                                                }
                                                            }}
                                                            placeholder={group.kind === 'audio' ? 'Paste prepared voice ID' : 'Paste prepared character ID'}
                                                            className="min-h-10 min-w-0 flex-1 rounded-ui-md border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] px-3 text-sm text-[var(--ui-text-primary)] outline-none transition-colors placeholder:text-[var(--ui-text-faint)] focus:border-[var(--ui-accent-video)]/50"
                                                        />
                                                        <button
                                                            type="button"
                                                            onClick={() => addPreparedReferenceId(group.kind)}
                                                            disabled={group.items.length >= 3}
                                                            className="ui-button ui-button-secondary ui-focus-ring disabled:opacity-40"
                                                        >
                                                            Add
                                                        </button>
                                                    </div>
                                                    {group.items.map((id) => (
                                                        <div key={id} className="flex items-center justify-between gap-3 rounded-ui-lg border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] py-1 pl-3 pr-1">
                                                            <code className="truncate text-xs text-[var(--ui-text-secondary)]">{id}</code>
                                                            <IconButton
                                                                label={`Remove ${group.kind} ID ${id}`}
                                                                icon={X}
                                                                onClick={() => group.kind === 'audio'
                                                                    ? setPreparedAudioIds((current) => current.filter((item) => item !== id))
                                                                    : setCharacterIds((current) => current.filter((item) => item !== id))}
                                                                className="shrink-0"
                                                            />
                                                        </div>
                                                    ))}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ) : null}

                                {isSeedance2Family ? (
                                    <div role="group" aria-labelledby="create-video-seedance" className="ui-card p-4">
                                        <div className="mb-1 flex items-start justify-between gap-3">
                                            <h2 id="create-video-seedance" className={cardHeadingClass}>Seedance Assets</h2>
                                            <span className={cardCountClass}>
                                                {[
                                                    ...elements.map((element) => element.seedanceAsset),
                                                    ...referenceVideos.map((reference) => reference.seedanceAsset),
                                                    ...referenceAudios.map((reference) => reference.seedanceAsset),
                                                ].filter((asset) => asset.status === 'active' && asset.assetId).length}/{elements.length + referenceVideos.length + referenceAudios.length} ready
                                            </span>
                                        </div>
                                        <p className="mb-3 text-xs text-[var(--ui-text-faint)]">
                                            Prepare uploaded references into Seedance asset IDs so the next run can prefer the optimized asset instead of the raw URL.
                                        </p>

                                        <div className="space-y-2">
                                            {[...elements.map((element) => ({
                                                id: element.id,
                                                kind: 'image' as const,
                                                title: element.displayName,
                                                assetType: 'Image' as const,
                                                asset: element.seedanceAsset,
                                                onPrepare: () => prepareElementSeedanceAsset(element.id),
                                                onRefresh: () => element.seedanceAsset.assetId ? refreshElementSeedanceAsset(element.id, element.seedanceAsset.assetId) : Promise.resolve(),
                                            })), ...referenceVideos.map((reference) => ({
                                                id: reference.id,
                                                kind: 'video' as const,
                                                title: reference.displayName,
                                                assetType: 'Video' as const,
                                                asset: reference.seedanceAsset,
                                                onPrepare: () => prepareReferenceSeedanceAsset('video', reference.id),
                                                onRefresh: () => reference.seedanceAsset.assetId ? refreshReferenceSeedanceAsset('video', reference.id, reference.seedanceAsset.assetId) : Promise.resolve(),
                                            })), ...referenceAudios.map((reference) => ({
                                                id: reference.id,
                                                kind: 'audio' as const,
                                                title: reference.displayName,
                                                assetType: 'Audio' as const,
                                                asset: reference.seedanceAsset,
                                                onPrepare: () => prepareReferenceSeedanceAsset('audio', reference.id),
                                                onRefresh: () => reference.seedanceAsset.assetId ? refreshReferenceSeedanceAsset('audio', reference.id, reference.seedanceAsset.assetId) : Promise.resolve(),
                                            }))].map((item) => {
                                                const activeKey = createSeedanceAssetKey(item.kind, item.id);
                                                const isBusy = activeSeedanceAssetKey === activeKey;
                                                // A reference name, an asset ID or a provider error can be one
                                                // unbreakable run, so the row's text may break anywhere
                                                // instead of widening the page.
                                                return (
                                                    <div key={activeKey} className="rounded-ui-lg border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-3 [overflow-wrap:anywhere]">
                                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                                            <div className="min-w-0">
                                                                <div className="text-sm font-semibold text-[var(--ui-text-primary)]">{item.title}</div>
                                                                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--ui-text-muted)]">
                                                                    <span>{item.assetType}</span>
                                                                    <span>Status: {getSeedanceAssetStatusLabel(item.asset.status)}</span>
                                                                    <span>Asset ID: {item.asset.assetId || 'none'}</span>
                                                                </div>
                                                            </div>
                                                            <div className="flex flex-wrap gap-2">
                                                                <button
                                                                    type="button"
                                                                    onClick={() => void item.onPrepare().catch((prepareError) => setError(prepareError instanceof Error ? prepareError.message : 'Failed to prepare Seedance asset'))}
                                                                    disabled={isBusy}
                                                                    className={`${chipButtonClass} gap-1.5`}
                                                                >
                                                                    {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                                                                    {item.asset.assetId ? 'Retry prep' : 'Prepare asset'}
                                                                </button>
                                                                {item.asset.assetId ? (
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => void item.onRefresh().catch((refreshError) => setError(refreshError instanceof Error ? refreshError.message : 'Failed to refresh Seedance asset'))}
                                                                        disabled={isBusy}
                                                                        className={chipButtonClass}
                                                                    >
                                                                        Refresh
                                                                    </button>
                                                                ) : null}
                                                            </div>
                                                        </div>
                                                        <div className="mt-3 grid gap-2 text-xs text-[var(--ui-text-faint)]">
                                                            <div className="rounded-ui-md border border-[var(--ui-border-subtle)] px-3 py-2">
                                                                Source: {getSeedanceAssetSourceName(item.asset.sourceUrl) || 'Upload or prepare to capture a source URL'}
                                                            </div>
                                                            <div className="rounded-ui-md border border-[var(--ui-border-subtle)] px-3 py-2">
                                                                Last checked: {item.asset.lastCheckedAt || 'Never'}
                                                            </div>
                                                        </div>
                                                        {item.asset.error ? (
                                                            <div className="mt-3 rounded-ui-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">
                                                                {item.asset.error}
                                                            </div>
                                                        ) : null}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ) : null}
                            </>
                        )}

                        <CreatorColumnBar
                            settingsSummary={settingsSummary}
                            settings={settingsPanel}
                            status={barStatus}
                            action={barAction}
                        />
                    </>
                }
                canvas={
                    <CreatorCanvas
                        title={canvasTitle}
                        subtitle={canvasSubtitle}
                        revealKey={canvasRevealKey}
                        tall={Boolean(outputVideo)}
                        footer={canvasFooter}
                    >
                        {outputVideo ? (
                            <CreatorCanvasMedia key={outputVideo} aspectRatio={runShape?.aspectRatio ?? currentAspectRatio}>
                                <GenerationResultVideo generationId={latestGenerationId} outputUrl={outputVideo} accessToken={session?.access_token} onOriginalResolved={setResolvedOutputVideo} />
                            </CreatorCanvasMedia>
                        ) : isGenerating ? (
                            <CreatorCanvasFrame aspectRatio={runShape?.aspectRatio ?? currentAspectRatio} accent="video" busy>
                                <p className="text-sm font-semibold text-[var(--ui-text-primary)]">Rendering your video</p>
                            </CreatorCanvasFrame>
                        ) : isBackgroundProcessing ? (
                            <div className="w-full max-w-md">
                                <StudioBackgroundProcessingNotice
                                    accent="rose"
                                    label="video"
                                    phaseLabel={backgroundTiming?.phaseLabel ?? null}
                                    timingLabel={backgroundTimingLabel}
                                />
                            </div>
                        ) : (
                            <CreatorCanvasFrame aspectRatio={currentAspectRatio} accent="video">
                                <span className="flex h-12 w-12 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)]">
                                    <Video className="h-5 w-5 text-[var(--ui-text-muted)]" />
                                </span>
                                <p className="text-sm font-semibold text-[var(--ui-text-secondary)]">Your video will appear here</p>
                                <p className="text-xs leading-5 text-[var(--ui-text-faint)]">{emptyCanvasHint}</p>
                            </CreatorCanvasFrame>
                        )}
                    </CreatorCanvas>
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
                defaultTitle={publishDefaults?.generationId === latestGenerationId ? publishDefaults.title : ''}
                creation={publishDefaults?.generationId === latestGenerationId ? publishDefaults.creation : null}
                paywallPrefill={publishDefaults?.generationId === latestGenerationId ? publishDefaults.paywallPrefill : null}
                shareAfterPublish={latestGenerationId ? {
                    title: shareTitle,
                    description: primarySharePrompt,
                    sourceSurface: 'create-video',
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
                mediaType="video"
                src={remixVideoUrl}
                alt="Original creation"
                title="Original Creation"
                footer={
                    <div className="flex flex-col gap-2">
                        <div className="text-xs font-bold uppercase tracking-wider text-zinc-500">Prompt</div>
                        <p className="max-h-32 overflow-y-auto whitespace-pre-wrap pr-2 text-sm leading-relaxed text-zinc-300 [overflow-wrap:anywhere] custom-scrollbar">
                            {isMultiShot ? multiPrompts.map((shot) => shot.prompt).join(' | ') : prompt || 'No prompt available'}
                        </p>
                    </div>
                }
            />
        </div>
    );
}
