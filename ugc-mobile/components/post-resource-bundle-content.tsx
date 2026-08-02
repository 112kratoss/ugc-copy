import {
  Copy,
  Download,
  ExternalLink,
  FileText,
  Link2,
  Repeat2,
  Settings2,
} from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';

import { FeedMediaFrame } from '@/components/feed-media-frame';
import { PostResourceReferences, getReferenceResourceItems } from '@/components/post-resource-references';
import { appTheme } from '@/lib/theme';
import type {
  PostResourceAttachment,
  PostResourceBundleLockedPreview,
  PostResourceBundleResources,
  PostResourceCardPreview,
  PostResourceItem,
  PostResourceItemScope,
  PostResourceItemType,
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

type ResourceCard = {
  id: string;
  items: PostResourceItem[];
  resourceType: PostResourceItemType;
  scope: PostResourceItemScope;
  title: string;
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
  const [selectedMediaKey, setSelectedMediaKey] = useState<string | null>(null);
  const cards = useMemo(() => buildUnlockedResourceCards(resources), [resources]);
  const cardPreviews = lockedPreview?.cardPreviews ?? [];
  const hasScopedContent = resources
    ? cards.some((card) => isMediaScope(card.scope) || card.items.some((item) => isMediaScope(item.scope)))
    : cardPreviews.some((card) => isMediaScope(card.scope));
  const selectableMedia = useMemo(
    () => mediaItems.filter((item) => Boolean(resourceMediaKey(item))),
    [mediaItems]
  );
  const showMediaSelector = hasScopedContent && selectableMedia.length > 1;

  const selector = showMediaSelector ? (
    <ResourceMediaSelector
      mediaItems={selectableMedia}
      onSelect={setSelectedMediaKey}
      selectedMediaKey={selectedMediaKey}
    />
  ) : null;

  if (!resources) {
    return (
      <View style={{ gap: 12 }}>
        {selector}
        {cardPreviews.length > 0 ? (
          <View style={{ gap: 10 }}>
            {cardPreviews
              .filter((card) => scopeMatches(card.scope, selectedMediaKey))
              .map((card) => (
                <LockedResourceCard
                  card={card}
                  key={card.sectionId}
                  mediaItems={selectableMedia}
                />
              ))}
          </View>
        ) : (
          <Text style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>
            Resource details stay private until this package is unlocked.
          </Text>
        )}
      </View>
    );
  }

  const visibleCards = cards.flatMap((card) => {
    if (!scopeMatches(card.scope, selectedMediaKey)) return [];
    const items = selectedMediaKey
      ? card.items.filter((item) => scopeMatches(item.scope ?? card.scope, selectedMediaKey))
      : card.items;
    return items.length > 0 ? [{ ...card, items }] : [];
  });

  return (
    <View style={{ gap: 12 }}>
      {selector}
      {visibleCards.length > 0 ? visibleCards.map((card) => (
        <UnlockedResourceCard
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
        <Text style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>
          No resources apply to this output.
        </Text>
      )}
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
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: appTheme.colors.faint, ...appTheme.type.caption, fontWeight: '800', textTransform: 'uppercase' }}>
        Resources for
      </Text>
      <ScrollView horizontal contentContainerStyle={{ gap: 8 }} showsHorizontalScrollIndicator={false}>
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
            borderColor: selectedMediaKey === null ? appTheme.colors.primary : appTheme.colors.border,
            backgroundColor: selectedMediaKey === null ? `${appTheme.colors.primary}20` : appTheme.colors.surface,
            opacity: pressed ? appTheme.opacity.pressed : 1,
            paddingHorizontal: 16,
          })}
        >
          <Text style={{ color: selectedMediaKey === null ? appTheme.colors.primary : appTheme.colors.textSecondary, ...appTheme.type.caption, fontWeight: '800' }}>
            All resources
          </Text>
        </Pressable>
        {mediaItems.map((item, index) => {
          const mediaKey = resourceMediaKey(item);
          if (!mediaKey) return null;
          const selected = selectedMediaKey === mediaKey;
          return (
            <Pressable
              accessibilityLabel={`Resources for output ${index + 1}`}
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
                borderColor: selected ? appTheme.colors.primary : appTheme.colors.border,
                backgroundColor: appTheme.colors.surfaceInset,
                opacity: pressed ? appTheme.opacity.pressed : 1,
                overflow: 'hidden',
              })}
            >
              <MediaScopeThumbnail item={item} />
              <View style={{ position: 'absolute', right: 3, bottom: 3, minWidth: 17, height: 17, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.72)', paddingHorizontal: 4 }}>
                <Text style={{ color: '#fff', fontSize: 9, lineHeight: 11, fontWeight: '900' }}>{index + 1}</Text>
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
  return (
    <View style={{ borderRadius: appTheme.radii.lg, borderCurve: 'continuous', borderWidth: 1, borderColor: appTheme.colors.border, backgroundColor: appTheme.colors.surface, padding: appTheme.spacing.gap, gap: 9 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 11 }}>
        <ResourceTypeIcon type={card.resourceType} />
        <View style={{ flex: 1, gap: 4 }}>
          <Text selectable style={{ color: appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '800' }}>
            {card.publicTitle}
          </Text>
          <Text style={{ color: appTheme.colors.muted, ...appTheme.type.caption }}>
            {resourceTypeLabel(card.resourceType)} · {formatItemCount(card.itemCount)}
          </Text>
        </View>
        {card.hasRemix ? (
          <View style={{ borderRadius: appTheme.radii.pill, backgroundColor: `${appTheme.colors.primary}18`, paddingHorizontal: 9, paddingVertical: 5 }}>
            <Text style={{ color: appTheme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>Remix included</Text>
          </View>
        ) : null}
      </View>
      <ScopeSummary mediaItems={mediaItems} scope={card.scope} />
    </View>
  );
}

function UnlockedResourceCard({
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
  const references = getReferenceResourceItems(card.items);
  const referenceIds = new Set(references.map(resourceItemKey));
  const standardItems = card.items.filter((item) => !referenceIds.has(resourceItemKey(item)));

  return (
    <View style={{ borderRadius: appTheme.radii.xl, borderCurve: 'continuous', borderWidth: 1, borderColor: appTheme.colors.border, backgroundColor: appTheme.colors.surface, padding: appTheme.spacing.card, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 11 }}>
        <ResourceTypeIcon type={card.resourceType} />
        <View style={{ flex: 1, gap: 4 }}>
          <Text selectable style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle, fontWeight: '800' }}>
            {card.title}
          </Text>
          <Text style={{ color: appTheme.colors.muted, ...appTheme.type.caption }}>
            {resourceTypeLabel(card.resourceType)} · {formatItemCount(card.items.length)}
          </Text>
        </View>
      </View>
      <ScopeSummary mediaItems={mediaItems} scope={card.scope} />
      {standardItems.map((item) => (
        <ResourceItemRow
          fileLoadingPath={fileLoadingPath}
          item={item}
          key={resourceItemKey(item)}
          onCopy={onCopy}
          onOpenFile={onOpenFile}
          onOpenUrl={onOpenUrl}
        />
      ))}
      {references.length > 0 && resolveFileUrl && onOpenUrl ? (
        <PostResourceReferences
          items={references}
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

function ResourceItemRow({
  fileLoadingPath,
  item,
  onCopy,
  onOpenFile,
  onOpenUrl,
}: {
  fileLoadingPath: string | null;
  item: PostResourceItem;
  onCopy?: (text: string) => Promise<void> | void;
  onOpenFile?: (file: ResourceFileInput) => Promise<void> | void;
  onOpenUrl?: (url: string) => Promise<void> | void;
}) {
  const textContent = item.textContent?.trim() ?? '';
  const externalUrl = item.externalUrl?.trim() ?? '';
  const storagePath = item.storagePath?.trim() ?? '';
  const fileLoading = Boolean(storagePath && storagePath === fileLoadingPath);

  return (
    <View style={{ borderRadius: appTheme.radii.md, borderCurve: 'continuous', backgroundColor: appTheme.colors.surfaceStrong, padding: appTheme.spacing.gap, gap: 9 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text selectable style={{ color: appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '800' }}>{item.title}</Text>
          {item.description ? (
            <Text selectable style={{ color: appTheme.colors.muted, ...appTheme.type.caption }}>{item.description}</Text>
          ) : null}
          {resourceItemMeta(item) ? (
            <Text style={{ color: appTheme.colors.faint, ...appTheme.type.caption }}>{resourceItemMeta(item)}</Text>
          ) : null}
        </View>
        {textContent && onCopy ? (
          <ResourceAction
            icon={<Copy size={14} color={appTheme.colors.success} strokeWidth={2.5} />}
            label="Copy"
            onPress={() => onCopy(textContent)}
          />
        ) : null}
      </View>
      {textContent ? (
        <Text selectable style={{ color: appTheme.colors.textSecondary, ...appTheme.type.bodySm }}>
          {textContent}
        </Text>
      ) : null}
      {item.workflowSnapshot && !externalUrl && !storagePath ? (
        <Text style={{ color: appTheme.colors.success, ...appTheme.type.caption, fontWeight: '700' }}>
          Workflow project included
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {externalUrl && onOpenUrl ? (
          <ResourceAction
            icon={item.type === 'remix_link'
              ? <Repeat2 size={14} color={appTheme.colors.primary} strokeWidth={2.5} />
              : <ExternalLink size={14} color={appTheme.colors.primary} strokeWidth={2.5} />}
            label={item.type === 'remix_link' ? 'Open remix' : item.type === 'workflow' ? 'Open workflow' : 'Open link'}
            onPress={() => onOpenUrl(externalUrl)}
          />
        ) : null}
        {storagePath && onOpenFile ? (
          <ResourceAction
            icon={fileLoading
              ? <ActivityIndicator color={appTheme.colors.primary} size="small" />
              : <Download size={14} color={appTheme.colors.primary} strokeWidth={2.5} />}
            label={fileLoading ? 'Opening…' : 'Open file'}
            onPress={() => onOpenFile({ contentType: item.contentType, storagePath, title: item.title })}
          />
        ) : null}
      </View>
    </View>
  );
}

function ResourceAction({ icon, label, onPress }: { icon: React.ReactNode; label: string; onPress: () => Promise<void> | void }) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={() => void onPress()}
      style={({ pressed }) => ({
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: appTheme.colors.surface,
        opacity: pressed ? appTheme.opacity.pressed : 1,
        paddingHorizontal: 12,
      })}
    >
      {icon}
      <Text style={{ color: appTheme.colors.text, ...appTheme.type.caption, fontWeight: '800' }}>{label}</Text>
    </Pressable>
  );
}

function ScopeSummary({ mediaItems, scope }: { mediaItems: ShowcaseMediaItem[]; scope: PostResourceItemScope | undefined }) {
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
      <Text style={{ color: appTheme.colors.faint, ...appTheme.type.caption }}>
        Applies to {normalizedScope.mediaKeys.length} {normalizedScope.mediaKeys.length === 1 ? 'output' : 'outputs'}
      </Text>
      {targets.slice(0, 4).map((item) => (
        <View key={resourceMediaKey(item)} style={{ width: 28, height: 28, borderRadius: 9, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: appTheme.colors.surfaceInset }}>
          <MediaScopeThumbnail item={item} />
        </View>
      ))}
    </View>
  );
}

function MediaScopeThumbnail({ item }: { item: ShowcaseMediaItem }) {
  const url = item.mediaKind === 'image' ? item.url : item.previewUrl;
  if (!url) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <FileText size={14} color={appTheme.colors.faint} strokeWidth={2.2} />
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

function ResourceTypeIcon({ type }: { type: PostResourceItemType }) {
  const icon = type === 'remix_link' || type === 'remix_access'
    ? <Repeat2 size={18} color={appTheme.colors.primary} strokeWidth={2.5} />
    : type === 'workflow'
      ? <Link2 size={18} color={appTheme.colors.primary} strokeWidth={2.5} />
      : type === 'settings' || type === 'preset'
        ? <Settings2 size={18} color={appTheme.colors.primary} strokeWidth={2.5} />
        : <FileText size={18} color={appTheme.colors.primary} strokeWidth={2.5} />;
  return (
    <View style={{ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: `${appTheme.colors.primary}18` }}>
      {icon}
    </View>
  );
}

function buildUnlockedResourceCards(resources: PostResourceBundleResources | null): ResourceCard[] {
  if (!resources) return [];
  const items = resources.items?.length ? [...resources.items].sort(bySortOrder) : buildLegacyItems(resources);
  const sections = [...(resources.sections ?? [])].sort(bySortOrder);
  const assignedIds = new Set<string>();
  const cards = sections.flatMap((section) => {
    const sectionItems = items.filter((item) => item.sectionId === section.id);
    if (sectionItems.length === 0) return [];
    sectionItems.forEach((item) => assignedIds.add(resourceItemKey(item)));
    return [cardFromSection(section, sectionItems)];
  });

  const unsectioned = items.filter((item) => !assignedIds.has(resourceItemKey(item)));
  const grouped = new Map<PostResourceItemType, PostResourceItem[]>();
  for (const item of unsectioned) {
    const list = grouped.get(item.type) ?? [];
    list.push(item);
    grouped.set(item.type, list);
  }
  for (const [type, groupedItems] of grouped) {
    cards.push({
      id: `global:${type}`,
      items: groupedItems,
      resourceType: type,
      scope: sharedScope(groupedItems),
      title: resourceTypeLabel(type),
    });
  }
  return cards;
}

function cardFromSection(section: PostResourceSection, items: PostResourceItem[]): ResourceCard {
  return {
    id: section.id,
    items,
    resourceType: section.resourceType ?? items[0]?.type ?? 'source_file',
    scope: normalizeScope(section.scope),
    title: section.title,
  };
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

function bySortOrder(left: { sortOrder: number }, right: { sortOrder: number }) {
  return left.sortOrder - right.sortOrder;
}

function resourceTypeLabel(type: PostResourceItemType) {
  if (type === 'prompt') return 'Prompt or script';
  if (type === 'workflow') return 'Workflow or project';
  if (type === 'reference_image' || type === 'reference_video' || type === 'reference_audio') return 'Reference media';
  if (type === 'settings') return 'Model settings';
  if (type === 'source_file') return 'Source assets';
  if (type === 'preset') return 'Preset';
  if (type === 'note') return 'Guide or notes';
  if (type === 'remix_link') return 'Remix link';
  if (type === 'remix_access') return 'Remix access';
  return 'External link';
}

function formatItemCount(count: number) {
  const normalized = Math.max(0, Math.round(count));
  return `${normalized} ${normalized === 1 ? 'item' : 'items'}`;
}

function resourceItemMeta(item: PostResourceItem) {
  const values = [item.contentType, formatFileSize(item.sizeBytes)].filter(Boolean);
  return values.join(' · ');
}

function formatFileSize(sizeBytes: number | null) {
  if (!sizeBytes) return '';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 102.4) / 10} KB`;
  return `${Math.round(sizeBytes / 1024 / 102.4) / 10} MB`;
}
