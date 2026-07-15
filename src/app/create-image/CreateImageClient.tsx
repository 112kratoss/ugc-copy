'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Sparkles, Loader2, Download, X, Image as ImageIcon, Zap, ChevronDown, Check, Share2, Expand } from 'lucide-react';
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
    StudioWorkspacePanel,
} from '@/app/components/CreatorStudio';
import PublicShareButton from '@/app/components/PublicShareButton';
import PublishToShowcaseModal from '@/app/components/PublishToShowcaseModal';
import EnhancePromptButton from '@/app/components/EnhancePromptButton';
import { useAuth } from '@/app/components/AuthProvider';
import type { RemixSourceBundle } from '@/lib/remix-source';
import {
    createRemixElementSeeds,
    createRemixResultReferenceElement,
    getRemixRestoreWarning,
    getRemixResultReferenceLabel,
} from '@/lib/remix-source-client';
import { buildShowcaseDetailPath } from '@/lib/share';
import {
    getPersistedFiles,
    getPersistedImageElementRecords,
    getPersistedValue,
    PERSISTED_MEDIA_KEYS,
    removePersistedMedia,
    setPersistedImageElementRecords,
} from '@/lib/persisted-media';
import {
    buildElementHandle,
    createElementHandleReplacementMap,
    createElementId,
    extractPromptHandles,
    findUnknownPromptHandles,
    getMentionQueryAtCaret,
    insertHandleIntoPrompt,
    isValidElementHandle,
    normalizeElementDisplayName,
    replacePromptHandles,
    type ImageElementDescriptor,
    type PersistedImageElementDraft,
} from '@/lib/image-elements';
import { BACKGROUND_PROCESSING_ERROR, getBackgroundProcessingCopy } from '@/lib/generation-feedback';
import { createGenerationIdempotencyKey } from '@/lib/generation-idempotency-client';
import {
    announceGenerationStarted,
    fetchGenerationStatus,
    waitForNextGenerationStatusPoll,
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
    getImageResolutionOptions,
    IMAGE_MODELS,
    supportsImageResolutionControl,
    type ImageModelId,
    type ImageQualityMode,
    type ImageResolution,
} from '@/lib/client-generation-models';
import {
    getActiveRegistryModels,
    resolveCatalogModelId,
    resolveWebGenerationQuoteUi,
    useWebGenerationModelCatalog,
    useWebGenerationModelQuote,
} from '@/lib/generation-model-client';
import { useDeploymentRefresh } from '@/lib/use-deployment-refresh';
import { useTicker } from '@/lib/use-ticker';
import { uploadMediaToTemporaryStorage } from '@/lib/temporary-media-upload';

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

type ImageElementDraft = ImageElementDescriptor & {
    file: File | null;
    previewUrl: string;
    providerUrl: string | null;
    source: 'upload' | 'remix';
    sourceGenerationId?: string | null;
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
};

function revokePreviewUrl(url: string | null | undefined) {
    if (url?.startsWith('blob:')) {
        URL.revokeObjectURL(url);
    }
}

async function clearLegacyPersistedImageElements() {
    await Promise.all([
        removePersistedMedia(PERSISTED_MEDIA_KEYS.createImageReferences),
        removePersistedMedia(PERSISTED_MEDIA_KEYS.createImageElementDrafts),
    ]);
}

function hydrateImageElements(seeds: ImageElementSeed[]): ImageElementDraft[] {
    const usedHandles = new Set<string>();

    return seeds.map((seed, index) => {
        const displayName = normalizeElementDisplayName(seed.displayName, index + 1);
        const preferredHandle =
            typeof seed.handle === 'string' && isValidElementHandle(seed.handle) && !usedHandles.has(seed.handle)
                ? seed.handle
                : buildElementHandle(displayName, usedHandles, index + 1);

        usedHandles.add(preferredHandle);

        return {
            id: seed.id ?? createElementId(),
            displayName,
            handle: preferredHandle,
            file: seed.file ?? null,
            previewUrl: seed.previewUrl,
            providerUrl: seed.providerUrl ?? null,
            storagePath: seed.storagePath ?? null,
            source: seed.source ?? 'upload',
            sourceGenerationId: seed.sourceGenerationId ?? null,
        };
    });
}

export interface CreateImagePrefill {
    remixId?: string | null;
    remixPostId?: string | null;
    prompt?: string | null;
    model?: string | null;
    aspectRatio?: string | null;
}

export default function CreateImageClient({ prefill }: { prefill: CreateImagePrefill }) {
    const router = useRouter();
    const { credits: userCredits, isLoading: isLoadingUser, session, updateCredits } = useAuth();
    const modelCatalog = useWebGenerationModelCatalog();
    const refetchModelCatalog = modelCatalog.refetch;
    const [selectedModel, setSelectedModel] = useState<ModelId>('nano-banana-2');
    const [prompt, setPrompt] = useState('');
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
    const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
    const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const hasResolvedInitialCatalogModel = useRef(false);
    const hasRestoredPersistedMedia = useRef(false);
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
    const [elementNameDrafts, setElementNameDrafts] = useState<Record<string, string>>({});
    const [resultPreviewImage, setResultPreviewImage] = useState<string | null>(null);
    const nowMs = useTicker(isGenerating);

    useEffect(() => () => {
        generationPollAbortControllerRef.current?.abort();
    }, []);


    useEffect(() => {
        if (remixId) return;
        // A route prefill intentionally seeds the editable form once it is available.
        if (prefillPrompt) setPrompt(prefillPrompt);
        const isCatalogModel = Boolean(modelCatalog.catalog?.models.some((candidate) => candidate.kind === 'image' && candidate.id === prefillModel));
        if (prefillModel && (prefillModel in IMAGE_MODELS || isCatalogModel)) setSelectedModel(prefillModel as ModelId);
        if (prefillAspectRatio) setAspectRatio(prefillAspectRatio);
    }, [modelCatalog.catalog, prefillPrompt, prefillModel, prefillAspectRatio, remixId]);

    const model = IMAGE_MODELS[selectedModel];
    const imageModelOptions = getActiveRegistryModels(
        IMAGE_MODELS as unknown as Record<string, typeof IMAGE_MODELS[ImageModelId]>
    );

    useEffect(() => {
        if (!modelCatalog.catalog) return;
        const preferDefault = !hasResolvedInitialCatalogModel.current && !remixId && !prefillModel;
        const nextModelId = resolveCatalogModelId(modelCatalog.catalog, 'image', selectedModel, { preferDefault });
        hasResolvedInitialCatalogModel.current = true;
        if (nextModelId && nextModelId !== selectedModel) {
            const nextModel = (IMAGE_MODELS as unknown as Record<string, typeof model>)[nextModelId];
            setSelectedModel(nextModelId as ModelId);
            if (!preferDefault) {
                setCatalogNotice(`Your previous image model is no longer available. Switched to ${nextModel?.displayName ?? nextModelId}.`);
            }
        }
    }, [modelCatalog.catalog, selectedModel, prefillModel, remixId]);
    const persistUploadedImageElements = useCallback(async (nextElements: ImageElementDraft[]) => {
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
            PERSISTED_MEDIA_KEYS.createImageElements,
            persistableElements
        );
        await clearLegacyPersistedImageElements();
    }, [remixId]);

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
        if (elements.length > model.maxImages) {
            const nextElements = hydrateImageElements(elements.slice(0, model.maxImages));
            elements.slice(model.maxImages).forEach((element) => revokePreviewUrl(element.previewUrl));
            // Model changes must immediately enforce the provider's reference limit.
            commitElements(nextElements);
            void persistUploadedImageElements(nextElements);
        }

        const nextAspectRatio = (model.aspectRatios as readonly string[]).includes(aspectRatio)
            ? aspectRatio
            : model.aspectRatios[0];
        if (nextAspectRatio !== aspectRatio) {
            setAspectRatio(nextAspectRatio);
        }

        const nextResolutionOptions = getImageResolutionOptions(selectedModel, nextAspectRatio);
        if (!nextResolutionOptions.includes(resolution)) {
            setResolution(nextResolutionOptions[0]);
        }
        if (!model.supportsGoogleSearch) {
            setGoogleSearch(false);
        }
    }, [aspectRatio, commitElements, elements, model, persistUploadedImageElements, resolution, selectedModel]);

    // Close dropdown on click outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setIsModelDropdownOpen(false);
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
                setPrompt(bundle.generation.prompt);
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
                if (settings?.qualityMode === 'quality' || settings?.qualityMode === 'standard') {
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
        if (remixId) {
            return;
        }

        try {
            const savedElementRecords = await getPersistedImageElementRecords(
                PERSISTED_MEDIA_KEYS.createImageElements
            );

            if (savedElementRecords.length > 0) {
                const clampedRecords = savedElementRecords.slice(0, model.maxImages);
                const restoredElements = hydrateImageElements(
                    clampedRecords.map((element) => ({
                        id: element.id,
                        displayName: element.displayName,
                        file: element.file,
                        previewUrl: URL.createObjectURL(element.file),
                        source: 'upload',
                    }))
                );

                commitElements(restoredElements);

                if (clampedRecords.length !== savedElementRecords.length) {
                    await persistUploadedImageElements(restoredElements);
                }
                return;
            }

            const [savedFiles, savedDrafts] = await Promise.all([
                getPersistedFiles(PERSISTED_MEDIA_KEYS.createImageReferences),
                getPersistedValue<PersistedImageElementDraft[]>(PERSISTED_MEDIA_KEYS.createImageElementDrafts),
            ]);

            if (savedFiles.length === 0) return;

            const clampedFiles = savedFiles.slice(0, model.maxImages);
            const restoredElements = hydrateImageElements(clampedFiles.map((file, index) => ({
                id: savedDrafts?.[index]?.id,
                displayName: savedDrafts?.[index]?.displayName,
                file,
                previewUrl: URL.createObjectURL(file),
                source: 'upload',
            })));

            commitElements(restoredElements);

            await persistUploadedImageElements(restoredElements);
        } catch (err) {
            console.error('Error loading persisted image elements:', err);
        }
    }, [commitElements, model.maxImages, persistUploadedImageElements, remixId]);

    useEffect(() => {
        if (hasRestoredPersistedMedia.current) return;
        hasRestoredPersistedMedia.current = true;

        void loadPersistedElements();
    }, [loadPersistedElements]);

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

    useEffect(() => {
        return () => {
            if (!remixId && elementRefs.current.length > 0) {
                void persistUploadedImageElements(elementRefs.current);
            }
        };
    }, [persistUploadedImageElements, remixId]);

    const processImageFiles = async (files: FileList | File[]) => {
        const validFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
        if (validFiles.length === 0) return;

        const currentElements = elementRefs.current;
        const availableSlots = model.maxImages - currentElements.length;
        const filesToAdd = validFiles.slice(0, availableSlots);

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
        setElementNameDrafts((prev) => {
            if (!(elementId in prev)) {
                return prev;
            }

            const nextDrafts = { ...prev };
            delete nextDrafts[elementId];
            return nextDrafts;
        });
        commitElements(nextElements);
        await persistUploadedImageElements(nextElements);
    };

    const handleElementRename = async (elementId: string, nextDisplayName: string) => {
        const currentElements = elementRefs.current;
        const nextElements = hydrateImageElements(
            currentElements.map((element) => (
                element.id === elementId
                    ? { ...element, displayName: nextDisplayName }
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
        setElementNameDrafts((prev) => ({
            ...prev,
            [elementId]: nextValue,
        }));
    };

    const commitElementDraft = async (elementId: string) => {
        const draftValue = elementNameDrafts[elementId];
        if (draftValue === undefined) {
            return;
        }

        const trimmed = draftValue.trim();
        setElementNameDrafts((prev) => {
            const nextDrafts = { ...prev };
            delete nextDrafts[elementId];
            return nextDrafts;
        });

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
        accessToken: string,
        startedAtMs: number,
        estimatedTotalMs: number | null
    ): Promise<{ output: string; outputs: string[]; timing: GenerationTiming | null }> => {
        const pollController = new AbortController();
        generationPollAbortControllerRef.current?.abort();
        generationPollAbortControllerRef.current = pollController;
        const pollingStartedAt = Date.now();

        try {
            while (Date.now() - pollingStartedAt < 5 * 60 * 1000) {
                const data = await fetchGenerationStatus({
                    url: `/api/generate-image?id=${predictionId}`,
                    accessToken,
                    signal: pollController.signal,
                });

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
                    throw new Error(data.error || 'Image generation failed');
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

    const quoteRequest = useMemo(() => modelCatalog.catalog ? {
        kind: 'image' as const,
        modelId: selectedModel,
        settings: { aspectRatio, resolution, qualityMode, outputFormat: 'jpg', googleSearch },
        inputCounts: { images: elements.length, videos: 0, audios: 0 },
        catalogRevision: modelCatalog.catalog.revision,
    } : null, [aspectRatio, elements.length, googleSearch, modelCatalog.catalog, qualityMode, resolution, selectedModel]);
    const quoteState = useWebGenerationModelQuote(quoteRequest, session?.access_token);
    useEffect(() => {
        if (quoteState.error?.code !== 'CATALOG_CHANGED') return;
        // The quote response is the external signal that the local catalog is stale.
        setCatalogNotice('Model settings changed. Review the refreshed options before generating.');
        refetchModelCatalog();
    }, [refetchModelCatalog, quoteState.error?.code]);
    const quoteUi = resolveWebGenerationQuoteUi({
        hasCatalog: Boolean(modelCatalog.catalog),
        quoteStatus: quoteState.status,
        quotedCost: quoteState.quote?.costCredits,
        quoteErrorMessage: quoteState.error?.message,
    });
    const currentCost = quoteUi.costCredits;
    const availableResolutions = getImageResolutionOptions(selectedModel, aspectRatio);
    const showResolutionControl = supportsImageResolutionControl(selectedModel);
    const isGrokImageModel = selectedModel === 'grok-imagine-image';
    const insufficientCredits = userCredits !== null && currentCost !== null && userCredits < currentCost;
    const quotePending = quoteUi.blocksGenerate;
    const elementHandles = elements.map((element) => element.handle);
    const referencedElementHandles = extractPromptHandles(prompt).filter((handle) => elementHandles.includes(handle));
    const isElementEnhancementLocked = referencedElementHandles.length > 0;
    const staleElementMentions = findUnknownPromptHandles(prompt, elementHandles);
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

    useEffect(() => {
        const resumePendingGeneration = async () => {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) return;

            const { data, error: pendingError } = await supabase
                .from('generations')
                .select('id, prediction_id, status, created_at')
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
            setGenerationTiming(createLocalGenerationTiming({
                kind: 'image',
                phaseLabel: 'Resuming active run',
                startedAtMs,
                appStatus: data.status === 'waiting' ? 'waiting' : 'processing',
            }));

            try {
                const result = await pollPrediction(data.prediction_id, session.access_token, startedAtMs, null);
                setOutputImage(result.output);
                setOutputImages(result.outputs);
                if (result.timing) {
                    setGenerationTiming(result.timing);
                }
            } catch (err) {
                const errorMessage = err instanceof Error ? err.message : 'Something went wrong';
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
        // Recovery is intentionally a mount-only lookup; changing form settings must not restart it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleGenerate = async () => {
        if (activeGenerationRequestKeyRef.current) return;
        if (!prompt.trim()) { setError('Please enter a prompt'); return; }
        if (quotePending) { setError(quoteUi.message ?? 'Wait for the current generation cost before continuing.'); return; }
        if (staleElementMentions.length > 0) {
            setError(`Unknown element mention${staleElementMentions.length > 1 ? 's' : ''}: ${staleElementMentions.join(', ')}`);
            return;
        }
        if (userCredits !== null && currentCost !== null && userCredits < currentCost) { setError(`Insufficient credits. Image generation costs ${currentCost} credits.`); return; }

        const idempotencyKey = createGenerationIdempotencyKey('image');
        activeGenerationRequestKeyRef.current = idempotencyKey;
        setIsGenerating(true);
        setError(null);
        setOutputImage(null);
        setOutputImages([]);
        setResultPreviewImage(null);
        setIsResultPreviewOpen(false);
        setLatestGenerationId(null);
        setLatestIsPublic(false);
        setPublishedMeta(null);
        const startedAtMs = getCurrentTimestampMs();
        const estimatedTotalMs = estimateGenerationDurationMs({
            kind: 'image',
            model: selectedModel,
            resolution,
            referenceCount: elements.length,
        });
        setGenerationTiming(createLocalGenerationTiming({
            kind: 'image',
            phaseLabel: 'Preparing inputs',
            startedAtMs,
            estimatedTotalMs,
        }));

        try {
            let imageUrls: string[] = [];
            const requestElements: ImageElementDescriptor[] = [];

            if (elements.length > 0) {
                setGenerationTiming(createLocalGenerationTiming({
                    kind: 'image',
                    phaseLabel: elements.length === 1 ? 'Uploading 1 reference' : `Uploading ${elements.length} references`,
                    startedAtMs,
                    estimatedTotalMs,
                }));

                const uploadedElements = await Promise.all(elements.map(async (element) => {
                    if (element.file) {
                        const upload = await uploadMediaToTemporaryStorage(element.file);
                        return {
                            descriptor: {
                                id: element.id,
                                displayName: element.displayName,
                                handle: element.handle,
                                storagePath: upload.storagePath,
                                sourceGenerationId: null,
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
                            sourceGenerationId: element.sourceGenerationId ?? null,
                        } satisfies ImageElementDescriptor,
                        imageUrl: element.providerUrl,
                    };
                }));

                requestElements.push(...uploadedElements.map((item) => item.descriptor));
                imageUrls = uploadedElements.map((item) => item.imageUrl);
            }

            setGenerationTiming(createLocalGenerationTiming({
                kind: 'image',
                phaseLabel: 'Submitting image run',
                startedAtMs,
                estimatedTotalMs,
            }));

            const { data: { session } } = await supabase.auth.getSession();
            if (!session) { router.push('/login?returnUrl=/create-image'); return; }

            const response = await fetch('/api/generate-image', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`,
                    'Idempotency-Key': idempotencyKey
                },
                body: JSON.stringify({
                    model: selectedModel,
                    prompt: prompt.trim(),
                    imageUrls,
                    elements: requestElements,
                    aspectRatio,
                    resolution,
                    qualityMode,
                    googleSearch: model.supportsGoogleSearch ? googleSearch : false,
                    outputFormat: 'jpg',
                    sourceGenerationId: remixId || undefined,
                    catalogRevision: modelCatalog.catalog?.revision,
                })
            });

            const data = await response.json();
            if (!data.success) {
                if (data.code === 'CATALOG_CHANGED') {
                    setCatalogNotice('Model settings changed. Review the refreshed options before generating.');
                    modelCatalog.refetch();
                }
                throw new Error(data.error || 'Failed to start generation');
            }
            setLatestGenerationId(data.generationId ?? null);
            setLatestIsPublic(false);
            announceGenerationStarted();
            if (data.remainingCredits !== undefined) updateCredits(data.remainingCredits);

            const result = await pollPrediction(data.predictionId, session.access_token, startedAtMs, estimatedTotalMs);
            setOutputImage(result.output);
            setOutputImages(result.outputs);
            if (result.timing) {
                setGenerationTiming(result.timing);
            }
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Something went wrong';
            if (errorMessage === BACKGROUND_PROCESSING_ERROR) {
                handoffToBackgroundProcessing(startedAtMs);
            } else {
                setError(errorMessage);
                setGenerationTiming(null);
            }
        } finally {
            activeGenerationRequestKeyRef.current = null;
            setIsGenerating(false);
        }
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
    const isBackgroundProcessing = error === BACKGROUND_PROCESSING_ERROR;
    const backgroundProcessingCopy = getBackgroundProcessingCopy('image');
    useDeploymentRefresh(isGenerating || isBackgroundProcessing);
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

        return buildMediaProxyUrl(location.bucket, location.filePath, {
            download: true,
            filename: outputImages.length > 1 ? `generated-image-${index + 1}.jpg` : 'generated-image.jpg',
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
    const shareTitle = publishedMeta?.title || prompt.trim() || `${model.displayName} image`;
    const shareDescription = publishedMeta?.description || prompt.trim() || null;
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
                            {catalogNotice ? (
                                <motion.div
                                    initial={{ opacity: 0, y: 12 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -12 }}
                                >
                                    <StudioRemixNotice description={catalogNotice} />
                                </motion.div>
                            ) : null}
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
                                onClick={() => setIsModelDropdownOpen(prev => !prev)}
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

                            <AnimatePresence>
                                {isModelDropdownOpen && (
                                    <motion.div
                                        initial={{ opacity: 0, y: -8, scaleY: 0.95 }}
                                        animate={{ opacity: 1, y: 0, scaleY: 1 }}
                                        exit={{ opacity: 0, y: -8, scaleY: 0.95 }}
                                        transition={{ duration: 0.15 }}
                                        className="absolute z-50 mt-2 w-[calc(100%-3rem)] bg-zinc-900/95 border border-white/10 rounded-2xl overflow-hidden backdrop-blur-xl shadow-[0_16px_48px_-12px_rgba(0,0,0,0.8)]"
                                        style={{ transformOrigin: 'top' }}
                                    >
                                        {imageModelOptions.map((m) => {
                                            const isActive = selectedModel === m.id;
                                            return (
                                                <button
                                                    key={m.id}
                                                    onClick={() => {
                                                        setSelectedModel(m.id as ModelId);
                                                        setIsModelDropdownOpen(false);
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
                                                                Up to {m.maxImages} ref images
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
                                    referenceImageCount: elements.length,
                                    elementEnhancementMode: isElementEnhancementLocked ? 'append-only' : undefined,
                                    elementReferences: elements.map((element) => ({
                                        handle: element.handle,
                                        displayName: element.displayName,
                                    })),
                                }}
                                disabled={isGenerating}
                            />
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
                                        Upload one or more element images below to mention them by name in the prompt.
                                    </p>
                                )}
                            </div>
                            <textarea
                                ref={promptTextareaRef}
                                value={prompt}
                                onChange={(e) => handlePromptChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
                                onClick={syncPromptCaretState}
                                onKeyUp={syncPromptCaretState}
                                placeholder="Describe the image you want to create..."
                                maxLength={20000}
                                className={`w-full bg-black/50 text-white rounded-2xl p-5 border border-white/10 ${accentStyles.ring} focus:ring-4 outline-none resize-y min-h-[150px] placeholder:text-zinc-600 transition-all text-sm leading-relaxed`}
                            />
                            <div className="mt-2 flex items-center justify-between gap-3 text-xs">
                                <p className="text-zinc-600">{prompt.length}/20000 characters</p>
                                {staleElementMentions.length > 0 ? (
                                    <p className="text-right text-rose-300">
                                        Unknown element mention{staleElementMentions.length > 1 ? 's' : ''}:{' '}
                                        {staleElementMentions.join(', ')}
                                    </p>
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
                        </motion.div>

                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.04 }}
                            className="rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(20,20,24,0.96),rgba(9,9,11,0.94))] p-5 shadow-[0_24px_90px_-56px_rgba(0,0,0,0.95)] sm:p-6"
                        >
                            <div className="mb-4 flex items-start justify-between gap-3">
                                <div>
                                    <h2 className="text-sm font-semibold text-white">Elements</h2>
                                    <p className="mt-1 text-sm text-zinc-400">Upload visual anchors, rename them, and reference them directly in the prompt.</p>
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
                        </motion.div>

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
                            ) : (
                                <motion.div
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: 0.08 }}
                                    className="rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(20,20,24,0.96),rgba(9,9,11,0.94))] p-5 shadow-[0_24px_90px_-56px_rgba(0,0,0,0.95)] sm:p-6"
                                >
                                    <h2 className="text-sm font-semibold text-white mb-1">Grok quality</h2>
                                    <p className="text-sm text-zinc-400 mb-4">
                                        Quality applies to prompt-only Grok runs; edits use fixed image-to-image pricing.
                                    </p>
                                    <div className="grid grid-cols-2 gap-3">
                                        {(['standard', 'quality'] as const).map((mode) => (
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
                            )}
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
                                        <div className="mt-1 text-zinc-200">{elements.length}/{model.maxImages}</div>
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
                                        <div className="rounded-[22px] border border-blue-500/20 bg-blue-500/10 p-4">
                                            <p className="text-sm font-semibold text-white">Not enough credits</p>
                                            <p className="mt-2 text-sm text-zinc-400">
                                                Image generation costs <strong className="text-white">{currentCost} credits</strong> but you only have <strong className="text-white">{userCredits}</strong>.
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
                                        disabled={!prompt.trim() || isGenerating || quotePending || staleElementMentions.length > 0}
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
                                    ) : error ? (
                                        <p className="text-sm text-red-400">{error}</p>
                                    ) : staleElementMentions.length > 0 ? (
                                        <p className="text-sm text-rose-300">
                                            Resolve the unknown element mention{staleElementMentions.length > 1 ? 's' : ''} before generating: {staleElementMentions.join(', ')}
                                        </p>
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
                                    Studio
                                    <Download className="h-4 w-4" />
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
                                                        download={`generated-image-${index + 1}.jpg`}
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
                                            download="generated-image.jpg"
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
                                            Write the prompt, optionally add a few named elements, then generate. The latest result will take over this workspace.
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
                            {prompt || 'No prompt available'}
                        </p>
                    </div>
                }
            />

            <PublishToShowcaseModal
                isOpen={isPublishModalOpen}
                onClose={() => setIsPublishModalOpen(false)}
                generationId={latestGenerationId}
                accessToken={session?.access_token ?? null}
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
                            {prompt || "No prompt available"}
                        </p>
                    </div>
                }
            />
        </div>
    );
}
