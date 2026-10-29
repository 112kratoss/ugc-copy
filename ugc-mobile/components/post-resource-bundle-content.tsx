import {
  Copy,
  Download,
  ExternalLink,
  FileText,
  Images,
  Link2,
  Lock,
  NotebookText,
  Paperclip,
  Repeat2,
  SlidersHorizontal,
  TextQuote,
  Workflow,
} from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';

import { ResourceAction } from '@/components/resource-action';
import { ResourcePrompt } from '@/components/resource-prompt';
import { FeedMediaFrame } from '@/components/feed-media-frame';
import { PostResourceReferences } from '@/components/post-resource-references';
import { creatorAuthoredDescription } from '@/lib/post-resource-bundle-view-model';
import {
  describeRecipeCardPreview,
  describeRecipeFile,
  describeRecipeGroup,
  groupRecipeForReading,
  parseGenerationSetupNotes,
  recipeItemKind,
  recipeLinkLabel,
  shouldShowRecipeItemTitle,
  type GenerationSetup,
  type RecipeGroupKind,
  type RecipeReadingGroup,
} from '@/lib/recipe-reading/recipe-reading';
import { hexWithAlpha } from '@/lib/eased-fade';
import { verticalHitSlop } from '@/lib/hit-target';
import { appTheme, mediaColors } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type {
  PostResourceAttachment,
  PostResourceBundleLockedPreview,
  PostResourceBundleResources,
  PostResourceCardPreview,
  PostResourceItem,
  PostResourceItemScope,
  PostResourceSection,
  ShowcaseMediaItem,
} from '@/lib/types';

type ResourceFileInput = {
  contentType: string | null;
  storagePath: string;
  title: string;
};

type PostResourceBundleContentProps = {
  fileLoadingPath?: string | null;
  lockedPreview?: PostResourceBundleLockedPreview | null;
  mediaItems?: ShowcaseMediaItem[];
  onCopy?: (text: string) => Promise<void> | void;
  onError?: (message: string) => void;
  onOpenFile?: (file: ResourceFileInput) => Promise<void> | void;
  onOpenUrl?: (url: string) => Promise<void> | void;
  resolveFileUrl?: (storagePath: string) => Promise<string>;
  resources: PostResourceBundleResources | null;
};

/**
 * A group as the shared reading rule makes it (the web reads by the same
 * one), with the outputs it applies to: its card's own, or, for a group
 * gathered by kind, those all of its items share.
 */
type ResourceCard = RecipeReadingGroup<PostResourceItem, PostResourceSection> & {
  scope: PostResourceItemScope;
};

const ALL_SCOPE: PostResourceItemScope = { kind: 'all' };

export function PostResourceBundleContent({
  fileLoadingPath = null,
  lockedPreview,
  mediaItems = [],
  onCopy,
  onError,
  onOpenFile,
  onOpenUrl,
  resolveFileUrl,
  resources,
}: PostResourceBundleContentProps) {
  const theme = useAppTheme();
  const [selectedMediaKey, setSelectedMediaKey] = useState<string | null>(null);
  const cards = useMemo(() => buildUnlockedResourceCards(resources), [resources]);
  const cardPreviews = lockedPreview?.cardPreviews ?? [];
  const redactedAttachments = lockedPreview?.attachmentPreviews ?? [];
  const hasScopedContent = resources
    ? cards.some((card) => isMediaScope(card.scope) || [...card.items, ...card.media].some((item) => isMediaScope(item.scope)))
    : cardPreviews.some((card) => isMediaScope(card.scope));
  const selectableMedia = useMemo(
    () => mediaItems.filter((item) => Boolean(resourceMediaKey(item))),
    [mediaItems]
  );
  // Props can swap from the latest bundle to the purchased revision while
  // this component stays mounted. Derive a valid selection synchronously so
  // the old key cannot produce a one-frame false empty state before the effect
  // commits the reset.
  const activeSelectedMediaKey = selectedMediaKey
    && selectableMedia.some((item) => resourceMediaKey(item) === selectedMediaKey)
    ? selectedMediaKey
    : null;
  const visibleCardPreviews = cardPreviews.filter((card) => scopeMatches(card.scope, activeSelectedMediaKey));
  useEffect(() => {
    if (selectedMediaKey && activeSelectedMediaKey === null) {
      setSelectedMediaKey(null);
    }
  }, [activeSelectedMediaKey, selectedMediaKey]);
  const showMediaSelector = hasScopedContent && selectableMedia.length > 1;

  const selector = showMediaSelector ? (
    <ResourceMediaSelector
      mediaItems={selectableMedia}
      onSelect={setSelectedMediaKey}
      selectedMediaKey={activeSelectedMediaKey}
    />
  ) : null;

  if (!resources) {
    return (
      <View style={{ gap: 12 }}>
        {selector}
        {visibleCardPreviews.length > 0 ? (
          <View style={{ gap: 10 }}>
            {visibleCardPreviews.map((card) => (
              <LockedResourceCard
                card={card}
                key={card.sectionId}
                mediaItems={selectableMedia}
              />
            ))}
          </View>
        ) : null}
        {/*
          The server has already redacted these to "File 1" / "Link 1" with no
          size or type. They are here so a locked package still communicates how
          much is inside, which is what the web panel shows.
        */}
        {redactedAttachments.length > 0 ? (
          <View style={{ gap: 7 }}>
            {redactedAttachments.map((attachment, index) => (
              <View
                key={`${attachment.label}-${index}`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 9,
                  borderRadius: appTheme.radii.lg,
                  borderCurve: 'continuous',
                  borderWidth: 1,
                  borderColor: theme.colors.borderSubtle,
                  backgroundColor: theme.colors.surfaceInset,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                }}
              >
                <Lock size={14} color={theme.colors.muted} />
                <Text style={{ color: theme.colors.textSecondary, ...appTheme.type.bodySm }}>
                  {attachment.label}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {activeSelectedMediaKey && cardPreviews.length > 0 && visibleCardPreviews.length === 0 && redactedAttachments.length === 0 ? (
          <Text style={{ color: theme.colors.muted, ...appTheme.type.bodySm }}>
            No items apply to this output.
          </Text>
        ) : null}
        {cardPreviews.length === 0 && redactedAttachments.length === 0 ? (
          <Text style={{ color: theme.colors.muted, ...appTheme.type.bodySm }}>
            What&apos;s inside stays private until you unlock this recipe.
          </Text>
        ) : null}
      </View>
    );
  }

  const visibleCards = cards.flatMap((card) => {
    if (!scopeMatches(card.scope, activeSelectedMediaKey)) return [];
    if (!activeSelectedMediaKey) return [card];
    const inScope = (item: PostResourceItem) => scopeMatches(item.scope ?? card.scope, activeSelectedMediaKey);
    const items = card.items.filter(inScope);
    const media = card.media.filter(inScope);
    return items.length + media.length > 0 ? [{ ...card, items, media }] : [];
  });

  return (
    <View style={{ gap: 12 }}>
      {selector}
      {visibleCards.length > 0 ? visibleCards.map((card) => (
        <UnlockedResourceGroup
          card={card}
          fileLoadingPath={fileLoadingPath}
          key={card.id}
          mediaItems={selectableMedia}
          onCopy={onCopy}
          onError={onError}
          onOpenFile={onOpenFile}
          onOpenUrl={onOpenUrl}
          resolveFileUrl={resolveFileUrl}
        />
      )) : (
        <Text style={{ color: theme.colors.muted, ...appTheme.type.bodySm }}>
          No items apply to this output.
        </Text>
      )}
    </View>
  );
}

export type ResourceRevision = 'latest' | 'purchased';

/** A compact pill, given the reach of a full control. */
const REVISION_PILL_HEIGHT = 36;

/**
 * Latest or the version this buyer unlocked, for a bundle the creator edited
 * after the purchase. Shared by the unlock screen and the post's resources
 * card, where the purchased version used to be out of reach.
 */
export function ResourceRevisionSwitch({
  onSelect,
  selected,
}: {
  onSelect: (revision: ResourceRevision) => void;
  selected: ResourceRevision;
}) {
  const theme = useAppTheme();
  const options: Array<{ label: string; revision: ResourceRevision }> = [
    { label: 'Latest', revision: 'latest' },
    { label: 'Purchased', revision: 'purchased' },
  ];
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {options.map((option) => {
        const isSelected = option.revision === selected;
        return (
          <Pressable
            accessibilityLabel={`Show ${option.label.toLowerCase()} recipe version`}
            accessibilityRole="button"
            accessibilityState={{ selected: isSelected }}
            hitSlop={verticalHitSlop(REVISION_PILL_HEIGHT)}
            key={option.revision}
            onPress={() => onSelect(option.revision)}
            style={({ pressed }) => ({
              minHeight: REVISION_PILL_HEIGHT,
              justifyContent: 'center',
              borderRadius: appTheme.radii.pill,
              borderWidth: 1,
              borderColor: isSelected ? theme.colors.success : theme.colors.border,
              backgroundColor: isSelected ? `${theme.colors.success}20` : theme.colors.surface,
              opacity: pressed ? appTheme.opacity.pressed : 1,
              paddingHorizontal: 14,
              paddingVertical: 9,
            })}
          >
            <Text style={{ color: isSelected ? theme.colors.success : theme.colors.muted, ...appTheme.type.caption }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ResourceMediaSelector({
  mediaItems,
  onSelect,
  selectedMediaKey,
}: {
  mediaItems: ShowcaseMediaItem[];
  onSelect: (mediaKey: string | null) => void;
  selectedMediaKey: string | null;
}) {
  const theme = useAppTheme();
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.colors.faint, ...appTheme.type.caption, fontWeight: '800', textTransform: 'uppercase' }}>
        Items for
      </Text>
      <ScrollView horizontal keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8 }} showsHorizontalScrollIndicator={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: selectedMediaKey === null }}
          onPress={() => onSelect(null)}
          style={({ pressed }) => ({
            minHeight: 48,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: appTheme.radii.pill,
            borderWidth: 1,
            borderColor: selectedMediaKey === null ? theme.colors.primary : theme.colors.border,
            backgroundColor: selectedMediaKey === null ? `${theme.colors.primary}20` : theme.colors.surface,
            opacity: pressed ? appTheme.opacity.pressed : 1,
            paddingHorizontal: 16,
          })}
        >
          <Text style={{ color: selectedMediaKey === null ? theme.colors.primary : theme.colors.textSecondary, ...appTheme.type.caption, fontWeight: '800' }}>
            All items
          </Text>
        </Pressable>
        {mediaItems.map((item, index) => {
          const mediaKey = resourceMediaKey(item);
          if (!mediaKey) return null;
          const selected = selectedMediaKey === mediaKey;
          return (
            <Pressable
              accessibilityLabel={`Items for output ${index + 1}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={mediaKey}
              onPress={() => onSelect(mediaKey)}
              style={({ pressed }) => ({
                width: 48,
                height: 48,
                borderRadius: 14,
                borderCurve: 'continuous',
                borderWidth: 2,
                borderColor: selected ? theme.colors.primary : theme.colors.border,
                backgroundColor: theme.colors.surfaceInset,
                opacity: pressed ? appTheme.opacity.pressed : 1,
                overflow: 'hidden',
              })}
            >
              <MediaScopeThumbnail item={item} />
              <View style={{ position: 'absolute', right: 3, bottom: 3, minWidth: 17, height: 17, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: hexWithAlpha(mediaColors.mediaGround, 0.72), paddingHorizontal: 4 }}>
                <Text style={{ color: mediaColors.onMedia, fontSize: 11, lineHeight: 14, fontWeight: '900' }}>{index + 1}</Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function LockedResourceCard({
  card,
  mediaItems,
}: {
  card: PostResourceCardPreview;
  mediaItems: ShowcaseMediaItem[];
}) {
  const theme = useAppTheme();
  // The kind only where the title does not say it, and the count only past
  // one, as the web's locked card reads (audit B-F16): a card titled
  // "Prompt or script" read "Prompt or script · 1 item" under it.
  const { kindLabel, countLabel } = describeRecipeCardPreview({ title: card.publicTitle, resourceType: card.resourceType, itemCount: card.itemCount });
  const subtitle = [kindLabel, countLabel].filter(Boolean).join(' · ');
  return (
    <View style={{ borderRadius: appTheme.radii.lg, borderCurve: 'continuous', borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface, padding: appTheme.spacing.gap, gap: 9 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 11 }}>
        <RecipeGroupIcon kind={recipeItemKind({ type: card.resourceType, contentType: null, textContent: null })} />
        <View style={{ flex: 1, gap: 4 }}>
          <Text selectable style={{ color: theme.colors.text, ...appTheme.type.bodySm, fontWeight: '800' }}>
            {card.publicTitle}
          </Text>
          {subtitle ? (
            <Text style={{ color: theme.colors.muted, ...appTheme.type.caption }}>{subtitle}</Text>
          ) : null}
        </View>
        {card.hasRemix ? (
          <View style={{ borderRadius: appTheme.radii.pill, backgroundColor: `${theme.colors.primary}18`, paddingHorizontal: 9, paddingVertical: 5 }}>
            <Text style={{ color: theme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>Remix included</Text>
          </View>
        ) : null}
      </View>
      <ScopeSummary mediaItems={mediaItems} scope={card.scope} />
    </View>
  );
}

function UnlockedResourceGroup({
  card,
  fileLoadingPath,
  mediaItems,
  onCopy,
  onError,
  onOpenFile,
  onOpenUrl,
  resolveFileUrl,
}: {
  card: ResourceCard;
  fileLoadingPath: string | null;
  mediaItems: ShowcaseMediaItem[];
  onCopy?: (text: string) => Promise<void> | void;
  onError?: (message: string) => void;
  onOpenFile?: (file: ResourceFileInput) => Promise<void> | void;
  onOpenUrl?: (url: string) => Promise<void> | void;
  resolveFileUrl?: (storagePath: string) => Promise<string>;
}) {
  const theme = useAppTheme();
  // The card's name, its line and its order come from the shared reading
  // rule: a saved setup alone in a card named by a form label is "Generation
  // setup", and a gallery says what it holds ("3 images · 1 video").
  const itemCount = card.items.length + card.media.length;
  const subtitle = describeRecipeGroup(card);
  const description = creatorAuthoredDescription(card.kind === 'prompt' ? 'prompt' : undefined, card.section?.description);

  return (
    <View style={{ borderRadius: appTheme.radii.xl, borderCurve: 'continuous', borderWidth: 1, borderColor: theme.colors.borderSubtle, backgroundColor: theme.colors.surface, padding: appTheme.spacing.card, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 11 }}>
        <RecipeGroupIcon kind={card.kind} />
        <View style={{ flex: 1, gap: 3 }}>
          <Text selectable style={{ color: theme.colors.text, ...appTheme.type.cardTitle, fontWeight: '800' }}>
            {card.title}
          </Text>
          {subtitle ? (
            <Text style={{ color: theme.colors.muted, ...appTheme.type.caption }}>
              {subtitle}
            </Text>
          ) : null}
          {description?.trim() ? (
            <Text selectable style={{ color: theme.colors.textSecondary, ...appTheme.type.bodySm }}>
              {description.trim()}
            </Text>
          ) : null}
        </View>
      </View>
      <ScopeSummary mediaItems={mediaItems} scope={card.scope} />
      {card.items.map((item, index) => (
        <ResourceItemRow
          divided={index > 0}
          fileLoadingPath={fileLoadingPath}
          groupItemCount={itemCount}
          item={item}
          key={resourceItemKey(item)}
          onCopy={onCopy}
          onOpenFile={onOpenFile}
          onOpenUrl={onOpenUrl}
          showTitle={shouldShowRecipeItemTitle({ title: card.title, itemCount }, item)}
        />
      ))}
      {card.media.length > 0 && resolveFileUrl && onOpenUrl ? (
        <PostResourceReferences
          items={card.media}
          // A card of references already says so in its name; a card that
          // mixes text and pictures marks where the pictures start.
          label={card.items.length > 0 ? 'References' : null}
          onError={onError}
          onOpenUrl={async (url) => {
            await onOpenUrl(url);
          }}
          resolveFileUrl={resolveFileUrl}
        />
      ) : null}
    </View>
  );
}

/**
 * One resource, laid out flat inside its group: what it is, then what it
 * says, then what can be done with it. No box of its own — the group is the
 * one surface, so the text on it keeps its contrast.
 */
function ResourceItemRow({
  divided,
  fileLoadingPath,
  groupItemCount,
  item,
  onCopy,
  onOpenFile,
  onOpenUrl,
  showTitle: showOwnTitle,
}: {
  divided: boolean;
  fileLoadingPath: string | null;
  groupItemCount: number;
  item: PostResourceItem;
  onCopy?: (text: string) => Promise<void> | void;
  onOpenFile?: (file: ResourceFileInput) => Promise<void> | void;
  onOpenUrl?: (url: string) => Promise<void> | void;
  showTitle: boolean;
}) {
  const theme = useAppTheme();
  const textContent = item.textContent?.trim() ?? '';
  const externalUrl = item.externalUrl?.trim() ?? '';
  const storagePath = item.storagePath?.trim() ?? '';
  const fileLoading = Boolean(storagePath && storagePath === fileLoadingPath);
  const setup = item.type === 'note' || item.type === 'settings' ? parseGenerationSetupNotes(textContent) : null;
  // A setup alone in its card is the card, whatever the note was titled.
  const showTitle = showOwnTitle && !(setup && groupItemCount === 1);
  const meta = item.storagePath ? describeRecipeFile(item.contentType, item.sizeBytes) : '';
  const hasHeading = showTitle || Boolean(item.description) || Boolean(meta);
  const hasActions = Boolean((textContent && onCopy) || (externalUrl && onOpenUrl) || (storagePath && onOpenFile));

  return (
    <View
      style={{
        gap: 9,
        paddingTop: divided ? 12 : 0,
        borderTopWidth: divided ? 1 : 0,
        borderTopColor: theme.colors.borderSubtle,
      }}
    >
      {hasHeading ? (
        <View style={{ gap: 3 }}>
          {showTitle ? (
            <Text selectable style={{ color: theme.colors.text, ...appTheme.type.bodySm, fontWeight: '800' }}>{item.title}</Text>
          ) : null}
          {item.description ? (
            <Text selectable style={{ color: theme.colors.muted, ...appTheme.type.caption }}>{item.description}</Text>
          ) : null}
          {meta ? (
            <Text style={{ color: theme.colors.muted, ...appTheme.type.caption }}>{meta}</Text>
          ) : null}
        </View>
      ) : null}
      {setup ? (
        <GenerationSetupList entries={setup.entries} />
      ) : textContent && item.type === 'prompt' ? (
        <ResourcePrompt text={textContent} onCopy={onCopy} />
      ) : textContent ? (
        <Text selectable style={{ color: theme.colors.textSecondary, ...appTheme.type.bodySm }}>
          {textContent}
        </Text>
      ) : null}
      {/* A workflow snapshot on its own draws nothing, as on web: neither
          client can open one (web shows a workflow only by its share link),
          and "Workflow project included" promised a project nobody could reach. */}
      {hasActions ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {textContent && onCopy && item.type !== 'prompt' ? (
            <ResourceAction
              confirmLabel="Copied"
              icon={<Copy size={appTheme.icon.xs} color={theme.colors.success} />}
              label="Copy"
              onPress={() => onCopy(textContent)}
            />
          ) : null}
          {externalUrl && onOpenUrl ? (
            <ResourceAction
              icon={item.type === 'remix_link'
                ? <Repeat2 size={14} color={theme.colors.primary} />
                : <ExternalLink size={14} color={theme.colors.primary} />}
              label={recipeLinkLabel(item.type)}
              onPress={() => onOpenUrl(externalUrl)}
            />
          ) : null}
          {storagePath && onOpenFile ? (
            <ResourceAction
              icon={fileLoading
                ? <ActivityIndicator color={theme.colors.primary} size="small" />
                : <Download size={14} color={theme.colors.primary} />}
              label={fileLoading ? 'Opening…' : 'Open file'}
              onPress={() => onOpenFile({ contentType: item.contentType, storagePath, title: item.title })}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A saved generation setup as the settings it is, not the paragraph it was stored as. */
function GenerationSetupList({ entries }: { entries: GenerationSetup['entries'] }) {
  const theme = useAppTheme();
  return (
    <View style={{ gap: 6 }}>
      {entries.map((entry) => (
        <View key={entry.key} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <Text style={{ flex: 1, color: theme.colors.muted, ...appTheme.type.caption, fontWeight: '700' }}>
            {entry.key}
          </Text>
          <Text selectable style={{ flex: 1.4, color: theme.colors.text, ...appTheme.type.bodySm, fontWeight: '700' }}>
            {entry.value}
          </Text>
        </View>
      ))}
    </View>
  );
}


function ScopeSummary({ mediaItems, scope }: { mediaItems: ShowcaseMediaItem[]; scope: PostResourceItemScope | undefined }) {
  const theme = useAppTheme();
  const normalizedScope = normalizeScope(scope);
  // Everything applying to every output is the norm, so saying so on each item
  // is noise. Only a deliberate narrowing carries information. Matches web.
  if (normalizedScope.kind === 'all') {
    return null;
  }

  const targets = mediaItems.filter((item) => {
    const mediaKey = resourceMediaKey(item);
    return Boolean(mediaKey && normalizedScope.mediaKeys.includes(mediaKey));
  });
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text style={{ color: theme.colors.muted, ...appTheme.type.caption }}>
        Applies to {normalizedScope.mediaKeys.length} {normalizedScope.mediaKeys.length === 1 ? 'output' : 'outputs'}
      </Text>
      {targets.slice(0, 4).map((item) => (
        <View key={resourceMediaKey(item)} style={{ width: 28, height: 28, borderRadius: 9, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: theme.colors.surfaceInset }}>
          <MediaScopeThumbnail item={item} />
        </View>
      ))}
    </View>
  );
}

function MediaScopeThumbnail({ item }: { item: ShowcaseMediaItem }) {
  const theme = useAppTheme();
  const url = item.mediaKind === 'image' ? item.url : item.previewUrl;
  if (!url) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <FileText size={14} color={theme.colors.faint} />
      </View>
    );
  }

  return (
    <FeedMediaFrame
      kind="image"
      radius={0}
      recyclingKey={`resource-scope:${resourceMediaKey(item)}`}
      style={{ width: '100%', height: '100%' }}
      transition={100}
      url={url}
    />
  );
}

/** One icon per kind of group, the web's set: a prompt, its references and a file no longer look alike. */
const RECIPE_GROUP_ICONS: Record<RecipeGroupKind, typeof FileText> = {
  prompt: TextQuote,
  references: Images,
  settings: SlidersHorizontal,
  notes: NotebookText,
  workflow: Workflow,
  files: Paperclip,
  links: Link2,
};

function RecipeGroupIcon({ kind }: { kind: RecipeGroupKind }) {
  const theme = useAppTheme();
  const Icon = RECIPE_GROUP_ICONS[kind];
  return (
    <View style={{ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: `${theme.colors.primary}18` }}>
      <Icon size={18} color={theme.colors.primary} />
    </View>
  );
}

/**
 * The recipe in the order both clients read it: the creator's cards as they
 * arranged them, then the rest by kind (Prompt, References, Settings, Notes,
 * Workflow, Files, Links), the creation's own references straight after the
 * prompt that names them. Each card keeps the outputs it applies to.
 */
function buildUnlockedResourceCards(resources: PostResourceBundleResources | null): ResourceCard[] {
  if (!resources) return [];
  const items = resources.items?.length ? resources.items : buildLegacyItems(resources);
  return groupRecipeForReading(items, resources.sections ?? []).map((group) => ({
    ...group,
    scope: group.section ? normalizeScope(group.section.scope) : sharedScope([...group.items, ...group.media]),
  }));
}

function buildLegacyItems(resources: PostResourceBundleResources): PostResourceItem[] {
  const items: PostResourceItem[] = [];
  const push = (item: Partial<PostResourceItem> & Pick<PostResourceItem, 'title' | 'type'>) => {
    const index = items.length;
    items.push({
      id: `legacy-${index + 1}`,
      scope: ALL_SCOPE,
      role: 'primary',
      sectionId: null,
      description: null,
      textContent: null,
      externalUrl: null,
      storagePath: null,
      contentType: null,
      sizeBytes: null,
      workflowSnapshot: null,
      sortOrder: index,
      isPrimary: index === 0,
      remixUse: 'none',
      ...item,
    });
  };
  if (resources.promptText) push({ type: 'prompt', title: 'Prompt', textContent: resources.promptText });
  if (resources.workflowShareUrl || resources.workflowSnapshot) {
    push({ type: 'workflow', title: 'Workflow', externalUrl: resources.workflowShareUrl, workflowSnapshot: resources.workflowSnapshot });
  }
  resources.attachments.forEach((attachment) => push(legacyAttachmentItem(attachment)));
  if (resources.notesMarkdown) push({ type: 'note', title: 'Notes', textContent: resources.notesMarkdown });
  if (resources.allowRemix) push({ type: 'remix_access', title: 'Remix access' });
  return items;
}

function legacyAttachmentItem(attachment: PostResourceAttachment): Partial<PostResourceItem> & Pick<PostResourceItem, 'title' | 'type'> {
  const type = attachment.resourceType
    ?? (attachment.contentType?.startsWith('image/')
      ? 'reference_image'
      : attachment.contentType?.startsWith('video/')
        ? 'reference_video'
        : attachment.contentType?.startsWith('audio/')
          ? 'reference_audio'
          : attachment.kind === 'file' ? 'source_file' : 'external_link');
  return {
    type,
    title: attachment.label,
    externalUrl: attachment.kind === 'file' ? null : attachment.url ?? null,
    storagePath: attachment.kind === 'file' ? attachment.storagePath ?? null : null,
    contentType: attachment.contentType ?? null,
    sizeBytes: attachment.sizeBytes ?? null,
    role: attachment.role ?? 'primary',
    remixUse: attachment.remixUse ?? 'none',
  };
}

function sharedScope(items: PostResourceItem[]): PostResourceItemScope {
  if (items.length === 0) return ALL_SCOPE;
  const scopes = items.map((item) => normalizeScope(item.scope));
  if (scopes.some((scope) => scope.kind === 'all')) return ALL_SCOPE;
  const mediaKeys = Array.from(new Set(scopes.flatMap((scope) => scope.kind === 'media' ? scope.mediaKeys : [])));
  return mediaKeys.length > 0 ? { kind: 'media', mediaKeys } : ALL_SCOPE;
}

function normalizeScope(scope: PostResourceItemScope | undefined): PostResourceItemScope {
  return scope?.kind === 'media' && scope.mediaKeys.length > 0 ? scope : ALL_SCOPE;
}

function isMediaScope(scope: PostResourceItemScope | undefined) {
  return normalizeScope(scope).kind === 'media';
}

function scopeMatches(scope: PostResourceItemScope | undefined, selectedMediaKey: string | null) {
  if (!selectedMediaKey) return true;
  const normalized = normalizeScope(scope);
  return normalized.kind === 'all' || normalized.mediaKeys.includes(selectedMediaKey);
}

function resourceMediaKey(item: ShowcaseMediaItem) {
  return item.mediaKey?.trim() || item.id?.trim() || null;
}

function resourceItemKey(item: PostResourceItem) {
  return item.id?.trim() || `${item.sectionId ?? 'global'}:${item.type}:${item.sortOrder}:${item.title}`;
}
