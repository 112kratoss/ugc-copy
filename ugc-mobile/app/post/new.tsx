import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { Check, ChevronDown, ImageIcon, Lock, PackageCheck, Play, Plus, Sparkles, X } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, PanResponder, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText, ChoiceChip, PrimaryButton, ReadinessRow, SecondaryButton, StatusBlock, SurfaceSection, ToggleRow } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { formatRelativeTime } from '@/lib/home-view-model';
import { immersiveViewerHref } from '@/lib/immersive-preview-view-model';
import { pickMediaList, pickResourceDocument, uploadPickedMedia } from '@/lib/media';
import {
  buildPostComposerMediaItemsPayload,
  buildCreatePostFormData,
  buildPublishGenerationPostPayload,
  buildUpdatePostPayload,
  applyCreationPromptResource,
  createMadeWithRow,
  getDefaultPostComposerDraft,
  getPostComposerPublishActions,
  getPostComposerPackageStatus,
  getPostComposerSubmitLabel,
  getPublishGenerationMediaKind,
  getPublishGenerationSubtitle,
  getPublishGenerationTitle,
  getPublishableGenerations,
  POST_COMPOSER_CATEGORY_OPTIONS,
  POST_COMPOSER_RESOURCE_KIND_OPTIONS,
  POST_COMPOSER_SOURCE_OPTIONS,
  POST_COMPOSER_UNLOCK_OPTIONS,
  validatePostComposerDraft,
  hasGenerationReferences,
  type PostComposerCategory,
  type PostComposerDraft,
  type PostComposerMadeWithRow,
  type PostComposerMediaItem,
  type PostComposerMode,
} from '@/lib/post-new-view-model';
import { resolvedBottomInset } from '@/lib/safe-area';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { appTheme, type ToolAccent } from '@/lib/theme';
import type { GenerationListItem, PostResourceAttachment, PostResourceBundleAccessMode, SourceToolOption } from '@/lib/types';

const getDefaultResourceDraft = () => ({
  accessMode: 'none' as const,
  selectedKinds: {
    prompt: true,
    workflow: false,
    files: false,
    notes: false,
    remix: false,
  },
  promptText: '',
  notesMarkdown: '',
  workflowShareUrl: '',
  attachmentUrl: '',
  attachmentLabel: '',
  attachments: [],
  organizeSections: false,
  sections: [],
  allowRemix: false,
  summary: '',
  previewText: '',
  priceUsd: '9',
});

const COMPOSER_SECTION_STYLE = {
  padding: 14,
  borderRadius: appTheme.radii.lg,
  gap: 10,
} as const;

const MINIMAL_COMPOSER_SECTION_STYLE = {
  padding: 14,
  borderRadius: 18,
  gap: 12,
} as const;

export default function NewPostScreen() {
  const { user, isLoading: authLoading, api } = useAuth();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ generationId?: string; postId?: string; focus?: string }>();
  const generationId = params.generationId;
  const postId = params.postId;
  const focusTarget = params.focus;
  const focusResourcePackage = focusTarget === 'resources';

  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const bottomInset = resolvedBottomInset(insets.bottom);
  const tabBarMetrics = getMagicTabBarMetrics(width, bottomInset);
  const horizontalPadding = Math.min(width, 430) < 390 ? 16 : 18;
  const [draft, setDraft] = useState<PostComposerDraft>(() => ({
    ...getDefaultPostComposerDraft(),
    mode: 'upload',
    proofMode: 'media',
    category: 'image',
    madeWithRows: [createMadeWithRow()],
  }));
  const [message, setMessage] = useState<{ tone: 'danger' | 'success'; title: string; body?: string } | null>(null);
  const [isPickingMedia, setIsPickingMedia] = useState(false);
  const [isPickingResourceFile, setIsPickingResourceFile] = useState(false);
  const [hasPrefilledEdit, setHasPrefilledEdit] = useState(false);
  const [isDescriptionOpen, setIsDescriptionOpen] = useState(false);

  const generationsQuery = useQuery({
    queryKey: ['post-new-generations', user?.id],
    enabled: Boolean(user),
    queryFn: () => api.listGenerations(true),
  });

  const postQuery = useQuery({
    queryKey: ['post-edit', postId],
    enabled: Boolean(user && postId),
    queryFn: () => api.getOwnerPost(postId!),
  });

  const sourceToolsQuery = useQuery({
    queryKey: ['post-source-tools'],
    enabled: Boolean(user),
    queryFn: () => api.listSourceTools(),
  });

  const publishableGenerations = useMemo(
    () => getPublishableGenerations(generationsQuery.data?.generations),
    [generationsQuery.data?.generations]
  );
  const allGenerations = generationsQuery.data?.generations ?? [];
  const selectedGeneration = allGenerations.find((item) => item.id === draft.selectedGenerationId) ?? null;
  const isGenerationBacked = Boolean(postQuery.data?.post?.generationId) || draft.mode === 'creation';
  const isEditMode = Boolean(postId);
  const isFieldsLocked = isEditMode && isGenerationBacked;
  const canSubmit = !isPickingMedia && !isPickingResourceFile && (!isEditMode || !postQuery.isLoading);
  const sourceTools = sourceToolsQuery.data?.tools ?? [];
  const packageStatus = useMemo(
    () => getPostComposerPackageStatus(draft, selectedGeneration),
    [draft, selectedGeneration]
  );

  // Prefill when generationId is provided and the creations list resolves
  useEffect(() => {
    if (generationId && publishableGenerations.length > 0) {
      const found = publishableGenerations.find((g) => g.id === generationId);
      if (found) {
        setDraft((current) => {
          if (current.selectedGenerationId === generationId) return current;
          const category = found.category === 'video' || found.category === 'motion' || found.category === 'ugc-ad' ? found.category : 'image';
          return {
            ...current,
            mode: 'creation',
            proofMode: 'media',
            selectedGenerationId: found.id,
            title: current.title || found.title || found.prompt || 'Untitled creation',
            contentText: '',
            sourceTool: 'Magicbooklet',
            sourceToolSlug: 'magicbooklet',
            madeWithRows: [createMadeWithRow({
              id: 'mw-generation',
              toolLabel: 'Magicbooklet',
              toolSlug: 'magicbooklet',
              modelLabel: found.model || '',
              modelSlug: slugifyMobileValue(found.model || '') ?? '',
            })],
            category,
          };
        });
      }
    }
  }, [generationId, publishableGenerations]);

  // Prefill when postId is provided and post detail resolves
  useEffect(() => {
    if (postId && postQuery.data?.post && !hasPrefilledEdit) {
      const post = postQuery.data.post;
      const resourceBundleInput = post.resourceBundleInput;
      const mode = post.postFormat === 'text' ? 'text' : post.generationId ? 'creation' : 'upload';

      setDraft({
        mode,
        proofMode: mode === 'text' ? 'text' : 'media',
        title: post.title || '',
        description: post.description || '',
        contentText: mode === 'text' ? post.body || '' : '',
        caption: mode === 'text' ? '' : post.body || '',
        sourceTool: post.sourceTool || 'Manual',
        sourceToolSlug: post.sourceToolSlug || 'manual',
        madeWithRows: post.sourceTools?.length
          ? post.sourceTools.map((sourceTool, index) => createMadeWithRow({
              id: `mw-existing-${index}`,
              toolLabel: sourceTool.toolLabel,
              toolSlug: sourceTool.toolSlug ?? '',
              modelLabel: sourceTool.modelLabel ?? '',
              modelSlug: sourceTool.modelSlug ?? '',
              createTool: sourceTool.createTool === true,
              createModel: sourceTool.createModel === true,
            }))
          : [createMadeWithRow({
              toolLabel: post.sourceTool || 'Manual',
              toolSlug: post.sourceToolSlug || 'manual',
            })],
        category: post.category || 'image',
        visibility: (post.visibility as any) || 'public',
        selectedGenerationId: post.generationId || null,
        upload: post.mediaUrl ? {
          uri: post.mediaUrl,
          name: post.title || 'media',
          type: post.mediaKind === 'video' ? 'video/mp4' : 'image/jpeg',
        } : null,
        mediaItems: post.mediaItems?.length
          ? post.mediaItems.map((item) => ({
              id: item.id,
              uri: item.url,
              previewUrl: item.previewUrl ?? item.url,
              name: item.originalName || item.id,
              type: item.contentType || (item.mediaKind === 'video' ? 'video/mp4' : 'image/jpeg'),
              mediaKind: item.mediaKind,
              existingId: item.id,
            }))
          : post.mediaUrl
            ? [{
                id: 'existing-cover',
                uri: post.mediaUrl,
                previewUrl: post.mediaUrl,
                name: post.title || 'media',
                type: post.mediaKind === 'video' ? 'video/mp4' : 'image/jpeg',
                mediaKind: post.mediaKind === 'video' ? 'video' : 'image',
                existingId: `${post.id}:cover`,
              }]
            : [],
        creationPackage: getDefaultPostComposerDraft().creationPackage,
        resource: resourceBundleInput ? {
          accessMode: resourceBundleInput.accessMode || 'none',
          selectedKinds: deriveResourceSelections(resourceBundleInput),
          promptText: resourceBundleInput.resources?.promptText || '',
          notesMarkdown: resourceBundleInput.resources?.notesMarkdown || '',
          workflowShareUrl: resourceBundleInput.resources?.workflowShareUrl || '',
          attachmentUrl: resourceBundleInput.resources?.attachments?.[0]?.url || resourceBundleInput.resources?.attachments?.[0]?.storagePath || '',
          attachmentLabel: resourceBundleInput.resources?.attachments?.[0]?.label || '',
          attachments: (resourceBundleInput.resources?.attachments ?? []).map((attachment: PostResourceAttachment, index: number) => ({
            id: `att-existing-${index}`,
            kind: attachment.kind === 'file' ? 'file' : 'link',
            label: attachment.label,
            url: attachment.url ?? '',
            storagePath: attachment.storagePath ?? '',
            contentType: attachment.contentType ?? null,
            sizeBytes: attachment.sizeBytes ?? null,
            resourceType: attachment.resourceType ?? undefined,
            role: attachment.role ?? undefined,
            remixUse: attachment.remixUse ?? undefined,
          })),
          organizeSections: Boolean(resourceBundleInput.resources?.sections?.length),
          sections: [],
          allowRemix: resourceBundleInput.resources?.allowRemix || false,
          summary: resourceBundleInput.summary || '',
          previewText: resourceBundleInput.previewText || '',
          priceUsd: resourceBundleInput.priceUsdCents ? String(resourceBundleInput.priceUsdCents / 100) : '9',
        } : getDefaultResourceDraft(),
      });
      setIsDescriptionOpen(Boolean(post.description));
      setHasPrefilledEdit(true);
    }
  }, [postId, postQuery.data, hasPrefilledEdit]);

  const publishMutation = useMutation({
    mutationFn: async (targetVisibility?: PostComposerDraft['visibility']) => {
      const effectiveDraft = targetVisibility ? { ...draft, visibility: targetVisibility } : draft;
      const validation = validateCurrentDraft(effectiveDraft, selectedGeneration, isEditMode && isGenerationBacked);
      if (!validation.valid) {
        throw new Error(validation.message);
      }

      if (postId) {
        const isGen = Boolean(postQuery.data?.post?.generationId);
        const payload = buildUpdatePostPayload(isGen, effectiveDraft);
        return api.updatePost(postId, payload);
      }

      if (effectiveDraft.mode === 'creation') {
        if (!selectedGeneration) throw new Error('Choose a finished creation before publishing.');
        return api.publishGeneration(buildPublishGenerationPostPayload(selectedGeneration, effectiveDraft));
      }

      return api.createPost(buildCreatePostFormData(effectiveDraft));
    },
    onSuccess: (response) => {
      setMessage({
        tone: 'success',
        title: isEditMode ? 'Saved' : 'Posted',
        body: isEditMode ? 'Your post has been updated.' : 'Your post is now live in your profile.',
      });
      void invalidatePostCaches(queryClient, user?.id);
      const targetPostId = response.postId || postId;
      if (targetPostId) {
        router.replace(
          immersiveViewerHref({
            source: 'profile-posts',
            initialId: targetPostId,
          }) as never
        );
      }
    },
    onError: (error) => {
      setMessage({
        tone: 'danger',
        title: isEditMode ? 'Could not save' : 'Could not publish',
        body: error instanceof Error ? error.message : 'Try again.',
      });
    },
  });

  if (authLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: appTheme.colors.background, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={appTheme.colors.motion} />
      </View>
    );
  }

  if (!user) {
    return <Redirect href="/auth" />;
  }

  const setMode = (mode: PostComposerMode) => {
    if (isFieldsLocked) return;
    setMessage(null);
    setDraft((current) => ({
      ...current,
      mode,
      proofMode: mode === 'text' ? 'text' : 'media',
      category: mode === 'text' ? 'text' : mode === 'creation' ? current.category === 'text' ? 'image' : current.category : current.category === 'text' ? 'image' : current.category,
      sourceTool: mode === 'creation' ? 'Magicbooklet' : mode === 'text' ? 'Manual' : current.sourceTool === 'Manual' ? 'Other' : current.sourceTool,
      sourceToolSlug: mode === 'creation' ? 'magicbooklet' : mode === 'text' ? 'manual' : current.sourceToolSlug === 'manual' ? 'other' : current.sourceToolSlug,
      madeWithRows: mode === 'creation'
        ? [createMadeWithRow({ toolLabel: 'Magicbooklet', toolSlug: 'magicbooklet' })]
        : current.madeWithRows.length > 0
          ? current.madeWithRows
          : [createMadeWithRow()],
    }));
  };

  const updateDraft = (patch: Partial<PostComposerDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const updateResource = (patch: Partial<PostComposerDraft['resource']>) => {
    setDraft((current) => ({ ...current, resource: { ...current.resource, ...patch } }));
  };

  const updateCreationPackage = (patch: Partial<PostComposerDraft['creationPackage']>) => {
    setDraft((current) => ({ ...current, creationPackage: { ...current.creationPackage, ...patch } }));
  };

  const togglePromptResource = (enabled: boolean) => {
    setDraft((current) => applyCreationPromptResource(current, selectedGeneration, enabled));
  };

  const changeCreation = () => {
    if (isFieldsLocked) return;
    setMessage(null);
    setDraft((current) => ({
      ...current,
      mode: 'creation',
      selectedGenerationId: null,
      creationPackage: getDefaultPostComposerDraft().creationPackage,
    }));
  };

  const chooseMedia = async (kind: 'image' | 'video' | 'mixed') => {
    if (isFieldsLocked) return;
    setMessage(null);
    setIsPickingMedia(true);
    try {
      const picked = await pickMediaList(kind, { allowsMultipleSelection: true });
      if (picked.length === 0) return;
      const availableSlots = Math.max(0, 5 - draft.mediaItems.length);
      const uploadedItems = await Promise.all(
        picked.slice(0, availableSlots).map(async (asset, index): Promise<PostComposerMediaItem> => {
          const uploaded = await uploadPickedMedia(asset.uri, {
            fileName: asset.fileName,
            mimeType: asset.mimeType,
            ...(kind === 'mixed' ? {} : { kind }),
            durationSeconds: asset.duration ?? null,
            sizeBytes: asset.fileSize ?? null,
          });

          return {
            id: `picked-${Date.now()}-${index}`,
            uri: asset.uri,
            previewUrl: asset.uri,
            name: uploaded.fileName,
            type: uploaded.mimeType,
            mediaKind: uploaded.kind === 'video' ? 'video' : 'image',
            storagePath: uploaded.storagePath,
          };
        })
      );
      setDraft((current) => ({
        ...current,
        mode: 'upload',
        proofMode: 'media',
        category: uploadedItems[0]?.mediaKind === 'video' ? 'video' : 'image',
        upload: uploadedItems[0]
          ? {
              uri: uploadedItems[0].uri,
              name: uploadedItems[0].name,
              type: uploadedItems[0].type,
            }
          : current.upload,
        mediaItems: [...current.mediaItems, ...uploadedItems].slice(0, 5),
      }));
    } catch (error) {
      setMessage({ tone: 'danger', title: 'Could not pick media', body: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setIsPickingMedia(false);
    }
  };

  const chooseGeneration = (item: GenerationListItem) => {
    if (isFieldsLocked) return;
    const category = generationToPostCategory(item);
    setMessage(null);
    setDraft((current) => ({
      ...current,
      mode: 'creation',
      proofMode: 'media',
      selectedGenerationId: item.id,
      title: current.title.trim() ? current.title : getPublishGenerationTitle(item),
      contentText: '',
      sourceTool: 'Magicbooklet',
      sourceToolSlug: 'magicbooklet',
      madeWithRows: [createMadeWithRow({
        id: 'mw-generation',
        toolLabel: 'Magicbooklet',
        toolSlug: 'magicbooklet',
        modelLabel: item.model || '',
        modelSlug: slugifyMobileValue(item.model || '') ?? '',
      })],
      category,
      creationPackage: getDefaultPostComposerDraft().creationPackage,
    }));
  };

  const updateMadeWithRow = (id: string, patch: Partial<PostComposerMadeWithRow>) => {
    setDraft((current) => ({
      ...current,
      madeWithRows: current.madeWithRows.map((row) => row.id === id ? { ...row, ...patch } : row),
    }));
  };

  const addMadeWithRow = () => {
    setDraft((current) => ({
      ...current,
      madeWithRows: [...current.madeWithRows, createMadeWithRow()].slice(0, 5),
    }));
  };

  const removeMadeWithRow = (id: string) => {
    setDraft((current) => ({
      ...current,
      madeWithRows: current.madeWithRows.filter((row) => row.id !== id).length > 0
        ? current.madeWithRows.filter((row) => row.id !== id)
        : [createMadeWithRow()],
    }));
  };

  const removeMediaItem = (id: string) => {
    setDraft((current) => {
      const mediaItems = current.mediaItems.filter((item) => item.id !== id);
      return {
        ...current,
        mediaItems,
        upload: mediaItems[0]
          ? { uri: mediaItems[0].uri, name: mediaItems[0].name, type: mediaItems[0].type }
          : null,
      };
    });
  };

  const reorderMediaItem = (id: string, targetIndex: number) => {
    setDraft((current) => {
      const index = current.mediaItems.findIndex((item) => item.id === id);
      const boundedTargetIndex = Math.max(0, Math.min(targetIndex, current.mediaItems.length - 1));
      if (index < 0 || index === boundedTargetIndex) {
        return current;
      }
      const next = [...current.mediaItems];
      const [moved] = next.splice(index, 1);
      next.splice(boundedTargetIndex, 0, moved);
      return {
        ...current,
        mediaItems: next,
        upload: next[0] ? { uri: next[0].uri, name: next[0].name, type: next[0].type } : null,
      };
    });
  };

  const updateResourceKind = (kind: keyof PostComposerDraft['resource']['selectedKinds'], enabled: boolean) => {
    updateResource({
      selectedKinds: {
        ...draft.resource.selectedKinds,
        [kind]: enabled,
      },
      allowRemix: kind === 'remix' ? enabled : draft.resource.allowRemix,
    });
  };

  const addResourceAttachment = (attachment: Partial<PostComposerDraft['resource']['attachments'][number]> = {}) => {
    updateResource({
      selectedKinds: { ...draft.resource.selectedKinds, files: true },
      attachments: [
        ...draft.resource.attachments,
        {
          id: `att-${Date.now()}`,
          kind: attachment.kind ?? 'link',
          label: attachment.label ?? '',
          url: attachment.url ?? '',
          storagePath: attachment.storagePath ?? '',
          contentType: attachment.contentType ?? null,
          sizeBytes: attachment.sizeBytes ?? null,
          resourceType: attachment.resourceType ?? 'external_link',
          role: attachment.role ?? 'primary',
          remixUse: attachment.remixUse ?? 'none',
        },
      ],
    });
  };

  const updateResourceAttachment = (
    id: string,
    patch: Partial<PostComposerDraft['resource']['attachments'][number]>
  ) => {
    updateResource({
      attachments: draft.resource.attachments.map((attachment) => attachment.id === id ? { ...attachment, ...patch } : attachment),
    });
  };

  const removeResourceAttachment = (id: string) => {
    updateResource({
      attachments: draft.resource.attachments.filter((attachment) => attachment.id !== id),
    });
  };

  const chooseResourceFile = async () => {
    setIsPickingResourceFile(true);
    setMessage(null);
    try {
      const picked = await pickResourceDocument();
      if (!picked) return;
      const formData = new FormData();
      formData.append('file', {
        uri: picked.uri,
        name: picked.name,
        type: picked.mimeType ?? 'application/octet-stream',
      } as unknown as Blob);
      const response = await api.uploadPostResourceFile(formData);
      addResourceAttachment({
        kind: 'file',
        label: response.attachment.label,
        storagePath: response.attachment.storagePath ?? '',
        contentType: response.attachment.contentType ?? null,
        sizeBytes: response.attachment.sizeBytes ?? null,
        resourceType: response.attachment.resourceType ?? 'source_file',
        role: response.attachment.role ?? 'primary',
        remixUse: response.attachment.remixUse ?? 'import_source',
      });
    } catch (error) {
      setMessage({ tone: 'danger', title: 'Could not add file', body: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setIsPickingResourceFile(false);
    }
  };

  const addResourceSection = () => {
    updateResource({
      organizeSections: true,
      sections: [
        ...draft.resource.sections,
        {
          id: `section-${Date.now()}`,
          title: `Section ${draft.resource.sections.length + 1}`,
          kind: 'scene',
          description: '',
          promptText: '',
          workflowShareUrl: '',
          notesMarkdown: '',
          attachments: [],
          allowRemix: false,
        },
      ],
    });
  };

  const updateResourceSection = (
    id: string,
    patch: Partial<PostComposerDraft['resource']['sections'][number]>
  ) => {
    updateResource({
      sections: draft.resource.sections.map((section) => section.id === id ? { ...section, ...patch } : section),
    });
  };

  const removeResourceSection = (id: string) => {
    updateResource({
      sections: draft.resource.sections.filter((section) => section.id !== id),
    });
  };

  const publishActions = getPostComposerPublishActions({
    selectedVisibility: draft.visibility,
    isEditMode,
    isPending: publishMutation.isPending,
  });
  const showMadeWith = draft.proofMode === 'media';
  const unlockSection = (
    <UnlockSection
      draft={draft}
      selectedGeneration={selectedGeneration}
      packageStatus={packageStatus}
      isPickingResourceFile={isPickingResourceFile}
      onResourceChange={updateResource}
      onCreationPackageChange={updateCreationPackage}
      onTogglePromptResource={togglePromptResource}
      onResourceKindChange={updateResourceKind}
      onAddAttachment={addResourceAttachment}
      onUpdateAttachment={updateResourceAttachment}
      onRemoveAttachment={removeResourceAttachment}
      onPickResourceFile={chooseResourceFile}
      onAddSection={addResourceSection}
      onUpdateSection={updateResourceSection}
      onRemoveSection={removeResourceSection}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1, backgroundColor: appTheme.colors.background }}
        contentContainerStyle={{
          paddingHorizontal: horizontalPadding,
          paddingTop: 12,
          paddingBottom: tabBarMetrics.bottomInset + 84,
          gap: 10,
        }}
      >
        {postQuery.isLoading && isEditMode ? (
          <ActivityIndicator color="#d946ef" style={{ marginVertical: 20 }} />
        ) : null}

        {message ? (
          <StatusBlock tone={message.tone} title={message.title} body={message.body} />
        ) : null}

        {selectedGeneration ? (
          <SelectedCreationHero
            item={selectedGeneration}
            disabled={isFieldsLocked}
            onChange={changeCreation}
          />
        ) : null}

        <TitleSection
          draft={draft}
          disabled={isFieldsLocked}
          onChange={updateDraft}
        />

        {showMadeWith ? (
          <MadeWithSection
            rows={draft.madeWithRows}
            sourceTools={sourceTools}
            disabled={isFieldsLocked || draft.mode === 'creation'}
            onUpdate={updateMadeWithRow}
            onAdd={addMadeWithRow}
            onRemove={removeMadeWithRow}
          />
        ) : null}

        <ProofSection
          draft={draft}
          selectedGeneration={selectedGeneration}
          publishableGenerations={publishableGenerations}
          allGenerations={allGenerations}
          generationsLoading={generationsQuery.isLoading}
          generationsError={generationsQuery.error}
          isPickingMedia={isPickingMedia}
          isFieldsLocked={isFieldsLocked}
          onModeChange={setMode}
          onPickMedia={() => chooseMedia('mixed')}
          onChooseGeneration={chooseGeneration}
          onCreateGeneration={() => router.push('/(tabs)/creator' as never)}
          onRemoveMedia={removeMediaItem}
          onReorderMedia={reorderMediaItem}
        />

        {focusResourcePackage ? unlockSection : null}

        <StorySection
          draft={draft}
          disabled={isFieldsLocked}
          isDescriptionOpen={isDescriptionOpen}
          onChange={updateDraft}
          onToggleDescription={() => setIsDescriptionOpen((current) => !current)}
        />

        {!focusResourcePackage ? unlockSection : null}

        <PublishSection
          actions={publishActions}
          canSubmit={canSubmit}
          isPending={publishMutation.isPending}
          onSubmit={(visibility) => {
            setMessage(null);
            publishMutation.mutate(visibility);
          }}
        />

      </ScrollView>
    </View>
  );
}

function MadeWithSection({
  rows,
  sourceTools,
  disabled,
  onUpdate,
  onAdd,
  onRemove,
}: {
  rows: PostComposerMadeWithRow[];
  sourceTools: SourceToolOption[];
  disabled: boolean;
  onUpdate: (id: string, patch: Partial<PostComposerMadeWithRow>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  const toolOptions = getMadeWithToolOptions(sourceTools);
  const [activePickerId, setActivePickerId] = useState<string | null>(null);

  return (
    <SurfaceSection
      eyebrow="Attribution"
      title="Made With"
      accent="image"
      style={COMPOSER_SECTION_STYLE}
    >
      <View style={{ gap: appTheme.spacing.gap }}>
        {rows.map((row, index) => {
          const selectedTool = toolOptions.find((tool) => (
            row.toolSlug ? tool.slug === row.toolSlug : tool.label === row.toolLabel
          ));
          const provisionalToolRows = rows.filter((candidate) => candidate.createTool && candidate.toolLabel.trim());
          const toolPickerOptions = uniquePickerOptions([
            ...toolOptions.map((tool) => ({ value: tool.slug, label: tool.label })),
            ...provisionalToolRows
              .filter((candidate) => !toolOptions.some((tool) => tool.slug === candidate.toolSlug))
              .map((candidate) => ({
                value: candidate.toolSlug,
                label: candidate.toolLabel,
                provisional: true,
              })),
          ]);
          const catalogModels = selectedTool?.models ?? [];
          const provisionalModelRows = rows.filter((candidate) => (
            candidate.toolSlug === row.toolSlug
            && candidate.createModel
            && candidate.modelLabel.trim()
          ));
          const modelPickerOptions = uniquePickerOptions([
            ...catalogModels.map((model) => ({ value: model.slug, label: model.label })),
            ...provisionalModelRows
              .filter((candidate) => !catalogModels.some((model) => model.slug === candidate.modelSlug))
              .map((candidate) => ({
                value: candidate.modelSlug,
                label: candidate.modelLabel,
                provisional: true,
              })),
          ]);
          const toolIsCatalogEntry = Boolean(selectedTool);
          const modelIsCatalogEntry = Boolean(catalogModels.some((model) => model.slug === row.modelSlug));

          return (
            <View key={row.id} style={{ gap: appTheme.spacing.compact }}>
              <FieldBlock label={`Tool ${index + 1}`}>
                <MobileCreatablePicker
                  pickerId={`${row.id}:tool`}
                  activePickerId={activePickerId}
                  value={row.toolLabel}
                  options={toolPickerOptions}
                  placeholder="Choose or search tool"
                  disabled={disabled}
                  allowCustomEdit={!toolIsCatalogEntry && !row.createTool}
                  onActivePickerChange={setActivePickerId}
                  onSelect={(option) => {
                    if (!option) {
                      onUpdate(row.id, {
                        toolLabel: '',
                        toolSlug: '',
                        modelLabel: '',
                        modelSlug: '',
                        createTool: false,
                        createModel: false,
                      });
                      return;
                    }
                    onUpdate(row.id, {
                      toolLabel: option.label,
                      toolSlug: option.value,
                      modelLabel: '',
                      modelSlug: '',
                      createTool: option.provisional === true,
                      createModel: false,
                    });
                  }}
                  onCreate={(label) => onUpdate(row.id, {
                    toolLabel: label,
                    toolSlug: slugifyMobileValue(label) ?? '',
                    modelLabel: '',
                    modelSlug: '',
                    createTool: true,
                    createModel: false,
                  })}
                  onCustomEdit={(label) => onUpdate(row.id, {
                    toolLabel: label,
                    toolSlug: slugifyMobileValue(label) ?? '',
                    createTool: false,
                  })}
                />
              </FieldBlock>
              <FieldBlock label="Model">
                <MobileCreatablePicker
                  pickerId={`${row.id}:model`}
                  activePickerId={activePickerId}
                  value={row.modelLabel}
                  options={modelPickerOptions}
                  placeholder="Any model"
                  disabled={disabled || !row.toolLabel.trim()}
                  emptyOptionLabel="Any model"
                  allowCustomEdit={Boolean(row.modelLabel && !modelIsCatalogEntry && !row.createModel)}
                  onActivePickerChange={setActivePickerId}
                  onSelect={(option) => onUpdate(row.id, {
                    modelLabel: option?.label ?? '',
                    modelSlug: option?.value ?? '',
                    createModel: option?.provisional === true,
                  })}
                  onCreate={(label) => onUpdate(row.id, {
                    modelLabel: label,
                    modelSlug: slugifyMobileValue(label) ?? '',
                    createModel: true,
                  })}
                  onCustomEdit={(label) => onUpdate(row.id, {
                    modelLabel: label,
                    modelSlug: slugifyMobileValue(label) ?? '',
                    createModel: false,
                  })}
                />
              </FieldBlock>
              {!disabled && rows.length > 1 ? (
                <SecondaryButton label="Remove tool" onPress={() => onRemove(row.id)} />
              ) : null}
            </View>
          );
        })}
        {!disabled && rows.length < 5 ? (
          <View style={{ alignSelf: 'flex-start' }}>
            <MiniAction label="Add another tool" onPress={onAdd} />
          </View>
        ) : null}
      </View>
    </SurfaceSection>
  );
}

function TitleSection({
  draft,
  disabled,
  onChange,
}: {
  draft: PostComposerDraft;
  disabled: boolean;
  onChange: (patch: Partial<PostComposerDraft>) => void;
}) {
  return (
    <SurfaceSection
      eyebrow="Post"
      title="Title"
      accent="motion"
      style={COMPOSER_SECTION_STYLE}
    >
      <ComposerInput
        value={draft.title}
        onChangeText={(title) => onChange({ title })}
        placeholder={draft.proofMode === 'text' ? 'Title (optional)' : 'Give your post a title'}
        editable={!disabled}
      />
    </SurfaceSection>
  );
}

type MobilePickerOption = {
  value: string;
  label: string;
  provisional?: boolean;
};

type MobilePickerEntry =
  | { type: 'empty'; key: string; label: string }
  | { type: 'option'; key: string; option: MobilePickerOption }
  | { type: 'create'; key: string; label: string };

function uniquePickerOptions(options: MobilePickerOption[]) {
  const seen = new Set<string>();

  return options.filter((option) => {
    const key = option.value || option.label.toLowerCase();
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizePickerSearch(value: string) {
  return value.trim().toLocaleLowerCase();
}

function MobileCreatablePicker({
  pickerId,
  activePickerId,
  value,
  options,
  placeholder,
  disabled = false,
  emptyOptionLabel,
  allowCreate = true,
  allowCustomEdit = false,
  onActivePickerChange,
  onSelect,
  onCreate,
  onCustomEdit,
}: {
  pickerId: string;
  activePickerId: string | null;
  value: string;
  options: MobilePickerOption[];
  placeholder: string;
  disabled?: boolean;
  emptyOptionLabel?: string;
  allowCreate?: boolean;
  allowCustomEdit?: boolean;
  onActivePickerChange: (id: string | null) => void;
  onSelect: (option: MobilePickerOption | null) => void;
  onCreate?: (label: string) => void;
  onCustomEdit?: (label: string) => void;
}) {
  const [draftQuery, setDraftQuery] = useState<string | null>(null);
  const isOpen = activePickerId === pickerId;
  const query = isOpen ? draftQuery ?? value : value;
  const normalizedQuery = normalizePickerSearch(query);
  const matchingOptions = useMemo(() => {
    if (!normalizedQuery) return options;

    return options.filter((option) => (
      normalizePickerSearch(option.label).includes(normalizedQuery)
      || normalizePickerSearch(option.value).includes(normalizedQuery)
    ));
  }, [normalizedQuery, options]);
  const hasExactMatch = options.some((option) => (
    normalizePickerSearch(option.label) === normalizedQuery
    || normalizePickerSearch(option.value) === normalizedQuery
  ));
  const canCreate = Boolean(allowCreate && onCreate && normalizedQuery && !hasExactMatch);
  const entries = useMemo<MobilePickerEntry[]>(() => {
    const next: MobilePickerEntry[] = [];
    if (emptyOptionLabel && (!normalizedQuery || normalizePickerSearch(emptyOptionLabel).includes(normalizedQuery))) {
      next.push({ type: 'empty', key: 'empty', label: emptyOptionLabel });
    }
    matchingOptions.forEach((option) => {
      next.push({ type: 'option', key: `option-${option.value}`, option });
    });
    if (canCreate) {
      next.push({ type: 'create', key: `create-${normalizedQuery}`, label: query.trim() });
    }
    return next;
  }, [canCreate, emptyOptionLabel, matchingOptions, normalizedQuery, query]);

  const openPicker = () => {
    if (!disabled) {
      onActivePickerChange(pickerId);
    }
  };

  const closePicker = () => {
    setDraftQuery(null);
    onActivePickerChange(null);
  };

  const chooseEntry = (entry: MobilePickerEntry) => {
    if (entry.type === 'empty') {
      onSelect(null);
    } else if (entry.type === 'option') {
      onSelect(entry.option);
    } else {
      onCreate?.(entry.label);
    }
    closePicker();
  };

  const commitCustomEdit = () => {
    if (!allowCustomEdit || !onCustomEdit || !value || query.trim() === value.trim()) {
      return;
    }

    const exactOption = options.some((option) => normalizePickerSearch(option.label) === normalizedQuery);
    if (!exactOption && query.trim()) {
      onCustomEdit(query.trim());
    }
    setDraftQuery(null);
  };

  return (
    <View style={{ gap: 8 }}>
      <View style={{ position: 'relative' }}>
        <TextInput
          value={query}
          onChangeText={(nextQuery) => {
            setDraftQuery(nextQuery);
            openPicker();
          }}
          onFocus={openPicker}
          onBlur={commitCustomEdit}
          onSubmitEditing={() => {
            if (entries[0]) {
              chooseEntry(entries[0]);
            } else {
              commitCustomEdit();
              closePicker();
            }
          }}
          placeholder={placeholder}
          placeholderTextColor="rgba(255,255,255,0.36)"
          editable={!disabled}
          style={{
            minHeight: 44,
            borderRadius: 14,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: isOpen ? `${appTheme.colors.image}88` : appTheme.colors.border,
            backgroundColor: disabled ? appTheme.colors.surface : appTheme.colors.surfaceInset,
            color: disabled ? appTheme.colors.faint : appTheme.colors.text,
            ...appTheme.type.bodySm,
            fontWeight: '700',
            paddingLeft: appTheme.spacing.gap,
            paddingRight: 44,
            paddingVertical: appTheme.spacing.gap,
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${placeholder}`}
          disabled={disabled}
          onPress={() => {
            if (disabled) return;
            if (isOpen) {
              closePicker();
            } else {
              openPicker();
            }
          }}
          style={({ pressed }) => ({
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: 44,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.72 : disabled ? 0.38 : 1,
          })}
        >
          <ChevronDown size={16} color="rgba(255,255,255,0.58)" strokeWidth={2.6} />
        </Pressable>
      </View>

      {isOpen && !disabled ? (
        <View
          style={{
            maxHeight: 224,
            borderRadius: 16,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: appTheme.colors.border,
            backgroundColor: '#0a0b10',
            overflow: 'hidden',
          }}
        >
          <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={{ maxHeight: 224 }}>
            {entries.length > 0 ? entries.map((entry) => {
              const label = entry.type === 'option' ? entry.option.label : entry.label;
              const selected = entry.type === 'option' && normalizePickerSearch(entry.option.label) === normalizePickerSearch(value);

              return (
                <Pressable
                  key={entry.key}
                  accessibilityRole="button"
                  onPress={() => chooseEntry(entry)}
                  style={({ pressed }) => ({
                    minHeight: 44,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    backgroundColor: selected ? 'rgba(56,189,248,0.14)' : pressed ? 'rgba(255,255,255,0.07)' : 'transparent',
                  })}
                >
                  {entry.type === 'create' ? (
                    <Plus size={15} color={appTheme.colors.image} strokeWidth={2.8} />
                  ) : null}
                  <AppText
                    variant="bodySm"
                    color={entry.type === 'create' ? 'text' : selected ? 'text' : 'muted'}
                    style={{ flex: 1 }}
                  >
                    {entry.type === 'create' ? `Create "${label}"` : label}
                  </AppText>
                  {entry.type === 'option' && entry.option.provisional ? (
                    <AppText variant="caption" color="image">New</AppText>
                  ) : null}
                </Pressable>
              );
            }) : (
              <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
                <AppText variant="bodySm" color="faint">No matches</AppText>
              </View>
            )}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

function getMadeWithToolOptions(sourceTools: SourceToolOption[]): SourceToolOption[] {
  const optionsByKey = new Map<string, SourceToolOption>();
  const addTool = (tool: SourceToolOption) => {
    const key = tool.slug || tool.label.toLowerCase();
    const existing = optionsByKey.get(key);
    const normalizedTool: SourceToolOption = {
      slug: tool.slug,
      label: tool.label,
      models: tool.models.map((model) => ({ ...model })),
      supportedMediaKinds: [...tool.supportedMediaKinds],
    };

    if (!existing) {
      optionsByKey.set(key, normalizedTool);
      return;
    }

    if (existing.models.length === 0 && normalizedTool.models.length > 0) {
      optionsByKey.set(key, {
        ...existing,
        models: normalizedTool.models,
        supportedMediaKinds: existing.supportedMediaKinds.length > 0
          ? existing.supportedMediaKinds
          : normalizedTool.supportedMediaKinds,
      });
    }
  };

  sourceTools.forEach(addTool);
  POST_COMPOSER_SOURCE_OPTIONS.forEach(addTool);

  return [...optionsByKey.values()];
}

function ProofSection({
  draft,
  selectedGeneration,
  publishableGenerations,
  allGenerations,
  generationsLoading,
  generationsError,
  isPickingMedia,
  isFieldsLocked,
  onModeChange,
  onPickMedia,
  onChooseGeneration,
  onCreateGeneration,
  onRemoveMedia,
  onReorderMedia,
}: {
  draft: PostComposerDraft;
  selectedGeneration: GenerationListItem | null;
  publishableGenerations: GenerationListItem[];
  allGenerations: GenerationListItem[];
  generationsLoading: boolean;
  generationsError: unknown;
  isPickingMedia: boolean;
  isFieldsLocked: boolean;
  onModeChange: (mode: PostComposerMode) => void;
  onPickMedia: () => void;
  onChooseGeneration: (item: GenerationListItem) => void;
  onCreateGeneration: () => void;
  onRemoveMedia: (id: string) => void;
  onReorderMedia: (id: string, targetIndex: number) => void;
}) {
  return (
    <SurfaceSection
      eyebrow={draft.mode === 'creation' ? 'Generated media attached' : draft.proofMode === 'text' ? 'Text post' : 'Media post'}
      title="Proof"
      accent="image"
      style={COMPOSER_SECTION_STYLE}
    >
      {!selectedGeneration ? (
        <SegmentedRow>
          <Chip label="Media" active={draft.proofMode === 'media' && draft.mode !== 'creation'} onPress={() => onModeChange('upload')} disabled={isFieldsLocked} />
          <Chip label="Text" active={draft.proofMode === 'text'} onPress={() => onModeChange('text')} disabled={isFieldsLocked} />
          <Chip label="Creation" active={draft.mode === 'creation'} onPress={() => onModeChange('creation')} disabled={isFieldsLocked} />
        </SegmentedRow>
      ) : null}

      {draft.mode === 'upload' ? (
        <UploadContent
          draft={draft}
          isPicking={isPickingMedia}
          onPickMedia={onPickMedia}
          onRemoveMedia={onRemoveMedia}
          onReorderMedia={onReorderMedia}
          disabled={isFieldsLocked}
        />
      ) : null}

      {draft.mode === 'creation' && !selectedGeneration ? (
        <CreationContent
          items={publishableGenerations}
          selectedId={draft.selectedGenerationId}
          loading={generationsLoading}
          error={generationsError}
          visibleItems={isFieldsLocked ? allGenerations : publishableGenerations}
          onSelect={onChooseGeneration}
          onCreate={onCreateGeneration}
          disabled={isFieldsLocked}
        />
      ) : null}
    </SurfaceSection>
  );
}

function StorySection({
  draft,
  disabled,
  isDescriptionOpen,
  onChange,
  onToggleDescription,
}: {
  draft: PostComposerDraft;
  disabled: boolean;
  isDescriptionOpen: boolean;
  onChange: (patch: Partial<PostComposerDraft>) => void;
  onToggleDescription: () => void;
}) {
  return (
    <MinimalComposerSection
      title="Story"
      body="The public content visible in the community feed."
      action={(
        <MiniAction
          label={isDescriptionOpen ? 'Hide description' : 'Add feed description'}
          onPress={onToggleDescription}
        />
      )}
    >
      <FieldBlock label={draft.proofMode === 'text' ? 'Post body' : 'Caption'}>
        <ComposerInput
          value={draft.proofMode === 'text' ? draft.contentText : draft.caption}
          onChangeText={(value) => onChange(draft.proofMode === 'text' ? { contentText: value } : { caption: value })}
          placeholder={draft.proofMode === 'text' ? 'Write the post content...' : 'Write an optional caption...'}
          multiline
          minHeight={130}
          editable={!disabled}
        />
      </FieldBlock>
      {isDescriptionOpen ? (
        <FieldBlock label="Feed description">
          <ComposerInput
            value={draft.description}
            onChangeText={(description) => onChange({ description })}
            placeholder="Optional: give the post a short one-line setup for feeds and previews."
            multiline
            minHeight={78}
            editable={!disabled}
          />
        </FieldBlock>
      ) : null}
    </MinimalComposerSection>
  );
}

function UnlockSection({
  draft,
  selectedGeneration,
  packageStatus,
  isPickingResourceFile,
  onResourceChange,
  onCreationPackageChange,
  onTogglePromptResource,
  onResourceKindChange,
  onAddAttachment,
  onUpdateAttachment,
  onRemoveAttachment,
  onPickResourceFile,
  onAddSection,
  onUpdateSection,
  onRemoveSection,
}: {
  draft: PostComposerDraft;
  selectedGeneration: GenerationListItem | null;
  packageStatus: ReturnType<typeof getPostComposerPackageStatus>;
  isPickingResourceFile: boolean;
  onResourceChange: (patch: Partial<PostComposerDraft['resource']>) => void;
  onCreationPackageChange: (patch: Partial<PostComposerDraft['creationPackage']>) => void;
  onTogglePromptResource: (enabled: boolean) => void;
  onResourceKindChange: (kind: keyof PostComposerDraft['resource']['selectedKinds'], enabled: boolean) => void;
  onAddAttachment: (attachment?: Partial<PostComposerDraft['resource']['attachments'][number]>) => void;
  onUpdateAttachment: (id: string, patch: Partial<PostComposerDraft['resource']['attachments'][number]>) => void;
  onRemoveAttachment: (id: string) => void;
  onPickResourceFile: () => void;
  onAddSection: () => void;
  onUpdateSection: (id: string, patch: Partial<PostComposerDraft['resource']['sections'][number]>) => void;
  onRemoveSection: (id: string) => void;
}) {
  const resourceActive = draft.resource.accessMode !== 'none';
  const unlockEnabled = resourceActive
    || draft.creationPackage.attachGenerationReferences
    || draft.creationPackage.attachPromptResource;

  const toggleUnlockEnabled = () => {
    if (unlockEnabled) {
      onResourceChange({ accessMode: 'none', organizeSections: false });
      onCreationPackageChange({
        attachGenerationReferences: false,
        attachPromptResource: false,
      });
      return;
    }

    onResourceChange({ accessMode: 'free' });
  };

  return (
    <MinimalComposerSection
      title="Unlock"
      body="Add optional gated resources to this post."
      tone="workflow"
    >
      <UnlockChecklistRow
        checked={unlockEnabled}
        label="Add references & unlockable resources"
        onPress={toggleUnlockEnabled}
      />

      {unlockEnabled && draft.mode === 'creation' && selectedGeneration ? (
        <View style={{ gap: appTheme.spacing.compact }}>
          {hasGenerationReferences(selectedGeneration) ? (
            <ToggleRow
              label="Attach creation references"
              body="Include the saved input media in post details."
              value={draft.creationPackage.attachGenerationReferences}
              onValueChange={(attachGenerationReferences) => onCreationPackageChange({ attachGenerationReferences })}
              accent="image"
            />
          ) : null}
          <ToggleRow
            label="Use exact prompt as resource"
            body="Turn the generation prompt into a free resource package."
            value={draft.creationPackage.attachPromptResource}
            onValueChange={onTogglePromptResource}
            accent="workflow"
            disabled={!selectedGeneration.prompt?.trim()}
          />
        </View>
      ) : null}

      {unlockEnabled ? (
        <>
          <View
            style={{
              borderRadius: 16,
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.10)',
              backgroundColor: 'rgba(0,0,0,0.16)',
              padding: 10,
              gap: appTheme.spacing.gap,
            }}
          >
            <SegmentedRow>
              {POST_COMPOSER_UNLOCK_OPTIONS.filter((option) => option.id !== 'none').map((option) => (
                <Chip
                  key={option.id}
                  label={option.label === 'Paid' ? 'Paid ($)' : option.label}
                  active={draft.resource.accessMode === option.id}
                  onPress={() => {
                    onResourceChange({ accessMode: option.id });
                    if (option.id === 'none') {
                      onCreationPackageChange({
                        attachGenerationReferences: false,
                        attachPromptResource: false,
                      });
                    }
                  }}
                  accent={option.id === 'paid' ? 'commerce' : option.id === 'free' ? 'workflow' : 'motion'}
                />
              ))}
            </SegmentedRow>

            <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.08)' }} />

            <FieldBlock label="Resource types">
              <SegmentedRow wrap>
                {POST_COMPOSER_RESOURCE_KIND_OPTIONS.map((option) => (
                  <SmallChip
                    key={option.id}
                    label={option.label}
                    active={draft.resource.selectedKinds[option.id]}
                    onPress={() => onResourceKindChange(option.id, !draft.resource.selectedKinds[option.id])}
                  />
                ))}
              </SegmentedRow>
            </FieldBlock>

            {resourceActive ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: appTheme.spacing.gap }}>
                <AppText variant="caption" color="muted">Need section-based structure?</AppText>
                <MiniAction
                  label={draft.resource.organizeSections ? 'Disable section layout' : 'Enable section layout'}
                  onPress={() => onResourceChange({ organizeSections: !draft.resource.organizeSections })}
                />
              </View>
            ) : null}
          </View>

          <ReadinessRow label={packageStatus.label} body={packageStatus.body} state={packageStatus.state} />
        </>
      ) : null}

      {resourceActive ? (
        <>
          <UnlockFields
            accessMode={draft.resource.accessMode}
            resource={draft.resource}
            onChange={onResourceChange}
            onAddAttachment={onAddAttachment}
            onUpdateAttachment={onUpdateAttachment}
            onRemoveAttachment={onRemoveAttachment}
            onPickResourceFile={onPickResourceFile}
            isPickingResourceFile={isPickingResourceFile}
          />
          {draft.resource.organizeSections ? (
            <View style={{ gap: appTheme.spacing.gap }}>
              {draft.resource.sections.map((section, index) => (
                <View key={section.id} style={{ gap: appTheme.spacing.compact }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: appTheme.spacing.compact }}>
                    <AppText variant="label" color="muted">{`Section ${index + 1}`}</AppText>
                    <MiniAction
                      label="Remove"
                      accessibilityLabel={`Remove Section ${index + 1}`}
                      onPress={() => onRemoveSection(section.id)}
                    />
                  </View>
                  <ComposerInput value={section.title} onChangeText={(title) => onUpdateSection(section.id, { title })} placeholder="Section title" />
                  <ComposerInput value={section.description} onChangeText={(description) => onUpdateSection(section.id, { description })} placeholder="Section description" multiline minHeight={68} />
                  <ComposerInput value={section.promptText} onChangeText={(promptText) => onUpdateSection(section.id, { promptText })} placeholder="Section prompt" multiline minHeight={76} />
                  <ComposerInput value={section.notesMarkdown} onChangeText={(notesMarkdown) => onUpdateSection(section.id, { notesMarkdown })} placeholder="Section notes" multiline minHeight={76} />
                  <ToggleRow
                    label="Section remix access"
                    value={section.allowRemix}
                    onValueChange={(allowRemix) => onUpdateSection(section.id, { allowRemix })}
                    accent="workflow"
                  />
                </View>
              ))}
              <SecondaryButton label="Add section" onPress={onAddSection} />
            </View>
          ) : null}
        </>
      ) : null}
    </MinimalComposerSection>
  );
}

function PublishSection({
  actions,
  canSubmit,
  isPending,
  onSubmit,
}: {
  actions: ReturnType<typeof getPostComposerPublishActions>;
  canSubmit: boolean;
  isPending: boolean;
  onSubmit: (visibility: PostComposerDraft['visibility']) => void;
}) {
  return (
    <MinimalComposerSection
      title="Publish"
      body="Choose who can see this post."
      tone="commerce"
      action={<MinimalStatusPill label="Saved privately in Studio" tone="commerce" />}
    >
      <View
        style={{
          flexDirection: actions.length > 2 ? 'column' : 'row',
          gap: appTheme.spacing.compact,
        }}
      >
        {actions.map((action) => (
          <PublishActionCard
            key={action.id}
            variant={action.variant}
            label={action.label}
            body={getPublishActionBody(action.visibility)}
            loading={isPending}
            disabled={!canSubmit || action.disabled}
            onPress={() => onSubmit(action.visibility)}
          />
        ))}
      </View>
    </MinimalComposerSection>
  );
}

function SelectedCreationHero({
  item,
  disabled,
  onChange,
}: {
  item: GenerationListItem;
  disabled: boolean;
  onChange: () => void;
}) {
  const mediaUrl = item.output_urls?.[0] ?? item.output_url ?? null;
  const previewUrl = getGenerationPreviewImageUrl(item);
  const mediaKind = getPublishGenerationMediaKind(item);
  const visualUrl = mediaKind === 'video' ? previewUrl : mediaUrl;

  return (
    <SurfaceSection
      eyebrow="Selected creation"
      title={getPublishGenerationTitle(item)}
      body={getPublishGenerationSubtitle(item)}
      accent="motion"
      action={!disabled ? <SecondaryButton label="Change creation" onPress={onChange} /> : null}
      style={COMPOSER_SECTION_STYLE}
    >
      <View
        style={{
          minHeight: 168,
          borderRadius: appTheme.radii.lg,
          borderCurve: 'continuous',
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: appTheme.colors.border,
          backgroundColor: appTheme.colors.surfaceInset,
        }}
      >
        {visualUrl ? (
          <Image source={{ uri: visualUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
        ) : (
          <LinearGradient colors={['#17131d', '#0b0c12', '#1d1020']} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: appTheme.spacing.gap }}>
            <Sparkles size={34} color={appTheme.colors.motion} />
            <AppText variant="cardTitle">Creation ready</AppText>
          </LinearGradient>
        )}
        {mediaKind === 'video' ? (
          <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.16)' }}>
            <Play size={44} color="#fff" fill="#fff" />
          </View>
        ) : null}
        <View style={{ position: 'absolute', left: 10, right: 10, bottom: 10, borderRadius: appTheme.radii.md, backgroundColor: 'rgba(0,0,0,0.62)', padding: 10, gap: 5 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact }}>
            <PackageCheck size={17} color={appTheme.colors.success} />
            <AppText variant="label" color="text" numberOfLines={1}>Creation selected</AppText>
          </View>
          <AppText variant="caption" color="textSecondary" numberOfLines={1}>References and resources optional.</AppText>
        </View>
      </View>
    </SurfaceSection>
  );
}

function FieldBlock({
  label,
  children,
  compact,
}: {
  label: string;
  children: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <View
      style={{
        flex: compact ? 1 : undefined,
        minWidth: compact ? 0 : undefined,
        gap: appTheme.spacing.compact,
      }}
    >
      <AppText variant="label" color="muted" style={{ textTransform: 'uppercase' }}>
        {label}
      </AppText>
      {children}
    </View>
  );
}

function MinimalComposerSection({
  title,
  body,
  tone = 'neutral',
  pill,
  action,
  children,
}: {
  title: string;
  body?: string;
  tone?: 'neutral' | 'workflow' | 'commerce';
  pill?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const toneColor = tone === 'workflow'
    ? appTheme.colors.workflow
    : tone === 'commerce'
      ? appTheme.colors.image
      : appTheme.colors.borderStrong;

  return (
    <View
      style={{
        ...MINIMAL_COMPOSER_SECTION_STYLE,
        borderWidth: 1,
        borderColor: tone === 'neutral' ? appTheme.colors.border : `${toneColor}3f`,
        backgroundColor: tone === 'workflow' ? 'rgba(5, 45, 32, 0.42)' : appTheme.colors.surface,
      }}
    >
      <View style={{ gap: 9 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: appTheme.spacing.gap }}>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <AppText variant="cardTitle">{title}</AppText>
            {body ? (
              <AppText variant="caption" color="muted">
                {body}
              </AppText>
            ) : null}
          </View>
          {action ? (
            <View style={{ flexShrink: 0 }}>{action}</View>
          ) : null}
        </View>
        {!action && pill ? (
          <MinimalStatusPill label={pill} tone={tone} />
        ) : null}
      </View>
      {children}
    </View>
  );
}

function MinimalStatusPill({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'workflow' | 'commerce';
}) {
  const color = tone === 'workflow'
    ? appTheme.colors.workflow
    : tone === 'commerce'
      ? appTheme.colors.image
      : appTheme.colors.muted;

  return (
    <View
      style={{
        minHeight: 30,
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: `${color}55`,
        backgroundColor: `${color}14`,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 10,
      }}
    >
      <AppText selectable={false} variant="caption" color={tone === 'neutral' ? 'muted' : 'text'} numberOfLines={1}>
        {label}
      </AppText>
    </View>
  );
}

function UnlockChecklistRow({
  checked,
  label,
  onPress,
}: {
  checked: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: checked ? `${appTheme.colors.workflow}66` : 'transparent',
        backgroundColor: checked ? 'rgba(16,185,129,0.10)' : 'transparent',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: checked ? 10 : 0,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 4,
          borderWidth: 1,
          borderColor: checked ? appTheme.colors.workflow : appTheme.colors.borderStrong,
          backgroundColor: checked ? appTheme.colors.workflow : appTheme.colors.surfaceInset,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked ? <Check size={13} color="#04130c" strokeWidth={3} /> : null}
      </View>
      <AppText selectable={false} variant="label" color="text">
        {label}
      </AppText>
    </Pressable>
  );
}

function PublishActionCard({
  label,
  body,
  variant,
  loading,
  disabled,
  onPress,
}: {
  label: string;
  body: string;
  variant: 'primary' | 'secondary';
  loading: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const isPrimary = variant === 'primary';

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 58,
        borderRadius: 13,
        borderWidth: 1,
        borderColor: isPrimary ? `${appTheme.colors.image}dd` : appTheme.colors.border,
        backgroundColor: isPrimary ? appTheme.colors.image : appTheme.colors.surfaceStrong,
        opacity: disabled ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
        justifyContent: 'center',
        gap: 4,
        paddingHorizontal: 14,
        paddingVertical: 10,
      })}
    >
      {loading ? (
        <ActivityIndicator color={isPrimary ? appTheme.colors.textInverse : appTheme.colors.text} />
      ) : (
        <>
          <AppText selectable={false} variant="label" color={isPrimary ? 'textInverse' : 'text'} numberOfLines={1}>
            {label}
          </AppText>
          <AppText selectable={false} variant="caption" color={isPrimary ? 'textInverse' : 'muted'} numberOfLines={1}>
            {body}
          </AppText>
        </>
      )}
    </Pressable>
  );
}

function getPublishActionBody(visibility: PostComposerDraft['visibility']) {
  if (visibility === 'private') return 'Saved privately in Studio.';
  if (visibility === 'unlisted') return 'Share by link.';
  return 'Visible in Feed.';
}

function ComposerInput({
  value,
  onChangeText,
  placeholder,
  multiline,
  minHeight,
  editable = true,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  multiline?: boolean;
  minHeight?: number;
  editable?: boolean;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor="rgba(255,255,255,0.36)"
      multiline={multiline}
      textAlignVertical={multiline ? 'top' : 'center'}
      editable={editable}
      style={{
        minHeight: multiline ? minHeight ?? 112 : 44,
        borderRadius: 14,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: editable ? appTheme.colors.surfaceInset : appTheme.colors.surface,
        color: editable ? appTheme.colors.text : appTheme.colors.faint,
        ...appTheme.type.bodySm,
        fontWeight: '700',
        paddingHorizontal: appTheme.spacing.gap,
        paddingVertical: appTheme.spacing.gap,
      }}
    />
  );
}

function SegmentedRow({ children, wrap }: { children: React.ReactNode; wrap?: boolean }) {
  return <View style={{ flexDirection: 'row', flexWrap: wrap ? 'wrap' : 'nowrap', gap: 8 }}>{children}</View>;
}

function Chip({
  label,
  active,
  onPress,
  disabled = false,
  accent = 'motion',
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  disabled?: boolean;
  accent?: ToolAccent;
}) {
  return (
    <ChoiceChip
      accent={accent}
      active={active}
      disabled={disabled}
      grow
      label={label}
      onPress={onPress}
    />
  );
}

function SmallChip({ label, active, onPress, disabled = false }: { label: string; active: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <ChoiceChip
      accent="workflow"
      active={active}
      compact
      disabled={disabled}
      label={label}
      onPress={onPress}
    />
  );
}

const MEDIA_CARD_WIDTH = 132;
const MEDIA_CARD_GAP = 10;
const MEDIA_CARD_STEP = MEDIA_CARD_WIDTH + MEDIA_CARD_GAP;

function UploadContent({
  draft,
  isPicking,
  onPickMedia,
  onRemoveMedia,
  onReorderMedia,
  disabled = false,
}: {
  draft: PostComposerDraft;
  isPicking: boolean;
  onPickMedia: () => void;
  onRemoveMedia: (id: string) => void;
  onReorderMedia: (id: string, targetIndex: number) => void;
  disabled?: boolean;
}) {
  return (
    <View style={{ gap: 10 }}>
      <View style={{ gap: 4 }}>
        <AppText variant="label" color="text">Upload images or videos</AppText>
        <AppText variant="caption" color="muted">Cover first · max 5</AppText>
      </View>
      {draft.mediaItems.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
          {draft.mediaItems.map((item, index) => (
            <MediaGalleryCard
              key={item.id}
              item={item}
              index={index}
              totalItems={draft.mediaItems.length}
              disabled={disabled}
              onRemoveMedia={onRemoveMedia}
              onReorderMedia={onReorderMedia}
            />
          ))}
          {!disabled && draft.mediaItems.length < 5 ? (
            <AddMediaGalleryCard
              isPicking={isPicking}
              remainingSlots={5 - draft.mediaItems.length}
              onPress={onPickMedia}
            />
          ) : null}
        </ScrollView>
      ) : (
        <Pressable
          accessibilityRole="button"
          disabled={disabled || isPicking}
          onPress={onPickMedia}
          style={({ pressed }) => ({
            minHeight: 124,
            borderRadius: 16,
            borderWidth: 1,
            borderStyle: 'dashed',
            borderColor: pressed ? `${appTheme.colors.image}aa` : appTheme.colors.border,
            backgroundColor: pressed ? appTheme.colors.surfaceStrong : appTheme.colors.surfaceInset,
            alignItems: 'center',
            justifyContent: 'center',
            gap: appTheme.spacing.compact,
            padding: appTheme.spacing.card,
            opacity: disabled || isPicking ? appTheme.opacity.disabled : 1,
          })}
        >
          <ImageIcon size={30} color={appTheme.colors.muted} />
          <AppText variant="label" color="muted">{isPicking ? 'Opening library...' : 'Add media'}</AppText>
        </Pressable>
      )}
    </View>
  );
}

function AddMediaGalleryCard({
  isPicking,
  remainingSlots,
  onPress,
}: {
  isPicking: boolean;
  remainingSlots: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Add more media"
      disabled={isPicking}
      onPress={onPress}
      style={({ pressed }) => ({
        width: MEDIA_CARD_WIDTH,
        borderRadius: 16,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: pressed ? `${appTheme.colors.image}cc` : appTheme.colors.border,
        backgroundColor: pressed ? appTheme.colors.surfaceStrong : appTheme.colors.surfaceInset,
        overflow: 'hidden',
        opacity: isPicking ? appTheme.opacity.disabled : 1,
      })}
    >
      <View
        style={{
          height: 132,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          backgroundColor: '#080912',
        }}
      >
        <View
          style={{
            width: 42,
            height: 42,
            borderRadius: 21,
            borderWidth: 1,
            borderColor: `${appTheme.colors.image}88`,
            backgroundColor: 'rgba(56,189,248,0.12)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Plus size={22} color={appTheme.colors.image} strokeWidth={2.8} />
        </View>
        <AppText variant="caption" color="muted">{isPicking ? 'Opening...' : 'Add media'}</AppText>
      </View>
      <View style={{ padding: 9, gap: 7 }}>
        <Text numberOfLines={1} style={{ color: '#fff', fontSize: 12, fontWeight: '900' }}>
          Add media
        </Text>
        <Text numberOfLines={1} style={{ color: appTheme.colors.muted, fontSize: 11, fontWeight: '700' }}>
          {`${remainingSlots} ${remainingSlots === 1 ? 'slot' : 'slots'} left`}
        </Text>
      </View>
    </Pressable>
  );
}

function MediaGalleryCard({
  item,
  index,
  totalItems,
  disabled,
  onRemoveMedia,
  onReorderMedia,
}: {
  item: PostComposerMediaItem;
  index: number;
  totalItems: number;
  disabled: boolean;
  onRemoveMedia: (id: string) => void;
  onReorderMedia: (id: string, targetIndex: number) => void;
}) {
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const isDragArmedRef = useRef(false);
  const dragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const label = index === 0 ? 'Cover' : `Media ${index + 1}`;
  const canDrag = !disabled && totalItems > 1;

  const clearDragTimer = () => {
    if (dragTimerRef.current) {
      clearTimeout(dragTimerRef.current);
      dragTimerRef.current = null;
    }
  };

  const setDragArmed = (armed: boolean) => {
    isDragArmedRef.current = armed;
  };

  const resetDrag = () => {
    clearDragTimer();
    setDragArmed(false);
    setIsDragging(false);
    setDragOffset(0);
  };

  const finishDrag = (dx: number) => {
    const wasArmed = isDragArmedRef.current;
    resetDrag();
    if (!wasArmed) return;
    const slotDelta = Math.round(dx / MEDIA_CARD_STEP);
    if (slotDelta === 0) return;
    const targetIndex = Math.max(0, Math.min(index + slotDelta, totalItems - 1));
    onReorderMedia(item.id, targetIndex);
  };

  useEffect(() => () => clearDragTimer(), []);

  const dragResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => canDrag,
    onPanResponderGrant: () => {
      clearDragTimer();
      dragTimerRef.current = setTimeout(() => {
        setDragArmed(true);
        setIsDragging(true);
      }, 220);
      setDragOffset(0);
    },
    onPanResponderMove: (_event, gesture) => {
      if (canDrag && isDragArmedRef.current) setDragOffset(gesture.dx);
    },
    onPanResponderRelease: (_event, gesture) => finishDrag(gesture.dx),
    onPanResponderTerminate: resetDrag,
    onPanResponderTerminationRequest: () => false,
  }), [canDrag, index, item.id, onReorderMedia, totalItems]);

  return (
    <View
      accessibilityRole={canDrag ? 'adjustable' : undefined}
      accessibilityLabel={canDrag ? `Hold ${label} to reorder` : undefined}
      {...dragResponder.panHandlers}
      style={{
        width: MEDIA_CARD_WIDTH,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: isDragging ? `${appTheme.colors.image}dd` : index === 0 ? `${appTheme.colors.image}aa` : appTheme.colors.border,
        backgroundColor: isDragging ? appTheme.colors.surfaceStrong : appTheme.colors.surfaceInset,
        overflow: 'hidden',
        transform: [{ translateX: dragOffset }],
        zIndex: isDragging ? 10 : 0,
        opacity: isDragging ? 0.92 : 1,
      }}
    >
      <View style={{ height: 132, backgroundColor: '#080912' }}>
        {item.mediaKind === 'image' ? (
          <Image source={{ uri: item.previewUrl ?? item.uri }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
        ) : (
          <LinearGradient colors={['#111827', '#271233', '#080912']} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Play size={34} color="#fff" fill="#fff" />
          </LinearGradient>
        )}
        {!disabled ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${label}`}
            onPress={() => onRemoveMedia(item.id)}
            style={({ pressed }) => ({
              position: 'absolute',
              top: 8,
              right: 8,
              width: 30,
              height: 30,
              borderRadius: 15,
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.2)',
              backgroundColor: 'rgba(0,0,0,0.58)',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.72 : 1,
            })}
          >
            <X size={15} color="#fff" strokeWidth={3} />
          </Pressable>
        ) : null}
      </View>
      <View style={{ padding: 9, gap: 7 }}>
        <Text numberOfLines={1} style={{ color: '#fff', fontSize: 12, fontWeight: '900' }}>
          {label}
        </Text>
        <Text numberOfLines={1} style={{ color: appTheme.colors.muted, fontSize: 11, fontWeight: '700' }}>
          {item.name}
        </Text>
      </View>
    </View>
  );
}

function MiniAction({
  label,
  onPress,
  disabled = false,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 28,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: appTheme.colors.surfaceStrong,
        opacity: disabled ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
        paddingHorizontal: 8,
        alignItems: 'center',
        justifyContent: 'center',
      })}
    >
      <Text style={{ color: appTheme.colors.text, fontSize: 10, fontWeight: '900' }}>{label}</Text>
    </Pressable>
  );
}

function CreationContent({
  items,
  selectedId,
  loading,
  error,
  visibleItems,
  onSelect,
  onCreate,
  disabled = false,
}: {
  items: GenerationListItem[];
  selectedId: string | null;
  loading: boolean;
  error: unknown;
  visibleItems?: GenerationListItem[];
  onSelect: (item: GenerationListItem) => void;
  onCreate: () => void;
  disabled?: boolean;
}) {
  const displayItems = visibleItems ?? items;

  if (loading) {
    return <ActivityIndicator color="#d946ef" />;
  }

  if (error) {
    return <StatusBlock tone="danger" title="Could not load creations" body={error instanceof Error ? error.message : 'Try again.'} />;
  }

  if (disabled) {
    const selectedItem = displayItems.find((item) => item.id === selectedId);
    if (!selectedItem) {
      return (
        <Text selectable style={{ color: appTheme.colors.muted, fontSize: 13, lineHeight: 19 }}>
          No creation attached.
        </Text>
      );
    }
    return (
      <View style={{ alignSelf: 'flex-start' }}>
        <CreationCard item={selectedItem} selected={true} onPress={() => {}} disabled={true} />
      </View>
    );
  }

  if (items.length === 0) {
    return (
      <View style={{ gap: 10 }}>
        <Text selectable style={{ color: appTheme.colors.muted, fontSize: 13, lineHeight: 19 }}>
          No finished Magicbooklet creations are ready to post yet.
        </Text>
        <PrimaryButton label="Create first" onPress={onCreate} accent="motion" />
      </View>
    );
  }

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
      {displayItems.map((item) => (
        <CreationCard key={item.id} item={item} selected={selectedId === item.id} onPress={() => onSelect(item)} />
      ))}
    </ScrollView>
  );
}

function CreationCard({ item, selected, onPress, disabled = false }: { item: GenerationListItem; selected: boolean; onPress: () => void; disabled?: boolean }) {
  const mediaUrl = item.output_urls?.[0] ?? item.output_url ?? null;
  const previewUrl = getGenerationPreviewImageUrl(item);
  const mediaKind = getPublishGenerationMediaKind(item);
  const visualUrl = mediaKind === 'video' ? previewUrl : mediaUrl;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 150,
        borderRadius: 18,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: selected ? '#66ff45' : 'rgba(255,255,255,0.10)',
        backgroundColor: 'rgba(255,255,255,0.06)',
        opacity: disabled ? 0.8 : pressed ? 0.78 : 1,
      })}
    >
      <View style={{ height: 148, backgroundColor: '#080912' }}>
        {visualUrl ? (
          <Image source={{ uri: visualUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
        ) : (
          <LinearGradient colors={mediaKind === 'video' ? ['#111827', '#271233', '#080912'] : ['#121226', '#171123', '#080912']} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            {mediaKind === 'video' ? <Play size={31} color="#fff" fill="#fff" /> : <Sparkles size={31} color="#fff" />}
          </LinearGradient>
        )}
        {visualUrl && mediaKind === 'video' ? (
          <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.18)' }}>
            <Play size={31} color="#fff" fill="#fff" />
          </View>
        ) : null}
        {selected ? (
          <View style={{ position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 14, backgroundColor: '#66ff45', alignItems: 'center', justifyContent: 'center' }}>
            <Check size={17} color="#07110a" strokeWidth={3} />
          </View>
        ) : null}
      </View>
      <View style={{ padding: 10, gap: 5 }}>
        <Text numberOfLines={2} style={{ color: '#fff', fontSize: 13, lineHeight: 17, fontWeight: '900' }}>{getPublishGenerationTitle(item)}</Text>
        <Text numberOfLines={1} style={{ color: appTheme.colors.muted, fontSize: 11, fontWeight: '800' }}>
          {getPublishGenerationSubtitle(item)} · {formatRelativeTime(item.completed_at ?? item.created_at)}
        </Text>
      </View>
    </Pressable>
  );
}

function SecondaryPickButton({ icon, label, loading, onPress }: { icon: React.ReactNode; label: string; loading: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={loading}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 44,
        borderRadius: 22,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.12)',
        backgroundColor: 'rgba(255,255,255,0.075)',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 8,
        opacity: pressed ? 0.75 : loading ? 0.58 : 1,
      })}
    >
      {loading ? <ActivityIndicator color="#fff" /> : icon}
      <Text style={{ color: '#fff', fontSize: 13, fontWeight: '900' }}>{label}</Text>
    </Pressable>
  );
}

function UnlockFields({
  accessMode,
  resource,
  onChange,
  onAddAttachment,
  onUpdateAttachment,
  onRemoveAttachment,
  onPickResourceFile,
  isPickingResourceFile,
}: {
  accessMode: PostResourceBundleAccessMode;
  resource: PostComposerDraft['resource'];
  onChange: (patch: Partial<PostComposerDraft['resource']>) => void;
  onAddAttachment: (attachment?: Partial<PostComposerDraft['resource']['attachments'][number]>) => void;
  onUpdateAttachment: (id: string, patch: Partial<PostComposerDraft['resource']['attachments'][number]>) => void;
  onRemoveAttachment: (id: string) => void;
  onPickResourceFile: () => void;
  isPickingResourceFile: boolean;
}) {
  return (
    <View style={{ gap: 10 }}>
      <ComposerInput value={resource.previewText} onChangeText={(previewText) => onChange({ previewText })} placeholder="Buyer preview: what is inside the unlock?" minHeight={64} multiline />
      {accessMode === 'paid' ? (
        <ComposerInput value={resource.priceUsd} onChangeText={(priceUsd) => onChange({ priceUsd })} placeholder="Price in USD, e.g. 9" />
      ) : null}
      {resource.selectedKinds.prompt ? (
        <ComposerInput value={resource.promptText} onChangeText={(promptText) => onChange({ promptText })} placeholder="Exact prompt or prompt pack" minHeight={80} multiline />
      ) : null}
      {resource.selectedKinds.workflow ? (
        <ComposerInput value={resource.workflowShareUrl} onChangeText={(workflowShareUrl) => onChange({ workflowShareUrl })} placeholder="Workflow/setup URL" />
      ) : null}
      {resource.selectedKinds.notes ? (
        <ComposerInput value={resource.notesMarkdown} onChangeText={(notesMarkdown) => onChange({ notesMarkdown })} placeholder="Notes, steps, or usage guide" minHeight={84} multiline />
      ) : null}
      {resource.selectedKinds.files ? (
        <View style={{ gap: appTheme.spacing.compact }}>
          <View style={{ flexDirection: 'row', gap: appTheme.spacing.compact }}>
            <SecondaryButton label="Add link" onPress={() => onAddAttachment({ kind: 'link', resourceType: 'external_link' })} />
            <SecondaryButton label={isPickingResourceFile ? 'Uploading file' : 'Upload file'} disabled={isPickingResourceFile} onPress={onPickResourceFile} />
          </View>
          {resource.attachments.map((attachment) => (
            <View key={attachment.id} style={{ gap: appTheme.spacing.compact }}>
              <ComposerInput value={attachment.label} onChangeText={(label) => onUpdateAttachment(attachment.id, { label })} placeholder="Attachment label" />
              {attachment.kind === 'file' ? (
                <ComposerInput value={attachment.storagePath ?? ''} onChangeText={(storagePath) => onUpdateAttachment(attachment.id, { storagePath })} placeholder="Uploaded file path" />
              ) : (
                <ComposerInput value={attachment.url ?? ''} onChangeText={(url) => onUpdateAttachment(attachment.id, { url })} placeholder="File or reference link" />
              )}
              <SegmentedRow wrap>
                {(['external_link', 'source_file', 'reference_image', 'preset', 'settings'] as const).map((type) => (
                  <SmallChip
                    key={`${attachment.id}-${type}`}
                    label={type.replace(/_/g, ' ')}
                    active={attachment.resourceType === type}
                    onPress={() => onUpdateAttachment(attachment.id, { resourceType: type })}
                  />
                ))}
              </SegmentedRow>
              <SecondaryButton label="Remove resource" onPress={() => onRemoveAttachment(attachment.id)} />
            </View>
          ))}
        </View>
      ) : null}
      {resource.selectedKinds.remix ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: resource.allowRemix }}
          onPress={() => onChange({ allowRemix: !resource.allowRemix })}
          style={({ pressed }) => ({
            minHeight: 42,
            borderRadius: 21,
            borderWidth: 1,
            borderColor: resource.allowRemix ? 'rgba(102,255,69,0.48)' : 'rgba(255,255,255,0.10)',
            backgroundColor: resource.allowRemix ? 'rgba(102,255,69,0.13)' : 'rgba(255,255,255,0.06)',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 13,
            opacity: pressed ? 0.76 : 1,
          })}
        >
          <Text style={{ color: resource.allowRemix ? '#66ff45' : appTheme.colors.muted, fontSize: 13, fontWeight: '900' }}>Include remix access</Text>
          <Lock size={16} color={resource.allowRemix ? '#66ff45' : appTheme.colors.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

function validateCurrentDraft(draft: PostComposerDraft, selectedGeneration: GenerationListItem | null, skipGenerationSelection = false) {
  const result = validatePostComposerDraft(draft);
  if (!result.valid) return result;
  if (draft.mode === 'creation' && !selectedGeneration && !skipGenerationSelection) {
    return { valid: false, message: 'Choose a finished creation before publishing.' };
  }
  return result;
}

function generationToPostCategory(item: GenerationListItem): PostComposerCategory {
  if (item.category === 'video' || item.category === 'motion' || item.category === 'ugc-ad') return item.category;
  return 'image';
}

function getGenerationPreviewImageUrl(item: GenerationListItem) {
  return item.previewUrl ?? item.preview_url ?? null;
}

function slugifyMobileValue(value: string | null | undefined) {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || null;
}

function deriveResourceSelections(bundle: any): PostComposerDraft['resource']['selectedKinds'] {
  const resources = bundle?.resources ?? {};
  const attachments = resources.attachments ?? [];
  const items = resources.items ?? [];

  return {
    prompt: Boolean(resources.promptText || items.some((item: any) => item.type === 'prompt')),
    workflow: Boolean(resources.workflowShareUrl || items.some((item: any) => item.type === 'workflow')),
    files: Boolean(attachments.length || items.some((item: any) => item.storagePath || item.externalUrl)),
    notes: Boolean(resources.notesMarkdown || items.some((item: any) => item.type === 'note' || item.type === 'settings')),
    remix: Boolean(resources.allowRemix || items.some((item: any) => item.type === 'remix_access')),
  };
}

async function invalidatePostCaches(queryClient: QueryClient, userId: string | undefined) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['post-new-generations', userId] }),
    queryClient.invalidateQueries({ queryKey: ['profile-generations', userId] }),
    queryClient.invalidateQueries({ queryKey: ['profile-owner-posts', userId] }),
    queryClient.invalidateQueries({ queryKey: ['home-generations', userId] }),
    queryClient.invalidateQueries({ queryKey: ['home-seller-posts', userId] }),
    queryClient.invalidateQueries({ queryKey: ['generations', userId] }),
    queryClient.invalidateQueries({ queryKey: ['showcase-feed'] }),
  ]);
}
