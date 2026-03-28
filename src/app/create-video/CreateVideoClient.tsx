'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Sparkles, Loader2, Download, X, Image as ImageIcon, Video, Plus, Trash2, Volume2, VolumeX, Play, Camera, ChevronDown, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import {
    GeneratorPageHeader,
    MediaStudioShell,
    StudioBackgroundProcessingNotice,
    StudioMediaPreviewModal,
    StudioRemixNotice,
    StudioRunPanel,
    StudioUploadedMediaPreview,
    StudioWorkspacePanel,
} from '@/app/components/CreatorStudio';
import EnhancePromptButton from '@/app/components/EnhancePromptButton';
import { clampVideoDuration, getDefaultVideoDuration, getVideoCost, getVideoDurationRange, getVideoElementSupport, isValidVideoDuration, VIDEO_MODELS, VideoModelId } from '@/lib/models';
import { useAuth } from '@/app/components/AuthProvider';
import {
    getPersistedFile,
    getPersistedImageElementRecords,
    getPersistedValue,
    PERSISTED_MEDIA_KEYS,
    removePersistedMedia,
    setPersistedFile,
    setPersistedImageElementRecords,
    setPersistedValue,
} from '@/lib/persisted-media';
import { BACKGROUND_PROCESSING_ERROR, getBackgroundProcessingCopy } from '@/lib/generation-feedback';
import {
    createElementHandleReplacementMap,
    createElementId,
    extractPromptHandles,
    findUnknownPromptHandles,
    getElementFileNameFromStoragePath,
    getMentionQueryAtCaret,
    getUploadsBucketPath,
    insertHandleIntoPrompt,
    isUploadsStoragePath,
    normalizeElementDisplayName,
    reconcileElementDescriptors,
    replacePromptHandles,
    type ImageElementDescriptor,
} from '@/lib/image-elements';

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
    referenceMode?: 'frames' | 'elements';
}

type VideoElementDraft = ImageElementDescriptor & {
    file: File | null;
    previewUrl: string;
    providerUrl: string | null;
    source: 'upload' | 'remix';
};

type VideoElementSeed = {
    id?: string;
    displayName?: string;
    file: File | null;
    previewUrl: string;
    providerUrl?: string | null;
    storagePath?: string | null;
    source?: 'upload' | 'remix';
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
            };
        }

        return {
            ...existing,
            displayName: element.displayName,
            handle: element.handle,
        };
    });
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
    const { credits: userCredits, isLoading: isLoadingUser, updateCredits } = useAuth();
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
    const [referenceMode, setReferenceMode] = useState<'frames' | 'elements'>('frames');
    const [elementNameDrafts, setElementNameDrafts] = useState<Record<string, string>>({});
    const [startImageFile, setStartImageFile] = useState<File | null>(null);
    const [startImageUrl, setStartImageUrl] = useState<string | null>(null);
    const [endImageFile, setEndImageFile] = useState<File | null>(null);
    const [endImageUrl, setEndImageUrl] = useState<string | null>(null);
    const [mode, setMode] = useState('std');
    const [aspectRatio, setAspectRatio] = useState('16:9');
    const [sound, setSound] = useState(false);
    const [resolution, setResolution] = useState('720p');
    const [fixedLens, setFixedLens] = useState(false);

    const [isDraggingStart, setIsDraggingStart] = useState(false);
    const [isDraggingEnd, setIsDraggingEnd] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [generationStatus, setGenerationStatus] = useState<string | null>(null);
    const [outputVideo, setOutputVideo] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
    const modelDropdownRef = useRef<HTMLDivElement>(null);
    const startImageInputRef = useRef<HTMLInputElement>(null);
    const endImageInputRef = useRef<HTMLInputElement>(null);
    const elementInputRef = useRef<HTMLInputElement>(null);
    const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
    const elementsRef = useRef<VideoElementDraft[]>([]);
    const [isDraggingElements, setIsDraggingElements] = useState(false);
    const [activeMentionQuery, setActiveMentionQuery] = useState<{
        query: string;
        replaceStart: number;
        replaceEnd: number;
    } | null>(null);

    const [isRemixLoading, setIsRemixLoading] = useState(!!remixId);
    const [remixTitle, setRemixTitle] = useState<string | null>(null);
    const [remixVideoUrl, setRemixVideoUrl] = useState<string | null>(null);
    const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false);
    const [uploadPreview, setUploadPreview] = useState<UploadPreviewState | null>(null);

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
    const revokeObjectUrl = (url: string | null) => {
        if (url?.startsWith('blob:')) {
            URL.revokeObjectURL(url);
        }
    };
    const commitElements = (nextElements: VideoElementDraft[]) => {
        elementsRef.current = nextElements;
        setElements(nextElements);
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
    const activeReferenceMode = canUseVideoElements ? referenceMode : 'frames';
    const totalDuration = currentIsMultiShot
        ? multiPrompts.reduce((acc, curr) => acc + curr.duration, 0)
        : (videoModel.provider === 'veo' ? videoModel.durations[0] : currentDuration);
    const estimatedCost = getVideoCost(selectedModel, {
        mode: currentMode,
        sound: currentSound,
        durationSeconds: totalDuration,
        resolution: currentResolution,
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
    const showFramesEditor = activeReferenceMode === 'frames';
    const hiddenElementDraftCount = activeReferenceMode === 'frames' ? elements.length : 0;
    const hiddenFrameDraftCount = activeReferenceMode === 'elements'
        ? [startImageUrl, endImageUrl].filter(Boolean).length
        : 0;
    const showSavedElementNotice = !canUseVideoElements && !currentIsMultiShot && (elements.length > 0 || referenceMode === 'elements');
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
        };
    }, [startImageUrl, endImageUrl]);

    useEffect(() => {
        elementsRef.current = elements;
    }, [elements]);

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

        const fetchRemixData = async () => {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) return;

            try {
                const { data, error } = await supabase
                    .from('generations')
                    .select('title, prompt, workflow_settings, output_url')
                    .eq('id', remixId)
                    .single();

                if (error || !data) {
                    console.error('Failed to load remix data');
                    return;
                }

                if (data.title) setRemixTitle(data.title);

                try {
                    const sessionData = await supabase.auth.getSession();
                    const token = sessionData.data.session?.access_token;
                    if (token) {
                        const previewRes = await fetch(`/api/showcase/preview?id=${remixId}`, {
                            headers: { Authorization: `Bearer ${token}` },
                        });
                        if (previewRes.ok) {
                            const previewData = await previewRes.json();
                            if (previewData.url) setRemixVideoUrl(previewData.url);
                        }
                    }
                } catch (previewError) {
                    console.error('Failed to load preview URL:', previewError);
                }

                const settings = data.workflow_settings as VideoWorkflowSettings | null;
                if (settings?.model && settings.model in VIDEO_MODELS) {
                    setSelectedModel(settings.model);
                }

                if (settings) {
                    if (settings.isMultiShot !== undefined) {
                        setIsMultiShot(settings.isMultiShot);
                        if (settings.isMultiShot && settings.multiPrompts) {
                            setMultiPrompts(settings.multiPrompts.map((shot, index) => ({
                                id: shot.id || `${index + 1}`,
                                prompt: shot.prompt,
                                duration: shot.duration,
                            })));
                        } else {
                            if (data.prompt) setPrompt(data.prompt);
                            if (settings.duration) setSingleDuration(settings.duration);
                        }
                    } else {
                        if (data.prompt) setPrompt(data.prompt);
                        if (settings.duration) setSingleDuration(settings.duration);
                    }

                    if (settings.mode) setMode(settings.mode);
                    if (settings.aspectRatio) setAspectRatio(settings.aspectRatio);
                    if (settings.sound !== undefined) setSound(settings.sound);
                    if (settings.resolution) setResolution(settings.resolution);
                    if (settings.fixedLens !== undefined) setFixedLens(settings.fixedLens);
                    if (settings.referenceMode) setReferenceMode(settings.referenceMode);

                    if (settings.elements?.length) {
                        const restoredSeeds = await Promise.all(
                            settings.elements.map(async (element) => {
                                if (!isUploadsStoragePath(element.storagePath)) {
                                    return null;
                                }

                                try {
                                    const filePath = getUploadsBucketPath(element.storagePath);
                                    const { data: signedData, error: signedUrlError } = await supabase.storage
                                        .from('uploads')
                                        .createSignedUrl(filePath, 3600);

                                    if (signedUrlError || !signedData?.signedUrl) {
                                        throw new Error(signedUrlError?.message || 'Failed to sign upload asset');
                                    }

                                    const assetResponse = await fetch(signedData.signedUrl);
                                    if (!assetResponse.ok) {
                                        throw new Error('Failed to download stored element asset');
                                    }

                                    const blob = await assetResponse.blob();
                                    const restoredFile = new File(
                                        [blob],
                                        getElementFileNameFromStoragePath(element.storagePath, element.handle),
                                        {
                                            type: blob.type || 'image/jpeg',
                                            lastModified: Date.now(),
                                        }
                                    );

                                    return {
                                        id: element.id,
                                        displayName: element.displayName,
                                        file: restoredFile,
                                        previewUrl: URL.createObjectURL(restoredFile),
                                        providerUrl: signedData.signedUrl,
                                        storagePath: element.storagePath,
                                        source: 'remix' as const,
                                    };
                                } catch (restoreError) {
                                    console.error('Failed to restore remix video element:', restoreError);
                                    return null;
                                }
                            })
                        );

                        const validSeeds = restoredSeeds.filter((value): value is VideoElementSeed => value !== null);
                        if (validSeeds.length > 0) {
                            commitElements(hydrateVideoElements(validSeeds));
                            setReferenceMode('elements');
                        }
                    }
                } else if (data.prompt) {
                    setPrompt(data.prompt);
                }
            } catch (fetchError) {
                console.error('Error fetching remix:', fetchError);
            } finally {
                setIsRemixLoading(false);
            }
        };

        fetchRemixData();
    }, [remixId]);

    useEffect(() => {
        if (remixId) {
            return;
        }

        let isMounted = true;

        const loadPersistedMedia = async () => {
            try {
                const [savedStartImage, savedEndImage, savedElements, savedReferenceMode] = await Promise.all([
                    getPersistedFile(PERSISTED_MEDIA_KEYS.createVideoStartImage),
                    getPersistedFile(PERSISTED_MEDIA_KEYS.createVideoEndImage),
                    getPersistedImageElementRecords(PERSISTED_MEDIA_KEYS.createVideoElements),
                    getPersistedValue<'frames' | 'elements'>(PERSISTED_MEDIA_KEYS.createVideoReferenceMode),
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
            if (!remixId) {
                await setPersistedFile(PERSISTED_MEDIA_KEYS.createVideoStartImage, file);
            }
            return;
        }

        revokeObjectUrl(endImageUrl);
        setEndImageFile(file);
        setEndImageUrl(URL.createObjectURL(file));
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

    const clearImage = async (type: 'start' | 'end') => {
        if (type === 'start') {
            revokeObjectUrl(startImageUrl);
            setStartImageFile(null);
            setStartImageUrl(null);
            if (!remixId) {
                await removePersistedMedia(PERSISTED_MEDIA_KEYS.createVideoStartImage);
            }
        } else {
            revokeObjectUrl(endImageUrl);
            setEndImageFile(null);
            setEndImageUrl(null);
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

    const pollPrediction = async (predictionId: string, accessToken: string): Promise<string> => {
        const maxAttempts = 120;
        let attempts = 0;
        const startTime = Date.now();

        while (attempts < maxAttempts) {
            const response = await fetch(`/api/generate-video?id=${predictionId}`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            const data = await response.json();

            if (data.status === 'succeeded') return data.output;
            if (data.status === 'failed') throw new Error(data.error || 'Video generation failed');

            const elapsed = (Date.now() - startTime) / 1000;
            const progress = Math.min((elapsed / 300) * 90, 95);

            let statusMsg = 'Processing...';
            if (progress < 10) statusMsg = 'Queuing request...';
            else if (progress < 40) statusMsg = 'Warming up AI models...';
            else if (progress < 80) statusMsg = 'Rendering video frames...';
            else statusMsg = 'Finalizing export...';

            setGenerationStatus(`${statusMsg} (${Math.round(progress)}%)`);
            await new Promise((resolve) => setTimeout(resolve, 5000));
            attempts++;
        }

        throw new Error(BACKGROUND_PROCESSING_ERROR);
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
    };

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

        if (insufficientCredits) {
            setError(`Insufficient credits. This costs ${estimatedCost} credits.`);
            return;
        }

        setIsGenerating(true);
        setError(null);
        setOutputVideo(null);
        setGenerationStatus('Preparing... (0%)');

        try {
            let startUrl: string | null = null;
            let endUrl: string | null = null;
            const requestElements: ImageElementDescriptor[] = [];
            let elementImageUrls: string[] = [];

            if (!currentIsMultiShot && activeReferenceMode === 'elements' && elements.length > 0) {
                setGenerationStatus(`Preparing ${elements.length} video elements... (2%)`);

                const uploadedElements = await Promise.all(elements.map(async (element) => {
                    if (element.file) {
                        const upload = await uploadToSupabase(element.file);
                        return {
                            descriptor: {
                                id: element.id,
                                displayName: element.displayName,
                                handle: element.handle,
                                storagePath: upload.storagePath,
                            } satisfies ImageElementDescriptor,
                            imageUrl: upload.signedUrl,
                        };
                    }

                    if (!element.providerUrl) {
                        throw new Error(`Missing media for ${element.displayName}`);
                    }

                    return {
                        descriptor: {
                            id: element.id,
                            displayName: element.displayName,
                            handle: element.handle,
                            storagePath: element.storagePath ?? null,
                        } satisfies ImageElementDescriptor,
                        imageUrl: element.providerUrl,
                    };
                }));

                requestElements.push(...uploadedElements.map((item) => item.descriptor));
                elementImageUrls = uploadedElements.map((item) => item.imageUrl);
            }

            if (activeReferenceMode === 'frames' && startImageFile) {
                setGenerationStatus('Uploading start image... (2%)');
                const upload = await uploadToSupabase(startImageFile);
                startUrl = upload.signedUrl;
            }

            if (activeReferenceMode === 'frames' && endImageFile && !isMultiShot) {
                setGenerationStatus('Uploading end image... (4%)');
                const upload = await uploadToSupabase(endImageFile);
                endUrl = upload.signedUrl;
            }

            setGenerationStatus('Starting AI generation... (5%)');

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
                startImageUrl: startUrl,
                endImageUrl: endUrl,
                mode: currentMode,
                aspectRatio: currentAspectRatio,
                sound: currentSound,
                resolution: currentResolution,
                fixedLens: currentFixedLens,
                referenceMode: activeReferenceMode,
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

            const outputUrl = await pollPrediction(data.predictionId, session.access_token);
            setOutputVideo(outputUrl);
            setGenerationStatus('Video generated successfully! (100%)');
            if (data.remainingCredits !== undefined) updateCredits(data.remainingCredits);
        } catch (generationError) {
            const errorMessage = generationError instanceof Error ? generationError.message : 'Something went wrong';
            if (errorMessage === BACKGROUND_PROCESSING_ERROR) {
                setError(BACKGROUND_PROCESSING_ERROR);
                setGenerationStatus(getBackgroundProcessingCopy('video').status);
            } else {
                setError(errorMessage);
                setGenerationStatus(null);
            }
        } finally {
            setIsGenerating(false);
        }
    };

    const getProgress = () => {
        if (!generationStatus) return 0;
        const match = generationStatus.match(/\((\d+)%\)/);
        return match ? parseInt(match[1]) : 0;
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
            : activeReferenceMode === 'elements'
                ? 'The workspace will show the current run and latest result once your named-element scene starts rendering.'
                : 'The workspace will show the current run and latest result once you generate.';

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
                                        description={`Settings pre-filled from ${remixTitle ? `"${remixTitle}"` : 'the original creation'}.`}
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
                                            resolution: currentResolution,
                                            isMultiShot: currentIsMultiShot,
                                            shotCount: multiPrompts.length,
                                            hasStartImage: activeReferenceMode === 'frames' && Boolean(startImageFile || startImageUrl),
                                            hasEndImage: activeReferenceMode === 'frames' && Boolean(endImageFile || endImageUrl),
                                            referenceImageCount: activeReferenceMode === 'elements' ? elements.length : 0,
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
                                                    Named elements
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
                                                    Upload element images below to mention people, products, or objects directly in the prompt.
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

                        {!currentIsMultiShot && canUseVideoElements && (
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
                                            {currentIsMultiShot ? 'Shot prompts' : activeReferenceMode === 'elements' ? 'Named elements' : 'Frames'}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Inputs</div>
                                        <div className="mt-1 text-zinc-200">
                                            {currentIsMultiShot
                                                ? `${multiPrompts.length} shot${multiPrompts.length === 1 ? '' : 's'}`
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
                                    {isGenerating && generationStatus ? (
                                        <div className="space-y-3">
                                            <div className="flex justify-between text-sm text-zinc-300">
                                                <span>{generationStatus}</span>
                                                <span>{getProgress()}%</span>
                                            </div>
                                            <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                                                <motion.div
                                                    className="h-full bg-gradient-to-r from-blue-500 to-purple-500"
                                                    initial={{ width: '0%' }}
                                                    animate={{ width: `${getProgress()}%` }}
                                                    transition={{ duration: 0.5 }}
                                                />
                                            </div>
                                            <p className="text-xs text-zinc-500">Longer runs can take a few minutes.</p>
                                        </div>
                                    ) : isBackgroundProcessing ? (
                                        <StudioBackgroundProcessingNotice accent="rose" label="video" />
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
                                    <a href={outputVideo} download="generated_video.mp4" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-full bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500">
                                        <Download className="h-4 w-4" />
                                        Download video
                                    </a>
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
                                <StudioBackgroundProcessingNotice accent="rose" label="video" variant="workspace" />
                            ) : (
                                <div className="flex min-h-[520px] flex-col items-center justify-center gap-5 rounded-[26px] border border-dashed border-white/10 bg-black/40 p-10 text-center">
                                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-r from-blue-500/30 to-purple-500/20">
                                        <Video className="h-7 w-7 text-white" />
                                    </div>
                                    <div>
                                        <h3 className="text-xl font-semibold text-white">No video yet</h3>
                                        <p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">
                                            {activeReferenceMode === 'elements'
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
