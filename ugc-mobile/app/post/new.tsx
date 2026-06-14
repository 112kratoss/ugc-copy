import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { Check, FileText, ImageIcon, Lock, PackageCheck, Play, Sparkles } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText, BottomActionDock, ChoiceChip, DisclosureSection, PrimaryButton, ReadinessRow, SecondaryButton, StatusBlock, SurfaceSection, ToggleRow } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { formatRelativeTime } from '@/lib/home-view-model';
import { immersiveViewerHref } from '@/lib/immersive-preview-view-model';
import { pickMedia } from '@/lib/media';
import {
  buildCreatePostFormData,
  buildPublishGenerationPostPayload,
  buildUpdatePostPayload,
  applyCreationPromptResource,
  getDefaultPostComposerDraft,
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
  POST_COMPOSER_MODES,
  POST_COMPOSER_SOURCE_OPTIONS,
  POST_COMPOSER_UNLOCK_OPTIONS,
  POST_COMPOSER_VISIBILITY_OPTIONS,
  validatePostComposerDraft,
  hasGenerationReferences,
  type PostComposerCategory,
  type PostComposerDraft,
  type PostComposerMode,
} from '@/lib/post-new-view-model';
import { resolvedBottomInset } from '@/lib/safe-area';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { appTheme, type ToolAccent } from '@/lib/theme';
import type { GenerationListItem, PostResourceBundleAccessMode } from '@/lib/types';

const getDefaultResourceDraft = () => ({
  accessMode: 'none' as const,
  promptText: '',
  notesMarkdown: '',
  workflowShareUrl: '',
  attachmentUrl: '',
  attachmentLabel: '',
  allowRemix: false,
  summary: '',
  previewText: '',
  priceUsd: '9',
});

export default function NewPostScreen() {
  const { user, isLoading: authLoading, api } = useAuth();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ generationId?: string; postId?: string }>();
  const generationId = params.generationId;
  const postId = params.postId;

  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const bottomInset = resolvedBottomInset(insets.bottom);
  const tabBarMetrics = getMagicTabBarMetrics(width, bottomInset);
  const horizontalPadding = Math.min(width, 430) < 390 ? 16 : 18;
  const [draft, setDraft] = useState<PostComposerDraft>(() => getDefaultPostComposerDraft());
  const [message, setMessage] = useState<{ tone: 'danger' | 'success'; title: string; body?: string } | null>(null);
  const [isPickingMedia, setIsPickingMedia] = useState(false);
  const [hasPrefilledEdit, setHasPrefilledEdit] = useState(false);
  const [postSettingsExpanded, setPostSettingsExpanded] = useState(false);

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

  const publishableGenerations = useMemo(
    () => getPublishableGenerations(generationsQuery.data?.generations),
    [generationsQuery.data?.generations]
  );
  const allGenerations = generationsQuery.data?.generations ?? [];
  const selectedGeneration = allGenerations.find((item) => item.id === draft.selectedGenerationId) ?? null;
  const isGenerationBacked = Boolean(postQuery.data?.post?.generationId) || draft.mode === 'creation';
  const isEditMode = Boolean(postId);
  const isFieldsLocked = isEditMode && isGenerationBacked;
  const canSubmit = !isPickingMedia && (!isEditMode || !postQuery.isLoading);
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
            selectedGenerationId: found.id,
            title: current.title || found.title || found.prompt || 'Untitled creation',
            contentText: '',
            sourceTool: 'Magicbooklet',
            sourceToolSlug: 'magicbooklet',
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
        title: post.title || '',
        contentText: mode === 'text' ? post.body || '' : '',
        caption: mode === 'text' ? post.description || '' : post.body || '',
        sourceTool: post.sourceTool || 'Manual',
        sourceToolSlug: post.sourceToolSlug || 'manual',
        category: post.category || 'image',
        visibility: (post.visibility as any) || 'public',
        selectedGenerationId: post.generationId || null,
        upload: post.mediaUrl ? {
          uri: post.mediaUrl,
          name: post.title || 'media',
          type: post.mediaKind === 'video' ? 'video/mp4' : 'image/jpeg',
        } : null,
        creationPackage: getDefaultPostComposerDraft().creationPackage,
        resource: resourceBundleInput ? {
          accessMode: resourceBundleInput.accessMode || 'none',
          promptText: resourceBundleInput.resources?.promptText || '',
          notesMarkdown: resourceBundleInput.resources?.notesMarkdown || '',
          workflowShareUrl: resourceBundleInput.resources?.workflowShareUrl || '',
          attachmentUrl: resourceBundleInput.resources?.attachments?.[0]?.url || resourceBundleInput.resources?.attachments?.[0]?.storagePath || '',
          attachmentLabel: resourceBundleInput.resources?.attachments?.[0]?.label || '',
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
    mutationFn: async () => {
      const validation = validateCurrentDraft(draft, selectedGeneration, isEditMode && isGenerationBacked);
      if (!validation.valid) {
        throw new Error(validation.message);
      }

      if (postId) {
        const isGen = Boolean(postQuery.data?.post?.generationId);
        const payload = buildUpdatePostPayload(isGen, draft);
        return api.updatePost(postId, payload);
      }

      if (draft.mode === 'creation') {
        if (!selectedGeneration) throw new Error('Choose a finished creation before publishing.');
        return api.publishGeneration(buildPublishGenerationPostPayload(selectedGeneration, draft));
      }

      return api.createPost(buildCreatePostFormData(draft));
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
      category: mode === 'text' ? 'text' : mode === 'creation' ? current.category === 'text' ? 'image' : current.category : current.category === 'text' ? 'image' : current.category,
      sourceTool: mode === 'creation' ? 'Magicbooklet' : mode === 'text' ? 'Manual' : current.sourceTool === 'Manual' ? 'Other' : current.sourceTool,
      sourceToolSlug: mode === 'creation' ? 'magicbooklet' : mode === 'text' ? 'manual' : current.sourceToolSlug === 'manual' ? 'other' : current.sourceToolSlug,
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
      const picked = await pickMedia(kind);
      if (!picked) return;
      setDraft((current) => ({
        ...current,
        mode: 'upload',
        category: kind === 'video' ? 'video' : 'image',
        upload: {
          uri: picked.uri,
          name: picked.fileName ?? `${Date.now()}.${kind === 'video' ? 'mp4' : 'jpg'}`,
          type: picked.mimeType ?? (kind === 'video' ? 'video/mp4' : 'image/jpeg'),
        },
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
      selectedGenerationId: item.id,
      title: current.title.trim() ? current.title : getPublishGenerationTitle(item),
      contentText: '',
      sourceTool: 'Magicbooklet',
      sourceToolSlug: 'magicbooklet',
      category,
      creationPackage: getDefaultPostComposerDraft().creationPackage,
    }));
  };

  const publishLabel = getPostComposerSubmitLabel({
    visibility: draft.visibility,
    isEditMode,
    isPending: publishMutation.isPending,
  });
  const publishReadiness = readiness.find((item) => item.id === 'publish') ?? readiness[readiness.length - 1];

  return (
    <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1, backgroundColor: appTheme.colors.background }}
        contentContainerStyle={{
          paddingHorizontal: horizontalPadding,
          paddingTop: 18,
          paddingBottom: tabBarMetrics.bottomInset + 150,
          gap: 14,
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

        <SurfaceSection
          eyebrow="Public post"
          title="Public post"
          body={sectionSummary.publicPost}
          accent="image"
        >
          <FieldBlock label="Title">
            <ComposerInput
              value={draft.title}
              onChangeText={(title) => updateDraft({ title })}
              placeholder="Name the idea, media, or resource"
              editable={!isFieldsLocked}
            />
          </FieldBlock>

          {!selectedGeneration ? (
            <FieldBlock label="Content">
              <SegmentedRow>
                {POST_COMPOSER_MODES.map((mode) => (
                  <Chip
                    key={mode.id}
                    label={mode.label}
                    active={draft.mode === mode.id}
                    onPress={() => setMode(mode.id)}
                    disabled={isFieldsLocked}
                  />
                ))}
              </SegmentedRow>
              {draft.mode === 'text' ? (
                <ComposerInput
                  value={draft.contentText}
                  onChangeText={(contentText) => updateDraft({ contentText, category: 'text' })}
                  placeholder="Write the reusable idea, prompt, teardown, or update..."
                  multiline
                  editable={!isFieldsLocked}
                />
              ) : null}
              {draft.mode === 'upload' ? (
                <UploadContent
                  draft={draft}
                  isPicking={isPickingMedia}
                  onPickImage={() => chooseMedia('image')}
                  onPickVideo={() => chooseMedia('video')}
                  disabled={isFieldsLocked}
                />
              ) : null}
              {draft.mode === 'creation' ? (
                <CreationContent
                  items={publishableGenerations}
                  selectedId={draft.selectedGenerationId}
                  loading={generationsQuery.isLoading}
                  error={generationsQuery.error}
                  visibleItems={isFieldsLocked ? allGenerations : publishableGenerations}
                  onSelect={chooseGeneration}
                  onCreate={() => router.push('/(tabs)/creator' as never)}
                  disabled={isFieldsLocked}
                />
              ) : null}
            </FieldBlock>
          ) : null}

          <FieldBlock label="Caption / body">
            <ComposerInput
              value={draft.caption}
              onChangeText={(caption) => updateDraft({ caption })}
              placeholder={draft.mode === 'text' ? 'Optional extra caption' : 'What should people know about this post?'}
              multiline
              minHeight={92}
              editable={!isFieldsLocked}
            />
          </FieldBlock>

          <FieldBlock label="Visibility">
            <SegmentedRow>
              {POST_COMPOSER_VISIBILITY_OPTIONS.map((option) => (
                <Chip
                  key={option.id}
                  label={option.label}
                  active={draft.visibility === option.id}
                  onPress={() => updateDraft({ visibility: option.id })}
                />
              ))}
            </SegmentedRow>
            <AppText variant="bodySm" color="muted">
              {POST_COMPOSER_VISIBILITY_OPTIONS.find((option) => option.id === draft.visibility)?.body ?? 'Choose who can see this post.'}
            </AppText>
          </FieldBlock>
        </SurfaceSection>

        <DisclosureSection
          title="Post settings"
          body={sectionSummary.postSettings}
          accent="workflow"
          expanded={postSettingsExpanded}
          onToggle={() => setPostSettingsExpanded((expanded) => !expanded)}
        >
          <View style={{ flexDirection: 'row', gap: appTheme.spacing.gap }}>
            <FieldBlock label="Source" compact>
              <SegmentedRow wrap>
                {POST_COMPOSER_SOURCE_OPTIONS.map((source) => (
                  <SmallChip
                    key={source.slug}
                    label={source.label}
                    active={draft.sourceToolSlug === source.slug}
                    onPress={() => updateDraft({ sourceTool: source.label, sourceToolSlug: source.slug })}
                    disabled={isFieldsLocked}
                  />
                ))}
              </SegmentedRow>
            </FieldBlock>
            <FieldBlock label="Category" compact>
              <SegmentedRow wrap>
                {POST_COMPOSER_CATEGORY_OPTIONS.filter((item) => draft.mode === 'text' ? item.id === 'text' : item.id !== 'text').map((category) => (
                  <SmallChip
                    key={category.id}
                    label={category.label}
                    active={draft.category === category.id}
                    onPress={() => updateDraft({ category: category.id })}
                    disabled={isFieldsLocked}
                  />
                ))}
              </SegmentedRow>
            </FieldBlock>
          </View>
        </DisclosureSection>

        <SurfaceSection
          eyebrow="Package"
          title="Resource package"
          body={sectionSummary.resourcePackage}
          accent={draft.resource.accessMode === 'paid' ? 'commerce' : 'workflow'}
        >
          {draft.mode === 'creation' && selectedGeneration ? (
            <View style={{ gap: appTheme.spacing.compact }}>
              {hasGenerationReferences(selectedGeneration) ? (
                <ToggleRow
                  label="Attach creation references"
                  body="Include the saved input media in post details."
                  value={draft.creationPackage.attachGenerationReferences}
                  onValueChange={(attachGenerationReferences) => updateCreationPackage({ attachGenerationReferences })}
                  accent="image"
                />
              ) : null}
              <ToggleRow
                label="Use exact prompt as resource"
                body="Turn the generation prompt into a free resource package."
                value={draft.creationPackage.attachPromptResource}
                onValueChange={togglePromptResource}
                accent="workflow"
                disabled={!selectedGeneration.prompt?.trim()}
              />
            </View>
          ) : null}
          <SegmentedRow>
            {POST_COMPOSER_UNLOCK_OPTIONS.map((option) => (
              <Chip
                  key={option.id}
                  label={option.label}
                  active={draft.resource.accessMode === option.id}
                  onPress={() => {
                    updateResource({ accessMode: option.id });
                    if (option.id === 'none') updateCreationPackage({ attachPromptResource: false });
                  }}
                  accent={option.id === 'paid' ? 'commerce' : option.id === 'free' ? 'workflow' : 'motion'}
                />
              ))}
          </SegmentedRow>
          {draft.resource.accessMode !== 'none' ? (
            <>
              <ReadinessRow
                label={packageStatus.label}
                body={packageStatus.body}
                state={packageStatus.state}
              />
              {draft.visibility !== 'public' ? (
                <ReadinessRow
                  label="Draft package"
                  body="This package stays quieter until the post is public."
                  state="warning"
                />
              ) : null}
              <UnlockFields
                accessMode={draft.resource.accessMode}
                resource={draft.resource}
                onChange={updateResource}
              />
            </>
          ) : (
            <View style={{ gap: appTheme.spacing.compact }}>
              <AppText variant="bodySm" color="muted">
                Publish a normal community post. Add free or paid resources only when this post has reusable value.
              </AppText>
              <ReadinessRow
                label={packageStatus.label}
                body={packageStatus.body}
                state={packageStatus.state}
              />
            </View>
          )}
        </SurfaceSection>

        <PreviewPanel draft={draft} selectedGeneration={selectedGeneration} />
      </ScrollView>
      <BottomActionDock
        title={isEditMode ? 'Save changes' : 'Ready to publish'}
        body={publishReadiness?.body ?? 'Complete the required fields before publishing.'}
        accent="motion"
        style={{
          position: 'absolute',
          left: horizontalPadding,
          right: horizontalPadding,
          bottom: bottomInset + 12,
        }}
      >
        {readiness.slice(0, 2).map((item) => (
          <ReadinessRow key={item.id} label={item.label} body={item.body} state={item.state} />
        ))}
        <PrimaryButton
          label={publishLabel}
          loading={publishMutation.isPending}
          disabled={!canSubmit || publishMutation.isPending}
          onPress={() => {
            setMessage(null);
            publishMutation.mutate();
          }}
          accent="motion"
        />
      </BottomActionDock>
    </View>
  );
}

function PostIntro({ isEdit, isGenerationBacked }: { isEdit: boolean; isGenerationBacked: boolean }) {
  return (
    <SurfaceSection
      eyebrow={isEdit ? 'Composer' : 'Guided composer'}
      title={isEdit ? 'Edit Post' : 'Post to Feed'}
      body={isEdit
        ? isGenerationBacked
          ? 'This post is backed by a creation. Title, category, source, and media cannot be changed.'
          : 'Update your post details below.'
        : 'Publish media, prompts, or reusable unlockables into the feed. One page, clear sections, quick publish.'}
      accent="motion"
    />
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
      body={`${getPublishGenerationSubtitle(item)} · Configure post settings, references, and resources below.`}
      accent="motion"
      action={!disabled ? <SecondaryButton label="Change creation" onPress={onChange} /> : null}
    >
      <View
        style={{
          minHeight: 210,
          borderRadius: appTheme.radii.xl,
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
        <View style={{ position: 'absolute', left: 12, right: 12, bottom: 12, borderRadius: appTheme.radii.lg, backgroundColor: 'rgba(0,0,0,0.62)', padding: appTheme.spacing.gap, gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact }}>
            <PackageCheck size={17} color={appTheme.colors.success} />
            <AppText variant="label" color="text" numberOfLines={1}>Creation selected</AppText>
          </View>
          <AppText variant="caption" color="textSecondary" numberOfLines={2}>
            Normal post by default. Turn on references or resources only if you want a package.
          </AppText>
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
        minHeight: multiline ? minHeight ?? 128 : 48,
        borderRadius: appTheme.radii.md,
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
  disabled = false,
}: {
  draft: PostComposerDraft;
  isPicking: boolean;
  onPickImage: () => void;
  onPickVideo: () => void;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <View style={{ gap: 10 }}>
        {draft.upload ? (
          <View style={{ height: 190, borderRadius: 18, overflow: 'hidden', backgroundColor: '#080912', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)', opacity: 0.8 }}>
            {draft.upload.type.startsWith('image/') ? (
              <Image source={{ uri: draft.upload.uri }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
            ) : (
              <LinearGradient colors={['#111827', '#271233', '#080912']} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Play size={42} color="#fff" fill="#fff" />
              </LinearGradient>
            )}
            <View style={{ position: 'absolute', left: 10, right: 10, bottom: 10, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.58)', padding: 10 }}>
              <Text numberOfLines={1} style={{ color: '#fff', fontSize: 12, fontWeight: '900' }}>{draft.upload.name}</Text>
            </View>
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      {draft.upload ? (
        <View style={{ height: 190, borderRadius: 18, overflow: 'hidden', backgroundColor: '#080912', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)' }}>
          {draft.upload.type.startsWith('image/') ? (
            <Image source={{ uri: draft.upload.uri }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
          ) : (
            <LinearGradient colors={['#111827', '#271233', '#080912']} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <Play size={42} color="#fff" fill="#fff" />
            </LinearGradient>
          )}
          <View style={{ position: 'absolute', left: 10, right: 10, bottom: 10, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.58)', padding: 10 }}>
            <Text numberOfLines={1} style={{ color: '#fff', fontSize: 12, fontWeight: '900' }}>{draft.upload.name}</Text>
          </View>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <SecondaryPickButton icon={<ImageIcon size={18} color="#fff" />} label="Image" loading={isPicking} onPress={onPickImage} />
        <SecondaryPickButton icon={<Play size={18} color="#fff" />} label="Video" loading={isPicking} onPress={onPickVideo} />
      </View>
    </View>
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
}: {
  accessMode: PostResourceBundleAccessMode;
  resource: PostComposerDraft['resource'];
  onChange: (patch: Partial<PostComposerDraft['resource']>) => void;
}) {
  return (
    <View style={{ gap: 10 }}>
      <ComposerInput value={resource.previewText} onChangeText={(previewText) => onChange({ previewText })} placeholder="Buyer preview: what is inside the unlock?" minHeight={64} multiline />
      {accessMode === 'paid' ? (
        <ComposerInput value={resource.priceUsd} onChangeText={(priceUsd) => onChange({ priceUsd })} placeholder="Price in USD, e.g. 9" />
      ) : null}
      <ComposerInput value={resource.promptText} onChangeText={(promptText) => onChange({ promptText })} placeholder="Exact prompt or prompt pack" minHeight={80} multiline />
      <ComposerInput value={resource.workflowShareUrl} onChangeText={(workflowShareUrl) => onChange({ workflowShareUrl })} placeholder="Workflow/setup URL" />
      <ComposerInput value={resource.notesMarkdown} onChangeText={(notesMarkdown) => onChange({ notesMarkdown })} placeholder="Notes, steps, or usage guide" minHeight={84} multiline />
      <ComposerInput value={resource.attachmentUrl} onChangeText={(attachmentUrl) => onChange({ attachmentUrl })} placeholder="File or reference link" />
      {resource.attachmentUrl.trim() ? (
        <ComposerInput value={resource.attachmentLabel} onChangeText={(attachmentLabel) => onChange({ attachmentLabel })} placeholder="Attachment label" />
      ) : null}
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
    </View>
  );
}

function PreviewPanel({ draft, selectedGeneration }: { draft: PostComposerDraft; selectedGeneration: GenerationListItem | null }) {
  const title = draft.title.trim() || 'Untitled post';
  const body = draft.mode === 'text' ? draft.contentText.trim() || draft.caption.trim() : draft.caption.trim();
  const statusLabel = getPostComposerPreviewStatusLabel(draft, selectedGeneration);
  const mediaUrl = draft.mode === 'upload' ? draft.upload?.uri ?? null : selectedGeneration?.output_urls?.[0] ?? selectedGeneration?.output_url ?? null;
  const selectedGenerationKind = selectedGeneration ? getPublishGenerationMediaKind(selectedGeneration) : null;
  const generationPreviewUrl = selectedGeneration ? getGenerationPreviewImageUrl(selectedGeneration) : null;
  const isUploadImage = draft.mode === 'upload' && draft.upload?.type.startsWith('image/');
  const isGenerationImage = draft.mode !== 'upload' && selectedGenerationKind === 'image';
  const visualUrl = draft.mode === 'upload'
    ? isUploadImage ? mediaUrl : null
    : selectedGenerationKind === 'video'
      ? generationPreviewUrl
      : mediaUrl;
  const showVideoOverlay = draft.mode !== 'text' && !isUploadImage && (selectedGenerationKind === 'video' || draft.upload?.type.startsWith('video/'));
  const hasResourcePackage = statusLabel !== 'No resource package configured.';

  return (
    <SurfaceSection
      eyebrow="Preview"
      title="How the post will read"
      body="Check the public card and the unlock cue before publishing."
      accent="image"
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
        label={hasResourcePackage ? 'Resource cue' : 'Public post'}
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
