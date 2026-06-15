import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { Check, FileText, ImageIcon, Lock, PackageCheck, Play, Sparkles } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
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
  getPostComposerPreviewStatusLabel,
  getPostComposerReadiness,
  getPostComposerSectionSummary,
  getPostComposerSubmitLabel,
  getPublishGenerationMediaKind,
  getPublishGenerationSubtitle,
  getPublishGenerationTitle,
  getPublishableGenerations,
  POST_COMPOSER_CATEGORY_OPTIONS,
  POST_COMPOSER_RESOURCE_KIND_OPTIONS,
  POST_COMPOSER_SOURCE_OPTIONS,
  POST_COMPOSER_UNLOCK_OPTIONS,
  POST_COMPOSER_VISIBILITY_OPTIONS,
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
  const readiness = useMemo(
    () => getPostComposerReadiness(draft, selectedGeneration, isEditMode && isGenerationBacked),
    [draft, isEditMode, isGenerationBacked, selectedGeneration]
  );
  const sectionSummary = useMemo(
    () => getPostComposerSectionSummary(draft, selectedGeneration),
    [draft, selectedGeneration]
  );
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

  const chooseMedia = async (kind: 'image' | 'video') => {
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
            kind,
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
        category: kind === 'video' ? 'video' : 'image',
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

  const moveMediaItem = (id: string, direction: -1 | 1) => {
    setDraft((current) => {
      const index = current.mediaItems.findIndex((item) => item.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= current.mediaItems.length) {
        return current;
      }
      const next = [...current.mediaItems];
      const [moved] = next.splice(index, 1);
      next.splice(targetIndex, 0, moved);
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

  const publishActions = getPostComposerPublishActions({
    selectedVisibility: draft.visibility,
    isEditMode,
    isPending: publishMutation.isPending,
  });
  const publishReadiness = readiness.find((item) => item.id === 'publish') ?? readiness[readiness.length - 1];
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
        <PostIntro isEdit={isEditMode} isGenerationBacked={isGenerationBacked} />

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

        <MadeWithSection
          rows={draft.madeWithRows}
          sourceTools={sourceTools}
          disabled={isFieldsLocked || draft.mode === 'creation'}
          onUpdate={updateMadeWithRow}
          onAdd={addMadeWithRow}
          onRemove={removeMadeWithRow}
        />

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
          onPickImage={() => chooseMedia('image')}
          onPickVideo={() => chooseMedia('video')}
          onChooseGeneration={chooseGeneration}
          onCreateGeneration={() => router.push('/(tabs)/creator' as never)}
          onRemoveMedia={removeMediaItem}
          onMoveMedia={moveMediaItem}
        />

        {focusResourcePackage ? unlockSection : null}

        <StorySection
          draft={draft}
          disabled={isFieldsLocked}
          onChange={updateDraft}
        />

        {!focusResourcePackage ? unlockSection : null}

        <PublishSection
          draft={draft}
          actions={publishActions}
          canSubmit={canSubmit}
          publishReadiness={publishReadiness}
          isPending={publishMutation.isPending}
          onDraftChange={updateDraft}
          onSubmit={(visibility) => {
            setMessage(null);
            publishMutation.mutate(visibility);
          }}
        />

        <ChecklistSection readiness={readiness} />
        <PreviewPanel draft={draft} selectedGeneration={selectedGeneration} />
      </ScrollView>
    </View>
  );
}

function PostIntro({ isEdit, isGenerationBacked }: { isEdit: boolean; isGenerationBacked: boolean }) {
  return (
    <SurfaceSection
      eyebrow={isEdit ? 'Edit' : 'Composer'}
      title={isEdit ? 'Update post' : 'Create post'}
      accent="motion"
      style={COMPOSER_SECTION_STYLE}
    >
      {isEdit && isGenerationBacked ? (
        <ReadinessRow label="Creation locked" body="Media and source stay fixed." state="neutral" />
      ) : null}
    </SurfaceSection>
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

  return (
    <SurfaceSection
      eyebrow="Attribution"
      title="Made With"
      accent="image"
      style={COMPOSER_SECTION_STYLE}
    >
      <View style={{ gap: appTheme.spacing.gap }}>
        {rows.map((row, index) => (
          <View key={row.id} style={{ gap: appTheme.spacing.compact }}>
            <FieldBlock label={`Tool ${index + 1}`}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 4 }}>
                {getVisibleMadeWithToolOptions(row, toolOptions).map((tool) => (
                  <SmallChip
                    key={`${row.id}-${tool.slug}`}
                    label={tool.label}
                    active={row.toolSlug === tool.slug || row.toolLabel === tool.label}
                    disabled={disabled}
                    onPress={() => onUpdate(row.id, {
                      toolLabel: tool.label,
                      toolSlug: tool.slug,
                      modelLabel: '',
                      modelSlug: '',
                      createTool: false,
                      createModel: false,
                    })}
                  />
                ))}
              </ScrollView>
              <ComposerInput
                value={row.toolLabel}
                onChangeText={(toolLabel) => onUpdate(row.id, {
                  toolLabel,
                  toolSlug: slugifyMobileValue(toolLabel) ?? '',
                  createTool: Boolean(toolLabel.trim() && !sourceTools.some((tool) => tool.label.toLowerCase() === toolLabel.trim().toLowerCase())),
                })}
                placeholder="Choose or search tool"
                editable={!disabled}
              />
            </FieldBlock>
            <FieldBlock label="Model">
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 4 }}>
                {(sourceTools.find((tool) => tool.slug === row.toolSlug || tool.label === row.toolLabel)?.models ?? []).map((model) => (
                  <SmallChip
                    key={`${row.id}-${model.slug}`}
                    label={model.label}
                    active={row.modelSlug === model.slug || row.modelLabel === model.label}
                    disabled={disabled}
                    onPress={() => onUpdate(row.id, {
                      modelLabel: model.label,
                      modelSlug: model.slug,
                      createModel: false,
                    })}
                  />
                ))}
              </ScrollView>
              <ComposerInput
                value={row.modelLabel}
                onChangeText={(modelLabel) => onUpdate(row.id, {
                  modelLabel,
                  modelSlug: slugifyMobileValue(modelLabel) ?? '',
                  createModel: Boolean(modelLabel.trim()),
                })}
                placeholder="Any model"
                editable={!disabled && Boolean(row.toolLabel.trim())}
              />
            </FieldBlock>
            {!disabled && rows.length > 1 ? (
              <SecondaryButton label="Remove tool" onPress={() => onRemove(row.id)} />
            ) : null}
          </View>
        ))}
        {!disabled && rows.length < 5 ? (
          <View style={{ alignSelf: 'flex-start' }}>
            <MiniAction label="Add tool" onPress={onAdd} />
          </View>
        ) : null}
      </View>
    </SurfaceSection>
  );
}

function getVisibleMadeWithToolOptions(row: PostComposerMadeWithRow, toolOptions: SourceToolOption[]) {
  const selectedTool = toolOptions.find((tool) => row.toolSlug === tool.slug || row.toolLabel === tool.label);
  const pinnedTools = toolOptions.filter((tool) => ['manual', 'other'].includes(tool.slug));
  const compactOptions = [selectedTool, ...toolOptions.slice(0, 5), ...pinnedTools].filter(Boolean) as SourceToolOption[];
  const seen = new Set<string>();

  return compactOptions.filter((tool) => {
    const key = tool.slug || tool.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getMadeWithToolOptions(sourceTools: SourceToolOption[]): SourceToolOption[] {
  const options = [
    ...sourceTools,
    ...POST_COMPOSER_SOURCE_OPTIONS.map((source) => ({
      ...source,
      models: [],
      supportedMediaKinds: ['image', 'video'] as Array<'image' | 'video'>,
    })),
  ];
  const seen = new Set<string>();

  return options.filter((tool) => {
    const key = tool.slug || tool.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  onPickImage,
  onPickVideo,
  onChooseGeneration,
  onCreateGeneration,
  onRemoveMedia,
  onMoveMedia,
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
  onPickImage: () => void;
  onPickVideo: () => void;
  onChooseGeneration: (item: GenerationListItem) => void;
  onCreateGeneration: () => void;
  onRemoveMedia: (id: string) => void;
  onMoveMedia: (id: string, direction: -1 | 1) => void;
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

      {draft.proofMode === 'text' ? (
        <ComposerInput
          value={draft.contentText}
          onChangeText={() => {}}
          placeholder="Write the post content..."
          multiline
          minHeight={150}
          editable={false}
        />
      ) : null}

      {draft.mode === 'upload' ? (
        <UploadContent
          draft={draft}
          isPicking={isPickingMedia}
          onPickImage={onPickImage}
          onPickVideo={onPickVideo}
          onRemoveMedia={onRemoveMedia}
          onMoveMedia={onMoveMedia}
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
  onChange,
}: {
  draft: PostComposerDraft;
  disabled: boolean;
  onChange: (patch: Partial<PostComposerDraft>) => void;
}) {
  return (
    <SurfaceSection
      eyebrow="Story"
      title="Story"
      accent="motion"
      style={COMPOSER_SECTION_STYLE}
    >
      <FieldBlock label="Title">
        <ComposerInput
          value={draft.title}
          onChangeText={(title) => onChange({ title })}
          placeholder={draft.proofMode === 'text' ? 'Title (optional)' : 'Give your post a title'}
          editable={!disabled}
        />
      </FieldBlock>
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
    </SurfaceSection>
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
}) {
  const resourceActive = draft.resource.accessMode !== 'none';

  return (
    <SurfaceSection
      eyebrow={draft.resource.accessMode === 'none' ? 'No unlock' : draft.resource.accessMode === 'paid' ? 'Paid unlock' : 'Free unlock'}
      title="Unlock"
      accent={draft.resource.accessMode === 'paid' ? 'commerce' : 'workflow'}
      style={COMPOSER_SECTION_STYLE}
    >
      {draft.mode === 'creation' && selectedGeneration ? (
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

      <SegmentedRow>
        {POST_COMPOSER_UNLOCK_OPTIONS.map((option) => (
          <Chip
            key={option.id}
            label={option.label === 'Paid' ? 'Paid ($)' : option.label}
            active={draft.resource.accessMode === option.id}
            onPress={() => {
              onResourceChange({ accessMode: option.id });
              if (option.id === 'none') onCreationPackageChange({ attachPromptResource: false });
            }}
            accent={option.id === 'paid' ? 'commerce' : option.id === 'free' ? 'workflow' : 'motion'}
          />
        ))}
      </SegmentedRow>

      <ReadinessRow label={packageStatus.label} body={packageStatus.body} state={packageStatus.state} />

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
          <ToggleRow
            label="Enable section layout"
            body="Organize resources into named sections."
            value={draft.resource.organizeSections}
            onValueChange={(organizeSections) => onResourceChange({ organizeSections })}
            accent="workflow"
          />
          {draft.resource.organizeSections ? (
            <View style={{ gap: appTheme.spacing.gap }}>
              {draft.resource.sections.map((section, index) => (
                <View key={section.id} style={{ gap: appTheme.spacing.compact }}>
                  <AppText variant="label" color="muted">{`Section ${index + 1}`}</AppText>
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
    </SurfaceSection>
  );
}

function PublishSection({
  draft,
  actions,
  canSubmit,
  publishReadiness,
  isPending,
  onDraftChange,
  onSubmit,
}: {
  draft: PostComposerDraft;
  actions: ReturnType<typeof getPostComposerPublishActions>;
  canSubmit: boolean;
  publishReadiness: ReturnType<typeof getPostComposerReadiness>[number];
  isPending: boolean;
  onDraftChange: (patch: Partial<PostComposerDraft>) => void;
  onSubmit: (visibility: PostComposerDraft['visibility']) => void;
}) {
  return (
    <SurfaceSection
      eyebrow="Visibility"
      title="Publish"
      accent="commerce"
      style={COMPOSER_SECTION_STYLE}
    >
      <FieldBlock label="Visibility">
        <SegmentedRow>
          {POST_COMPOSER_VISIBILITY_OPTIONS.map((option) => (
            <Chip
              key={option.id}
              label={option.label}
              active={draft.visibility === option.id}
              onPress={() => onDraftChange({ visibility: option.id })}
              accent={option.id === 'public' ? 'commerce' : 'motion'}
            />
          ))}
        </SegmentedRow>
      </FieldBlock>
      <ReadinessRow label={publishReadiness.label} body={publishReadiness.body} state={publishReadiness.state} />
      <View style={{ gap: appTheme.spacing.compact }}>
        {actions.map((action) => action.variant === 'primary' ? (
          <PrimaryButton
            key={action.id}
            label={action.label}
            loading={isPending}
            disabled={!canSubmit || action.disabled}
            onPress={() => onSubmit(action.visibility)}
            accent="commerce"
          />
        ) : (
          <SecondaryButton
            key={action.id}
            label={action.label}
            disabled={!canSubmit || action.disabled}
            onPress={() => onSubmit(action.visibility)}
          />
        ))}
      </View>
    </SurfaceSection>
  );
}

function ChecklistSection({ readiness }: { readiness: ReturnType<typeof getPostComposerReadiness> }) {
  return (
    <SurfaceSection
      eyebrow="Publish checklist"
      title="Checklist"
      accent="motion"
      style={COMPOSER_SECTION_STYLE}
    >
      {readiness.map((item) => (
        <ReadinessRow key={item.id} label={item.label} body={item.body} state={item.state} />
      ))}
    </SurfaceSection>
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

function UploadContent({
  draft,
  isPicking,
  onPickImage,
  onPickVideo,
  onRemoveMedia,
  onMoveMedia,
  disabled = false,
}: {
  draft: PostComposerDraft;
  isPicking: boolean;
  onPickImage: () => void;
  onPickVideo: () => void;
  onRemoveMedia: (id: string) => void;
  onMoveMedia: (id: string, direction: -1 | 1) => void;
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
            <View
              key={item.id}
              style={{
                width: 132,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: index === 0 ? `${appTheme.colors.image}aa` : appTheme.colors.border,
                backgroundColor: appTheme.colors.surfaceInset,
                overflow: 'hidden',
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
              </View>
              <View style={{ padding: 9, gap: 7 }}>
                <Text numberOfLines={1} style={{ color: '#fff', fontSize: 12, fontWeight: '900' }}>
                  {index === 0 ? 'Cover' : `Media ${index + 1}`}
                </Text>
                <Text numberOfLines={1} style={{ color: appTheme.colors.muted, fontSize: 11, fontWeight: '700' }}>
                  {item.name}
                </Text>
                {!disabled ? (
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    <MiniAction label="Left" disabled={index === 0} onPress={() => onMoveMedia(item.id, -1)} />
                    <MiniAction label="Right" disabled={index === draft.mediaItems.length - 1} onPress={() => onMoveMedia(item.id, 1)} />
                    <MiniAction label="Remove" onPress={() => onRemoveMedia(item.id)} />
                  </View>
                ) : null}
              </View>
            </View>
          ))}
        </ScrollView>
      ) : (
        <View
          style={{
            minHeight: 124,
            borderRadius: 16,
            borderWidth: 1,
            borderStyle: 'dashed',
            borderColor: appTheme.colors.border,
            backgroundColor: appTheme.colors.surfaceInset,
            alignItems: 'center',
            justifyContent: 'center',
            gap: appTheme.spacing.compact,
            padding: appTheme.spacing.card,
          }}
        >
          <ImageIcon size={30} color={appTheme.colors.muted} />
          <AppText variant="label" color="muted">Add media</AppText>
        </View>
      )}
      {!disabled ? (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {draft.mediaItems.length === 0 ? (
            <SecondaryPickButton icon={<ImageIcon size={18} color="#fff" />} label="Add media" loading={isPicking} onPress={onPickImage} />
          ) : (
            <SecondaryPickButton icon={<ImageIcon size={18} color="#fff" />} label="Add more" loading={isPicking} onPress={onPickImage} />
          )}
          <SecondaryPickButton icon={<Play size={18} color="#fff" />} label="Video" loading={isPicking} onPress={onPickVideo} />
        </View>
      ) : null}
    </View>
  );
}

function MiniAction({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
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

function PreviewPanel({ draft, selectedGeneration }: { draft: PostComposerDraft; selectedGeneration: GenerationListItem | null }) {
  const title = draft.title.trim() || 'Untitled post';
  const body = draft.mode === 'text' ? draft.contentText.trim() || draft.caption.trim() : draft.caption.trim();
  const statusLabel = getPostComposerPreviewStatusLabel(draft, selectedGeneration);
  const coverMedia = draft.mediaItems[0] ?? null;
  const mediaUrl = draft.mode === 'upload' ? coverMedia?.uri ?? draft.upload?.uri ?? null : selectedGeneration?.output_urls?.[0] ?? selectedGeneration?.output_url ?? null;
  const selectedGenerationKind = selectedGeneration ? getPublishGenerationMediaKind(selectedGeneration) : null;
  const generationPreviewUrl = selectedGeneration ? getGenerationPreviewImageUrl(selectedGeneration) : null;
  const isUploadImage = draft.mode === 'upload' && (coverMedia?.mediaKind === 'image' || draft.upload?.type.startsWith('image/'));
  const isGenerationImage = draft.mode !== 'upload' && selectedGenerationKind === 'image';
  const visualUrl = draft.mode === 'upload'
    ? isUploadImage ? coverMedia?.previewUrl ?? mediaUrl : null
    : selectedGenerationKind === 'video'
      ? generationPreviewUrl
      : mediaUrl;
  const showVideoOverlay = draft.mode !== 'text' && !isUploadImage && (selectedGenerationKind === 'video' || draft.upload?.type.startsWith('video/'));
  const hasResourcePackage = statusLabel !== 'No resource package configured.';

  return (
    <SurfaceSection
      eyebrow="Preview"
      title="Preview"
      accent="image"
      style={COMPOSER_SECTION_STYLE}
    >
      <View style={{ minHeight: 190, borderRadius: 20, overflow: 'hidden', backgroundColor: '#050506', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)' }}>
        {visualUrl && (isUploadImage || isGenerationImage || selectedGenerationKind === 'video') ? (
          <Image source={{ uri: visualUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
        ) : mediaUrl ? (
          <LinearGradient colors={['#111827', '#271233', '#080912']} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Play size={44} color="#fff" fill="#fff" />
          </LinearGradient>
        ) : (
          <LinearGradient colors={['#17131d', '#0b0c12', '#1d1020']} style={{ flex: 1, justifyContent: 'center', padding: 18, gap: 12 }}>
            <FileText size={28} color={appTheme.colors.motion} />
            <AppText variant="sectionTitle">{title}</AppText>
            {body ? <AppText variant="bodySm" color="textSecondary" numberOfLines={4}>{body}</AppText> : null}
          </LinearGradient>
        )}
        {visualUrl && showVideoOverlay ? (
          <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.16)' }}>
            <Play size={44} color="#fff" fill="#fff" />
          </View>
        ) : null}
        {mediaUrl ? (
          <View style={{ position: 'absolute', left: 12, right: 12, bottom: 12, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.62)', padding: 12, gap: 5 }}>
            <AppText variant="body" numberOfLines={1} style={{ fontWeight: '900' }}>{title}</AppText>
            {body ? <AppText variant="caption" color="textSecondary" numberOfLines={2}>{body}</AppText> : null}
          </View>
        ) : null}
      </View>
      <ReadinessRow
        label={hasResourcePackage ? 'Resource cue' : 'Post preview'}
        body={statusLabel}
        state={hasResourcePackage ? 'ready' : 'neutral'}
      />
    </SurfaceSection>
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
