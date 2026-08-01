import { useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useNavigation, usePreventRemove } from '@react-navigation/native';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import type { ImagePickerAsset } from 'expo-image-picker';
import { ArrowLeft, Check, ChevronDown, ChevronRight, FileText, Globe2, ImageIcon, Link2, Lock, Package, Play, Plus, Sparkles, Trash2, Upload, X } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  findNodeHandle,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type TextInputProps,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText, ChoiceChip, PrimaryButton, ReadinessRow, SecondaryButton, StatusBlock, SurfaceSection, ToggleRow } from '@/components/ui';
import { StableMediaImage } from '@/components/media-preview';
import { useAuth } from '@/lib/auth';
import { truncateInfiniteDataToFirstPage } from '@/lib/profile-media-query';
import { pickMediaList, pickResourceDocument, uploadPickedMedia } from '@/lib/media';
import {
  clearPersistedPostComposerDraft,
  getPostComposerDraftSignature,
  getPostComposerDraftStorageId,
  isPostComposerDraftMeaningful,
  loadPersistedPostComposerDraft,
  persistPostComposerDraft,
} from '@/lib/post-composer-draft-resume';
import {
  buildPostComposerMediaItemsPayload,
  buildCreatePostFormData,
  buildOptimisticOwnerPostListItem,
  buildPublishGenerationPostPayload,
  buildUpdatePostPayload,
  applyCreationPromptResource,
  createPostComposerResourceCard,
  createMadeWithRow,
  getDefaultPostComposerDraft,
  getPostComposerDetailErrors,
  getPostComposerPublishActions,
  getPostComposerPackageStatus,
  getPostComposerPriceTokens,
  getPostComposerResourceCardErrors,
  getPostComposerSubmitLabel,
  getExplicitPublishGeneration,
  getPublishGenerationMediaKind,
  getPublishGenerationTitle,
  BODY_MAX_LENGTH,
  hydratePostComposerResourceCards,
  isTemplateGeneration,
  isPostComposerResourceCardReady,
  POST_COMPOSER_CATEGORY_OPTIONS,
  POST_COMPOSER_RESOURCE_KIND_OPTIONS,
  POST_COMPOSER_RESOURCE_CARD_OPTIONS,
  POST_COMPOSER_SOURCE_OPTIONS,
  POST_COMPOSER_UNLOCK_OPTIONS,
  validatePostComposerDraft,
  hasGenerationReferences,
  upsertOptimisticOwnerPostInfiniteData,
  type PostComposerDraft,
  type PostComposerDetailErrors,
  type PostComposerDetailField,
  type PostComposerMadeWithRow,
  type PostComposerMediaItem,
  type PostComposerMode,
  type PostComposerResourceCardDraft,
  type PostComposerResourceCardType,
  type PostComposerValidationResult,
} from '@/lib/post-new-view-model';
import { resolvedBottomInset } from '@/lib/safe-area';
import { appTheme, type ToolAccent } from '@/lib/theme';
import { isUploadCancelledError, runWeightedUploadQueue } from '@/lib/upload-file';
import type { GenerationListItem, OwnerPostsResponse, PostResourceAttachment, PostResourceBundleAccessMode, SourceToolOption } from '@/lib/types';

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
  cards: [],
  allowRemix: false,
  summary: '',
  previewText: '',
  priceUsd: '1',
  priceTokens: '100',
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

interface MediaUploadBatchProgress {
  bytesSent: number;
  completed: number;
  percent: number;
  total: number;
  totalBytes: number;
}

function PostComposerHeader({
  step,
  isEditMode,
  topInset,
  onClose,
  onBack,
}: {
  step: 'details' | 'resources';
  isEditMode: boolean;
  topInset: number;
  onClose: () => void;
  onBack: () => void;
}) {
  const isResources = step === 'resources';
  return (
    <View
      style={{
        paddingTop: Math.max(8, topInset),
        paddingHorizontal: 14,
        borderBottomWidth: 1,
        borderBottomColor: appTheme.colors.borderSubtle,
        backgroundColor: appTheme.colors.background,
      }}
    >
      <View style={{ minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <HeaderIconButton
          label={isResources ? 'Back to post details' : 'Close post composer'}
          icon={isResources ? 'back' : 'close'}
          onPress={isResources ? onBack : onClose}
        />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <AppText heading variant="cardTitle" numberOfLines={1}>
            {isEditMode ? 'Edit post' : isResources ? 'Review & publish' : 'Create post'}
          </AppText>
          <AppText variant="caption" color="muted">
            {isResources ? 'Step 2 of 2 · resources optional' : 'Step 1 of 2 · post details'}
          </AppText>
        </View>
        {isResources ? <HeaderIconButton label="Close post composer" icon="close" onPress={onClose} /> : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 6, paddingBottom: 8 }}>
        <View style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: appTheme.colors.primary }} />
        <View style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: isResources ? appTheme.colors.primary : appTheme.colors.border }} />
      </View>
    </View>
  );
}

function HeaderIconButton({ label, icon, onPress }: { label: string; icon: 'back' | 'close'; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 48,
        height: 48,
        borderRadius: 24,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? appTheme.colors.surfaceStrong : 'transparent',
      })}
    >
      {icon === 'back'
        ? <ArrowLeft size={22} color={appTheme.colors.text} strokeWidth={2.4} />
        : <X size={22} color={appTheme.colors.text} strokeWidth={2.4} />}
    </Pressable>
  );
}

function PostDetailsPage({
  draft,
  selectedGeneration,
  sourceTools,
  detailErrors,
  isPickingMedia,
  isFieldsLocked,
  isMadeWithOpen,
  mediaControlRef,
  titleInputRef,
  contentInputRef,
  onMadeWithOpenChange,
  onModeChange,
  onChange,
  onPickMedia,
  onRemoveMedia,
  onReorderMedia,
  onUpdateMadeWith,
  onAddMadeWith,
  onRemoveMadeWith,
}: {
  draft: PostComposerDraft;
  selectedGeneration: GenerationListItem | null;
  sourceTools: SourceToolOption[];
  detailErrors: PostComposerDetailErrors;
  isPickingMedia: boolean;
  isFieldsLocked: boolean;
  isMadeWithOpen: boolean;
  mediaControlRef: RefObject<View | null>;
  titleInputRef: RefObject<TextInput | null>;
  contentInputRef: RefObject<TextInput | null>;
  onMadeWithOpenChange: (value: boolean) => void;
  onModeChange: (mode: Exclude<PostComposerMode, 'creation'>) => void;
  onChange: (patch: Partial<PostComposerDraft>) => void;
  onPickMedia: () => void;
  onRemoveMedia: (id: string) => void;
  onReorderMedia: (id: string, targetIndex: number) => void;
  onUpdateMadeWith: (id: string, patch: Partial<PostComposerMadeWithRow>) => void;
  onAddMadeWith: () => void;
  onRemoveMadeWith: (id: string) => void;
}) {
  const primaryAttribution = draft.madeWithRows.find((row) => row.toolLabel.trim());
  const attribution = primaryAttribution
    ? `${primaryAttribution.toolLabel}${primaryAttribution.modelLabel ? ` · ${primaryAttribution.modelLabel}` : ''}`
    : 'Add tool and model';
  const titleField = (
    <ComposerFieldShell>
      <CompactFieldLabel label="Title" required valueLength={draft.title.length} maxLength={100} />
      <ComposerInput
        inputRef={titleInputRef}
        accessibilityLabel="Title, required"
        accessibilityHint="Enter a short title for this post. Maximum 100 characters."
        value={draft.title}
        onChangeText={(title) => onChange({ title: title.slice(0, 100) })}
        placeholder="What is this creation about?"
        editable={!isFieldsLocked}
      />
      <FieldErrorText message={detailErrors.title} />
    </ComposerFieldShell>
  );
  const textField = (
    <ComposerFieldShell>
      <CompactFieldLabel label="Post text" required valueLength={draft.contentText.length} maxLength={1000} />
      <ComposerInput
        inputRef={contentInputRef}
        accessibilityLabel="Post text, required"
        accessibilityHint="Write the main text people will read in this post."
        value={draft.contentText}
        onChangeText={(contentText) => onChange({ contentText: contentText.slice(0, BODY_MAX_LENGTH) })}
        placeholder="Share a prompt, idea, breakdown, or useful note..."
        multiline
        minHeight={170}
        editable={!isFieldsLocked}
      />
      <FieldErrorText message={detailErrors.content} />
    </ComposerFieldShell>
  );

  return (
    <View style={{ gap: 18 }}>
      {isFieldsLocked ? (
        <StatusBlock
          tone="neutral"
          title="Creation details are fixed"
          body="This post stays connected to its generated media. You can still change visibility and manage eligible resources in Review & publish."
        />
      ) : null}

      {!selectedGeneration && !isFieldsLocked ? (
        <PostFormatSelector value={draft.mode === 'text' ? 'text' : 'upload'} onChange={onModeChange} />
      ) : null}

      {draft.mode === 'text' ? titleField : selectedGeneration ? (
        <View style={{ gap: 8 }}>
          <CompactFieldLabel label="Media" required />
          <GeneratedProofCard item={selectedGeneration} />
        </View>
      ) : (
        <UploadContent
          draft={draft}
          isPicking={isPickingMedia}
          onPickMedia={onPickMedia}
          onRemoveMedia={onRemoveMedia}
          onReorderMedia={onReorderMedia}
          disabled={isFieldsLocked}
          controlRef={mediaControlRef}
          error={detailErrors.media}
        />
      )}

      {draft.mode === 'text' ? textField : titleField}

      {draft.mode !== 'text' ? <View style={{ gap: 10 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Made with"
          accessibilityState={{ expanded: isMadeWithOpen }}
          onPress={() => onMadeWithOpenChange(!isMadeWithOpen)}
          style={({ pressed }) => ({
            minHeight: 58,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: appTheme.colors.borderSubtle,
            backgroundColor: pressed ? appTheme.colors.surfaceStrong : appTheme.colors.surface,
            paddingHorizontal: 14,
          })}
        >
          <Sparkles size={19} color={appTheme.colors.image} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <AppText variant="label">Made with <AppText variant="caption" color="faint">optional</AppText></AppText>
            <AppText variant="caption" color="muted" numberOfLines={1}>{attribution}</AppText>
          </View>
          <ChevronDown
            size={18}
            color={appTheme.colors.muted}
            style={{ transform: [{ rotate: isMadeWithOpen ? '180deg' : '0deg' }] }}
          />
        </Pressable>
        {isMadeWithOpen ? (
          <MadeWithSection
            rows={draft.madeWithRows}
            sourceTools={sourceTools}
            disabled={isFieldsLocked || draft.mode === 'creation'}
            compactReadOnly={draft.mode === 'creation'}
            onUpdate={onUpdateMadeWith}
            onAdd={onAddMadeWith}
            onRemove={onRemoveMadeWith}
          />
        ) : null}
      </View> : null}

      {draft.mode !== 'text' ? <ComposerFieldShell>
        <CompactFieldLabel label="Story" optional valueLength={draft.caption.length} maxLength={1000} />
        <ComposerInput
          accessibilityLabel="Story, optional"
          accessibilityHint="Share the idea, process, or story behind this post. Maximum 1000 characters."
          value={draft.caption}
          onChangeText={(caption) => onChange({ caption: caption.slice(0, BODY_MAX_LENGTH), description: caption.slice(0, BODY_MAX_LENGTH) })}
          placeholder="Share the idea, process, or story behind it..."
          multiline
          minHeight={150}
          editable={!isFieldsLocked}
        />
      </ComposerFieldShell> : null}
    </View>
  );
}

function PostFormatSelector({
  value,
  onChange,
}: {
  value: Exclude<PostComposerMode, 'creation'>;
  onChange: (mode: Exclude<PostComposerMode, 'creation'>) => void;
}) {
  const options: Array<{ id: Exclude<PostComposerMode, 'creation'>; label: string; body: string }> = [
    { id: 'upload', label: 'Media post', body: 'Share images or video' },
    { id: 'text', label: 'Text post', body: 'Share an idea or breakdown' },
  ];

  return (
    <View style={{ gap: 8 }}>
      <CompactFieldLabel label="Post format" />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {options.map((option) => {
          const selected = value === option.id;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityLabel={`${option.label}, ${option.body}`}
              accessibilityState={{ selected }}
              onPress={() => onChange(option.id)}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: 68,
                borderRadius: 17,
                borderWidth: 1,
                borderColor: selected ? `${appTheme.colors.primary}aa` : appTheme.colors.borderSubtle,
                backgroundColor: selected ? `${appTheme.colors.primary}18` : pressed ? appTheme.colors.surfaceStrong : appTheme.colors.surface,
                padding: 12,
                gap: 3,
              })}
            >
              <AppText variant="label">{option.label}</AppText>
              <AppText variant="caption" color="muted">{option.body}</AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function FieldErrorText({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <AppText accessibilityRole="alert" variant="caption" color="danger">
      {message}
    </AppText>
  );
}

function ComposerFieldShell({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        gap: 8,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: appTheme.colors.borderSubtle,
        backgroundColor: appTheme.colors.surface,
        padding: 14,
      }}
    >
      {children}
    </View>
  );
}

function CompactFieldLabel({
  label,
  required = false,
  optional = false,
  valueLength,
  maxLength,
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  valueLength?: number;
  maxLength?: number;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <AppText variant="label">{label}</AppText>
      {required ? <AppText variant="caption" color="primary">Required</AppText> : null}
      {optional ? <AppText variant="caption" color="faint">Optional</AppText> : null}
      {typeof valueLength === 'number' && typeof maxLength === 'number' ? (
        <AppText variant="caption" color="faint" style={{ marginLeft: 'auto' }}>{`${valueLength}/${maxLength}`}</AppText>
      ) : null}
    </View>
  );
}

function PostResourcesPage({
  draft,
  selectedGeneration,
  isTemplateBacked,
  resourceEditingLocked,
  packageStatus,
  publishValidation,
  onResourceChange,
  onCreationPackageChange,
  onTogglePromptResource,
  onAddResource,
  onEditResource,
  onRemoveResource,
}: {
  draft: PostComposerDraft;
  selectedGeneration: GenerationListItem | null;
  isTemplateBacked: boolean;
  resourceEditingLocked: boolean;
  packageStatus: ReturnType<typeof getPostComposerPackageStatus>;
  publishValidation: PostComposerValidationResult;
  onResourceChange: (patch: Partial<PostComposerDraft['resource']>) => void;
  onCreationPackageChange: (patch: Partial<PostComposerDraft['creationPackage']>) => void;
  onTogglePromptResource: (enabled: boolean) => void;
  onAddResource: () => void;
  onEditResource: (id: string) => void;
  onRemoveResource: (id: string) => void;
}) {
  const resourceActive = draft.resource.accessMode !== 'none';
  const priceTokens = getPostComposerPriceTokens(draft.resource);
  const creatorEarnings = Math.floor(priceTokens * 0.85 * 100) / 100;

  if (isTemplateBacked) {
    return (
      <View style={{ gap: 16 }}>
        <PostPublishSummary draft={draft} selectedGeneration={selectedGeneration} validation={publishValidation} />
        <StatusBlock
          title="Ready to publish"
          body="This template result shares final media only. Its private recipe remains protected."
          tone="neutral"
        />
      </View>
    );
  }

  if (resourceEditingLocked) {
    const resourceCount = draft.resource.cards.length;
    const packageDescription = `${draft.resource.accessMode === 'paid' ? `${getPostComposerPriceTokens(draft.resource)} token paid package` : 'Resource package'} · ${resourceCount} ${resourceCount === 1 ? 'resource' : 'resources'}`;
    return (
      <View style={{ gap: 16 }}>
        <PostPublishSummary draft={draft} selectedGeneration={selectedGeneration} validation={publishValidation} />
        <StatusBlock
          title="Purchased resources are protected"
          body="People have already unlocked this package, so its access mode, price, and contents cannot be changed. Visibility changes still apply to the post."
          tone="neutral"
        />
        <ReadinessRow label="Existing package preserved" body={packageDescription} state="ready" />
      </View>
    );
  }

  return (
    <View style={{ gap: 18 }}>
      <PostPublishSummary draft={draft} selectedGeneration={selectedGeneration} validation={publishValidation} />
      <View style={{ gap: 8 }}>
        <AppText heading variant="sectionTitle">Optional resources</AppText>
        <AppText variant="bodySm" color="muted">
          Share reusable prompts, files, links, or guidance for free or at a token price.
        </AppText>
      </View>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <ResourceAccessChoice
          label="Share free"
          body="Reward useful work"
          active={draft.resource.accessMode === 'free'}
          accent="workflow"
          onPress={() => onResourceChange({ accessMode: 'free' })}
        />
        <ResourceAccessChoice
          label="Sell resources"
          body="Set a token price"
          active={draft.resource.accessMode === 'paid'}
          accent="commerce"
          onPress={() => onResourceChange({ accessMode: 'paid' })}
        />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: draft.resource.accessMode === 'none' }}
        onPress={() => onResourceChange({ accessMode: 'none' })}
        style={({ pressed }) => ({
          minHeight: 48,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 14,
          backgroundColor: draft.resource.accessMode === 'none'
            ? appTheme.colors.surfaceStrong
            : pressed ? appTheme.colors.surface : 'transparent',
          opacity: pressed ? 0.78 : 1,
        })}
      >
        <AppText variant="label" color={draft.resource.accessMode === 'none' ? 'text' : 'muted'}>
          Post without resources
        </AppText>
      </Pressable>

      {resourceActive && selectedGeneration ? (
        <ComposerFieldShell>
          <CompactFieldLabel label="From this creation" optional />
          {hasGenerationReferences(selectedGeneration) ? (
            <ToggleRow
              label="Include creation references"
              body="Attach the saved input media as reusable references."
              value={draft.creationPackage.attachGenerationReferences}
              onValueChange={(attachGenerationReferences) => onCreationPackageChange({ attachGenerationReferences })}
              accent="image"
            />
          ) : null}
          <ToggleRow
            label="Include exact prompt"
            body="Add the original generation prompt as a resource card."
            value={draft.creationPackage.attachPromptResource}
            onValueChange={onTogglePromptResource}
            accent="workflow"
            disabled={!selectedGeneration.prompt?.trim()}
          />
        </ComposerFieldShell>
      ) : null}

      {resourceActive ? (
        <>
          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1, gap: 2 }}>
                <AppText variant="cardTitle">What people receive</AppText>
                <AppText variant="caption" color="muted">
                  {draft.resource.cards.length === 0 ? 'Add at least one useful resource.' : `${draft.resource.cards.length} resource ${draft.resource.cards.length === 1 ? 'card' : 'cards'}`}
                </AppText>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add resource"
                onPress={onAddResource}
                style={({ pressed }) => ({
                  minHeight: 48,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 7,
                  borderRadius: 24,
                  paddingHorizontal: 14,
                  backgroundColor: pressed ? appTheme.colors.primaryStrong : appTheme.colors.primary,
                })}
              >
                <Plus size={17} color={appTheme.colors.onPrimary} strokeWidth={3} />
                <AppText variant="label" color="onPrimary">Add</AppText>
              </Pressable>
            </View>

            {draft.resource.cards.length > 0 ? (
              <View style={{ gap: 8 }}>
                {draft.resource.cards.map((card) => (
                  <ResourceCardRow
                    key={card.id}
                    card={card}
                    mediaItems={draft.mediaItems}
                    onEdit={() => onEditResource(card.id)}
                    onRemove={() => onRemoveResource(card.id)}
                  />
                ))}
              </View>
            ) : (
              <Pressable
                accessibilityRole="button"
                onPress={onAddResource}
                style={({ pressed }) => ({
                  minHeight: 120,
                  borderRadius: 18,
                  borderWidth: 1,
                  borderStyle: 'dashed',
                  borderColor: pressed ? `${appTheme.colors.primary}aa` : appTheme.colors.border,
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 9,
                  backgroundColor: pressed ? appTheme.colors.surfaceStrong : appTheme.colors.surfaceInset,
                })}
              >
                <Package size={27} color={appTheme.colors.muted} />
                <AppText variant="label" color="muted">Add your first resource</AppText>
              </Pressable>
            )}
          </View>

          <ComposerFieldShell>
            <CompactFieldLabel label="Package preview" required valueLength={draft.resource.previewText.length} maxLength={180} />
            <ComposerInput
              accessibilityLabel="Package preview, required"
              accessibilityHint="Describe publicly what people receive. Maximum 180 characters."
              value={draft.resource.previewText}
              onChangeText={(previewText) => onResourceChange({ previewText: previewText.slice(0, 180) })}
              placeholder="Tell people what they will receive"
              multiline
              minHeight={82}
            />
            {!draft.resource.previewText.trim() && draft.resource.cards.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => onResourceChange({ previewText: buildResourcePreviewFromCards(draft.resource.cards) })}
                style={({ pressed }) => ({ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
              >
                <AppText variant="caption" color="primary">Use suggested preview</AppText>
              </Pressable>
            ) : null}
          </ComposerFieldShell>

          {draft.resource.accessMode === 'paid' ? (
            <ComposerFieldShell>
              <CompactFieldLabel label="Price in tokens" required />
              <ComposerInput
                accessibilityLabel="Price in tokens, required"
                accessibilityHint="Enter at least 10 tokens using increments of 10."
                value={draft.resource.priceTokens}
                onChangeText={(value) => {
                  const priceTokens = value.replace(/[^0-9]/g, '');
                  const numeric = Number.parseInt(priceTokens || '0', 10);
                  onResourceChange({ priceTokens, priceUsd: String((Number.isFinite(numeric) ? numeric : 0) / 100) });
                }}
                placeholder="100"
                keyboardType="number-pad"
              />
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <AppText variant="caption" color="muted">Minimum 10 · increments of 10</AppText>
                <AppText variant="caption" color="commerce">{`You earn ~${creatorEarnings} tokens`}</AppText>
              </View>
              {priceTokens < 100 ? (
                <AppText variant="caption" color="muted">Credit-only purchase on web and mobile below 100 tokens.</AppText>
              ) : null}
            </ComposerFieldShell>
          ) : null}

          <ReadinessRow label={packageStatus.label} body={packageStatus.body} state={packageStatus.state} />
        </>
      ) : null}
    </View>
  );
}

function ResourceAccessChoice({
  label,
  body,
  active,
  accent,
  onPress,
}: {
  label: string;
  body: string;
  active: boolean;
  accent: 'workflow' | 'commerce';
  onPress: () => void;
}) {
  const color = appTheme.colors[accent];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 92,
        justifyContent: 'space-between',
        borderRadius: 18,
        borderWidth: 1,
        borderColor: active ? `${color}99` : appTheme.colors.border,
        backgroundColor: active ? `${color}18` : pressed ? appTheme.colors.surfaceStrong : appTheme.colors.surface,
        padding: 14,
        opacity: pressed ? 0.86 : 1,
      })}
    >
      <View style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: `${color}20` }}>
        {accent === 'workflow' ? <Sparkles size={16} color={color} /> : <Lock size={16} color={color} />}
      </View>
      <View style={{ gap: 2 }}>
        <AppText variant="label">{label}</AppText>
        <AppText variant="caption" color="muted">{body}</AppText>
      </View>
    </Pressable>
  );
}

function PostPublishSummary({
  draft,
  selectedGeneration,
  validation,
}: {
  draft: PostComposerDraft;
  selectedGeneration: GenerationListItem | null;
  validation: PostComposerValidationResult;
}) {
  const title = draft.title.trim() || 'Your post';
  const cover = draft.mediaItems[0]?.previewUrl
    || draft.mediaItems[0]?.uri
    || selectedGeneration?.previewUrl
    || selectedGeneration?.preview_url
    || selectedGeneration?.output_url
    || null;
  const visibilityLabel = draft.visibility === 'public' ? 'Public' : draft.visibility === 'unlisted' ? 'Unlisted' : 'Private';
  const resourceLabel = draft.resource.accessMode === 'paid'
    ? `${getPostComposerPriceTokens(draft.resource)} tokens`
    : draft.resource.accessMode === 'free'
      ? 'Free resources'
      : 'No resources';
  const ready = validation.valid;
  return (
    <View
      style={{
        borderRadius: 18,
        borderWidth: 1,
        borderColor: ready ? appTheme.semantic.success.border : appTheme.semantic.warning.border,
        backgroundColor: appTheme.colors.surface,
        padding: 14,
        gap: 12,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 58, height: 58, borderRadius: 15, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.surfaceStrong }}>
          {cover && draft.mode !== 'text' ? (
            <StableMediaImage
              url={cover}
              cacheKey={`post-review:${draft.selectedGenerationId ?? draft.mediaItems[0]?.id ?? 'cover'}`}
              contentFit="cover"
              style={{ width: 58, height: 58 }}
            />
          ) : (
            <FileText size={22} color={appTheme.colors.textSecondary} />
          )}
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {ready ? <Check size={17} color={appTheme.colors.success} /> : null}
            <AppText variant="label">{ready ? 'Ready to publish' : 'Needs attention'}</AppText>
          </View>
          <AppText variant="bodySm" numberOfLines={1}>{title}</AppText>
          <AppText variant="caption" color="muted" numberOfLines={2}>
            {ready
              ? draft.mode === 'text'
                ? draft.contentText.trim() || 'Text post'
                : draft.caption.trim() || 'Media post'
              : validation.message ?? 'Complete the required fields.'}
          </AppText>
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
        {[visibilityLabel, resourceLabel].map((label) => (
          <View key={label} style={{ minHeight: 28, justifyContent: 'center', borderRadius: 14, backgroundColor: appTheme.colors.surfaceStrong, paddingHorizontal: 10 }}>
            <AppText variant="caption" color="textSecondary">{label}</AppText>
          </View>
        ))}
      </View>
    </View>
  );
}

function ResourceCardRow({
  card,
  mediaItems,
  onEdit,
  onRemove,
}: {
  card: PostComposerResourceCardDraft;
  mediaItems: PostComposerMediaItem[];
  onEdit: () => void;
  onRemove: () => void;
}) {
  const typeLabel = POST_COMPOSER_RESOURCE_CARD_OPTIONS.find((option) => option.id === card.type)?.label ?? 'Resource';
  const scopeLabel = card.appliesToAll || mediaItems.length <= 1
    ? 'All outputs'
    : `${card.mediaKeys.length} ${card.mediaKeys.length === 1 ? 'output' : 'outputs'}`;
  const contentLabel = card.attachments.length > 0
    ? `${card.attachments.length} ${card.attachments.length === 1 ? 'file' : 'files'}`
    : card.textContent.trim()
      ? `${card.textContent.trim().length} characters`
      : card.externalUrl.trim()
        ? card.type === 'remix_link' ? 'Protected remix link' : 'Protected link'
        : 'Needs content';

  return (
    <View
      style={{
        minHeight: 82,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: isPostComposerResourceCardReady(card) ? appTheme.colors.borderSubtle : appTheme.semantic.warning.border,
        backgroundColor: appTheme.colors.surface,
        padding: 12,
      }}
    >
      <View style={{ width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.surfaceStrong }}>
        <ResourceTypeIcon type={card.type} color={appTheme.colors.textSecondary} />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Edit ${card.title || typeLabel}`}
        onPress={onEdit}
        style={({ pressed }) => ({ flex: 1, minWidth: 0, gap: 3, opacity: pressed ? 0.72 : 1 })}
      >
        <AppText variant="label" numberOfLines={1}>{card.title.trim() || typeLabel}</AppText>
        <AppText variant="caption" color="muted" numberOfLines={1}>{`${typeLabel} · ${contentLabel}`}</AppText>
        <AppText variant="caption" color="image" numberOfLines={1}>{scopeLabel}</AppText>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${card.title || typeLabel}`}
        hitSlop={6}
        onPress={onRemove}
        style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.65 : 1 })}
      >
        <Trash2 size={18} color={appTheme.colors.danger} />
      </Pressable>
    </View>
  );
}

function ResourceTypeIcon({ type, color, size = 20 }: { type: PostComposerResourceCardType; color: string; size?: number }) {
  if (type === 'prompt' || type === 'guide' || type === 'settings') return <FileText size={size} color={color} />;
  if (type === 'reference_media') return <ImageIcon size={size} color={color} />;
  if (type === 'workflow' || type === 'remix_link' || type === 'external_link') return <Link2 size={size} color={color} />;
  return <Package size={size} color={color} />;
}

function PostComposerFooter({
  step,
  bottomInset,
  visibility,
  isEditMode,
  loading,
  disabled,
  onNext,
  onVisibility,
  onPublish,
}: {
  step: 'details' | 'resources';
  bottomInset: number;
  visibility: PostComposerDraft['visibility'];
  isEditMode: boolean;
  loading: boolean;
  disabled: boolean;
  onNext: () => void;
  onVisibility: () => void;
  onPublish: () => void;
}) {
  const visibilityLabel = visibility === 'public' ? 'Public' : visibility === 'unlisted' ? 'Unlisted' : 'Private';
  const submitLabel = getPostComposerSubmitLabel({ visibility, isEditMode, isPending: loading });
  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: bottomInset + 10,
        borderTopWidth: 1,
        borderTopColor: appTheme.colors.borderSubtle,
        backgroundColor: appTheme.colors.background,
        boxShadow: '0 -12px 30px rgba(0,0,0,0.30)',
      }}
    >
      {step === 'details' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Review and publish"
          onPress={onNext}
          style={({ pressed }) => ({
            minHeight: 54,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            borderRadius: 17,
            backgroundColor: pressed ? appTheme.colors.primaryStrong : appTheme.colors.primary,
          })}
        >
          <AppText variant="button" color="onPrimary">Review & publish</AppText>
          <ChevronRight size={19} color={appTheme.colors.onPrimary} strokeWidth={2.8} />
        </Pressable>
      ) : (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Visibility: ${visibilityLabel}`}
            onPress={onVisibility}
            style={({ pressed }) => ({
              minWidth: 112,
              minHeight: 54,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              borderRadius: 17,
              borderWidth: 1,
              borderColor: appTheme.colors.border,
              backgroundColor: pressed ? appTheme.colors.surfaceStrong : appTheme.colors.surface,
            })}
          >
            <Globe2 size={17} color={appTheme.colors.textSecondary} />
            <AppText variant="label">{visibilityLabel}</AppText>
            <ChevronDown size={15} color={appTheme.colors.muted} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={submitLabel}
            accessibilityState={{ disabled: disabled || loading, busy: loading }}
            disabled={disabled || loading}
            onPress={onPublish}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: 54,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              borderRadius: 17,
              backgroundColor: appTheme.colors.primary,
              opacity: disabled || loading ? appTheme.opacity.disabled : pressed ? 0.88 : 1,
            })}
          >
            {loading ? <ActivityIndicator size="small" color={appTheme.colors.onPrimary} /> : null}
            <AppText variant="button" color="onPrimary">{submitLabel}</AppText>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function VisibilitySheet({
  visible,
  value,
  bottomInset,
  onClose,
  onChange,
}: {
  visible: boolean;
  value: PostComposerDraft['visibility'];
  bottomInset: number;
  onClose: () => void;
  onChange: (value: PostComposerDraft['visibility']) => void;
}) {
  const options: Array<{ id: PostComposerDraft['visibility']; label: string; body: string }> = [
    { id: 'public', label: 'Public', body: 'Visible in Showcase and your profile.' },
    { id: 'unlisted', label: 'Unlisted', body: 'Only people with the link can open it.' },
    { id: 'private', label: 'Private', body: 'Only you can see it in Studio.' },
  ];
  return (
    <Modal visible={visible} transparent animationType="fade" presentationStyle="overFullScreen" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable accessible={false} onPress={onClose} style={{ position: 'absolute', inset: 0, backgroundColor: appTheme.colors.overlayStrong }} />
        <View
          accessibilityViewIsModal
          style={{
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            borderWidth: 1,
            borderBottomWidth: 0,
            borderColor: appTheme.colors.border,
            backgroundColor: appTheme.colors.panel,
            paddingHorizontal: 18,
            paddingTop: 12,
            paddingBottom: bottomInset + 18,
            gap: 12,
          }}
        >
          <View style={{ width: 36, height: 4, borderRadius: 2, alignSelf: 'center', backgroundColor: appTheme.colors.borderStrong }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <AppText heading variant="sectionTitle" style={{ flex: 1 }}>Who can see this?</AppText>
            <HeaderIconButton label="Close visibility options" icon="close" onPress={onClose} />
          </View>
          {options.map((option) => (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityState={{ selected: value === option.id }}
              onPress={() => onChange(option.id)}
              style={({ pressed }) => ({
                minHeight: 66,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: value === option.id ? `${appTheme.colors.primary}99` : appTheme.colors.borderSubtle,
                backgroundColor: value === option.id ? appTheme.colors.selected : pressed ? appTheme.colors.surfaceStrong : appTheme.colors.surface,
                padding: 12,
              })}
            >
              <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 1, borderColor: value === option.id ? appTheme.colors.primary : appTheme.colors.borderStrong, alignItems: 'center', justifyContent: 'center' }}>
                {value === option.id ? <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: appTheme.colors.primary }} /> : null}
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <AppText variant="label">{option.label}</AppText>
                <AppText variant="caption" color="muted">{option.body}</AppText>
              </View>
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

function ResourceComposerSheet({
  mode,
  card,
  mediaItems,
  bottomInset,
  isUploading,
  onRequestClose,
  onSave,
  onChooseType,
  onChange,
  onPickFile,
  onRemoveAttachment,
}: {
  mode: 'type' | 'editor' | null;
  card: PostComposerResourceCardDraft | null;
  mediaItems: PostComposerMediaItem[];
  bottomInset: number;
  isUploading: boolean;
  onRequestClose: () => void;
  onSave: () => void;
  onChooseType: (type: PostComposerResourceCardType) => void;
  onChange: (patch: Partial<PostComposerResourceCardDraft>) => void;
  onPickFile: () => void;
  onRemoveAttachment: (id: string) => void;
}) {
  const { height } = useWindowDimensions();
  const visible = mode !== null;
  const option = card ? POST_COMPOSER_RESOURCE_CARD_OPTIONS.find((candidate) => candidate.id === card.type) : null;
  const textType = card?.type === 'prompt' || card?.type === 'settings' || card?.type === 'guide' || card?.type === 'other';
  const linkType = card?.type === 'external_link' || card?.type === 'remix_link' || card?.type === 'workflow';
  const fileType = card?.type === 'reference_media' || card?.type === 'source_assets' || card?.type === 'workflow' || card?.type === 'other';
  const cardErrors = card ? getPostComposerResourceCardErrors(card) : {};
  const isReady = card ? isPostComposerResourceCardReady(card) : false;

  return (
    <Modal visible={visible} transparent animationType="slide" presentationStyle="overFullScreen" onRequestClose={onRequestClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
        style={{ flex: 1, justifyContent: 'flex-end' }}
      >
        <Pressable accessible={false} onPress={onRequestClose} style={{ position: 'absolute', inset: 0, backgroundColor: appTheme.colors.overlayStrong }} />
        <View
          accessibilityViewIsModal
          style={{
            maxHeight: Math.min(height * 0.9, 760),
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            borderWidth: 1,
            borderBottomWidth: 0,
            borderColor: appTheme.colors.border,
            backgroundColor: appTheme.colors.panel,
            overflow: 'hidden',
          }}
        >
          <View style={{ paddingTop: 11, paddingHorizontal: 18 }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, alignSelf: 'center', backgroundColor: appTheme.colors.borderStrong }} />
            <View style={{ minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <AppText heading variant="sectionTitle">{mode === 'type' ? 'Add a resource' : option?.label ?? 'Edit resource'}</AppText>
                <AppText variant="caption" color="muted">{mode === 'type' ? 'Choose what people will receive.' : 'Contents stay protected until unlock.'}</AppText>
              </View>
              <HeaderIconButton label="Close resource editor" icon="close" onPress={onRequestClose} />
            </View>
          </View>

          {mode === 'type' ? (
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: bottomInset + 20, gap: 9 }}
            >
              {POST_COMPOSER_RESOURCE_CARD_OPTIONS.map((resourceOption) => (
                <Pressable
                  key={resourceOption.id}
                  accessibilityRole="button"
                  onPress={() => onChooseType(resourceOption.id)}
                  style={({ pressed }) => ({
                    minHeight: 68,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    borderRadius: 17,
                    borderWidth: 1,
                    borderColor: appTheme.colors.borderSubtle,
                    backgroundColor: pressed ? appTheme.colors.surfaceStrong : appTheme.colors.surface,
                    padding: 12,
                  })}
                >
                  <View style={{ width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.surfaceStrong }}>
                    <ResourceTypeIcon type={resourceOption.id} color={appTheme.colors.textSecondary} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <AppText variant="label">{resourceOption.label}</AppText>
                    <AppText variant="caption" color="muted" numberOfLines={2}>{resourceOption.body}</AppText>
                  </View>
                  <ChevronRight size={18} color={appTheme.colors.faint} />
                </Pressable>
              ))}
            </ScrollView>
          ) : card ? (
            <>
              <ScrollView
                automaticallyAdjustKeyboardInsets
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="interactive"
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: bottomInset + 24, gap: 14 }}
              >
                <ComposerFieldShell>
                  <CompactFieldLabel label="Resource title" required valueLength={card.title.length} maxLength={80} />
                  <ComposerInput
                    accessibilityLabel="Resource title, required"
                    accessibilityHint="Enter a public title for this protected resource. Maximum 80 characters."
                    value={card.title}
                    onChangeText={(title) => onChange({ title: title.slice(0, 80) })}
                    placeholder={option?.label ?? 'Resource title'}
                  />
                  <FieldErrorText message={cardErrors.title} />
                  <CompactFieldLabel label="Short preview" optional valueLength={card.preview.length} maxLength={120} />
                  <ComposerInput
                    accessibilityLabel="Short preview, optional"
                    accessibilityHint="Summarize the resource publicly without revealing its protected contents."
                    value={card.preview}
                    onChangeText={(preview) => onChange({ preview: preview.slice(0, 120) })}
                    placeholder="Public summary without revealing the contents"
                    multiline
                    minHeight={66}
                  />
                </ComposerFieldShell>

                {textType ? (
                  <ComposerFieldShell>
                    <CompactFieldLabel
                      label={card.type === 'prompt' ? 'Prompt or script' : card.type === 'settings' ? 'Settings' : card.type === 'guide' ? 'Guide or notes' : 'Resource content'}
                      required={!fileType || card.attachments.length === 0}
                    />
                    <ComposerInput
                      accessibilityLabel={`${card.type === 'prompt' ? 'Prompt or script' : card.type === 'settings' ? 'Settings' : card.type === 'guide' ? 'Guide or notes' : 'Resource content'}, required`}
                      accessibilityHint="This protected content is revealed only after the resource package is unlocked."
                      value={card.textContent}
                      onChangeText={(textContent) => onChange({ textContent })}
                      placeholder="This content is revealed only after unlock"
                      multiline
                      minHeight={150}
                    />
                    <FieldErrorText message={cardErrors.content} />
                  </ComposerFieldShell>
                ) : null}

                {linkType ? (
                  <ComposerFieldShell>
                    <CompactFieldLabel label={card.type === 'remix_link' ? 'Remix URL' : card.type === 'workflow' ? 'Workflow link' : 'URL'} required={card.type !== 'workflow' || card.attachments.length === 0} />
                    <ComposerInput
                      accessibilityLabel={`${card.type === 'remix_link' ? 'Remix URL' : card.type === 'workflow' ? 'Workflow link' : 'URL'}, required`}
                      accessibilityHint="Enter the protected destination URL."
                      value={card.externalUrl}
                      onChangeText={(externalUrl) => onChange({ externalUrl })}
                      placeholder="https://"
                      autoCapitalize="none"
                      keyboardType="url"
                    />
                    <FieldErrorText message={cardErrors.content} />
                    {card.type === 'remix_link' ? <AppText variant="caption" color="muted">The URL remains hidden until the package is unlocked.</AppText> : null}
                  </ComposerFieldShell>
                ) : null}

                {fileType ? (
                  <ComposerFieldShell>
                    <CompactFieldLabel label={card.type === 'reference_media' ? 'Reference files' : card.type === 'workflow' ? 'Workflow files' : 'Files'} optional={card.type === 'workflow' || card.type === 'other'} required={card.type === 'reference_media' || card.type === 'source_assets'} />
                    {card.attachments.map((attachment) => (
                      <View key={attachment.id} style={{ minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 14, backgroundColor: appTheme.colors.surfaceInset, paddingHorizontal: 11 }}>
                        <FileText size={17} color={appTheme.colors.textSecondary} />
                        <AppText variant="caption" numberOfLines={1} style={{ flex: 1 }}>{attachment.label}</AppText>
                        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${attachment.label}`} onPress={() => onRemoveAttachment(attachment.id)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                          <X size={17} color={appTheme.colors.danger} />
                        </Pressable>
                      </View>
                    ))}
                    <Pressable
                      accessibilityRole="button"
                      disabled={isUploading}
                      onPress={onPickFile}
                      style={({ pressed }) => ({
                        minHeight: 50,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 8,
                        borderRadius: 15,
                        borderWidth: 1,
                        borderStyle: 'dashed',
                        borderColor: appTheme.colors.border,
                        backgroundColor: pressed ? appTheme.colors.surfaceStrong : appTheme.colors.surfaceInset,
                        opacity: isUploading ? appTheme.opacity.disabled : 1,
                      })}
                    >
                      {isUploading ? <ActivityIndicator size="small" color={appTheme.colors.primary} /> : <Upload size={17} color={appTheme.colors.textSecondary} />}
                      <AppText variant="label" color="textSecondary">{isUploading ? 'Uploading' : 'Add file'}</AppText>
                    </Pressable>
                    {!linkType && !textType ? <FieldErrorText message={cardErrors.content} /> : null}
                  </ComposerFieldShell>
                ) : null}

                {mediaItems.length > 1 ? (
                  <ResourceScopePicker card={card} mediaItems={mediaItems} onChange={onChange} />
                ) : null}
              </ScrollView>
              <View style={{ paddingHorizontal: 18, paddingTop: 10, paddingBottom: bottomInset + 12, borderTopWidth: 1, borderTopColor: appTheme.colors.borderSubtle }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Save resource"
                  accessibilityState={{ disabled: !isReady }}
                  disabled={!isReady}
                  onPress={() => {
                    Keyboard.dismiss();
                    onSave();
                  }}
                  style={({ pressed }) => ({
                    minHeight: 54,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 17,
                    backgroundColor: appTheme.colors.primary,
                    opacity: !isReady ? appTheme.opacity.disabled : pressed ? 0.86 : 1,
                  })}
                >
                  <AppText variant="button" color="onPrimary">Save resource</AppText>
                </Pressable>
              </View>
            </>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ResourceScopePicker({
  card,
  mediaItems,
  onChange,
}: {
  card: PostComposerResourceCardDraft;
  mediaItems: PostComposerMediaItem[];
  onChange: (patch: Partial<PostComposerResourceCardDraft>) => void;
}) {
  const toggleMedia = (mediaKey: string) => {
    if (card.appliesToAll) {
      onChange({ appliesToAll: false, mediaKeys: [mediaKey] });
      return;
    }
    const selected = card.mediaKeys.includes(mediaKey)
      ? card.mediaKeys.filter((key) => key !== mediaKey)
      : [...card.mediaKeys, mediaKey];
    onChange(selected.length === 0
      ? { appliesToAll: true, mediaKeys: [] }
      : { appliesToAll: false, mediaKeys: selected });
  };

  return (
    <ComposerFieldShell>
      <CompactFieldLabel label="Applies to" optional />
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: card.appliesToAll }}
        onPress={() => onChange({ appliesToAll: true, mediaKeys: [] })}
        style={({ pressed }) => ({
          minHeight: 48,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 9,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: card.appliesToAll ? `${appTheme.colors.image}99` : appTheme.colors.border,
          backgroundColor: card.appliesToAll ? `${appTheme.colors.image}16` : pressed ? appTheme.colors.surfaceStrong : appTheme.colors.surfaceInset,
          paddingHorizontal: 12,
        })}
      >
        <Check size={17} color={card.appliesToAll ? appTheme.colors.image : appTheme.colors.faint} />
        <AppText variant="label">All outputs</AppText>
      </Pressable>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 9 }}>
        {mediaItems.map((item, index) => {
          const mediaKey = item.mediaKey ?? item.id;
          const selected = !card.appliesToAll && card.mediaKeys.includes(mediaKey);
          return (
            <Pressable
              key={mediaKey}
              accessibilityRole="button"
              accessibilityLabel={`Apply to output ${index + 1}`}
              accessibilityState={{ selected }}
              onPress={() => toggleMedia(mediaKey)}
              style={({ pressed }) => ({
                width: 72,
                gap: 5,
                opacity: pressed ? 0.78 : 1,
              })}
            >
              <View style={{ height: 82, borderRadius: 13, overflow: 'hidden', borderWidth: selected ? 2 : 1, borderColor: selected ? appTheme.colors.image : appTheme.colors.border, backgroundColor: appTheme.colors.surfaceInset }}>
                {item.mediaKind === 'image' ? (
                  <StableMediaImage url={item.previewUrl ?? item.uri} cacheKey={`scope:${mediaKey}`} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
                ) : (
                  <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Play size={24} color={appTheme.colors.textSecondary} /></View>
                )}
                {selected ? (
                  <View style={{ position: 'absolute', top: 5, right: 5, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.image }}>
                    <Check size={13} color={appTheme.colors.textInverse} strokeWidth={3} />
                  </View>
                ) : null}
              </View>
              <AppText variant="caption" color={selected ? 'image' : 'muted'} style={{ textAlign: 'center' }}>{index === 0 ? 'Cover' : `Output ${index + 1}`}</AppText>
            </Pressable>
          );
        })}
      </ScrollView>
    </ComposerFieldShell>
  );
}

function buildResourcePreviewFromCards(cards: PostComposerResourceCardDraft[]) {
  const labels = cards.slice(0, 3).map((card) => card.title.trim()).filter(Boolean);
  if (labels.length === 0) return 'Includes reusable resources from this creation.';
  const joined = labels.join(', ').replace(/, ([^,]*)$/, ', and $1');
  const extra = Math.max(0, cards.length - labels.length);
  return `Includes ${joined}${extra > 0 ? ` and ${extra} more` : ''}.`;
}

function cloneResourceCard(card: PostComposerResourceCardDraft): PostComposerResourceCardDraft {
  return {
    ...card,
    attachments: card.attachments.map((attachment) => ({ ...attachment })),
    mediaKeys: [...card.mediaKeys],
  };
}

function getResourceCardSignature(card: PostComposerResourceCardDraft) {
  return JSON.stringify(card);
}





export default function NewPostScreen() {
  const { user, isLoading: authLoading, api } = useAuth();
  const queryClient = useQueryClient();
  const navigation = useNavigation();
  const params = useLocalSearchParams<{ generationId?: string; postId?: string; focus?: string }>();
  const generationId = params.generationId;
  const postId = params.postId;
  const focusTarget = Array.isArray(params.focus) ? params.focus[0] : params.focus;

  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const bottomInset = resolvedBottomInset(insets.bottom);
  const horizontalPadding = Math.min(width, 430) < 390 ? 16 : 18;
  const [draft, setDraft] = useState<PostComposerDraft>(() => ({
    ...getDefaultPostComposerDraft(),
    mode: 'upload',
    proofMode: 'media',
    category: 'image',
    madeWithRows: [createMadeWithRow()],
  }));
  const [message, setMessage] = useState<{ tone: 'danger' | 'success' | 'neutral'; title: string; body?: string } | null>(null);
  const [detailErrors, setDetailErrors] = useState<PostComposerDetailErrors>({});
  const [isPickingMedia, setIsPickingMedia] = useState(false);
  const [isPickingResourceFile, setIsPickingResourceFile] = useState(false);
  const [hasPrefilledEdit, setHasPrefilledEdit] = useState(false);
  const [hasHydratedPersistedDraft, setHasHydratedPersistedDraft] = useState(false);
  const [composerStep, setComposerStep] = useState<'details' | 'resources'>('details');
  const [isMadeWithOpen, setIsMadeWithOpen] = useState(false);
  const [resourceSheetMode, setResourceSheetMode] = useState<'type' | 'editor' | null>(null);
  const [editingResourceId, setEditingResourceId] = useState<string | null>(null);
  const [resourceEditorCard, setResourceEditorCard] = useState<PostComposerResourceCardDraft | null>(null);
  const [resourceEditorOriginal, setResourceEditorOriginal] = useState<PostComposerResourceCardDraft | null>(null);
  const [isVisibilityOpen, setIsVisibilityOpen] = useState(false);
  const [isNavigationAllowed, setIsNavigationAllowed] = useState(false);
  const [pendingPublishVisibility, setPendingPublishVisibility] = useState<PostComposerDraft['visibility'] | null>(null);
  const [mediaUploadProgress, setMediaUploadProgress] = useState<MediaUploadBatchProgress | null>(null);
  const [pendingRetryMedia, setPendingRetryMedia] = useState<ImagePickerAsset[]>([]);
  const scrollRef = useRef<ScrollView>(null);
  const mediaControlRef = useRef<View>(null);
  const titleInputRef = useRef<TextInput>(null);
  const contentInputRef = useRef<TextInput>(null);
  const mediaUploadAbortRef = useRef<AbortController | null>(null);
  const mediaUploadIdRef = useRef(0);
  const initialDraftSignatureRef = useRef<string | null>(null);
  const draftStorageId = user ? getPostComposerDraftStorageId({
    userId: user.id,
    postId,
    generationId,
  }) : null;

  const postQuery = useQuery({
    queryKey: ['post-edit', postId],
    enabled: Boolean(user && postId),
    queryFn: () => api.getOwnerPost(postId!),
  });

  const generationLookupId = generationId ?? postQuery.data?.post?.generationId ?? null;
  const generationsQuery = useQuery({
    queryKey: ['post-new-generations', user?.id, generationLookupId],
    enabled: Boolean(user && generationLookupId),
    queryFn: () => api.listGenerations(true, { id: generationLookupId ?? undefined, limit: 1 }),
  });

  const sourceToolsQuery = useQuery({
    queryKey: ['post-source-tools'],
    enabled: Boolean(user),
    queryFn: () => api.listSourceTools(),
  });

  const allGenerations = generationsQuery.data?.generations ?? [];
  const explicitGeneration = useMemo(
    () => getExplicitPublishGeneration(allGenerations, generationId),
    [allGenerations, generationId]
  );
  const selectedGeneration = allGenerations.find((item) => item.id === draft.selectedGenerationId) ?? null;
  const isTemplateBacked = isTemplateGeneration(selectedGeneration);
  const isGenerationBacked = Boolean(postQuery.data?.post?.generationId) || draft.mode === 'creation';
  const isEditMode = Boolean(postId);
  const isFieldsLocked = isEditMode && isGenerationBacked;
  const hasPaidOrders = postQuery.data?.post?.hasPaidOrders === true;
  const canSubmit = !isPickingMedia
    && !isPickingResourceFile
    && (!isEditMode || (postQuery.isSuccess && hasPrefilledEdit));
  const sourceTools = sourceToolsQuery.data?.tools ?? [];
  const packageStatus = useMemo(
    () => getPostComposerPackageStatus(draft, selectedGeneration),
    [draft, selectedGeneration]
  );
  const publishValidation = useMemo(
    () => validateCurrentDraft(draft, selectedGeneration, isEditMode && isGenerationBacked, hasPaidOrders),
    [draft, hasPaidOrders, isEditMode, isGenerationBacked, selectedGeneration]
  );
  const hasUnsavedChanges = hasHydratedPersistedDraft && (
    isEditMode || Boolean(generationId)
      ? initialDraftSignatureRef.current !== null
        && getPostComposerDraftSignature(draft) !== initialDraftSignatureRef.current
      : isPostComposerDraftMeaningful(draft)
  );

  // Prefill when generationId is provided and the creations list resolves.
  // A canonical template result may be selected before its grid derivative
  // is ready, while ordinary creations retain the normal publishable filter.
  useEffect(() => {
    if (generationId && explicitGeneration) {
      const found = explicitGeneration;
        setDraft((current) => {
          if (current.selectedGenerationId === generationId) return current;
          const category = found.category === 'video' || found.category === 'motion' || found.category === 'ugc-ad' ? 'video' : 'image';
          return {
            ...current,
            mode: 'creation',
            proofMode: 'media',
            selectedGenerationId: found.id,
            title: current.title || getPublishGenerationTitle(found),
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
  }, [explicitGeneration, generationId]);

  useEffect(() => {
    if (!generationId || !generationsQuery.isSuccess) return;
    const requested = allGenerations.find((item) => item.id === generationId);
    if (!requested?.linked_post_id) return;
    router.replace(`/showcase/${encodeURIComponent(requested.linked_post_id)}` as never);
  }, [allGenerations, generationId, generationsQuery.isSuccess]);

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
        caption: mode === 'text' ? '' : post.body || post.description || '',
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
              mediaKey: item.mediaKey ?? item.id,
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
                mediaKey: `${post.id}:cover`,
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
          cards: hydratePostComposerResourceCards(resourceBundleInput),
          allowRemix: resourceBundleInput.resources?.allowRemix || false,
          summary: resourceBundleInput.summary || '',
          previewText: resourceBundleInput.previewText || '',
          priceUsd: resourceBundleInput.priceUsdCents ? String(resourceBundleInput.priceUsdCents / 100) : '9',
          priceTokens: resourceBundleInput.priceUsdCents ? String(resourceBundleInput.priceUsdCents) : '100',
        } : getDefaultResourceDraft(),
      });
      setHasPrefilledEdit(true);
    }
  }, [postId, postQuery.data, hasPrefilledEdit]);

  useEffect(() => () => {
    mediaUploadAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    const canHydrate = Boolean(
      user
      && draftStorageId
      && (!isEditMode || hasPrefilledEdit)
      && (!generationId || (explicitGeneration && draft.selectedGenerationId === generationId))
    );
    if (!canHydrate || hasHydratedPersistedDraft) return;

    let active = true;
    const baselineSignature = getPostComposerDraftSignature(draft);
    initialDraftSignatureRef.current = baselineSignature;

    void loadPersistedPostComposerDraft(draftStorageId!).then((persisted) => {
      if (!active) return;
      if (persisted) {
        const details = getPostComposerDetailErrors(persisted.draft);
        const canOpenReview = Object.keys(details).length === 0;
        setDraft(persisted.draft);
        setComposerStep(persisted.step === 'resources' && canOpenReview ? 'resources' : 'details');
        setDetailErrors(canOpenReview ? {} : details);
        setMessage({
          tone: 'neutral',
          title: 'Draft restored',
          body: 'Your unfinished post was recovered on this device.',
        });
      } else if (focusTarget === 'resources') {
        const details = getPostComposerDetailErrors(draft);
        if (Object.keys(details).length === 0) {
          setComposerStep('resources');
        } else {
          setComposerStep('details');
          setDetailErrors(details);
        }
      }
      setHasHydratedPersistedDraft(true);
    });

    return () => {
      active = false;
    };
  }, [
    draftStorageId,
    draft.selectedGenerationId,
    explicitGeneration,
    focusTarget,
    generationId,
    hasHydratedPersistedDraft,
    hasPrefilledEdit,
    isEditMode,
    user,
  ]);

  useEffect(() => {
    if (!draftStorageId || !hasHydratedPersistedDraft) return;
    const timer = setTimeout(() => {
      if (isPostComposerDraftMeaningful(draft)) {
        void persistPostComposerDraft(draftStorageId, { draft, step: composerStep });
      } else {
        void clearPersistedPostComposerDraft(draftStorageId);
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [composerStep, draft, draftStorageId, hasHydratedPersistedDraft]);

  const publishMutation = useMutation({
    mutationFn: async (targetVisibility?: PostComposerDraft['visibility']) => {
      const effectiveDraft = targetVisibility ? { ...draft, visibility: targetVisibility } : draft;
      const validation = validateCurrentDraft(
        effectiveDraft,
        selectedGeneration,
        isEditMode && isGenerationBacked,
        hasPaidOrders,
      );
      if (!validation.valid) {
        throw new Error(validation.message);
      }

      if (postId) {
        const isGen = Boolean(postQuery.data?.post?.generationId);
        const payload = buildUpdatePostPayload(isGen, effectiveDraft, {
          preserveSoldResourceBundle: hasPaidOrders,
        });
        return api.updatePost(postId, payload);
      }

      if (effectiveDraft.mode === 'creation') {
        if (!selectedGeneration) throw new Error('Choose a finished creation before publishing.');
        return api.publishGeneration(buildPublishGenerationPostPayload(selectedGeneration, effectiveDraft));
      }

      return api.createPost(buildCreatePostFormData(effectiveDraft));
    },
    onMutate: (targetVisibility?: PostComposerDraft['visibility']) => {
      const submittedDraft = targetVisibility ? { ...draft, visibility: targetVisibility } : draft;
      setPendingPublishVisibility(submittedDraft.visibility);
      return { submittedDraft };
    },
    onSuccess: (response, _targetVisibility, context) => {
      setMessage({
        tone: 'success',
        title: isEditMode ? 'Saved' : 'Posted',
        body: isEditMode ? 'Your post has been updated.' : 'Your post is now live in your profile.',
      });
      const targetPostId = response.postId || postId;
      if (!isEditMode) {
        const optimisticPost = buildOptimisticOwnerPostListItem(targetPostId, context?.submittedDraft ?? draft);
        if (optimisticPost) {
          queryClient.setQueryData<InfiniteData<OwnerPostsResponse>>(
            ['profile-owner-posts', user?.id],
            (current) => upsertOptimisticOwnerPostInfiniteData(current, optimisticPost)
          );
        }
      }
      void invalidatePostCaches(queryClient, user?.id);
      if (targetPostId) {
        setIsNavigationAllowed(true);
        setHasHydratedPersistedDraft(false);
        if (draftStorageId) {
          void clearPersistedPostComposerDraft(draftStorageId);
        }
        setTimeout(() => {
          router.replace({
            pathname: '/(tabs)/profile',
            params: {
              tab: 'posts',
              postId: targetPostId,
            },
          } as never);
        }, 0);
      }
    },
    onError: (error) => {
      setMessage({
        tone: 'danger',
        title: isEditMode ? 'Could not save' : 'Could not publish',
        body: error instanceof Error ? error.message : 'Try again.',
      });
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    },
    onSettled: () => {
      setPendingPublishVisibility(null);
    },
  });

  usePreventRemove(hasUnsavedChanges && !isNavigationAllowed, ({ data }) => {
    Alert.alert(
      'Leave this post?',
      'Keep editing, save this draft on this device, or discard the changes.',
      [
        { text: 'Keep editing', style: 'cancel' },
        {
          text: 'Save draft',
          onPress: () => {
            const save = draftStorageId
              ? persistPostComposerDraft(draftStorageId, { draft, step: composerStep })
              : Promise.resolve();
            void save.finally(() => {
              setIsNavigationAllowed(true);
              setTimeout(() => navigation.dispatch(data.action), 0);
            });
          },
        },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            const clear = draftStorageId
              ? clearPersistedPostComposerDraft(draftStorageId)
              : Promise.resolve();
            void clear.finally(() => {
              setIsNavigationAllowed(true);
              setTimeout(() => navigation.dispatch(data.action), 0);
            });
          },
        },
      ],
    );
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

  if (isEditMode && (postQuery.isLoading || (postQuery.isSuccess && Boolean(postQuery.data?.post) && !hasPrefilledEdit))) {
    return (
      <View style={{ flex: 1, backgroundColor: appTheme.colors.background, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 }}>
        <ActivityIndicator color={appTheme.colors.primary} />
        <AppText variant="bodySm" color="muted">Loading your post</AppText>
      </View>
    );
  }

  if (isEditMode && (postQuery.isError || (postQuery.isSuccess && !postQuery.data?.post))) {
    return (
      <View style={{ flex: 1, backgroundColor: appTheme.colors.background, justifyContent: 'center', gap: 12, padding: 24 }}>
        <StatusBlock tone="danger" title="Could not load this post" body="Nothing has been changed. Check your connection, then try again." />
        <SecondaryButton label="Retry post" onPress={() => void postQuery.refetch()} />
        <SecondaryButton label="Back to profile" onPress={() => router.replace('/(tabs)/profile?tab=posts' as never)} />
      </View>
    );
  }

  if (generationId && generationsQuery.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: appTheme.colors.background, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 }}>
        <ActivityIndicator color={appTheme.colors.primary} />
        <AppText variant="bodySm" color="muted">Loading your creation</AppText>
      </View>
    );
  }

  if (generationId && (generationsQuery.isError || (generationsQuery.isSuccess && !explicitGeneration))) {
    return (
      <View style={{ flex: 1, backgroundColor: appTheme.colors.background, justifyContent: 'center', gap: 12, padding: 24 }}>
        <StatusBlock tone="danger" title="Could not load this creation" body="Open the creation from your library and try publishing it again." />
        <SecondaryButton label="Retry creation" onPress={() => void generationsQuery.refetch()} />
        <SecondaryButton label="Back to creations" onPress={() => router.replace('/(tabs)/profile?tab=creations' as never)} />
      </View>
    );
  }

  const setMode = (mode: Exclude<PostComposerMode, 'creation'>) => {
    if (isFieldsLocked) return;
    setMessage(null);
    const next = {
      ...draft,
      mode,
      proofMode: mode === 'text' ? 'text' as const : 'media' as const,
      category: mode === 'text' ? 'text' as const : draft.category === 'text' ? 'image' as const : draft.category,
      sourceTool: mode === 'text' ? 'Manual' : draft.sourceTool === 'Manual' ? 'Other' : draft.sourceTool,
      sourceToolSlug: mode === 'text' ? 'manual' : draft.sourceToolSlug === 'manual' ? 'other' : draft.sourceToolSlug,
      madeWithRows: draft.madeWithRows.length > 0 ? draft.madeWithRows : [createMadeWithRow()],
    };
    setDraft(next);
    if (Object.keys(detailErrors).length > 0) {
      setDetailErrors(getPostComposerDetailErrors(next));
    }
  };

  const updateDraft = (patch: Partial<PostComposerDraft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (Object.keys(detailErrors).length > 0) {
      setDetailErrors(getPostComposerDetailErrors(next));
    }
    if (message?.tone === 'danger') {
      setMessage(null);
    }
  };

  const updateResource = (patch: Partial<PostComposerDraft['resource']>) => {
    if (hasPaidOrders) return;
    setDraft((current) => ({ ...current, resource: { ...current.resource, ...patch } }));
  };

  const updateCreationPackage = (patch: Partial<PostComposerDraft['creationPackage']>) => {
    if (hasPaidOrders) return;
    setDraft((current) => ({ ...current, creationPackage: { ...current.creationPackage, ...patch } }));
  };

  const togglePromptResource = (enabled: boolean) => {
    if (hasPaidOrders) return;
    setDraft((current) => applyCreationPromptResource(current, selectedGeneration, enabled));
  };

  const applyUploadedMedia = (uploadedItems: PostComposerMediaItem[]) => {
    if (uploadedItems.length === 0) return;
    setDraft((current) => {
      const mediaItems = [...current.mediaItems, ...uploadedItems].slice(0, 5);
      const cover = mediaItems[0];
      return {
        ...current,
        mode: 'upload',
        proofMode: 'media',
        category: cover?.mediaKind === 'video' ? 'video' : 'image',
        upload: cover
          ? {
              uri: cover.uri,
              name: cover.name,
              type: cover.type,
            }
          : current.upload,
        mediaItems,
      };
    });
    setDetailErrors((current) => {
      const next = { ...current };
      delete next.media;
      return next;
    });
  };

  const uploadSelectedMedia = async (assets: ImagePickerAsset[]) => {
    if (assets.length === 0) return;
    const controller = new AbortController();
    mediaUploadAbortRef.current = controller;
    setIsPickingMedia(true);
    setPendingRetryMedia([]);
    setMessage(null);

    const progressByIndex = new Map<number, { bytesSent: number; totalBytes: number }>();
    let completed = 0;
    const updateBatchProgress = () => {
      const totals = [...progressByIndex.values()].reduce(
        (sum, progress) => ({
          bytesSent: sum.bytesSent + progress.bytesSent,
          totalBytes: sum.totalBytes + progress.totalBytes,
        }),
        { bytesSent: 0, totalBytes: 0 }
      );
      setMediaUploadProgress({
        ...totals,
        completed,
        percent: totals.totalBytes > 0 ? Math.round((totals.bytesSent / totals.totalBytes) * 100) : 0,
        total: assets.length,
      });
    };
    assets.forEach((asset, index) => {
      const size = asset.fileSize && asset.fileSize > 0 ? asset.fileSize : 0;
      progressByIndex.set(index, { bytesSent: 0, totalBytes: size });
    });
    updateBatchProgress();

    try {
      const result = await runWeightedUploadQueue(
        assets.map((asset) => ({ item: asset, kind: getPickedAssetKind(asset) })),
        async (asset, index) => {
          const uploaded = await uploadPickedMedia(asset.uri, {
            api,
            fileName: asset.fileName,
            mimeType: asset.mimeType,
            kind: getPickedAssetKind(asset),
            durationSeconds: asset.duration ?? null,
            sizeBytes: asset.fileSize ?? null,
            signal: controller.signal,
            onProgress: (progress) => {
              progressByIndex.set(index, {
                bytesSent: progress.bytesSent,
                totalBytes: progress.totalBytes,
              });
              updateBatchProgress();
            },
          });
          completed += 1;
          progressByIndex.set(index, {
            bytesSent: uploaded.sizeBytes ?? progressByIndex.get(index)?.totalBytes ?? 0,
            totalBytes: uploaded.sizeBytes ?? progressByIndex.get(index)?.totalBytes ?? 0,
          });
          updateBatchProgress();
          mediaUploadIdRef.current += 1;
          const mediaKey = `media-${Date.now()}-${mediaUploadIdRef.current}`;
          return {
            id: mediaKey,
            mediaKey,
            uri: asset.uri,
            previewUrl: asset.uri,
            name: uploaded.fileName,
            type: uploaded.mimeType,
            mediaKind: uploaded.kind === 'video' ? 'video' as const : 'image' as const,
            storagePath: uploaded.storagePath,
          } satisfies PostComposerMediaItem;
        },
        { signal: controller.signal }
      );
      applyUploadedMedia(result.successes.map((entry) => entry.result));

      const retryAssets = result.failures.map((entry) => entry.item);
      setPendingRetryMedia(retryAssets);
      if (retryAssets.length > 0) {
        const cancelled = result.failures.every((entry) => isUploadCancelledError(entry.error));
        const firstError = result.failures.find((entry) => !isUploadCancelledError(entry.error))?.error;
        setMessage({
          tone: 'danger',
          title: cancelled ? 'Upload cancelled' : `${retryAssets.length} media upload${retryAssets.length === 1 ? '' : 's'} failed`,
          body: cancelled
            ? 'Completed uploads were kept. Retry the remaining media when you are ready.'
            : firstError instanceof Error
              ? firstError.message
              : 'Completed uploads were kept. Retry the remaining media.',
        });
      }
    } catch (error) {
      setPendingRetryMedia(assets);
      setMessage({
        tone: 'danger',
        title: isUploadCancelledError(error) ? 'Upload cancelled' : 'Could not upload media',
        body: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      if (mediaUploadAbortRef.current === controller) {
        mediaUploadAbortRef.current = null;
      }
      setMediaUploadProgress(null);
      setIsPickingMedia(false);
    }
  };

  const chooseMedia = async (kind: 'image' | 'video' | 'mixed') => {
    if (isFieldsLocked || isPickingMedia) return;
    setMessage(null);
    setPendingRetryMedia([]);
    setIsPickingMedia(true);
    try {
      const picked = await pickMediaList(kind, { allowsMultipleSelection: true });
      const availableSlots = Math.max(0, 5 - draft.mediaItems.length);
      const selected = picked.slice(0, availableSlots);
      if (selected.length === 0) return;
      setIsPickingMedia(false);
      await uploadSelectedMedia(selected);
    } catch (error) {
      setMessage({ tone: 'danger', title: 'Could not pick media', body: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      if (!mediaUploadAbortRef.current) setIsPickingMedia(false);
    }
  };
  const retryPendingMediaUploads = async () => {
    if (pendingRetryMedia.length === 0 || isPickingMedia) return;
    const retryAssets = pendingRetryMedia;
    setPendingRetryMedia([]);
    await uploadSelectedMedia(retryAssets);
  };

  const cancelMediaUploads = () => {
    mediaUploadAbortRef.current?.abort();
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
      const removed = current.mediaItems.find((item) => item.id === id);
      const mediaItems = current.mediaItems.filter((item) => item.id !== id);
      return {
        ...current,
        mediaItems,
        upload: mediaItems[0]
          ? { uri: mediaItems[0].uri, name: mediaItems[0].name, type: mediaItems[0].type }
          : null,
        resource: {
          ...current.resource,
          cards: current.resource.cards.map((card) => {
            const removedMediaKey = removed ? removed.mediaKey ?? removed.id : null;
            const mediaKeys = removedMediaKey ? card.mediaKeys.filter((key) => key !== removedMediaKey) : card.mediaKeys;
            return { ...card, mediaKeys, appliesToAll: card.appliesToAll || mediaKeys.length === 0 };
          }),
        },
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
    if (!resourceEditorCard || hasPaidOrders) return;
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
      const attachment = {
        id: `att-${Date.now()}`,
        kind: 'file',
        label: response.attachment.label,
        storagePath: response.attachment.storagePath ?? '',
        contentType: response.attachment.contentType ?? null,
        sizeBytes: response.attachment.sizeBytes ?? null,
        resourceType: response.attachment.resourceType ?? 'source_file',
        role: response.attachment.role ?? 'primary',
        remixUse: response.attachment.remixUse ?? 'import_source',
      } satisfies PostComposerResourceCardDraft['attachments'][number];
      setResourceEditorCard((current) => current
        ? { ...current, attachments: [...current.attachments, attachment] }
        : current);
    } catch (error) {
      setMessage({ tone: 'danger', title: 'Could not add file', body: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setIsPickingResourceFile(false);
    }
  };

  const updateResourceEditorCard = (patch: Partial<PostComposerResourceCardDraft>) => {
    if (hasPaidOrders) return;
    setResourceEditorCard((current) => current ? { ...current, ...patch } : current);
  };

  const removeResourceCard = (id: string) => {
    if (hasPaidOrders) return;
    setDraft((current) => ({
      ...current,
      resource: {
        ...current.resource,
        cards: current.resource.cards.filter((card) => card.id !== id),
      },
    }));
    if (editingResourceId === id) {
      setEditingResourceId(null);
      setResourceEditorCard(null);
      setResourceEditorOriginal(null);
      setResourceSheetMode(null);
    }
  };

  const startResourceCard = (type: PostComposerResourceCardType) => {
    if (hasPaidOrders) return;
    const card = createPostComposerResourceCard(type);
    setEditingResourceId(card.id);
    setResourceEditorCard(cloneResourceCard(card));
    setResourceEditorOriginal(cloneResourceCard(card));
    setResourceSheetMode('editor');
  };

  const openResourceCard = (id: string) => {
    if (hasPaidOrders) return;
    const card = draft.resource.cards.find((candidate) => candidate.id === id);
    if (!card) return;
    setEditingResourceId(id);
    setResourceEditorCard(cloneResourceCard(card));
    setResourceEditorOriginal(cloneResourceCard(card));
    setResourceSheetMode('editor');
  };

  const clearResourceEditor = () => {
    setEditingResourceId(null);
    setResourceEditorCard(null);
    setResourceEditorOriginal(null);
    setResourceSheetMode(null);
  };

  const requestCloseResourceSheet = () => {
    if (resourceSheetMode !== 'editor' || !resourceEditorCard || !resourceEditorOriginal) {
      clearResourceEditor();
      return;
    }
    const isDirty = getResourceCardSignature(resourceEditorCard) !== getResourceCardSignature(resourceEditorOriginal);
    if (!isDirty) {
      clearResourceEditor();
      return;
    }
    Alert.alert(
      'Discard resource changes?',
      'This resource has unsaved changes.',
      [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: clearResourceEditor },
      ],
    );
  };

  const saveResourceEditor = () => {
    if (!resourceEditorCard || !isPostComposerResourceCardReady(resourceEditorCard) || hasPaidOrders) return;
    const savedCard = cloneResourceCard(resourceEditorCard);
    setDraft((current) => {
      const exists = current.resource.cards.some((card) => card.id === savedCard.id);
      const cards = exists
        ? current.resource.cards.map((card) => card.id === savedCard.id ? savedCard : card)
        : [...current.resource.cards, savedCard];
      const previewText = current.resource.previewText.trim()
        ? current.resource.previewText
        : buildResourcePreviewFromCards(cards);
      return {
        ...current,
        resource: { ...current.resource, cards, previewText },
      };
    });
    clearResourceEditor();
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

  const editingResource = resourceEditorCard;

  const focusDetailField = (field: PostComposerDetailField) => {
    setTimeout(() => {
      if (field === 'media') {
        scrollRef.current?.scrollTo({ y: 0, animated: true });
        const node = findNodeHandle(mediaControlRef.current);
        if (node) {
          AccessibilityInfo.setAccessibilityFocus(node);
        }
        return;
      }
      if (field === 'content') {
        scrollRef.current?.scrollTo({ y: 220, animated: true });
        contentInputRef.current?.focus();
        return;
      }
      scrollRef.current?.scrollTo({ y: draft.mode === 'text' ? 80 : 220, animated: true });
      titleInputRef.current?.focus();
    }, 120);
  };

  const goToResources = () => {
    const errors = getPostComposerDetailErrors(draft);
    const detailFieldOrder: readonly PostComposerDetailField[] = draft.mode === 'text'
      ? ['title', 'content']
      : ['media', 'title'];
    const firstInvalidField = detailFieldOrder
      .find((field) => Boolean(errors[field]));
    if (firstInvalidField) {
      setDetailErrors(errors);
      setMessage(null);
      focusDetailField(firstInvalidField);
      return;
    }
    setDetailErrors({});
    setMessage(null);
    setComposerStep('resources');
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  };

  const submitPost = () => {
    setMessage(null);
    setPendingPublishVisibility(draft.visibility);
    publishMutation.mutate(draft.visibility);
  };

  return (
    <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
      <PostComposerHeader
        step={composerStep}
        isEditMode={isEditMode}
        topInset={insets.top}
        onClose={() => router.back()}
        onBack={() => {
          setMessage(null);
          setComposerStep('details');
        }}
      />
      <ScrollView
        ref={scrollRef}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        style={{ flex: 1, backgroundColor: appTheme.colors.background }}
        contentContainerStyle={{
          paddingHorizontal: horizontalPadding,
          paddingTop: 8,
          paddingBottom: bottomInset + 112,
          gap: 14,
        }}
      >
        {message ? (
          <StatusBlock tone={message.tone} title={message.title} body={message.body} />
        ) : null}

        {mediaUploadProgress ? (
          <View style={{ gap: 8 }}>
            <StatusBlock
              tone="neutral"
              title={`Uploading media · ${mediaUploadProgress.percent}%`}
              body={`${mediaUploadProgress.completed} of ${mediaUploadProgress.total} complete${mediaUploadProgress.totalBytes > 0 ? ` · ${formatUploadBytes(mediaUploadProgress.bytesSent)} of ${formatUploadBytes(mediaUploadProgress.totalBytes)}` : ''}`}
            />
            <SecondaryButton label="Cancel upload" onPress={cancelMediaUploads} />
          </View>
        ) : pendingRetryMedia.length > 0 ? (
          <SecondaryButton
            label={`Retry ${pendingRetryMedia.length} media upload${pendingRetryMedia.length === 1 ? '' : 's'}`}
            onPress={() => void retryPendingMediaUploads()}
          />
        ) : null}

        {composerStep === 'details' ? (
          <PostDetailsPage
            draft={draft}
            selectedGeneration={selectedGeneration}
            sourceTools={sourceTools}
            detailErrors={detailErrors}
            isPickingMedia={isPickingMedia}
            isFieldsLocked={isFieldsLocked}
            isMadeWithOpen={isMadeWithOpen}
            mediaControlRef={mediaControlRef}
            titleInputRef={titleInputRef}
            contentInputRef={contentInputRef}
            onMadeWithOpenChange={setIsMadeWithOpen}
            onModeChange={setMode}
            onChange={updateDraft}
            onPickMedia={() => void chooseMedia('mixed')}
            onRemoveMedia={removeMediaItem}
            onReorderMedia={reorderMediaItem}
            onUpdateMadeWith={updateMadeWithRow}
            onAddMadeWith={addMadeWithRow}
            onRemoveMadeWith={removeMadeWithRow}
          />
        ) : (
          <PostResourcesPage
            draft={draft}
            selectedGeneration={selectedGeneration}
            isTemplateBacked={isTemplateBacked}
            resourceEditingLocked={hasPaidOrders}
            packageStatus={packageStatus}
            publishValidation={publishValidation}
            onResourceChange={updateResource}
            onCreationPackageChange={updateCreationPackage}
            onTogglePromptResource={togglePromptResource}
            onAddResource={() => {
              if (!hasPaidOrders) setResourceSheetMode('type');
            }}
            onEditResource={openResourceCard}
            onRemoveResource={removeResourceCard}
          />
        )}
      </ScrollView>

      <PostComposerFooter
        step={composerStep}
        bottomInset={bottomInset}
        visibility={draft.visibility}
        isEditMode={isEditMode}
        loading={publishMutation.isPending}
        disabled={!canSubmit || isPickingMedia || pendingRetryMedia.length > 0 || (composerStep === 'resources' && !publishValidation.valid)}
        onNext={goToResources}
        onVisibility={() => setIsVisibilityOpen(true)}
        onPublish={submitPost}
      />

      <ResourceComposerSheet
        mode={resourceSheetMode}
        card={editingResource}
        mediaItems={draft.mediaItems}
        bottomInset={bottomInset}
        isUploading={isPickingResourceFile}
        onRequestClose={requestCloseResourceSheet}
        onSave={saveResourceEditor}
        onChooseType={startResourceCard}
        onChange={updateResourceEditorCard}
        onPickFile={() => void chooseResourceFile()}
        onRemoveAttachment={(attachmentId) => {
          if (!editingResource) return;
          updateResourceEditorCard({
            attachments: editingResource.attachments.filter((attachment) => attachment.id !== attachmentId),
          });
        }}
      />

      <VisibilitySheet
        visible={isVisibilityOpen}
        value={draft.visibility}
        bottomInset={bottomInset}
        onClose={() => setIsVisibilityOpen(false)}
        onChange={(visibility) => {
          updateDraft({ visibility });
          setIsVisibilityOpen(false);
        }}
      />
    </View>
  );
}

function MadeWithSection({
  rows,
  sourceTools,
  disabled,
  compactReadOnly = false,
  onUpdate,
  onAdd,
  onRemove,
}: {
  rows: PostComposerMadeWithRow[];
  sourceTools: SourceToolOption[];
  disabled: boolean;
  compactReadOnly?: boolean;
  onUpdate: (id: string, patch: Partial<PostComposerMadeWithRow>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  const toolOptions = getMadeWithToolOptions(sourceTools);
  const [activePickerId, setActivePickerId] = useState<string | null>(null);
  const lockedRow = rows[0];

  if (compactReadOnly && lockedRow) {
    const toolLabel = lockedRow.toolLabel.trim() || 'Magicbooklet';
    const modelLabel = lockedRow.modelLabel.trim();

    return (
      <SurfaceSection
        eyebrow="Attribution"
        title="Made With"
        accent="image"
        style={COMPOSER_SECTION_STYLE}
      >
        <View
          style={{
            minHeight: 48,
            borderRadius: 16,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: 'rgba(125,211,252,0.20)',
            backgroundColor: 'rgba(56,189,248,0.08)',
            paddingHorizontal: appTheme.spacing.gap,
            paddingVertical: 10,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: appTheme.spacing.gap,
          }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <AppText variant="bodySm" color="text" numberOfLines={1}>
              {toolLabel}
            </AppText>
            {modelLabel ? (
              <AppText variant="caption" color="muted" numberOfLines={1}>
                {modelLabel}
              </AppText>
            ) : null}
          </View>
          <MinimalStatusPill label="Locked" tone="neutral" />
        </View>
      </SurfaceSection>
    );
  }

  return (
    <SurfaceSection
      eyebrow="Attribution"
      title="Made With"
      accent="image"
      style={COMPOSER_SECTION_STYLE}
    >
      <View style={{ gap: appTheme.spacing.gap }}>
        <AppText variant="caption" color="faint">
          Popular tools appear first. Search for more editors, workflows, or older tools.
        </AppText>
        {rows.map((row, index) => {
          const selectedTool = toolOptions.find((tool) => (
            row.toolSlug ? tool.slug === row.toolSlug : tool.label === row.toolLabel
          ));
          const provisionalToolRows = rows.filter((candidate) => candidate.createTool && candidate.toolLabel.trim());
          const toolPickerOptions = uniquePickerOptions([
            ...toolOptions.map((tool) => ({
              value: tool.slug,
              label: tool.label,
              keywords: [
                ...(tool.aliases ?? []),
                tool.toolType ?? '',
                ...(tool.capabilities ?? []),
                tool.providerSlug ?? '',
              ],
              meta: tool.status && tool.status !== 'current'
                ? 'Historical'
                : readableSourceToolType(tool.toolType),
              hiddenUntilSearch: Boolean(
                (tool.catalogTier && tool.catalogTier !== 'featured')
                || (tool.status && tool.status !== 'current')
              ),
            })),
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
            ...catalogModels.map((model) => ({
              value: model.slug,
              label: model.label,
              keywords: [
                ...(model.aliases ?? []),
                model.providerSlug ?? '',
                ...(model.capabilities ?? []),
              ],
              meta: model.status && model.status !== 'current'
                ? 'Historical'
                : readableCatalogName(model.providerSlug),
              hiddenUntilSearch: Boolean(model.status && model.status !== 'current'),
            })),
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
      accent="primary"
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
  keywords?: string[];
  meta?: string;
  hiddenUntilSearch?: boolean;
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

function readableCatalogName(value?: string | null) {
  if (!value) return undefined;

  return value
    .split('-')
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function readableSourceToolType(toolType?: SourceToolOption['toolType']) {
  switch (toolType) {
    case 'api-marketplace':
      return 'API marketplace';
    case 'editor':
      return 'Editor';
    case 'workflow':
      return 'Workflow';
    case 'platform':
      return 'Platform';
    default:
      return undefined;
  }
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
    if (!normalizedQuery) return options.filter((option) => !option.hiddenUntilSearch);

    return options.filter((option) => (
      normalizePickerSearch(option.label).includes(normalizedQuery)
      || normalizePickerSearch(option.value).includes(normalizedQuery)
      || (option.keywords ?? []).some((keyword) => normalizePickerSearch(keyword).includes(normalizedQuery))
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
          placeholderTextColor={appTheme.colors.faint}
          editable={!disabled}
          style={{
            minHeight: appTheme.touch.compact,
            borderRadius: 14,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: isOpen ? `${appTheme.colors.image}88` : appTheme.colors.border,
            backgroundColor: disabled ? appTheme.colors.surface : appTheme.colors.surfaceInset,
            color: disabled ? appTheme.colors.faint : appTheme.colors.text,
            ...appTheme.type.bodySm,
            fontWeight: '700',
            paddingLeft: appTheme.spacing.gap,
            paddingRight: appTheme.touch.compact,
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
            width: appTheme.touch.compact,
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
                    minHeight: appTheme.touch.compact,
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
                  {entry.type === 'option' && !entry.option.provisional && entry.option.meta ? (
                    <AppText variant="caption" color="faint" numberOfLines={1}>
                      {entry.option.meta}
                    </AppText>
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
      ...tool,
      models: tool.models.map((model) => ({
        ...model,
        capabilities: model.capabilities ? [...model.capabilities] : undefined,
        aliases: model.aliases ? [...model.aliases] : undefined,
      })),
      supportedMediaKinds: [...tool.supportedMediaKinds],
      capabilities: tool.capabilities ? [...tool.capabilities] : undefined,
      aliases: tool.aliases ? [...tool.aliases] : undefined,
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

  const tools = sourceTools.length > 0 ? sourceTools : POST_COMPOSER_SOURCE_OPTIONS;
  tools.forEach(addTool);

  const catalogTierRank = (tool: SourceToolOption) => {
    if (tool.catalogTier === 'historical' || (tool.status && tool.status !== 'current')) return 2;
    if (tool.catalogTier === 'extended') return 1;
    return 0;
  };

  return [...optionsByKey.values()].sort((left, right) => catalogTierRank(left) - catalogTierRank(right));
}

function ProofSection({
  draft,
  selectedGeneration,
  isPickingMedia,
  isFieldsLocked,
  onModeChange,
  onPickMedia,
  onRemoveMedia,
  onReorderMedia,
}: {
  draft: PostComposerDraft;
  selectedGeneration: GenerationListItem | null;
  isPickingMedia: boolean;
  isFieldsLocked: boolean;
  onModeChange: (mode: Exclude<PostComposerMode, 'creation'>) => void;
  onPickMedia: () => void;
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
        </SegmentedRow>
      ) : null}

      {selectedGeneration ? (
        <GeneratedProofCard
          item={selectedGeneration}
        />
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
      body="The public content visible in Showcase."
      action={(
        <MiniAction
          label={isDescriptionOpen ? 'Hide description' : 'Add Showcase description'}
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
        <FieldBlock label="Showcase description">
          <ComposerInput
            value={draft.description}
            onChangeText={(description) => onChange({ description })}
            placeholder="Optional: give the post a short one-line setup for Showcase and previews."
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
  onSubmit,
}: {
  actions: ReturnType<typeof getPostComposerPublishActions>;
  canSubmit: boolean;
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
            loading={action.loading}
            disabled={!canSubmit || action.disabled}
            onPress={() => onSubmit(action.visibility)}
          />
        ))}
      </View>
    </MinimalComposerSection>
  );
}

function GeneratedProofCard({ item }: { item: GenerationListItem }) {
  const mediaUrl = item.media?.url ?? item.output_urls?.[0] ?? item.output_url ?? null;
  const previewUrl = getGenerationPreviewImageUrl(item);
  const mediaKind = getPublishGenerationMediaKind(item);
  const visualUrl = item.media?.previewUrl ?? (mediaKind === 'video' ? previewUrl : mediaUrl);

  return (
    <View
      style={{
        borderRadius: 18,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.10)',
        backgroundColor: 'rgba(255,255,255,0.025)',
        padding: appTheme.spacing.gap,
        gap: appTheme.spacing.gap,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: appTheme.spacing.gap }}>
        <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
          <AppText variant="label" color="muted" style={{ textTransform: 'uppercase' }}>
            Generated media
          </AppText>
          <AppText variant="cardTitle" numberOfLines={2}>
            {getPublishGenerationTitle(item)}
          </AppText>
          <AppText variant="caption" color="muted" numberOfLines={2}>
            {`Created in Magicbooklet with ${item.model || 'your latest model'}.`}
          </AppText>
        </View>
        <View style={{ flexShrink: 0, alignItems: 'flex-end', gap: appTheme.spacing.compact }}>
          <MinimalStatusPill label="Attached automatically" tone="workflow" />
        </View>
      </View>
      <View
        style={{
          minHeight: 220,
          borderRadius: 16,
          borderCurve: 'continuous',
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.08)',
          backgroundColor: appTheme.colors.surfaceInset,
        }}
      >
        {visualUrl ? (
          <StableMediaImage
            url={visualUrl}
            cacheKey={item.media?.cacheKey ?? item.id}
            thumbhash={item.media?.thumbhash}
            contentFit="cover"
            style={{ position: 'absolute', inset: 0 }}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: appTheme.spacing.gap, backgroundColor: appTheme.colors.panelSoft }}>
            <Sparkles size={34} color={appTheme.colors.motion} />
            <AppText variant="cardTitle">Creation ready</AppText>
          </View>
        )}
        {mediaKind === 'video' ? (
          <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.16)' }}>
            <Play size={44} color="#fff" fill="#fff" />
          </View>
        ) : null}
      </View>
    </View>
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
        minHeight: appTheme.touch.compact,
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
        borderColor: isPrimary ? appTheme.colors.primaryStrong : appTheme.colors.border,
        backgroundColor: isPrimary ? appTheme.colors.primary : appTheme.colors.surfaceStrong,
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
  return 'Visible in Showcase.';
}

function ComposerInput({
  inputRef,
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
  accessibilityHint,
  multiline,
  minHeight,
  editable = true,
  ...inputProps
}: {
  inputRef?: RefObject<TextInput | null>;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  multiline?: boolean;
  minHeight?: number;
  editable?: boolean;
} & Omit<TextInputProps, 'ref' | 'value' | 'onChangeText' | 'placeholder' | 'multiline' | 'editable' | 'style'>) {
  return (
    <TextInput
      {...inputProps}
      ref={inputRef}
      accessibilityLabel={accessibilityLabel ?? placeholder}
      accessibilityHint={accessibilityHint}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={appTheme.colors.faint}
      multiline={multiline}
      textAlignVertical={multiline ? 'top' : 'center'}
      editable={editable}
      style={{
        minHeight: multiline ? minHeight ?? 112 : appTheme.touch.compact,
        borderRadius: 14,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: editable ? appTheme.colors.surfaceInset : appTheme.colors.surface,
        color: editable ? appTheme.colors.text : appTheme.colors.faint,
        ...appTheme.type.bodySm,
        fontWeight: '500',
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
  accent = 'primary',
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
  controlRef,
  error,
  onPickMedia,
  onRemoveMedia,
  onReorderMedia,
  disabled = false,
}: {
  draft: PostComposerDraft;
  isPicking: boolean;
  controlRef?: RefObject<View | null>;
  error?: string;
  onPickMedia: () => void;
  onRemoveMedia: (id: string) => void;
  onReorderMedia: (id: string, targetIndex: number) => void;
  disabled?: boolean;
}) {
  return (
    <View style={{ gap: 10 }}>
      <View style={{ gap: 4 }}>
        <AppText variant="label" color="text">
          Upload images or videos <AppText variant="caption" color="primary">Required</AppText>
        </AppText>
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
          ref={controlRef as never}
          accessibilityRole="button"
          accessibilityLabel="Add media, required"
          accessibilityHint={error
            ? `${error} Choose up to five images or videos. The first item becomes the cover.`
            : 'Choose up to five images or videos. The first item becomes the cover.'}
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
          <AppText variant="label" color="muted">{isPicking ? 'Preparing media...' : 'Add media'}</AppText>
        </Pressable>
      )}
      <FieldErrorText message={error} />
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
        <AppText variant="caption" color="muted">{isPicking ? 'Preparing...' : 'Add media'}</AppText>
      </View>
      <View style={{ padding: 9, gap: 7 }}>
        <Text numberOfLines={1} style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>
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
      accessibilityLabel={canDrag ? `${label}, ${index + 1} of ${totalItems}` : undefined}
      accessibilityValue={canDrag ? { text: `${index + 1} of ${totalItems}` } : undefined}
      accessibilityActions={canDrag ? [
        { name: 'decrement', label: 'Move left' },
        { name: 'increment', label: 'Move right' },
      ] : undefined}
      onAccessibilityAction={canDrag ? (event) => {
        if (event.nativeEvent.actionName === 'decrement' && index > 0) {
          onReorderMedia(item.id, index - 1);
        }
        if (event.nativeEvent.actionName === 'increment' && index < totalItems - 1) {
          onReorderMedia(item.id, index + 1);
        }
      } : undefined}
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
          <StableMediaImage
            url={item.previewUrl ?? item.uri}
            cacheKey={`composer:${item.id}`}
            contentFit="cover"
            style={{ position: 'absolute', inset: 0 }}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.panelSoft }}>
            <Play size={34} color="#fff" fill="#fff" />
          </View>
        )}
        {!disabled ? (
          <Pressable
            accessibilityRole="button"
              accessibilityLabel={`Remove ${label}`}
              hitSlop={9}
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
        <Text numberOfLines={1} style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>
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
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: appTheme.touch.compact,
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: appTheme.colors.surfaceStrong,
        opacity: disabled ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
        paddingHorizontal: 12,
        alignItems: 'center',
        justifyContent: 'center',
      })}
    >
      <Text style={{ color: appTheme.colors.text, fontSize: 12, fontWeight: '700' }}>{label}</Text>
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
        minHeight: appTheme.touch.compact,
        borderRadius: 22,
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: appTheme.colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 8,
        opacity: pressed ? 0.75 : loading ? 0.58 : 1,
      })}
    >
      {loading ? <ActivityIndicator color="#fff" /> : icon}
      <Text style={{ color: appTheme.colors.text, fontSize: 13, fontWeight: '700' }}>{label}</Text>
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
            minHeight: appTheme.touch.compact,
            borderRadius: appTheme.radii.pill,
            borderWidth: 1,
            borderColor: resource.allowRemix ? appTheme.colors.primary : appTheme.colors.borderSubtle,
            backgroundColor: resource.allowRemix ? appTheme.colors.selected : appTheme.colors.surface,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 13,
            opacity: pressed ? 0.76 : 1,
          })}
        >
          <Text style={{ color: resource.allowRemix ? appTheme.colors.primary : appTheme.colors.muted, fontSize: 13, fontWeight: '700' }}>Include remix access</Text>
          <Lock size={16} color={resource.allowRemix ? appTheme.colors.primary : appTheme.colors.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

function validateCurrentDraft(
  draft: PostComposerDraft,
  selectedGeneration: GenerationListItem | null,
  skipGenerationSelection = false,
  preserveSoldResourceBundle = false,
) {
  const result = validatePostComposerDraft(preserveSoldResourceBundle
    ? {
        ...draft,
        resource: { ...draft.resource, accessMode: 'none' },
      }
    : draft);
  if (!result.valid) return result;
  if (draft.mode === 'creation' && !selectedGeneration && !skipGenerationSelection) {
    return { valid: false, message: 'Choose a finished creation before publishing.' };
  }
  return result;
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

function getPickedAssetKind(asset: ImagePickerAsset): 'image' | 'video' {
  return asset.type === 'video' || asset.mimeType?.startsWith('video/') ? 'video' : 'image';
}

function formatUploadBytes(value: number) {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
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
  // Collapse the paginated profile caches first — invalidating them while several pages are
  // loaded would refetch every one of those pages.
  queryClient.setQueryData(['profile-generations', userId], truncateInfiniteDataToFirstPage);
  queryClient.setQueryData(['profile-owner-posts', userId], truncateInfiniteDataToFirstPage);

  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['post-new-generations', userId] }),
    queryClient.invalidateQueries({ queryKey: ['profile-generations', userId] }),
    queryClient.invalidateQueries({ queryKey: ['profile-owner-posts', userId] }),
    queryClient.invalidateQueries({ queryKey: ['home-generations', userId] }),
    queryClient.invalidateQueries({ queryKey: ['owner-posts-sales-summary', userId] }),
    queryClient.invalidateQueries({ queryKey: ['generations', userId] }),
    queryClient.invalidateQueries({ queryKey: ['showcase-feed'] }),
  ]);
}
