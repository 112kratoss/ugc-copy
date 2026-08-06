import type {
  PostResourceBundleAccessMode,
  PostResourceBundleInput,
  PostResourceItem,
  PostResourceItemRole,
  PostResourceItemScope,
  PostResourceItemType,
  PostResourceRemixUse,
  PostResourceSection,
} from '@/lib/post-resource-bundles';
import type { SerializedWorkflowCanvasGraph } from '@/lib/workflow-canvas';

/**
 * The composer authors a resource bundle as a list of cards: one card is one
 * thing a buyer receives. This module is the web half of that model and is a
 * deliberate duplicate of ugc-mobile/lib/post-new-view-model.ts, because the
 * mobile app is a separate npm workspace and cannot import from src/lib.
 *
 * The two implementations must serialize identical payloads from identical
 * card drafts. contracts/post-resource-bundle-authoring-v1.json is what proves
 * it — every option label below is a serialization default (it becomes a card
 * title, and therefore a section's publicTitle), so the strings are part of the
 * contract rather than free-form copy.
 */
export type PostComposerResourceCardType =
  | 'prompt'
  | 'reference_media'
  | 'settings'
  | 'workflow'
  | 'source_assets'
  | 'guide'
  | 'external_link'
  | 'remix_link'
  | 'other';

export interface PostComposerResourceAttachmentDraft {
  id: string;
  kind: 'link' | 'file';
  label: string;
  url?: string;
  storagePath?: string;
  contentType?: string | null;
  sizeBytes?: number | null;
  resourceType?: PostResourceItemType;
  role?: PostResourceItemRole;
  remixUse?: PostResourceRemixUse;
}

/**
 * Raw normalized records retained when an existing bundle is opened in the
 * card editor. Older bundles can put several different item types (and several
 * different scopes) in one section, while the card UI intentionally presents
 * a simpler summary. Keeping the source records lets an unrelated post edit
 * round-trip the parts the card UI does not currently expose.
 */
export interface PostComposerResourceCardHydrationSource {
  groupKey: string;
  section: PostResourceSection | null;
  items: PostResourceItem[];
  textItemIndex: number | null;
  urlItemIndex: number | null;
  attachmentItemIndexes: number[];
}

export interface PostComposerResourceCardDraft {
  id: string;
  type: PostComposerResourceCardType;
  title: string;
  preview: string;
  textContent: string;
  externalUrl: string;
  attachments: PostComposerResourceAttachmentDraft[];
  appliesToAll: boolean;
  mediaKeys: string[];
  /**
   * `legacy_private` means `title` is only an editor label copied from old
   * private metadata. It must not become `section.publicTitle` unless the
   * creator changes it in the explicitly public title field.
   */
  publicTitleIntent?: 'explicit' | 'legacy_private';
  /** Internal lossless adapter state. UI object spreads deliberately retain it. */
  hydrationSource?: PostComposerResourceCardHydrationSource;
  /**
   * Only ever set by hydration, so re-saving a bundle that carries a workflow
   * graph does not silently drop it. Absent on cards the composer creates.
   */
  workflowSnapshot?: SerializedWorkflowCanvasGraph | null;
}

export const POST_COMPOSER_RESOURCE_CARD_OPTIONS: Array<{
  id: PostComposerResourceCardType;
  label: string;
  body: string;
}> = [
  { id: 'prompt', label: 'Prompt or script', body: 'Reusable text, shot list, or narration.' },
  { id: 'reference_media', label: 'Reference media', body: 'Images, video, or audio used to make it.' },
  { id: 'settings', label: 'Model settings', body: 'Seed, parameters, or generation settings.' },
  { id: 'workflow', label: 'Workflow or project', body: 'A workflow file, project, or setup link.' },
  { id: 'source_assets', label: 'Source assets', body: 'Editable files, presets, and supporting assets.' },
  { id: 'guide', label: 'Guide or notes', body: 'Steps, tips, and usage instructions.' },
  { id: 'external_link', label: 'External link', body: 'A useful supporting destination.' },
  { id: 'remix_link', label: 'Remix link', body: 'A protected link to remix this work.' },
  { id: 'other', label: 'Other', body: 'Anything useful that does not fit above.' },
];

function trimOrUndefined(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function trimOrNull(value: string | null | undefined) {
  return trimOrUndefined(value) ?? null;
}

export function createPostComposerResourceCard(
  type: PostComposerResourceCardType,
  partial: Partial<PostComposerResourceCardDraft> = {}
): PostComposerResourceCardDraft {
  const option = POST_COMPOSER_RESOURCE_CARD_OPTIONS.find((candidate) => candidate.id === type);

  return {
    id: partial.id ?? `resource-${Math.random().toString(36).slice(2, 10)}`,
    type,
    title: partial.title ?? option?.label ?? 'Resource',
    preview: partial.preview ?? '',
    textContent: partial.textContent ?? '',
    externalUrl: partial.externalUrl ?? '',
    attachments: partial.attachments ?? [],
    appliesToAll: partial.appliesToAll ?? true,
    mediaKeys: partial.mediaKeys ?? [],
    ...(partial.publicTitleIntent ? { publicTitleIntent: partial.publicTitleIntent } : {}),
    ...(partial.hydrationSource ? { hydrationSource: partial.hydrationSource } : {}),
    // Spread rather than defaulted to null: an absent snapshot must stay absent
    // so cards without one compare equal to the mobile drafts.
    ...(partial.workflowSnapshot ? { workflowSnapshot: partial.workflowSnapshot } : {}),
  };
}

function isSafeResourceUrl(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function hasHydratedItemContent(card: PostComposerResourceCardDraft): boolean {
  return Boolean(card.hydrationSource?.items.some((item) => (
    item.textContent?.trim()
    || isSafeResourceUrl(item.externalUrl)
    || item.storagePath?.trim()
    || item.workflowSnapshot
    || item.remixUse !== 'none'
  )));
}

export function resourceCardHasContent(
  card: PostComposerResourceCardDraft,
  options: { ignoreTitle?: boolean } = {}
) {
  if (!options.ignoreTitle && !card.title.trim()) {
    return false;
  }
  const hasText = Boolean(card.textContent.trim());
  const hasUrl = isSafeResourceUrl(card.externalUrl);
  const hasAttachments = card.attachments.some((attachment) => (
    attachment.kind === 'file'
      ? Boolean(attachment.storagePath?.trim())
      : isSafeResourceUrl(attachment.url)
  ));
  const hasWorkflowSnapshot = Boolean(card.workflowSnapshot);
  const hasPreservedContent = hasHydratedItemContent(card);

  if (card.type === 'prompt' || card.type === 'settings' || card.type === 'guide') {
    return hasText || hasAttachments || hasPreservedContent;
  }
  if (card.type === 'external_link' || card.type === 'remix_link') {
    return hasUrl || hasPreservedContent;
  }
  if (card.type === 'reference_media' || card.type === 'source_assets') {
    return hasAttachments || hasPreservedContent;
  }
  return hasText || hasUrl || hasAttachments || hasWorkflowSnapshot || hasPreservedContent;
}

export function getPostComposerResourceCardErrors(
  card: PostComposerResourceCardDraft
): Partial<Record<'title' | 'content', string>> {
  const errors: Partial<Record<'title' | 'content', string>> = {};
  if (!card.title.trim()) {
    errors.title = 'Add a resource title.';
  }
  const hasInvalidUrl = (
    Boolean(card.externalUrl.trim())
    && !isSafeResourceUrl(card.externalUrl)
  ) || card.attachments.some((attachment) => (
    Boolean(attachment.url?.trim())
    && !isSafeResourceUrl(attachment.url)
  ));
  if (hasInvalidUrl) {
    errors.content = 'Add a valid http:// or https:// link.';
  } else if (!resourceCardHasContent(card, { ignoreTitle: true })) {
    errors.content = 'Add the protected content, link, or file for this resource.';
  }
  return errors;
}

export function isPostComposerResourceCardReady(card: PostComposerResourceCardDraft) {
  return Object.keys(getPostComposerResourceCardErrors(card)).length === 0;
}

function resolveCardScope(card: PostComposerResourceCardDraft): PostResourceItemScope {
  return card.appliesToAll || card.mediaKeys.length === 0
    ? { kind: 'all' }
    : { kind: 'media', mediaKeys: [...new Set(card.mediaKeys)] };
}

function resourceScopesEqual(left: PostResourceItemScope, right: PostResourceItemScope): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'all' || right.kind === 'all') return true;
  return left.mediaKeys.length === right.mediaKeys.length
    && left.mediaKeys.every((key, index) => key === right.mediaKeys[index]);
}

function inferReferenceType(contentType: string | null | undefined): PostResourceItemType {
  if (contentType?.startsWith('video/')) return 'reference_video';
  if (contentType?.startsWith('audio/')) return 'reference_audio';
  return 'reference_image';
}

function getHydratedCardProjection(
  source: PostComposerResourceCardHydrationSource
): Omit<PostComposerResourceCardDraft, 'hydrationSource'> {
  const { groupKey, items: groupItems, section } = source;
  const first = groupItems[0]!;
  const type = inferResourceCardType(groupItems);
  const mediaKeys = [...new Set(groupItems.flatMap((item) => (item.scope?.kind === 'media'
    ? item.scope.mediaKeys
    : section?.scope?.kind === 'media'
      ? section.scope.mediaKeys
      : [])))];
  const appliesToAll = (
    groupItems.some((item) => !item.scope || item.scope.kind === 'all')
    && section?.scope?.kind !== 'media'
  ) || mediaKeys.length === 0;
  const contentItem = source.textItemIndex == null ? undefined : groupItems[source.textItemIndex];
  const urlItem = source.urlItemIndex == null ? undefined : groupItems[source.urlItemIndex];
  const workflowSnapshot = groupItems.find((item) => item.workflowSnapshot)?.workflowSnapshot ?? null;
  const attachments = source.attachmentItemIndexes.map((itemIndex, attachmentIndex): PostComposerResourceAttachmentDraft => {
    const item = groupItems[itemIndex]!;
    return {
      id: item.id ?? `${groupKey}-attachment-${attachmentIndex + 1}`,
      kind: item.storagePath ? 'file' : 'link',
      label: item.title,
      url: item.externalUrl ?? '',
      storagePath: item.storagePath ?? '',
      contentType: item.contentType,
      sizeBytes: item.sizeBytes,
      resourceType: item.type,
      role: item.role,
      remixUse: item.remixUse,
    };
  });

  return {
    id: section?.id ?? first.sectionId ?? first.id ?? groupKey,
    type,
    // An old private label remains useful inside the editor, but intent is
    // tracked separately so this fallback is never published by accident.
    title: section?.publicTitle ?? section?.title ?? first.title,
    preview: section?.description ?? '',
    textContent: contentItem?.textContent ?? '',
    externalUrl: urlItem?.externalUrl ?? '',
    attachments,
    appliesToAll,
    mediaKeys,
    publicTitleIntent: section?.publicTitle ? 'explicit' : 'legacy_private',
    ...(workflowSnapshot ? { workflowSnapshot } : {}),
  };
}

function serializeNewResourceCardSection(
  card: PostComposerResourceCardDraft,
  index: number
): PostResourceSection {
  const title = card.title.trim()
    || POST_COMPOSER_RESOURCE_CARD_OPTIONS.find((option) => option.id === card.type)?.label
    || `Resource ${index + 1}`;
  const referenceContentType = card.attachments.find((attachment) => attachment.contentType)?.contentType;
  const resourceType: PostResourceItemType = card.type === 'prompt'
    ? 'prompt'
    : card.type === 'reference_media'
      ? inferReferenceType(referenceContentType)
      : card.type === 'settings'
        ? 'settings'
        : card.type === 'workflow'
          ? 'workflow'
          : card.type === 'source_assets'
            ? 'source_file'
            : card.type === 'external_link'
              ? 'external_link'
              : card.type === 'remix_link'
                ? 'remix_link'
                : 'note';

  return {
    id: card.id,
    title,
    publicTitle: title,
    resourceType,
    scope: resolveCardScope(card),
    kind: card.type === 'workflow'
      ? 'workflow_step'
      : card.type === 'reference_media' || card.type === 'source_assets'
        ? 'asset_group'
        : 'global',
    description: trimOrNull(card.preview),
    sortOrder: index,
  };
}

export function serializeResourceCardSections(
  cards: PostComposerResourceCardDraft[]
): PostResourceSection[] {
  return cards.flatMap((card, index) => {
    const source = card.hydrationSource;
    if (!source) return [serializeNewResourceCardSection(card, index)];

    const baseline = getHydratedCardProjection(source);
    if (!source.section) {
      // Preserve old unsectioned items until the creator explicitly authors a
      // public card title. Merely opening and saving must not create a listing.
      if (card.publicTitleIntent === 'legacy_private' && card.title === baseline.title) {
        return [];
      }
      return [serializeNewResourceCardSection(card, index)];
    }

    const section: PostResourceSection = { ...source.section };
    if (card.title !== baseline.title || card.publicTitleIntent === 'explicit') {
      section.publicTitle = trimOrNull(card.title);
    }
    if (card.preview !== baseline.preview) {
      section.description = trimOrNull(card.preview);
    }
    if (!resourceScopesEqual(resolveCardScope(card), resolveCardScope(baseline))) {
      section.scope = resolveCardScope(card);
    }
    if (card.type !== baseline.type) {
      const replacement = serializeNewResourceCardSection(card, index);
      section.resourceType = replacement.resourceType;
      section.kind = replacement.kind;
    }
    return [section];
  });
}

export function buildResourceCardItems(cards: PostComposerResourceCardDraft[]): PostResourceItem[] {
  const items: PostResourceItem[] = [];

  const pushCardItem = (
    card: PostComposerResourceCardDraft,
    item: Omit<PostResourceItem, 'sortOrder' | 'isPrimary' | 'sectionId'>
  ) => {
    items.push({
      ...item,
      // The running index is global, not per card, so one card's items can be
      // numbered non-contiguously. Changing that renames items in every bundle.
      id: item.id ?? `${card.id}-item-${items.length + 1}`,
      scope: resolveCardScope(card),
      sectionId: card.id,
      sortOrder: items.length,
      isPrimary: items.length === 0,
    });
  };

  const attachmentItem = (
    card: PostComposerResourceCardDraft,
    attachment: PostComposerResourceAttachmentDraft,
    attachmentIndex: number
  ): Omit<PostResourceItem, 'sortOrder' | 'isPrimary' | 'sectionId'> => {
    const isFile = attachment.kind === 'file';
    const type: PostResourceItemType = attachment.resourceType
      ?? (card.type === 'reference_media'
        ? inferReferenceType(attachment.contentType)
        : card.type === 'workflow'
          ? 'workflow'
          : card.type === 'source_assets'
            ? 'source_file'
            : isFile
              ? 'source_file'
              : 'external_link');
    const defaultRole: PostResourceItemRole = card.type === 'reference_media'
      ? 'style_reference'
      : 'primary';
    const defaultRemixUse: PostResourceRemixUse = card.type === 'reference_media'
      ? 'reference_only'
      : card.type === 'workflow'
        ? 'import_source'
        : 'none';

    return {
      id: `${card.id}-file-${attachmentIndex + 1}`,
      type,
      role: attachment.role ?? defaultRole,
      title: attachment.label.trim() || `${card.title.trim() || 'Resource'} ${attachmentIndex + 1}`,
      description: null,
      textContent: null,
      externalUrl: isFile ? null : attachment.url?.trim() || null,
      storagePath: isFile ? attachment.storagePath?.trim() || null : null,
      contentType: attachment.contentType ?? null,
      sizeBytes: attachment.sizeBytes ?? null,
      workflowSnapshot: null,
      remixUse: attachment.remixUse ?? defaultRemixUse,
    };
  };

  const attachmentDraftsEqual = (
    left: PostComposerResourceAttachmentDraft,
    right: PostComposerResourceAttachmentDraft
  ) => (
    left.kind === right.kind
    && left.label === right.label
    && (left.url ?? '') === (right.url ?? '')
    && (left.storagePath ?? '') === (right.storagePath ?? '')
    && (left.contentType ?? null) === (right.contentType ?? null)
    && (left.sizeBytes ?? null) === (right.sizeBytes ?? null)
    && left.resourceType === right.resourceType
    && left.role === right.role
    && left.remixUse === right.remixUse
  );

  const pushFreshCardItems = (card: PostComposerResourceCardDraft) => {
    const title = card.title.trim() || 'Resource';
    const baseItem = {
      id: undefined,
      role: 'primary' as const,
      title,
      description: null,
      textContent: null,
      externalUrl: null,
      storagePath: null,
      contentType: null,
      sizeBytes: null,
      workflowSnapshot: null,
      remixUse: 'none' as const,
    };

    if (
      (card.type === 'prompt' || card.type === 'settings' || card.type === 'guide')
      && card.textContent.trim()
    ) {
      pushCardItem(card, {
        ...baseItem,
        type: card.type === 'prompt' ? 'prompt' : card.type === 'settings' ? 'settings' : 'note',
        textContent: card.textContent.trim(),
        remixUse: card.type === 'prompt' ? 'text_template' : 'none',
      });
    }

    if (
      (card.type === 'external_link' || card.type === 'remix_link')
      && card.externalUrl.trim()
    ) {
      pushCardItem(card, {
        ...baseItem,
        type: card.type === 'remix_link' ? 'remix_link' : 'external_link',
        externalUrl: card.externalUrl.trim(),
        remixUse: 'none',
      });
    } else if (card.externalUrl.trim()) {
      pushCardItem(card, {
        ...baseItem,
        type: card.type === 'workflow' ? 'workflow' : 'external_link',
        externalUrl: card.externalUrl.trim(),
        remixUse: card.type === 'workflow' ? 'import_source' : 'none',
        ...(card.type === 'workflow' && card.workflowSnapshot
          ? { workflowSnapshot: card.workflowSnapshot }
          : {}),
      });
    }

    card.attachments.forEach((attachment, attachmentIndex) => {
      pushCardItem(card, attachmentItem(card, attachment, attachmentIndex));
    });

    if (
      card.textContent.trim()
      && card.type !== 'prompt'
      && card.type !== 'settings'
      && card.type !== 'guide'
    ) {
      pushCardItem(card, {
        ...baseItem,
        type: card.type === 'workflow' ? 'workflow' : 'note',
        textContent: card.textContent.trim(),
        remixUse: card.type === 'workflow' ? 'import_source' : 'none',
        ...(card.type === 'workflow' && card.workflowSnapshot && !card.externalUrl.trim()
          ? { workflowSnapshot: card.workflowSnapshot }
          : {}),
      });
    } else if (
      card.type === 'workflow'
      && card.workflowSnapshot
      && !card.externalUrl.trim()
      && !card.textContent.trim()
      && card.attachments.length === 0
    ) {
      pushCardItem(card, {
        ...baseItem,
        type: 'workflow',
        workflowSnapshot: card.workflowSnapshot,
        remixUse: 'import_source',
      });
    }
  };

  const pushHydratedCardItems = (
    card: PostComposerResourceCardDraft,
    source: PostComposerResourceCardHydrationSource
  ) => {
    const baseline = getHydratedCardProjection(source);
    const next = source.items.map((item) => ({ ...item }));
    const removed = new Set<number>();
    const additions: Array<Omit<PostResourceItem, 'sortOrder' | 'isPrimary' | 'sectionId'>> = [];
    const scopeChanged = !resourceScopesEqual(resolveCardScope(card), resolveCardScope(baseline));
    const createsSection = !source.section
      && (card.publicTitleIntent === 'explicit' || card.title !== baseline.title);

    if (card.textContent !== baseline.textContent) {
      if (source.textItemIndex != null) {
        const item = next[source.textItemIndex]!;
        item.textContent = trimOrNull(card.textContent);
        if (
          !item.textContent
          && !item.externalUrl
          && !item.storagePath
          && !item.workflowSnapshot
          && item.remixUse === 'none'
        ) {
          removed.add(source.textItemIndex);
        }
      } else if (card.textContent.trim()) {
        additions.push({
          id: undefined,
          type: card.type === 'prompt'
            ? 'prompt'
            : card.type === 'settings'
              ? 'settings'
              : card.type === 'workflow'
                ? 'workflow'
                : 'note',
          role: 'primary',
          title: card.title.trim() || 'Resource',
          description: null,
          textContent: card.textContent.trim(),
          externalUrl: null,
          storagePath: null,
          contentType: null,
          sizeBytes: null,
          workflowSnapshot: card.type === 'workflow' ? card.workflowSnapshot ?? null : null,
          remixUse: card.type === 'prompt'
            ? 'text_template'
            : card.type === 'workflow'
              ? 'import_source'
              : 'none',
        });
      }
    }

    if (card.externalUrl !== baseline.externalUrl) {
      if (source.urlItemIndex != null) {
        const item = next[source.urlItemIndex]!;
        item.externalUrl = trimOrNull(card.externalUrl);
        if (
          !item.textContent
          && !item.externalUrl
          && !item.storagePath
          && !item.workflowSnapshot
          && item.remixUse === 'none'
        ) {
          removed.add(source.urlItemIndex);
        }
      } else if (card.externalUrl.trim()) {
        additions.push({
          id: undefined,
          type: card.type === 'remix_link'
            ? 'remix_link'
            : card.type === 'workflow'
              ? 'workflow'
              : 'external_link',
          role: 'primary',
          title: card.title.trim() || 'Resource',
          description: null,
          textContent: null,
          externalUrl: card.externalUrl.trim(),
          storagePath: null,
          contentType: null,
          sizeBytes: null,
          workflowSnapshot: card.type === 'workflow' ? card.workflowSnapshot ?? null : null,
          remixUse: card.type === 'workflow' ? 'import_source' : 'none',
        });
      }
    }

    const baselineAttachmentIds = new Set(baseline.attachments.map((attachment) => attachment.id));
    source.attachmentItemIndexes.forEach((itemIndex, attachmentIndex) => {
      const originalAttachment = baseline.attachments[attachmentIndex]!;
      const attachment = card.attachments.find((candidate) => candidate.id === originalAttachment.id);
      if (!attachment) {
        const item = next[itemIndex]!;
        const itemAlsoBacksVisibleContent = source.textItemIndex === itemIndex
          || source.urlItemIndex === itemIndex
          || Boolean(item.workflowSnapshot);
        if (!itemAlsoBacksVisibleContent) {
          removed.add(itemIndex);
          return;
        }

        // One normalized item can back two controls (for example, a workflow
        // URL plus its stored file). Removing the file must clear only the file
        // projection, not delete the URL/text that is still visible beside it.
        if (originalAttachment.kind === 'file') {
          item.storagePath = null;
          item.contentType = null;
          item.sizeBytes = null;
        } else {
          item.externalUrl = null;
        }
        if (
          !item.textContent
          && !item.externalUrl
          && !item.storagePath
          && !item.workflowSnapshot
          && item.remixUse === 'none'
        ) {
          removed.add(itemIndex);
        }
        return;
      }
      // A normalized resource item can legitimately carry both a storage path
      // and an external fallback URL. The simplified card UI displays it as a
      // file, so rebuilding that untouched projection would otherwise erase
      // the secondary URL. Preserve the complete source item until the author
      // actually edits this attachment.
      if (attachmentDraftsEqual(attachment, originalAttachment)) {
        return;
      }
      const item = next[itemIndex]!;
      const replacement = attachmentItem(card, attachment, attachmentIndex);
      item.type = replacement.type;
      item.role = replacement.role;
      item.title = replacement.title;
      // Merge only fields the attachment projection actually changed. A file
      // may carry a source-only external fallback which is not editable in the
      // card UI; renaming the file must not erase that hidden compatibility
      // field. Edits to the card's visible URL are already applied above.
      if ((attachment.url ?? '') !== (originalAttachment.url ?? '')) {
        item.externalUrl = trimOrNull(attachment.url);
      }
      if ((attachment.storagePath ?? '') !== (originalAttachment.storagePath ?? '')) {
        item.storagePath = trimOrNull(attachment.storagePath);
      }
      item.contentType = replacement.contentType;
      item.sizeBytes = replacement.sizeBytes;
      item.remixUse = replacement.remixUse;
    });
    card.attachments
      .filter((attachment) => !baselineAttachmentIds.has(attachment.id))
      .forEach((attachment, index) => additions.push(
        attachmentItem(card, attachment, baseline.attachments.length + index)
      ));

    const retained = next.filter((_, index) => !removed.has(index));
    if (scopeChanged) {
      retained.forEach((item) => { item.scope = resolveCardScope(card); });
    }
    if (createsSection) {
      retained.forEach((item) => { item.sectionId = card.id; });
    }

    items.push(...retained);
    additions.forEach((item) => {
      items.push({
        ...item,
        id: item.id ?? `${card.id}-item-${items.length + 1}`,
        scope: resolveCardScope(card),
        sectionId: source.section?.id ?? (createsSection ? card.id : null),
        sortOrder: items.reduce((max, existing) => Math.max(max, existing.sortOrder), -1) + 1,
        isPrimary: items.length === 0,
      });
    });
  };

  cards.forEach((card) => {
    if (card.hydrationSource) {
      pushHydratedCardItems(card, card.hydrationSource);
    } else {
      pushFreshCardItems(card);
    }
  });

  return items;
}

export function getResourceCardSummary(cards: PostComposerResourceCardDraft[]) {
  if (cards.length === 1) {
    return cards[0]?.title.trim() || 'Resource package';
  }
  return `${cards.length} reusable resources`;
}

export function getResourceCardPreview(cards: PostComposerResourceCardDraft[]) {
  const labels = cards.slice(0, 3).map((card) => card.title.trim()).filter(Boolean);
  const visibleLabels = labels.join(', ').replace(/, ([^,]*)$/, ', and $1');
  const extraCount = Math.max(0, cards.length - labels.length);
  return visibleLabels
    ? `Includes ${visibleLabels}${extraCount > 0 ? ` and ${extraCount} more` : ''}.`
    : 'Includes reusable resources from this creation.';
}

export function inferResourceCardType(items: PostResourceItem[]): PostComposerResourceCardType {
  const types = new Set(items.map((item) => item.type));
  if (types.has('remix_link')) return 'remix_link';
  if (types.has('remix_access')) return 'other';
  if (types.has('prompt')) return 'prompt';
  if (types.has('settings') || types.has('preset')) return 'settings';
  if (types.has('reference_image') || types.has('reference_video') || types.has('reference_audio')) return 'reference_media';
  if (types.has('workflow')) return 'workflow';
  if (types.has('source_file')) return 'source_assets';
  if (types.has('external_link')) return 'external_link';
  if (types.has('note')) return 'guide';
  return 'other';
}

export function hydratePostComposerResourceCards(
  bundle: PostResourceBundleInput | null | undefined
): PostComposerResourceCardDraft[] {
  const resources = bundle?.resources;
  // A remix_access item carries no text, link or file, so it can only ever
  // hydrate into an empty card that the content gate then discards. It is read
  // back by hydratePostComposerAllowRemix instead.
  const items = (resources?.items ?? []).filter((item) => item.type !== 'remix_access');
  if (items.length === 0) {
    return [];
  }

  const sections = new Map((resources?.sections ?? []).map((section) => [section.id, section]));
  const groups = new Map<string, PostResourceItem[]>();
  items.forEach((item, index) => {
    const groupKey = item.sectionId || `item-${item.id ?? index}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), item]);
  });

  return [...groups.entries()].map(([groupKey, groupItems]) => {
    const first = groupItems[0]!;
    const section = first.sectionId ? sections.get(first.sectionId) ?? null : null;
    const type = inferResourceCardType(groupItems);
    const textItemIndex = groupItems.findIndex((item) => Boolean(item.textContent));
    const urlItemIndex = (
      type === 'external_link' || type === 'remix_link' || type === 'workflow'
    )
      ? groupItems.findIndex((item) => Boolean(item.externalUrl))
      : -1;
    const attachmentItemIndexes = groupItems.flatMap((item, index) => (
      item.storagePath || (item.externalUrl && index !== urlItemIndex) ? [index] : []
    ));
    const hydrationSource: PostComposerResourceCardHydrationSource = {
      groupKey,
      section,
      items: groupItems.map((item) => ({ ...item })),
      textItemIndex: textItemIndex >= 0 ? textItemIndex : null,
      urlItemIndex: urlItemIndex >= 0 ? urlItemIndex : null,
      attachmentItemIndexes,
    };
    const projection = getHydratedCardProjection(hydrationSource);

    return createPostComposerResourceCard(type, {
      ...projection,
      hydrationSource,
    });
  });
}

/**
 * Reads back whether a loaded bundle grants direct remix. A remix_access item
 * carries no text, link or file of its own, so it cannot survive as a card —
 * the permission lives at bundle level instead.
 */
export function hydratePostComposerAllowRemix(
  bundle: PostResourceBundleInput | null | undefined
): boolean {
  const resources = bundle?.resources;
  return Boolean(
    resources?.allowRemix
    || (resources?.items ?? []).some((item) => item.type === 'remix_access')
  );
}

export function buildResourceCardBundleInput({
  accessMode,
  cards,
  allowRemix,
  summary,
  previewText,
  priceTokens,
}: {
  accessMode: PostResourceBundleAccessMode;
  cards: PostComposerResourceCardDraft[];
  allowRemix: boolean;
  summary: string;
  previewText: string;
  priceTokens: number;
}): PostResourceBundleInput | null {
  if (accessMode === 'none') {
    return null;
  }

  const resourceCards = cards.filter((card) => resourceCardHasContent(card));
  const sections = serializeResourceCardSections(resourceCards);
  const items = buildResourceCardItems(resourceCards);

  // Neither composer offers a resource-less package, but a bundle written
  // before the card model can grant remix and nothing else. Returning null for
  // it would delete the permission on the next save, so it survives as a
  // bundle the server synthesizes a remix_access item for.
  if (items.length === 0 && !allowRemix) {
    return null;
  }

  return {
    accessMode,
    // The author's preview stands in for the summary when they have not written
    // a separate one. assessMarketplaceListingQuality reads whichever of the two
    // is non-empty *first*, so deriving a short summary here would shadow what
    // the author actually wrote and fail the listing on their behalf.
    summary: trimOrUndefined(summary)
      ?? trimOrUndefined(previewText)
      ?? getResourceCardSummary(resourceCards),
    previewText: trimOrUndefined(previewText) ?? getResourceCardPreview(resourceCards),
    priceUsdCents: accessMode === 'paid' ? Math.max(0, priceTokens) : 0,
    resources: {
      promptText: null,
      notesMarkdown: null,
      workflowShareUrl: null,
      attachments: [],
      allowRemix,
      sections,
      items,
    },
  };
}
