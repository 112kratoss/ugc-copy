import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, router } from 'expo-router';
import { Check, FileText, ImageIcon, Lock, Play, Sparkles } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrimaryButton, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { formatRelativeTime } from '@/lib/home-view-model';
import { immersiveViewerHref } from '@/lib/immersive-preview-view-model';
import { pickMedia } from '@/lib/media';
import {
  buildCreatePostFormData,
  buildPublishGenerationPostPayload,
  getDefaultPostComposerDraft,
  getPublishGenerationMediaKind,
  getPublishGenerationSubtitle,
  getPublishGenerationTitle,
  getPublishableGenerations,
  POST_COMPOSER_CATEGORY_OPTIONS,
  POST_COMPOSER_MODES,
  POST_COMPOSER_SOURCE_OPTIONS,
  POST_COMPOSER_UNLOCK_OPTIONS,
  validatePostComposerDraft,
  type PostComposerCategory,
  type PostComposerDraft,
  type PostComposerMode,
} from '@/lib/post-new-view-model';
import { resolvedBottomInset } from '@/lib/safe-area';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { appTheme } from '@/lib/theme';
import type { GenerationListItem, PostResourceBundleAccessMode } from '@/lib/types';

export default function NewPostScreen() {
  const { user, isLoading: authLoading, api } = useAuth();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const bottomInset = resolvedBottomInset(insets.bottom);
  const tabBarMetrics = getMagicTabBarMetrics(width, bottomInset);
  const horizontalPadding = Math.min(width, 430) < 390 ? 16 : 18;
  const [draft, setDraft] = useState<PostComposerDraft>(() => getDefaultPostComposerDraft());
  const [message, setMessage] = useState<{ tone: 'danger' | 'success'; title: string; body?: string } | null>(null);
  const [isPickingMedia, setIsPickingMedia] = useState(false);

  const generationsQuery = useQuery({
    queryKey: ['post-new-generations', user?.id],
    enabled: Boolean(user),
    queryFn: () => api.listGenerations(true),
  });

  const publishableGenerations = useMemo(
    () => getPublishableGenerations(generationsQuery.data?.generations),
    [generationsQuery.data?.generations]
  );
  const selectedGeneration = publishableGenerations.find((item) => item.id === draft.selectedGenerationId) ?? null;
  const canSubmit = !isPickingMedia;

  const publishMutation = useMutation({
    mutationFn: async () => {
      const validation = validateCurrentDraft(draft, selectedGeneration);
      if (!validation.valid) {
        throw new Error(validation.message);
      }

      if (draft.mode === 'creation') {
        if (!selectedGeneration) throw new Error('Choose a finished creation before publishing.');
        return api.publishGeneration(buildPublishGenerationPostPayload(selectedGeneration, draft));
      }

      return api.createPost(buildCreatePostFormData(draft));
    },
    onSuccess: (response) => {
      setMessage({ tone: 'success', title: 'Posted', body: 'Your post is now live in your profile.' });
      void invalidatePostCaches(queryClient, user?.id);
      if (response.postId) {
        router.replace(immersiveViewerHref({ source: 'profile-posts', initialId: response.postId }) as never);
      }
    },
    onError: (error) => {
      setMessage({
        tone: 'danger',
        title: 'Could not publish',
        body: error instanceof Error ? error.message : 'Try again.',
      });
    },
  });

  if (authLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: '#03040d', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#d946ef" />
      </View>
    );
  }

  if (!user) {
    return <Redirect href="/auth" />;
  }

  const setMode = (mode: PostComposerMode) => {
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

  const chooseMedia = async (kind: 'image' | 'video') => {
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
    }));
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#03040d' }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1, backgroundColor: '#03040d' }}
        contentContainerStyle={{
          paddingHorizontal: horizontalPadding,
          paddingTop: 18,
          paddingBottom: tabBarMetrics.bottomInset + 42,
          gap: 14,
        }}
      >
        <PostIntro />

        {message ? (
          <StatusBlock tone={message.tone} title={message.title} body={message.body} />
        ) : null}

        <OrderedField step="1" label="Title">
          <ComposerInput
            value={draft.title}
            onChangeText={(title) => updateDraft({ title })}
            placeholder="Name the idea, media, or resource"
          />
        </OrderedField>

        <OrderedField step="2" label="Content">
          <SegmentedRow>
            {POST_COMPOSER_MODES.map((mode) => (
              <Chip
                key={mode.id}
                label={mode.label}
                active={draft.mode === mode.id}
                onPress={() => setMode(mode.id)}
              />
            ))}
          </SegmentedRow>
          {draft.mode === 'text' ? (
            <ComposerInput
              value={draft.contentText}
              onChangeText={(contentText) => updateDraft({ contentText, category: 'text' })}
              placeholder="Write the reusable idea, prompt, teardown, or update..."
              multiline
            />
          ) : null}
          {draft.mode === 'upload' ? (
            <UploadContent
              draft={draft}
              isPicking={isPickingMedia}
              onPickImage={() => chooseMedia('image')}
              onPickVideo={() => chooseMedia('video')}
            />
          ) : null}
          {draft.mode === 'creation' ? (
            <CreationContent
              items={publishableGenerations}
              selectedId={draft.selectedGenerationId}
              loading={generationsQuery.isLoading}
              error={generationsQuery.error}
              onSelect={chooseGeneration}
              onCreate={() => router.push('/(tabs)/creator' as never)}
            />
          ) : null}
        </OrderedField>

        <OrderedField step="3" label="Caption / Body">
          <ComposerInput
            value={draft.caption}
            onChangeText={(caption) => updateDraft({ caption })}
            placeholder={draft.mode === 'text' ? 'Optional extra caption' : 'What should people know about this post?'}
            multiline
            minHeight={92}
          />
        </OrderedField>

        <View style={{ flexDirection: 'row', gap: 10 }}>
          <OrderedField step="4" label="Source" compact>
            <SegmentedRow wrap>
              {POST_COMPOSER_SOURCE_OPTIONS.map((source) => (
                <SmallChip
                  key={source.slug}
                  label={source.label}
                  active={draft.sourceToolSlug === source.slug}
                  onPress={() => updateDraft({ sourceTool: source.label, sourceToolSlug: source.slug })}
                />
              ))}
            </SegmentedRow>
          </OrderedField>
          <OrderedField step="5" label="Category" compact>
            <SegmentedRow wrap>
              {POST_COMPOSER_CATEGORY_OPTIONS.filter((item) => draft.mode === 'text' ? item.id === 'text' : item.id !== 'text').map((category) => (
                <SmallChip
                  key={category.id}
                  label={category.label}
                  active={draft.category === category.id}
                  onPress={() => updateDraft({ category: category.id })}
                />
              ))}
            </SegmentedRow>
          </OrderedField>
        </View>

        <OrderedField step="6" label="Unlockables">
          <SegmentedRow>
            {POST_COMPOSER_UNLOCK_OPTIONS.map((option) => (
              <Chip
                key={option.id}
                label={option.label}
                active={draft.resource.accessMode === option.id}
                onPress={() => updateResource({ accessMode: option.id })}
              />
            ))}
          </SegmentedRow>
          {draft.resource.accessMode !== 'none' ? (
            <UnlockFields
              accessMode={draft.resource.accessMode}
              resource={draft.resource}
              onChange={updateResource}
            />
          ) : (
            <Text selectable style={{ color: appTheme.colors.muted, fontSize: 13, lineHeight: 19 }}>
              Publish a normal community post. You can add free or paid resources when the post has reusable value.
            </Text>
          )}
        </OrderedField>

        <PreviewPanel draft={draft} selectedGeneration={selectedGeneration} />

        <PrimaryButton
          label={publishMutation.isPending ? 'Publishing' : 'Post now'}
          loading={publishMutation.isPending}
          disabled={!canSubmit || publishMutation.isPending}
          onPress={() => {
            setMessage(null);
            publishMutation.mutate();
          }}
          accent="motion"
        />
      </ScrollView>
    </View>
  );
}

function PostIntro() {
  return (
    <View style={{ gap: 7 }}>
      <Text selectable style={{ color: '#fff', fontSize: 29, lineHeight: 34, fontWeight: '900' }}>Post</Text>
      <Text selectable style={{ color: appTheme.colors.muted, fontSize: 14, lineHeight: 20, fontWeight: '700' }}>
        Title, content, caption, source, category, unlockables, then publish.
      </Text>
    </View>
  );
}

function OrderedField({
  step,
  label,
  children,
  compact,
}: {
  step: string;
  label: string;
  children: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <View
      style={{
        flex: compact ? 1 : undefined,
        gap: 10,
        borderRadius: 22,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.10)',
        backgroundColor: 'rgba(255,255,255,0.055)',
        padding: 13,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(102,255,69,0.18)' }}>
          <Text style={{ color: '#66ff45', fontSize: 11, fontWeight: '900' }}>{step}</Text>
        </View>
        <Text selectable style={{ color: appTheme.colors.muted, fontSize: 11, fontWeight: '900', textTransform: 'uppercase' }}>
          {label}
        </Text>
      </View>
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
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  multiline?: boolean;
  minHeight?: number;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor="rgba(255,255,255,0.36)"
      multiline={multiline}
      textAlignVertical={multiline ? 'top' : 'center'}
      style={{
        minHeight: multiline ? minHeight ?? 128 : 48,
        borderRadius: 16,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.10)',
        backgroundColor: 'rgba(0,0,0,0.28)',
        color: '#fff',
        fontSize: 15,
        lineHeight: 21,
        fontWeight: '700',
        paddingHorizontal: 13,
        paddingVertical: 11,
      }}
    />
  );
}

function SegmentedRow({ children, wrap }: { children: React.ReactNode; wrap?: boolean }) {
  return <View style={{ flexDirection: 'row', flexWrap: wrap ? 'wrap' : 'nowrap', gap: 8 }}>{children}</View>;
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: active ? 'rgba(217,70,239,0.72)' : 'rgba(255,255,255,0.11)',
        backgroundColor: active ? 'rgba(217,70,239,0.28)' : 'rgba(255,255,255,0.07)',
        opacity: pressed ? 0.75 : 1,
        paddingHorizontal: 10,
      })}
    >
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.76} style={{ color: active ? '#fff' : appTheme.colors.muted, fontSize: 13, fontWeight: '900' }}>
        {label}
      </Text>
    </Pressable>
  );
}

function SmallChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: active ? 'rgba(102,255,69,0.48)' : 'rgba(255,255,255,0.10)',
        backgroundColor: active ? 'rgba(102,255,69,0.13)' : 'rgba(255,255,255,0.06)',
        opacity: pressed ? 0.75 : 1,
        paddingHorizontal: 9,
      })}
    >
      <Text numberOfLines={1} style={{ color: active ? '#66ff45' : appTheme.colors.muted, fontSize: 11, fontWeight: '900' }}>
        {label}
      </Text>
    </Pressable>
  );
}

function UploadContent({
  draft,
  isPicking,
  onPickImage,
  onPickVideo,
}: {
  draft: PostComposerDraft;
  isPicking: boolean;
  onPickImage: () => void;
  onPickVideo: () => void;
}) {
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
  onSelect,
  onCreate,
}: {
  items: GenerationListItem[];
  selectedId: string | null;
  loading: boolean;
  error: unknown;
  onSelect: (item: GenerationListItem) => void;
  onCreate: () => void;
}) {
  if (loading) {
    return <ActivityIndicator color="#d946ef" />;
  }

  if (error) {
    return <StatusBlock tone="danger" title="Could not load creations" body={error instanceof Error ? error.message : 'Try again.'} />;
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
      {items.map((item) => (
        <CreationCard key={item.id} item={item} selected={selectedId === item.id} onPress={() => onSelect(item)} />
      ))}
    </ScrollView>
  );
}

function CreationCard({ item, selected, onPress }: { item: GenerationListItem; selected: boolean; onPress: () => void }) {
  const mediaUrl = item.output_urls?.[0] ?? item.output_url ?? null;
  const mediaKind = getPublishGenerationMediaKind(item);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 150,
        borderRadius: 18,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: selected ? '#66ff45' : 'rgba(255,255,255,0.10)',
        backgroundColor: 'rgba(255,255,255,0.06)',
        opacity: pressed ? 0.78 : 1,
      })}
    >
      <View style={{ height: 148, backgroundColor: '#080912' }}>
        {mediaUrl && mediaKind === 'image' ? (
          <Image source={{ uri: mediaUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
        ) : (
          <LinearGradient colors={mediaKind === 'video' ? ['#111827', '#271233', '#080912'] : ['#121226', '#171123', '#080912']} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            {mediaKind === 'video' ? <Play size={31} color="#fff" fill="#fff" /> : <Sparkles size={31} color="#fff" />}
          </LinearGradient>
        )}
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
  const mediaUrl = draft.mode === 'upload' ? draft.upload?.uri ?? null : selectedGeneration?.output_urls?.[0] ?? selectedGeneration?.output_url ?? null;
  const isImage = draft.mode === 'upload'
    ? draft.upload?.type.startsWith('image/')
    : selectedGeneration ? getPublishGenerationMediaKind(selectedGeneration) === 'image' : false;

  return (
    <OrderedField step="7" label="Preview">
      <View style={{ minHeight: 190, borderRadius: 20, overflow: 'hidden', backgroundColor: '#050506', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)' }}>
        {mediaUrl && isImage ? (
          <Image source={{ uri: mediaUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
        ) : mediaUrl ? (
          <LinearGradient colors={['#111827', '#271233', '#080912']} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Play size={44} color="#fff" fill="#fff" />
          </LinearGradient>
        ) : (
          <LinearGradient colors={['#17131d', '#0b0c12', '#1d1020']} style={{ flex: 1, justifyContent: 'center', padding: 18, gap: 12 }}>
            <FileText size={28} color="#d946ef" />
            <Text selectable style={{ color: '#fff', fontSize: 22, lineHeight: 27, fontWeight: '900' }}>{title}</Text>
            {body ? <Text selectable numberOfLines={4} style={{ color: 'rgba(255,255,255,0.76)', fontSize: 14, lineHeight: 20 }}>{body}</Text> : null}
          </LinearGradient>
        )}
        {mediaUrl ? (
          <View style={{ position: 'absolute', left: 12, right: 12, bottom: 12, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.62)', padding: 12, gap: 5 }}>
            <Text selectable numberOfLines={1} style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>{title}</Text>
            {body ? <Text selectable numberOfLines={2} style={{ color: 'rgba(255,255,255,0.72)', fontSize: 12, lineHeight: 17 }}>{body}</Text> : null}
          </View>
        ) : null}
      </View>
      <Text selectable style={{ color: draft.resource.accessMode === 'none' ? appTheme.colors.muted : '#66ff45', fontSize: 13, lineHeight: 19, fontWeight: '800' }}>
        {draft.resource.accessMode === 'none' ? 'No unlock attached.' : `${draft.resource.accessMode === 'paid' ? 'Paid' : 'Free'} unlock will appear in post details.`}
      </Text>
    </OrderedField>
  );
}

function validateCurrentDraft(draft: PostComposerDraft, selectedGeneration: GenerationListItem | null) {
  const result = validatePostComposerDraft(draft);
  if (!result.valid) return result;
  if (draft.mode === 'creation' && !selectedGeneration) {
    return { valid: false, message: 'Choose a finished creation before publishing.' };
  }
  return result;
}

function generationToPostCategory(item: GenerationListItem): PostComposerCategory {
  if (item.category === 'video' || item.category === 'motion' || item.category === 'ugc-ad') return item.category;
  return 'image';
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
