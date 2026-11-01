'use client';

import RecoverableMediaAudio from '@/components/RecoverableMediaAudio';
import InlineMediaVideo from '@/components/InlineMediaVideo';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import GenerationResultVideo from '@/components/GenerationResultVideo';
import { Sparkles, Loader2, X, ImagePlus, Video, Plus, Trash2, Volume2, Play } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import {
    CREATOR_REFERENCE_CHIP_CLASS,
    CreatorAddTile,
    CreatorBackgroundRunLine,
    CreatorBalanceNote,
    CreatorBarAction,
    CreatorCanvas,
    CreatorCanvasFrame,
    CreatorCanvasMedia,
    parseAspectRatio,
    CreatorCanvasStage,
    CreatorColumnBar,
    CreatorColumnLayout,
    CreatorFitNotice,
    CreatorInputsCard,
    CreatorLowBalanceNote,
    CreatorLowBalanceNotice,
    CreatorMakeImageInstead,
    CreatorMentionPanel,
    CreatorModelChip,
    CreatorOverBalanceLegend,
    CreatorPendingStartNotice,
    CreatorReferenceStrip,
    CreatorReferenceTile,
    CreatorReplaceButton,
    CreatorRunFailed,
    CreatorRunFailedLine,
    CreatorRunWaitLines,
    CreatorSettingChoices,
    CreatorSettingsFootNote,
    CreatorSettingSwitch,
    CreatorTemplatesTile,
    CreatorToolTabs,
    CreatorTopUpNotice,
    CreatorUploadSlot,
    CreatorVisitorNote,
    CREATOR_VISITOR_CANVAS_HINT,
    CREATOR_BAR_PRIMARY_CLASS,
    CREATOR_NOTE_LINK_CLASS,
    aspectRatioMark,
    creatorAddButtonClass,
    creatorCanvasChip,
    creditsWords,
    describeRunFailure,
    smallestCreditPackLabel,
} from '@/components/CreatorColumn';
import { CreatorEmptyCanvas, CreatorStartPostsStrip, CreatorWhileYouWait, type StartPostsSource } from '@/components/CreatorStartPosts';
import { useConfirmation } from '@/components/useConfirmation';
import CreatorModelPickerRows, { CreatorModelPickerFoot, type PickerModelRow } from '@/components/CreatorModelPickerRows';
import CreatorSignUpSheet, { type CreatorSignUpReason } from '@/components/CreatorSignUpSheet';
import CreatorWelcomeCard, { type CreatorWelcome } from '@/components/CreatorWelcomeCard';
import { VISITOR_DRAFT_OWNER } from '@/lib/creator-visitor-draft';
import { isRetryableProviderFailure } from '@/lib/provider-failure-messages';
import { useCreatorDraftOwner, useCreatorForm, type CreatorDraftOwner, type CreatorForm } from '@/lib/use-creator-draft-owner';
import { getAccentClasses, IconButton } from '@/components/DesignSystem';
import { videoRunShortSummary, videoSettingsSummary } from '../../../ugc-mobile/lib/creator-settings-summary/creator-settings-summary';
import {
    cheapestCost,
    fitRemixToBalance,
    longestLengthWithin,
    referenceKeepWords,
    samePriceForEach,
} from '../../../ugc-mobile/lib/creator-run-fit/creator-run-fit';
import {
    fitVideoFormToModel,
    sameVideoFormSettings,
    takesSameVideoInputs,
    videoLengthsBelow,
    videoRunInputTally,
    videoRunOnModel,
    type VideoFormHeld,
    type VideoFormSettings,
    type VideoRunOnModel,
} from '@/lib/creator-video-candidates';
import {
    listedFromQuote,
    NO_SETTINGS_VARIANTS,
    optionPricesOf,
    readyCost,
    settingsVariants,
    smallestOverBalance,
    useQuotePrices,
} from '@/lib/use-quote-prices';
import {
    StudioBackgroundProcessingNotice,
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
} from '@/components/CreatorStudio';
import StudioModelPicker from '@/components/StudioModelPicker';
import CatalogAdditionalControls, { catalogChoiceDefault, useAdditionalCatalogSettings } from '@/components/CatalogAdditionalControls';
import { CreatorDoneLayout, CreatorDownloadButton, CreatorPostedNext, CreatorPublishPanel, useCreatorPublish } from '@/components/CreatorPublish';
import { creatorCanvasFollowsRun, creatorCanvasPhase, creatorCanvasSettledStatus, creatorCanvasTitle } from '@/lib/creator-canvas-phase';
import EnhancePromptButton from '@/components/EnhancePromptButton';
import { ALWAYS_ON_AUDIO_VIDEO_MODELS, clampVideoDuration, getDefaultVideoDuration, getVideoDurationRange, IMAGE_MODELS, isValidVideoDuration, VIDEO_MODELS, VideoModelId, videoLengthOptions } from '@/lib/client-generation-models';
import { getVideoInputAffordances, getVideoRunAffordances } from '@/lib/generation-model-affordances';
import { heldLengthNote, lengthReading, planVideoRunInputs, type VideoRunInput } from '@/lib/creator-run-inputs';
import {
    framesLeftOutLine,
    planVideoInputSwitch,
    VIDEO_INPUT_SIDES,
    videoInputSides,
    videoInputsHint,
    videoInputView,
    type HeldVideoInputs,
    type VideoFrame,
    type VideoInputSide,
    type VideoInputSwitch,
} from '@/lib/creator-video-inputs';
import type { CatalogGenerationInputAsset, CatalogGenerationRequestPayload } from '@/lib/generation-model-adapters';
import type { CatalogPrimitive, GenerationModelDescriptor } from '@/lib/generation-model-catalog';
import {
    clearPendingWebStart,
    getCatalogDescriptorDefaultSettings,
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
import { catalogInputTooShort, catalogRunQuoteInput, catalogSettingsAtControlDefaults, GENERATION_PROMPT_MAX_LENGTH } from '../../../ugc-mobile/lib/model-catalog/protocol';
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
import { keepsPromptOverSavedDraft } from '@/lib/creator-draft-prompt';
import { BACKGROUND_PROCESSING_ERROR, getBackgroundProcessingCopy } from '@/lib/generation-feedback';
import { createGenerationIdempotencyKey } from '@/lib/generation-idempotency-client';
import {
    announceGenerationStarted,
    fetchCreatorActiveRun,
    fetchGenerationStatusWithRetry,
    isGenerationStatusAbortError,
    waitForNextGenerationStatusPoll,
    type GenerationStatusResponse,
    useAnnounceRunOnPage,
} from '@/lib/generation-status-client';
import {
    assignElementHandles,
    assignRemixElementHandles,
    assignSubjectHandles,
    createElementHandleReplacementMap,
    createElementId,
    extractMentionedHandles,
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
import { openingCost, openingSetting, type CreatorOpening } from '@/lib/creator-opening';
import { reloadBroughtBackThisBuild, reloadForNewerBuild, useDeploymentRefresh } from '@/lib/use-deployment-refresh';
import { useNameDrafts } from '@/lib/use-name-drafts';
import { useTicker } from '@/lib/use-ticker';
import { useTypedBeforeHydration } from '@/lib/use-typed-before-hydration';
import { useUnmountSignal } from '@/lib/use-unmount-signal';
import { isUploadCancelledError, UploadCancelledError } from '@/lib/upload-queue';
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
    type TemporaryMediaUploadOptions,
} from '@/lib/temporary-media-upload';
import { readVideoDurationSeconds } from '@/lib/video-metadata-probe';
import { RECLAIM_AFTER_HOURS } from '@/lib/media-upload-reclaim';

interface MultiShot {
    id: string;
    prompt: string;
    duration: number;
}

/** The shots the page opens on. */
function openingShots(): MultiShot[] {
    return [{ id: '1', prompt: '', duration: 5 }];
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

/**
 * The form the page draws until a model is picked when its server could hand it no opening (a
 * remix, or a catalog it could not read): Kling 3.0's, the catalog default until 2026-10-28. At
 * the first pick a setting still at its drawn value takes the picked model's published default.
 */
const STAND_IN_FORM = {
    modelId: 'kling-3.0-video',
    mode: 'std',
    aspectRatio: '16:9',
    sound: false,
    resolution: '720p',
    fixedLens: false,
    isMultiShot: false,
    duration: 5,
} as const;

type DrawnVideoSettings = {
    mode: string;
    aspectRatio: string;
    sound: boolean;
    resolution: string;
    fixedLens: boolean;
    isMultiShot: boolean;
    duration: number;
};

type DrawnVideoForm = DrawnVideoSettings & { modelId: VideoModelId };

/**
 * The form the page draws until its first pick: the server's opening (`CreatorOpening`) as that
 * pick would set it on the stand-in, so on the revision the server read nothing changes.
 */
function drawnVideoForm(opening: CreatorOpening | null): DrawnVideoForm {
    // A length is a number, or a choice's string in some descriptors ("4").
    const duration = Number(opening?.settings.duration ?? Number.NaN);
    return {
        modelId: (opening?.modelId ?? STAND_IN_FORM.modelId) as VideoModelId,
        mode: openingSetting<string>(opening, 'mode', STAND_IN_FORM.mode),
        aspectRatio: openingSetting<string>(opening, 'aspectRatio', STAND_IN_FORM.aspectRatio),
        sound: openingSetting<boolean>(opening, 'sound', STAND_IN_FORM.sound),
        resolution: openingSetting<string>(opening, 'resolution', STAND_IN_FORM.resolution),
        fixedLens: openingSetting<boolean>(opening, 'fixedLens', STAND_IN_FORM.fixedLens),
        isMultiShot: openingSetting<boolean>(opening, 'isMultiShot', STAND_IN_FORM.isMultiShot),
        duration: Number.isFinite(duration) ? duration : STAND_IN_FORM.duration,
    };
}

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
 * MEDIA_OBJECT_NOT_FOUND, and the file goes up again. `press`: the account it goes up
 * for, and the signal that stops it (another owner's form taking this one's place),
 * then or as it ends, so nothing keeps it.
 */
async function stageReferenceFile(
    file: File,
    staged: StagedUpload | null | undefined,
    press: TemporaryMediaUploadOptions,
): Promise<StagedUpload> {
    if (staged && Date.now() - staged.uploadedAt < STAGED_UPLOAD_REUSE_MS) {
        try {
            const signedUrl = await refreshTemporaryMediaUrl(staged.storagePath, press);
            if (press.signal?.aborted) throw new UploadCancelledError();
            return { ...staged, signedUrl };
        } catch (refreshError) {
            if (!(refreshError instanceof TemporaryMediaReadUrlError && refreshError.code === 'MEDIA_OBJECT_NOT_FOUND')) {
                throw refreshError;
            }
        }
    }
    const upload = await uploadMediaToTemporaryStorage(file, press);
    if (press.signal?.aborted) throw new UploadCancelledError();
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

/** What the column's bar says when picks were left out because the model takes no more. */
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
    /** The inputs' side last picked: frames or references (the artboard Inputs). */
    inputSide: VideoInputSide;
    /** What the page drew, saved with a draft that has no model yet (`modelId: ''`). */
    drawn?: Partial<DrawnVideoSettings>;
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
    const drawn = stored.drawn && typeof stored.drawn === 'object' ? savedVideoFormValues(readVideoCreatorDraft(stored.drawn)) : undefined;
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
        inputSide: stored.inputSide === 'frames' || stored.inputSide === 'references' ? stored.inputSide : undefined,
        drawn,
    };
}

/** The page's own settings a saved draft holds, as the restore puts them in the form. */
function savedVideoFormValues(draft: Partial<VideoCreatorDraft>) {
    return {
        ...(draft.mode !== undefined ? { mode: draft.mode } : {}),
        ...(draft.aspectRatio ? { aspectRatio: draft.aspectRatio } : {}),
        ...(draft.sound !== undefined ? { sound: draft.sound } : {}),
        ...(draft.resolution !== undefined ? { resolution: draft.resolution } : {}),
        ...(draft.fixedLens !== undefined ? { fixedLens: draft.fixedLens } : {}),
        ...(draft.isMultiShot !== undefined ? { isMultiShot: draft.isMultiShot } : {}),
        ...(draft.duration !== undefined ? { duration: draft.duration } : {}),
    };
}

/**
 * Whether a saved draft's settings are its model's published defaults (catalogSettingsAtControlDefaults):
 * the page's own and the extra ones it saved for that model.
 */
function savedVideoSettingsAtDefaults(draft: Partial<VideoCreatorDraft>, descriptor: GenerationModelDescriptor): boolean {
    const saved: Record<string, unknown> = {
        ...(draft.additionalSettings?.modelId === draft.modelId ? draft.additionalSettings?.values : undefined),
        ...savedVideoFormValues(draft),
    };
    return catalogSettingsAtControlDefaults(descriptor.controls, (control) => saved[control.key]);
}

/** Single shot or multi-shot, as the app's segmented control offers them. */
const SHOT_MODES = ['single', 'multi'] as const;

/**
 * The run in flight, as it was started: its frame's shape, its settings' line, its prompt,
 * and the credits it holds (the price sent with it, then the start's own answer).
 */
type VideoRunShape = {
    aspectRatio: string | null;
    label: string | null;
    prompt: string | null;
    cost: number | null;
    /** The start answered: the run is the server's, and holds its credits, so the page may be left. */
    answered: boolean;
};

/** A multi-shot run's prompt as one caption: its shots' prompts in order. */
function shotsPrompt(shots: ReadonlyArray<{ prompt: string }>) {
    return shots.map((shot) => shot.prompt.trim()).filter(Boolean).join(' · ') || null;
}

/** A run's model as its chip names it, where all the page knows of the run is its model: a start sent before, a run picked up on load. */
function videoModelName(modelId: unknown): string | null {
    return typeof modelId === 'string' ? (VIDEO_MODELS as Record<string, { displayName: string } | undefined>)[modelId]?.displayName ?? null : null;
}

/** The shape and prompt of a start that was sent, read off its saved body. */
function runShapeOfStart(body: Record<string, unknown>): VideoRunShape {
    const settings = body.settings && typeof body.settings === 'object' ? body.settings as Record<string, unknown> : {};
    const shots = Array.isArray(body.shots)
        ? body.shots.filter((shot): shot is { prompt: string } => typeof (shot as { prompt?: unknown })?.prompt === 'string')
        : [];
    return {
        aspectRatio: typeof settings.aspectRatio === 'string' ? settings.aspectRatio : null,
        label: videoModelName(body.modelId),
        prompt: shots.length > 0 ? shotsPrompt(shots) : (typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : null),
        cost: typeof body.expectedCostCredits === 'number' ? body.expectedCostCredits : null,
        answered: false,
    };
}

/** A settings group's columns: its options on one row where up to five fit. */
function choiceColumns(count: number): 3 | 4 | 5 {
    return count <= 3 ? 3 : count === 4 ? 4 : 5;
}

/**
 * The longest length range priced as buttons, one a second (Seedance 2 Mini's 4 to 15s):
 * each length shows its price. A longer range (Wan 3.0's 2 to 30s) keeps its slider,
 * which shows the price of the length it is on.
 */
const PRICED_LENGTH_BUTTONS_MAX = 15;
/** A prompt longer than this does not ride along in the image creator's link. */
const PROMPT_IN_LINK_MAX = 1500;

/** The image creator, on the image model that costs least, with the prompt when it fits a link. */
function makeImageInsteadHref(modelId: string, prompt: string): string {
    const params = new URLSearchParams({ model: modelId });
    const text = prompt.trim();
    if (text && text.length <= PROMPT_IN_LINK_MAX) params.set('prompt', text);
    return `/create-image?${params.toString()}`;
}

/** The run a remix fitted to the balance opened on in its original's place. */
type RemixFitted = { modelId: VideoModelId; settings: VideoFormSettings; cost: number; sameLength: boolean };

/**
 * A remix fitted to the balance (owner, 2026-10-28): the original it came from and how far
 * the deciding has got. It is decided once, when the original's price first comes in:
 * pricing every model, then (when even the cheapest is short at its length) its shorter
 * lengths, then settled on the run it opened on, or on the original (`fitted` null).
 */
type RemixFit = { original: { modelId: VideoModelId; settings: VideoFormSettings; cost: number; durationSeconds: number } } & (
    | { stage: 'pricing' }
    | {
        stage: 'shortening';
        /** The model whose shorter lengths are priced, at its fitted settings. */
        shortenOn: { modelId: VideoModelId; settings: VideoFormSettings; belowSeconds: number };
        /** The run to open when no shorter length fits, priced when it was decided. */
        otherwise: RemixFitted | null;
    }
    | { stage: 'settled'; fitted: RemixFitted | null }
);

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

/** What a Seedance asset step changes on a card: its upload and its asset. */
type AssetStepCard = {
    id: string;
    file: File | null;
    providerUrl: string | null;
    storagePath?: string | null;
    staged: StagedUpload | null;
    seedanceAsset: SeedanceAssetMetadata;
};

/**
 * A Seedance asset step's result laid on its card as the cards are once the step ends, or null
 * when the card is gone or holds another file: Replace keeps a card's id, and the original's
 * upload or asset is not the new file's. Only what the step changes is taken from it, so a
 * rename made meanwhile stays.
 */
function landAssetStep<T extends AssetStepCard>(current: readonly T[], before: T, after: T): T[] | null {
    const index = current.findIndex((card) => card.id === before.id && card.file === before.file);
    if (index === -1) return null;
    const next = [...current];
    next[index] = {
        ...current[index],
        providerUrl: after.providerUrl,
        storagePath: after.storagePath,
        staged: after.staged,
        seedanceAsset: after.seedanceAsset,
    };
    return next;
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
    /**
     * Brought back by a remix from its original. Replace makes it the creator's own and it stays
     * replaceable (the artboard Remix: "Replace the photos to make it yours").
     */
    restoredFromRemix: boolean;
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
    /** Defaults to whether it came from a remix (`source`). */
    restoredFromRemix?: boolean;
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
    /** Brought back by a remix from its original, and replaceable (as a picture's is). */
    restoredFromRemix: boolean;
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
    restoredFromRemix?: boolean;
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
    onInsert,
}: {
    subjects: KlingSubjectDraft[];
    limits: SubjectLimits;
    disabled: boolean;
    onChange: (next: KlingSubjectSeed[]) => void;
    onRename: (subjectId: string, displayName: string) => void;
    onRefusedFiles: (message: string | null) => void;
    /** Puts a subject's @handle where the creator is writing, as a reference tile's handle does. */
    onInsert: (handle: string) => void;
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
                                <div className="mt-2 flex items-center justify-between gap-2">
                                    <p className={`text-xs font-semibold ${imageCountOk ? 'text-[var(--ui-text-faint)]' : 'text-amber-300'}`}>
                                        {subject.images.length}/{KLING_SUBJECT_MAX_IMAGES} images{imageCountOk ? '' : ` — add at least ${KLING_SUBJECT_MIN_IMAGES}`}
                                    </p>
                                    <button
                                        type="button"
                                        disabled={disabled}
                                        onClick={() => onInsert(subject.handle)}
                                        aria-label={`Insert ${subject.handle}`}
                                        className={CREATOR_REFERENCE_CHIP_CLASS}
                                    >
                                        Insert
                                    </button>
                                </div>
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
        restoredFromRemix: seed.restoredFromRemix ?? seed.source === 'remix',
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
        restoredFromRemix: seed.restoredFromRemix ?? seed.source === 'remix',
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

/**
 * Kling 3.0's clip cards, each under its handle. `mentionedHandles` are the handles a
 * remix's words mention, for clips it hands back without one (`assignRemixElementHandles`).
 */
function hydrateKlingVideoElements(
    seeds: KlingVideoElementSeed[],
    mentionedHandles: Iterable<string> = [],
): KlingVideoElementDraft[] {
    return assignRemixElementHandles(seeds, mentionedHandles).map((seed) => ({
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

type CreateVideoClientProps = {
    prefill: CreateVideoPrefill;
    /** Back from the sign-up a visitor opened here: the card that adds the welcome credits. */
    welcome?: CreatorWelcome | null;
    /** The sign-up sheet's `?handover=` nonce on the way back: the visitor's draft moves to the account by it. */
    handoverNonce?: string | null;
    /** What a new account starts with, told to a signed-out visitor. */
    visitorWelcomeCredits?: number | null;
    /** The run the server read the page opens on: its form is drawn from the first paint, and its price stands until the page's own. */
    opening?: CreatorOpening | null;
    /** The shelf's posts for the empty canvas, still on their way; none for a remix. */
    startPosts?: StartPostsSource;
};

/**
 * The video creator, drawn for one owner's form at a time: the visitor's until someone signs in,
 * then the account's, which takes the visitor's when sign-up was opened here. Another account's
 * form is a creator drawn anew (`useCreatorForm`): the earlier owner's unanswered start, run,
 * result and remix go with theirs, and nothing still under way for them is sent under the next.
 */
export default function CreateVideoClient(props: CreateVideoClientProps) {
    const { session } = useAuth();
    const draft = useCreatorDraftOwner('video', session?.user?.id ?? null, props.handoverNonce ?? null);
    const form = useCreatorForm(draft);
    // What the server drew for the page's viewer (the sign-up's welcome, the posts to start from, read
    // for them) is theirs: a later account's form is drawn without it.
    return (
        <VideoCreator
            key={form.key}
            {...props}
            welcome={form.pageViewer ? props.welcome : null}
            startPosts={form.pageViewer ? props.startPosts : null}
            draft={draft}
            form={form}
        />
    );
}

function VideoCreator({
    prefill,
    welcome = null,
    visitorWelcomeCredits = null,
    opening = null,
    startPosts = null,
    draft,
    form,
}: CreateVideoClientProps & { draft: CreatorDraftOwner; form: CreatorForm }) {
    const router = useRouter();
    const { credits: userCredits, isLoading: isLoadingUser, session, updateCredits } = useAuth();
    const userId = session?.user?.id ?? null;
    const { owner: draftOwner, carriedDraft, keepsVisitorForm } = draft;
    // The account whose form this is, which a press goes out under: the page's own, or through a
    // session that lapsed, the one the form was drawn for.
    const formAccount = form.owner !== null && form.owner !== VISITOR_DRAFT_OWNER ? form.owner : userId;
    // A page that opened signed out works up to Generate, which asks for an account
    // (owner, 2026-10-28). One whose session lapsed is not a visitor's: it keeps its
    // signed-in face, and its Generate signs in again on the login page.
    const isVisitor = draftOwner === VISITOR_DRAFT_OWNER;
    const [signUpReason, setSignUpReason] = useState<CreatorSignUpReason | null>(null);
    const remixId = prefill.remixId ?? null;
    const remixPostId = prefill.remixPostId ?? null;
    const prefillPrompt = prefill.prompt ?? null;
    const prefillModel = prefill.model ?? null;
    const prefillAspectRatio = prefill.aspectRatio ?? null;
    const prefillDuration = prefill.duration ?? null;

    // What the page draws until its first pick, kept as it opened: the first pick reads the form against it.
    const [drawnForm] = useState(() => drawnVideoForm(opening));
    const [selectedModel, setSelectedModel] = useState<VideoModelId>(drawnForm.modelId);
    const [isMultiShot, setIsMultiShot] = useState<boolean>(drawnForm.isMultiShot);
    const [prompt, setPrompt] = useState('');

    // Mirrors the live prompt so the remix restore below can tell whether the
    // creator typed while /api/remix-source was still in flight.
    const promptRef = useRef(prompt);
    useEffect(() => {
        promptRef.current = prompt;
    }, [prompt]);
    const [singleDuration, setSingleDuration] = useState<number>(drawnForm.duration);
    const [multiPrompts, setMultiPrompts] = useState<MultiShot[]>(openingShots);
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
    const [mode, setMode] = useState<string>(drawnForm.mode);
    const [aspectRatio, setAspectRatio] = useState<string>(drawnForm.aspectRatio);
    const [sound, setSound] = useState<boolean>(drawnForm.sound);
    const [resolution, setResolution] = useState<string>(drawnForm.resolution);
    const [fixedLens, setFixedLens] = useState<boolean>(drawnForm.fixedLens);
    // The inputs' side last picked, frames or references (the artboard Inputs), saved with the
    // draft. What is attached holds the card to its own side (`videoInputView`).
    const [pickedInputSide, setPickedInputSide] = useState<VideoInputSide>('frames');
    const inputSwitchRef = useRef<HTMLDivElement>(null);
    // The file a Replace last picked for each clip or track: a pick measured later than a newer
    // one for the same reference does not take its place.
    const latestReplacePicksRef = useRef(new Map<string, File>());
    // The last switch's writes, which the next switch's wait for (`writeAfterEarlierSwitches`).
    const inputSwitchWritesRef = useRef<Promise<void>>(Promise.resolve());

    const [isDraggingStart, setIsDraggingStart] = useState(false);
    const [isDraggingEnd, setIsDraggingEnd] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [generationTiming, setGenerationTiming] = useState<GenerationTiming | null>(null);
    const [outputVideo, setOutputVideo] = useState<string | null>(null);
    const [resolvedOutputVideo, setResolvedOutputVideo] = useState<{ outputUrl: string; url: string } | null>(null);
    const [latestGenerationId, setLatestGenerationId] = useState<string | null>(null);
    // Publishing on the canvas: the form's details, the remix's original (credited with Follow,
    // owner 2026-10-28), Posted, and a publish in flight, which Generate waits for.
    const canvasPublish = useCreatorPublish({
        generationId: latestGenerationId,
        done: Boolean(outputVideo),
        accessToken: session?.access_token,
        remixPostId,
        viewerUserId: userId,
    });
    const [error, setError] = useState<string | null>(null);
    // Why files just picked were left out: their own line, so it never stands in for a
    // run's error or its background state.
    const [pickNotice, setPickNotice] = useState<string | null>(null);
    // A start sent without an answer that says whether it started. Until one comes, the
    // bar offers to check again under the same key instead of starting another.
    const [unconfirmedStart, setUnconfirmedStart] = useState<PendingWebStart | null>(null);
    // The server's "not enough credits", for the balance and price it was given at. A
    // fresh balance or another price is a new question, so it applies only while both hold.
    const [creditRefusal, setCreditRefusal] = useState<{ message: string; credits: number | null; cost: number | null } | null>(null);
    // The owner whose saved draft has been read back. Until then nothing is saved over
    // it, and the catalog does not pick its default model in place of the saved one.
    const [draftRestoredFor, setDraftRestoredFor] = useState<string | null>(null);
    // Whether the prompt carried from sign-up has come back yet: the prompt box's rule (`creator-draft-prompt.ts`).
    const carriedPromptTakenRef = useRef(false);
    const restoredDraftModelRef = useRef(false);
    // A saved draft with a model was read back, a link's model or not: its settings are the creator's.
    const restoredDraftSettingsRef = useRef(false);
    // A saved draft read back with a model and no words. If the form still holds nothing when the first
    // pick comes, the saved files restored, and its settings are its model's published defaults, it was
    // never the creator's: the first pick gives it the catalog's default instead.
    const emptySavedDraftRef = useRef<Partial<VideoCreatorDraft> | null>(null);
    // The owner whose saved files have been read back (`complete`), or given up on.
    const [mediaRestoredFor, setMediaRestoredFor] = useState<{ owner: string; complete: boolean } | null>(null);
    const pendingAdditionalSettingsRef = useRef<VideoCreatorDraft['additionalSettings'] | null>(null);
    const unsavedDraftRef = useRef<{ owner: string; draft: VideoCreatorDraft } | null>(null);
    const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
    const [promptQualityWarnings, setPromptQualityWarnings] = useState<PromptEnhancementWarning[]>([]);
    const [multiPromptQualityWarnings, setMultiPromptQualityWarnings] = useState<Record<string, PromptEnhancementWarning[]>>({});
    const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
    // Open settings price each of their options; the bar says when they open and close.
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [remixFit, setRemixFit] = useState<RemixFit | null>(null);
    const modelCatalog = useWebGenerationModelCatalog({ kind: 'video', selectedIds: [selectedModel], pickerOpen: isModelDropdownOpen });
    const catalogDescriptor = modelCatalog.catalog?.models.find(item => item.id === selectedModel);
    const refetchModelCatalog = modelCatalog.refetch;
    const [modelSearchQuery, setModelSearchQuery] = useState('');
    const modelDropdownRef = useRef<HTMLDivElement>(null);
    const hasResolvedInitialCatalogModel = useRef(false);
    // Whether the model and its settings are the creator's, a saved draft's or the first pick's rather
    // than the page's stand-in form: only then is the model saved with the draft (a link's model is not
    // settled until the first pick, which gives it its own settings; a reload keeps the link anyway).
    const [modelSettled, setModelSettled] = useState(false);
    const activeGenerationRequestKeyRef = useRef<string | null>(null);
    const generationPollAbortControllerRef = useRef<AbortController | null>(null);
    // The look, as the page opens, for a run already at work.
    const activeRunLookupRef = useRef<AbortController | null>(null);
    // Aborted as this creator goes, left or drawn anew for another owner: a check or an answer of its
    // own still out then shows nothing more and sends no one to sign in. A press already out goes on
    // under its own account; only another owner's form stops it (`form.replaced`).
    const unmountSignal = useUnmountSignal();
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
    // The run in flight's shape, settings and prompt, which its frame and caption keep while
    // the form changes for the next run.
    const [runShape, setRunShape] = useState<VideoRunShape | null>(null);
    // A run the provider failed, said on the canvas with its cause (the artboard Failed).
    const [runFailure, setRunFailure] = useState<{ message: string; cost: number | null } | null>(null);
    // Bumped when a run this page followed ends, done or failed: the canvas takes the focus.
    const [runEndKey, setRunEndKey] = useState(0);
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
    // Anything the creator has put in the form. A link's own prompt is not theirs.
    const formHoldsWork = Boolean(prompt.trim() && prompt !== prefillPrompt)
        || multiPrompts.some((shot) => shot.prompt.trim())
        || elements.length > 0 || referenceVideos.length > 0 || referenceAudios.length > 0
        || klingVideoElements.length > 0 || klingSubjects.length > 0
        || Boolean(startImageUrl || startImageFile || endImageUrl || endImageFile)
        || preparedAudioIds.length > 0 || characterIds.length > 0;
    const draftReady = Boolean(remixId) || (draftOwner !== null && draftRestoredFor === draftOwner);
    useEffect(() => {
        if (!modelCatalog.catalog || !draftReady) return;
        const firstPick = !hasResolvedInitialCatalogModel.current;
        // The first pick waits for the revision the network confirms: a catalog read back from
        // the browser can still name an earlier default, which the page would then keep.
        if (firstPick && modelCatalog.isCheckingRevision) return;
        const catalog = modelCatalog.catalog;
        // A saved draft with nothing in it, at its model's published defaults, was never the creator's:
        // the default of its day (Kling 3.0 until 2026-10-28), or the form as the page opened. It takes
        // the default, as a new form does, while the form still holds nothing and its settings are as
        // the restore drew them. Its model's details and the read of its saved files say which it is.
        const emptySaved = firstPick ? emptySavedDraftRef.current : null;
        const emptySavedModel = emptySaved && catalog.models.find((model) => model.id === emptySaved.modelId && model.kind === 'video');
        if (emptySaved && !emptySavedModel && !modelCatalog.missingIds.includes(emptySaved.modelId ?? '')) return;
        if (emptySaved && mediaRestoredFor?.owner !== draftOwner) return;
        const drawn = emptySaved ? { ...drawnForm, ...savedVideoFormValues(emptySaved) } : drawnForm;
        // The drawn model's own settings check empties a choice it does not offer.
        const asDrawn = (value: string, drawnValue: string) => value === drawnValue || value === '';
        const formAsDrawn = asDrawn(mode, drawn.mode) && asDrawn(resolution, drawn.resolution) && sound === drawn.sound
            && fixedLens === drawn.fixedLens && isMultiShot === drawn.isMultiShot
            && (Boolean(prefillAspectRatio) || aspectRatio === drawn.aspectRatio)
            && (Boolean(prefillDuration) || singleDuration === drawn.duration);
        const untouchedSaved = emptySaved && emptySavedModel && mediaRestoredFor?.complete && !formHoldsWork && formAsDrawn
            && savedVideoSettingsAtDefaults(emptySaved, emptySavedModel)
            ? emptySaved
            : null;
        const preferDefault = firstPick && !remixId && !prefillModel && (!restoredDraftModelRef.current || Boolean(untouchedSaved));
        // The default's details are still loading: picking now would settle on the stand-in.
        const defaultId = catalog.defaults.video;
        if (preferDefault && defaultId && !catalog.models.some((model) => model.id === defaultId)
            && !modelCatalog.missingIds.includes(defaultId)) return;
        const nextModelId = resolveCatalogModelId(catalog, 'video', selectedModel, { preferDefault });
        if (!nextModelId) return;
        hasResolvedInitialCatalogModel.current = true;
        setModelSettled(true);
        if (firstPick && !remixId && (!restoredDraftSettingsRef.current || untouchedSaved)) {
            // Until now the page drew a stand-in form, or an untouched saved draft's: the default, or
            // the model a link named, opens on its own published settings, but for a ratio or a length
            // the link asked for and a setting the creator changed while the page waited.
            const descriptor = catalog.models.find((model) => model.id === nextModelId);
            const defaults = descriptor ? getCatalogDescriptorDefaultSettings(descriptor) : {};
            if (typeof defaults.mode === 'string' && asDrawn(mode, drawn.mode)) setMode(defaults.mode);
            if (typeof defaults.resolution === 'string' && asDrawn(resolution, drawn.resolution)) setResolution(defaults.resolution);
            if (typeof defaults.sound === 'boolean' && sound === drawn.sound) setSound(defaults.sound);
            if (typeof defaults.fixedLens === 'boolean' && fixedLens === drawn.fixedLens) setFixedLens(defaults.fixedLens);
            if (typeof defaults.isMultiShot === 'boolean' && isMultiShot === drawn.isMultiShot) setIsMultiShot(defaults.isMultiShot);
            if (typeof defaults.aspectRatio === 'string' && !prefillAspectRatio && aspectRatio === drawn.aspectRatio) {
                setAspectRatio(defaults.aspectRatio);
            }
            if (defaults.duration !== undefined && !prefillDuration && singleDuration === drawn.duration) {
                setSingleDuration(Number(defaults.duration));
            }
        }
        if (nextModelId !== selectedModel) {
            const nextModel = (VIDEO_MODELS as unknown as Record<string, typeof videoModel>)[nextModelId];
            setSelectedModel(nextModelId as VideoModelId);
            if (!preferDefault) {
                setCatalogNotice(`Your previous video model is no longer available. Switched to ${nextModel?.displayName ?? nextModelId}.`);
            }
        }
    }, [
        modelCatalog.catalog, modelCatalog.isCheckingRevision, selectedModel, videoModel, prefillModel, prefillAspectRatio, prefillDuration,
        remixId, draftReady, mode, resolution, sound, fixedLens, isMultiShot, aspectRatio, singleDuration, modelCatalog.missingIds,
        formHoldsWork, mediaRestoredFor, draftOwner, drawnForm,
    ]);
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
    // Staged files are saved under the account that added them (or the visitor, until
    // one signs in), so the next account to use this browser does not open them. A
    // remix keeps none: it restores its source. Nor does a form another owner's has replaced: a
    // press, a pick or a save still out for it would write the earlier owner's files back, after a
    // sign-out that cleared them too.
    const mediaKey = useCallback((key: string) => (
        !remixId && draftOwner && !form.replaced.aborted ? scopedPersistedMediaKey(key, draftOwner) : null
    ), [form.replaced, remixId, draftOwner]);
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

    /**
     * Reads the length of each clip and track that holds its file but no length, and writes it on
     * the reference it belongs to. Until 2026-10-31 the reader skipped every .mov on Chrome, so a
     * draft saved then came back with clips the quote could not price and Kling 3.0 could not
     * hold. Each reference is found by its file: one taken off or replaced meanwhile is left alone.
     */
    const measureUnreadLengths = async () => {
        const unread = [...referenceVideosRef.current, ...referenceAudiosRef.current, ...klingVideoElementsRef.current]
            .flatMap((item) => (item.file && item.durationSeconds == null ? [item.file] : []));
        if (unread.length === 0) return;
        const lengths = new Map<File, number>();
        await Promise.all(unread.map(async (file) => {
            const seconds = await readVideoDurationSeconds(file);
            if (seconds !== null) lengths.set(file, seconds);
        }));
        const measured = <T extends { file: File | null; durationSeconds?: number | null }>(items: T[]) => {
            let changed = false;
            const next = items.map((item) => {
                const length = item.file && item.durationSeconds == null ? lengths.get(item.file) : undefined;
                if (length === undefined) return item;
                changed = true;
                return { ...item, durationSeconds: length };
            });
            return changed ? next : null;
        };

        const nextVideos = measured(referenceVideosRef.current);
        if (nextVideos) {
            commitReferenceVideos(nextVideos);
            await persistReferenceVideos(nextVideos);
        }
        const nextAudios = measured(referenceAudiosRef.current);
        if (nextAudios) {
            commitReferenceAudios(nextAudios);
            await persistReferenceAudios(nextAudios);
        }
        const nextKlingElements = measured(klingVideoElementsRef.current);
        if (nextKlingElements) {
            commitKlingVideoElements(nextKlingElements);
            await persistKlingVideoElements(nextKlingElements);
        }
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
    // Which shape the run uses is read back off what is attached, never off the inputs'
    // switch (which only decides what the card shows): a derived mode cannot disagree with
    // the attachments the way a separately persisted one could.
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
    // The inputs, frames or references, one side at a time (the artboard Inputs; the owner's
    // answers of 2026-10-29). The side shown is the one what is attached belongs to, or the one
    // last picked while nothing is; the run's own shape is still read off what it carries.
    const inputSides = videoInputSides(affordances, { isMultiShot: currentIsMultiShot });
    const heldInputs: HeldVideoInputs = {
        start: Boolean(startImageUrl || startImageFile),
        end: Boolean(endImageUrl || endImageFile),
        pictures: runElements.length,
        clips: runReferenceVideos.length,
        tracks: runReferenceAudios.length,
        characters: isGeminiOmniVideoModel ? characterIds.length : 0,
    };
    const inputView = videoInputView(inputSides, heldInputs, pickedInputSide);
    // A side held by what is attached is the one picked, so taking the last of it off leaves
    // the card where it is, whichever came back first, the attachments or a saved pick.
    if (inputView.heldSide && inputView.heldSide !== pickedInputSide) setPickedInputSide(inputView.heldSide);
    // A question about what is attached is moot once that changes while it is up (a remix or
    // a saved draft coming back): it is answered "keep", so its yes never acts on what has gone.
    const confirmInputSwitch = useConfirmation([
        selectedModel,
        currentMode,
        currentIsMultiShot,
        startImageUrl,
        endImageUrl,
        ...elements.map((element) => element.id),
        ...referenceVideos.map((reference) => reference.id),
        ...referenceAudios.map((reference) => reference.id),
    ].join('|'));
    const videoElementSupport = {
        enabled: affordances.elements.enabled,
        maxElements: affordances.elements.maxTotal,
        maxNamed: affordances.elements.maxNamed,
        reason: affordances.elements.disabledReason,
    };
    const canUseVideoElements = affordances.elements.enabled;
    const activeReferenceMode = affordances.activeMode;
    const combinesFrameWithReferences = affordances.combineFramesWithReferences;
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
    const videoAccent = getAccentClasses('video');
    // What the run leaves out, and the Grok note: the amber of a caution.
    const noticeClasses = getAccentClasses('commerce');
    // The mode control's own name from the model's descriptor ("Grok mode"), as the app shows it.
    const modeControlLabel = catalogDescriptor?.controls.find((control) => control.key === 'mode')?.label
        ?? (selectedModel === 'veo-3.1' ? 'Model variant' : 'Quality mode');
    // Hailuo 2.3 animates a start image and has no run without one (handleGenerate says so).
    const startFrameRequired = selectedModel === 'hailuo-2.3';
    // The settings chip, read as the app's ("720P · 16:9 · 5s").
    const currentModeLabel = videoModel.modeOptions.find((option) => option.value === currentMode)?.label ?? currentMode;
    const settingsSummary = videoSettingsSummary({
        modeLabel: currentModeLabel,
        resolution: currentResolution,
        aspectRatio: currentAspectRatio,
        durationSeconds: totalDuration,
        sound: videoModel.supportsSound ? currentSound : null,
    });
    const settingsSummaryShort = videoRunShortSummary({ modeLabel: currentModeLabel, resolution: currentResolution, durationSeconds: totalDuration });
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
    // The price under the bar: the page's own, or until it is in, the server's for the run the page opened on.
    const notedCost = estimatedCost ?? openingCost(opening, {
        run: { modelId: selectedModel, settings: runSettings, inputs: runInputs },
        quoteStatus: quoteState.status,
        confirmedRevision: modelCatalog.isCheckingRevision ? null : modelCatalog.revision,
        catalogFailed: Boolean(modelCatalog.error) || modelCatalog.missingIds.includes(selectedModel),
    });
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

    // The creator's lists priced (owner, 2026-10-28): every model at this run's settings, every
    // option of the settings, and what a balance short of every video can make instead. Read
    // against the balance, or a visitor's welcome credits.
    const listBalance = isVisitor ? visitorWelcomeCredits : userCredits;
    // How many references and frames this run sends.
    const pageTally = videoRunInputTally(runInputs);
    const pageForm = useMemo<VideoFormSettings>(() => ({
        mode: currentMode,
        aspectRatio: currentAspectRatio,
        resolution: currentResolution,
        duration: currentDuration,
        sound: currentSound,
        fixedLens: currentFixedLens,
        isMultiShot: currentIsMultiShot,
    }), [currentMode, currentAspectRatio, currentResolution, currentDuration, currentSound, currentFixedLens, currentIsMultiShot]);
    const formHeld = useMemo<VideoFormHeld<PageVideoRunMedia>>(() => ({
        imageReferences: elements,
        videoReferences: referenceVideos,
        audioReferences: referenceAudios,
        videoElements: klingVideoElements,
        subjects: klingSubjects,
        hasStartFrame: Boolean(startImageUrl || startImageFile),
        hasEndFrame: Boolean(endImageUrl || endImageFile),
        preparedVoiceIds: preparedAudioIds,
        characterIds,
        multiShotSeconds: multiShotTotalDuration(multiPrompts),
    }), [elements, referenceVideos, referenceAudios, klingVideoElements, klingSubjects, startImageUrl, startImageFile, endImageUrl, endImageFile, preparedAudioIds, characterIds, multiPrompts]);
    // While a change is being priced (each settings press: a debounce and a round trip), what
    // the balance covers is read from this model's last price, so the bar does not swap its
    // action, its layout and the notices over it and back on every press.
    const [lastCost, setLastCost] = useState<{ modelId: VideoModelId; cost: number } | null>(null);
    if (estimatedCost !== null && (lastCost?.modelId !== selectedModel || lastCost.cost !== estimatedCost)) {
        setLastCost({ modelId: selectedModel, cost: estimatedCost });
    }
    const affordCost = estimatedCost
        ?? (quoteState.status === 'pending' && lastCost?.modelId === selectedModel ? lastCost.cost : null);
    // Every model is priced while the list is open, while a remix is fitted to the balance, and
    // while the balance is short of this run, to tell a balance short of every video.
    const balanceShort = !isVisitor && userCredits !== null && affordCost !== null && userCredits < affordCost;
    const pricesModelList = isModelDropdownOpen || remixFit?.stage === 'pricing' || balanceShort;
    const videoModelIdsKey = videoModelOptions.map((option) => option.id).join(',');
    const ensureModelDetails = modelCatalog.ensureDetails;
    useEffect(() => {
        if (pricesModelList && videoModelIdsKey) ensureModelDetails?.(videoModelIdsKey.split(','));
    }, [ensureModelDetails, pricesModelList, videoModelIdsKey]);
    // The run on each other model whose details are in, its settings carried over.
    const modelRuns = useMemo(() => {
        const catalog = modelCatalog.catalog;
        const runs = new Map<string, VideoRunOnModel<PageVideoRunMedia>>();
        if (!pricesModelList || !catalog || !videoModelIdsKey) return runs;
        const detailed = new Set(catalog.models.map((model) => model.id));
        for (const id of videoModelIdsKey.split(',')) {
            if (id === selectedModel || !detailed.has(id)) continue;
            const run = videoRunOnModel({ modelId: id, catalogRevision: catalog.revision, settings: fitVideoFormToModel(id, pageForm), held: formHeld });
            if (run) runs.set(id, run);
        }
        return runs;
    }, [pricesModelList, modelCatalog.catalog, videoModelIdsKey, selectedModel, pageForm, formHeld]);
    // Every option of the open settings, each the run with that one setting changed.
    const lengthOptions = useMemo(
        () => videoLengthOptions(singleShotDurationRange, videoModel.durations),
        [singleShotDurationRange, videoModel.durations],
    );
    const lengthPriced = !currentIsMultiShot && lengthOptions.length > 1;
    const lengthButtons = lengthPriced && (!singleShotDurationRange || lengthOptions.length <= PRICED_LENGTH_BUTTONS_MAX);
    const settingsAxes = useMemo<Array<readonly [string, readonly CatalogPrimitive[]]>>(() => [
        ...(lengthPriced ? [['duration', lengthOptions] as const] : []),
        ['resolution', videoModel.resolutions],
        ['mode', videoModel.modeOptions.map((option) => option.value)],
        ['aspectRatio', videoModel.aspectRatios],
        ...(videoModel.supportsSound ? [['sound', [true, false]] as const] : []),
    ], [lengthPriced, lengthOptions, videoModel]);
    const variants = useMemo(() => {
        const revision = modelCatalog.catalog?.revision;
        if (!settingsOpen) return NO_SETTINGS_VARIANTS;
        // Each option is the run with that one setting changed, unless the setting changes which slots
        // the run fills: pictures Veo 3.1 holds on Lite or Fast wait on Quality, which takes none, so
        // its Quality option is priced as the run the page would make there. Only then: the planned
        // run cuts pictures to the model's cap, which the page's own run leaves to Generate to refuse.
        const slotsFilled = (inputs: ReadonlyArray<{ slot: string }>) => [...new Set(inputs.map((input) => input.slot))].sort().join(' ');
        const filled = slotsFilled(runInputs);
        return settingsVariants(quoteRequest, settingsAxes, undefined, (key, value) => {
            if (key !== 'mode' || value === currentMode || !revision) return null;
            const run = videoRunOnModel({ modelId: selectedModel, catalogRevision: revision, settings: { ...pageForm, mode: String(value) }, held: formHeld });
            return run && slotsFilled(run.inputs) !== filled ? run.quoteInput : null;
        });
    }, [settingsOpen, quoteRequest, settingsAxes, modelCatalog.catalog?.revision, runInputs, currentMode, selectedModel, pageForm, formHeld]);
    // While the balance is short of this run, the image models too, for a balance short of every video.
    const imageRuns = useMemo(() => {
        const revision = modelCatalog.catalog?.revision;
        if (!balanceShort || !revision) return [];
        return Object.keys(IMAGE_MODELS).map((id) => catalogRunQuoteInput({ kind: 'image' as const, modelId: id, catalogRevision: revision, settings: {}, inputs: [] }));
    }, [balanceShort, modelCatalog.catalog?.revision]);
    // A remix whose cheapest fitting model is short of the balance at its length: its shorter lengths.
    const shortenRuns = useMemo(() => {
        const revision = modelCatalog.catalog?.revision;
        if (remixFit?.stage !== 'shortening' || !revision) return [];
        const { modelId, settings, belowSeconds } = remixFit.shortenOn;
        return videoLengthsBelow(modelId, belowSeconds).flatMap((duration) => {
            const run = videoRunOnModel({ modelId, catalogRevision: revision, settings: { ...settings, duration }, held: formHeld });
            return run ? [run] : [];
        });
    }, [remixFit, modelCatalog.catalog?.revision, formHeld]);
    const priceOf = useQuotePrices([
        ...[...modelRuns.values()].map((run) => run.quoteInput),
        ...variants.values(),
        ...imageRuns,
        ...shortenRuns.map((run) => run.quoteInput),
    ]);
    // Every model's price is in: each model with details has its answer, and the rest are
    // missing, or will not load (a model whose details failed counts as unpriced).
    const modelListSettled = pricesModelList && Boolean(modelCatalog.catalog) && videoModelIdsKey.split(',').every((id) => (
        id === selectedModel
            || modelCatalog.missingIds.includes(id)
            || (modelRuns.has(id) ? priceOf(modelRuns.get(id)!.quoteInput).status !== 'pending' : Boolean(modelCatalog.error))
    ));
    // A remix is fitted only on prices that are in: one not to be had now is asked again in
    // half a minute (`useQuotePrices`), and the remix waits for it rather than settling on its original.
    // The catalog's default video (Seedance 2 Mini) comes first (owner, 2026-10-28), so its price
    // is waited for too: a model whose details failed counts as settled for the list, not here.
    const preferredVideo = modelCatalog.catalog?.defaults.video ?? null;
    const preferredRun = preferredVideo ? modelRuns.get(preferredVideo) : undefined;
    const preferredPriced = !preferredVideo || preferredVideo === selectedModel || modelCatalog.missingIds.includes(preferredVideo)
        || (preferredRun !== undefined && priceOf(preferredRun.quoteInput).status !== 'pending');
    const remixPricesIn = modelListSettled && preferredPriced
        && [...modelRuns.values()].every((run) => priceOf(run.quoteInput).status !== 'unavailable');
    const videoCosts = [affordCost, ...[...modelRuns.values()].map((run) => readyCost(priceOf(run.quoteInput)))];
    const videosFrom = cheapestCost(videoCosts);
    // Short of every video (owner, 2026-10-28): an image first, on the image model that costs least.
    const imageOffer = imageRuns.reduce<{ modelId: string; name: string; cost: number } | null>((best, run) => {
        const cost = readyCost(priceOf(run));
        if (cost === null || (best && best.cost <= cost)) return best;
        const name = (IMAGE_MODELS as Record<string, { displayName?: string } | undefined>)[run.modelId]?.displayName ?? run.modelId;
        return { modelId: run.modelId, name, cost };
    }, null);
    const shortOfEveryVideo = balanceShort && userCredits !== null && modelListSettled && videosFrom !== null && userCredits < videosFrom;
    const offersImageInstead = shortOfEveryVideo && imageOffer !== null && imageOffer.cost <= (userCredits ?? 0);
    // An option's price in the settings, against the balance: "19", or "23 · +1" past it.
    const optionPrice = optionPricesOf(variants, priceOf, listBalance, isVisitor ? 'the free credits' : 'your balance');
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
    // The clips and tracks the run sends that are shorter than their slot takes (Kie refuses a
    // Kling 3.0 video element under 3 seconds, a Seedance 2 clip or track under 2). The start
    // refused such a run before any hold, but only once Generate was pressed; the run now waits,
    // with the start's words for the first beside Generate, for as long as one holds, and each
    // one's card says it is under the minimum. A length the page never read is left to the
    // start, which measures it.
    const shortInputs = runInputs.flatMap((input) => {
        const slot = affordances.minimumLengths.get(input.slot);
        const media = input.slot === 'videoElements'
            ? { id: input.element.id, label: input.element.displayName, durationSeconds: input.element.durationSeconds }
            : input.slot === 'videoReferences' || input.slot === 'audioReferences'
                ? { id: input.reference.id, label: input.reference.displayName, durationSeconds: input.durationSeconds }
                : null;
        const minimumSeconds = slot?.minDurationSeconds;
        const message = slot && media ? catalogInputTooShort(videoModel.displayName, slot, media) : null;
        return message && media && minimumSeconds ? [{ id: media.id, message, minimumSeconds }] : [];
    });
    const shortInputMessage = shortInputs[0]?.message ?? null;
    /**
     * What a clip's or track's card says of its length, or null where the page read none: read toward
     * the limit it is past (`lengthReading`: rounded down under the slot's shortest, as the start's
     * refusal gives it, up over its longest), and, for one the run holds, that it is under the minimum.
     */
    const cardLength = (id: string, durationSeconds: number | null | undefined, slotKey: 'videoReferences' | 'audioReferences' | 'videoElements', noun: 'clip' | 'track') => {
        if (typeof durationSeconds !== 'number') return null;
        const held = shortInputs.find((input) => input.id === id);
        if (held) return { held: true, text: heldLengthNote(durationSeconds, held.minimumSeconds, noun) };
        const limits = {
            minDurationSeconds: affordances.minimumLengths.get(slotKey)?.minDurationSeconds,
            maxDurationSeconds: slotKey === 'videoReferences' ? affordances.referenceVideos.maxDurationSeconds : null,
        };
        return { held: false, text: `${lengthReading(durationSeconds, limits)}s ${noun}` };
    };
    const klingClipLengths = new Map(klingVideoElements.map((element) => [element.id, cardLength(element.id, element.durationSeconds, 'videoElements', 'clip')]));
    // The run waits, with its reason beside Generate: Generate, Start new and Try again are off.
    const runHeld = Boolean(promptLimitMessage || shortInputMessage);
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
    // "@" opens the panel only where the prompt can mention something: the references while the
    // inputs show their side (the artboard Inputs), and Kling's video elements and named
    // subjects, which stand beside either side.
    const offersPromptMentions = inputView.side === 'references' || shotMentionCandidates.length > 0 || supportsNamedSubjects || isKlingVideoModel;
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

    /**
     * The uploads of a Prepare or of an Enhance's frames: for the form's account, and stopped if
     * another owner's form takes this one's place. None while the browser holds another account's
     * session (signed in from another tab, before the page has heard): nothing of this form goes up
     * under it.
     */
    const prepareUploads = async (): Promise<TemporaryMediaUploadOptions | null> => {
        const { data: { session } } = await supabase.auth.getSession();
        if (session && formAccount && session.user.id !== formAccount) return null;
        // The form's account even while the browser holds no session: one that lands before the
        // upload reads it is refused there.
        return { userId: formAccount ?? session?.user.id, signal: form.replaced };
    };

    const resolveEnhancerFrameUrl = async (file: File | null, url: string | null): Promise<string | null> => {
        if (url && url.startsWith('https://')) return url;
        if (!file) return null;
        const cached = enhanceFrameUploadCacheRef.current.get(file);
        if (cached && Date.now() - cached.at < ENHANCE_FRAME_CACHE_TTL_MS) {
            return cached.url;
        }
        const uploads = await prepareUploads();
        // Under another account's session the frame stays out of the Enhance.
        if (!uploads) return null;
        const upload = await uploadMediaToTemporaryStorage(file, uploads);
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

    // A remix is loaded once: a refreshed session token (Supabase renews it about hourly)
    // loaded it again and put the original's model and settings back over the creator's, a
    // remix fitted to the balance included.
    const loadedRemixRef = useRef<string | null>(null);
    useEffect(() => {
        if (!remixId) return;
        if (!session?.access_token) return;
        const remixKey = `${remixId}\n${remixPostId ?? ''}`;
        if (loadedRemixRef.current === remixKey) return;

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
                loadedRemixRef.current = remixKey;

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
                // The inputs open on the original's side; what comes back holds them there too.
                setPickedInputSide(restoredVideoInputs?.referenceMode === 'elements' ? 'references' : 'frames');

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

                // The run's frames come back as its frames, but where the Seedance 2 family's
                // restore below takes them for its pictures or leaves them out.
                const restoredStartFrame = createRestoredRemixAssetState(restoredVideoInputs?.startFrame ?? null);
                const restoredEndFrame = createRestoredRemixAssetState(restoredVideoInputs?.endFrame ?? null);
                let restoresFrames = true;
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

                    // A references run of the family kept its pictures as frames before the
                    // family took frames (2026-04-04): those come back as its references. A
                    // frames run gets its frames back as frames, and runs as one again. A run
                    // that brings pictures back is a references run, and frames recorded beside
                    // them (an old run's prepared assets come back as pictures) stay out.
                    const framesWereReferences = restoredSeeds.length === 0
                        && restoredVideoInputs?.referenceMode === 'elements';
                    restoresFrames = restoredSeeds.length === 0 && !framesWereReferences;
                    const legacyFrameSeeds = framesWereReferences
                        ? [restoredStartFrame, restoredEndFrame]
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
	                                // The handle the prompt mentions the clip by: one rebuilt
	                                // from its name and place misses it once a clip was taken away.
	                                handle: item.handle ?? null,
	                                file: null,
	                                previewUrl: item.url,
	                                providerUrl: item.url,
	                                storagePath: item.storagePath ?? null,
	                                source: 'remix' as const,
	                                sourceGenerationId: item.sourceGenerationId ?? null,
	                            }] : []))
	                        : [];
	                    // A run kept before clips had handles hands its clips back with none,
	                    // while its words still name the source's: the words the page may show
	                    // (the source's, or the creator's own if they typed during the load).
	                    const restoredMentions = extractMentionedHandles([
	                        bundle.generation.prompt,
	                        promptRef.current,
	                        ...(Array.isArray(settings?.multiPrompts) ? settings.multiPrompts : []).map((shot) => shot?.prompt),
	                    ]);
	                    commitKlingVideoElements(hydrateKlingVideoElements(klingVideoSeeds, restoredMentions));
                }

                const keptStartFrame = restoresFrames ? restoredStartFrame : null;
                const keptEndFrame = restoresFrames ? restoredEndFrame : null;
                setStartImageFile(null);
                setStartImageUrl(keptStartFrame?.url ?? null);
                setStartFrameDescriptor(keptStartFrame?.descriptor ?? null);
                setEndImageFile(null);
                setEndImageUrl(keptEndFrame?.url ?? null);
                setEndFrameDescriptor(keptEndFrame?.descriptor ?? null);
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
        if (remixId || !draftOwner) {
            return;
        }

        let isMounted = true;
        const key = (name: string) => scopedPersistedMediaKey(name, draftOwner);

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
                if (keepsVisitorForm) {
                    // A form the sign-up's hand-over kept stays as it is, with nothing older of the
                    // account's over it.
                    setMediaRestoredFor({ owner: draftOwner, complete: true });
                    return;
                }

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
                if (isMounted) setMediaRestoredFor({ owner: draftOwner, complete: true });
                // A clip saved without its length is read now, behind the restored draft.
                if (isMounted) {
                    void measureUnreadLengths().catch((err) => console.error('Error measuring restored video media:', err));
                }
            } catch (err) {
                console.error('Error loading persisted video media:', err);
                // A store that cannot say what it holds keeps the saved draft's model.
                if (isMounted) setMediaRestoredFor({ owner: draftOwner, complete: false });
            }
        };

        // The first pick waits for these files when the saved draft holds no words: a store that
        // never answers must not hold it, and past this the draft keeps its model.
        const giveUp = window.setTimeout(() => {
            if (isMounted) setMediaRestoredFor((current) => (current?.owner === draftOwner ? current : { owner: draftOwner, complete: false }));
        }, 3000);
        void loadPersistedMedia().finally(() => window.clearTimeout(giveUp));

        return () => {
            isMounted = false;
            window.clearTimeout(giveUp);
        };
    // Restored once per account; measureUnreadLengths reads the lists as they are when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [remixId, draftOwner]);

    // The saved text draft, read back before the catalog checks the settings against a
    // model. A link's own prompt, model, ratio or length wins over it; what the link
    // leaves alone comes back. A remix restores its source instead.
    useEffect(() => {
        if (remixId || !draftOwner) return;
        let cancelled = false;
        // Words typed on the page win over the saved prompt, typed before the page's script ran
        // included, except over the one carried from sign-up (`creator-draft-prompt.ts`).
        const openingPrompt = prefillPrompt ?? '';
        // The catalog waits for the draft, so a store that never answers must not hold
        // it: past this the page goes on without the draft, and a late one is ignored.
        let settled = false;
        const giveUp = window.setTimeout(() => {
            settled = true;
            if (!cancelled) setDraftRestoredFor(draftOwner);
        }, 3000);
        void loadCreatorDraft<unknown>('video', draftOwner)
            .then((stored) => {
                if (cancelled) return;
                const carried = carriedDraft && !carriedPromptTakenRef.current;
                if (carried) carriedPromptTakenRef.current = true;
                // A form the sign-up's hand-over kept stays as it is, with no older draft of the account's over it.
                if (settled || !stored || keepsVisitorForm) return;
                const draft = readVideoCreatorDraft(stored);
                emptySavedDraftRef.current = draft.modelId && !prefillModel && !draft.prompt?.trim()
                    && !draft.shots?.some((shot) => shot.prompt.trim())
                    ? draft
                    : null;
                const keepsTypedPrompt = !prefillPrompt && keepsPromptOverSavedDraft({
                    boxPrompt: promptRef.current,
                    openingPrompt,
                    savedPrompt: draft.prompt,
                    savedShotPrompts: draft.isMultiShot ? draft.shots?.map((shot) => shot.prompt) : undefined,
                    carried,
                });
                if (draft.prompt !== undefined && !prefillPrompt && !keepsTypedPrompt) setPrompt(draft.prompt);
                if (draft.modelId) {
                    restoredDraftSettingsRef.current = true;
                    setModelSettled(true);
                }
                if (draft.modelId && !prefillModel) {
                    restoredDraftModelRef.current = true;
                    setSelectedModel(draft.modelId as VideoModelId);
                }
                // A draft saved before any model was settled holds what the page drew then beside what the
                // creator changed: only the changes come back, and the rest is this visit's to draw. One saved
                // before the page drew the server's opening (2026-10-29) drew the stand-in.
                const drawnThen: Partial<DrawnVideoSettings> | null = draft.modelId ? null : { ...STAND_IN_FORM, ...draft.drawn };
                // The page itself empties a choice its model does not offer, so an empty one was never the creator's either.
                const changed = <T,>(value: T | undefined, drawnValue: T | undefined): value is T => (
                    value !== undefined && (drawnThen === null || (value !== drawnValue && value !== ''))
                );
                if (changed(draft.mode, drawnThen?.mode)) setMode(draft.mode);
                if (draft.aspectRatio && !prefillAspectRatio && changed(draft.aspectRatio, drawnThen?.aspectRatio)) setAspectRatio(draft.aspectRatio);
                if (changed(draft.sound, drawnThen?.sound)) setSound(draft.sound);
                if (changed(draft.resolution, drawnThen?.resolution)) setResolution(draft.resolution);
                if (changed(draft.fixedLens, drawnThen?.fixedLens)) setFixedLens(draft.fixedLens);
                // A kept prompt stays in sight: a saved multi-shot form would hide its box. Its shots still come back.
                if (!keepsTypedPrompt && changed(draft.isMultiShot, drawnThen?.isMultiShot)) setIsMultiShot(draft.isMultiShot);
                if (draft.shots) setMultiPrompts(draft.shots);
                if (changed(draft.duration, drawnThen?.duration) && !prefillDuration) setSingleDuration(draft.duration);
                if (draft.additionalSettings) pendingAdditionalSettingsRef.current = draft.additionalSettings;
                if (draft.inputSide) setPickedInputSide(draft.inputSide);
            })
            .catch((draftError) => {
                console.error('Error loading the saved video draft:', draftError);
            })
            .finally(() => {
                window.clearTimeout(giveUp);
                settled = true;
                if (!cancelled) setDraftRestoredFor(draftOwner);
            });
        return () => {
            cancelled = true;
            window.clearTimeout(giveUp);
        };
    }, [remixId, draftOwner, carriedDraft, keepsVisitorForm, prefillPrompt, prefillModel, prefillAspectRatio, prefillDuration]);

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
        // The stand-in model is never saved: the next visit takes the catalog's default instead.
        modelId: modelSettled ? selectedModel : '',
        mode,
        aspectRatio,
        sound,
        resolution,
        fixedLens,
        isMultiShot,
        shots: multiPrompts,
        duration: singleDuration,
        additionalSettings: { modelId: selectedModel, values: additionalSettings.settings },
        inputSide: pickedInputSide,
        // Until a model is settled, what the page drew, so the next visit tells it from the creator's own.
        drawn: modelSettled ? undefined : savedVideoFormValues(drawnForm),
    }), [prompt, modelSettled, selectedModel, mode, aspectRatio, sound, resolution, fixedLens, isMultiShot, multiPrompts, singleDuration, additionalSettings.settings, drawnForm, pickedInputSide]);

    const flushTextDraft = useCallback(async () => {
        const unsaved = unsavedDraftRef.current;
        unsavedDraftRef.current = null;
        if (!unsaved) return;
        try {
            await saveCreatorDraft('video', unsaved.owner, {
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
        if (remixId || !draftOwner || draftRestoredFor !== draftOwner) {
            // Not yet read back: nothing is written over the owner's draft.
            unsavedDraftRef.current = null;
            return;
        }
        unsavedDraftRef.current = { owner: draftOwner, draft: textDraft };
        const timer = window.setTimeout(() => {
            void flushTextDraft();
        }, 500);
        return () => window.clearTimeout(timer);
    }, [draftRestoredFor, flushTextDraft, remixId, textDraft, draftOwner]);

    // An edit made in the last half second is not lost when the page goes. A form another owner's
    // has replaced keeps it unsaved: its owner may have just signed out.
    useEffect(() => () => {
        if (!form.replaced.aborted) void flushTextDraft();
    }, [flushTextDraft, form.replaced]);

    /** Saves the form now, for a reload or a sign-in round trip about to leave the page. */
    const saveTextDraftNow = async () => {
        if (!remixId && draftOwner && draftRestoredFor === draftOwner) {
            unsavedDraftRef.current = { owner: draftOwner, draft: textDraft };
        }
        await flushTextDraft();
    };
    /** Asks a visitor to sign up for what they pressed, with the form saved for the way back. */
    const openSignUp = async (reason: CreatorSignUpReason) => {
        await saveTextDraftNow();
        setSignUpReason(reason);
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

    const persistFrame = async (file: File, frame: VideoFrame) => {
        const { refusal } = screenPickedFiles([file], 'image');
        setPickNotice(refusal);
        if (refusal) return;

        setFrame(frame, { file, url: URL.createObjectURL(file), descriptor: null, staged: null });
        const key = savedFrameKey(frame);
        if (key) {
            await setPersistedFile(key, file);
        }
    };

    /** A picture from the creator's own file, as an add and a Replace make it. */
    const uploadedPictureSeed = (file: File, displayName: string) => ({
        displayName,
        file,
        previewUrl: URL.createObjectURL(file),
        source: 'upload' as const,
    });

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

        const newElements = hydrateVideoElements(filesToAdd.map((file, index) => (
            uploadedPictureSeed(file, `Element ${currentElements.length + index + 1}`)
        )));

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

    /**
     * A clip or track from the creator's own file, as an add and a Replace make it. Kie caps
     * the combined length of reference clips and audio, and some models price by it, so the
     * quote is told each one's length (a media element reads a track's as it reads a clip's).
     * A track draws no preview of its own: its row plays the file.
     */
    const uploadedMediaSeed = (kind: 'video' | 'audio', file: File, displayName: string, durationSeconds: number | null) => ({
        displayName,
        file,
        previewUrl: kind === 'video' ? URL.createObjectURL(file) : '',
        source: 'upload' as const,
        durationSeconds,
    });
    /**
     * Picked files' seeds once each length is read, or none when another owner's form took this
     * one's place meanwhile: the files go with the form they were picked on, unsaved. A page that is
     * only left keeps them, saved for its owner's next visit.
     */
    const readPickSeeds = async <Seed extends { previewUrl: string }>(read: Promise<Seed[]>): Promise<Seed[] | null> => {
        const seeds = await read;
        if (!form.replaced.aborted) return seeds;
        seeds.forEach((seed) => revokeObjectUrl(seed.previewUrl));
        return null;
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

        const seeds = await readPickSeeds(Promise.all(filesToAdd.map(async (file, index) => uploadedMediaSeed(
            'video',
            file,
            `Video reference ${referenceVideosRef.current.length + index + 1}`,
            await readVideoDurationSeconds(file),
        ))));
        if (!seeds) return;

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

        const seeds = await readPickSeeds(Promise.all(filesToAdd.map(async (file, index) => ({
            displayName: `Video element ${klingVideoElementsRef.current.length + index + 1}`,
            file,
            previewUrl: URL.createObjectURL(file),
            source: 'upload' as const,
            durationSeconds: await readVideoDurationSeconds(file),
        }))));
        if (!seeds) return;

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

        const seeds = await readPickSeeds(Promise.all(filesToAdd.map(async (file, index) => uploadedMediaSeed(
            'audio',
            file,
            `Audio reference ${referenceAudiosRef.current.length + index + 1}`,
            await readVideoDurationSeconds(file),
        ))));
        if (!seeds) return;

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

    /** Where a frame's file is saved for the creator, or null where nothing is saved (a remix). */
    const savedFrameKey = (frame: VideoFrame) => mediaKey(
        frame === 'start' ? PERSISTED_MEDIA_KEYS.createVideoStartImage : PERSISTED_MEDIA_KEYS.createVideoEndImage,
    );

    /** Sets a frame, or takes it off with null. Its old preview goes with it, unless it is the new one. */
    const setFrame = (frame: VideoFrame, next: {
        file: File | null;
        url: string;
        descriptor: RemixMediaAssetDescriptor | null;
        staged: { file: File; staged: StagedUpload } | null;
    } | null) => {
        const previous = frame === 'start' ? startImageUrl : endImageUrl;
        if (previous !== next?.url) revokeObjectUrl(previous);
        if (frame === 'start') {
            setStartImageFile(next?.file ?? null);
            setStartImageUrl(next?.url ?? null);
            setStartFrameDescriptor(next?.descriptor ?? null);
            setStartFrameStaged(next?.staged ?? null);
        } else {
            setEndImageFile(next?.file ?? null);
            setEndImageUrl(next?.url ?? null);
            setEndFrameDescriptor(next?.descriptor ?? null);
            setEndFrameStaged(next?.staged ?? null);
        }
    };

    const clearImage = async (frame: VideoFrame) => {
        setFrame(frame, null);
        const key = savedFrameKey(frame);
        if (key) {
            await removePersistedMedia(key);
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

    // The inputs' switch (the artboard Inputs). A pick that would clear something asks first,
    // and its yes brings along what the other side can take: frames become references, the
    // first pictures become the free frames. The focus goes back to the side shown.
    const focusInputSwitch = () => {
        requestAnimationFrame(() => {
            inputSwitchRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
        });
    };

    const requestInputSide = async (to: VideoInputSide) => {
        if (to === inputView.side) return;
        const plan = planVideoInputSwitch(inputSides, heldInputs, to, {
            model: videoModel.displayName,
            start: startImageFile?.name ?? null,
            end: endImageFile?.name ?? null,
            pictures: runElements.map((element) => ({ handle: element.handle, name: element.displayName })),
            promptHandles: extractPromptHandles(prompt),
        });
        if (!plan.question) {
            setPickedInputSide(to);
            return;
        }
        // The safe answer comes first and takes the focus, so Enter never clears by accident.
        const confirmed = await confirmInputSwitch({
            title: plan.question.title,
            message: plan.question.message,
            cancelLabel: plan.question.keepLabel,
            confirmLabel: plan.question.confirmLabel,
            // A yes that clears something cannot be taken back.
            tone: plan.question.clears ? 'danger' : undefined,
        });
        focusInputSwitch();
        if (!confirmed) return;
        await (plan.to === 'references' ? moveFramesToReferences(plan) : movePicturesToFrames(plan));
    };

    /**
     * A switch's writes, run once the switch before it is written: each writes its new copy
     * before it takes the old one off, and a switch back answered while the earlier one was still
     * writing had its start image taken off by the earlier one's removal.
     */
    const writeAfterEarlierSwitches = (side: VideoInputSide, writes: () => Promise<void>) => {
        const written = inputSwitchWritesRef.current.then(writes).catch((saveError) => {
            console.error(`Failed to save the inputs moved to ${side}:`, saveError);
        });
        inputSwitchWritesRef.current = written;
        return written;
    };

    const moveFramesToReferences = async (plan: VideoInputSwitch) => {
        const seeds = plan.framesToReferences.flatMap((frame): VideoElementSeed[] => {
            const file = frame === 'start' ? startImageFile : endImageFile;
            const url = frame === 'start' ? startImageUrl : endImageUrl;
            const descriptor = frame === 'start' ? startFrameDescriptor : endFrameDescriptor;
            const staged = frame === 'start' ? startFrameStaged : endFrameStaged;
            if (!url && !file) return [];
            return [{
                file,
                // A preview of its own: the frame's is revoked as the frame goes.
                previewUrl: file ? URL.createObjectURL(file) : url ?? '',
                // A frame with no file of the creator's is a remix's, sent again by its path.
                providerUrl: file ? null : url,
                storagePath: descriptor?.storagePath ?? null,
                source: file ? 'upload' : 'remix',
                sourceGenerationId: descriptor?.sourceGenerationId ?? null,
                staged: file && staged?.file === file ? staged.staged : null,
            }];
        });
        const nextElements = hydrateVideoElements([...elementsRef.current, ...seeds]);
        commitElements(nextElements);
        const frames = [...plan.framesToReferences, ...plan.framesCleared];
        frames.forEach((frame) => setFrame(frame, null));
        setPickedInputSide('references');
        // The new copy is written before the old one goes, so a write that fails loses nothing.
        await writeAfterEarlierSwitches('references', async () => {
            await persistVideoElements(nextElements);
            await persistSeedanceAssets(nextElements, referenceVideosRef.current, referenceAudiosRef.current);
            await Promise.all(frames.map((frame) => {
                const key = savedFrameKey(frame);
                return key ? removePersistedMedia(key) : undefined;
            }));
        });
    };

    const movePicturesToFrames = async (plan: VideoInputSwitch) => {
        const { carries } = affordances;
        const pictures = runElements;
        const moved = new Set<string>();
        const savedFrames: Array<{ frame: VideoFrame; file: File }> = [];
        for (const { index, frame } of plan.picturesToFrames) {
            const element = pictures[index];
            if (!element) continue;
            moved.add(element.id);
            setFrame(frame, {
                file: element.file,
                // An upload's preview moves with its file; a remix's picture is sent again by its path.
                url: element.file ? element.previewUrl : (element.providerUrl ?? element.previewUrl),
                descriptor: element.file ? null : {
                    kind: 'image',
                    label: element.displayName,
                    storagePath: element.storagePath ?? null,
                    sourceGenerationId: element.sourceGenerationId ?? null,
                },
                staged: element.file && element.staged ? { file: element.file, staged: element.staged } : null,
            });
            if (element.file) savedFrames.push({ frame, file: element.file });
        }
        // The prompt's mentions of the pictures read as their names: the run sends none of them.
        if (plan.promptNames.length > 0) {
            const names = new Map(plan.promptNames);
            setPrompt((current) => replacePromptHandles(current, names));
        }
        // Every reference the run carried and the frames did not take goes: pictures, clips
        // and tracks. A kind the model has no slot for stays on standby.
        const nextElements = carries.images ? [] : elementsRef.current;
        if (carries.images) {
            for (const element of elementsRef.current) {
                if (!moved.has(element.id)) revokeObjectUrl(element.previewUrl);
                elementNames.dropDraft(element.id);
            }
            commitElements(nextElements);
        }
        const nextVideos = carries.videos ? [] : referenceVideosRef.current;
        if (carries.videos) {
            referenceVideosRef.current.forEach((reference) => revokeObjectUrl(reference.previewUrl));
            commitReferenceVideos(nextVideos);
        }
        const nextAudios = carries.audios ? [] : referenceAudiosRef.current;
        if (carries.audios) commitReferenceAudios(nextAudios);
        setPickedInputSide('frames');
        // The frames are written before the lists that held them, so a write that fails loses
        // nothing; only the lists that changed are written.
        await writeAfterEarlierSwitches('frames', async () => {
            await Promise.all(savedFrames.map(({ frame, file }) => {
                const key = savedFrameKey(frame);
                return key ? setPersistedFile(key, file) : undefined;
            }));
            await Promise.all([
                carries.images ? persistVideoElements(nextElements) : undefined,
                carries.videos ? persistReferenceVideos(nextVideos) : undefined,
                carries.audios ? persistReferenceAudios(nextAudios) : undefined,
            ]);
            await persistSeedanceAssets(nextElements, nextVideos, nextAudios);
        });
    };

    /** The frames a draft holds beside its references, which the run leaves out, taken off. */
    const removeLeftOutFrames = async () => {
        // The notice goes with them, and the focus it held goes to the switch.
        focusInputSwitch();
        await Promise.all(inputView.framesLeftOut.map((frame) => clearImage(frame)));
    };

    // Replace on a remix's reference (the artboard Remix): a file of the creator's own takes
    // its place, with its name and @handle, so the prompt still reads. It is an upload now,
    // sent as one, and stays replaceable.
    const replaceElement = async (elementId: string, file: File) => {
        const { refusal } = screenPickedFiles([file], 'image');
        setPickNotice(refusal);
        if (refusal) return;
        const current = elementsRef.current;
        const target = current.find((element) => element.id === elementId);
        if (!target) return;
        revokeObjectUrl(target.previewUrl);
        const nextElements = hydrateVideoElements(current.map((element): VideoElementSeed => (element.id === elementId ? {
            ...uploadedPictureSeed(file, element.displayName),
            id: element.id,
            handle: element.handle,
            restoredFromRemix: element.restoredFromRemix,
        } : element)));
        commitElements(nextElements);
        await persistVideoElements(nextElements);
        await persistSeedanceAssets(nextElements, referenceVideosRef.current, referenceAudiosRef.current);
    };

    const replaceMediaReference = async (kind: 'video' | 'audio', referenceId: string, file: File) => {
        const { refusal } = screenPickedFiles([file], kind);
        setPickNotice(refusal);
        if (refusal) return;
        const latestPicks = latestReplacePicksRef.current;
        latestPicks.set(referenceId, file);
        const durationSeconds = await readVideoDurationSeconds(file);
        // A newer pick for the same reference won while this one was measured.
        if (latestPicks.get(referenceId) !== file) return;
        latestPicks.delete(referenceId);
        // Read now, not before the measuring: the list may have changed meanwhile.
        const current = kind === 'video' ? referenceVideosRef.current : referenceAudiosRef.current;
        const target = current.find((reference) => reference.id === referenceId);
        if (!target) return;
        const [replaced] = hydrateSeedanceMediaReferences(kind === 'video' ? 'Video' : 'Audio', [{
            ...uploadedMediaSeed(kind, file, target.displayName, durationSeconds),
            id: target.id,
            restoredFromRemix: target.restoredFromRemix,
        }]);
        revokeObjectUrl(target.previewUrl);
        const nextReferences = current.map((reference) => (reference.id === referenceId ? replaced : reference));
        if (kind === 'video') {
            commitReferenceVideos(nextReferences);
            await persistReferenceVideos(nextReferences);
            await persistSeedanceAssets(elementsRef.current, nextReferences, referenceAudiosRef.current);
        } else {
            commitReferenceAudios(nextReferences);
            await persistReferenceAudios(nextReferences);
            await persistSeedanceAssets(elementsRef.current, referenceVideosRef.current, nextReferences);
        }
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
        // The prompt follows the new handle at once, with the card: a switch or Generate pressed
        // while the write below runs reads the two together (a tap on Frames blurs the name
        // field, and the switch's question read the old handle in the prompt).
        if (replacements.size > 0) {
            setPrompt((currentPrompt) => {
                const nextPrompt = replacePromptHandles(currentPrompt, replacements);
                requestAnimationFrame(() => updateMentionState(nextPrompt));
                return nextPrompt;
            });
        } else {
            requestAnimationFrame(() => updateMentionState(prompt));
        }
        await persistVideoElements(nextElements);
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
        // The prompts follow the new handle at once, with the card, as a picture's rename does: a
        // Generate pressed while the write below runs reads the two together.
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
        } else {
            requestAnimationFrame(() => updateMentionState(prompt));
        }
        await persistKlingVideoElements(nextElements);
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

    // Typed into the server's HTML before this page's script ran, where no React heard it.
    useTypedBeforeHydration(promptTextareaRef, { drawn: prompt, enabled: !remixId && !prefillPrompt, onTyped: handlePromptChange });

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
        // Not under a session another account has taken since (signed in from another tab, before
        // the page has heard): the asset would be that account's.
        if (formAccount && session.user.id !== formAccount) throw new UploadCancelledError();

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

    const ensureUploadedElement = async (element: VideoElementDraft, press: TemporaryMediaUploadOptions): Promise<VideoElementDraft> => {
        if (!element.file) {
            return element;
        }

        const staged = await stageReferenceFile(element.file, element.staged, press);
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
        assetType: SeedanceAssetKind,
        press: TemporaryMediaUploadOptions,
    ): Promise<SeedanceMediaReferenceDraft> => {
        if (!reference.file) {
            return reference;
        }

        const staged = await stageReferenceFile(reference.file, reference.staged, press);
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
        element: KlingVideoElementDraft,
        press: TemporaryMediaUploadOptions,
    ): Promise<KlingVideoElementDraft> => {
        if (!element.file) {
            return element;
        }

        const staged = await stageReferenceFile(element.file, element.staged, press);
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

    // One Seedance asset step on a card: `updater` makes it from the card as the step starts
    // (null when the card is no longer the one the step was for), and it lands on the card as
    // it is once the step ends (`landAssetStep`). Null when it did not land.
    const updateElementAsset = async (
        elementId: string,
        updater: (element: VideoElementDraft) => Promise<VideoElementDraft | null> | VideoElementDraft | null
    ) => {
        const before = elementsRef.current.find((element) => element.id === elementId);
        const after = before ? await updater(before) : null;
        const nextElements = before && after ? landAssetStep(elementsRef.current, before, after) : null;
        if (!nextElements) return null;
        commitElements(nextElements);
        await persistVideoElements(nextElements);
        await persistSeedanceAssets(nextElements, referenceVideosRef.current, referenceAudiosRef.current);
        return nextElements.find((element) => element.id === elementId) ?? null;
    };

    const updateReferenceVideoAsset = async (
        referenceId: string,
        updater: (reference: SeedanceMediaReferenceDraft) => Promise<SeedanceMediaReferenceDraft | null> | SeedanceMediaReferenceDraft | null
    ) => {
        const before = referenceVideosRef.current.find((reference) => reference.id === referenceId);
        const after = before ? await updater(before) : null;
        const nextReferences = before && after ? landAssetStep(referenceVideosRef.current, before, after) : null;
        if (!nextReferences) return null;
        commitReferenceVideos(nextReferences);
        await persistReferenceVideos(nextReferences);
        await persistSeedanceAssets(elementsRef.current, nextReferences, referenceAudiosRef.current);
        return nextReferences.find((reference) => reference.id === referenceId) ?? null;
    };

    const updateReferenceAudioAsset = async (
        referenceId: string,
        updater: (reference: SeedanceMediaReferenceDraft) => Promise<SeedanceMediaReferenceDraft | null> | SeedanceMediaReferenceDraft | null
    ) => {
        const before = referenceAudiosRef.current.find((reference) => reference.id === referenceId);
        const after = before ? await updater(before) : null;
        const nextReferences = before && after ? landAssetStep(referenceAudiosRef.current, before, after) : null;
        if (!nextReferences) return null;
        commitReferenceAudios(nextReferences);
        await persistReferenceAudios(nextReferences);
        await persistSeedanceAssets(elementsRef.current, referenceVideosRef.current, nextReferences);
        return nextReferences.find((reference) => reference.id === referenceId) ?? null;
    };


    const prepareElementSeedanceAsset = async (elementId: string) => {
        // Preparing uploads the file, which takes an account.
        if (isVisitor) {
            await openSignUp('prepare');
            return;
        }
        const activeKey = createSeedanceAssetKey('image', elementId);
        setActiveSeedanceAssetKey(activeKey);

        try {
            const uploads = await prepareUploads();
            if (!uploads) return;
            const uploadedElement = await updateElementAsset(elementId, (element) => ensureUploadedElement(element, uploads));
            // Gone, or replaced while it uploaded: the card has nothing of its own to prepare yet.
            if (!uploadedElement) return;

            const sourceUrl = uploadedElement.storagePath || uploadedElement.providerUrl;
            if (!sourceUrl) {
                throw new Error('Missing image source URL.');
            }

            const asset = await requestSeedanceAsset(sourceUrl, 'Image');
            // Not on a file that replaced the prepared one meanwhile (Replace keeps the card's id).
            await updateElementAsset(elementId, (element) => (
                element.file === uploadedElement.file ? { ...element, seedanceAsset: asset } : null
            ));
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
            // Only while the card still holds the asset refreshed: a Replace meanwhile dropped it.
            await updateElementAsset(elementId, (element) => (
                element.seedanceAsset.assetId === assetId ? { ...element, seedanceAsset: asset } : null
            ));
        } finally {
            setActiveSeedanceAssetKey((current) => current === activeKey ? null : current);
        }
    };

    const prepareReferenceSeedanceAsset = async (
        kind: 'video' | 'audio',
        referenceId: string
    ) => {
        if (isVisitor) {
            await openSignUp('prepare');
            return;
        }
        const activeKey = createSeedanceAssetKey(kind, referenceId);
        setActiveSeedanceAssetKey(activeKey);

        try {
            const uploads = await prepareUploads();
            if (!uploads) return;
            if (kind === 'video') {
                const uploadedReference = await updateReferenceVideoAsset(referenceId, (reference) => ensureUploadedReference(reference, 'Video', uploads));
                // Gone, or replaced while it uploaded.
                if (!uploadedReference) return;

                const sourceUrl = uploadedReference.storagePath || uploadedReference.providerUrl;
                if (!sourceUrl) {
                    throw new Error('Missing video source URL.');
                }

                const asset = await requestSeedanceAsset(sourceUrl, 'Video');
                await updateReferenceVideoAsset(referenceId, (reference) => (
                    reference.file === uploadedReference.file ? { ...reference, seedanceAsset: asset } : null
                ));
                return;
            }

            const uploadedReference = await updateReferenceAudioAsset(referenceId, (reference) => ensureUploadedReference(reference, 'Audio', uploads));
            if (!uploadedReference) return;

            const sourceUrl = uploadedReference.storagePath || uploadedReference.providerUrl;
            if (!sourceUrl) {
                throw new Error('Missing audio source URL.');
            }

            const asset = await requestSeedanceAsset(sourceUrl, 'Audio');
            await updateReferenceAudioAsset(referenceId, (reference) => (
                reference.file === uploadedReference.file ? { ...reference, seedanceAsset: asset } : null
            ));
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
            // Only while the card still holds the asset refreshed: a Replace meanwhile dropped it.
            const refreshed = (reference: SeedanceMediaReferenceDraft) => (
                reference.seedanceAsset.assetId === assetId ? { ...reference, seedanceAsset: asset } : null
            );

            if (kind === 'video') {
                await updateReferenceVideoAsset(referenceId, refreshed);
                return;
            }

            await updateReferenceAudioAsset(referenceId, refreshed);
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

    // `followed`: the creator started this run here, so its end moves the focus; a run picked up on load leaves the page be.
    const handleRunFailure = (runError: unknown, startedAtMs: number, cost: number | null, followed: boolean) => {
        // The page went away under the poll; the run is not this page's to report.
        if (isGenerationStatusAbortError(runError)) return;
        if (runError instanceof Error && runError.message === BACKGROUND_PROCESSING_ERROR) {
            handoffToBackgroundProcessing(startedAtMs);
            return;
        }
        if (runError instanceof VideoRunFailedError) {
            // A failed run is refunded, and the balance on screen is still the debited one.
            window.dispatchEvent(new Event('credits_updated'));
            setRunFailure({ message: runError.message, cost });
            if (followed) setRunEndKey((key) => key + 1);
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
     * keeps the attempt, and the column's bar offers to check again under its key. A
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
            // The balance on screen was out of date. It is read again, and the column's bar
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
     * page where it is. It goes only under the session of the account it is for: one another
     * account has taken since (signed in from another tab, before the page has heard) sends
     * nothing, and a start being checked again stays, to be checked under its own.
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
            if (attempt.userId && activeSession && activeSession.user.id !== attempt.userId) {
                setGenerationTiming(null);
                return;
            }
            // Kept before it is sent: with no answer, the next press and the next visit
            // replay this key and body instead of paying for a second run.
            savePendingWebStart(attempt);
            started = await requestWebGenerationStart(attempt.body as CatalogGenerationRequestPayload, {
                accessToken: activeSession?.access_token ?? null,
                idempotencyKey: attempt.idempotencyKey,
            });
        } catch (startError) {
            if (unmountSignal.current.aborted) {
                // The page went while the start was out. A refusal settles it, so the next visit does
                // not send it again; an answer that may yet mean it started stays kept, to be checked.
                if (!isAmbiguousWebStartFailure(startError)) clearPendingWebStart('video', attempt.idempotencyKey);
                return;
            }
            await handleStartFailure(startError, attempt);
            return;
        }

        if (unmountSignal.current.aborted) {
            // The page went while the start was out: it was left, or another owner's form took its
            // place. The run is the server's and the start has done its work. The balance is read
            // again for whoever holds the session now, rather than set to the one this start
            // answered, and nothing here follows the run.
            clearPendingWebStart('video', attempt.idempotencyKey);
            announceGenerationStarted();
            window.dispatchEvent(new Event('credits_updated'));
            return;
        }
        // The answer names the run: the attempt has done its work.
        clearPendingWebStart('video');
        setUnconfirmedStart(null);
        quoteState.started(attempt.body as CatalogGenerationRequestPayload);
        try {
            setLatestGenerationId(started.generationId ?? null);
            announceGenerationStarted();
            updateCredits(started.remainingCredits);
            if (reveal) setCanvasRevealKey((key) => key + 1);
            const held = typeof started.cost === 'number' ? started.cost : null;
            setRunShape((current) => (current ? { ...current, cost: held ?? current.cost, answered: true } : current));

            const result = await pollPrediction(started.predictionId, startedAtMs, estimatedTotalMs);
            setOutputVideo(result.output);
            if (reveal) setRunEndKey((key) => key + 1);
            if (result.timing) {
                setGenerationTiming(result.timing);
            }
        } catch (runError) {
            handleRunFailure(runError, startedAtMs, started.cost, reveal);
        }
    };

    /** "Check again": the unanswered start, replayed with the exact body under the same key. */
    const replayPendingStart = async (attempt: PendingWebStart, { reveal = false }: { reveal?: boolean } = {}) => {
        if (activeGenerationRequestKeyRef.current) return;
        activeGenerationRequestKeyRef.current = attempt.idempotencyKey;
        setRunShape((current) => current ?? runShapeOfStart(attempt.body));
        const startedAtMs = getCurrentTimestampMs();
        setIsGenerating(true);
        setError(null);
        setRunFailure(null);
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


    // Puts the form on a model with these settings: the creator's pick, or a remix fitted to the balance.
    const switchModel = (modelId: VideoModelId, settings: VideoFormSettings) => {
        const nextModel = VIDEO_MODELS[modelId];

        // A notice about the previous model no longer applies.
        if (modelId !== selectedModel) setCatalogNotice(null);
        // The creator's pick is the first pick: the catalog's default no longer replaces it.
        hasResolvedInitialCatalogModel.current = true;
        setModelSettled(true);
        setSelectedModel(modelId);
        setMode(settings.mode);
        setAspectRatio(settings.aspectRatio);
        setSingleDuration(settings.duration);
        setResolution(settings.resolution);
        setSound(settings.sound);
        setFixedLens(settings.fixedLens);
        setPromptQualityWarnings([]);
        setMultiPromptQualityWarnings({});

        if (!nextModel.supportsMultiShot) {
            setIsMultiShot(false);
        }

        // A model that takes no end frame drops the one the form holds: its catalog descriptor
        // says so once the catalog has reached the registry, the fallback tables before. A list
        // kept here went stale when Grok Imagine Video 1.5 gained an end frame (2026-10-29).
        const takesEndFrame = getVideoInputAffordances(
            (nextModel as { catalogDescriptor?: GenerationModelDescriptor }).catalogDescriptor,
            modelId,
        ).frames.end;
        if (!takesEndFrame && endImageUrl) {
            void clearImage('end');
        }
    };

    // A model picked from the list opens on this run's settings where it offers them, the
    // run its row priced (owner, 2026-10-28): it used to open on its first options.
    const handleSelectModel = (modelId: VideoModelId) => {
        switchModel(modelId, modelRuns.get(modelId)?.settings ?? fitVideoFormToModel(modelId, pageForm));
        setIsModelDropdownOpen(false);
        setModelSearchQuery('');
    };

    // A remix opens fitted to the balance (owner, 2026-10-28), decided once, when the original's
    // price first comes in: the original while the balance covers it, else the catalog's default
    // video when it takes the same inputs and fits, else the cheapest model that does, at the
    // same length when that fits (`fitRemixToBalance`).
    const remixReadyToWeigh = Boolean(remixId) && !isRemixLoading && !isVisitor && userCredits !== null
        && modelSettled && remixFit === null && quoteState.status === 'ready' && estimatedCost !== null;
    useEffect(() => {
        if (!remixReadyToWeigh || estimatedCost === null || userCredits === null) return;
        const original = { modelId: selectedModel, settings: pageForm, cost: estimatedCost, durationSeconds: totalDuration };
        setRemixFit(estimatedCost <= userCredits ? { original, stage: 'settled', fitted: null } : { original, stage: 'pricing' });
    // Weighed once, from the render that first has the original's price.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [remixReadyToWeigh]);
    // While it is decided, a creator who moves off the original (picks a model, changes a
    // setting) has chosen, and a balance that now covers the original needs no fitting:
    // either settles it where the creator is.
    const remixLeftAlone = remixFit !== null && remixFit.stage !== 'settled'
        && selectedModel === remixFit.original.modelId
        && sameVideoFormSettings(pageForm, remixFit.original.settings)
        && !(estimatedCost !== null && userCredits !== null && estimatedCost <= userCredits);
    /** The run on `modelId` the remix opens on, at its listed price; null when it is not priced. */
    const remixFittedOn = (modelId: string, sameLength: boolean): RemixFitted | null => {
        const run = modelRuns.get(modelId);
        const cost = run ? readyCost(priceOf(run.quoteInput)) : null;
        return run && cost !== null ? { modelId: run.modelId as VideoModelId, settings: run.settings, cost, sameLength } : null;
    };
    // While it is decided the page is on the original, so its price now is the original's
    // (its inputs may have changed since it was weighed).
    const remixOriginalNow = remixFit ? { ...remixFit.original, cost: affordCost ?? remixFit.original.cost } : null;
    const settleRemix = (fitted: RemixFitted | null) => {
        if (!remixOriginalNow) return;
        if (fitted) switchModel(fitted.modelId, fitted.settings);
        setRemixFit({ original: remixOriginalNow, stage: 'settled', fitted });
    };
    useEffect(() => {
        if (remixFit?.stage !== 'pricing' || userCredits === null) return;
        if (!remixLeftAlone) {
            settleRemix(null);
            return;
        }
        if (!remixPricesIn) return;
        const originalRun = { inputs: runInputs, settings: remixFit.original.settings };
        const decision = fitRemixToBalance({
            original: remixOriginalNow ?? remixFit.original,
            balance: userCredits,
            preferredModelId: modelCatalog.catalog?.defaults.video ?? null,
            candidates: [...modelRuns.values()].map((run) => ({
                modelId: run.modelId,
                cost: readyCost(priceOf(run.quoteInput)),
                durationSeconds: run.durationSeconds,
                takesInputs: takesSameVideoInputs(originalRun, run),
            })),
        });
        const shortenOn = decision.kind === 'shorten' ? modelRuns.get(decision.modelId) : undefined;
        if (decision.kind === 'original') {
            settleRemix(null);
        } else if (decision.kind === 'fitted') {
            settleRemix(remixFittedOn(decision.modelId, decision.sameLength));
        } else if (!shortenOn) {
            settleRemix(null);
        } else {
            setRemixFit({
                original: remixOriginalNow ?? remixFit.original,
                stage: 'shortening',
                shortenOn: { modelId: shortenOn.modelId as VideoModelId, settings: shortenOn.settings, belowSeconds: decision.durationSeconds },
                otherwise: decision.otherwise ? remixFittedOn(decision.otherwise.modelId, decision.otherwise.sameLength) : null,
            });
        }
    // It decides from the prices as they come in; the switch is this render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [remixFit, remixLeftAlone, remixPricesIn, userCredits]);
    useEffect(() => {
        if (remixFit?.stage !== 'shortening' || userCredits === null) return;
        if (!remixLeftAlone) {
            settleRemix(null);
            return;
        }
        const prices = shortenRuns.map((run) => ({ run, price: priceOf(run.quoteInput) }));
        if (prices.some(({ price }) => price.status === 'pending' || price.status === 'unavailable')) return;
        const length = longestLengthWithin(
            prices.map(({ run, price }) => ({ durationSeconds: run.durationSeconds, cost: readyCost(price) })),
            userCredits,
            remixFit.shortenOn.belowSeconds,
        );
        const chosen = prices.find(({ run }) => run.durationSeconds === length);
        const cost = chosen ? readyCost(chosen.price) : null;
        if (chosen && cost !== null) {
            settleRemix({ modelId: chosen.run.modelId as VideoModelId, settings: chosen.run.settings, cost, sameLength: false });
            return;
        }
        // No shorter length fits: the cheapest model that fits at a length of its own, else the original.
        settleRemix(remixFit.otherwise);
    // It decides once every shorter length's price is in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [remixFit, remixLeftAlone, shortenRuns, priceOf, userCredits]);

    useEffect(() => {
        // Dropped when the page goes (development's Strict Mode mounts it twice) and at a
        // press: a run it found then would get a follower nothing stops, or take the page
        // from the creator's own run.
        const lookup = new AbortController();
        activeRunLookupRef.current = lookup;
        const resumePendingGeneration = async () => {
            const { data: { session } } = await supabase.auth.getSession();
            // Another account's session the page has not heard of yet picks up nothing: the creator
            // is drawn anew for that account once it has.
            if (!session || (formAccount && session.user.id !== formAccount)) return;

            // A start this tab sent and never heard back from goes first. Replayed under
            // its own key, it answers with the run it started, or starts it once.
            const unanswered = loadPendingWebStart('video', session.user.id);
            if (unanswered) {
                await replayPendingStart(unanswered);
                return;
            }

            // Asked of the server: the browser may not read a run's prompt, cost or model.
            const run = await fetchCreatorActiveRun({ tool: 'video', accessToken: session.access_token, signal: lookup.signal });
            // One run on the page at a time, held as a press holds it.
            if (!run || lookup.signal.aborted || activeGenerationRequestKeyRef.current) return;
            activeGenerationRequestKeyRef.current = `resume:${run.predictionId}`;

            const startedAtMs = Number.isNaN(Date.parse(run.createdAt)) ? Date.now() : Date.parse(run.createdAt);

            setIsGenerating(true);
            setError(null);
            setLatestGenerationId(run.id);
            setRunShape({
                aspectRatio: null,
                label: videoModelName(run.model),
                prompt: run.prompt?.trim() || null,
                cost: run.cost,
                answered: true,
            });
            setGenerationTiming(createLocalGenerationTiming({
                kind: 'video',
                phaseLabel: 'Resuming active run',
                startedAtMs,
                appStatus: run.status,
            }));

            try {
                const result = await pollPrediction(run.predictionId, startedAtMs, null);
                setOutputVideo(result.output);
                if (result.timing) {
                    setGenerationTiming(result.timing);
                }
            } catch (generationError) {
                handleRunFailure(generationError, startedAtMs, run.cost, false);
            } finally {
                activeGenerationRequestKeyRef.current = null;
                setIsGenerating(false);
            }
        };

        void resumePendingGeneration();
        return () => lookup.abort();
        // Recovery is intentionally a mount-only lookup; changing form settings must not restart it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const isBackgroundProcessing = error === BACKGROUND_PROCESSING_ERROR;
    // Watched while idle only: a reload mid-upload or mid-start lost the run's page. A page
    // left hidden reloads by itself; one in use reloads at the next press instead of sending.
    const { newBuildAvailable } = useDeploymentRefresh(!isGenerating && !isBackgroundProcessing);

    const handleGenerate = async ({ replacingUnconfirmed = false }: { replacingUnconfirmed?: boolean } = {}) => {
        if (activeGenerationRequestKeyRef.current) return;
        // A new run takes the publish form away: a publish in flight is let finish first.
        if (canvasPublish.inFlight) return;
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
        if (runHeld) return;

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

        if (isVisitor) {
            // Signed out: the sign-up comes back here, on this page's own link, with the
            // draft saved, and nothing runs until Generate is pressed again.
            await openSignUp('generate');
            return;
        }

        // Held from here, so a second click while the session is read sends nothing.
        const idempotencyKey = createGenerationIdempotencyKey('video');
        activeGenerationRequestKeyRef.current = idempotencyKey;
        activeRunLookupRef.current?.abort();

        // A newer build was deployed since this page loaded. The run is not sent from the
        // old one: the draft is saved and the page reloads onto the new build.
        if (newBuildAvailable) {
            await reloadPage();
            activeGenerationRequestKeyRef.current = null;
            return;
        }

        // The run takes the canvas at the press, before the session is read, as the image
        // creator's does: a finished result's publish form goes with it, so no publish can
        // start while the session read is awaited (Generate waits for one already sent).
        setIsGenerating(true);
        setError(null);
        setRunFailure(null);
        setCreditRefusal(null);
        setOutputVideo(null);
        setLatestGenerationId(null);
        setRunShape({
            aspectRatio: currentAspectRatio,
            label: `${videoModel.displayName} · ${settingsSummary}`,
            prompt: currentIsMultiShot ? shotsPrompt(multiPrompts) : prompt.trim() || null,
            cost: estimatedCost,
            answered: false,
        });
        const startedAtMs = getCurrentTimestampMs();
        const estimatedTotalMs = estimatedGenerationTotalMs;
        setGenerationTiming(createLocalGenerationTiming({
            kind: 'video',
            phaseLabel: 'Preparing inputs',
            startedAtMs,
            estimatedTotalMs,
        }));

        const { data: { session: activeSession } } = await supabase.auth.getSession();
        if (!activeSession) {
            // The session lapsed since the page opened: back here after signing in, on this
            // page's own link, with the draft saved under the account it belongs to.
            activeGenerationRequestKeyRef.current = null;
            setIsGenerating(false);
            setGenerationTiming(null);
            // A page that has gone sends no one to sign in.
            if (unmountSignal.current.aborted) return;
            await saveTextDraftNow();
            router.push(`/login?returnUrl=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
            return;
        }
        // The press is the form's account's: under a session another account has taken since
        // (signed in from another tab, before the page has heard), nothing goes up or out.
        if (formAccount && activeSession.user.id !== formAccount) {
            activeGenerationRequestKeyRef.current = null;
            setIsGenerating(false);
            setGenerationTiming(null);
            return;
        }
        // A page that is only left goes on with its press; another owner's form in its place stops it.
        const press: TemporaryMediaUploadOptions = { userId: activeSession.user.id, signal: form.replaced };

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

                const preparedElements = await Promise.all(imageReferenceInputs.map((input) => ensureUploadedElement(input.element, press)));
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
                const preparedReferences = await Promise.all(referenceVideoInputs.map((input) => ensureUploadedReference(input.reference, 'Video', press)));
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
                const preparedReferences = await Promise.all(referenceAudioInputs.map((input) => ensureUploadedReference(input.reference, 'Audio', press)));
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
                    const preparedElement = await ensureUploadedKlingVideoElement(element, press);
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
                        staged = await stageReferenceFile(image.file, image.staged, press);
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
                // Keep the uploaded URLs so a retry does not re-upload the set: on the subjects the
                // form holds now, as each list above.
                commitKlingSubjects(klingSubjectsRef.current.map((subject) => ({
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
                        press,
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
                        press,
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

            // The price on Generate goes with the run when it is this run's own quote.
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
        } catch (prepareError) {
            // An upload the press gave up, for the creator going or for another account's
            // session, is no failure of the creator's to show.
            if (!isUploadCancelledError(prepareError)) {
                setError(prepareError instanceof Error ? prepareError.message : 'Something went wrong');
            }
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

    /**
     * The balance a paid Enhance answers with. One that answers after the page went (it was left, or
     * another owner's form took its place) is read again for whoever holds the session instead.
     */
    const reportEnhanceBalance = (credits: number) => {
        if (unmountSignal.current.aborted) {
            window.dispatchEvent(new Event('credits_updated'));
            return;
        }
        updateCredits(credits);
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

    // The line under the inputs' switch, and a frame's slot: the start image's shows on either
    // side of Wan 2.7 (its reference endpoint takes a first frame beside the references).
    const inputsHint = videoInputsHint({
        view: inputView,
        sides: inputSides,
        model: videoModel.displayName,
        held: heldInputs,
        remixPictures: runElements.filter((element) => element.restoredFromRemix).length,
        subjectsHeld: klingSubjectsActive,
    });
    const renderFrameSlot = (frame: VideoFrame, hint?: string) => {
        const title = frame === 'start' ? 'Start image' : 'End image';
        const src = frame === 'start' ? startImageUrl : endImageUrl;
        const setDragging = frame === 'start' ? setIsDraggingStart : setIsDraggingEnd;
        return (
            <CreatorUploadSlot
                accent="video"
                title={title}
                hint={hint}
                status={frame === 'start' && startFrameRequired ? 'required' : 'optional'}
                height="frame"
                mediaType="image"
                src={src}
                alt={title}
                previewHint="Preview"
                icon={ImagePlus}
                emptyLabel="Add"
                input={{
                    id: `video-${frame}-frame-input`,
                    accept: 'image/*',
                    // The tile reads "Add" beside its heading; the field says which frame it adds.
                    'aria-label': frame === 'start' ? 'Add a start image' : 'Add an end image',
                    onChange: (event) => handleImageUpload(event, frame),
                }}
                onPreview={() => {
                    if (src) setUploadPreview({ type: 'image', src, alt: title, title });
                }}
                onRemove={() => void clearImage(frame)}
                dragging={frame === 'start' ? isDraggingStart : isDraggingEnd}
                onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                onDragLeave={(event) => { event.preventDefault(); setDragging(false); }}
                onDrop={(event) => handleImageDrop(event, frame)}
            />
        );
    };

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
    const backgroundProcessingCopy = getBackgroundProcessingCopy('video');
    const backgroundTiming = generationTiming ? freezeGenerationTiming(generationTiming, nowMs) : null;
    const backgroundTimingLabel = backgroundTiming ? getGenerationTimingSummaryLabel(backgroundTiming, nowMs) : null;

    // The run's own prompt, not the form's: the form may hold the next run's by now.
    const runPrompt = runShape?.prompt ?? null;

    // The canvas says where the run is (the artboards Main, Generating, Failed and Result),
    // and its chip what the run is and holds.
    const canvasTitle = creatorCanvasTitle(canvasPhase, { making: 'Making your video', waiting: 'Your video' });
    const canvasChip = creatorCanvasChip(canvasPhase, runShape?.label, runShape?.cost);
    const showsEmptyCanvas = canvasPhase === 'empty';
    const showsRunFailure = canvasPhase === 'failed';
    // What the run needs, as the column's cards ask for it.
    const emptyCanvasHint = currentIsMultiShot
        ? 'Write each shot, then Generate.'
        : klingSubjectsActive
            ? 'Write a prompt that names your subjects, then Generate.'
            : inputView.side === 'references'
                ? 'Write a prompt, add references if you like, then Generate.'
                : startFrameRequired
                    ? startImageUrl || startImageFile
                        ? 'Write a prompt, then Generate.'
                        : 'Add a start frame and write a prompt, then Generate.'
                    : 'Write a prompt, add frames if you like, then Generate.';

    const isAwaitingStartCheck = Boolean(unconfirmedStart) && !isGenerating;
    // What stops or explains a run, said just above the bar. Progress is drawn on the
    // canvas; a run in the background is named here too, beside Generate.
    const runStatus = isGenerating ? null : isBackgroundProcessing ? (
        <CreatorBackgroundRunLine title={backgroundProcessingCopy.title} />
    ) : unconfirmedStart ? (
        <CreatorPendingStartNotice
            message={START_UNCONFIRMED_MESSAGE}
            costLabel={quoteUi.costLabel}
            hasPrice={estimatedCost !== null}
            disabled={quotePending || runHeld}
            onStartNew={startNewRunInstead}
        />
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
    // A remix moved back to its original that the balance does not cover: the run it was fitted
    // to is one press away (owner, 2026-10-28; the artboard "Short").
    const remixFitted = remixFit?.stage === 'settled' ? remixFit.fitted : null;
    const onFittedRemix = remixFitted !== null && selectedModel === remixFitted.modelId;
    const onRemixOriginal = remixFitted !== null && remixFit !== null && selectedModel === remixFit.original.modelId;
    const offersFittedRemix = onRemixOriginal && balanceShort && !isGenerating && !isAwaitingStartCheck
        && userCredits !== null && affordCost !== null;
    const fittedName = remixFitted ? VIDEO_MODELS[remixFitted.modelId]?.displayName ?? remixFitted.modelId : '';
    const originalName = remixFit ? VIDEO_MODELS[remixFit.original.modelId]?.displayName ?? remixFit.original.modelId : '';
    // "the same prompt, references and 5s", or "the same prompt and references at 4s".
    const fittedKeeps = (() => {
        if (!remixFit || !remixFitted) return '';
        const things = [currentIsMultiShot ? 'shots' : 'prompt'];
        if (pageTally.references > 0) things.push('references');
        else if (pageTally.frames > 0) things.push(pageTally.frames === 1 ? 'frame' : 'frames');
        const listed = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]);
        return remixFitted.sameLength
            ? `the same ${listed([...things, `${remixFit.original.durationSeconds}s`])}`
            : `the same ${listed(things)} at ${remixFitted.settings.duration}s`;
    })();
    const shortOfEveryVideoShown = offersImageInstead && !isGenerating && !isAwaitingStartCheck;
    const topUpNotice = showTopUp && !isAwaitingStartCheck && !isGenerating && !offersFittedRemix && !shortOfEveryVideoShown ? (
        <CreatorTopUpNotice cost={estimatedCost} balance={userCredits} message={creditRefusal?.message ?? null} />
    ) : null;
    const fitNotice = offersFittedRemix && remixFitted && userCredits !== null && affordCost !== null ? (
        <CreatorFitNotice
            original={{ name: originalName, cost: affordCost }}
            balance={userCredits}
            fitted={{ name: fittedName, cost: remixFitted.cost, keeps: fittedKeeps }}
        />
    ) : null;
    // A line of its own, so no other status (a pick's notice, an unanswered start) hides why
    // Generate is off. It names the clip as the creator named it, which can be a word no line holds.
    const shortInputLine = shortInputMessage && !isGenerating ? (
        <p className="text-red-400 [overflow-wrap:anywhere]">{shortInputMessage}</p>
    ) : null;
    const barStatus = fitNotice || topUpNotice || runStatus || shortInputLine ? (
        <div className="space-y-3">
            {fitNotice}
            {topUpNotice}
            {runStatus}
            {shortInputLine}
        </div>
    ) : null;

    // Check again goes through Generate's own path, which checks an unanswered start first.
    // A visitor's press needs no price: it checks the form, then asks for an account.
    const barAction = offersFittedRemix && remixFitted ? (
        <button type="button" onClick={() => switchModel(remixFitted.modelId, remixFitted.settings)} className={CREATOR_BAR_PRIMARY_CLASS}>
            <span className="truncate">Switch back to {fittedName}</span>
        </button>
    ) : shortOfEveryVideoShown && imageOffer ? (
        <CreatorMakeImageInstead href={makeImageInsteadHref(imageOffer.modelId, prompt)} fromCost={imageOffer.cost} />
    ) : (
        <CreatorBarAction
            awaitingCheck={isAwaitingStartCheck}
            onCheckAgain={() => void handleGenerate()}
            showTopUp={showTopUp}
            isGenerating={isGenerating}
            disabled={(!isVisitor && quotePending) || runHeld || canvasPublish.inFlight}
            costLabel={quoteUi.costLabel}
            hasPrice={estimatedCost !== null}
            onGenerate={() => void handleGenerate()}
            signUp={isVisitor}
        />
    );
    const barNote = isVisitor ? (
        <CreatorVisitorNote welcomeCredits={visitorWelcomeCredits} cost={notedCost} />
    ) : offersFittedRemix ? (
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
            <Link href="/pricing" className={CREATOR_NOTE_LINK_CLASS}>Top up · {smallestCreditPackLabel()}</Link>
            <button
                type="button"
                onClick={() => {
                    setIsModelDropdownOpen(true);
                    modelDropdownRef.current?.scrollIntoView({ block: 'nearest' });
                }}
                className={CREATOR_NOTE_LINK_CLASS}
            >
                Other models
            </button>
        </div>
    ) : shortOfEveryVideoShown && userCredits !== null && videosFrom !== null ? (
        <CreatorLowBalanceNote balance={userCredits} videosFrom={videosFrom} />
    ) : userCredits !== null ? (
        <CreatorBalanceNote balance={userCredits} cost={notedCost} />
    ) : undefined;

    // The settings, each option priced (owner, 2026-10-28): the run with that one option.
    const sameRatioPrice = samePriceForEach(videoModel.aspectRatios.map((ratio) => optionPrice('aspectRatio', ratio)?.cost ?? null));
    const soundCosts = { on: optionPrice('sound', true), off: optionPrice('sound', false) };
    const soundPriceWords = soundCosts.on && soundCosts.off
        ? soundCosts.on.cost === soundCosts.off.cost
            ? `No extra cost on ${videoModel.displayName}`
            : `${soundCosts.on.cost > soundCosts.off.cost ? 'Adds' : 'Saves'} ${creditsWords(Math.abs(soundCosts.on.cost - soundCosts.off.cost))}`
        : 'Adds sound made for the scene.';
    // "+N" is explained by the least N an option on screen carries: a slider shows only its own length's.
    const smallestOver = smallestOverBalance(optionPrice, settingsAxes.flatMap(([key, values]) => (
        key === 'duration' && !lengthButtons ? [[key, [currentDuration]] as const]
            : key === 'aspectRatio' && sameRatioPrice ? []
                : key === 'sound' ? [[key, [currentSound]] as const]
                    : [[key, values] as const]
    )));
    const sliderPrice = optionPrice('duration', currentDuration);

    const settingsPanel = (
        <div className="space-y-5">
            {videoModel.modeOptions.length > 0 ? (
                <CreatorSettingChoices
                    label={modeControlLabel}
                    options={videoModel.modeOptions.map((option) => option.value)}
                    optionLabel={(value) => videoModel.modeOptions.find((option) => option.value === value)?.label ?? value}
                    value={currentMode}
                    onChange={setMode}
                    columns={videoModel.modeOptions.length === 2 ? 2 : 1}
                    accent="video"
                    optionPrice={(value) => optionPrice('mode', value)}
                />
            ) : null}

            {currentIsMultiShot ? (
                <p className="text-xs text-[var(--ui-text-faint)]">Each shot sets its own length: {totalDuration}s in all.</p>
            ) : lengthButtons ? (
                <CreatorSettingChoices
                    label="Length"
                    options={lengthOptions.map(String)}
                    optionLabel={(value) => `${value}s`}
                    value={String(currentDuration)}
                    onChange={(value) => setSingleDuration(Number(value))}
                    columns={lengthOptions.length <= 3 ? choiceColumns(lengthOptions.length) : lengthOptions.length <= 12 ? 4 : 5}
                    accent="video"
                    optionPrice={(value) => optionPrice('duration', Number(value))}
                />
            ) : singleShotDurationRange ? (
                <div>
                    <div className="mb-2 flex items-baseline justify-between gap-3">
                        <label htmlFor="create-video-duration" className="text-xs font-bold text-[var(--ui-text-muted)]">Length</label>
                        <span className="text-xs font-bold tabular-nums text-[var(--ui-text-primary)]">
                            {currentDuration}s
                            {sliderPrice ? (
                                <span className={sliderPrice.over !== null ? 'text-amber-300' : 'text-[var(--ui-text-faint)]'}>
                                    {` · ${creditsWords(sliderPrice.cost)}${sliderPrice.over !== null ? ` · +${sliderPrice.over}` : ''}`}
                                </span>
                            ) : null}
                        </span>
                    </div>
                    <input
                        id="create-video-duration"
                        type="range"
                        min={singleShotDurationRange.min}
                        max={singleShotDurationRange.max}
                        step="1"
                        value={currentDuration}
                        onChange={(event) => setSingleDuration(Number(event.target.value))}
                        className={`ui-focus-ring w-full ${videoAccent.control}`}
                    />
                    <div className="mt-1 flex justify-between text-xs tabular-nums text-[var(--ui-text-faint)]">
                        <span>{singleShotDurationRange.min}s</span>
                        <span>{singleShotDurationRange.max}s</span>
                    </div>
                </div>
            ) : (
                <div className="flex items-baseline justify-between gap-3">
                    <p className="text-xs font-bold text-[var(--ui-text-muted)]">Length</p>
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
                    optionPrice={(value) => optionPrice('resolution', value)}
                />
            ) : null}

            <CreatorSettingChoices
                label="Aspect ratio"
                hint={sameRatioPrice ? 'Same price for each' : undefined}
                options={videoModel.aspectRatios as readonly string[]}
                value={currentAspectRatio}
                onChange={setAspectRatio}
                columns={choiceColumns(videoModel.aspectRatios.length)}
                accent="video"
                optionMark={aspectRatioMark}
                optionPrice={sameRatioPrice ? undefined : (value) => optionPrice('aspectRatio', value)}
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
                    label="Generated sound"
                    description={soundPriceWords}
                    checked={currentSound}
                    onChange={setSound}
                    accent="video"
                />
            ) : null}

            <CreatorOverBalanceLegend
                over={smallestOver}
                balance={listBalance}
                isVisitor={isVisitor}
                offersTopUp={!isVisitor && !offersFittedRemix && !shortOfEveryVideoShown}
            />

            <CatalogAdditionalControls
                appearance="panel"
                descriptor={catalogDescriptor}
                handledKeys={CATALOG_HANDLED_KEYS}
                settings={{ mode: currentMode, aspectRatio: currentAspectRatio, sound: currentSound, duration: totalDuration, resolution: currentResolution, fixedLens: currentFixedLens, isMultiShot: currentIsMultiShot, referenceMode: activeReferenceMode, ...additionalSettings.settings }}
                onChange={additionalSettings.onChange}
            />
        </div>
    );

    // Done (the artboard Result): the clip, its download, and the publish form beside it; Posted once it went.
    const videoDownload = outputVideo ? {
        href: resolvedOutputVideo?.outputUrl === outputVideo ? resolvedOutputVideo.url : outputVideo,
        fileName: 'generated-video.mp4',
        label: 'Download video',
        newTab: true,
    } : null;
    const nextRunCost = runShape?.cost ?? estimatedCost;
    const publishPanel = canvasPublish.panel && videoDownload ? (
        <CreatorPublishPanel
            key={canvasPublish.panel.generationId}
            {...canvasPublish.panel}
            sourceSurface="create-video"
            download={videoDownload}
            next={userCredits !== null ? (
                <CreatorPostedNext
                    balance={userCredits}
                    runCost={nextRunCost}
                    imageHref={imageOffer && imageOffer.cost <= userCredits ? makeImageInsteadHref(imageOffer.modelId, runPrompt ?? prompt) : null}
                    onMakeAnother={() => (promptTextareaRef.current ?? Object.values(multiShotTextareaRefs.current).find(Boolean))?.focus()}
                />
            ) : null}
        />
    ) : null;

    // The model list's rows: each model's price at this run's settings, what it is for, and
    // what it keeps of the run's references (or, with none, its frames).
    const pickerRows: PickerModelRow[] = filteredVideoModelOptions.map((modelOption) => {
        const run = modelRuns.get(modelOption.id);
        const isSelected = modelOption.id === selectedModel;
        const tally = isSelected ? pageTally : run ? videoRunInputTally(run.inputs) : null;
        const keeps = !tally
            ? null
            : pageTally.references > 0
                ? referenceKeepWords(pageTally.references, tally.references)
                : referenceKeepWords(pageTally.frames, tally.frames, 'frame');
        return {
            id: modelOption.id,
            name: modelOption.displayName,
            description: modelOption.description,
            price: isSelected
                ? listedFromQuote(quoteState)
                : run
                    ? priceOf(run.quoteInput)
                    : { status: modelCatalog.error || modelCatalog.missingIds.includes(modelOption.id) ? 'unavailable' : 'pending' },
            summary: isSelected ? settingsSummaryShort : run?.summary ?? null,
            keeps,
        };
    });

    const cardHeadingClass = 'text-xs font-bold text-[var(--ui-text-muted)]';
    const cardCountClass = 'text-xs font-bold tabular-nums text-[var(--ui-text-faint)]';
    const standbyCardClass = 'rounded-ui-2xl border border-amber-500/20 bg-amber-500/10 p-4';
    const mentionHandleClass = (candidate: { kind: string }) => (candidate.kind === 'video' ? 'text-emerald-300' : 'text-sky-300');

    return (
        <div className="ui-page ui-page-ambient min-h-screen py-4 text-[var(--ui-text-primary)] sm:py-6 font-[family-name:var(--font-geist-sans)]">
            <CreatorColumnLayout
                resultFirst={canvasPhase === 'done'}
                title="Create video"
                column={
                    <>
                        <CreatorToolTabs currentToolId="video" />
                        {welcome && !isVisitor ? <CreatorWelcomeCard welcome={welcome} carriedDraft={carriedDraft} /> : null}

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
                                    footer={<CreatorModelPickerFoot />}
                                >
                                    <CreatorModelPickerRows
                                        rows={pickerRows}
                                        selectedId={selectedModel}
                                        balance={listBalance}
                                        balanceLabel={isVisitor ? `the ${listBalance} free credits` : `your ${listBalance} credits`}
                                        accent="video"
                                        onSelect={(id) => handleSelectModel(id as VideoModelId)}
                                    />
                                </StudioModelPicker>
                            </div>
                        </div>
                        {/* Until the first run this visit: back over the prompt after one, it pushed the field the creator went to. */}
                        {showsEmptyCanvas && canvasRevealKey === 0 ? <CreatorStartPostsStrip source={startPosts} tool="video" balance={listBalance} /> : null}

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
                                        description={`${remixFit && remixFitted && onFittedRemix
                                            ? `Fitted to your ${userCredits ?? remixFitted.cost} credits: ${fittedName} instead of ${originalName}, ${remixFitted.sameLength
                                                ? `at the same ${remixFit.original.durationSeconds}s`
                                                : `at ${remixFitted.settings.duration}s instead of ${remixFit.original.durationSeconds}s`}. It won’t match the original exactly.`
                                            : remixFit && onRemixOriginal
                                                ? `On the original settings: ${originalName} at ${remixFit.original.durationSeconds}s.`
                                                : `Settings pre-filled from ${remixTitle ? `"${remixTitle}"` : 'the original creation'}.`}${remixRestoreWarning ? ` ${remixRestoreWarning}` : ''}`}
                                        original={remixVideoUrl ? { mediaType: 'video', src: remixVideoUrl, onOpen: () => setIsPreviewModalOpen(true) } : null}
                                        action={
                                            remixFit && onFittedRemix ? (
                                                <button
                                                    type="button"
                                                    onClick={() => switchModel(remixFit.original.modelId, remixFit.original.settings)}
                                                    className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.08] hover:text-white"
                                                >
                                                    Use the original · {remixFit.original.cost} credits
                                                </button>
                                            ) : undefined
                                        }
                                    />
                                </motion.div>
                            )}
                            {shortOfEveryVideoShown && userCredits !== null && videosFrom !== null ? (
                                <motion.div key="short-of-every-video" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}>
                                    <CreatorLowBalanceNotice
                                        balance={userCredits}
                                        videosFrom={videosFrom}
                                        image={imageOffer ? { name: imageOffer.name, cost: imageOffer.cost } : null}
                                    />
                                </motion.div>
                            ) : null}
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
                                <div className={`rounded-ui-2xl border bg-[var(--ui-surface-1)] transition-colors duration-150 ${videoAccent.outline}`}>
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

                                {activeMentionQuery && offersPromptMentions ? (
                                    <CreatorMentionPanel
                                        title="Insert reference"
                                        hint={mentionSuggestions.length > 0 ? 'Pick a reference to insert its @mention.' : 'No matching references yet.'}
                                        query={activeMentionQuery.query}
                                        suggestions={mentionSuggestions}
                                        handleClassName={mentionHandleClass}
                                        onInsert={handleInsertPromptHandle}
                                    />
                                ) : null}

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
                                    onCreditsUpdate={reportEnhanceBalance}
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
                                    onRequireAccount={isVisitor ? () => void openSignUp('enhance') : undefined}
                                />
                                <PromptQualityWarnings warnings={promptQualityWarnings} />
                            </>
                        ) : (
                            <div className="flex flex-col gap-3">
                                {multiPrompts.map((shot, index) => (
                                    <div role="group"
                                        key={shot.id}
                                        aria-labelledby={`create-video-shot-${shot.id}`}
                                        className={`rounded-ui-2xl border bg-[var(--ui-surface-1)] p-4 transition-colors duration-150 ${videoAccent.outline}`}
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
                                            onCreditsUpdate={reportEnhanceBalance}
                                            medium="video"
                                            selectedModel={selectedModel}
                                            context={buildShotPromptQualityContext(shot, index)}
                                            disabled={isGenerating}
                                            showWarnings={false}
                                            onRequireAccount={isVisitor ? () => void openSignUp('enhance') : undefined}
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
                                            className={`mb-3 block min-h-[100px] w-full resize-y rounded-ui-lg border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-3 text-sm leading-6 text-[var(--ui-text-primary)] outline-none transition-colors placeholder:text-[var(--ui-text-faint)] ${videoAccent.fieldFocus}`}
                                        />
                                        {activeShotMentionQuery?.shotId === shot.id && shotPromptsTakeMentions ? (
                                            <div className="mb-3">
                                                <CreatorMentionPanel
                                                    title={shotMentionPanelCopy.title}
                                                    hint={shotMentionSuggestions.length > 0 ? shotMentionPanelCopy.pick : shotMentionPanelCopy.none}
                                                    query={activeShotMentionQuery.query}
                                                    suggestions={shotMentionSuggestions}
                                                    handleClassName={mentionHandleClass}
                                                    onInsert={(handle) => handleInsertShotHandle(shot.id, handle)}
                                                />
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
                                                className={`ui-focus-ring w-32 ${videoAccent.control}`}
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
                                    className={creatorAddButtonClass('video')}
                                >
                                    <Plus aria-hidden className={`h-4 w-4 ${videoAccent.mark}`} /> Add New Shot
                                </button>
                            </div>
                        )}

                        {!videoModel.supportsSound && ALWAYS_ON_AUDIO_VIDEO_MODELS.has(selectedModel) ? (
                            <p className="flex items-start gap-2 px-1 text-xs leading-5 text-[var(--ui-text-muted)]">
                                <Volume2 aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 ${videoAccent.mark}`} />
                                This model always generates audio. Describe the sound you want in the prompt, or say “no music”.
                            </p>
                        ) : null}

                        {inputView.side ? (
                            <CreatorInputsCard
                                switcher={inputView.switchable ? (
                                    <CreatorSettingChoices
                                        ref={inputSwitchRef}
                                        label={`Start from ${inputSides.labels.frames.toLowerCase()} or ${inputSides.labels.references.toLowerCase()}`}
                                        labelHidden
                                        options={VIDEO_INPUT_SIDES}
                                        optionLabel={(side) => inputSides.labels[side]}
                                        value={inputView.side}
                                        onChange={(side) => void requestInputSide(side)}
                                        appearance="pill"
                                        accent="video"
                                    />
                                ) : null}
                                hint={inputsHint}
                                notice={inputView.framesLeftOut.length > 0 ? (
                                    <div className={`mt-3 flex flex-wrap items-center justify-between gap-2 rounded-ui-lg border py-1.5 pl-3 pr-1.5 text-xs leading-5 ${noticeClasses.badge}`}>
                                        <span className="min-w-0 flex-1">{framesLeftOutLine(inputView.framesLeftOut, inputSides.labels)}</span>
                                        <button
                                            type="button"
                                            onClick={() => void removeLeftOutFrames()}
                                            aria-label={inputView.framesLeftOut.length === 2 ? 'Remove the start and end images' : `Remove the ${inputView.framesLeftOut[0]} image`}
                                            className={CREATOR_REFERENCE_CHIP_CLASS}
                                        >
                                            Remove
                                        </button>
                                    </div>
                                ) : null}
                            >
                                {inputView.side === 'frames' ? (
                                    <>
                                        <div className={`grid gap-3 ${inputSides.frames?.start && inputSides.frames.end ? 'grid-cols-2' : ''}`}>
                                            {inputSides.frames?.start ? renderFrameSlot('start') : null}
                                            {inputSides.frames?.end ? renderFrameSlot('end') : null}
                                        </div>
                                        {isGrokVideoModel ? (
                                            <p className={`rounded-ui-lg border px-3 py-2 text-sm leading-6 ${noticeClasses.badge}`}>
                                                Grok Imagine Video takes a start image here, or up to 7 pictures as references.
                                            </p>
                                        ) : null}
                                    </>
                                ) : (
                                    <>
                                        {showElementEditor ? (
                                            <div className="space-y-3">
                                                {supportsMultimodalReferences ? (
                                                    <h3 className="text-xs font-semibold text-[var(--ui-text-secondary)]">Reference images</h3>
                                                ) : null}
                                                {elements.length > 0 ? (
                                                    <CreatorReferenceStrip aria-label="Reference images">
                                                        {elements.map((element) => (
                                                            <CreatorReferenceTile
                                                                key={element.id}
                                                                accent="video"
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
                                                                        className="ui-focus-ring group relative block aspect-square w-full overflow-hidden rounded-ui-md border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)]"
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
                                                                replace={element.restoredFromRemix ? {
                                                                    label: `Replace ${element.handle} with your own photo`,
                                                                    accept: 'image/*',
                                                                    onFile: (file) => void replaceElement(element.id, file),
                                                                } : undefined}
                                                            />
                                                        ))}
                                                    </CreatorReferenceStrip>
                                                ) : null}
                                                {elements.length < videoElementSupport.maxElements && (
                                                    <CreatorAddTile
                                                        accent="video"
                                                        icon={Plus}
                                                        label={isDraggingElements ? 'Drop reference images here' : 'Add reference images'}
                                                        input={{
                                                            ref: elementInputRef,
                                                            accept: 'image/*',
                                                            multiple: true,
                                                            onChange: handleElementUpload,
                                                        }}
                                                        dragging={isDraggingElements}
                                                        onDragOver={(event) => { event.preventDefault(); setIsDraggingElements(true); }}
                                                        onDragLeave={(event) => { event.preventDefault(); setIsDraggingElements(false); }}
                                                        onDrop={handleElementDrop}
                                                    />
                                                )}
                                            </div>
                                        ) : null}
                                        {supportsMultimodalReferences ? (
                                            <div className="space-y-4">
                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between gap-3">
                                                <h3 className="text-xs font-semibold text-[var(--ui-text-secondary)]">Reference videos</h3>
                                                <button
                                                    type="button"
                                                    onClick={() => referenceVideoInputRef.current?.click()}
                                                    disabled={referenceVideos.length >= referenceVideoLimit}
                                                    className={CREATOR_REFERENCE_CHIP_CLASS}
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
                                                    {referenceVideos.map((reference) => {
                                                        const length = cardLength(reference.id, reference.durationSeconds, 'videoReferences', 'clip');
                                                        return (
                                                            <li key={reference.id} className="rounded-ui-lg border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-3">
                                                                <div className="flex items-start justify-between gap-3">
                                                                    <div className="min-w-0">
                                                                        <div className="truncate text-sm font-semibold text-[var(--ui-text-primary)]">{reference.displayName}</div>
                                                                        <div className={`mt-1 text-xs ${length?.held ? 'text-red-400' : 'text-[var(--ui-text-faint)]'}`}>
                                                                            {length?.text ?? 'Duration unavailable'}
                                                                        </div>
                                                                    </div>
                                                                    <div className="-my-1 -mr-1 flex shrink-0 items-center gap-1.5">
                                                                        {reference.restoredFromRemix ? (
                                                                            <CreatorReplaceButton
                                                                                label={`Replace ${reference.displayName} with your own clip`}
                                                                                accept="video/*"
                                                                                onFile={(file) => void replaceMediaReference('video', reference.id, file)}
                                                                            />
                                                                        ) : null}
                                                                        <IconButton
                                                                            label={`Remove ${reference.displayName}`}
                                                                            icon={X}
                                                                            onClick={() => void handleRemoveReferenceVideo(reference.id)}
                                                                            className="shrink-0"
                                                                        />
                                                                    </div>
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
                                                        );
                                                    })}
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
                                                        className={CREATOR_REFERENCE_CHIP_CLASS}
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
                                                        {referenceAudios.map((reference) => {
                                                            const length = cardLength(reference.id, reference.durationSeconds, 'audioReferences', 'track');
                                                            return (
                                                                <li key={reference.id} className="rounded-ui-lg border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-3">
                                                                    <div className="flex items-start justify-between gap-3">
                                                                        <div className="min-w-0">
                                                                            <div className="truncate text-sm font-semibold text-[var(--ui-text-primary)]">{reference.displayName}</div>
                                                                            {/* Only the Seedance 2 family prepares assets. On any other model the row says how long the track is. A held track says it is under the minimum, as its line does, in place of either. */}
                                                                            {length?.held ? (
                                                                                <div className="mt-1 text-xs text-red-400">{length.text}</div>
                                                                            ) : isSeedance2Family ? (
                                                                                <div className="mt-1 text-xs text-[var(--ui-text-faint)]">
                                                                                    {reference.seedanceAsset.assetId ? 'Prepared asset available' : 'Uses URL fallback until prepared'}
                                                                                </div>
                                                                            ) : length ? (
                                                                                <div className="mt-1 text-xs text-[var(--ui-text-faint)]">{length.text}</div>
                                                                            ) : null}
                                                                        </div>
                                                                        <div className="-my-1 -mr-1 flex shrink-0 items-center gap-1.5">
                                                                            {reference.restoredFromRemix ? (
                                                                                <CreatorReplaceButton
                                                                                    label={`Replace ${reference.displayName} with your own track`}
                                                                                    accept="audio/*"
                                                                                    onFile={(file) => void replaceMediaReference('audio', reference.id, file)}
                                                                                />
                                                                            ) : null}
                                                                            <IconButton
                                                                                label={`Remove ${reference.displayName}`}
                                                                                icon={X}
                                                                                onClick={() => void handleRemoveReferenceAudio(reference.id)}
                                                                                className="shrink-0"
                                                                            />
                                                                        </div>
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
                                                            );
                                                        })}
                                                    </ul>
                                                ) : (
                                                    <p className="rounded-ui-lg border border-dashed border-[var(--ui-border-default)] px-4 py-4 text-sm text-[var(--ui-text-muted)]">
                                                        Add up to {referenceAudioLimit} audio clip{referenceAudioLimit === 1 ? '' : 's'} for beat, voice, or dialogue timing guidance.
                                                    </p>
                                                )}
                                            </div>
                                        ) : null}
                                    </div>
                                        ) : null}
                                        {inputSides.references?.keepsStart
                                            ? renderFrameSlot('start', `${videoModel.displayName} can start from it, with your references.`)
                                            : null}
                                    </>
                                )}
                            </CreatorInputsCard>
                        ) : null}

                        {supportsNamedSubjects && (
                            <div className="ui-card p-4">
                                <KlingSubjectsEditor
                                    subjects={klingSubjects}
                                    limits={affordances.subjects}
                                    disabled={isGenerating}
                                    onChange={commitKlingSubjects}
                                    onRename={handleKlingSubjectRename}
                                    onRefusedFiles={setPickNotice}
                                    // Into the prompt, or in multi-shot the shot being written.
                                    onInsert={handleInsertKlingVideoHandle}
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
                                    Named clips. Type @ in the prompt or a shot prompt, or tap a handle, to use one by its name.
                                </p>

                                {klingVideoElements.length > 0 ? (
                                    <CreatorReferenceStrip className="mb-3">
                                        {klingVideoElements.map((element) => (
                                            <CreatorReferenceTile
                                                key={element.id}
                                                accent="video"
                                                preview={
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            const src = element.previewUrl || element.providerUrl;
                                                            if (src) setUploadPreview({ type: 'video', src, alt: element.displayName, title: element.displayName });
                                                        }}
                                                        aria-label={`Preview ${element.displayName}`}
                                                        className="ui-focus-ring relative block aspect-video w-full overflow-hidden rounded-ui-md border border-[var(--ui-border-default)] bg-black"
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
                                                }
                                                displayName={element.displayName}
                                                nameDraft={klingVideoNames.drafts[element.id]}
                                                placeholder="Rename video element"
                                                onNameChange={(value) => handleKlingVideoDraftChange(element.id, value)}
                                                onNameCommit={() => void commitKlingVideoDraft(element.id)}
                                                onNameCancel={() => klingVideoNames.dropDraft(element.id)}
                                                onRemove={() => void handleRemoveKlingVideoElement(element.id)}
                                                handle={element.handle}
                                                handleClassName="text-emerald-300"
                                                onInsert={() => handleInsertKlingVideoHandle(element.handle)}
                                                onCopy={() => {
                                                    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                                                        void navigator.clipboard.writeText(element.handle);
                                                    }
                                                }}
                                                // Read as the line beside Generate and the start give a clip's length, so a
                                                // clip named there as too short never reads as 3.0s here.
                                                note={klingClipLengths.get(element.id)?.held ? (
                                                    <span className="text-red-400">{klingClipLengths.get(element.id)?.text}</span>
                                                ) : klingClipLengths.get(element.id)?.text ?? 'MP4 or MOV, 50MB max'}
                                            />
                                        ))}
                                    </CreatorReferenceStrip>
                                ) : null}

                                {klingVideoElements.length < KLING_VIDEO_ELEMENT_LIMIT ? (
                                    <CreatorAddTile
                                        accent="video"
                                        icon={Video}
                                        label={isDraggingKlingVideos ? 'Drop Kling video elements here' : 'Add video elements'}
                                        input={{
                                            ref: klingVideoInputRef,
                                            accept: 'video/mp4,video/quicktime,.mp4,.mov',
                                            multiple: true,
                                            onChange: handleKlingVideoElementUpload,
                                            'aria-describedby': 'create-video-kling-elements-limits',
                                        }}
                                        dragging={isDraggingKlingVideos}
                                        onDragOver={(event) => { event.preventDefault(); setIsDraggingKlingVideos(true); }}
                                        onDragLeave={(event) => { event.preventDefault(); setIsDraggingKlingVideos(false); }}
                                        onDrop={handleKlingVideoElementDrop}
                                    />
                                ) : (
                                    <p className="text-sm text-[var(--ui-text-muted)]">
                                        Kling video elements are capped at {KLING_VIDEO_ELEMENT_LIMIT} clips in this version.
                                    </p>
                                )}
                                <p id="create-video-kling-elements-limits" className="sr-only">MP4 or MOV clips, one per element, 50MB max.</p>
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
                                <ul aria-label="References on standby" className="mt-3 space-y-1.5">
                                    {standbyReferences.map((reference) => (
                                        <li
                                            key={`${reference.kind}-${reference.id}`}
                                            className="flex items-center justify-between gap-3 rounded-ui-lg border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] py-0.5 pl-3 pr-0.5 text-sm text-[var(--ui-text-secondary)]"
                                        >
                                            <span className="min-w-0 truncate">{reference.displayName}</span>
                                            <IconButton label={`Remove ${reference.displayName}`} icon={X} onClick={reference.onRemove} className="shrink-0" />
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

                        {supportsMultimodalReferences && !currentIsMultiShot && (
                            <>
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
                                                            className={`min-h-10 min-w-0 flex-1 rounded-ui-md border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] px-3 text-sm text-[var(--ui-text-primary)] outline-none transition-colors placeholder:text-[var(--ui-text-faint)] ${videoAccent.fieldFocus}`}
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

                                {isSeedance2Family && inputView.side === 'references' ? (
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
                                                                    onClick={() => void item.onPrepare().catch((prepareError) => {
                                                                        if (!isUploadCancelledError(prepareError)) setError(prepareError instanceof Error ? prepareError.message : 'Failed to prepare Seedance asset');
                                                                    })}
                                                                    disabled={isBusy}
                                                                    className={`${CREATOR_REFERENCE_CHIP_CLASS} gap-1.5`}
                                                                >
                                                                    {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                                                                    {item.asset.assetId ? 'Retry prep' : 'Prepare asset'}
                                                                </button>
                                                                {item.asset.assetId ? (
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => void item.onRefresh().catch((refreshError) => {
                                                                            if (!isUploadCancelledError(refreshError)) setError(refreshError instanceof Error ? refreshError.message : 'Failed to refresh Seedance asset');
                                                                        })}
                                                                        disabled={isBusy}
                                                                        className={CREATOR_REFERENCE_CHIP_CLASS}
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
                            holdsFootUnderColumn={!(publishPanel && !canvasPublish.posted)}
                            settingsSummary={settingsSummary}
                            settingsSummaryShort={settingsSummaryShort}
                            settings={settingsPanel}
                            settingsFootNote={<CreatorSettingsFootNote cost={estimatedCost} costLabel={quoteUi.costLabel} balance={listBalance} isVisitor={isVisitor} />}
                            settingsOpen={settingsOpen}
                            onSettingsOpenChange={setSettingsOpen}
                            status={barStatus}
                            narrowStatus={showsRunFailure ? (
                                <CreatorRunFailedLine returnedCredits={runFailure?.cost ?? null} onSeeWhy={() => setRunEndKey((key) => key + 1)} />
                            ) : null}
                            action={barAction}
                            note={barNote}
                            stacked={offersFittedRemix || shortOfEveryVideoShown}
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
                                ratio={parseAspectRatio(runShape?.aspectRatio ?? currentAspectRatio)}
                                media={(
                                    <CreatorCanvasMedia aspectRatio={runShape?.aspectRatio ?? currentAspectRatio}>
                                        <GenerationResultVideo generationId={latestGenerationId} outputUrl={outputVideo} accessToken={session?.access_token} onOriginalResolved={setResolvedOutputVideo} loop={false} />
                                    </CreatorCanvasMedia>
                                )}
                                mediaFoot={videoDownload ? (
                                    <div className="space-y-3">
                                        {runPrompt ? <p className="line-clamp-2 text-xs leading-5 text-[var(--ui-text-faint)]">{runPrompt}</p> : null}
                                        <CreatorDownloadButton {...videoDownload} />
                                    </div>
                                ) : null}
                                panel={publishPanel}
                            />
                        ) : isGenerating ? (
                            <>
                                <CreatorCanvasStage>
                                    <CreatorCanvasFrame aspectRatio={runShape?.aspectRatio ?? currentAspectRatio} accent="video" busy>
                                        <Video aria-hidden className="h-6 w-6 text-[var(--ui-primary)]" />
                                        {generationTiming ? (
                                            <div className="w-full max-w-72">
                                                <StudioGenerationStatus accent="rose" timing={generationTiming} nowMs={nowMs} />
                                            </div>
                                        ) : (
                                            <p role="status" className="text-sm font-semibold text-[var(--ui-text-primary)]">Rendering your video</p>
                                        )}
                                    </CreatorCanvasFrame>
                                </CreatorCanvasStage>
                                {runShape?.answered ? <CreatorRunWaitLines noun="video" heldCredits={runShape.cost} /> : null}
                                <CreatorWhileYouWait source={startPosts} tool="video" />
                            </>
                        ) : isBackgroundProcessing ? (
                            <div className="w-full max-w-md">
                                <StudioBackgroundProcessingNotice
                                    accent="rose"
                                    label="video"
                                    phaseLabel={backgroundTiming?.phaseLabel ?? null}
                                    timingLabel={backgroundTimingLabel}
                                />
                            </div>
                        ) : runFailure ? (
                            <CreatorRunFailed
                                cause={describeRunFailure(runFailure.message, 'video')}
                                returnedCredits={runFailure.cost}
                                retryLabel={estimatedCost !== null ? `Try again · ${quoteUi.costLabel}` : 'Try again'}
                                retryDisabled={quotePending || runHeld || showTopUp || offersFittedRemix || shortOfEveryVideoShown}
                                onRetry={() => void handleGenerate()}
                                retryable={isRetryableProviderFailure(runFailure.message)}
                                onPickModel={() => setIsModelDropdownOpen(true)}
                                onChangePrompt={() => {
                                    setRunFailure(null);
                                    (promptTextareaRef.current ?? Object.values(multiShotTextareaRefs.current).find(Boolean))?.focus();
                                }}
                            />
                        ) : (
                            <CreatorEmptyCanvas
                                source={startPosts}
                                tool="video"
                                balance={listBalance}
                                icon={Video}
                                title={isVisitor ? 'Try it before you sign up' : 'Your video will appear here'}
                                hint={`${isVisitor ? CREATOR_VISITOR_CANVAS_HINT : emptyCanvasHint} Or remix a post below.`}
                                frame={(
                                    <CreatorCanvasStage>
                                        <CreatorCanvasFrame aspectRatio={currentAspectRatio} accent="video">
                                            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)]">
                                                <Video className="h-5 w-5 text-[var(--ui-text-muted)]" />
                                            </span>
                                            <p className="text-sm font-semibold text-[var(--ui-text-secondary)]">{isVisitor ? 'Try it before you sign up' : 'Your video will appear here'}</p>
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
                tool="video"
                welcomeCredits={visitorWelcomeCredits}
                runCost={estimatedCost}
                modelName={videoModel.displayName}
                settingsSummary={settingsSummary}
                keepsPrompt={currentIsMultiShot ? multiPrompts.some((shot) => shot.prompt.trim()) : Boolean(prompt.trim())}
                keepsImages={Boolean(startImageFile || endImageFile) || elements.length > 0 || klingSubjects.length > 0}
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
