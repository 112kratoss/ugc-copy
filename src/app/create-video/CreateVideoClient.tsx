'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Sparkles, Loader2, Download, X, Image as ImageIcon, Video, Plus, Trash2, Volume2, VolumeX, Play, Camera, ChevronDown, Check, Share2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import {
    GeneratorPageHeader,
    MediaStudioShell,
    StudioBackgroundProcessingNotice,
    StudioGenerationStatus,
    StudioMediaPreviewModal,
    StudioRemixNotice,
    StudioRunPanel,
    StudioUploadedMediaPreview,
    StudioWorkspacePanel,
} from '@/app/components/CreatorStudio';
import PublicShareButton from '@/app/components/PublicShareButton';
import PublishToShowcaseModal from '@/app/components/PublishToShowcaseModal';
import EnhancePromptButton from '@/app/components/EnhancePromptButton';
import { clampVideoDuration, getDefaultVideoDuration, getVideoCost, getVideoDurationRange, getVideoElementSupport, isValidVideoDuration, VIDEO_MODELS, VideoModelId } from '@/lib/models';
import { useAuth } from '@/app/components/AuthProvider';
import type { RemixMediaAssetDescriptor, RemixSourceBundle } from '@/lib/remix-source';
import {
    createRemixElementSeeds,
    createRestoredRemixAssetState,
    getRemixRestoreWarning,
} from '@/lib/remix-source-client';
import { buildShowcaseDetailPath } from '@/lib/share';
import {
    getPersistedFile,
    getPersistedImageElementRecords,
    getPersistedMediaRecords,
    getPersistedValue,
    PERSISTED_MEDIA_KEYS,
    removePersistedMedia,
    setPersistedFile,
    setPersistedImageElementRecords,
    setPersistedMediaRecords,
    setPersistedValue,
} from '@/lib/persisted-media';
import { BACKGROUND_PROCESSING_ERROR, getBackgroundProcessingCopy } from '@/lib/generation-feedback';
import {
    createElementHandleReplacementMap,
    createElementId,
    extractPromptHandles,
    findUnknownPromptHandles,
    getMentionQueryAtCaret,
    insertHandleIntoPrompt,
    normalizeElementDisplayName,
    reconcileElementDescriptors,
    replacePromptHandles,
    type ImageElementDescriptor,
} from '@/lib/image-elements';
import {
    createSeedanceAssetMetadata,
    getPreferredSeedanceReferenceValue,
    getSeedanceAssetStatusLabel,
    isSeedance2VideoModelId,
    type SeedanceAssetCollections,
    type SeedanceAssetKind,
    type SeedanceAssetMetadata,
} from '@/lib/seedance-assets';
import {
    createLocalGenerationTiming,
    freezeGenerationTiming,
    getGenerationTimingSummaryLabel,
    type GenerationTiming,
} from '@/lib/generation-timing';
import { useTicker } from '@/lib/use-ticker';

interface MultiShot {
    id: string;
    prompt: string;
    duration: number;
}

interface UploadPreviewState {
    type: 'image' | 'video';
    src: string;
    alt: string;
    title: string;
}

type GenerationStatusResponse = {
    status: 'processing' | 'waiting' | 'succeeded' | 'failed';
    output?: string | null;
    error?: string | null;
    timing?: GenerationTiming | null;
};

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
    seedanceAssets?: SeedanceAssetCollections;
}

type VideoElementDraft = ImageElementDescriptor & {
    file: File | null;
    previewUrl: string;
    providerUrl: string | null;
    source: 'upload' | 'remix';
    sourceGenerationId?: string | null;
    seedanceAsset: SeedanceAssetMetadata;
};

type VideoElementSeed = {
    id?: string;
    displayName?: string;
    file: File | null;
    previewUrl: string;
    providerUrl?: string | null;
    storagePath?: string | null;
    source?: 'upload' | 'remix';
    sourceGenerationId?: string | null;
    seedanceAsset?: Partial<SeedanceAssetMetadata>;
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
};

function hydrateVideoElements(seeds: VideoElementSeed[]): VideoElementDraft[] {
    const baseElements = seeds.map((seed, index) => ({
        id: seed.id ?? createElementId(),
        displayName: normalizeElementDisplayName(seed.displayName, index + 1),
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
    }));

    const reconciled = reconcileElementDescriptors(baseElements.map((element) => ({
        id: element.id,
        displayName: element.displayName,
    })));
    const byId = new Map(baseElements.map((element) => [element.id, element]));

    return reconciled.map((element) => {
        const existing = byId.get(element.id);
        if (!existing) {
            return {
                id: element.id,
                displayName: element.displayName,
                handle: element.handle,
                file: null,
                previewUrl: '',
                providerUrl: null,
                storagePath: null,
                source: 'upload' as const,
                sourceGenerationId: null,
                seedanceAsset: createSeedanceAssetMetadata({ assetType: 'Image' }),
            };
        }

        return {
            ...existing,
            displayName: element.displayName,
            handle: element.handle,
        };
    });
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
    }));
}

async function readVideoDurationSeconds(file: File): Promise<number | null> {
    const previewUrl = URL.createObjectURL(file);

    try {
        const durationSeconds = await new Promise<number | null>((resolve) => {
            const previewVideo = document.createElement('video');

            const cleanup = () => {
                previewVideo.removeAttribute('src');
                previewVideo.load();
            };

            previewVideo.preload = 'metadata';
            previewVideo.onloadedmetadata = () => {
                const nextDuration = Number.isFinite(previewVideo.duration) ? previewVideo.duration : null;
                cleanup();
                resolve(nextDuration);
            };
            previewVideo.onerror = () => {
                cleanup();
                resolve(null);
            };
            previewVideo.src = previewUrl;
        });

        return durationSeconds;
    } finally {
        URL.revokeObjectURL(previewUrl);
    }
}

export interface CreateVideoPrefill {
    remixId?: string | null;
    prompt?: string | null;
    model?: string | null;
    aspectRatio?: string | null;
    duration?: string | null;
}

export default function CreateVideoClient({ prefill }: { prefill: CreateVideoPrefill }) {
    const router = useRouter();
    const { credits: userCredits, isLoading: isLoadingUser, session, updateCredits } = useAuth();
    const remixId = prefill.remixId ?? null;
    const prefillPrompt = prefill.prompt ?? null;
    const prefillModel = prefill.model ?? null;
    const prefillAspectRatio = prefill.aspectRatio ?? null;
    const prefillDuration = prefill.duration ?? null;

    const [selectedModel, setSelectedModel] = useState<VideoModelId>('kling-3.0-video');
    const [isMultiShot, setIsMultiShot] = useState(false);
    const [prompt, setPrompt] = useState('');
    const [singleDuration, setSingleDuration] = useState(5);
    const [multiPrompts, setMultiPrompts] = useState<MultiShot[]>([
        { id: '1', prompt: '', duration: 5 },
    ]);
    const [elements, setElements] = useState<VideoElementDraft[]>([]);
    const [referenceVideos, setReferenceVideos] = useState<SeedanceMediaReferenceDraft[]>([]);
    const [referenceAudios, setReferenceAudios] = useState<SeedanceMediaReferenceDraft[]>([]);
    const [referenceMode, setReferenceMode] = useState<'frames' | 'elements'>('frames');
    const [elementNameDrafts, setElementNameDrafts] = useState<Record<string, string>>({});
    const [startImageFile, setStartImageFile] = useState<File | null>(null);
    const [startImageUrl, setStartImageUrl] = useState<string | null>(null);
    const [startFrameDescriptor, setStartFrameDescriptor] = useState<RemixMediaAssetDescriptor | null>(null);
    const [endImageFile, setEndImageFile] = useState<File | null>(null);
    const [endImageUrl, setEndImageUrl] = useState<string | null>(null);
    const [endFrameDescriptor, setEndFrameDescriptor] = useState<RemixMediaAssetDescriptor | null>(null);
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
    const [latestGenerationId, setLatestGenerationId] = useState<string | null>(null);
    const [latestIsPublic, setLatestIsPublic] = useState(false);
    const [publishedMeta, setPublishedMeta] = useState<{ title: string; description: string } | null>(null);
    const [isPublishModalOpen, setIsPublishModalOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
    const modelDropdownRef = useRef<HTMLDivElement>(null);
    const startImageInputRef = useRef<HTMLInputElement>(null);
    const endImageInputRef = useRef<HTMLInputElement>(null);
    const elementInputRef = useRef<HTMLInputElement>(null);
    const referenceVideoInputRef = useRef<HTMLInputElement>(null);
    const referenceAudioInputRef = useRef<HTMLInputElement>(null);
    const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
    const elementsRef = useRef<VideoElementDraft[]>([]);
    const referenceVideosRef = useRef<SeedanceMediaReferenceDraft[]>([]);
    const referenceAudiosRef = useRef<SeedanceMediaReferenceDraft[]>([]);
    const [isDraggingElements, setIsDraggingElements] = useState(false);
    const [activeSeedanceAssetKey, setActiveSeedanceAssetKey] = useState<string | null>(null);
    const [activeMentionQuery, setActiveMentionQuery] = useState<{
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
    const nowMs = useTicker(isGenerating);

    useEffect(() => {
        if (remixId) return;
        if (prefillPrompt) setPrompt(prefillPrompt);
        if (prefillModel && prefillModel in VIDEO_MODELS) setSelectedModel(prefillModel as VideoModelId);
        if (prefillAspectRatio) setAspectRatio(prefillAspectRatio);
        if (prefillDuration) {
            const nextDuration = Number(prefillDuration);
            if (!Number.isNaN(nextDuration)) setSingleDuration(nextDuration);
        }
    }, [prefillPrompt, prefillModel, prefillAspectRatio, prefillDuration, remixId]);

    const videoModel = VIDEO_MODELS[selectedModel];
    const isSeedance2Family = isSeedance2VideoModelId(selectedModel);
    const revokeObjectUrl = (url: string | null) => {
        if (url?.startsWith('blob:')) {
            URL.revokeObjectURL(url);
        }
    };
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
    const persistVideoElements = async (nextElements: VideoElementDraft[]) => {
        if (remixId) {
            return;
        }

        const persistableElements = nextElements
            .filter((element) => element.file && element.source === 'upload')
            .map((element) => ({
                id: element.id,
                displayName: element.displayName,
                file: element.file as File,
            }));

        await setPersistedImageElementRecords(
            PERSISTED_MEDIA_KEYS.createVideoElements,
            persistableElements
        );
    };
    const persistReferenceVideos = async (nextReferences: SeedanceMediaReferenceDraft[]) => {
        if (remixId) {
            return;
        }

        await setPersistedMediaRecords(
            PERSISTED_MEDIA_KEYS.createVideoReferenceVideos,
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
        if (remixId) {
            return;
        }

        await setPersistedMediaRecords(
            PERSISTED_MEDIA_KEYS.createVideoReferenceAudios,
            nextReferences
                .filter((reference) => reference.file && reference.source === 'upload')
                .map((reference) => ({
                    id: reference.id,
                    displayName: reference.displayName,
                    durationSeconds: null,
                    file: reference.file as File,
                }))
        );
    };
    const persistSeedanceAssets = async (
        nextElements: VideoElementDraft[] = elementsRef.current,
        nextReferenceVideos: SeedanceMediaReferenceDraft[] = referenceVideosRef.current,
        nextReferenceAudios: SeedanceMediaReferenceDraft[] = referenceAudiosRef.current
    ) => {
        if (remixId) {
            return;
        }

        await setPersistedValue<SeedanceAssetCollections>(
            PERSISTED_MEDIA_KEYS.createVideoSeedanceAssets,
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
    const videoElementSupport = getVideoElementSupport(selectedModel, {
        mode: currentMode,
        isMultiShot: currentIsMultiShot,
    });
    const canUseVideoElements = videoElementSupport.enabled;
    const activeReferenceMode = isSeedance2Family ? 'elements' : (canUseVideoElements ? referenceMode : 'frames');
    const totalDuration = currentIsMultiShot
        ? multiPrompts.reduce((acc, curr) => acc + curr.duration, 0)
        : (videoModel.provider === 'veo' ? videoModel.durations[0] : currentDuration);
    const estimatedCost = getVideoCost(selectedModel, {
        mode: currentMode,
        sound: currentSound,
        durationSeconds: totalDuration,
        resolution: currentResolution,
        hasReferenceVideo: referenceVideos.length > 0,
    });
    const insufficientCredits = userCredits !== null && userCredits < estimatedCost;
    const elementHandles = elements.map((element) => element.handle);
    const knownElementMentions = extractPromptHandles(prompt).filter((handle) => elementHandles.includes(handle));
    const staleElementMentions = findUnknownPromptHandles(prompt, elementHandles);
    const hasKnownElementMentions = knownElementMentions.length > 0;
    const hasInactiveElementMentions = !canUseVideoElements && hasKnownElementMentions;
    const mentionSuggestions = activeMentionQuery
        ? elements.filter((element) => {
            const normalizedQuery = activeMentionQuery.query.toLowerCase();
            if (!normalizedQuery) return true;

            return (
                element.handle.toLowerCase().includes(`@${normalizedQuery}`) ||
                element.displayName.toLowerCase().includes(normalizedQuery)
            );
        })
        : [];
    const showElementEditor = !currentIsMultiShot && canUseVideoElements && activeReferenceMode === 'elements';
    const showFramesEditor = !isSeedance2Family && activeReferenceMode === 'frames';
    const hiddenElementDraftCount = activeReferenceMode === 'frames' ? elements.length : 0;
    const hiddenFrameDraftCount = activeReferenceMode === 'elements'
        ? [startImageUrl, endImageUrl].filter(Boolean).length
        : 0;
    const showSavedElementNotice = !isSeedance2Family && !canUseVideoElements && !currentIsMultiShot && (elements.length > 0 || referenceMode === 'elements');
    const showMultiShotElementNotice = currentIsMultiShot && (elements.length > 0 || referenceMode === 'elements' || hasKnownElementMentions);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
                setIsModelDropdownOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        return () => {
            revokeObjectUrl(startImageUrl);
            revokeObjectUrl(endImageUrl);
            elementsRef.current.forEach((element) => revokeObjectUrl(element.previewUrl));
            referenceVideosRef.current.forEach((reference) => revokeObjectUrl(reference.previewUrl));
            referenceAudiosRef.current.forEach((reference) => revokeObjectUrl(reference.previewUrl));
        };
    }, [startImageUrl, endImageUrl]);

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
        if (videoModel.modeOptions?.length) {
            if (!videoModel.modeOptions.some((option) => option.value === mode)) {
                setMode(videoModel.modeOptions[0].value);
            }
        } else if (mode !== '') {
            setMode('');
        }

        if (!(videoModel.aspectRatios as readonly string[]).includes(aspectRatio)) {
            setAspectRatio(videoModel.aspectRatios[0]);
        }

        if (!isValidVideoDuration(selectedModel, singleDuration)) {
            setSingleDuration(getDefaultVideoDuration(selectedModel));
        }

        if (videoModel.resolutions?.length) {
            if (!(videoModel.resolutions as readonly string[]).includes(resolution)) {
                setResolution(videoModel.resolutions[0]);
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
    }, [selectedModel, videoModel, mode, aspectRatio, singleDuration, resolution]);

    useEffect(() => {
        if (!canUseVideoElements || elements.length <= videoElementSupport.maxElements) {
            return;
        }

        const nextElements = hydrateVideoElements(elements.slice(0, videoElementSupport.maxElements));
        elements.slice(videoElementSupport.maxElements).forEach((element) => revokeObjectUrl(element.previewUrl));
        commitElements(nextElements);
        void persistVideoElements(nextElements);
    }, [canUseVideoElements, elements, videoElementSupport.maxElements]);

    useEffect(() => {
        if (!remixId) return;
        if (!session?.access_token) return;

        let isCancelled = false;

        const fetchRemixData = async () => {
            try {
                const response = await fetch(`/api/remix-source?id=${remixId}`, {
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
                    setPrompt(bundle.generation.prompt);
                    if (settings?.duration) setSingleDuration(settings.duration);
                }

                if (settings?.aspectRatio) setAspectRatio(settings.aspectRatio);
                if (settings?.sound !== undefined) setSound(settings.sound);
                if (settings?.resolution) setResolution(settings.resolution);
                if (settings?.fixedLens !== undefined) setFixedLens(settings.fixedLens);
                if (settings?.referenceMode === 'frames' || settings?.referenceMode === 'elements') {
                    setReferenceMode(settings.referenceMode);
                }
                setMode(nextMode);

                const restoredVideoInputs = bundle.inputs.video;
                const restoredSeedanceAssets = settings?.seedanceAssets ?? null;

                if (isSeedance2VideoModelId(nextModelId)) {
                    setReferenceMode('elements');
                    const elementSupport = getVideoElementSupport(nextModelId, {
                        mode: nextMode,
                        isMultiShot: nextIsMultiShot,
                    });
                    const restoredSeeds = createRemixElementSeeds(
                        restoredVideoInputs?.elements ?? [],
                        elementSupport.maxElements
                    ).map((seed, index) => ({
                        ...seed,
                        file: null,
                        seedanceAsset: restoredSeedanceAssets?.images?.[index] ?? undefined,
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
                    commitReferenceVideos(hydrateSeedanceMediaReferences(
                        'Video',
                        (settings?.referenceVideoUrls ?? []).map((url, index) => ({
                            displayName: `Video reference ${index + 1}`,
                            file: null,
                            previewUrl: url,
                            providerUrl: url,
                            source: 'remix',
                            seedanceAsset: restoredSeedanceAssets?.videos?.[index] ?? undefined,
                        }))
                    ));
                    commitReferenceAudios(hydrateSeedanceMediaReferences(
                        'Audio',
                        (settings?.referenceAudioUrls ?? []).map((url, index) => ({
                            displayName: `Audio reference ${index + 1}`,
                            file: null,
                            previewUrl: '',
                            providerUrl: url,
                            source: 'remix',
                            seedanceAsset: restoredSeedanceAssets?.audios?.[index] ?? undefined,
                        }))
                    ));

                    setStartImageFile(null);
                    setStartImageUrl(null);
                    setStartFrameDescriptor(null);
                    setEndImageFile(null);
                    setEndImageUrl(null);
                    setEndFrameDescriptor(null);
                } else {
                    const restoreMode = restoredVideoInputs?.referenceMode === 'elements' ? 'elements' : 'frames';
                    setReferenceMode(restoreMode);
                    commitElements([]);
                    commitReferenceVideos([]);
                    commitReferenceAudios([]);

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
    }, [remixId, session?.access_token]);

    useEffect(() => {
        if (remixId) {
            return;
        }

        let isMounted = true;

        const loadPersistedMedia = async () => {
            try {
                const [savedStartImage, savedEndImage, savedElements, savedReferenceMode, savedReferenceVideos, savedReferenceAudios, savedSeedanceAssets] = await Promise.all([
                    getPersistedFile(PERSISTED_MEDIA_KEYS.createVideoStartImage),
                    getPersistedFile(PERSISTED_MEDIA_KEYS.createVideoEndImage),
                    getPersistedImageElementRecords(PERSISTED_MEDIA_KEYS.createVideoElements),
                    getPersistedValue<'frames' | 'elements'>(PERSISTED_MEDIA_KEYS.createVideoReferenceMode),
                    getPersistedMediaRecords(PERSISTED_MEDIA_KEYS.createVideoReferenceVideos),
                    getPersistedMediaRecords(PERSISTED_MEDIA_KEYS.createVideoReferenceAudios),
                    getPersistedValue<SeedanceAssetCollections>(PERSISTED_MEDIA_KEYS.createVideoSeedanceAssets),
                ]);

                if (!isMounted) return;

                if (savedReferenceMode === 'frames' || savedReferenceMode === 'elements') {
                    setReferenceMode(savedReferenceMode);
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
                            file: reference.file,
                            previewUrl: '',
                            source: 'upload',
                            seedanceAsset: savedSeedanceAssets?.audios?.[index] ?? undefined,
                        }))
                    ));
                }
            } catch (err) {
                console.error('Error loading persisted video media:', err);
            }
        };

        void loadPersistedMedia();

        return () => {
            isMounted = false;
        };
    }, [remixId]);

    const addShot = () => {
        setMultiPrompts([...multiPrompts, { id: Math.random().toString(), prompt: '', duration: 5 }]);
    };

    const removeShot = (id: string) => {
        if (multiPrompts.length > 1) {
            setMultiPrompts(multiPrompts.filter((shot) => shot.id !== id));
        }
    };

    const updateShot = (id: string, field: 'prompt' | 'duration', value: string | number) => {
        setMultiPrompts(multiPrompts.map((shot) => shot.id === id ? { ...shot, [field]: value } : shot));
    };

    const setReferenceModeWithPersistence = async (nextMode: 'frames' | 'elements') => {
        setReferenceMode(nextMode);
        if (remixId) {
            return;
        }
        await setPersistedValue(PERSISTED_MEDIA_KEYS.createVideoReferenceMode, nextMode);
    };

    const persistFrame = async (file: File, type: 'start' | 'end') => {
        await setReferenceModeWithPersistence('frames');

        if (type === 'start') {
            revokeObjectUrl(startImageUrl);
            setStartImageFile(file);
            setStartImageUrl(URL.createObjectURL(file));
            setStartFrameDescriptor(null);
            if (!remixId) {
                await setPersistedFile(PERSISTED_MEDIA_KEYS.createVideoStartImage, file);
            }
            return;
        }

        revokeObjectUrl(endImageUrl);
        setEndImageFile(file);
        setEndImageUrl(URL.createObjectURL(file));
        setEndFrameDescriptor(null);
        if (!remixId) {
            await setPersistedFile(PERSISTED_MEDIA_KEYS.createVideoEndImage, file);
        }
    };

    const processElementFiles = async (files: FileList | File[]) => {
        const validFiles = Array.from(files).filter((file) => file.type.startsWith('image/'));
        if (validFiles.length === 0) return;

        const currentElements = elementsRef.current;
        const availableSlots = videoElementSupport.maxElements - currentElements.length;
        const filesToAdd = validFiles.slice(0, availableSlots);
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
        await setReferenceModeWithPersistence('elements');
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
        if (file && file.type.startsWith('image/')) {
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

    const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>, type: 'start' | 'end') => {
        const file = event.target.files?.[0];
        if (file && file.type.startsWith('image/')) {
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
        const validFiles = Array.from(files).filter((file) => file.type.startsWith('video/'));
        if (validFiles.length === 0) return;

        const availableSlots = Math.max(0, 3 - referenceVideosRef.current.length);
        const filesToAdd = validFiles.slice(0, availableSlots);
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

    const processReferenceAudioFiles = async (files: FileList | File[]) => {
        const validFiles = Array.from(files).filter((file) => file.type.startsWith('audio/'));
        if (validFiles.length === 0) return;

        const availableSlots = Math.max(0, 3 - referenceAudiosRef.current.length);
        const filesToAdd = validFiles.slice(0, availableSlots);
        if (filesToAdd.length === 0) return;

        const seeds = filesToAdd.map((file, index) => ({
            displayName: `Audio reference ${referenceAudiosRef.current.length + index + 1}`,
            file,
            previewUrl: '',
            source: 'upload' as const,
        }));

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
            if (!remixId) {
                await removePersistedMedia(PERSISTED_MEDIA_KEYS.createVideoStartImage);
            }
        } else {
            revokeObjectUrl(endImageUrl);
            setEndImageFile(null);
            setEndImageUrl(null);
            setEndFrameDescriptor(null);
            if (!remixId) {
                await removePersistedMedia(PERSISTED_MEDIA_KEYS.createVideoEndImage);
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

        setElementNameDrafts((prev) => {
            if (!(elementId in prev)) {
                return prev;
            }

            const nextDrafts = { ...prev };
            delete nextDrafts[elementId];
            return nextDrafts;
        });
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

    const handleRemoveReferenceAudio = async (referenceId: string) => {
        const nextReferences = referenceAudiosRef.current.filter((reference) => reference.id !== referenceId);
        commitReferenceAudios(nextReferences);
        await persistReferenceAudios(nextReferences);
        await persistSeedanceAssets(elementsRef.current, referenceVideosRef.current, nextReferences);
    };

    const handleElementRename = async (elementId: string, nextDisplayName: string) => {
        const currentElements = elementsRef.current;
        const nextElements = hydrateVideoElements(
            currentElements.map((element) => (
                element.id === elementId
                    ? { ...element, displayName: nextDisplayName }
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

    const handleElementDraftChange = (elementId: string, nextValue: string) => {
        setElementNameDrafts((prev) => ({
            ...prev,
            [elementId]: nextValue,
        }));
    };

    const commitElementDraft = async (elementId: string) => {
        const draftValue = elementNameDrafts[elementId];
        if (draftValue === undefined) return;

        const trimmed = draftValue.trim();
        setElementNameDrafts((prev) => {
            const nextDrafts = { ...prev };
            delete nextDrafts[elementId];
            return nextDrafts;
        });

        if (!trimmed) return;

        const currentElement = elementsRef.current.find((element) => element.id === elementId);
        if (!currentElement || currentElement.displayName === trimmed) {
            return;
        }

        await handleElementRename(elementId, trimmed);
    };

    const handlePromptChange = (value: string, caretIndex?: number) => {
        setPrompt(value);
        updateMentionState(value, caretIndex);
    };

    const syncPromptCaretState = () => {
        updateMentionState(prompt);
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

        if (!currentIsMultiShot && canUseVideoElements && activeReferenceMode !== 'elements') {
            void setReferenceModeWithPersistence('elements');
        }

        setPrompt(nextValue.prompt);
        setActiveMentionQuery(null);

        requestAnimationFrame(() => {
            textarea?.focus();
            textarea?.setSelectionRange(nextValue.caretIndex, nextValue.caretIndex);
        });
    };

    const uploadToSupabase = async (file: File): Promise<{ signedUrl: string; storagePath: string }> => {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('Please log in to upload files.');

        const fileExt = file.name.split('.').pop();
        const fileName = `${user.id}/${Math.random().toString(36).substring(2)}.${fileExt}`;
        const { error: uploadError } = await supabase.storage.from('uploads').upload(fileName, file);
        if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

        const { data: signedData, error: signedUrlError } = await supabase.storage
            .from('uploads')
            .createSignedUrl(fileName, 3600);

        if (signedUrlError || !signedData?.signedUrl) {
            throw new Error(`Signed URL generation failed: ${signedUrlError?.message || 'Unknown error'}`);
        }

        return {
            signedUrl: signedData.signedUrl,
            storagePath: `uploads/${fileName}`,
        };
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

        const upload = await uploadToSupabase(element.file);
        return {
            ...element,
            providerUrl: upload.signedUrl,
            storagePath: upload.storagePath,
            seedanceAsset: {
                ...element.seedanceAsset,
                assetType: 'Image',
                sourceUrl: upload.signedUrl,
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

        const upload = await uploadToSupabase(reference.file);
        return {
            ...reference,
            providerUrl: upload.signedUrl,
            storagePath: upload.storagePath,
            seedanceAsset: {
                ...reference.seedanceAsset,
                assetType,
                sourceUrl: upload.signedUrl,
            },
        };
    };

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
            }),
            Date.now()
        ));
    };

    const pollPrediction = async (
        predictionId: string,
        accessToken: string,
        startedAtMs: number
    ): Promise<{ output: string; timing: GenerationTiming | null }> => {
        const maxAttempts = 120;
        let attempts = 0;

        while (attempts < maxAttempts) {
            const response = await fetch(`/api/generate-video?id=${predictionId}`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            const data = await response.json() as GenerationStatusResponse;

            if (data.timing) {
                setGenerationTiming(data.timing);
            } else {
                setGenerationTiming((current) => current ?? createLocalGenerationTiming({
                    kind: 'video',
                    phaseLabel: 'Waiting for provider',
                    startedAtMs,
                }));
            }

            if (data.status === 'succeeded') {
                return {
                    output: data.output || '',
                    timing: data.timing ?? null,
                };
            }

            if (data.status === 'failed') {
                throw new Error(data.error || 'Video generation failed');
            }

            await new Promise((resolve) => setTimeout(resolve, 5000));
            attempts++;
        }

        throw new Error(BACKGROUND_PROCESSING_ERROR);
    };

    const migrateFramesToSeedanceReferences = async () => {
        const nextSeeds: VideoElementSeed[] = [];

        if (startImageUrl) {
            nextSeeds.push({
                displayName: 'Image reference 1',
                file: startImageFile,
                previewUrl: startImageUrl,
                providerUrl: startImageFile ? null : startImageUrl,
                storagePath: startFrameDescriptor?.storagePath ?? null,
                source: startImageFile ? 'upload' : 'remix',
                sourceGenerationId: startFrameDescriptor?.sourceGenerationId ?? null,
            });
        }

        if (endImageUrl) {
            nextSeeds.push({
                displayName: `Image reference ${nextSeeds.length + 1}`,
                file: endImageFile,
                previewUrl: endImageUrl,
                providerUrl: endImageFile ? null : endImageUrl,
                storagePath: endFrameDescriptor?.storagePath ?? null,
                source: endImageFile ? 'upload' : 'remix',
                sourceGenerationId: endFrameDescriptor?.sourceGenerationId ?? null,
            });
        }

        if (nextSeeds.length === 0) {
            return;
        }

        const nextElements = hydrateVideoElements([...elementsRef.current, ...nextSeeds]);
        commitElements(nextElements);
        await persistVideoElements(nextElements);
        await persistSeedanceAssets(nextElements, referenceVideosRef.current, referenceAudiosRef.current);

        revokeObjectUrl(startImageUrl);
        revokeObjectUrl(endImageUrl);
        setStartImageFile(null);
        setStartImageUrl(null);
        setStartFrameDescriptor(null);
        setEndImageFile(null);
        setEndImageUrl(null);
        setEndFrameDescriptor(null);
        if (!remixId) {
            await Promise.all([
                removePersistedMedia(PERSISTED_MEDIA_KEYS.createVideoStartImage),
                removePersistedMedia(PERSISTED_MEDIA_KEYS.createVideoEndImage),
            ]);
        }
    };

    const handleSelectModel = (modelId: VideoModelId) => {
        const nextModel = VIDEO_MODELS[modelId];

        setSelectedModel(modelId);
        setIsModelDropdownOpen(false);
        setMode(nextModel.modeOptions[0]?.value || '');
        setAspectRatio(nextModel.aspectRatios[0]);
        setSingleDuration(getDefaultVideoDuration(modelId));
        setResolution(nextModel.resolutions[0] || '');
        setSound(false);
        setFixedLens(false);

        if (!nextModel.supportsMultiShot) {
            setIsMultiShot(false);
        }

        if (isSeedance2VideoModelId(modelId)) {
            void setReferenceModeWithPersistence('elements');
            if (startImageUrl || endImageUrl) {
                void migrateFramesToSeedanceReferences();
            }
        }
    };

    useEffect(() => {
        const resumePendingGeneration = async () => {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) return;

            const { data, error: pendingError } = await supabase
                .from('generations')
                .select('id, prediction_id, status, created_at')
                .eq('user_id', session.user.id)
                .eq('category', 'video')
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
                const result = await pollPrediction(data.prediction_id, session.access_token, startedAtMs);
                setOutputVideo(result.output);
                if (result.timing) {
                    setGenerationTiming(result.timing);
                }
            } catch (generationError) {
                const errorMessage = generationError instanceof Error ? generationError.message : 'Something went wrong';
                if (errorMessage === BACKGROUND_PROCESSING_ERROR) {
                    handoffToBackgroundProcessing(startedAtMs);
                } else {
                    setError(errorMessage);
                    setGenerationTiming(null);
                }
            } finally {
                setIsGenerating(false);
            }
        };

        void resumePendingGeneration();
    }, []);

    const handleGenerate = async () => {
        if (isMultiShot) {
            if (multiPrompts.some((shot) => !shot.prompt.trim())) {
                setError('All shots must have a prompt');
                return;
            }
        } else if (!prompt.trim()) {
            setError('Please enter a prompt');
            return;
        }

        if (!currentIsMultiShot && staleElementMentions.length > 0) {
            setError(`Unknown element mention${staleElementMentions.length > 1 ? 's' : ''}: ${staleElementMentions.join(', ')}`);
            return;
        }

        if (!currentIsMultiShot && hasInactiveElementMentions) {
            setError(videoElementSupport.reason || 'Named elements are not available in this video mode.');
            return;
        }

        if (!currentIsMultiShot && activeReferenceMode !== 'elements' && hasKnownElementMentions) {
            setError('Switch the reference mode to Elements to use @mentions in the video prompt.');
            return;
        }

        if (isSeedance2Family && referenceVideos.length > 3) {
            setError('Seedance 2 supports up to 3 reference videos per run.');
            return;
        }

        if (isSeedance2Family) {
            const knownReferenceVideoDuration = referenceVideos.reduce((total, reference) => {
                return total + (typeof reference.durationSeconds === 'number' ? reference.durationSeconds : 0);
            }, 0);
            if (knownReferenceVideoDuration > 15) {
                setError('Seedance 2 reference videos must stay within the 15 second combined limit.');
                return;
            }
        }

        if (insufficientCredits) {
            setError(`Insufficient credits. This costs ${estimatedCost} credits.`);
            return;
        }

        setIsGenerating(true);
        setError(null);
        setOutputVideo(null);
        setLatestGenerationId(null);
        setLatestIsPublic(false);
        setPublishedMeta(null);
        const startedAtMs = Date.now();
        setGenerationTiming(createLocalGenerationTiming({
            kind: 'video',
            phaseLabel: 'Preparing inputs',
            startedAtMs,
        }));

        try {
            let startUrl: string | null = activeReferenceMode === 'frames' ? startImageUrl : null;
            let endUrl: string | null = activeReferenceMode === 'frames' ? endImageUrl : null;
            let nextStartFrameDescriptor = startFrameDescriptor;
            let nextEndFrameDescriptor = endFrameDescriptor;
            const requestElements: ImageElementDescriptor[] = [];
            let elementImageUrls: string[] = [];
            const requestReferenceVideoUrls: string[] = [];
            const requestReferenceAudioUrls: string[] = [];
            const nextSeedanceAssets: SeedanceAssetCollections = {
                images: [],
                videos: [],
                audios: [],
            };

            if (!currentIsMultiShot && activeReferenceMode === 'elements' && elements.length > 0) {
                setGenerationTiming(createLocalGenerationTiming({
                    kind: 'video',
                    phaseLabel: elements.length === 1 ? 'Uploading 1 image reference' : `Uploading ${elements.length} image references`,
                    startedAtMs,
                }));

                const uploadedElements = await Promise.all(elements.map(async (element) => {
                    const preparedElement = await ensureUploadedElement(element);
                    const imageUrl = preparedElement.providerUrl || preparedElement.previewUrl;
                    if (!imageUrl) {
                        throw new Error(`Missing media for ${element.displayName}`);
                    }

                    const nextAsset = {
                        ...preparedElement.seedanceAsset,
                        assetType: 'Image' as const,
                        sourceUrl: preparedElement.providerUrl || preparedElement.seedanceAsset.sourceUrl,
                    };

                    return {
                        descriptor: {
                            id: preparedElement.id,
                            displayName: preparedElement.displayName,
                            handle: preparedElement.handle,
                            storagePath: preparedElement.storagePath ?? null,
                            sourceGenerationId: preparedElement.sourceGenerationId ?? null,
                        } satisfies ImageElementDescriptor,
                        imageUrl: getPreferredSeedanceReferenceValue(imageUrl, nextAsset) || imageUrl,
                        asset: nextAsset,
                    };
                }));

                requestElements.push(...uploadedElements.map((item) => item.descriptor));
                elementImageUrls = uploadedElements.map((item) => item.imageUrl);
                nextSeedanceAssets.images = uploadedElements.map((item) => item.asset);
            }

            if (isSeedance2Family && referenceVideos.length > 0) {
                setGenerationTiming(createLocalGenerationTiming({
                    kind: 'video',
                    phaseLabel: referenceVideos.length === 1 ? 'Uploading 1 reference video' : `Uploading ${referenceVideos.length} reference videos`,
                    startedAtMs,
                }));
                const uploadedReferences = await Promise.all(referenceVideos.map(async (reference) => {
                    const preparedReference = await ensureUploadedReference(reference, 'Video');
                    const sourceUrl = preparedReference.providerUrl || preparedReference.previewUrl;
                    if (!sourceUrl) {
                        throw new Error(`Missing media for ${reference.displayName}`);
                    }

                    const nextAsset = {
                        ...preparedReference.seedanceAsset,
                        assetType: 'Video' as const,
                        sourceUrl: preparedReference.providerUrl || preparedReference.seedanceAsset.sourceUrl,
                    };

                    return {
                        url: getPreferredSeedanceReferenceValue(sourceUrl, nextAsset) || sourceUrl,
                        asset: nextAsset,
                    };
                }));

                requestReferenceVideoUrls.push(...uploadedReferences.map((item) => item.url));
                nextSeedanceAssets.videos = uploadedReferences.map((item) => item.asset);
            }

            if (isSeedance2Family && referenceAudios.length > 0) {
                setGenerationTiming(createLocalGenerationTiming({
                    kind: 'video',
                    phaseLabel: referenceAudios.length === 1 ? 'Uploading 1 reference audio clip' : `Uploading ${referenceAudios.length} reference audio clips`,
                    startedAtMs,
                }));
                const uploadedReferences = await Promise.all(referenceAudios.map(async (reference) => {
                    const preparedReference = await ensureUploadedReference(reference, 'Audio');
                    const sourceUrl = preparedReference.providerUrl || preparedReference.previewUrl;
                    if (!sourceUrl) {
                        throw new Error(`Missing media for ${reference.displayName}`);
                    }

                    const nextAsset = {
                        ...preparedReference.seedanceAsset,
                        assetType: 'Audio' as const,
                        sourceUrl: preparedReference.providerUrl || preparedReference.seedanceAsset.sourceUrl,
                    };

                    return {
                        url: getPreferredSeedanceReferenceValue(sourceUrl, nextAsset) || sourceUrl,
                        asset: nextAsset,
                    };
                }));

                requestReferenceAudioUrls.push(...uploadedReferences.map((item) => item.url));
                nextSeedanceAssets.audios = uploadedReferences.map((item) => item.asset);
            }

            if (activeReferenceMode === 'frames' && startImageFile) {
                setGenerationTiming(createLocalGenerationTiming({
                    kind: 'video',
                    phaseLabel: 'Uploading start frame',
                    startedAtMs,
                }));
                const upload = await uploadToSupabase(startImageFile);
                startUrl = upload.signedUrl;
                nextStartFrameDescriptor = {
                    kind: 'image',
                    label: 'Start frame',
                    storagePath: upload.storagePath,
                    sourceGenerationId: null,
                };
            }

            if (activeReferenceMode === 'frames' && endImageFile && !isMultiShot) {
                setGenerationTiming(createLocalGenerationTiming({
                    kind: 'video',
                    phaseLabel: 'Uploading end frame',
                    startedAtMs,
                }));
                const upload = await uploadToSupabase(endImageFile);
                endUrl = upload.signedUrl;
                nextEndFrameDescriptor = {
                    kind: 'image',
                    label: 'End frame',
                    storagePath: upload.storagePath,
                    sourceGenerationId: null,
                };
            }

            setGenerationTiming(createLocalGenerationTiming({
                kind: 'video',
                phaseLabel: 'Submitting video run',
                startedAtMs,
            }));

            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                router.push('/login?returnUrl=/create-video');
                return;
            }

            const payload = {
                model: selectedModel,
                isMultiShot: currentIsMultiShot,
                prompt: prompt.trim(),
                multiPrompts,
                duration: totalDuration,
                elements: requestElements,
                elementImageUrls,
                referenceVideoUrls: requestReferenceVideoUrls,
                referenceAudioUrls: requestReferenceAudioUrls,
                startImageUrl: startUrl,
                endImageUrl: endUrl,
                mode: currentMode,
                aspectRatio: currentAspectRatio,
                sound: currentSound,
                resolution: currentResolution,
                fixedLens: currentFixedLens,
                referenceMode: activeReferenceMode,
                startFrame: activeReferenceMode === 'frames' ? nextStartFrameDescriptor : undefined,
                endFrame: activeReferenceMode === 'frames' ? nextEndFrameDescriptor : undefined,
                seedanceAssets: isSeedance2Family ? nextSeedanceAssets : undefined,
                sourceGenerationId: remixId || undefined,
            };

            const response = await fetch('/api/generate-video', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${session.access_token}`,
                },
                body: JSON.stringify(payload),
            });

            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'Failed to start generation');
            setLatestGenerationId(data.generationId ?? null);
            setLatestIsPublic(false);

            const result = await pollPrediction(data.predictionId, session.access_token, startedAtMs);
            setOutputVideo(result.output);
            if (result.timing) {
                setGenerationTiming(result.timing);
            }
            if (data.remainingCredits !== undefined) updateCredits(data.remainingCredits);
        } catch (generationError) {
            const errorMessage = generationError instanceof Error ? generationError.message : 'Something went wrong';
            if (errorMessage === BACKGROUND_PROCESSING_ERROR) {
                handoffToBackgroundProcessing(startedAtMs);
            } else {
                setError(errorMessage);
                setGenerationTiming(null);
            }
        } finally {
            setIsGenerating(false);
        }
    };

    if (isLoadingUser) {
        return (
            <div className="min-h-screen bg-black text-white flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-zinc-500" />
            </div>
        );
    }
    const isBackgroundProcessing = error === BACKGROUND_PROCESSING_ERROR;
    const backgroundProcessingCopy = getBackgroundProcessingCopy('video');
    const backgroundTiming = generationTiming ? freezeGenerationTiming(generationTiming, nowMs) : null;
    const backgroundTimingLabel = backgroundTiming ? getGenerationTimingSummaryLabel(backgroundTiming, nowMs) : null;

    const workspaceTitle = outputVideo
        ? 'Latest video result'
        : isGenerating
            ? 'Creating your video'
            : isBackgroundProcessing
                ? backgroundProcessingCopy.title
            : 'Ready to build a scene';

    const workspaceDescription = outputVideo
        ? 'Your newest video stays here until you start another run.'
        : isGenerating
            ? 'Track the active run here while the model handles timing, frames, and render.'
            : isBackgroundProcessing
                ? backgroundProcessingCopy.description
            : isSeedance2Family
                ? 'The workspace will show the current run and latest result once your Seedance references are ready to render.'
            : activeReferenceMode === 'elements'
                ? 'The workspace will show the current run and latest result once your named-element scene starts rendering.'
                : 'The workspace will show the current run and latest result once you generate.';
    const primarySharePrompt = publishedMeta?.description
        || prompt.trim()
        || multiPrompts.map((shot) => shot.prompt.trim()).find(Boolean)
        || null;
    const shareTitle = publishedMeta?.title
        || prompt.trim()
        || multiPrompts.map((shot) => shot.prompt.trim()).find(Boolean)
        || `${videoModel.displayName} video`;
    const publicResultPath = latestGenerationId && latestIsPublic ? buildShowcaseDetailPath(latestGenerationId) : null;

    return (
        <div className="min-h-screen bg-black py-6 text-white sm:py-8 font-[family-name:var(--font-geist-sans)]">
            <div className="fixed inset-0 z-0 pointer-events-none">
                <div className="absolute top-[10%] left-[-10%] w-[40%] h-[40%] bg-blue-900/15 blur-[120px] rounded-full mix-blend-screen" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-900/10 blur-[120px] rounded-full mix-blend-screen" />
            </div>

            <MediaStudioShell
                currentToolId="video"
                header={
                    <GeneratorPageHeader
                        currentToolId="video"
                        title="Create video"
                        eyebrow={`Creator studio / ${videoModel.displayName}`}
                        description="Start with video when the idea needs movement, presence, or a clearer story in the very first output."
                        credits={userCredits}
                        showPathSwitcher={false}
                    />
                }
                controls={
                    <>
                        <AnimatePresence>
                            {remixId && !isRemixLoading && (
                                <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}>
                                    <StudioRemixNotice
                                        description={`${`Settings pre-filled from ${remixTitle ? `"${remixTitle}"` : 'the original creation'}.`}${remixRestoreWarning ? ` ${remixRestoreWarning}` : ''}`}
                                        action={
                                            remixVideoUrl ? (
                                                <button
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
                        </AnimatePresence>

                        <motion.div
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="relative"
                            ref={modelDropdownRef}
                        >
                            <p className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Video Model</p>
                            <button
                                onClick={() => setIsModelDropdownOpen((prev) => !prev)}
                                className="w-full flex items-center justify-between gap-3 px-5 py-4 bg-zinc-900/50 border border-white/10 rounded-2xl hover:bg-zinc-900/70 hover:border-white/15 transition-all backdrop-blur-sm"
                            >
                                <div className="flex items-center gap-3">
                                    <Video className="w-4 h-4 text-white" />
                                    <div className="text-left">
                                        <div className="text-sm font-bold text-white">{videoModel.displayName}</div>
                                        <p className="text-xs text-zinc-500 mt-0.5">{videoModel.description}</p>
                                    </div>
                                </div>
                                <ChevronDown className={`w-4 h-4 text-zinc-400 transition-transform duration-200 ${isModelDropdownOpen ? 'rotate-180' : ''}`} />
                            </button>

                            <AnimatePresence>
                                {isModelDropdownOpen && (
                                    <motion.div
                                        initial={{ opacity: 0, y: -8, scaleY: 0.95 }}
                                        animate={{ opacity: 1, y: 0, scaleY: 1 }}
                                        exit={{ opacity: 0, y: -8, scaleY: 0.95 }}
                                        transition={{ duration: 0.15 }}
                                        className="absolute z-50 mt-2 w-full bg-zinc-900/95 border border-white/10 rounded-2xl overflow-hidden backdrop-blur-xl shadow-[0_16px_48px_-12px_rgba(0,0,0,0.8)]"
                                        style={{ transformOrigin: 'top' }}
                                    >
                                        {(Object.values(VIDEO_MODELS) as typeof VIDEO_MODELS[VideoModelId][]).map((modelOption) => {
                                            const isActive = selectedModel === modelOption.id;
                                            const modelOptionDurationRange = getVideoDurationRange(modelOption.id);

                                            return (
                                                <button
                                                    key={modelOption.id}
                                                    onClick={() => handleSelectModel(modelOption.id)}
                                                    className={`w-full text-left px-5 py-4 flex items-center gap-3 transition-all ${isActive ? 'bg-white/5' : 'hover:bg-white/[0.03]'}`}
                                                >
                                                    <div className="flex-1 min-w-0">
                                                        <span className={`text-sm font-bold ${isActive ? 'text-white' : 'text-zinc-300'}`}>
                                                            {modelOption.displayName}
                                                        </span>
                                                        <p className="text-xs text-zinc-500 mt-0.5">{modelOption.description}</p>
                                                        <div className="flex flex-wrap gap-1.5 mt-2">
                                                            {modelOption.supportsMultiShot && (
                                                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-300 border border-purple-500/20">
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
                                                    {isActive && <Check className="w-4 h-4 text-blue-400 shrink-0" />}
                                                </button>
                                            );
                                        })}
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </motion.div>

                        {videoModel.supportsMultiShot && (
                            <div className="bg-zinc-900/30 border border-white/5 rounded-3xl p-2 flex gap-2 backdrop-blur-sm self-start">
                                <button
                                    onClick={() => setIsMultiShot(false)}
                                    className={`px-6 py-2.5 rounded-2xl text-sm font-bold transition-all ${!currentIsMultiShot ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'text-zinc-500 hover:text-white'}`}
                                >
                                    Single Shot
                                </button>
                                <button
                                    onClick={() => setIsMultiShot(true)}
                                    className={`px-6 py-2.5 rounded-2xl text-sm font-bold transition-all ${currentIsMultiShot ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' : 'text-zinc-500 hover:text-white'}`}
                                >
                                    Multi-Shot
                                </button>
                            </div>
                        )}

                        <AnimatePresence mode="popLayout">
                            {!currentIsMultiShot ? (
                                <motion.div
                                    key="single-shot"
                                    initial={{ opacity: 0, scale: 0.95 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.95 }}
                                    transition={{ duration: 0.2 }}
                                    className="bg-zinc-900/30 border border-white/5 rounded-3xl p-6 backdrop-blur-sm"
                                >
                                    <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Video Prompt</h2>
                                    <EnhancePromptButton
                                        prompt={prompt}
                                        onEnhanced={(text) => {
                                            setPrompt(text);
                                            setActiveMentionQuery(null);
                                            requestAnimationFrame(() => updateMentionState(text));
                                        }}
                                        onCreditsUpdate={updateCredits}
                                        medium="video"
                                        selectedModel={videoModel.enhancerModelId}
                                        helperText={
                                            activeReferenceMode === 'elements' && elements.length > 0
                                                ? 'Named elements keep their @handles. This enhances the scene while preserving those references.'
                                                : undefined
                                        }
                                        context={{
                                            modelId: selectedModel,
                                            mode: currentMode,
                                            aspectRatio: currentAspectRatio,
                                            duration: totalDuration,
                                            sound: currentSound,
                                            fixedLens: currentFixedLens,
                                            resolution: currentResolution,
                                            isMultiShot: currentIsMultiShot,
                                            shotCount: multiPrompts.length,
                                            hasStartImage: !isSeedance2Family && activeReferenceMode === 'frames' && Boolean(startImageFile || startImageUrl),
                                            hasEndImage: !isSeedance2Family && activeReferenceMode === 'frames' && Boolean(endImageFile || endImageUrl),
                                            referenceImageCount: activeReferenceMode === 'elements' ? elements.length : 0,
                                            hasReferenceVideo: referenceVideos.length > 0,
                                            elementReferences: activeReferenceMode === 'elements'
                                                ? elements.map((element) => ({
                                                    handle: element.handle,
                                                    displayName: element.displayName,
                                                }))
                                                : undefined,
                                        }}
                                        disabled={isGenerating}
                                    />
                                    {(canUseVideoElements || elements.length > 0) && (
                                        <div className="mb-4 mt-4 space-y-3">
                                            <div className="flex items-center justify-between gap-3">
                                                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                                                    {isSeedance2Family ? 'Image references' : 'Named elements'}
                                                </p>
                                                <span className="text-xs text-zinc-500">
                                                    Type <span className="font-semibold text-zinc-300">@</span> to reference them in the prompt.
                                                </span>
                                            </div>
                                            {elements.length > 0 ? (
                                                <div className="flex flex-wrap gap-2">
                                                    {elements.map((element) => (
                                                        <button
                                                            key={element.id}
                                                            type="button"
                                                            onClick={() => handleInsertElementHandle(element.handle)}
                                                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-semibold text-zinc-200 transition hover:bg-white/[0.08] hover:text-white"
                                                        >
                                                            <span className="text-zinc-400">{element.displayName}</span>
                                                            <span className="text-sky-300">{element.handle}</span>
                                                        </button>
                                                    ))}
                                                </div>
                                            ) : (
                                                <p className="text-sm text-zinc-500">
                                                    {isSeedance2Family
                                                        ? 'Upload reference images below to anchor characters, products, or scenes directly in the prompt.'
                                                        : 'Upload element images below to mention people, products, or objects directly in the prompt.'}
                                                </p>
                                            )}
                                        </div>
                                    )}
                                    <textarea
                                        ref={promptTextareaRef}
                                        value={prompt}
                                        onChange={(event) => handlePromptChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
                                        onClick={syncPromptCaretState}
                                        onKeyUp={syncPromptCaretState}
                                        placeholder={`Describe the ${videoModel.displayName} scene in rich cinematic detail...`}
                                        maxLength={2500}
                                        className="w-full bg-black/50 text-white rounded-2xl p-5 border border-white/10 focus:border-blue-500/50 focus:ring-4 focus:ring-blue-500/10 outline-none resize-y min-h-[140px] text-sm leading-relaxed"
                                    />
                                    <div className="mt-2 flex items-center justify-between gap-3 text-xs">
                                        <span className="text-zinc-600">{prompt.length}/2500</span>
                                        {staleElementMentions.length > 0 ? (
                                            <span className="text-right text-rose-300">
                                                Unknown element mention{staleElementMentions.length > 1 ? 's' : ''}: {staleElementMentions.join(', ')}
                                            </span>
                                        ) : activeReferenceMode !== 'elements' && hasKnownElementMentions ? (
                                            <span className="text-right text-amber-300">
                                                Switch reference mode to Elements to use {knownElementMentions.join(', ')}.
                                            </span>
                                        ) : null}
                                    </div>
                                    {activeMentionQuery ? (
                                        <div className="mt-4 rounded-[20px] border border-white/8 bg-black/35 p-4">
                                            <div className="flex items-center justify-between gap-3">
                                                <div>
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
                                                    <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold text-zinc-300">
                                                        @{activeMentionQuery.query}
                                                    </span>
                                                ) : null}
                                            </div>
                                            {mentionSuggestions.length > 0 ? (
                                                <div className="mt-3 flex flex-wrap gap-2">
                                                    {mentionSuggestions.map((element) => (
                                                        <button
                                                            key={element.id}
                                                            type="button"
                                                            onClick={() => handleInsertElementHandle(element.handle)}
                                                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-semibold text-zinc-100 transition hover:bg-white/[0.08]"
                                                        >
                                                            <span className="text-zinc-400">{element.displayName}</span>
                                                            <span className="text-sky-300">{element.handle}</span>
                                                        </button>
                                                    ))}
                                                </div>
                                            ) : null}
                                        </div>
                                    ) : null}
                                    <div className="mt-4 flex items-center justify-between gap-4">
                                        <div className="flex items-center gap-3 flex-wrap">
                                            <span className="text-xs text-zinc-500 font-medium">Duration:</span>
                                            {singleShotDurationRange ? (
                                                <>
                                                    <input
                                                        type="range"
                                                        min={singleShotDurationRange.min}
                                                        max={singleShotDurationRange.max}
                                                        step="1"
                                                        value={currentDuration}
                                                        onChange={(event) => setSingleDuration(Number(event.target.value))}
                                                        className="w-36 accent-blue-500"
                                                    />
                                                    <span className="px-3 py-1.5 rounded-lg text-xs font-bold bg-white/10 text-white border border-white/20">
                                                        {currentDuration} sec
                                                    </span>
                                                    <span className="text-xs text-zinc-600">
                                                        {singleShotDurationRange.min}-{singleShotDurationRange.max}s
                                                    </span>
                                                </>
                                            ) : videoModel.durations.length > 1 ? (
                                                videoModel.durations.map((durationOption) => (
                                                    <button
                                                        key={durationOption}
                                                        onClick={() => setSingleDuration(durationOption)}
                                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${currentDuration === durationOption ? 'bg-white/10 text-white border border-white/20' : 'bg-black text-zinc-500 border border-white/5 hover:bg-zinc-800'}`}
                                                    >
                                                        {durationOption} sec
                                                    </button>
                                                ))
                                            ) : (
                                                <span className="px-3 py-1.5 rounded-lg text-xs font-bold bg-white/10 text-white border border-white/20">
                                                    {videoModel.durations[0]} sec fixed
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </motion.div>
                            ) : (
                                <motion.div
                                    key="multi-shot"
                                    initial={{ opacity: 0, scale: 0.95 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.95 }}
                                    transition={{ duration: 0.2 }}
                                    className="flex flex-col gap-4"
                                >
                                    <AnimatePresence>
                                        {multiPrompts.map((shot, index) => (
                                            <motion.div
                                                key={shot.id}
                                                initial={{ opacity: 0, height: 0 }}
                                                animate={{ opacity: 1, height: 'auto' }}
                                                exit={{ opacity: 0, height: 0 }}
                                                className="bg-zinc-900/30 border border-purple-500/20 rounded-3xl p-6 backdrop-blur-sm relative group"
                                            >
                                                <div className="flex justify-between items-center mb-3">
                                                    <h2 className="text-xs font-bold text-purple-400 uppercase tracking-widest">Shot {index + 1}</h2>
                                                    {multiPrompts.length > 1 && (
                                                        <button onClick={() => removeShot(shot.id)} className="text-zinc-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100">
                                                            <Trash2 className="w-4 h-4" />
                                                        </button>
                                                    )}
                                                </div>
                                                <EnhancePromptButton
                                                    prompt={shot.prompt}
                                                    onEnhanced={(text) => updateShot(shot.id, 'prompt', text)}
                                                    onCreditsUpdate={updateCredits}
                                                    medium="video"
                                                    selectedModel={videoModel.enhancerModelId}
                                                    context={{
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
                                                    }}
                                                    disabled={isGenerating}
                                                />
                                                <textarea
                                                    value={shot.prompt}
                                                    onChange={(event) => updateShot(shot.id, 'prompt', event.target.value)}
                                                    placeholder={`Describe shot ${index + 1}...`}
                                                    className="w-full bg-black/50 text-white rounded-2xl p-4 border border-white/10 focus:border-purple-500/50 outline-none resize-none min-h-[100px] text-sm mb-4"
                                                />
                                                <div className="flex items-center gap-3">
                                                    <span className="text-xs text-zinc-500 font-medium">Duration (1-12s):</span>
                                                    <input
                                                        type="range"
                                                        min="1"
                                                        max="12"
                                                        step="1"
                                                        value={shot.duration}
                                                        onChange={(event) => updateShot(shot.id, 'duration', parseInt(event.target.value))}
                                                        className="w-32 accent-purple-500"
                                                    />
                                                    <span className="text-xs font-bold text-white">{shot.duration}s</span>
                                                </div>
                                            </motion.div>
                                        ))}
                                    </AnimatePresence>

                                    <button
                                        onClick={addShot}
                                        className="w-full py-4 border-2 border-dashed border-zinc-800 rounded-3xl text-zinc-500 font-medium flex items-center justify-center gap-2 hover:border-purple-500/50 hover:text-purple-400 hover:bg-purple-500/5 transition-all"
                                    >
                                        <Plus className="w-5 h-5" /> Add New Shot
                                    </button>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {!currentIsMultiShot && canUseVideoElements && !isSeedance2Family && (
                            <motion.div
                                initial={{ opacity: 0, y: 16 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="bg-zinc-900/30 border border-white/5 rounded-3xl p-5 backdrop-blur-sm"
                            >
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <h2 className="text-sm font-semibold text-white">Reference mode</h2>
                                        <p className="mt-1 text-sm text-zinc-400">
                                            Use frames for continuity beats, or switch to named elements for reusable characters and products.
                                        </p>
                                    </div>
                                    <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-300">
                                        {videoElementSupport.maxElements} elements max
                                    </span>
                                </div>
                                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                                    <button
                                        type="button"
                                        onClick={() => void setReferenceModeWithPersistence('frames')}
                                        className={`rounded-2xl border px-4 py-3 text-left transition ${activeReferenceMode === 'frames' ? 'border-blue-500/40 bg-blue-500/15 text-white' : 'border-white/8 bg-black/40 text-zinc-400 hover:border-white/15 hover:text-white'}`}
                                    >
                                        <div className="text-sm font-semibold">Frames</div>
                                        <div className="mt-1 text-xs leading-5 text-inherit/80">
                                            Start from a single frame or define a clear start and end transition.
                                        </div>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void setReferenceModeWithPersistence('elements')}
                                        className={`rounded-2xl border px-4 py-3 text-left transition ${activeReferenceMode === 'elements' ? 'border-fuchsia-500/40 bg-fuchsia-500/15 text-white' : 'border-white/8 bg-black/40 text-zinc-400 hover:border-white/15 hover:text-white'}`}
                                    >
                                        <div className="text-sm font-semibold">Elements</div>
                                        <div className="mt-1 text-xs leading-5 text-inherit/80">
                                            Upload named references like <span className="font-semibold">@person</span> or <span className="font-semibold">@product</span> and mention them in the prompt.
                                        </div>
                                    </button>
                                </div>
                            </motion.div>
                        )}

                        {!currentIsMultiShot && canUseVideoElements && isSeedance2Family && (
                            <motion.div
                                initial={{ opacity: 0, y: 16 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="bg-zinc-900/30 border border-white/5 rounded-3xl p-5 backdrop-blur-sm"
                            >
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <h2 className="text-sm font-semibold text-white">Seedance references</h2>
                                        <p className="mt-1 text-sm text-zinc-400">
                                            Seedance 2 uses one unified reference surface. Add image references for identity, then layer video and audio clips when you want motion or timing guidance.
                                        </p>
                                    </div>
                                    <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-300">
                                        {videoElementSupport.maxElements} image refs max
                                    </span>
                                </div>
                                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                                    <div className="rounded-2xl border border-white/8 bg-black/30 p-3">
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Image refs</div>
                                        <div className="mt-2 text-sm text-zinc-100">{elements.length} connected</div>
                                    </div>
                                    <div className="rounded-2xl border border-white/8 bg-black/30 p-3">
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Video refs</div>
                                        <div className="mt-2 text-sm text-zinc-100">{referenceVideos.length}/3</div>
                                    </div>
                                    <div className="rounded-2xl border border-white/8 bg-black/30 p-3">
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Audio refs</div>
                                        <div className="mt-2 text-sm text-zinc-100">{referenceAudios.length}/3</div>
                                    </div>
                                </div>
                            </motion.div>
                        )}

                        {showSavedElementNotice && (
                            <div className="rounded-[26px] border border-amber-500/20 bg-amber-500/10 p-5">
                                <p className="text-sm font-semibold text-white">Saved named elements are on standby</p>
                                <p className="mt-2 text-sm leading-6 text-zinc-300">
                                    You have {elements.length} saved element{elements.length === 1 ? '' : 's'}, but this setup can&apos;t use them right now.
                                    {videoElementSupport.reason ? ` ${videoElementSupport.reason}` : ''} Switch to Seedance 1.5 Pro or Veo Fast single-shot to use those references.
                                </p>
                            </div>
                        )}

                        {showMultiShotElementNotice && (
                            <div className="rounded-[26px] border border-purple-500/20 bg-purple-500/10 p-5">
                                <p className="text-sm font-semibold text-white">Named elements are paused in multi-shot</p>
                                <p className="mt-2 text-sm leading-6 text-zinc-300">
                                    Your saved elements stay available, but multi-shot runs use shot prompts only in v1. Switch back to single-shot to reuse those named references.
                                </p>
                            </div>
                        )}

                        {showFramesEditor && (
                            <>
                                <div className={`grid gap-4 ${!currentIsMultiShot ? 'sm:grid-cols-2' : ''}`}>
                                    <div className="bg-zinc-900/30 border border-white/5 rounded-3xl p-5 backdrop-blur-sm">
                                        <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3 flex items-center justify-between">
                                            Start Frame <span className="text-[10px] text-zinc-600 normal-case">optional</span>
                                        </h2>
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
                                            </div>
                                        ) : (
                                            <label
                                                htmlFor="video-start-frame-input"
                                                className={`group flex h-[140px] w-full cursor-pointer flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed bg-black/40 transition-all ${isDraggingStart ? 'border-cyan-400 bg-cyan-500/10' : 'border-zinc-700/50 hover:border-cyan-500/50'}`}
                                                onDragOver={(event) => { event.preventDefault(); setIsDraggingStart(true); }}
                                                onDragLeave={(event) => { event.preventDefault(); setIsDraggingStart(false); }}
                                                onDrop={(event) => handleImageDrop(event, 'start')}
                                            >
                                                <div className="flex flex-col items-center gap-2 text-zinc-500"><ImageIcon className="w-6 h-6" /><span className="text-xs">Upload Start Frame</span></div>
                                            </label>
                                        )}
                                        <input
                                            ref={startImageInputRef}
                                            id="video-start-frame-input"
                                            type="file"
                                            accept="image/*"
                                            onChange={(event) => handleImageUpload(event, 'start')}
                                            className="hidden"
                                        />
                                    </div>

                                    {!currentIsMultiShot && (
                                        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="bg-zinc-900/30 border border-white/5 rounded-3xl p-5 backdrop-blur-sm">
                                            <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3 flex items-center justify-between">
                                                End Frame <span className="text-[10px] text-zinc-600 normal-case">optional</span>
                                            </h2>
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
                                                </div>
                                            ) : (
                                                <label
                                                    htmlFor="video-end-frame-input"
                                                    className={`group flex h-[140px] w-full cursor-pointer flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed bg-black/40 transition-all ${isDraggingEnd ? 'border-cyan-400 bg-cyan-500/10' : 'border-zinc-700/50 hover:border-cyan-500/50'}`}
                                                    onDragOver={(event) => { event.preventDefault(); setIsDraggingEnd(true); }}
                                                    onDragLeave={(event) => { event.preventDefault(); setIsDraggingEnd(false); }}
                                                    onDrop={(event) => handleImageDrop(event, 'end')}
                                                >
                                                    <div className="flex flex-col items-center gap-2 text-zinc-500"><ImageIcon className="w-6 h-6" /><span className="text-xs">Upload End Frame</span></div>
                                                </label>
                                            )}
                                            <input
                                                ref={endImageInputRef}
                                                id="video-end-frame-input"
                                                type="file"
                                                accept="image/*"
                                                onChange={(event) => handleImageUpload(event, 'end')}
                                                className="hidden"
                                            />
                                        </motion.div>
                                    )}
                                </div>
                                {hiddenElementDraftCount > 0 && !currentIsMultiShot ? (
                                    <div className="rounded-[22px] border border-white/8 bg-white/[0.03] px-4 py-3 text-sm text-zinc-400">
                                        {hiddenElementDraftCount} saved element{hiddenElementDraftCount === 1 ? '' : 's'} will be ready if you switch the reference mode back to Elements.
                                    </div>
                                ) : null}
                            </>
                        )}

                        {showElementEditor && (
                            <motion.div
                                initial={{ opacity: 0, y: 16 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(20,20,24,0.96),rgba(9,9,11,0.94))] p-5 shadow-[0_24px_90px_-56px_rgba(0,0,0,0.95)] sm:p-6"
                            >
                                <div className="mb-4 flex items-start justify-between gap-3">
                                    <div>
                                        <h2 className="text-sm font-semibold text-white">Elements</h2>
                                        <p className="mt-1 text-sm text-zinc-400">
                                            Upload named references, rename them, and mention them directly in the prompt for identity-aware video generation.
                                        </p>
                                    </div>
                                    <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-300">
                                        {elements.length}/{videoElementSupport.maxElements}
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
                                                        onClick={() => void handleRemoveElement(element.id)}
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
                                                            value={elementNameDrafts[element.id] ?? element.displayName}
                                                            onChange={(event) => handleElementDraftChange(element.id, event.target.value)}
                                                            onBlur={() => void commitElementDraft(element.id)}
                                                            onKeyDown={(event) => {
                                                                if (event.key === 'Enter') {
                                                                    event.preventDefault();
                                                                    void commitElementDraft(element.id);
                                                                    event.currentTarget.blur();
                                                                }

                                                                if (event.key === 'Escape') {
                                                                    setElementNameDrafts((prev) => {
                                                                        if (!(element.id in prev)) {
                                                                            return prev;
                                                                        }

                                                                        const nextDrafts = { ...prev };
                                                                        delete nextDrafts[element.id];
                                                                        return nextDrafts;
                                                                    });
                                                                    event.currentTarget.blur();
                                                                }
                                                            }}
                                                            className="w-full rounded-2xl border border-white/10 bg-black/45 px-3 py-2.5 text-sm text-white outline-none transition focus:border-blue-500/40"
                                                            placeholder="Rename element"
                                                        />
                                                    </div>
                                                    <div className="flex items-center justify-between gap-2 rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2">
                                                        <span className="truncate text-xs font-semibold text-sky-300">{element.handle}</span>
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

                                {elements.length < videoElementSupport.maxElements && (
                                    <label
                                        className={`group flex flex-col items-center justify-center w-full h-[120px] border-2 border-dashed rounded-2xl cursor-pointer transition-all bg-black/40 overflow-hidden relative ${isDraggingElements
                                            ? 'border-cyan-400 bg-cyan-500/10 shadow-[0_0_30px_-5px_rgba(6,182,212,0.3)]'
                                            : 'border-zinc-700/50 hover:border-cyan-500/50 hover:bg-cyan-500/5'
                                            }`}
                                        onDragOver={(event) => { event.preventDefault(); setIsDraggingElements(true); }}
                                        onDragLeave={(event) => { event.preventDefault(); setIsDraggingElements(false); }}
                                        onDrop={handleElementDrop}
                                    >
                                        <div className="flex flex-col items-center gap-2 text-zinc-500">
                                            <ImageIcon className={`w-6 h-6 transition-colors ${isDraggingElements ? 'text-cyan-400' : ''}`} />
                                            <span className="text-sm">{isDraggingElements ? 'Drop element images here' : 'Drop element images or click'}</span>
                                        </div>
                                        <input
                                            ref={elementInputRef}
                                            type="file"
                                            accept="image/*"
                                            multiple
                                            onChange={handleElementUpload}
                                            className="hidden"
                                        />
                                    </label>
                                )}

                                {hiddenFrameDraftCount > 0 ? (
                                    <p className="mt-4 text-sm text-zinc-500">
                                        Your start and end frames are still saved. Switch the reference mode back to Frames whenever you want to use that transition path again.
                                    </p>
                                ) : null}
                            </motion.div>
                        )}

                        {isSeedance2Family && !currentIsMultiShot && (
                            <>
                                <div className="rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(17,17,21,0.98),rgba(8,8,10,0.95))] p-5 shadow-[0_24px_90px_-56px_rgba(0,0,0,0.95)] sm:p-6">
                                    <div className="mb-4 flex items-start justify-between gap-3">
                                        <div>
                                            <h2 className="text-sm font-semibold text-white">Reference video and audio</h2>
                                            <p className="mt-1 text-sm text-zinc-400">
                                                Add motion clips or timing/audio references to steer Seedance 2 beyond still-image guidance.
                                            </p>
                                        </div>
                                        <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-300">
                                            3 video refs max
                                        </span>
                                    </div>

                                    <div className="grid gap-4 lg:grid-cols-2">
                                        <div className="space-y-3">
                                            <div className="flex items-center justify-between gap-3">
                                                <h3 className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">Reference videos</h3>
                                                <button
                                                    type="button"
                                                    onClick={() => referenceVideoInputRef.current?.click()}
                                                    disabled={referenceVideos.length >= 3}
                                                    className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-100 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
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
                                                <div className="space-y-3">
                                                    {referenceVideos.map((reference) => (
                                                        <div key={reference.id} className="rounded-2xl border border-white/8 bg-black/30 p-3">
                                                            <div className="flex items-start justify-between gap-3">
                                                                <div>
                                                                    <div className="text-sm font-semibold text-white">{reference.displayName}</div>
                                                                    <div className="mt-1 text-xs text-zinc-500">
                                                                        {typeof reference.durationSeconds === 'number'
                                                                            ? `${reference.durationSeconds.toFixed(1)}s clip`
                                                                            : 'Duration unavailable'}
                                                                    </div>
                                                                </div>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => void handleRemoveReferenceVideo(reference.id)}
                                                                    className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 transition hover:bg-rose-500/20 hover:text-rose-100"
                                                                >
                                                                    <X className="h-3.5 w-3.5" />
                                                                </button>
                                                            </div>
                                                            {reference.previewUrl || reference.providerUrl ? (
                                                                <video
                                                                    src={reference.previewUrl || reference.providerUrl || undefined}
                                                                    className="mt-3 h-40 w-full rounded-2xl border border-white/8 object-cover"
                                                                    controls
                                                                    muted
                                                                    playsInline
                                                                />
                                                            ) : null}
                                                        </div>
                                                    ))}
                                                </div>
                                            ) : (
                                                <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-6 text-sm text-zinc-500">
                                                    Add up to 3 short clips. Seedance 2 uses them as motion and framing references.
                                                </div>
                                            )}
                                        </div>

                                        <div className="space-y-3">
                                            <div className="flex items-center justify-between gap-3">
                                                <h3 className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">Reference audio</h3>
                                                <button
                                                    type="button"
                                                    onClick={() => referenceAudioInputRef.current?.click()}
                                                    disabled={referenceAudios.length >= 3}
                                                    className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-100 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
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
                                                <div className="space-y-3">
                                                    {referenceAudios.map((reference) => (
                                                        <div key={reference.id} className="rounded-2xl border border-white/8 bg-black/30 p-3">
                                                            <div className="flex items-start justify-between gap-3">
                                                                <div>
                                                                    <div className="text-sm font-semibold text-white">{reference.displayName}</div>
                                                                    <div className="mt-1 text-xs text-zinc-500">
                                                                        {reference.seedanceAsset.assetId ? 'Prepared asset available' : 'Uses URL fallback until prepared'}
                                                                    </div>
                                                                </div>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => void handleRemoveReferenceAudio(reference.id)}
                                                                    className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 transition hover:bg-rose-500/20 hover:text-rose-100"
                                                                >
                                                                    <X className="h-3.5 w-3.5" />
                                                                </button>
                                                            </div>
                                                            {reference.providerUrl ? (
                                                                <audio
                                                                    src={reference.providerUrl}
                                                                    className="mt-3 w-full"
                                                                    controls
                                                                />
                                                            ) : reference.previewUrl ? (
                                                                <audio
                                                                    src={reference.previewUrl}
                                                                    className="mt-3 w-full"
                                                                    controls
                                                                />
                                                            ) : null}
                                                        </div>
                                                    ))}
                                                </div>
                                            ) : (
                                                <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-6 text-sm text-zinc-500">
                                                    Add up to 3 audio clips when you want beat, rhythm, or dialogue timing references.
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                <div className="rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(17,17,21,0.98),rgba(8,8,10,0.95))] p-5 shadow-[0_24px_90px_-56px_rgba(0,0,0,0.95)] sm:p-6">
                                    <div className="mb-4 flex items-start justify-between gap-3">
                                        <div>
                                            <h2 className="text-sm font-semibold text-white">Seedance Assets</h2>
                                            <p className="mt-1 text-sm text-zinc-400">
                                                Prepare uploaded references into Seedance asset IDs so the next run can prefer the optimized asset instead of the raw URL.
                                            </p>
                                        </div>
                                        <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-300">
                                            {[
                                                ...elements.map((element) => element.seedanceAsset),
                                                ...referenceVideos.map((reference) => reference.seedanceAsset),
                                                ...referenceAudios.map((reference) => reference.seedanceAsset),
                                            ].filter((asset) => asset.status === 'active' && asset.assetId).length}/{elements.length + referenceVideos.length + referenceAudios.length} ready
                                        </span>
                                    </div>

                                    <div className="space-y-3">
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
                                            return (
                                                <div key={activeKey} className="rounded-2xl border border-white/8 bg-black/30 p-4">
                                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                                        <div>
                                                            <div className="text-sm font-semibold text-white">{item.title}</div>
                                                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
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
                                                                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-100 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60"
                                                            >
                                                                {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                                                                {item.asset.assetId ? 'Retry prep' : 'Prepare asset'}
                                                            </button>
                                                            {item.asset.assetId ? (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => void item.onRefresh().catch((refreshError) => setError(refreshError instanceof Error ? refreshError.message : 'Failed to refresh Seedance asset'))}
                                                                    disabled={isBusy}
                                                                    className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-100 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60"
                                                                >
                                                                    Refresh
                                                                </button>
                                                            ) : null}
                                                        </div>
                                                    </div>
                                                    <div className="mt-3 grid gap-2 text-xs text-zinc-500 sm:grid-cols-2">
                                                        <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-2">
                                                            Source: {item.asset.sourceUrl || 'Upload or prepare to capture a source URL'}
                                                        </div>
                                                        <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-2">
                                                            Last checked: {item.asset.lastCheckedAt || 'Never'}
                                                        </div>
                                                    </div>
                                                    {item.asset.error ? (
                                                        <div className="mt-3 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">
                                                            {item.asset.error}
                                                        </div>
                                                    ) : null}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            </>
                        )}

                        <div className="bg-zinc-900/30 border border-white/5 rounded-3xl p-6 backdrop-blur-sm space-y-6">
                            {videoModel.modeOptions.length > 0 && (
                                <div>
                                    <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">{selectedModel === 'veo-3.1' ? 'Model Variant' : 'Quality Mode'}</h2>
                                    <div className="flex flex-col gap-2">
                                        {videoModel.modeOptions.map((option) => (
                                            <button
                                                key={option.value}
                                                onClick={() => setMode(option.value)}
                                                className={`p-3 rounded-xl text-sm font-medium transition-all text-left ${currentMode === option.value ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'bg-black/50 text-zinc-500 border border-white/5 hover:bg-zinc-800'}`}
                                            >
                                                {option.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {videoModel.resolutions.length > 0 && (
                                <div>
                                    <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Resolution</h2>
                                    <div className="grid grid-cols-3 gap-2">
                                        {videoModel.resolutions.map((resolutionOption) => (
                                            <button
                                                key={resolutionOption}
                                                onClick={() => setResolution(resolutionOption)}
                                                className={`py-2 rounded-xl text-xs font-bold transition-all ${currentResolution === resolutionOption ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'bg-black/50 text-zinc-500 border border-white/5 hover:bg-zinc-800'}`}
                                            >
                                                {resolutionOption}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div>
                                <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Aspect Ratio</h2>
                                <div className="grid grid-cols-3 gap-2">
                                    {videoModel.aspectRatios.map((ratio) => (
                                        <button
                                            key={ratio}
                                            onClick={() => setAspectRatio(ratio)}
                                            className={`py-2 rounded-xl text-xs font-bold transition-all ${currentAspectRatio === ratio ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'bg-black/50 text-zinc-500 border border-white/5 hover:bg-zinc-800'}`}
                                        >
                                            {ratio}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {videoModel.supportsFixedLens && (
                                <div>
                                    <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Camera</h2>
                                    <button
                                        onClick={() => setFixedLens(!fixedLens)}
                                        className={`w-full p-3 rounded-xl flex items-center justify-between text-sm font-medium transition-all ${currentFixedLens ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' : 'bg-black/50 text-zinc-500 border border-white/5'}`}
                                    >
                                        <span className="flex items-center gap-2">
                                            <Camera className="w-4 h-4" />
                                            Fixed Lens
                                        </span>
                                        <span>{currentFixedLens ? 'ON' : 'OFF'}</span>
                                    </button>
                                </div>
                            )}

                            {videoModel.supportsSound && (
                                <div>
                                    <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Audio</h2>
                                    <button
                                        onClick={() => setSound(!sound)}
                                        className={`w-full p-3 rounded-xl flex items-center justify-between text-sm font-medium transition-all ${currentSound ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-black/50 text-zinc-500 border border-white/5'}`}
                                    >
                                        <span className="flex items-center gap-2">
                                            {currentSound ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                                            AI Sound Effects
                                        </span>
                                        <span>{currentSound ? 'ON' : 'OFF'}</span>
                                    </button>
                                </div>
                            )}
                        </div>
                    </>
                }
                workspace={
                    <>
                        <StudioRunPanel
                            title={isGenerating ? 'Video run in progress' : 'Ready to generate'}
                            summary={
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="rounded-[20px] border border-white/8 bg-black/30 p-4">
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Model</div>
                                        <div className="mt-2 text-sm font-semibold text-white">{videoModel.displayName}</div>
                                    </div>
                                    <div className="rounded-[20px] border border-white/8 bg-black/30 p-4">
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Cost</div>
                                        <div className="mt-2 text-sm font-semibold text-white">{estimatedCost} credits</div>
                                    </div>
                                </div>
                            }
                            details={
                                <div className="grid grid-cols-2 gap-3 text-sm">
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Duration</div>
                                        <div className="mt-1 text-zinc-200">{totalDuration}s</div>
                                    </div>
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Aspect ratio</div>
                                        <div className="mt-1 text-zinc-200">{currentAspectRatio}</div>
                                    </div>
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Shot mode</div>
                                        <div className="mt-1 text-zinc-200">{currentIsMultiShot ? 'Multi-shot' : 'Single shot'}</div>
                                    </div>
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Reference</div>
                                        <div className="mt-1 text-zinc-200">
                                            {currentIsMultiShot
                                                ? 'Shot prompts'
                                                : isSeedance2Family
                                                    ? 'Unified references'
                                                    : activeReferenceMode === 'elements'
                                                        ? 'Named elements'
                                                        : 'Frames'}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Inputs</div>
                                        <div className="mt-1 text-zinc-200">
                                            {currentIsMultiShot
                                                ? `${multiPrompts.length} shot${multiPrompts.length === 1 ? '' : 's'}`
                                                : isSeedance2Family
                                                    ? `${elements.length + referenceVideos.length + referenceAudios.length} reference${elements.length + referenceVideos.length + referenceAudios.length === 1 ? '' : 's'}`
                                                : activeReferenceMode === 'elements'
                                                    ? `${elements.length} element${elements.length === 1 ? '' : 's'}`
                                                    : `${[startImageUrl, endImageUrl].filter(Boolean).length} frame${[startImageUrl, endImageUrl].filter(Boolean).length === 1 ? '' : 's'}`}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Credits left</div>
                                        <div className="mt-1 text-zinc-200">{userCredits ?? '...'}</div>
                                    </div>
                                </div>
                            }
                            action={
                                insufficientCredits ? (
                                    <div className="space-y-4">
                                        <div className="rounded-[22px] border border-rose-500/20 bg-rose-500/10 p-4">
                                            <p className="text-sm font-semibold text-white">Not enough credits</p>
                                            <p className="mt-2 text-sm text-zinc-400">
                                                This run costs <strong className="text-white">{estimatedCost} credits</strong> but you only have <strong className="text-white">{userCredits}</strong>.
                                            </p>
                                        </div>
                                        <Link href="/pricing" className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-blue-600 to-purple-600 px-6 py-3 text-sm font-semibold text-white transition hover:opacity-90">
                                            <Sparkles className="h-4 w-4" />
                                            Top Up Credits
                                        </Link>
                                    </div>
                                ) : (
                                    <button
                                        onClick={handleGenerate}
                                        disabled={isGenerating}
                                        className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-blue-600 to-purple-600 px-6 py-4 text-base font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50 hover:opacity-90"
                                    >
                                        {isGenerating ? <><Loader2 className="w-5 h-5 animate-spin" /> Generating...</> : <><Video className="w-5 h-5" /> Generate Video</>}
                                    </button>
                                )
                            }
                            status={
                                <>
                                    {isGenerating && generationTiming ? (
                                        <StudioGenerationStatus
                                            accent="rose"
                                            timing={generationTiming}
                                            nowMs={nowMs}
                                        />
                                    ) : isBackgroundProcessing ? (
                                        <StudioBackgroundProcessingNotice
                                            accent="rose"
                                            label="video"
                                            phaseLabel={backgroundTiming?.phaseLabel ?? null}
                                            timingLabel={backgroundTimingLabel}
                                        />
                                    ) : error ? (
                                        <p className="text-sm text-red-400">{error}</p>
                                    ) : (
                                        <p className="text-sm text-zinc-500">The current run will replace this workspace as soon as generation starts.</p>
                                    )}
                                </>
                            }
                            footer={
                                <Link
                                    href="/creations"
                                    className="inline-flex items-center gap-2 text-sm font-medium text-zinc-300 transition hover:text-white"
                                >
                                    View My Creations
                                    <Download className="h-4 w-4" />
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
                                    My Creations
                                    <Download className="h-4 w-4" />
                                </Link>
                            }
                        >
                            {outputVideo ? (
                                <div className="space-y-5">
                                    <div className="overflow-hidden rounded-[26px] border border-white/8 bg-black/60 aspect-video">
                                        <video src={outputVideo} controls autoPlay loop className="h-full w-full object-contain" />
                                    </div>
                                    <div className="flex flex-wrap gap-3">
                                        <a href={outputVideo} download="generated_video.mp4" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-full bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500">
                                            <Download className="h-4 w-4" />
                                            Download video
                                        </a>
                                        {latestGenerationId ? (
                                            latestIsPublic ? (
                                                <>
                                                    <PublicShareButton
                                                        generationId={latestGenerationId}
                                                        title={shareTitle}
                                                        description={primarySharePrompt}
                                                        sourceSurface="create-video"
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
                                                    className="inline-flex items-center gap-2 rounded-full border border-purple-500/25 bg-purple-500/10 px-5 py-3 text-sm font-semibold text-purple-100 transition hover:border-purple-400/40 hover:bg-purple-500/15"
                                                >
                                                    <Share2 className="h-4 w-4" />
                                                    Publish & share
                                                </button>
                                            )
                                        ) : null}
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setOutputVideo(null);
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
                                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-r from-blue-500/30 to-purple-500/20">
                                        <Loader2 className="h-7 w-7 animate-spin text-white" />
                                    </div>
                                    <div>
                                        <h3 className="text-xl font-semibold text-white">Rendering the current scene</h3>
                                        <p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">
                                            This workspace will switch from progress to preview as soon as the model finishes the latest run.
                                        </p>
                                    </div>
                                </div>
                            ) : isBackgroundProcessing ? (
                                <StudioBackgroundProcessingNotice
                                    accent="rose"
                                    label="video"
                                    variant="workspace"
                                    phaseLabel={backgroundTiming?.phaseLabel ?? null}
                                    timingLabel={backgroundTimingLabel}
                                />
                            ) : (
                                <div className="flex min-h-[520px] flex-col items-center justify-center gap-5 rounded-[26px] border border-dashed border-white/10 bg-black/40 p-10 text-center">
                                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-r from-blue-500/30 to-purple-500/20">
                                        <Video className="h-7 w-7 text-white" />
                                    </div>
                                    <div>
                                        <h3 className="text-xl font-semibold text-white">No video yet</h3>
                                        <p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">
                                            {isSeedance2Family
                                                ? 'Upload image, video, or audio references, prepare assets when needed, and the latest Seedance render will take over this workspace.'
                                                : activeReferenceMode === 'elements'
                                                ? 'Name your references, write the scene with @elements, and the latest render will take over this workspace.'
                                                : 'Choose the shot structure, write the prompt, and set your frames. The latest render will take over this workspace.'}
                                        </p>
                                    </div>
                                </div>
                            )}
                        </StudioWorkspacePanel>
                    </>
                }
            >
            </MediaStudioShell>

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
                        <p className="max-h-32 overflow-y-auto pr-2 text-sm leading-relaxed text-zinc-300 custom-scrollbar">
                            {isMultiShot ? multiPrompts.map((shot) => shot.prompt).join(' | ') : prompt || 'No prompt available'}
                        </p>
                    </div>
                }
            />
        </div>
    );
}
