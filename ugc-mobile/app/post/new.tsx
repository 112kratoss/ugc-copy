import { useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useNavigation, usePreventRemove } from '@react-navigation/native';
import { Redirect, router, Stack, useLocalSearchParams } from 'expo-router';
import type { ImagePickerAsset } from 'expo-image-picker';
import { BookOpen, Check, ChevronDown, ChevronRight, CircleMinus, Ellipsis, ExternalLink, FileText, FolderOpen, Globe2, ImageIcon, Images, Lock, Package, Pencil, Play, Plus, Repeat2, ScrollText, Shapes, SlidersHorizontal, Sparkles, Trash2, Upload, Workflow, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AccessibilityInfo, ActivityIndicator, findNodeHandle, Keyboard, Modal, PanResponder, Platform, Pressable, ScrollView, Share, Text, TextInput, useWindowDimensions, View, type GestureResponderEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ContentPolicyGate } from '@/components/content-policy-gate';
import { AppText, ReadinessRow, SecondaryButton, StatusBlock, SurfaceSection, ToggleRow } from '@/components/ui';
import { ComposerMediaLightbox, getComposerMediaFileName, getComposerMediaLabel } from '@/components/composer-media-lightbox';
import { CompactFieldLabel, ComposerFieldShell, ComposerInput, FieldErrorText } from '@/components/composer-fields';
import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { PublicIdentityCard } from '@/components/public-identity-card';
import { Overlay } from '@/components/overlay-host';
import { SheetBackdrop, SheetGrabber, SheetPanel, sheetMotion, useSheetDismissDrag, useSheetPresentation, type SheetDismissDrag } from '@/components/sheet-chrome';
import { showConfirmDialog } from '@/lib/dialog';
import { showActionSheet } from '@/lib/action-sheet';
import { StableMediaImage } from '@/components/media-preview';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { truncateInfiniteDataToFirstPage } from '@/lib/profile-media-query';
import { adjustProfileStats, invalidateProfileStats, profileQueryKey } from '@/lib/profile-stats';
import { useClaimPublicIdentity } from '@/lib/use-claim-public-identity';
import {
  getInitialPublicIdentity,
  isPublicIdentityReady,
  isPublicIdentityRefusal,
  readPublicIdentitySaveError,
  validatePublicIdentity,
  type PublicIdentityDraft,
  type PublicIdentityErrors,
} from '@/lib/public-identity';
import {
  assetDurationSeconds,
  describeOversizedResourceFiles,
  describePostMediaPickRefusals,
  getPostMediaPickRefusal,
  partitionResourceFilesBySize,
  pickMediaList,
  pickResourceDocument,
  pickResourcePhotos,
  RESOURCE_FILE_SIZE_LIMIT_LABEL,
  uploadPickedMedia,
  uploadResourceDocument,
  type PickedResourceFile,
} from '@/lib/media';
import {
  clearPersistedPostComposerDraft,
  getPostComposerDraftSignature,
  getPostComposerDraftStorageId,
  isPostComposerDraftMeaningful,
  loadPersistedPostComposerDraft,
  persistPostComposerDraft,
} from '@/lib/post-composer-draft-resume';
import {
  applyPostComposerMediaRecovery,
  applyPostComposerMediaRecoveryToDraft,
  describeFailedRecoveryReuploads,
  describeLostRecoveryMedia,
  forgetConsumedMediaUploads,
  getMediaAwaitingUpload,
  planPostComposerMediaRecovery,
  saveMayHaveConsumedUploads,
  saveRefusedForStaleMediaIds,
  withSavedPostMedia,
  type MediaVerification,
} from '@/lib/post-composer-media-recovery';
import {
  buildCreatePostFormData,
  buildOptimisticOwnerPostListItem,
  buildPublishGenerationPostPayload,
  buildUpdatePostPayload,
  buildCreationMadeWithRow,
  applyCreationPromptResource,
  createPostComposerResourceCard,
  createMadeWithRow,
  getComposerVisibility,
  getMadeWithToolLabel,
  getDefaultCreationPackageDraft,
  getDefaultPostComposerDraft,
  getPostComposerDetailErrors,
  getPostComposerPackageStatus,
  getPostComposerPriceTokens,
  getPostComposerResourceCardSaveHint,
  getPostComposerSubmitLabel,
  getVisiblePostComposerResourceCardErrors,
  countCreationReferenceFiles,
  describeRecipeBuyers,
  followSuggestedRecipePreview,
  foldRecipeSummaryIntoPreview,
  getRecipeMoneyLine,
  getRecipePriceError,
  getRecipeRemovalConfirmation,
  POST_COMPOSER_MORE_RESOURCE_CARD_TYPES,
  POST_COMPOSER_PRIMARY_RESOURCE_CARD_TYPES,
  RECIPE_PREVIEW_MAX_LENGTH,
  RECIPE_PREVIEW_QUALITY_MESSAGE,
  RECIPE_PREVIEW_REQUIRED_MESSAGE,
  willAttachGenerationReferences,
  type PostComposerResourceCardTouched,
  getExplicitPublishGeneration,
  getPublishGenerationMediaKind,
  getPublishGenerationTitle,
  getCreationPostTitleSuggestion,
  getCreationTitleSuggestionHint,
  followCreationTitleSuggestion,
  BODY_MAX_LENGTH,
  MADE_WITH_LABEL_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  hydratePostComposerAllowRemix,
  hydratePostComposerMediaItems,
  hydratePostComposerResourceCards,
  migratePostComposerResourceDraftToCards,
  sanitizePostComposerResourceCardIds,
  isTemplateGeneration,
  isPostComposerResourceCardReady,
  postComposerReturnPath,
  POST_COMPOSER_RESOURCE_CARD_OPTIONS,
  POST_COMPOSER_SOURCE_OPTIONS,
  validatePostComposerDraft,
  type PostComposerValidationOptions,
  hasCreationPromptCard,
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
  getDefaultResourceDraft,
  MAX_MADE_WITH_ROWS,
} from '@/lib/post-new-view-model';
import { homeModelLabel } from '@/lib/home-feed-view-model';
import {
  COMPOSER_UNDO_WINDOW_MS,
  describeComposerUndo,
  describeComposerUndoAction,
  putBackComposerRemoval,
  takeComposerMadeWithRow,
  takeComposerMedia,
  takeComposerResourceCard,
  type ComposerUndoEntry,
  type PostComposerRemoval,
} from '@/lib/composer-undo';
import { env } from '@/lib/env';
import { verticalHitSlop } from '@/lib/hit-target';
import {
  MEDIA_CARD_GAP,
  MEDIA_CARD_STEP,
  MEDIA_CARD_WIDTH,
  MEDIA_DRAG_HOLD_MS,
  MEDIA_DRAG_SCROLL_INTERVAL_MS,
  MEDIA_DRAG_SLOP,
  MEDIA_MAX_ITEMS,
  describeDropTarget,
  resolveAutoScrollStep,
  resolveDropIndex,
  resolveNeighbourShift,
  resolveRowContentWidth,
} from '@/lib/media-reorder';
import { useReducedMotion } from '@/lib/motion';
import { BackGlyph, CloseGlyph } from '@/lib/platform-glyphs';
import { resolvedBottomInset } from '@/lib/safe-area';
import { hexWithAlpha } from '@/lib/eased-fade';
import { formatCreditAmount } from '@/lib/pricing';
import { appTheme, mediaColors } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import { isUploadCancelledError, runWeightedUploadQueue } from '@/lib/upload-file';
import { useHardwareBack } from '@/lib/use-hardware-back';
import type { GenerationListItem, OwnerPostsResponse, PostResourceAttachment, PostResourceItemType, SourceToolOption } from '@/lib/types';
import { buildShareUrl } from '@/lib/viewer-actions';
import { haptic } from '@/lib/haptics';

// The dimmed strip kept between the status bar and a resource sheet that the keyboard has shortened.
const RESOURCE_SHEET_TOP_GAP = 8;

/** The space above the page's first block, and where a refused field is brought to. */
const COMPOSER_TOP_PADDING = 8;

const COMPOSER_SECTION_STYLE = {
  padding: 14,
  borderRadius: appTheme.radii.lg,
  gap: 10,
} as const;

interface MediaUploadBatchProgress {
  bytesSent: number;
  completed: number;
  percent: number;
  total: number;
  totalBytes: number;
}

interface ResourceUploadProgress {
  bytesSent: number;
  cardId: string;
  percent: number;
  totalBytes: number;
  /** Which of the picked files is going up, from 0, and how many there are. */
  fileIndex: number;
  fileCount: number;
}

/** The picked files of one item still to upload, in the order they were chosen; Retry sends these. */
interface PendingResourceUpload {
  cardId: string;
  cardType: PostComposerResourceCardType;
  files: PickedResourceFile[];
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
  const theme = useAppTheme();
  const isResources = step === 'resources';
  return (
    <View
      style={{
        paddingTop: Math.max(8, topInset),
        paddingHorizontal: 14,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.background,
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
            {isResources ? 'Step 2 of 2 · recipe optional' : 'Step 1 of 2 · post details'}
          </AppText>
        </View>
        {isResources ? <HeaderIconButton label="Close post composer" icon="close" onPress={onClose} /> : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 6, paddingBottom: 8 }}>
        <View style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: theme.colors.primary }} />
        <View style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: isResources ? theme.colors.primary : theme.colors.border }} />
      </View>
    </View>
  );
}

function HeaderIconButton({ label, icon, onPress }: { label: string; icon: 'back' | 'close'; onPress: () => void }) {
  const theme = useAppTheme();
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
        backgroundColor: pressed ? theme.colors.surfaceStrong : 'transparent',
      })}
    >
      {icon === 'back'
        ? <BackGlyph size={appTheme.icon.feature} color={theme.colors.text} />
        : <CloseGlyph size={appTheme.icon.feature} color={theme.colors.text} />}
    </Pressable>
  );
}

function PostDetailsPage({
  draft,
  selectedGeneration,
  sourceTools,
  detailErrors,
  isPickingMedia,
  isMediaLocked,
  isEditMode,
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
  isMediaLocked: boolean;
  /** Editing keeps the post's format: the server never changes it on update. */
  isEditMode: boolean;
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
  const theme = useAppTheme();
  const primaryAttribution = draft.madeWithRows.find((row) => row.toolLabel.trim());
  const attribution = primaryAttribution
    ? `${getMadeWithToolLabel(primaryAttribution)}${primaryAttribution.modelLabel ? ` · ${primaryAttribution.modelLabel}` : ''}`
    : 'Add tool and model';
  // "Suggested" speaks only of a new post's starting title, never of an edit's saved one.
  const titleSuggestionHint = getCreationTitleSuggestionHint(draft, isEditMode ? null : selectedGeneration);
  const titleField = (
    <ComposerFieldShell>
      <CompactFieldLabel label="Title" required valueLength={draft.title.length} maxLength={TITLE_MAX_LENGTH} />
      <ComposerInput
        inputRef={titleInputRef}
        accessibilityLabel="Title, required"
        accessibilityHint={`Enter a short title for this post. Maximum ${TITLE_MAX_LENGTH} characters.`}
        value={draft.title}
        onChangeText={(title) => onChange({ title: title.slice(0, TITLE_MAX_LENGTH) })}
        placeholder="What is this creation about?"
      />
      {titleSuggestionHint ? <AppText variant="caption" color="muted">{titleSuggestionHint}</AppText> : null}
      <FieldErrorText message={detailErrors.title} />
    </ComposerFieldShell>
  );
  const textField = (
    <ComposerFieldShell>
      <CompactFieldLabel label="Post text" required valueLength={draft.contentText.length} maxLength={BODY_MAX_LENGTH} />
      <ComposerInput
        inputRef={contentInputRef}
        accessibilityLabel="Post text, required"
        accessibilityHint="Write the main text people will read in this post."
        value={draft.contentText}
        onChangeText={(contentText) => onChange({ contentText: contentText.slice(0, BODY_MAX_LENGTH) })}
        placeholder="Share a prompt, idea, breakdown, or useful note…"
        multiline
        minHeight={170}
      />
      <FieldErrorText message={detailErrors.content} />
    </ComposerFieldShell>
  );

  return (
    <View style={{ gap: 18 }}>
      {isMediaLocked ? (
        <StatusBlock
          tone="neutral"
          title="Creation media is fixed"
          body="This post stays connected to its generated media. The title, story, visibility, and recipe are yours to change."
        />
      ) : null}

      {!selectedGeneration && !isMediaLocked && !isEditMode ? (
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
          disabled={isMediaLocked}
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
            borderColor: theme.colors.borderSubtle,
            backgroundColor: pressed ? theme.colors.surfaceStrong : theme.colors.surface,
            paddingHorizontal: 14,
          })}
        >
          <Sparkles size={19} color={theme.colors.image} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <AppText variant="label">Made with <AppText variant="caption" color="faint">optional</AppText></AppText>
            <AppText variant="caption" color="muted" numberOfLines={1}>{attribution}</AppText>
          </View>
          <ChevronDown
            size={18}
            color={theme.colors.muted}
            style={{ transform: [{ rotate: isMadeWithOpen ? '180deg' : '0deg' }] }}
          />
        </Pressable>
        {isMadeWithOpen ? (
          <MadeWithSection
            rows={draft.madeWithRows}
            sourceTools={sourceTools}
            disabled={isMediaLocked || draft.mode === 'creation'}
            compactReadOnly={draft.mode === 'creation'}
            onUpdate={onUpdateMadeWith}
            onAdd={onAddMadeWith}
            onRemove={onRemoveMadeWith}
          />
        ) : null}
      </View> : null}

      {draft.mode !== 'text' ? <ComposerFieldShell>
        <CompactFieldLabel label="Story" optional valueLength={draft.caption.length} maxLength={BODY_MAX_LENGTH} />
        <ComposerInput
          accessibilityLabel="Story, optional"
          accessibilityHint={`Share the idea, process, or story behind this post. Maximum ${BODY_MAX_LENGTH} characters.`}
          value={draft.caption}
          onChangeText={(caption) => onChange({ caption: caption.slice(0, BODY_MAX_LENGTH) })}
          placeholder="Share the idea, process, or story behind it…"
          multiline
          minHeight={150}
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
  const theme = useAppTheme();
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
                borderColor: selected ? `${theme.colors.primary}aa` : theme.colors.borderSubtle,
                backgroundColor: selected ? `${theme.colors.primary}18` : pressed ? theme.colors.surfaceStrong : theme.colors.surface,
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

function PostResourcesPage({
  draft,
  selectedGeneration,
  isTemplateBacked,
  isEditMode,
  buyerCount,
  packageStatus,
  publishValidation,
  onResourceChange,
  onCreationPackageChange,
  onTogglePromptResource,
  onAddResource,
  onEditResource,
  onRemoveResource,
  onEditDetails,
}: {
  draft: PostComposerDraft;
  selectedGeneration: GenerationListItem | null;
  isTemplateBacked: boolean;
  /** Only the publish route copies a creation's references; an edit has no such step. */
  isEditMode: boolean;
  /** People who have the loaded recipe, paid or free (an edit's `resourceBundleBuyerCount`). */
  buyerCount: number;
  packageStatus: ReturnType<typeof getPostComposerPackageStatus>;
  publishValidation: PostComposerValidationResult;
  onResourceChange: (patch: Partial<PostComposerDraft['resource']>) => void;
  onCreationPackageChange: (patch: Partial<PostComposerDraft['creationPackage']>) => void;
  onTogglePromptResource: (enabled: boolean) => void;
  onAddResource: () => void;
  onEditResource: (id: string) => void;
  onRemoveResource: (id: string) => void;
  onEditDetails: () => void;
}) {
  const theme = useAppTheme();
  const resourceActive = draft.resource.accessMode !== 'none';
  const priceTokens = getPostComposerPriceTokens(draft.resource);
  // The checks that speak of the Recipe preview are said under it, live, as before.
  const previewError = !publishValidation.valid
    && (publishValidation.message === RECIPE_PREVIEW_REQUIRED_MESSAGE || publishValidation.message === RECIPE_PREVIEW_QUALITY_MESSAGE)
    ? publishValidation.message
    : undefined;
  // Only a new post's publish copies the creation's saved inputs.
  const includesCreationReferences = !isEditMode && willAttachGenerationReferences(selectedGeneration, draft);
  const cardCount = draft.resource.cards.length;
  const itemsLabel = cardCount === 0
    ? includesCreationReferences ? 'Creation references' : 'Add at least one item.'
    : `${cardCount} ${cardCount === 1 ? 'item' : 'items'}${includesCreationReferences ? ' and creation references' : ''}`;
  const buyersNote = describeRecipeBuyers(buyerCount);

  if (isTemplateBacked) {
    return (
      <View style={{ gap: 16 }}>
        <PostPublishSummary draft={draft} selectedGeneration={selectedGeneration} validation={publishValidation} onEditTitle={onEditDetails} />
        <StatusBlock
          title="Ready to publish"
          body="This template result shares final media only. Its private recipe remains protected."
          tone="neutral"
        />
      </View>
    );
  }

  return (
    <View style={{ gap: 18 }}>
      <PostPublishSummary draft={draft} selectedGeneration={selectedGeneration} validation={publishValidation} onEditTitle={onEditDetails} />
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <AppText heading variant="sectionTitle">Recipe</AppText>
          <AppText variant="caption" color="faint">Optional</AppText>
        </View>
        <AppText variant="bodySm" color="muted">
          Share reusable prompts, files, links, or guidance for free or for credits.
        </AppText>
      </View>

      <RecipeAccessCards value={draft.resource.accessMode} onChange={(accessMode) => onResourceChange({ accessMode })} />

      {/* The price sits where Paid is chosen (recipe audit A-F5): it was the last block of the step,
          below the fold, so tapping Paid changed nothing a creator could see. */}
      {draft.resource.accessMode === 'paid' ? (
        <ComposerFieldShell>
          <CompactFieldLabel label="Price in credits" required />
          <ComposerInput
            accessibilityLabel="Price in credits, required"
            accessibilityHint="Enter at least 10 credits, in steps of 10."
            value={draft.resource.priceTokens}
            onChangeText={(value) => {
              const priceTokens = value.replace(/[^0-9]/g, '');
              const numeric = Number.parseInt(priceTokens || '0', 10);
              onResourceChange({ priceTokens, priceUsd: String((Number.isFinite(numeric) ? numeric : 0) / 100) });
            }}
            placeholder="900"
            keyboardType="number-pad"
          />
          <AppText variant="caption" color="commerce">{getRecipeMoneyLine(priceTokens)}</AppText>
          <AppText variant="caption" color="muted">
            {'Before buying, people see your recipe preview and item titles — never what\'s inside.'}
          </AppText>
          <FieldErrorText message={getRecipePriceError(draft.resource)} />
        </ComposerFieldShell>
      ) : null}

      {resourceActive && selectedGeneration ? (
        <ComposerFieldShell>
          <CompactFieldLabel label="From this creation" optional />
          {hasGenerationReferences(selectedGeneration) && !isEditMode ? (
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
            body="Add the original generation prompt to the recipe."
            value={hasCreationPromptCard(draft.resource.cards, selectedGeneration)}
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
                <AppText variant="caption" color="muted">{itemsLabel}</AppText>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add item"
                onPress={onAddResource}
                style={({ pressed }) => ({
                  minHeight: 48,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 7,
                  borderRadius: 24,
                  paddingHorizontal: 14,
                  backgroundColor: pressed ? theme.colors.primaryFillPressed : theme.colors.primaryFill,
                })}
              >
                <Plus size={17} color={theme.colors.onPrimary} />
                <AppText variant="label" color="onPrimary">Add</AppText>
              </Pressable>
            </View>

            {/* A recipe people have is edited like any other (recipe audit S2): each save is a new
                version, and the people who have it keep theirs. */}
            {buyersNote ? (
              <View style={{ borderRadius: 14, backgroundColor: theme.colors.surfaceInset, paddingHorizontal: 12, paddingVertical: 10 }}>
                <AppText variant="caption" color="textSecondary">{buyersNote}</AppText>
              </View>
            ) : null}

            {cardCount > 0 ? (
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
            ) : includesCreationReferences ? null : (
              <Pressable
                accessibilityRole="button"
                onPress={onAddResource}
                style={({ pressed }) => ({
                  minHeight: 120,
                  borderRadius: 18,
                  borderWidth: 1,
                  borderStyle: 'dashed',
                  borderColor: pressed ? `${theme.colors.primary}aa` : theme.colors.border,
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 9,
                  backgroundColor: pressed ? theme.colors.surfaceStrong : theme.colors.surfaceInset,
                })}
              >
                <Package size={27} color={theme.colors.muted} />
                <AppText variant="label" color="muted">Add your first item</AppText>
              </Pressable>
            )}

            {includesCreationReferences ? (
              <CreationReferencesRow fileCount={countCreationReferenceFiles(selectedGeneration)} />
            ) : null}

            {/* Remix comes with any recipe on a post made from a creation (recipe audit S1): the
                "Allow direct remix" switch it replaces left Remix, and the prompt it hands over, free
                when it was off. */}
            {draft.mode === 'creation' ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 2 }}>
                <Repeat2 size={appTheme.icon.sm} color={theme.colors.workflow} />
                <AppText variant="caption" color="muted" style={{ flex: 1 }}>
                  Remix comes with this recipe: people who unlock it can remix your post.
                </AppText>
              </View>
            ) : null}
          </View>

          {/* One public text (recipe audit S6): "Public summary" and "Package preview" were two, and
              the optional one silently replaced the required one in listings. */}
          <ComposerFieldShell>
            <CompactFieldLabel label="Recipe preview" required valueLength={draft.resource.previewText.length} maxLength={RECIPE_PREVIEW_MAX_LENGTH} />
            <ComposerInput
              accessibilityLabel="Recipe preview, required"
              accessibilityHint={`Say what people get. Everyone sees this before unlocking. Maximum ${RECIPE_PREVIEW_MAX_LENGTH} characters.`}
              value={draft.resource.previewText}
              onChangeText={(previewText) => onResourceChange({ previewText: previewText.slice(0, RECIPE_PREVIEW_MAX_LENGTH) })}
              placeholder="Tell people what they will receive"
              maxLength={RECIPE_PREVIEW_MAX_LENGTH}
              multiline
              minHeight={82}
            />
            <AppText variant="caption" color="muted">Everyone sees this before unlocking.</AppText>
            <FieldErrorText message={previewError} />
          </ComposerFieldShell>

          <ReadinessRow label={packageStatus.label} body={packageStatus.body} state={packageStatus.state} />
        </>
      ) : null}
    </View>
  );
}

/**
 * The recipe's three choices as one radio group of equal cards, as the web's
 * `RecipeAccessCards` draws them on a phone (recipe audit A-F15): "No recipe"
 * was a plain row under two cards and read as a status line, not an option.
 */
const RECIPE_ACCESS_CHOICES: ReadonlyArray<{
  value: PostComposerDraft['resource']['accessMode'];
  label: string;
  body: string;
}> = [
  { value: 'free', label: 'Free recipe', body: 'Reward useful work' },
  { value: 'paid', label: 'Paid recipe', body: 'Set a credit price' },
  { value: 'none', label: 'No recipe', body: 'Just the post' },
];

function RecipeAccessCards({
  value,
  onChange,
}: {
  value: PostComposerDraft['resource']['accessMode'];
  onChange: (accessMode: PostComposerDraft['resource']['accessMode']) => void;
}) {
  const theme = useAppTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Recipe" style={{ gap: 8 }}>
      {RECIPE_ACCESS_CHOICES.map((choice) => {
        const checked = choice.value === value;
        const color = choice.value === 'free'
          ? theme.colors.workflow
          : choice.value === 'paid'
            ? theme.colors.commerce
            : theme.colors.textSecondary;
        return (
          <Pressable
            key={choice.value}
            accessibilityRole="radio"
            accessibilityLabel={`${choice.label}, ${choice.body}`}
            accessibilityState={{ checked, selected: checked }}
            onPress={() => {
              if (checked) return;
              haptic.select();
              onChange(choice.value);
            }}
            style={({ pressed }) => ({
              minHeight: 64,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              borderRadius: 18,
              borderCurve: 'continuous',
              borderWidth: 1,
              borderColor: checked ? hexWithAlpha(color, 0.6) : theme.colors.border,
              backgroundColor: checked ? hexWithAlpha(color, 0.09) : pressed ? theme.colors.surfaceStrong : theme.colors.surface,
              paddingVertical: 10,
              paddingLeft: 12,
              paddingRight: 14,
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: hexWithAlpha(color, 0.13) }}>
              {choice.value === 'free'
                ? <Sparkles size={appTheme.icon.sm} color={color} />
                : choice.value === 'paid'
                  ? <Lock size={appTheme.icon.sm} color={color} />
                  : <CircleMinus size={appTheme.icon.sm} color={color} />}
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <AppText variant="label">{choice.label}</AppText>
              <AppText variant="caption" color="muted">{choice.body}</AppText>
            </View>
            {/* The mark's slot is always kept, so choosing a card never moves its text. */}
            <View style={{ width: appTheme.icon.compact, alignItems: 'center' }}>
              {checked ? <Check size={appTheme.icon.compact} color={color} /> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * What "Include creation references" adds, drawn with the items (recipe audit
 * A-F9): the server copies the creation's saved inputs in at publish, so they
 * have no editor of their own; the toggle above takes them out again.
 */
function CreationReferencesRow({ fileCount }: { fileCount: number }) {
  const theme = useAppTheme();
  const files = `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;
  return (
    <View
      accessible
      accessibilityLabel={`Creation references · ${files}`}
      style={{
        minHeight: 72,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.surface,
        padding: 12,
      }}
    >
      <View style={{ width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceStrong }}>
        <ResourceTypeIcon type="reference_media" color={theme.colors.textSecondary} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <AppText variant="label" numberOfLines={1}>Creation references</AppText>
        <AppText variant="caption" color="muted" numberOfLines={1}>{`Reference media · ${files}`}</AppText>
      </View>
    </View>
  );
}

function PostPublishSummary({
  draft,
  selectedGeneration,
  validation,
  onEditTitle,
}: {
  draft: PostComposerDraft;
  selectedGeneration: GenerationListItem | null;
  validation: PostComposerValidationResult;
  onEditTitle?: () => void;
}) {
  const theme = useAppTheme();
  const title = draft.title.trim() || (onEditTitle ? 'Add a title' : 'Your post');
  const cover = draft.mediaItems[0]?.previewUrl
    || draft.mediaItems[0]?.uri
    || selectedGeneration?.previewUrl
    || selectedGeneration?.preview_url
    // A picture stands in for its own missing preview; a clip does not: an
    // image view handed one fetches the whole file to draw a frame at best.
    // A creation whose poster failed opens here now, so it gets the glyph.
    || (selectedGeneration && getPublishGenerationMediaKind(selectedGeneration) !== 'video'
      ? selectedGeneration.output_url
      : null)
    || null;
  const visibilityLabel = draft.visibility === 'public' ? 'Public' : 'Private';
  const resourceLabel = draft.resource.accessMode === 'paid'
    ? `Paid recipe · ${formatCreditAmount(getPostComposerPriceTokens(draft.resource))} credits`
    : draft.resource.accessMode === 'free'
      ? 'Free recipe'
      : 'No recipe';
  const ready = validation.valid;
  return (
    <View
      style={{
        borderRadius: 18,
        borderWidth: 1,
        borderColor: ready ? theme.semantic.success.border : theme.semantic.warning.border,
        backgroundColor: theme.colors.surface,
        padding: 14,
        gap: 12,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 58, height: 58, borderRadius: 15, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceStrong }}>
          {cover && draft.mode !== 'text' ? (
            <StableMediaImage
              url={cover}
              cacheKey={`post-review:${draft.selectedGenerationId ?? draft.mediaItems[0]?.id ?? 'cover'}`}
              contentFit="cover"
              style={{ width: 58, height: 58 }}
            />
          ) : (
            <FileText size={22} color={theme.colors.textSecondary} />
          )}
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {ready ? <Check size={17} color={theme.colors.success} /> : null}
            <AppText variant="label">{ready ? 'Ready to publish' : 'Needs attention'}</AppText>
          </View>
          {onEditTitle ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Edit title"
              onPress={onEditTitle}
              hitSlop={verticalHitSlop(20)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <AppText
                variant="bodySm"
                numberOfLines={1}
                color={draft.title.trim() ? 'text' : 'muted'}
                style={{ flexShrink: 1 }}
              >
                {title}
              </AppText>
              <Pencil size={16} color={theme.colors.textSecondary} />
            </Pressable>
          ) : (
            <AppText variant="bodySm" numberOfLines={1}>{title}</AppText>
          )}
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
          <View key={label} style={{ minHeight: 28, justifyContent: 'center', borderRadius: 14, backgroundColor: theme.colors.surfaceStrong, paddingHorizontal: 10 }}>
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
  const theme = useAppTheme();
  const typeLabel = POST_COMPOSER_RESOURCE_CARD_OPTIONS.find((option) => option.id === card.type)?.label ?? 'Item';
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
        borderColor: isPostComposerResourceCardReady(card) ? theme.colors.borderSubtle : theme.semantic.warning.border,
        backgroundColor: theme.colors.surface,
        padding: 12,
      }}
    >
      <View style={{ width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceStrong }}>
        <ResourceTypeIcon type={card.type} color={theme.colors.textSecondary} />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Edit ${card.title || typeLabel}`}
        onPress={onEdit}
        style={({ pressed }) => ({ flex: 1, minWidth: 0, gap: 3, opacity: pressed ? appTheme.opacity.pressed : 1 })}
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
        style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
      >
        <Trash2 size={18} color={theme.colors.danger} />
      </Pressable>
    </View>
  );
}

/**
 * One glyph per kind of item, none shared (recipe audit S8): the picker drew
 * three documents, three links and two boxes for nine kinds. Remix link takes
 * Remix's own glyph, as the reel's rail draws it.
 */
function ResourceTypeIcon({ type, color, size = appTheme.icon.default }: { type: PostComposerResourceCardType; color: string; size?: number }) {
  switch (type) {
    case 'prompt':
      return <ScrollText size={size} color={color} />;
    case 'reference_media':
      return <ImageIcon size={size} color={color} />;
    case 'settings':
      return <SlidersHorizontal size={size} color={color} />;
    case 'guide':
      return <BookOpen size={size} color={color} />;
    case 'workflow':
      return <Workflow size={size} color={color} />;
    case 'source_assets':
      return <FolderOpen size={size} color={color} />;
    case 'external_link':
      return <ExternalLink size={size} color={color} />;
    case 'remix_link':
      return <Repeat2 size={size} color={color} />;
    default:
      return <Shapes size={size} color={color} />;
  }
}

/**
 * The offer to put back whatever was just removed. It sits directly above the
 * footer rather than in the scroll, because Undo and redo asks that people can
 * see the result of the reversal — an offer that scrolls out of reach with the
 * form is an offer nobody takes.
 */
function ComposerUndoBar({
  entry,
  onUndo,
  onDismiss,
}: {
  entry: ComposerUndoEntry<PostComposerRemoval> | null;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const theme = useAppTheme();
  if (!entry) return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: appTheme.spacing.gap,
        marginHorizontal: appTheme.spacing.screen,
        marginBottom: appTheme.spacing.compact,
        paddingLeft: appTheme.spacing.card,
        paddingRight: appTheme.spacing.compact,
        paddingVertical: appTheme.spacing.compact,
        borderRadius: appTheme.radii.md,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.panelSoft,
      }}
    >
      <AppText variant="label" color="text" style={{ flex: 1, minWidth: 0 }} numberOfLines={1}>
        {describeComposerUndo(entry.label)}
      </AppText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={describeComposerUndoAction(entry.label)}
        onPress={onUndo}
        style={({ pressed }) => ({
          minHeight: appTheme.touch.compact,
          minWidth: 72,
          paddingHorizontal: appTheme.spacing.gap,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: appTheme.radii.sm,
          backgroundColor: pressed ? theme.colors.surfaceStrong : 'transparent',
        })}
      >
        <AppText variant="button" color="primary">Undo</AppText>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss undo"
        onPress={onDismiss}
        style={({ pressed }) => ({
          width: appTheme.touch.compact,
          height: appTheme.touch.compact,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? appTheme.opacity.pressed : 1,
        })}
      >
        <X size={appTheme.icon.sm} color={theme.colors.muted} />
      </Pressable>
    </View>
  );
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
  const theme = useAppTheme();
  const visibilityLabel = visibility === 'public' ? 'Public' : 'Private';
  const submitLabel = getPostComposerSubmitLabel({ visibility, isEditMode, isPending: loading });
  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: bottomInset + 10,
        borderTopWidth: 1,
        borderTopColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.background,
        boxShadow: theme.shadow.dock.boxShadow,
      }}
    >
      {step === 'details' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Next"
          onPress={onNext}
          style={({ pressed }) => ({
            minHeight: 54,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            borderRadius: 17,
            backgroundColor: pressed ? theme.colors.primaryFillPressed : theme.colors.primaryFill,
          })}
        >
          <AppText variant="button" color="onPrimary">Next</AppText>
          <ChevronRight size={19} color={theme.colors.onPrimary} />
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
              borderColor: theme.colors.border,
              backgroundColor: pressed ? theme.colors.surfaceStrong : theme.colors.surface,
            })}
          >
            <Globe2 size={17} color={theme.colors.textSecondary} />
            <AppText variant="label">{visibilityLabel}</AppText>
            <ChevronDown size={15} color={theme.colors.muted} />
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
              backgroundColor: theme.colors.primaryFill,
              opacity: disabled || loading ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            {loading ? <ActivityIndicator size="small" color={theme.colors.onPrimary} /> : null}
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
  const theme = useAppTheme();
  const options: Array<{ id: PostComposerDraft['visibility']; label: string; body: string }> = [
    { id: 'public', label: 'Public', body: 'Visible in Explore and your profile.' },
    { id: 'private', label: 'Private', body: 'Only you can see it in Studio.' },
  ];
  const drag = useSheetDismissDrag({ onDismiss: onClose, visible });
  const reducedMotion = useReducedMotion();
  return (
    <Modal visible={visible} transparent animationType={reducedMotion ? 'none' : 'fade'} presentationStyle="overFullScreen" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <SheetBackdrop drag={drag} color={theme.colors.overlayStrong} onPress={onClose} />
        <SheetPanel
          {...drag.contentPanHandlers}
          accessibilityViewIsModal
          style={[
            {
              borderTopLeftRadius: 28,
              borderTopRightRadius: 28,
              borderWidth: 1,
              borderBottomWidth: 0,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.panel,
              paddingHorizontal: 18,
              paddingBottom: bottomInset + 18,
              gap: 12,
            },
            drag.dragStyle,
          ]}
        >
          <SheetGrabber drag={drag} />
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
                borderColor: value === option.id ? `${theme.colors.primary}99` : theme.colors.borderSubtle,
                backgroundColor: value === option.id ? theme.colors.selected : pressed ? theme.colors.surfaceStrong : theme.colors.surface,
                padding: 12,
              })}
            >
              <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 1, borderColor: value === option.id ? theme.colors.primary : theme.colors.borderStrong, alignItems: 'center', justifyContent: 'center' }}>
                {value === option.id ? <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: theme.colors.primary }} /> : null}
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <AppText variant="label">{option.label}</AppText>
                <AppText variant="caption" color="muted">{option.body}</AppText>
              </View>
            </Pressable>
          ))}
        </SheetPanel>
      </View>
    </Modal>
  );
}

/** What the resource sheet draws that the composer drops or resets the moment it closes. */
type ResourceSheetContent = {
  mode: 'type' | 'editor';
  card: PostComposerResourceCardDraft | null;
  touched: PostComposerResourceCardTouched;
  isUploading: boolean;
  uploadProgress: ResourceUploadProgress | null;
  uploadError: string | null;
  canRetryUpload: boolean;
};

function sameResourceSheetContent(held: ResourceSheetContent | null, live: ResourceSheetContent) {
  return held !== null
    && held.mode === live.mode
    && held.card === live.card
    && held.touched === live.touched
    && held.isUploading === live.isUploading
    && held.uploadProgress === live.uploadProgress
    && held.uploadError === live.uploadError
    && held.canRetryUpload === live.canRetryUpload;
}

type ResourceComposerSheetProps = {
  mode: 'type' | 'editor' | null;
  card: PostComposerResourceCardDraft | null;
  /** The editor's fields the creator has typed in or left: their errors are drawn, no others. */
  touched: PostComposerResourceCardTouched;
  mediaItems: PostComposerMediaItem[];
  bottomInset: number;
  isUploading: boolean;
  uploadProgress: ResourceUploadProgress | null;
  uploadError: string | null;
  canRetryUpload: boolean;
  onRequestClose: () => void;
  onSave: () => void;
  onChooseType: (type: PostComposerResourceCardType) => void;
  onChange: (patch: Partial<PostComposerResourceCardDraft>) => void;
  onTouchField: (field: keyof PostComposerResourceCardTouched) => void;
  onPickFile: () => void;
  onPickPhotos: () => void;
  onRetryUpload: () => void;
  onCancelUpload: () => void;
  onRemoveAttachment: (id: string) => void;
};

/**
 * The sheet the Recipe step opens: first what kind of item to add, then its
 * editor.
 *
 * Through the overlay host, not a `Modal`, because the editor holds text
 * fields. As a Modal on Android it could not follow the keyboard. The area
 * around it lifted on React Native's event alone, after the keys had begun to
 * cover the Save row and 24dp short, and the panel was lifted whole instead of
 * shortened: its title, its Close button and the Resource title field went off
 * the top of the screen (Pixel 9a emulator, 2026-10-05). In the app's own
 * window the area follows the keyboard frame by frame, and the panel gives up
 * height to it: on Android it shortens to what the keyboard and the status bar
 * leave, its header and Save row stay where they can be pressed, and the
 * fields scroll between them; on iOS the panel stays and the scroll view makes
 * the room itself.
 *
 * Being an ordinary view, the sheet owns what a Modal gave for free: its
 * entrance and exit, Android's back key, and taking the keyboard from the page
 * as it opens.
 */
function ResourceComposerSheet({
  mode,
  card,
  touched,
  mediaItems,
  bottomInset,
  isUploading,
  uploadProgress,
  uploadError,
  canRetryUpload,
  onRequestClose,
  onSave,
  onChooseType,
  onChange,
  onTouchField,
  onPickFile,
  onPickPhotos,
  onRetryUpload,
  onCancelUpload,
  onRemoveAttachment,
}: ResourceComposerSheetProps) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const visible = mode !== null;
  // The composer drops the step and the card the moment the sheet closes, and
  // an upload's progress and error with them. The panel leaves showing what it
  // was showing: emptied as its exit began, it fell to the height of its title
  // in one frame, which is how the Modal left on the iPhone.
  const [held, setHeld] = useState<ResourceSheetContent | null>(null);
  const live: ResourceSheetContent | null = mode !== null
    ? { mode, card, touched, isUploading, uploadProgress, uploadError, canRetryUpload }
    : null;
  if (live && !sameResourceSheetContent(held, live)) setHeld(live);
  const shown = live ?? held;

  // Dismissing by drag goes through the same handler as the Close button, so
  // the unsaved-changes confirmation runs either way (Modality: get
  // confirmation before closing a modal view, gesture or button). The panel
  // takes a touch only once it is a pull: held from its start, as a sheet in a
  // Modal must, the touch is taken from the scroll view on Android at the
  // finger's next movement (see `takesTouchDown`).
  const drag = useSheetDismissDrag({ onDismiss: onRequestClose, visible, takesTouchDown: false });
  const presentation = useSheetPresentation({ visible, reducedMotion, onExited: () => setHeld(null) });
  // An overlay is an ordinary view: unlike a Modal it has no native claim on
  // Android's back key, so it takes one, and asks what the Close button asks.
  useHardwareBack(visible, onRequestClose);

  // The keyboard goes with whatever had it. Opening over a field of the page
  // takes the keyboard from it, as a Modal's window did by taking the focus;
  // closing puts the editor's own away as the sheet leaves rather than after
  // it has gone.
  const wasVisibleRef = useRef(visible);
  useEffect(() => {
    if (wasVisibleRef.current === visible) return;
    wasVisibleRef.current = visible;
    Keyboard.dismiss();
  }, [visible]);

  if (!shown) return null;
  const motion = sheetMotion(drag, presentation);

  return (
    <Overlay visible={presentation.rendered}>
      {/* Answered once: while the exit plays the sheet is still drawn, and a press on it must not land. */}
      <View pointerEvents={visible ? 'auto' : 'none'} style={{ flex: 1 }}>
        {/* The area ends under the status bar, so a panel that has to give up height to the keyboard never
            gives up its title to the clock. `reservedBottomInset`: the Save row and the list already keep
            that much clear of the screen's edge, and the keyboard covers the same strip. */}
        <KeyboardAvoidingArea
          iosScrollViewAdjustsInsets
          followsKeyboard={presentation.settled}
          reservedBottomInset={bottomInset}
          testID="resource-editor-keyboard-area"
          style={{ justifyContent: 'flex-end', paddingTop: insets.top + RESOURCE_SHEET_TOP_GAP }}
        >
          <SheetBackdrop drag={drag} style={motion.backdrop} color={theme.colors.overlayStrong} onPress={onRequestClose} />
          <SheetPanel
            {...drag.contentPanHandlers}
            accessibilityViewIsModal
            onLayout={presentation.onPanelLayout}
            style={[
              {
                maxHeight: Math.min(height * 0.9, 760),
                // The one thing between the header and the Save row that can give way is the scroll
                // view, and the panel has to be allowed to pass the keyboard's squeeze on to it.
                flexShrink: 1,
                borderTopLeftRadius: 28,
                borderTopRightRadius: 28,
                borderWidth: 1,
                borderBottomWidth: 0,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.panel,
                overflow: 'hidden',
              },
              motion.panel,
            ]}
          >
            <ResourceComposerContent
              drag={drag}
              {...shown}
              mediaItems={mediaItems}
              bottomInset={bottomInset}
              onRequestClose={onRequestClose}
              onSave={onSave}
              onChooseType={onChooseType}
              onChange={onChange}
              onTouchField={onTouchField}
              onPickFile={onPickFile}
              onPickPhotos={onPickPhotos}
              onRetryUpload={onRetryUpload}
              onCancelUpload={onCancelUpload}
              onRemoveAttachment={onRemoveAttachment}
            />
          </SheetPanel>
        </KeyboardAvoidingArea>
      </View>
    </Overlay>
  );
}

/** What the item sheet's panel holds: its title row, then the list of kinds or the editor. */
function ResourceComposerContent({
  drag,
  mode,
  card,
  touched,
  mediaItems,
  bottomInset,
  isUploading,
  uploadProgress,
  uploadError,
  canRetryUpload,
  onRequestClose,
  onSave,
  onChooseType,
  onChange,
  onTouchField,
  onPickFile,
  onPickPhotos,
  onRetryUpload,
  onCancelUpload,
  onRemoveAttachment,
}: Omit<ResourceComposerSheetProps, 'mode'> & { drag: SheetDismissDrag; mode: 'type' | 'editor' }) {
  const theme = useAppTheme();
  // Four kinds first, the other five under "More types" (recipe audit S8).
  const [showMoreTypes, setShowMoreTypes] = useState(false);
  const option = card ? POST_COMPOSER_RESOURCE_CARD_OPTIONS.find((candidate) => candidate.id === card.type) : null;
  const textType = card?.type === 'prompt' || card?.type === 'settings' || card?.type === 'guide' || card?.type === 'other';
  const linkType = card?.type === 'external_link' || card?.type === 'remix_link' || card?.type === 'workflow';
  const fileType = card?.type === 'reference_media'
    || card?.type === 'source_assets'
    || card?.type === 'workflow'
    || card?.type === 'other'
    // Older sections can combine a prompt/guide/settings item with files. Keep
    // those hydrated uploads visible and removable even though the card's
    // inferred primary type is text-oriented.
    || Boolean(card?.attachments.length);
  // Pictures and videos come from the photo library as well as from Files
  // (recipe audit H6): on an iPhone the document picker opens Files alone.
  const offersPhotoLibrary = card?.type === 'reference_media' || card?.type === 'source_assets' || card?.type === 'other';
  const cardErrors = card ? getVisiblePostComposerResourceCardErrors(card, touched) : {};
  const saveHint = card ? getPostComposerResourceCardSaveHint(card, touched) : null;
  const isReady = card ? isPostComposerResourceCardReady(card) : false;
  const textLabel = card?.type === 'prompt'
    ? 'Prompt or script'
    : card?.type === 'settings'
      ? 'Settings'
      : card?.type === 'guide'
        ? 'Guide or notes'
        : 'Content';
  const textRequired = !fileType || (card?.attachments.length ?? 0) === 0;
  const linkLabel = card?.type === 'remix_link' ? 'Remix URL' : card?.type === 'workflow' ? 'Workflow link' : 'URL';
  const linkRequired = card?.type !== 'workflow' || (card?.attachments.length ?? 0) === 0;
  const legacyTitle = card?.publicTitleIntent === 'legacy_private';
  const typeRow = (type: PostComposerResourceCardType) => {
    const resourceOption = POST_COMPOSER_RESOURCE_CARD_OPTIONS.find((candidate) => candidate.id === type);
    if (!resourceOption) return null;
    return (
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
          borderColor: theme.colors.borderSubtle,
          backgroundColor: pressed ? theme.colors.surfaceStrong : theme.colors.surface,
          padding: 12,
        })}
      >
        <View style={{ width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceStrong }}>
          <ResourceTypeIcon type={resourceOption.id} color={theme.colors.textSecondary} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <AppText variant="label">{resourceOption.label}</AppText>
          <AppText variant="caption" color="muted" numberOfLines={2}>{resourceOption.body}</AppText>
        </View>
        <ChevronRight size={18} color={theme.colors.faint} />
      </Pressable>
    );
  };

  return (
    <>
      <View style={{ paddingHorizontal: 18 }}>
        <SheetGrabber drag={drag} />
        {/* The title takes a pull as the grabber does, wherever the body is scrolled to. The panel's own
            drag waits for the body to be at its top, so a pull from here did nothing once it had scrolled. */}
        <View {...drag.panHandlers} style={{ minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <AppText heading variant="sectionTitle">{mode === 'type' ? 'Add an item' : option?.label ?? 'Edit item'}</AppText>
            <AppText variant="caption" color="muted">
              {mode === 'type'
                ? 'Choose what people will receive.'
                : isUploading
                  ? 'Keep this editor open while the file uploads.'
                  : 'Contents stay protected until unlock.'}
            </AppText>
          </View>
          <HeaderIconButton label="Close item editor" icon="close" onPress={onRequestClose} />
        </View>
      </View>

      {mode === 'type' ? (
        <ScrollView
          {...drag.scrollProps}
          keyboardShouldPersistTaps="never"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: bottomInset + 20, gap: 9 }}
        >
          {POST_COMPOSER_PRIMARY_RESOURCE_CARD_TYPES.map(typeRow)}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="More types"
            accessibilityHint="Shows the workflow, source assets, link, remix link and other kinds of item."
            accessibilityState={{ expanded: showMoreTypes }}
            onPress={() => setShowMoreTypes((current) => !current)}
            style={({ pressed }) => ({
              minHeight: 56,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              borderRadius: 17,
              paddingHorizontal: 12,
              paddingVertical: 8,
              backgroundColor: pressed ? theme.colors.surfaceStrong : 'transparent',
            })}
          >
            <View style={{ width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceInset }}>
              <Ellipsis size={appTheme.icon.default} color={theme.colors.textSecondary} />
            </View>
            <AppText variant="label" color="textSecondary" style={{ flex: 1 }}>More types</AppText>
            <ChevronDown
              size={18}
              color={theme.colors.faint}
              style={{ transform: [{ rotate: showMoreTypes ? '180deg' : '0deg' }] }}
            />
          </Pressable>
          {showMoreTypes ? POST_COMPOSER_MORE_RESOURCE_CARD_TYPES.map(typeRow) : null}
        </ScrollView>
      ) : card ? (
        <>
          <ScrollView
            {...drag.scrollProps}
            automaticallyAdjustKeyboardInsets
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: bottomInset + 24, gap: 14 }}
          >
            <ComposerFieldShell>
              <CompactFieldLabel label="Item title" required valueLength={card.title.length} maxLength={80} />
              <ComposerInput
                accessibilityLabel="Item title, required"
                accessibilityHint={legacyTitle
                  ? 'This older title stays private unless you edit it. Once edited, everyone sees it before unlocking.'
                  : 'Everyone sees this title before unlocking. Maximum 80 characters.'}
                value={card.title}
                onChangeText={(title) => onChange({
                  title: title.slice(0, 80),
                  publicTitleIntent: 'explicit',
                })}
                onBlur={() => onTouchField('title')}
                placeholder={option?.label ?? 'Item title'}
              />
              {/* Item titles are public before unlock (recipe audit A-F6); the app said so only to a screen reader. */}
              {legacyTitle ? (
                <AppText variant="caption" color="muted">
                  This older title stays private. Editing it shows the new title to everyone before unlocking.
                </AppText>
              ) : (
                <AppText variant="caption" color="muted">Everyone sees this before unlocking.</AppText>
              )}
              <FieldErrorText message={cardErrors.title} />
              <CompactFieldLabel label="Note shown after unlock" optional valueLength={card.preview.length} maxLength={120} />
              <ComposerInput
                accessibilityLabel="Note shown after unlock, optional"
                accessibilityHint="A short note people see with this item once they unlock the recipe. Maximum 120 characters."
                value={card.preview}
                onChangeText={(preview) => onChange({ preview: preview.slice(0, 120) })}
                placeholder="How to use it, what to change"
                multiline
                minHeight={66}
              />
            </ComposerFieldShell>

            {textType ? (
              <ComposerFieldShell>
                <CompactFieldLabel label={textLabel} required={textRequired} optional={!textRequired} />
                <ComposerInput
                  accessibilityLabel={`${textLabel}, ${textRequired ? 'required' : 'optional'}`}
                  accessibilityHint="This protected content is revealed only after the recipe is unlocked."
                  value={card.textContent}
                  onChangeText={(textContent) => onChange({ textContent })}
                  onBlur={() => onTouchField('content')}
                  placeholder="This content is revealed only after unlock"
                  multiline
                  minHeight={150}
                />
                <FieldErrorText message={cardErrors.content} />
              </ComposerFieldShell>
            ) : null}

            {linkType ? (
              <ComposerFieldShell>
                <CompactFieldLabel label={linkLabel} required={linkRequired} optional={!linkRequired} />
                <ComposerInput
                  accessibilityLabel={`${linkLabel}, ${linkRequired ? 'required' : 'optional'}`}
                  accessibilityHint="Enter the protected destination URL."
                  value={card.externalUrl}
                  onChangeText={(externalUrl) => onChange({ externalUrl })}
                  onBlur={() => onTouchField('content')}
                  placeholder="https://"
                  autoCapitalize="none"
                  keyboardType="url"
                />
                <FieldErrorText message={cardErrors.content} />
                {card.type === 'remix_link' ? <AppText variant="caption" color="muted">The link stays hidden until the recipe is unlocked.</AppText> : null}
              </ComposerFieldShell>
            ) : null}

            {fileType ? (
              <ComposerFieldShell>
                <CompactFieldLabel label={card.type === 'reference_media' ? 'Reference files' : card.type === 'workflow' ? 'Workflow files' : 'Files'} optional={card.type === 'workflow' || card.type === 'other'} required={card.type === 'reference_media' || card.type === 'source_assets'} />
                {card.attachments.map((attachment) => (
                  <View key={attachment.id} style={{ minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 14, backgroundColor: theme.colors.surfaceInset, paddingHorizontal: 11 }}>
                    <FileText size={17} color={theme.colors.textSecondary} />
                    <AppText variant="caption" numberOfLines={1} style={{ flex: 1 }}>{attachment.label}</AppText>
                    <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${attachment.label}`} onPress={() => onRemoveAttachment(attachment.id)} style={({ pressed }) => ({ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}>
                      <X size={17} color={theme.colors.danger} />
                    </Pressable>
                  </View>
                ))}
                {offersPhotoLibrary ? (
                  // Side by side where they fit, one above the other on a narrow phone or at a large text size.
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}>
                    <ResourceFilePickButton
                      label="Photo library"
                      icon={<Images size={appTheme.icon.sm} color={theme.colors.textSecondary} />}
                      disabled={isUploading}
                      onPress={onPickPhotos}
                    />
                    <ResourceFilePickButton
                      label="Files"
                      icon={<FolderOpen size={appTheme.icon.sm} color={theme.colors.textSecondary} />}
                      disabled={isUploading}
                      onPress={onPickFile}
                    />
                  </View>
                ) : (
                  <ResourceFilePickButton
                    label="Add file"
                    icon={<Upload size={appTheme.icon.sm} color={theme.colors.textSecondary} />}
                    disabled={isUploading}
                    onPress={onPickFile}
                  />
                )}
                {/* Said before anything is picked: the limit was told only by a refused upload. */}
                <AppText variant="caption" color="muted">{RESOURCE_FILE_SIZE_LIMIT_LABEL}</AppText>
                {isUploading ? (
                  <View
                    accessible
                    accessibilityLabel="File upload progress"
                    accessibilityRole="progressbar"
                    accessibilityValue={{ min: 0, max: 100, now: uploadProgress?.percent ?? 0 }}
                    style={{ gap: 9 }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <AppText variant="caption" color="muted">
                        {uploadProgress
                          ? uploadProgress.fileCount > 1
                            ? `Uploading ${uploadProgress.fileIndex + 1} of ${uploadProgress.fileCount} · ${uploadProgress.percent}%`
                            : `Uploading file · ${uploadProgress.percent}%`
                          : 'Preparing file…'}
                      </AppText>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Cancel file upload"
                        onPress={onCancelUpload}
                        style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
                      >
                        <AppText variant="caption" color="danger">Cancel</AppText>
                      </Pressable>
                    </View>
                    <View style={{ height: 5, overflow: 'hidden', borderRadius: 3, backgroundColor: theme.colors.borderSubtle }}>
                      <View
                        style={{
                          width: `${uploadProgress?.percent ?? 0}%`,
                          height: '100%',
                          borderRadius: 3,
                          backgroundColor: theme.colors.primary,
                        }}
                      />
                    </View>
                    {uploadProgress && uploadProgress.totalBytes > 0 ? (
                      <AppText variant="caption" color="faint">
                        {`${formatUploadBytes(uploadProgress.bytesSent)} of ${formatUploadBytes(uploadProgress.totalBytes)}`}
                      </AppText>
                    ) : null}
                  </View>
                ) : uploadError ? (
                  <View
                    accessibilityLiveRegion="polite"
                    style={{ gap: 8, borderRadius: 14, backgroundColor: `${theme.colors.danger}12`, padding: 11 }}
                  >
                    <AppText variant="label" color="danger">Could not add file</AppText>
                    <AppText variant="caption" color="muted">{uploadError}</AppText>
                    {canRetryUpload ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Retry file upload"
                        onPress={onRetryUpload}
                        style={({ pressed }) => ({ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
                      >
                        <AppText variant="caption" color="primary">Retry upload</AppText>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
                {!linkType && !textType ? <FieldErrorText message={cardErrors.content} /> : null}
              </ComposerFieldShell>
            ) : null}

            {mediaItems.length > 1 ? (
              <ResourceScopePicker card={card} mediaItems={mediaItems} onChange={onChange} />
            ) : null}
          </ScrollView>
          <View style={{ paddingHorizontal: 18, paddingTop: 10, paddingBottom: bottomInset + 12, gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle }}>
            {/* What the item still needs, said plainly until its field is touched (recipe audit A-F14). */}
            {saveHint && !isUploading ? (
              <AppText variant="caption" color="muted" style={{ textAlign: 'center' }}>{saveHint}</AppText>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save item"
              accessibilityState={{ disabled: !isReady || isUploading }}
              disabled={!isReady || isUploading}
              onPress={() => {
                Keyboard.dismiss();
                onSave();
              }}
              style={({ pressed }) => ({
                minHeight: 54,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 17,
                backgroundColor: theme.colors.primaryFill,
                opacity: !isReady || isUploading ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <AppText variant="button" color="onPrimary">Save item</AppText>
            </Pressable>
          </View>
        </>
      ) : null}
    </>
  );
}

/** One of the item editor's file buttons: Photo library, Files, or Add file where there is one way. */
function ResourceFilePickButton({
  label,
  icon,
  disabled,
  onPress,
}: {
  label: string;
  icon: ReactNode;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexGrow: 1,
        flexBasis: 140,
        minHeight: 50,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        borderRadius: 15,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: theme.colors.border,
        backgroundColor: pressed ? theme.colors.surfaceStrong : theme.colors.surfaceInset,
        paddingHorizontal: 10,
        opacity: disabled ? appTheme.opacity.disabled : 1,
      })}
    >
      {icon}
      <AppText variant="label" color="textSecondary" numberOfLines={1}>{label}</AppText>
    </Pressable>
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
  const theme = useAppTheme();
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
          borderColor: card.appliesToAll ? `${theme.colors.image}99` : theme.colors.border,
          backgroundColor: card.appliesToAll ? `${theme.colors.image}16` : pressed ? theme.colors.surfaceStrong : theme.colors.surfaceInset,
          paddingHorizontal: 12,
        })}
      >
        <Check size={17} color={card.appliesToAll ? theme.colors.image : theme.colors.faint} />
        <AppText variant="label">All outputs</AppText>
      </Pressable>
      <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 9 }}>
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
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <View style={{ height: 82, borderRadius: 13, overflow: 'hidden', borderWidth: selected ? 2 : 1, borderColor: selected ? theme.colors.image : theme.colors.border, backgroundColor: theme.colors.surfaceInset }}>
                {item.mediaKind === 'image' ? (
                  <StableMediaImage url={item.previewUrl ?? item.uri} cacheKey={`scope:${mediaKey}`} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
                ) : (
                  <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Play size={24} color={theme.colors.textSecondary} /></View>
                )}
                {selected ? (
                  <View style={{ position: 'absolute', top: 5, right: 5, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.image }}>
                    <Check size={13} color={theme.colors.textInverse} />
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

// Matches the inference the web composer applies to a freshly uploaded
// attachment, so the same file produces the same resource type on both clients.
function inferResourceAttachmentType(contentType: string | null): PostResourceItemType {
  if (contentType?.startsWith('image/')) return 'reference_image';
  if (contentType?.startsWith('video/')) return 'reference_video';
  if (contentType?.startsWith('audio/')) return 'reference_audio';
  return 'source_file';
}

/** What the item editor says when an upload is cancelled, with what Retry would send. */
function describeCancelledResourceUpload(remaining: number) {
  return remaining > 1
    ? `Upload cancelled. You can retry the ${remaining} files left.`
    : 'Upload cancelled. You can retry the selected file.';
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

// Posting is creating: the community rules come first (`ContentPolicyGate`),
// and the composer's drafts and uploads start only once they are accepted.
export default function NewPostScreen() {
  return (
    <ContentPolicyGate chrome="headerless">
      <NewPostComposer />
    </ContentPolicyGate>
  );
}

function NewPostComposer() {
  const theme = useAppTheme();
  const { user, isLoading: authLoading, api } = useAuth();
  const queryClient = useQueryClient();
  const claimIdentity = useClaimPublicIdentity();
  const navigation = useNavigation();
  const params = useLocalSearchParams<{
    generationId?: string;
    postId?: string;
    focus?: string;
    shareAfterPublish?: string;
  }>();
  const generationId = params.generationId;
  const postId = params.postId;
  const focusTarget = Array.isArray(params.focus) ? params.focus[0] : params.focus;
  // Set when the viewer reached this screen by tapping Share on something that
  // was not public yet. Publishing is the real action; the share sheet follows.
  const shareAfterPublish = (Array.isArray(params.shareAfterPublish)
    ? params.shareAfterPublish[0]
    : params.shareAfterPublish) === '1';

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
  const [message, setMessage] = useState<{
    tone: 'danger' | 'success' | 'neutral';
    title: string;
    body?: string;
    /** A way on from the message, drawn as a button under it. */
    action?: 'complete-profile';
  } | null>(null);
  const [detailErrors, setDetailErrors] = useState<PostComposerDetailErrors>({});
  // A public post needs a claimed handle and a display name. Read up front, so
  // step 2 asks for them and the post saves them first, instead of the server
  // refusing it once the media is up.
  const profileQuery = useQuery({
    queryKey: profileQueryKey(user?.id),
    enabled: Boolean(user),
    queryFn: api.getProfile,
    staleTime: 1000 * 60 * 5,
  });
  // The fields follow the profile and the sign-in until the creator types.
  const [identityEdits, setIdentityEdits] = useState<PublicIdentityDraft | null>(null);
  const [identitySaveErrors, setIdentitySaveErrors] = useState<PublicIdentityErrors>({});
  const [isSavingIdentity, setIsSavingIdentity] = useState(false);
  // The card's two fields and the scroll content they are measured against,
  // and what the last refused save of them brings into view once it is drawn:
  // the refused field, or the top of the page for the banner.
  const displayNameFieldRef = useRef<View>(null);
  const usernameFieldRef = useRef<View>(null);
  const scrollContentRef = useRef<View>(null);
  const pendingIdentityRevealRef = useRef<View | 'top' | null>(null);
  const [identityRefusalCount, setIdentityRefusalCount] = useState(0);
  const identity = identityEdits ?? getInitialPublicIdentity(profileQuery.data, user);
  const needsPublicIdentity = draft.visibility === 'public'
    && Boolean(profileQuery.data)
    && !isPublicIdentityReady(profileQuery.data);
  const identityProblems = needsPublicIdentity ? validatePublicIdentity(identity, profileQuery.data?.username) : {};
  const [isPickingMedia, setIsPickingMedia] = useState(false);
  const [isRecoveringDraftMedia, setIsRecoveringDraftMedia] = useState(false);
  const [isPickingResourceFile, setIsPickingResourceFile] = useState(false);
  const [resourceUploadProgress, setResourceUploadProgress] = useState<ResourceUploadProgress | null>(null);
  const [resourceUploadError, setResourceUploadError] = useState<string | null>(null);
  const [pendingResourceUpload, setPendingResourceUpload] = useState<PendingResourceUpload | null>(null);
  const [hasPrefilledEdit, setHasPrefilledEdit] = useState(false);
  const [hasHydratedPersistedDraft, setHasHydratedPersistedDraft] = useState(false);
  const [composerStep, setComposerStep] = useState<'details' | 'resources'>('details');
  const [isMadeWithOpen, setIsMadeWithOpen] = useState(false);
  const [resourceSheetMode, setResourceSheetMode] = useState<'type' | 'editor' | null>(null);
  const [editingResourceId, setEditingResourceId] = useState<string | null>(null);
  const [resourceEditorCard, setResourceEditorCard] = useState<PostComposerResourceCardDraft | null>(null);
  const [resourceEditorOriginal, setResourceEditorOriginal] = useState<PostComposerResourceCardDraft | null>(null);
  // The editor's fields the creator has typed in or left (recipe audit A-F14): only their errors are drawn.
  const [resourceEditorTouched, setResourceEditorTouched] = useState<PostComposerResourceCardTouched>({});
  const [isVisibilityOpen, setIsVisibilityOpen] = useState(false);
  const [isNavigationAllowed, setIsNavigationAllowed] = useState(false);
  const [pendingPublishVisibility, setPendingPublishVisibility] = useState<PostComposerDraft['visibility'] | null>(null);
  const [mediaUploadProgress, setMediaUploadProgress] = useState<MediaUploadBatchProgress | null>(null);
  // Separate from the pick banner: the two can run concurrently, and sharing one
  // slot made the numbers incoherent and let whichever finished first blank the
  // other's banner (and its Cancel button) mid-transfer.
  const [recoveryUploadProgress, setRecoveryUploadProgress] = useState<MediaUploadBatchProgress | null>(null);
  const [pendingRetryMedia, setPendingRetryMedia] = useState<ImagePickerAsset[]>([]);
  // Undo and redo: every removal below is instant, so each one leaves what it
  // took here and offers it back for a moment.
  const [undoEntry, setUndoEntry] = useState<ComposerUndoEntry<PostComposerRemoval> | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const scrollYRef = useRef(0);
  const mediaControlRef = useRef<View>(null);
  const titleInputRef = useRef<TextInput>(null);
  const contentInputRef = useRef<TextInput>(null);
  const mediaUploadAbortRef = useRef<AbortController | null>(null);
  const resourceUploadAbortRef = useRef<AbortController | null>(null);
  /**
   * Every in-flight upload controller. Draft recovery and normal media picking
   * can overlap -- the picker blocks on the OS sheet while a resumed draft
   * starts re-uploading -- and a single ref meant whichever finished first
   * nulled it, leaving Cancel and the unmount abort as no-ops on the other.
   */
  const activeUploadControllersRef = useRef<Set<AbortController>>(new Set());
  const mediaUploadIdRef = useRef(0);
  // The title the post carried when the edit prefill loaded it. Fed into every
  // validation call so a pre-limit title is grandfathered exactly like the
  // server does; stays null for new posts, where nothing is grandfathered.
  const initialTitleRef = useRef<string | null>(null);
  const initialDraftSignatureRef = useRef<string | null>(null);
  // An edit save that sends media re-inserts every media row of the post under a
  // new id, and can go through and still fail. From then on the ids the draft
  // holds may name rows that are gone, so every later save reads the rows back
  // first (`readBackSavedMedia`): past the client's deadline the server can still
  // be finishing, and a retry that read the rows before it did is refused once it
  // has, which a read on the next press puts right.
  const savedMediaIdsStaleRef = useRef(false);
  const draftStorageId = user ? getPostComposerDraftStorageId({
    userId: user.id,
    postId,
    generationId,
  }) : null;

  const postQuery = useQuery({
    queryKey: ['post-edit', postId],
    enabled: Boolean(user && postId),
    queryFn: () => api.getOwnerPost(postId!),
    // The prefill runs once, from whatever copy is in hand. A saved edit goes
    // back to the screen that opened the editor, where Edit is one tap away, so
    // a copy kept past this screen would reopen it on the values before the save.
    gcTime: 0,
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
  const isMediaLocked = isEditMode && isGenerationBacked;
  // People who have the loaded recipe. A recipe they have is edited like any other (recipe audit S2):
  // `hasPaidOrders`, which froze it, is always false from the server now and is not read.
  const recipeBuyerCount = postQuery.data?.post?.resourceBundleBuyerCount ?? 0;
  const canSubmit = !isPickingMedia
    && !isPickingResourceFile
    // A publish racing draft-media recovery would submit a reclaimed path and
    // fail with the opaque server error recovery exists to prevent.
    && !isRecoveringDraftMedia
    && (!isEditMode || (postQuery.isSuccess && hasPrefilledEdit));
  const sourceTools = sourceToolsQuery.data?.tools ?? [];
  const packageStatus = useMemo(
    () => getPostComposerPackageStatus(draft, selectedGeneration),
    [draft, selectedGeneration]
  );
  const publishValidation = useMemo(
    () => validateCurrentDraft(draft, selectedGeneration, isEditMode, isEditMode && isGenerationBacked, { grandfatheredTitle: initialTitleRef.current }),
    [draft, isEditMode, isGenerationBacked, selectedGeneration]
  );
  const hasUnsavedChanges = hasHydratedPersistedDraft && (
    isEditMode || Boolean(generationId)
      ? initialDraftSignatureRef.current !== null
        && getPostComposerDraftSignature(draft) !== initialDraftSignatureRef.current
      : isPostComposerDraftMeaningful(draft)
  );

  useEffect(() => () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  }, []);

  // Prefill when generationId is provided and the creations list resolves.
  // A named creation opens before its grid derivative is ready, or after that
  // job failed: the server publishes any succeeded run with output.
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
            title: current.title || getCreationPostTitleSuggestion(found, current.resource.accessMode).title,
            contentText: '',
            sourceTool: 'Magicbooklet',
            sourceToolSlug: 'magicbooklet',
            madeWithRows: [buildCreationMadeWithRow(found.model)],
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
      const hydratedResourceCards = resourceBundleInput
        ? hydratePostComposerResourceCards(resourceBundleInput)
        : [];
      // rawTitle, never the display title: the read API substitutes "Untitled
      // post" for an empty title, and echoing that back on save trips the
      // marketplace placeholder gate. A '' grandfathered title also tells
      // validation the post may stay untitled until its author names it.
      const loadedTitle = post.rawTitle ?? (post.title || '');

      initialTitleRef.current = post.rawTitle ?? (post.title || null);
      setDraft({
        mode,
        proofMode: mode === 'text' ? 'text' : 'media',
        title: loadedTitle,
        description: post.description || '',
        contentText: mode === 'text' ? post.body || '' : '',
        // The Story is the body. A description is the web's separate Explore
        // field: copying it into the Story turned a media post into a mixed one
        // on its first save here and showed the same text twice on the web.
        caption: mode === 'text' ? '' : post.body || '',
        // A post with no tool opens with none: a "Manual" filled in here was
        // sent with the save and printed "Made with Manual" under it.
        sourceTool: post.sourceTool || '',
        sourceToolSlug: post.sourceToolSlug || '',
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
          : post.sourceTool
            ? [createMadeWithRow({ toolLabel: post.sourceTool, toolSlug: post.sourceToolSlug || '' })]
            : [createMadeWithRow()],
        category: post.category || 'image',
        // An old unlisted post opens as the private post its save stores. Share
        // on a post that is not public opens it here to publish it, and only a
        // public result is shared: left on Private, a save dropped the share.
        visibility: shareAfterPublish ? 'public' : getComposerVisibility(post.visibility),
        isNsfw: post.isNsfw === true,
        selectedGenerationId: post.generationId || null,
        upload: post.mediaUrl ? {
          uri: post.mediaUrl,
          name: post.title || 'media',
          type: post.mediaKind === 'video' ? 'video/mp4' : 'image/jpeg',
        } : null,
        mediaItems: hydratePostComposerMediaItems(post),
        // "Include exact prompt" reads the loaded cards (`hasCreationPromptCard`),
        // and an edit attaches no creation references: only the publish route
        // copies them, so the editor does not offer them.
        creationPackage: getDefaultCreationPackageDraft(),
        // One Recipe preview, starting from the summary listings showed first (recipe audit S6).
        resource: resourceBundleInput ? foldRecipeSummaryIntoPreview({
          accessMode: resourceBundleInput.accessMode || 'none',
          cardAuthoringMode: 'cards',
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
          cards: hydratedResourceCards,
          allowRemix: hydratePostComposerAllowRemix(resourceBundleInput),
          summary: resourceBundleInput.summary || '',
          previewText: resourceBundleInput.previewText || '',
          // Both from the stored price, else both the default: '9' beside '100'
          // showed 100 tokens and saved 900 through the legacy-USD rule.
          priceUsd: resourceBundleInput.priceUsdCents ? String(resourceBundleInput.priceUsdCents / 100) : '9',
          priceTokens: resourceBundleInput.priceUsdCents ? String(resourceBundleInput.priceUsdCents) : '900',
        }) : getDefaultResourceDraft(),
      });
      setHasPrefilledEdit(true);
    }
  }, [postId, postQuery.data, hasPrefilledEdit, shareAfterPublish]);

  useEffect(() => () => {
    for (const controller of activeUploadControllersRef.current) {
      controller.abort();
    }
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

    void loadPersistedPostComposerDraft(draftStorageId!).then(async (persisted) => {
      if (!active) return;
      if (persisted) {
        const keptDraft: PostComposerDraft = {
          ...persisted.draft,
          // An older build could save a draft as unlisted, which is private now.
          // Opened from Share, the post is being published, as in the prefill.
          visibility: shareAfterPublish && isEditMode ? 'public' : getComposerVisibility(persisted.draft.visibility),
          // Drafts saved by older builds can carry duplicate card ids; dedupe
          // them before they become React keys and edit/remove targets. Their
          // summary, a field the composer no longer has, becomes the one preview.
          resource: foldRecipeSummaryIntoPreview(sanitizePostComposerResourceCardIds(
            migratePostComposerResourceDraftToCards(persisted.draft.resource),
          )),
          // A creation's Made with is locked to the row publishing stores, so it
          // is the creation's, never the kept one: older builds kept the
          // model's id there.
          ...(generationId && explicitGeneration && !isEditMode
            ? { madeWithRows: [buildCreationMadeWithRow(explicitGeneration.model)] }
            : {}),
        };
        // A kept edit names its media by the ids from when it was kept, and a
        // save since then (one that went through and then failed included)
        // re-inserted every row under a new id. Only a post whose saves send
        // media is checked: one made from a creation keeps the creation's.
        const editedPost = isEditMode && !postQuery.data?.post?.generationId ? postQuery.data?.post : undefined;
        const deviceFiles = editedPost ? await findDeviceFiles(keptDraft.mediaItems) : new Set<string>();
        if (!active) return;
        const { draft: restoredDraft, lost: lostOnRestore } = editedPost
          ? withSavedPostMedia(keptDraft, editedPost, (uri) => deviceFiles.has(uri))
          : { draft: keptDraft, lost: [] as PostComposerMediaItem[] };
        const details = getPostComposerDetailErrors(restoredDraft, { grandfatheredTitle: initialTitleRef.current });
        const canOpenReview = Object.keys(details).length === 0;
        setDraft(restoredDraft);
        setComposerStep(persisted.step === 'resources' && canOpenReview ? 'resources' : 'details');
        setDetailErrors(canOpenReview ? {} : details);
        const lostMessage = describeLostRecoveryMedia(lostOnRestore);
        setMessage(lostMessage
          ? { tone: 'danger', title: 'Some media could not be restored', body: lostMessage }
          : {
              tone: 'neutral',
              title: 'Draft restored',
              body: 'Your unfinished post was recovered on this device.',
            });
        // Deliberately not awaited: the draft is already usable, and verifying
        // its uploads is a background repair the user should not wait behind.
        void recoverRestoredDraftMedia(restoredDraft, lostOnRestore);
      } else if (focusTarget === 'resources') {
        const details = getPostComposerDetailErrors(draft, { grandfatheredTitle: initialTitleRef.current });
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
    shareAfterPublish,
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

  /**
   * A refused save of the name and handle, brought into view once it is drawn.
   * Publish is in the footer, so the creator may be at a price far down step 2,
   * or typing in the card with the keyboard up, where the top of step 2 left
   * the refused field under the footer. The field's top comes to where the
   * page's first block rests, its verdict under it; the banner is at the top.
   */
  useEffect(() => {
    const target = pendingIdentityRevealRef.current;
    const scrollView = scrollRef.current;
    if (!target || !scrollView) return;
    pendingIdentityRevealRef.current = null;
    const content = scrollContentRef.current;
    if (target === 'top' || !content) {
      scrollView.scrollTo({ y: 0, animated: true });
      return;
    }
    target.measureLayout(
      content,
      (_x, y) => scrollView.scrollTo({ y: Math.max(0, y - COMPOSER_TOP_PADDING), animated: true }),
      () => scrollView.scrollTo({ y: 0, animated: true }),
    );
  }, [identityRefusalCount]);

  /**
   * Uploads again, from the device, the new media whose staged uploads a failed
   * save may have used (`forgetConsumedMediaUploads`), ahead of the save that
   * sends them, under the same progress and Cancel as a pick. What uploads stays
   * in the draft, so a refusal after this sends it again rather than uploading
   * it once more.
   */
  const uploadMediaAwaitingUpload = async (target: PostComposerDraft): Promise<PostComposerDraft> => {
    const pending = getMediaAwaitingUpload(target.mediaItems);
    if (pending.length === 0) return target;

    const controller = new AbortController();
    activeUploadControllersRef.current.add(controller);
    const reuploaded = new Map<string, { storagePath: string }>();
    const progressByIndex = new Map<number, { bytesSent: number; totalBytes: number }>();
    const showProgress = () => {
      const totals = [...progressByIndex.values()].reduce(
        (sum, progress) => ({
          bytesSent: sum.bytesSent + progress.bytesSent,
          totalBytes: sum.totalBytes + progress.totalBytes,
        }),
        { bytesSent: 0, totalBytes: 0 }
      );
      setMediaUploadProgress({
        ...totals,
        completed: reuploaded.size,
        percent: totals.totalBytes > 0 ? Math.round((totals.bytesSent / totals.totalBytes) * 100) : 0,
        total: pending.length,
      });
    };
    showProgress();

    try {
      for (const [index, item] of pending.entries()) {
        const uploaded = await uploadPickedMedia(item.uri, {
          api,
          fileName: item.name,
          mimeType: item.type,
          kind: item.mediaKind,
          durationSeconds: item.durationSeconds ?? null,
          signal: controller.signal,
          onProgress: (progress) => {
            progressByIndex.set(index, { bytesSent: progress.bytesSent, totalBytes: progress.totalBytes });
            showProgress();
          },
        });
        reuploaded.set(item.id, { storagePath: uploaded.storagePath });
        showProgress();
      }
    } finally {
      activeUploadControllersRef.current.delete(controller);
      setMediaUploadProgress(null);
      if (reuploaded.size > 0) {
        setDraft((current) => ({
          ...current,
          mediaItems: applyPostComposerMediaRecovery(current.mediaItems, { reuploaded, lost: new Set() }),
        }));
      }
    }

    return {
      ...target,
      mediaItems: applyPostComposerMediaRecovery(target.mediaItems, { reuploaded, lost: new Set() }),
    };
  };

  /**
   * The draft with its media named by the rows the post holds now, read with the
   * owner read the prefill uses (`savedMediaIdsStaleRef`). When the post cannot
   * be read the save stops here: an id the post no longer has is refused on
   * every save, so none that may be stale goes. Media that is on neither the
   * post nor the device leaves the draft, and the save stops to say so.
   */
  const readBackSavedMedia = async (editedPostId: string, target: PostComposerDraft): Promise<PostComposerDraft> => {
    const post = (await api.getOwnerPost(editedPostId).catch(() => null))?.post;
    if (!post || !Array.isArray(post.mediaItems)) {
      throw new Error('Could not check this post\'s media before saving. Try again.');
    }
    const deviceFiles = await findDeviceFiles(target.mediaItems);
    const hasDeviceFile = (uri: string) => deviceFiles.has(uri);
    const named = withSavedPostMedia(target, post, hasDeviceFile);
    setDraft((current) => withSavedPostMedia(current, post, hasDeviceFile).draft);
    const lostMessage = describeLostRecoveryMedia(named.lost);
    if (lostMessage) throw new Error(lostMessage);
    return named.draft;
  };

  const publishMutation = useMutation({
    mutationFn: async (targetVisibility?: PostComposerDraft['visibility']) => {
      const effectiveDraft = targetVisibility ? { ...draft, visibility: targetVisibility } : draft;
      const validation = validateCurrentDraft(
        effectiveDraft,
        selectedGeneration,
        isEditMode,
        isEditMode && isGenerationBacked,
        { grandfatheredTitle: initialTitleRef.current },
      );
      if (!validation.valid) {
        throw new Error(validation.message);
      }

      const draftToSave = postId && savedMediaIdsStaleRef.current
        ? await readBackSavedMedia(postId, effectiveDraft)
        : effectiveDraft;
      const submittedDraft = await uploadMediaAwaitingUpload(draftToSave);
      let sentPostMedia = false;
      try {
        if (postId) {
          const isGen = Boolean(postQuery.data?.post?.generationId);
          const payload = buildUpdatePostPayload(isGen, submittedDraft);
          sentPostMedia = 'mediaItems' in payload;
          return await api.updatePost(postId, payload);
        }

        if (submittedDraft.mode === 'creation') {
          if (!selectedGeneration) throw new Error('Choose a finished creation before publishing.');
          return await api.publishGeneration(buildPublishGenerationPostPayload(selectedGeneration, submittedDraft));
        }

        return await api.createPost(buildCreatePostFormData(submittedDraft));
      } catch (error) {
        // Sending the same staged paths after the server may have moved them
        // was refused on every retry; the next publish uploads those files again.
        if (saveMayHaveConsumedUploads(error)) {
          setDraft((current) => forgetConsumedMediaUploads(current, submittedDraft));
          // The same edit may have re-inserted every media row under a new id.
          if (sentPostMedia) savedMediaIdsStaleRef.current = true;
        } else if (sentPostMedia && saveRefusedForStaleMediaIds(error)) {
          // Refused before anything was written; the uploads stand, the ids do not.
          savedMediaIdsStaleRef.current = true;
        }
        throw error;
      }
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
        body: isEditMode
          ? 'Your post has been updated.'
          : context?.submittedDraft.visibility === 'public'
            ? 'Your post is now live in your profile.'
            : context?.submittedDraft.resource.accessMode !== 'none'
              ? 'Your post is saved. Its recipe stays a draft until the post is public.'
              : 'Your post is saved to your profile.',
      });
      const targetPostId = response.postId || postId;
      if (!isEditMode) {
        // The header's Posts count moves now; the profile refetch confirms it.
        adjustProfileStats(queryClient, user?.id, { posts: 1 });
        const optimisticPost = buildOptimisticOwnerPostListItem(targetPostId, context?.submittedDraft ?? draft);
        if (optimisticPost) {
          queryClient.setQueryData<InfiniteData<OwnerPostsResponse>>(
            ['profile-owner-posts', user?.id],
            (current) => upsertOptimisticOwnerPostInfiniteData(current, optimisticPost)
          );
        }
        // Your Sales keeps the list it read, so a post made with a recipe, a new
        // listing, was missing from it; an edit refreshes it with the screens it
        // returns to.
        void queryClient.invalidateQueries({ queryKey: ['seller-dashboard-posts', user?.id] });
      }
      void invalidatePostCaches(queryClient, user?.id);
      if (isEditMode && targetPostId) {
        void invalidateEditedPostCaches(queryClient, user?.id, targetPostId);
      }
      if (targetPostId) {
        setIsNavigationAllowed(true);
        setHasHydratedPersistedDraft(false);
        if (draftStorageId) {
          void clearPersistedPostComposerDraft(draftStorageId);
        }
        const leaveComposer = () => {
          if (isEditMode) {
            // An edit returns to where it was opened from (the viewer, the post
            // page, the seller dashboard), as the web editor keeps its page.
            // Landing every edit on the profile lost that place.
            if (router.canGoBack()) {
              router.back();
              return;
            }
            router.replace({ pathname: '/(tabs)/profile', params: { tab: 'posts', postId: targetPostId } } as never);
            return;
          }
          router.replace({
            pathname: '/(tabs)/profile',
            params: {
              tab: 'posts',
              postId: targetPostId,
              // Profile offers notifications once, right after a publish:
              // every social push is about the person's own posts.
              published: '1',
            },
          } as never);
        };

        // The share sheet has to fully resolve before this screen unmounts, so
        // it is awaited ahead of the navigation rather than raced against it.
        // Publishing has already succeeded at this point: a dismissed or failed
        // share must never be reported as a failed publish.
        setTimeout(() => {
          if (!shareAfterPublish || response.visibility !== 'public') {
            leaveComposer();
            return;
          }

          void (async () => {
            try {
              const title = (context?.submittedDraft ?? draft).title.trim() || 'My creation';
              const url = buildShareUrl(env.siteUrl, `/showcase/${targetPostId}`, 'my-creations');
              const result = await Share.share({ title, message: `${title}\n${url}`, url });
              if (result.action === Share.sharedAction) {
                await api
                  .shareShowcasePost(targetPostId, { sourceSurface: 'my-creations' })
                  .catch(() => null);
              }
            } catch {
              // A share sheet that could not open is not a publish failure.
            } finally {
              leaveComposer();
            }
          })();
        }, 0);
      }
    },
    onError: (error) => {
      // A public post needs a claimed handle and a display name, and the server
      // says which refusal that is on all three routes.
      const needsProfile = isPublicIdentityRefusal(error);
      setMessage({
        tone: 'danger',
        title: isEditMode ? 'Could not save' : 'Could not publish',
        body: error instanceof Error ? error.message : 'Try again.',
        ...(needsProfile ? { action: 'complete-profile' as const } : {}),
      });
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    },
    onSettled: () => {
      setPendingPublishVisibility(null);
    },
  });

  // Leaving a composer with unsaved work is the case Action sheets names by
  // example ("when people cancel the message they're editing in Mail ... an
  // action sheet provides two choices: delete the draft, or save the draft"),
  // and Sheets repeats it for the dismiss gesture. It was an alert, which the
  // Alerts chapter reserves for problems — and its message existed only to
  // explain the three buttons, which the same chapter tells you not to do.
  const preventLeaveWithUnsavedChanges = hasUnsavedChanges && !isNavigationAllowed;
  usePreventRemove(preventLeaveWithUnsavedChanges, ({ data }) => {
    const leave = (settle: () => Promise<unknown>) => {
      void settle().finally(() => {
        setIsNavigationAllowed(true);
        setTimeout(() => navigation.dispatch(data.action), 0);
      });
    };

    showActionSheet({
      title: 'Leave this post?',
      actions: [
        {
          label: 'Discard changes',
          destructive: true,
          onPress: () => leave(() => (
            draftStorageId ? clearPersistedPostComposerDraft(draftStorageId) : Promise.resolve()
          )),
        },
        {
          label: 'Save draft',
          detail: 'Kept on this device.',
          onPress: () => leave(() => (
            draftStorageId
              ? persistPostComposerDraft(draftStorageId, { draft, step: composerStep })
              : Promise.resolve()
          )),
        },
      ],
    });
  });

  if (authLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.colors.motion} />
      </View>
    );
  }

  if (!user) {
    // Sign-in comes back here, on the same creation. A guest can generate and
    // press Post to feed, and finishing sign-in on Home lost what they were
    // posting.
    const returnTo = postComposerReturnPath({
      generationId,
      postId,
      focus: focusTarget,
      shareAfterPublish: shareAfterPublish ? '1' : null,
    });
    return <Redirect href={{ pathname: '/auth', params: { returnTo } } as never} />;
  }

  if (isEditMode && (postQuery.isLoading || (postQuery.isSuccess && Boolean(postQuery.data?.post) && !hasPrefilledEdit))) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 }}>
        <ActivityIndicator color={theme.colors.primary} />
        <AppText variant="bodySm" color="muted">Loading your post</AppText>
      </View>
    );
  }

  if (isEditMode && (postQuery.isError || (postQuery.isSuccess && !postQuery.data?.post))) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, justifyContent: 'center', gap: 12, padding: 24 }}>
        <StatusBlock tone="danger" title="Could not load this post" body="Nothing has been changed. Check your connection, then try again." />
        <SecondaryButton label="Retry post" onPress={() => void postQuery.refetch()} />
        <SecondaryButton label="Back to profile" onPress={() => router.replace('/(tabs)/profile?tab=posts' as never)} />
      </View>
    );
  }

  if (generationId && generationsQuery.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 }}>
        <ActivityIndicator color={theme.colors.primary} />
        <AppText variant="bodySm" color="muted">Loading your creation</AppText>
      </View>
    );
  }

  if (generationId && (generationsQuery.isError || (generationsQuery.isSuccess && !explicitGeneration))) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, justifyContent: 'center', gap: 12, padding: 24 }}>
        <StatusBlock tone="danger" title="Could not load this creation" body="Open the creation from your library and try publishing it again." />
        <SecondaryButton label="Retry creation" onPress={() => void generationsQuery.refetch()} />
        <SecondaryButton label="Back to creations" onPress={() => router.replace('/(tabs)/profile?tab=creations' as never)} />
      </View>
    );
  }

  const setMode = (mode: Exclude<PostComposerMode, 'creation'>) => {
    // Media → text on an uploaded post saved an empty body and deleted the caption.
    if (isMediaLocked || isEditMode) return;
    setMessage(null);
    const next = {
      ...draft,
      mode,
      proofMode: mode === 'text' ? 'text' as const : 'media' as const,
      category: mode === 'text' ? 'text' as const : draft.category === 'text' ? 'image' as const : draft.category,
      madeWithRows: draft.madeWithRows.length > 0 ? draft.madeWithRows : [createMadeWithRow()],
    };
    setDraft(next);
    if (Object.keys(detailErrors).length > 0) {
      setDetailErrors(getPostComposerDetailErrors(next, { grandfatheredTitle: initialTitleRef.current }));
    }
  };

  const updateDraft = (patch: Partial<PostComposerDraft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (Object.keys(detailErrors).length > 0) {
      setDetailErrors(getPostComposerDetailErrors(next, { grandfatheredTitle: initialTitleRef.current }));
    }
    if (message?.tone === 'danger') {
      setMessage(null);
    }
  };

  const updateResource = (patch: Partial<PostComposerDraft['resource']>) => {
    setDraft((current) => followCreationTitleSuggestion(
      current,
      { ...current, resource: { ...current.resource, ...patch } },
      selectedGeneration,
    ));
  };

  // The creation's references are part of what the recipe holds, so the
  // suggested Recipe preview follows them in and out as it follows the items.
  const updateCreationPackage = (patch: Partial<PostComposerDraft['creationPackage']>) => {
    setDraft((current) => followSuggestedRecipePreview(
      current,
      { ...current, creationPackage: { ...current.creationPackage, ...patch } },
      selectedGeneration,
    ));
  };

  const togglePromptResource = (enabled: boolean) => {
    setDraft((current) => followCreationTitleSuggestion(
      current,
      applyCreationPromptResource(current, selectedGeneration, enabled),
      selectedGeneration,
    ));
  };

  const applyUploadedMedia = (uploadedItems: PostComposerMediaItem[]) => {
    if (uploadedItems.length === 0) return;
    setDraft((current) => {
      const mediaItems = [...current.mediaItems, ...uploadedItems].slice(0, MEDIA_MAX_ITEMS);
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

  /**
   * Re-attach a restored draft's staged media.
   *
   * Staged uploads are not permanent -- the server reclaims ones nothing ever
   * published -- so a draft resumed days later can reference objects that are
   * gone. Without this the composer looked completely intact and publishing
   * failed with "Failed to load uploaded media", which the user had no way to
   * act on. Each item still knows the local file it came from, so the usual
   * outcome is a re-upload.
   *
   * Publishing is disabled for the duration (`isRecoveringDraftMedia` feeds
   * `canSubmit`): a publish racing the recovery would submit the reclaimed
   * path and fail with exactly the opaque error this exists to prevent. The
   * re-upload phase runs through the same progress banner and cancel button as
   * a normal media pick, so several large videos never upload invisibly.
   */
  const recoverRestoredDraftMedia = async (
    restored: PostComposerDraft,
    // Dropped before this ran; a notice of more drops names them too, as it replaces theirs.
    alreadyLost: PostComposerMediaItem[] = [],
  ) => {
    const staged = restored.mediaItems.filter((item) => !item.existingId && item.storagePath);
    if (staged.length === 0) return;

    setIsRecoveringDraftMedia(true);
    try {
      const verifications = new Map<string, MediaVerification>();
      const localUris = new Set<string>();

      await Promise.all(staged.map(async (item) => {
        const storagePath = item.storagePath as string;
        try {
          await api.createMediaReadUrl({ storagePath });
          verifications.set(storagePath, { exists: true, inconclusive: false });
        } catch (error) {
          // Only a positive 404 means reclaimed. Anything else -- offline, rate
          // limited, storage blip -- leaves the item alone rather than risking
          // dropping media that is really still there.
          const missing = error instanceof ApiError && error.status === 404;
          verifications.set(storagePath, { exists: false, inconclusive: !missing });
        }
      }));

      await Promise.all(staged.map(async (item) => {
        if (!item.uri) return;
        try {
          const { File: ExpoFile } = await import('expo-file-system');
          if (new ExpoFile(item.uri).exists) localUris.add(item.uri);
        } catch {
          // An unreadable local file is treated as gone, which is what it is.
        }
      }));

      const plan = planPostComposerMediaRecovery(
        restored.mediaItems,
        verifications,
        (uri) => localUris.has(uri),
      );
      if (plan.toReupload.length === 0 && plan.lost.length === 0) return;

      const reuploaded = new Map<string, { storagePath: string }>();
      const lost = new Set(plan.lost.map((item) => item.id));
      const failedReupload: typeof plan.toReupload = [];
      let cancelled = false;

      if (plan.toReupload.length > 0) {
        const controller = new AbortController();
        activeUploadControllersRef.current.add(controller);

        const progressByIndex = new Map<number, { bytesSent: number; totalBytes: number }>();
        let completed = 0;
        const publishRecoveryProgress = () => {
          const totals = [...progressByIndex.values()].reduce(
            (sum, progress) => ({
              bytesSent: sum.bytesSent + progress.bytesSent,
              totalBytes: sum.totalBytes + progress.totalBytes,
            }),
            { bytesSent: 0, totalBytes: 0 }
          );
          setRecoveryUploadProgress({
            ...totals,
            completed,
            percent: totals.totalBytes > 0 ? Math.round((totals.bytesSent / totals.totalBytes) * 100) : 0,
            total: plan.toReupload.length,
          });
        };
        publishRecoveryProgress();

        try {
          for (const [index, item] of plan.toReupload.entries()) {
            if (controller.signal.aborted) {
              cancelled = true;
              break;
            }

            try {
              const uploaded = await uploadPickedMedia(item.uri, {
                api,
                fileName: item.name,
                mimeType: item.type,
                kind: item.mediaKind,
                signal: controller.signal,
                onProgress: (progress) => {
                  progressByIndex.set(index, {
                    bytesSent: progress.bytesSent,
                    totalBytes: progress.totalBytes,
                  });
                  publishRecoveryProgress();
                },
              });
              completed += 1;
              publishRecoveryProgress();
              reuploaded.set(item.id, { storagePath: uploaded.storagePath });
            } catch (error) {
              if (isUploadCancelledError(error)) {
                // The user stopped the restore; the items stay in the draft
                // untouched rather than being written off as lost.
                cancelled = true;
                break;
              }
              // The planner already confirmed this file is still on the device,
              // so a failed PUT is transient -- dropping the item would destroy
              // work one retry would have restored. `lost` stays reserved for
              // the planner's verdict: gone from storage AND gone locally.
              failedReupload.push(item);
            }
          }
        } finally {
          activeUploadControllersRef.current.delete(controller);
          setRecoveryUploadProgress(null);
        }
      }

      setDraft((current) => applyPostComposerMediaRecoveryToDraft(current, { reuploaded, lost }));

      if (cancelled) {
        setMessage({
          tone: 'neutral',
          title: 'Media restore cancelled',
          body: 'Some of this draft\'s media may need to be added again before publishing.',
        });
        return;
      }

      const lostMessage = describeLostRecoveryMedia([
        ...alreadyLost,
        ...restored.mediaItems.filter((item) => lost.has(item.id)),
      ]);
      if (lostMessage) {
        setMessage({ tone: 'danger', title: 'Some media could not be restored', body: lostMessage });
        return;
      }

      if (failedReupload.length > 0) {
        // Kept in the draft, but publishing would fail on the reclaimed path,
        // so the user is told rather than left to discover it at publish time.
        setMessage({
          tone: 'danger',
          title: 'Could not restore some media',
          body: describeFailedRecoveryReuploads(failedReupload),
        });
      }
    } finally {
      setIsRecoveringDraftMedia(false);
    }
  };

  const uploadSelectedMedia = async (assets: ImagePickerAsset[]) => {
    if (assets.length === 0) return;
    const controller = new AbortController();
    mediaUploadAbortRef.current = controller;
    activeUploadControllersRef.current.add(controller);
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
            // ImagePickerAsset.duration is milliseconds; the API speaks seconds.
            durationSeconds: assetDurationSeconds(asset.duration),
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
            durationSeconds: uploaded.durationSeconds ?? null,
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
      activeUploadControllersRef.current.delete(controller);
      if (mediaUploadAbortRef.current === controller) {
        mediaUploadAbortRef.current = null;
      }
      setMediaUploadProgress(null);
      setIsPickingMedia(false);
    }
  };

  const chooseMedia = async (kind: 'image' | 'video' | 'mixed') => {
    if (isMediaLocked || isPickingMedia || isRecoveringDraftMedia) return;
    setMessage(null);
    setPendingRetryMedia([]);
    setIsPickingMedia(true);
    try {
      const picked = await pickMediaList(kind, { allowsMultipleSelection: true });
      // Refused before any bytes move: a file the sign step refuses for its
      // size lands in Retry, which can never succeed.
      const refusals = picked.map(getPostMediaPickRefusal);
      const allowed = picked.filter((_asset, index) => refusals[index] === null);
      const availableSlots = Math.max(0, MEDIA_MAX_ITEMS - draft.mediaItems.length);
      const selected = allowed.slice(0, availableSlots);
      const refusal = describePostMediaPickRefusals(refusals);
      const refusalMessage = refusal ? { tone: 'danger' as const, ...refusal } : null;
      if (selected.length === 0) {
        if (refusalMessage) setMessage(refusalMessage);
        return;
      }
      setIsPickingMedia(false);
      await uploadSelectedMedia(selected);
      if (refusalMessage) {
        // Restore the notice after the upload runs (it clears messages on
        // start) — but never on top of an upload failure it just reported.
        setMessage((current) => current ?? refusalMessage);
      }
    } catch (error) {
      setMessage({ tone: 'danger', title: 'Could not pick media', body: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      if (!mediaUploadAbortRef.current) setIsPickingMedia(false);
    }
  };
  const retryPendingMediaUploads = async () => {
    if (pendingRetryMedia.length === 0 || isPickingMedia || isRecoveringDraftMedia) return;
    const retryAssets = pendingRetryMedia;
    setPendingRetryMedia([]);
    await uploadSelectedMedia(retryAssets);
  };

  // Publish stays off while uploads wait for a retry, and some failures never
  // pass on a retry; this lets the post go without them. They never reached
  // the draft, so there is nothing for undo to put back.
  const removeFailedMediaUploads = () => {
    setPendingRetryMedia([]);
    setMessage(null);
  };

  const cancelMediaUploads = () => {
    for (const controller of activeUploadControllersRef.current) {
      // Resource uploads have their own in-sheet Cancel action and recovery
      // state. A page-level media cancel must not silently stop that different
      // transfer when draft recovery happens to overlap it.
      if (controller !== resourceUploadAbortRef.current) controller.abort();
    }
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
      madeWithRows: [...current.madeWithRows, createMadeWithRow()].slice(0, MAX_MADE_WITH_ROWS),
    }));
  };

  /**
   * Hand what a removal took to the undo offer, and start the clock on it.
   * Everything that removes part of the draft goes through here, so the
   * reversal is the same one everywhere rather than a courtesy on whichever
   * control someone remembered. The rows answer their × with the keyboard up
   * (2026-10-21), so a removal can happen mid-typing. On Android the page's
   * keyboard area lifts the offer above the keys with the footer, and the
   * keyboard stays where the person left it. On iOS the area leaves the room to
   * the scroll view's own insets and the offer stays under the keys, so the
   * keyboard goes first there: an offer under the keys is an offer nobody sees.
   */
  const offerUndo = (label: string, removal: PostComposerRemoval) => {
    if (Platform.OS === 'ios') Keyboard.dismiss();
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndoEntry({ label, removal, scrollY: scrollYRef.current });
    undoTimerRef.current = setTimeout(() => setUndoEntry(null), COMPOSER_UNDO_WINDOW_MS);
  };

  const dismissUndo = () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = null;
    setUndoEntry(null);
  };

  const applyUndo = () => {
    if (!undoEntry) return;
    const { removal, scrollY } = undoEntry;
    dismissUndo();
    // Onto the draft as it is now: the offer can be taken mid-typing, and what
    // was typed since the removal stays. An item put back is named again in a
    // Recipe preview that still says what was suggested.
    setDraft((current) => followSuggestedRecipePreview(current, putBackComposerRemoval(current, removal), selectedGeneration));
    setDetailErrors((current) => (
      Object.keys(current).length > 0
        ? getPostComposerDetailErrors(putBackComposerRemoval(draft, removal), { grandfatheredTitle: initialTitleRef.current })
        : current
    ));
    // Undo and redo: "it's crucial to highlight the result of each undo ... to
    // keep people from thinking that the action had no effect."
    scrollRef.current?.scrollTo({ y: scrollY, animated: true });
  };

  const removeMadeWithRow = (id: string) => {
    const taken = takeComposerMadeWithRow(draft, id);
    if (!taken) return;
    offerUndo(taken.removal.row.toolLabel.trim() || 'tool', taken.removal);
    setDraft((current) => takeComposerMadeWithRow(current, id)?.draft ?? current);
  };

  const removeMediaItem = (id: string) => {
    const taken = takeComposerMedia(draft, id);
    if (!taken) return;
    offerUndo(getComposerMediaLabel(taken.removal.index), taken.removal);
    setDraft((current) => takeComposerMedia(current, id)?.draft ?? current);
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

  /**
   * Uploads an item's picked files one after another, each through the signed
   * resource upload, into the item being edited. What fails or is cancelled
   * stays pending with whatever was not sent yet, for Retry; what went up
   * stays on the item. `notice` is said once the files are in: photos left out
   * for their size.
   */
  const uploadPendingResourceFiles = async (pending: PendingResourceUpload, notice: string | null = null) => {
    if (isPickingResourceFile || resourceEditorCard?.id !== pending.cardId || pending.files.length === 0) return;

    const controller = new AbortController();
    resourceUploadAbortRef.current = controller;
    activeUploadControllersRef.current.add(controller);
    setIsPickingResourceFile(true);
    setResourceUploadError(null);
    let remaining = pending.files;
    const fileCount = pending.files.length;

    try {
      for (const [fileIndex, file] of pending.files.entries()) {
        setResourceUploadProgress({
          bytesSent: 0,
          cardId: pending.cardId,
          percent: 0,
          totalBytes: file.size ?? 0,
          fileIndex,
          fileCount,
        });
        const uploaded = await uploadResourceDocument(file.uri, {
          api,
          fileName: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.size,
          mediaOnly: pending.cardType === 'reference_media',
          signal: controller.signal,
          onProgress: (progress) => {
            if (controller.signal.aborted) return;
            setResourceUploadProgress((current) => current?.cardId === pending.cardId
              ? {
                  bytesSent: progress.bytesSent,
                  cardId: pending.cardId,
                  percent: Math.round(progress.fraction * 100),
                  totalBytes: progress.totalBytes,
                  fileIndex,
                  fileCount,
                }
              : current);
          },
        });

        // Honor a cancellation that lands at the end of finalization, and never
        // write its result into a different editor card.
        if (controller.signal.aborted) {
          setPendingResourceUpload({ ...pending, files: remaining });
          setResourceUploadError(describeCancelledResourceUpload(remaining.length));
          return;
        }

        const contentType = uploaded.contentType ?? null;
        const attachment = {
          // Several files can finish within one millisecond.
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'file',
          label: uploaded.label,
          storagePath: uploaded.storagePath ?? '',
          contentType,
          sizeBytes: uploaded.sizeBytes ?? null,
          // Finalize only reports what it verified in storage, so the editorial
          // fields are inferred here. The card serializer overrides them for
          // every card type except 'other', where these are the fallback.
          resourceType: inferResourceAttachmentType(contentType),
          role: 'primary',
          remixUse: 'none',
        } satisfies PostComposerResourceCardDraft['attachments'][number];
        setResourceEditorCard((current) => current?.id === pending.cardId
          ? { ...current, attachments: [...current.attachments, attachment] }
          : current);
        remaining = remaining.slice(1);
      }
      setPendingResourceUpload(null);
      setResourceUploadError(notice);
    } catch (error) {
      setPendingResourceUpload({ ...pending, files: remaining });
      const failure = isUploadCancelledError(error)
        ? describeCancelledResourceUpload(remaining.length)
        : error instanceof Error
          ? error.message
          : 'Try again.';
      setResourceUploadError(notice ? `${failure} ${notice}` : failure);
    } finally {
      activeUploadControllersRef.current.delete(controller);
      if (resourceUploadAbortRef.current === controller) {
        resourceUploadAbortRef.current = null;
      }
      setResourceUploadProgress(null);
      setIsPickingResourceFile(false);
    }
  };

  /**
   * Files for the item being edited: from the photo library (pictures and
   * videos, several at once; recipe audit H6) or from Files (one document). A
   * photo over 50 MB is left out before anything is sent, and said.
   */
  const chooseResourceFiles = async (source: 'files' | 'photos') => {
    if (!resourceEditorCard || isPickingResourceFile) return;
    const targetCardId = resourceEditorCard.id;
    const targetCardType = resourceEditorCard.type;
    setIsPickingResourceFile(true);
    setResourceUploadError(null);
    setPendingResourceUpload(null);
    try {
      let picked: PickedResourceFile[];
      if (source === 'photos') {
        picked = await pickResourcePhotos();
      } else {
        const document = await pickResourceDocument(targetCardType === 'reference_media' ? 'reference_media' : 'resource');
        picked = document ? [document] : [];
      }
      if (picked.length === 0) return;
      const { accepted, oversized } = partitionResourceFilesBySize(picked);
      const notice = describeOversizedResourceFiles(oversized.length);
      if (accepted.length === 0) {
        setResourceUploadError(notice);
        return;
      }
      const pending = {
        cardId: targetCardId,
        cardType: targetCardType,
        files: accepted,
      } satisfies PendingResourceUpload;
      setPendingResourceUpload(pending);
      // The picker phase and transfer share the same busy state. Clear it here
      // so the upload helper can acquire and own the state/controller.
      setIsPickingResourceFile(false);
      await uploadPendingResourceFiles(pending, notice);
    } catch (error) {
      setResourceUploadError(error instanceof Error
        ? error.message
        : source === 'photos'
          ? 'Could not open the photo library. Try again.'
          : 'Could not open the file picker. Try again.');
    } finally {
      if (!resourceUploadAbortRef.current) setIsPickingResourceFile(false);
    }
  };

  const retryResourceFileUpload = () => {
    if (!pendingResourceUpload || isPickingResourceFile) return;
    void uploadPendingResourceFiles(pendingResourceUpload);
  };

  const cancelResourceFileUpload = () => {
    resourceUploadAbortRef.current?.abort();
  };

  const touchResourceEditorField = (field: keyof PostComposerResourceCardTouched) => {
    setResourceEditorTouched((current) => (current[field] ? current : { ...current, [field]: true }));
  };

  const updateResourceEditorCard = (patch: Partial<PostComposerResourceCardDraft>) => {
    setResourceEditorCard((current) => current ? { ...current, ...patch } : current);
    // A field typed in, or a file taken away, may now say what it lacks.
    if ('title' in patch) touchResourceEditorField('title');
    if ('textContent' in patch || 'externalUrl' in patch || 'attachments' in patch) touchResourceEditorField('content');
  };

  const removeResourceCard = (id: string) => {
    if (isPickingResourceFile && editingResourceId === id) return;
    const taken = takeComposerResourceCard(draft, id);
    if (!taken) return;
    offerUndo(taken.removal.card.title.trim() || 'item', taken.removal);
    setDraft((current) => {
      const next = takeComposerResourceCard(current, id)?.draft;
      return next ? followSuggestedRecipePreview(current, next, selectedGeneration) : current;
    });
    if (editingResourceId === id) {
      setEditingResourceId(null);
      setResourceEditorCard(null);
      setResourceEditorOriginal(null);
      setResourceEditorTouched({});
      setResourceSheetMode(null);
    }
  };

  const startResourceCard = (type: PostComposerResourceCardType) => {
    if (isPickingResourceFile) return;
    const card = createPostComposerResourceCard(type);
    setEditingResourceId(card.id);
    setResourceEditorCard(cloneResourceCard(card));
    setResourceEditorOriginal(cloneResourceCard(card));
    setResourceEditorTouched({});
    setResourceSheetMode('editor');
  };

  const openResourceCard = (id: string) => {
    if (isPickingResourceFile) return;
    const card = draft.resource.cards.find((candidate) => candidate.id === id);
    if (!card) return;
    setEditingResourceId(id);
    setResourceEditorCard(cloneResourceCard(card));
    setResourceEditorOriginal(cloneResourceCard(card));
    setResourceEditorTouched({});
    setResourceSheetMode('editor');
  };

  const clearResourceEditor = () => {
    setEditingResourceId(null);
    setResourceEditorCard(null);
    setResourceEditorOriginal(null);
    setResourceEditorTouched({});
    setResourceSheetMode(null);
    setResourceUploadProgress(null);
    setResourceUploadError(null);
    setPendingResourceUpload(null);
  };

  const requestCloseResourceSheet = () => {
    if (isPickingResourceFile) {
      void showConfirmDialog({
        title: 'File upload in progress',
        message: 'Keep this item editor open until the upload finishes, or cancel the upload first.',
        cancelLabel: 'Keep uploading',
        confirmLabel: 'Cancel upload',
        destructive: true,
      }).then((cancelUpload) => {
        if (cancelUpload) cancelResourceFileUpload();
      });
      return;
    }
    if (resourceSheetMode !== 'editor' || !resourceEditorCard || !resourceEditorOriginal) {
      clearResourceEditor();
      return;
    }
    const isDirty = getResourceCardSignature(resourceEditorCard) !== getResourceCardSignature(resourceEditorOriginal);
    if (!isDirty) {
      clearResourceEditor();
      return;
    }
    void showConfirmDialog({
      title: 'Discard item changes?',
      message: 'This item has unsaved changes.',
      cancelLabel: 'Keep editing',
      confirmLabel: 'Discard',
      destructive: true,
    }).then((discard) => {
      if (discard) clearResourceEditor();
    });
  };

  const saveResourceEditor = () => {
    if (!resourceEditorCard || isPickingResourceFile || !isPostComposerResourceCardReady(resourceEditorCard)) return;
    const savedCard = cloneResourceCard(resourceEditorCard);
    setDraft((current) => {
      const exists = current.resource.cards.some((card) => card.id === savedCard.id);
      const cards = exists
        ? current.resource.cards.map((card) => card.id === savedCard.id ? savedCard : card)
        : [...current.resource.cards, savedCard];
      // The Recipe preview is suggested from the items when the first is saved,
      // and follows them while it still says what was suggested (recipe audit S6).
      return followSuggestedRecipePreview(current, {
        ...current,
        resource: { ...current.resource, cardAuthoringMode: 'cards', cards },
      }, selectedGeneration);
    });
    clearResourceEditor();
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
    const errors = getPostComposerDetailErrors(draft, { grandfatheredTitle: initialTitleRef.current });
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

  // An offer that could no longer bring anything back (its list filled up again meanwhile) is not
  // drawn: Undo would take the bar away and change nothing.
  const shownUndoEntry = undoEntry && putBackComposerRemoval(draft, undoEntry.removal) !== draft ? undoEntry : null;

  const submitPost = async () => {
    setMessage(null);
    // Saving "No recipe" over the recipe an edit loaded deletes it, or takes it
    // off sale when people have it: asked first (recipe audit A-F2), and Keep
    // recipe puts the choice back as it was.
    const loadedRecipe = isEditMode ? postQuery.data?.post?.resourceBundleInput ?? null : null;
    const removal = getRecipeRemovalConfirmation({
      loadedAccessMode: loadedRecipe?.accessMode ?? null,
      loadedItemCount: loadedRecipe ? hydratePostComposerResourceCards(loadedRecipe).length : 0,
      buyerCount: recipeBuyerCount,
      nextAccessMode: draft.resource.accessMode,
      // The same condition as the "Remix comes with this recipe" line above.
      reopensPost: draft.mode === 'creation',
    });
    if (removal && loadedRecipe) {
      const remove = await showConfirmDialog(removal);
      if (!remove) {
        updateResource({ accessMode: loadedRecipe.accessMode });
        return;
      }
    }
    if (needsPublicIdentity) {
      setIsSavingIdentity(true);
      try {
        // Read again first: a profile finished elsewhere since this screen read
        // it keeps its own name and handle, and nothing is saved over them.
        await claimIdentity(identity);
      } catch (error) {
        const { errors, message: saveMessage } = readPublicIdentitySaveError(error);
        setIdentitySaveErrors(errors);
        // A verdict on a field is said under that field alone, as the list's
        // sheet, Edit profile and onboarding say it: the banner used to repeat
        // it and kept saying a handle was taken after the field had moved on
        // to one the card's live check called available. The banner keeps
        // what no field can hold: a save that failed offline, or a verdict
        // that lands after the creator went back to step 1, with no card drawn.
        const refusedFieldView = errors.displayName
          ? displayNameFieldRef.current
          : errors.username ? usernameFieldRef.current : null;
        if (!refusedFieldView) {
          setMessage({ tone: 'danger', title: 'Your name and handle were not saved', body: saveMessage });
        }
        setIsSavingIdentity(false);
        pendingIdentityRevealRef.current = refusedFieldView ?? 'top';
        setIdentityRefusalCount((count) => count + 1);
        return;
      }
      setIdentitySaveErrors({});
      setIsSavingIdentity(false);
    }
    setPendingPublishVisibility(draft.visibility);
    publishMutation.mutate(draft.visibility);
  };
  // Step 2 is not ready while a public post still lacks the name and handle.
  const stepTwoValidation: PostComposerValidationResult = publishValidation.valid && (identityProblems.displayName || identityProblems.username)
    ? { valid: false, message: 'Add your name and handle to publish publicly.' }
    : publishValidation;

  // Pushed over the composer, which stays as it is: the profile editor goes
  // back to it when it saves or closes, and the draft is kept on the device too.
  const openProfileEditor = () => {
    setMessage(null);
    router.push('/edit-profile' as never);
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      {/* On iOS 26 the back swipe completes the pop natively before the
          usePreventRemove veto can run — the leave sheet then opens over the
          previous screen and JS/native navigation state desync (upstream:
          react-navigation#13072). The gesture must therefore not start at all
          while the veto is armed; the header's Close button stays the way out
          and raises the same sheet. A clean composer keeps its normal swipe. */}
      <Stack.Screen options={{ gestureEnabled: !preventLeaveWithUnsavedChanges }} />
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
      {/* The page's own fields give way to the keyboard. On Android the area shortens by the keyboard,
          so the scroll view keeps the focused field in view and the undo offer and the footer ride above
          the keys; on the Pixel 9a emulator a focused Title, Story, post text, package summary and price
          all sat under the keys without it (2026-10-22), the resource sheet's area being the only one in
          this file. On iOS the scroll view's own insets make the room, and the offer and the footer stay
          under the keys: React Native brings the field's bottom to the keys' top edge, under anything
          lifted above them. `reservedBottomInset`: the footer already pads that much for the screen's
          edge, which the keyboard covers. */}
      <KeyboardAvoidingArea iosScrollViewAdjustsInsets reservedBottomInset={bottomInset} testID="composer-keyboard-area">
      <ScrollView
        ref={scrollRef}
        // React Native declares this ref without React 19's nullable `current`.
        innerViewRef={scrollContentRef as RefObject<View>}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        scrollEventThrottle={16}
        onScroll={(event) => { scrollYRef.current = event.nativeEvent.contentOffset.y; }}
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{
          paddingHorizontal: horizontalPadding,
          paddingTop: COMPOSER_TOP_PADDING,
          paddingBottom: bottomInset + 112,
          gap: 14,
        }}
      >
        {message ? (
          <View style={{ gap: 8 }}>
            <StatusBlock tone={message.tone} title={message.title} body={message.body} />
            {message.action === 'complete-profile' ? (
              <SecondaryButton
                label="Complete profile"
                accessibilityHint="Opens your profile. This post stays here."
                onPress={openProfileEditor}
              />
            ) : null}
          </View>
        ) : null}

        {recoveryUploadProgress ? (
          <View style={{ gap: 8 }}>
            <StatusBlock
              tone="neutral"
              title={`Restoring draft media · ${recoveryUploadProgress.percent}%`}
              body={`${recoveryUploadProgress.completed} of ${recoveryUploadProgress.total} complete${recoveryUploadProgress.totalBytes > 0 ? ` · ${formatUploadBytes(recoveryUploadProgress.bytesSent)} of ${formatUploadBytes(recoveryUploadProgress.totalBytes)}` : ''}`}
            />
            <SecondaryButton label="Cancel restore" onPress={cancelMediaUploads} />
          </View>
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
          <View style={{ gap: 8 }}>
            <SecondaryButton
              label={`Retry ${pendingRetryMedia.length} media upload${pendingRetryMedia.length === 1 ? '' : 's'}`}
              onPress={() => void retryPendingMediaUploads()}
            />
            <SecondaryButton
              label="Remove failed"
              accessibilityHint="Drops the media that did not upload, so the post can be published without it."
              onPress={removeFailedMediaUploads}
            />
          </View>
        ) : null}

        <ToggleRow
          label="Mark as NSFW / mature"
          body="Cover this post until viewers choose to reveal it. Community rules still apply."
          value={draft.isNsfw === true}
          onValueChange={(isNsfw) => updateDraft({ isNsfw })}
        />
        {composerStep === 'details' ? (
          <PostDetailsPage
            draft={draft}
            selectedGeneration={selectedGeneration}
            sourceTools={sourceTools}
            detailErrors={detailErrors}
            isPickingMedia={isPickingMedia}
            isMediaLocked={isMediaLocked}
            isEditMode={isEditMode}
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
          <>
          {needsPublicIdentity ? (
            <PublicIdentityCard
              value={identity}
              savedUsername={profileQuery.data?.username}
              // Until the creator types, the summary says what is missing, not the fields.
              errors={{ ...(identityEdits ? identityProblems : {}), ...identitySaveErrors }}
              fieldRefs={{ displayName: displayNameFieldRef, username: usernameFieldRef }}
              editable={!isSavingIdentity && !publishMutation.isPending}
              onChange={(next) => {
                setIdentityEdits(next);
                setIdentitySaveErrors({});
              }}
            />
          ) : null}
          <PostResourcesPage
            draft={draft}
            selectedGeneration={selectedGeneration}
            isTemplateBacked={isTemplateBacked}
            isEditMode={isEditMode}
            buyerCount={recipeBuyerCount}
            packageStatus={packageStatus}
            publishValidation={stepTwoValidation}
            onResourceChange={updateResource}
            onCreationPackageChange={updateCreationPackage}
            onTogglePromptResource={togglePromptResource}
            onAddResource={() => setResourceSheetMode('type')}
            onEditResource={openResourceCard}
            onRemoveResource={removeResourceCard}
            onEditDetails={() => setComposerStep('details')}
          />
          </>
        )}
      </ScrollView>

      <ComposerUndoBar entry={shownUndoEntry} onUndo={applyUndo} onDismiss={dismissUndo} />

      <PostComposerFooter
        step={composerStep}
        bottomInset={bottomInset}
        visibility={draft.visibility}
        isEditMode={isEditMode}
        loading={publishMutation.isPending || isSavingIdentity}
        disabled={!canSubmit || isSavingIdentity || isPickingMedia || pendingRetryMedia.length > 0 || (composerStep === 'resources' && !stepTwoValidation.valid)}
        onNext={goToResources}
        onVisibility={() => setIsVisibilityOpen(true)}
        onPublish={() => void submitPost()}
      />
      </KeyboardAvoidingArea>

      <ResourceComposerSheet
        mode={resourceSheetMode}
        card={editingResource}
        touched={resourceEditorTouched}
        mediaItems={draft.mediaItems}
        bottomInset={bottomInset}
        isUploading={isPickingResourceFile}
        uploadProgress={resourceUploadProgress?.cardId === editingResource?.id ? resourceUploadProgress : null}
        uploadError={resourceUploadError}
        canRetryUpload={pendingResourceUpload?.cardId === editingResource?.id}
        onRequestClose={requestCloseResourceSheet}
        onSave={saveResourceEditor}
        onChooseType={startResourceCard}
        onChange={updateResourceEditorCard}
        onTouchField={touchResourceEditorField}
        onPickFile={() => void chooseResourceFiles('files')}
        onPickPhotos={() => void chooseResourceFiles('photos')}
        onRetryUpload={retryResourceFileUpload}
        onCancelUpload={cancelResourceFileUpload}
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
  const theme = useAppTheme();
  const toolOptions = getMadeWithToolOptions(sourceTools);
  const [activePickerId, setActivePickerId] = useState<string | null>(null);
  const lockedRow = rows[0];

  if (compactReadOnly && lockedRow) {
    const toolLabel = getMadeWithToolLabel(lockedRow) || 'Magicbooklet';
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
            borderColor: hexWithAlpha(theme.colors.image, 0.20),
            backgroundColor: hexWithAlpha(theme.colors.image, 0.08),
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
        {!disabled && rows.length < MAX_MADE_WITH_ROWS ? (
          <View style={{ alignSelf: 'flex-start' }}>
            <MiniAction label="Add another tool" onPress={onAdd} />
          </View>
        ) : null}
      </View>
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
  const theme = useAppTheme();
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
          placeholderTextColor={theme.colors.faint}
          editable={!disabled}
          // Every picker here names a made-with tool or model.
          maxLength={MADE_WITH_LABEL_MAX_LENGTH}
          style={{
            minHeight: appTheme.touch.compact,
            borderRadius: 14,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: isOpen ? `${theme.colors.image}88` : theme.colors.border,
            backgroundColor: disabled ? theme.colors.surface : theme.colors.surfaceInset,
            color: disabled ? theme.colors.faint : theme.colors.text,
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
            opacity: pressed ? appTheme.opacity.pressed : disabled ? 0.38 : 1,
          })}
        >
          <ChevronDown size={16} color={hexWithAlpha(theme.colors.text, 0.58)} />
        </Pressable>
      </View>

      {isOpen && !disabled ? (
        <View
          style={{
            maxHeight: 224,
            borderRadius: 16,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surfaceInset,
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
                    backgroundColor: selected ? hexWithAlpha(theme.colors.image, 0.14) : pressed ? hexWithAlpha(theme.colors.text, 0.07) : 'transparent',
                  })}
                >
                  {entry.type === 'create' ? (
                    <Plus size={15} color={theme.colors.image} />
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

function GeneratedProofCard({ item }: { item: GenerationListItem }) {
  const theme = useAppTheme();
  const mediaUrl = item.media?.url ?? item.output_urls?.[0] ?? item.output_url ?? null;
  const previewUrl = getGenerationPreviewImageUrl(item);
  const mediaKind = getPublishGenerationMediaKind(item);
  const visualUrl = item.media?.previewUrl ?? (mediaKind === 'video' ? previewUrl : mediaUrl);
  // By the name its post shows, as its Made with row names it: none where the
  // catalog names none (a template result's model is its author's).
  const modelName = homeModelLabel(item.model);

  return (
    <View
      style={{
        borderRadius: 18,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: hexWithAlpha(theme.colors.text, 0.10),
        backgroundColor: hexWithAlpha(theme.colors.text, 0.025),
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
            {`Created in Magicbooklet${modelName ? ` with ${modelName}` : ''}.`}
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
          borderColor: hexWithAlpha(theme.colors.text, 0.08),
          backgroundColor: theme.colors.surfaceInset,
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
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: appTheme.spacing.gap, backgroundColor: theme.colors.panelSoft }}>
            <Sparkles size={34} color={theme.colors.motion} />
            <AppText variant="cardTitle">Creation ready</AppText>
          </View>
        )}
        {mediaKind === 'video' ? (
          <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: hexWithAlpha(mediaColors.mediaGround, 0.16) }}>
            <Play size={44} color={mediaColors.onMedia} fill={mediaColors.onMedia} />
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

function MinimalStatusPill({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'workflow' | 'commerce';
}) {
  const theme = useAppTheme();
  const color = tone === 'workflow'
    ? theme.colors.workflow
    : tone === 'commerce'
      ? theme.colors.image
      : theme.colors.muted;

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

/** What the row is showing right now: which card is up, and where it would land. */
interface MediaDragState {
  id: string;
  from: number;
  to: number;
  translateX: number;
}

/** The same drag as the gesture sees it, before it becomes geometry. */
interface ActiveMediaDrag {
  id: string;
  from: number;
  /** Where inside the card the finger landed, so the row knows where the *finger* is. */
  grabOffsetX: number;
  dx: number;
  startScrollX: number;
}

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
  const theme = useAppTheme();
  // The whole drag lives here rather than inside a card, because Drag and drop
  // asks the *row* to respond: the neighbours move aside to show where the card
  // will land, and the row scrolls itself when the destination is off-screen.
  // A card only reports its gesture upwards.
  const [drag, setDrag] = useState<MediaDragState | null>(null);
  // Kept here rather than threaded down from the screen: a Modal renders into
  // its own native window, so the state only has to sit above the cards.
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const items = draft.mediaItems;
  const itemCount = items.length;
  const canAddMore = !disabled && itemCount < MEDIA_MAX_ITEMS;

  // On Android the horizontal ScrollView intercepts touches natively, so a card
  // can never win the gesture from JS once scrolling engages. Switching the
  // ScrollView off the moment a card is picked up is what hands the drag over.
  // iOS needs the other half of that, and it cannot be done from here: the
  // navigator's own full-screen back gesture is native and takes the drag
  // outright, so the route turns it off in `app/_layout.tsx`.

  const rowRef = useRef<ScrollView>(null);
  const scrollXRef = useRef(0);
  const rowWidthRef = useRef(0);
  const autoScrollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The live drag, in a ref so the pan handlers stay stable across the frames
  // the drag itself is causing.
  const dragRef = useRef<ActiveMediaDrag | null>(null);
  // Everything the stable handlers below need to read as of *this* render.
  const latestRef = useRef({ itemCount, canAddMore, onReorderMedia });
  latestRef.current = { itemCount, canAddMore, onReorderMedia };

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRef.current) {
      clearInterval(autoScrollRef.current);
      autoScrollRef.current = null;
    }
  }, []);

  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  const readDragGeometry = useCallback((active: ActiveMediaDrag) => {
    const { itemCount: count, canAddMore: hasAddCard } = latestRef.current;
    const cardContentX = active.from * MEDIA_CARD_STEP + active.dx + (scrollXRef.current - active.startScrollX);
    return {
      cardContentX,
      to: resolveDropIndex(cardContentX, count),
      pointerViewportX: cardContentX + active.grabOffsetX - scrollXRef.current,
      maxScrollX: Math.max(0, resolveRowContentWidth(count, hasAddCard) - rowWidthRef.current),
    };
  }, []);

  const applyDragGeometry = useCallback(() => {
    const active = dragRef.current;
    if (!active) return;
    const { cardContentX, to, pointerViewportX, maxScrollX } = readDragGeometry(active);
    setDrag({
      id: active.id,
      from: active.from,
      to,
      translateX: cardContentX - active.from * MEDIA_CARD_STEP,
    });

    const step = resolveAutoScrollStep({
      pointerViewportX,
      rowWidth: rowWidthRef.current,
      scrollX: scrollXRef.current,
      maxScrollX,
    });
    if (step === 0) {
      stopAutoScroll();
      return;
    }
    if (autoScrollRef.current) return;
    autoScrollRef.current = setInterval(() => {
      const live = dragRef.current;
      if (!live) {
        stopAutoScroll();
        return;
      }
      const tick = resolveAutoScrollStep({
        pointerViewportX: readDragGeometry(live).pointerViewportX,
        rowWidth: rowWidthRef.current,
        scrollX: scrollXRef.current,
        maxScrollX: readDragGeometry(live).maxScrollX,
      });
      if (tick === 0) {
        stopAutoScroll();
        return;
      }
      scrollXRef.current += tick;
      rowRef.current?.scrollTo({ x: scrollXRef.current, animated: false });
      applyDragGeometry();
    }, MEDIA_DRAG_SCROLL_INTERVAL_MS);
  }, [readDragGeometry, stopAutoScroll]);

  const beginDrag = useCallback((index: number, id: string, grabOffsetX: number) => {
    dragRef.current = { id, from: index, grabOffsetX, dx: 0, startScrollX: scrollXRef.current };
    setDrag({ id, from: index, to: index, translateX: 0 });
  }, []);

  const moveDrag = useCallback((dx: number) => {
    const active = dragRef.current;
    if (!active) return;
    active.dx = dx;
    applyDragGeometry();
  }, [applyDragGeometry]);

  const endDrag = useCallback((commit: boolean) => {
    stopAutoScroll();
    const active = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!active || !commit) return;
    // Read the landing slot from the drag itself rather than from render state,
    // so a release that arrives before the last frame still lands where the row
    // was showing it would.
    const { to } = readDragGeometry(active);
    if (to !== active.from) latestRef.current.onReorderMedia(active.id, to);
  }, [readDragGeometry, stopAutoScroll]);

  return (
    <View style={{ gap: 10 }}>
      <View style={{ gap: 4 }}>
        <AppText variant="label" color="text">
          Upload images or videos <AppText variant="caption" color="primary">Required</AppText>
        </AppText>
        <AppText variant="caption" color="muted">
          {itemCount > 1
            ? `Cover first · max ${MEDIA_MAX_ITEMS} · hold a card to reorder`
            : `Cover first · max ${MEDIA_MAX_ITEMS}`}
        </AppText>
      </View>
      {itemCount > 0 ? (
        <ScrollView
          ref={rowRef}
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
          scrollEnabled={drag === null}
          scrollEventThrottle={16}
          onScroll={(event) => { scrollXRef.current = event.nativeEvent.contentOffset.x; }}
          onLayout={(event) => { rowWidthRef.current = event.nativeEvent.layout.width; }}
          contentContainerStyle={{ gap: MEDIA_CARD_GAP }}
        >
          {items.map((item, index) => (
            <MediaGalleryCard
              key={item.id}
              item={item}
              index={index}
              totalItems={itemCount}
              disabled={disabled}
              drag={drag}
              onRemoveMedia={onRemoveMedia}
              onReorderMedia={onReorderMedia}
              onDragStart={beginDrag}
              onDragMove={moveDrag}
              onDragEnd={endDrag}
              onPreviewMedia={setPreviewIndex}
            />
          ))}
          {canAddMore ? (
            <AddMediaGalleryCard
              isPicking={isPicking}
              remainingSlots={MEDIA_MAX_ITEMS - itemCount}
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
            borderColor: pressed ? `${theme.colors.image}aa` : theme.colors.border,
            backgroundColor: pressed ? theme.colors.surfaceStrong : theme.colors.surfaceInset,
            alignItems: 'center',
            justifyContent: 'center',
            gap: appTheme.spacing.compact,
            padding: appTheme.spacing.card,
            opacity: disabled || isPicking ? appTheme.opacity.disabled : 1,
          })}
        >
          <ImageIcon size={30} color={theme.colors.muted} />
          <AppText variant="label" color="muted">{isPicking ? 'Preparing media…' : 'Add media'}</AppText>
        </Pressable>
      )}
      <FieldErrorText message={error} />
      <ComposerMediaLightbox
        items={draft.mediaItems}
        activeIndex={previewIndex}
        onClose={() => setPreviewIndex(null)}
        onNavigate={setPreviewIndex}
      />
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
  const theme = useAppTheme();
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
        borderColor: pressed ? `${theme.colors.image}cc` : theme.colors.border,
        backgroundColor: pressed ? theme.colors.surfaceStrong : theme.colors.surfaceInset,
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
          backgroundColor: theme.colors.surfaceInset,
        }}
      >
        <View
          style={{
            width: 42,
            height: 42,
            borderRadius: 21,
            borderWidth: 1,
            borderColor: `${theme.colors.image}88`,
            backgroundColor: hexWithAlpha(theme.colors.image, 0.12),
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Plus size={22} color={theme.colors.image} />
        </View>
        <AppText variant="caption" color="muted">{isPicking ? 'Preparing…' : 'Add media'}</AppText>
      </View>
      <View style={{ padding: 9, gap: 7 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 12, fontWeight: '800' }}>
          Add media
        </Text>
        <Text numberOfLines={1} style={{ color: theme.colors.muted, fontSize: 11, fontWeight: '700' }}>
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
  drag,
  onRemoveMedia,
  onReorderMedia,
  onDragStart,
  onDragMove,
  onDragEnd,
  onPreviewMedia,
}: {
  item: PostComposerMediaItem;
  index: number;
  totalItems: number;
  disabled: boolean;
  drag: MediaDragState | null;
  onRemoveMedia: (id: string) => void;
  onReorderMedia: (id: string, targetIndex: number) => void;
  onDragStart: (index: number, id: string, grabOffsetX: number) => void;
  onDragMove: (dx: number) => void;
  onDragEnd: (commit: boolean) => void;
  onPreviewMedia: (index: number) => void;
}) {
  const theme = useAppTheme();
  const isDragArmedRef = useRef(false);
  const isResponderRef = useRef(false);
  const touchOriginRef = useRef<{ x: number; y: number } | null>(null);
  const dragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const grabOffsetRef = useRef(0);
  // A touch on the card opens the preview on lift, unless it turns into a
  // scroll, a hold, or lands on the remove control that sits on top of it.
  const tapCandidateRef = useRef(false);
  const suppressTapRef = useRef(false);
  const label = getComposerMediaLabel(index);
  const canDrag = !disabled && totalItems > 1;

  const isDragging = drag?.id === item.id;
  // The card being dragged rides the finger; the rest step aside to open the
  // slot it would land in. Drag and drop: "show people whether a destination
  // can accept dragged content ... display an insertion point."
  const translateX = isDragging
    ? drag.translateX
    : drag
      ? resolveNeighbourShift(index, drag.from, drag.to)
      : 0;

  const clearDragTimer = () => {
    if (dragTimerRef.current) {
      clearTimeout(dragTimerRef.current);
      dragTimerRef.current = null;
    }
  };

  useEffect(() => () => clearDragTimer(), []);

  // Press-and-hold arms the reorder. Until it fires the card claims nothing, so
  // an ordinary swipe scrolls the row instead of fighting it.
  const handleTouchStart = (event: GestureResponderEvent) => {
    const { pageX, pageY, locationX } = event.nativeEvent;
    // Recorded ahead of the canDrag guard: a lone media item has nothing to
    // reorder but must still open its preview on tap.
    touchOriginRef.current = { x: pageX, y: pageY };
    tapCandidateRef.current = true;
    grabOffsetRef.current = locationX;

    if (!canDrag) return;

    clearDragTimer();
    dragTimerRef.current = setTimeout(() => {
      // The hold completed, so this is a deliberate pick-up — lifting in place
      // should settle the card rather than open a preview.
      tapCandidateRef.current = false;
      isDragArmedRef.current = true;
      // Frees the gesture from the native scroller so the pan below can take it,
      // and holds the navigator's swipe-back off for the length of the drag.
      onDragStart(index, item.id, grabOffsetRef.current);
      haptic.medium();
    }, MEDIA_DRAG_HOLD_MS);
  };

  // Moving before the hold completes means the finger is scrolling, not picking
  // the card up — drop the pending arm so a slow swipe never becomes a reorder.
  const handleTouchMove = (event: GestureResponderEvent) => {
    const origin = touchOriginRef.current;
    if (!origin || isDragArmedRef.current) return;
    const { pageX, pageY } = event.nativeEvent;
    if (
      Math.abs(pageX - origin.x) > MEDIA_DRAG_SLOP
      || Math.abs(pageY - origin.y) > MEDIA_DRAG_SLOP
    ) {
      // Travelled too far to be a tap — this is a scroll.
      tapCandidateRef.current = false;
      clearDragTimer();
    }
  };

  const releaseDrag = (commit: boolean) => {
    const wasArmed = isDragArmedRef.current;
    isDragArmedRef.current = false;
    clearDragTimer();
    if (wasArmed) onDragEnd(commit);
  };

  const clearTouchState = () => {
    touchOriginRef.current = null;
    tapCandidateRef.current = false;
    suppressTapRef.current = false;
    if (!isResponderRef.current) releaseDrag(false);
  };

  // If the card armed but the finger lifted without ever moving, no responder
  // callback runs — clean up here so it does not stay stuck in the lifted state.
  const handleTouchEnd = () => {
    const wasTap = tapCandidateRef.current && !suppressTapRef.current;
    clearTouchState();
    if (wasTap) onPreviewMedia(index);
  };

  const dragResponder = useMemo(() => PanResponder.create({
    // Never claim on touch-down. The horizontal ScrollView that holds these
    // cards has to own the gesture by default, otherwise every swipe that
    // happens to start on a card is captured and the row barely scrolls.
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: () => isDragArmedRef.current,
    onPanResponderGrant: () => {
      isResponderRef.current = true;
    },
    onPanResponderMove: (_event, gesture) => {
      if (isDragArmedRef.current) onDragMove(gesture.dx);
    },
    onPanResponderRelease: () => {
      isResponderRef.current = false;
      releaseDrag(true);
    },
    onPanResponderTerminate: () => {
      isResponderRef.current = false;
      releaseDrag(false);
    },
    onPanResponderTerminationRequest: () => false,
  // The callbacks are stable by construction (the row memoises them), so the
  // responder survives every frame the drag itself causes.
  }), [onDragMove, onDragEnd]);

  return (
    <View
      accessibilityRole={canDrag ? 'adjustable' : 'image'}
      // The name, with the position as the value, both in every state: on
      // Android a value that goes back to undefined clears the whole
      // description, name and all, and a position in both was read twice.
      accessibilityLabel={label}
      accessibilityHint="Opens a full preview of this media"
      accessibilityValue={{ text: isDragging ? describeDropTarget(drag.to, totalItems) : `${index + 1} of ${totalItems}` }}
      // The pointer path opens the preview on tap; this is the same action for
      // a screen reader, which never produces those raw touch events.
      onAccessibilityTap={() => onPreviewMedia(index)}
      // An empty list, never undefined: Android keeps the actions a view had
      // when the prop goes back to undefined, so the only card left kept
      // offering Move left and Move right, which then did nothing.
      accessibilityActions={canDrag ? [
        { name: 'decrement', label: 'Move left' },
        { name: 'increment', label: 'Move right' },
      ] : []}
      onAccessibilityAction={canDrag ? (event) => {
        if (event.nativeEvent.actionName === 'decrement' && index > 0) {
          onReorderMedia(item.id, index - 1);
        }
        if (event.nativeEvent.actionName === 'increment' && index < totalItems - 1) {
          onReorderMedia(item.id, index + 1);
        }
      } : undefined}
      {...dragResponder.panHandlers}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={clearTouchState}
      style={{
        width: MEDIA_CARD_WIDTH,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: isDragging ? `${theme.colors.image}dd` : index === 0 ? `${theme.colors.image}aa` : theme.colors.border,
        backgroundColor: isDragging ? theme.colors.surfaceStrong : theme.colors.surfaceInset,
        overflow: 'hidden',
        transform: [{ translateX }],
        zIndex: isDragging ? 10 : 0,
        opacity: isDragging ? 0.92 : 1,
      }}
    >
      <View style={{ height: 132, backgroundColor: theme.colors.surfaceInset }}>
        {item.mediaKind === 'image' ? (
          <StableMediaImage
            url={item.previewUrl ?? item.uri}
            cacheKey={`composer:${item.id}`}
            contentFit="cover"
            style={{ position: 'absolute', inset: 0 }}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.panelSoft }}>
            <Play size={34} color={theme.colors.textSecondary} fill={theme.colors.textSecondary} />
          </View>
        )}
        {!disabled ? (
          <Pressable
            accessibilityRole="button"
              accessibilityLabel={`Remove ${label}`}
              hitSlop={9}
            // Touch events reach the card underneath too, so removal has to say
            // "not a tap" or dismissing a card would also open its preview.
            onPressIn={() => { suppressTapRef.current = true; }}
            onPress={() => onRemoveMedia(item.id)}
            style={({ pressed }) => ({
              position: 'absolute',
              top: 8,
              right: 8,
              width: 30,
              height: 30,
              borderRadius: 15,
              borderWidth: 1,
              borderColor: hexWithAlpha(mediaColors.onMedia, 0.2),
              backgroundColor: hexWithAlpha(mediaColors.mediaGround, 0.58),
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <X size={15} color={mediaColors.onMedia} />
          </Pressable>
        ) : null}
      </View>
      <View style={{ padding: 9, gap: 7 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 12, fontWeight: '800' }}>
          {isDragging ? getComposerMediaLabel(drag.to) : label}
        </Text>
        <Text numberOfLines={1} style={{ color: theme.colors.muted, fontSize: 11, fontWeight: '700' }}>
          {getComposerMediaFileName(item) ?? (item.mediaKind === 'video' ? 'Video' : 'Image')}
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
  const theme = useAppTheme();
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
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surfaceStrong,
        opacity: disabled ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
        paddingHorizontal: 12,
        alignItems: 'center',
        justifyContent: 'center',
      })}
    >
      <Text style={{ color: theme.colors.text, fontSize: 12, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}

function validateCurrentDraft(
  draft: PostComposerDraft,
  selectedGeneration: GenerationListItem | null,
  isEditMode: boolean,
  skipGenerationSelection = false,
  options: PostComposerValidationOptions = {},
) {
  const result = validatePostComposerDraft(draft, {
    ...options,
    // Only a new post's publish copies the creation's saved inputs into its recipe.
    includesCreationReferences: !isEditMode && willAttachGenerationReferences(selectedGeneration, draft),
  });
  if (!result.valid) return result;
  if (draft.mode === 'creation' && !selectedGeneration && !skipGenerationSelection) {
    return { valid: false, message: 'Choose a finished creation before publishing.' };
  }
  return result;
}

/**
 * The files still on this device of the media with no staged upload, which is
 * where a new upload of them would be read from. A remote URL is media the post
 * held, not a device file.
 */
async function findDeviceFiles(items: PostComposerMediaItem[]): Promise<Set<string>> {
  const found = new Set<string>();
  const uris = items.flatMap((item) => (
    !item.storagePath && item.uri && !/^https?:\/\//i.test(item.uri) ? [item.uri] : []
  ));
  if (uris.length === 0) return found;
  try {
    const { File: ExpoFile } = await import('expo-file-system');
    for (const uri of uris) {
      try {
        if (new ExpoFile(uri).exists) found.add(uri);
      } catch {
        // An unreadable local file is treated as gone, which is what it is.
      }
    }
  } catch {
    // With no file system to ask, no file counts as still there.
  }
  return found;
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
    // The header's post count and the seller total ride on the profile.
    invalidateProfileStats(queryClient, userId),
    queryClient.invalidateQueries({ queryKey: ['generations', userId] }),
    queryClient.invalidateQueries({ queryKey: ['showcase-feed'] }),
    // Home's shelf asks a member who has never posted to post; after a first
    // post it offers the next thing instead.
    queryClient.invalidateQueries({ queryKey: ['home-shelf'] }),
  ]);
}

/** The screens a saved edit can return to, which still hold the post as it was. */
async function invalidateEditedPostCaches(queryClient: QueryClient, userId: string | undefined, postId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['immersive-preview-source'] }),
    queryClient.invalidateQueries({ queryKey: ['showcase-post', postId] }),
    queryClient.invalidateQueries({ queryKey: ['owner-text-post', postId] }),
    queryClient.invalidateQueries({ queryKey: ['seller-dashboard-posts', userId] }),
    // The post page keeps its recipe for a minute, and showed the price and cards from before the save.
    queryClient.invalidateQueries({ queryKey: ['post-resource-bundle', postId] }),
  ]);
}
