import type { SerializedWorkflowCanvasGraph } from '@/lib/workflow-canvas';
import { normalizePostMediaKey } from '@/lib/post-media-key';
import { parseCanonicalStorageObjectPath } from '@/lib/storage-ownership';

export const POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS = 10;
export const POST_RESOURCE_PRICE_INCREMENT_USD_CENTS = 10;

export type PostResourceBundleAccessMode = 'none' | 'free' | 'paid';
export type PersistedPostResourceBundleAccessMode = Exclude<PostResourceBundleAccessMode, 'none'>;
export type PostResourceBundleStatus = 'draft' | 'published';
export type PostResourceKind = 'prompt' | 'workflow' | 'files' | 'notes' | 'remix';
export type MarketplaceResourceFilter = 'all' | 'free' | 'paid';
export type MarketplaceResourceKindFilter = 'all' | PostResourceKind;
export type MarketplaceResourceSort = 'recent' | 'top-sales' | 'price-low' | 'price-high';
export type MarketplaceCheckoutCurrency = 'INR' | 'USD';

type PostResourceAttachmentKind = 'link' | 'file';
export type PostResourceSectionKind =
  | 'global'
  | 'scene'
  | 'shot'
  | 'frame'
  | 'variation'
  | 'workflow_step'
  | 'asset_group'
  | 'chapter'
  | 'other';
export type PostResourceItemType =
  | 'prompt'
  | 'workflow'
  | 'reference_image'
  | 'reference_video'
  | 'reference_audio'
  | 'source_file'
  | 'preset'
  | 'settings'
  | 'note'
  | 'external_link'
  | 'remix_link'
  | 'remix_access';
export type PostResourceItemRole =
  | 'primary'
  | 'style_reference'
  | 'product_reference'
  | 'composition_reference'
  | 'character_reference'
  | 'color_reference'
  | 'negative_reference'
  | 'before_input'
  | 'supporting_workflow'
  | 'manual_import'
  | 'other';
export type PostResourceRemixUse =
  | 'none'
  | 'reference_only'
  | 'import_source'
  | 'direct_remix'
  | 'text_template';
export type PostRemixCapability = 'none' | 'public' | 'unlock_required' | 'unsupported';
export type PostRemixTarget = 'image' | 'video' | 'motion' | 'workflow' | 'text_template' | null;

export type PostResourceItemScope =
  | { kind: 'all' }
  | { kind: 'media'; mediaKeys: string[] };

export interface PostResourceItem {
  /** Optional only at legacy/client input boundaries; normalization always supplies it. */
  id?: string;
  /** Missing legacy scope is normalized to `{ kind: 'all' }`. */
  scope?: PostResourceItemScope;
  type: PostResourceItemType;
  role: PostResourceItemRole;
  sectionId: string | null;
  title: string;
  description: string | null;
  textContent: string | null;
  externalUrl: string | null;
  storagePath: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  workflowSnapshot: SerializedWorkflowCanvasGraph | null;
  sortOrder: number;
  isPrimary: boolean;
  remixUse: PostResourceRemixUse;
}

export interface NormalizedPostResourceItem extends Omit<PostResourceItem, 'id' | 'scope'> {
  id: string;
  scope: PostResourceItemScope;
}

export type PostResourceItemCounts = Partial<Record<PostResourceItemType, number>>;

export interface PostResourceSection {
  id: string;
  title: string;
  kind: PostResourceSectionKind;
  description: string | null;
  sortOrder: number;
  /** Explicit, creator-authored sales title. Private `title` must never be used as its fallback. */
  publicTitle?: string | null;
  /** Optional representative type for a grouped public resource card. */
  resourceType?: PostResourceItemType | null;
  /** Missing legacy scope applies the card to every proof-media item. */
  scope?: PostResourceItemScope;
}

interface PostResourceSectionPreview {
  id: string;
  title: string;
  kind: PostResourceSectionKind;
  description: string | null;
  publicTitle?: string | null;
  resourceType?: PostResourceItemType | null;
  scope?: PostResourceItemScope;
}

export interface PostResourceCardPreview {
  sectionId: string;
  publicTitle: string;
  resourceType: PostResourceItemType;
  scope: PostResourceItemScope;
  itemCount: number;
  hasRemix: boolean;
}

export interface PostResourceItemPreview {
  id?: string;
  scope?: PostResourceItemScope;
  type: PostResourceItemType;
  title: string;
  role: PostResourceItemRole;
  sectionId?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  remixUse: PostResourceRemixUse;
}

export interface PostResourceAttachment {
  label: string;
  kind?: PostResourceAttachmentKind;
  url?: string | null;
  storagePath?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  resourceType?: PostResourceItemType | null;
  role?: PostResourceItemRole | null;
  remixUse?: PostResourceRemixUse | null;
}

export interface PostResourceBundleResources {
  promptText: string | null;
  notesMarkdown: string | null;
  workflowShareUrl: string | null;
  workflowSnapshot: SerializedWorkflowCanvasGraph | null;
  attachments: PostResourceAttachment[];
  allowRemix: boolean;
  sections?: PostResourceSection[];
  items?: PostResourceItem[];
}

interface PostResourceAttachmentPreview {
  label: string;
  kind: PostResourceAttachmentKind;
  contentType?: string | null;
  sizeBytes?: number | null;
}

export interface PostResourceBundleLockedPreview {
  resourceKinds: PostResourceKind[];
  attachmentPreviews: PostResourceAttachmentPreview[];
  itemCounts: PostResourceItemCounts;
  itemPreviews: PostResourceItemPreview[];
  sectionCount?: number;
  sectionPreviews?: PostResourceSectionPreview[];
  /** Public card metadata exists only when the creator explicitly supplied it. */
  cardPreviews?: PostResourceCardPreview[];
  hasPrompt: boolean;
  hasNotes: boolean;
  hasWorkflow: boolean;
  hasRemix: boolean;
  updatedAt: string | null;
}

export interface PostResourceBundleInput {
  accessMode: PostResourceBundleAccessMode;
  summary?: string | null;
  previewText?: string | null;
  priceUsdCents?: number | null;
  resources?: Partial<PostResourceBundleResources> | null;
}

export interface PostResourceBundleValidationOptions {
  ownerUserId?: string | null;
  mediaKeys?: Iterable<string> | null;
}

export interface MarketplacePriceQuote {
  currency: MarketplaceCheckoutCurrency;
  amountSubunits: number;
  formatted: string;
  note: string | null;
}

export type PostResourceRemixDescriptor = Pick<PostResourceItem, 'type' | 'remixUse'>;

export interface PostRemixResolutionInput {
  generationId: string | null | undefined;
  postFormat: string | null | undefined;
  category: string | null | undefined;
  sourceKind: string | null | undefined;
  resourceBundle?: {
    viewerCanAccess?: boolean | null;
    allowRemix?: boolean | null;
    items?: PostResourceRemixDescriptor[] | null;
  } | null;
}

const POST_RESOURCE_ITEM_TYPES: PostResourceItemType[] = [
  'prompt',
  'workflow',
  'reference_image',
  'reference_video',
  'reference_audio',
  'source_file',
  'preset',
  'settings',
  'note',
  'external_link',
  'remix_link',
  'remix_access',
];

const POST_RESOURCE_ITEM_ROLES: PostResourceItemRole[] = [
  'primary',
  'style_reference',
  'product_reference',
  'composition_reference',
  'character_reference',
  'color_reference',
  'negative_reference',
  'before_input',
  'supporting_workflow',
  'manual_import',
  'other',
];

const POST_RESOURCE_REMIX_USES: PostResourceRemixUse[] = [
  'none',
  'reference_only',
  'import_source',
  'direct_remix',
  'text_template',
];

const POST_RESOURCE_SECTION_KINDS: PostResourceSectionKind[] = [
  'global',
  'scene',
  'shot',
  'frame',
  'variation',
  'workflow_step',
  'asset_group',
  'chapter',
  'other',
];

const RESOURCE_ITEM_COUNT_ORDER: PostResourceItemType[] = [
  'prompt',
  'workflow',
  'reference_image',
  'reference_video',
  'reference_audio',
  'source_file',
  'preset',
  'settings',
  'note',
  'external_link',
  'remix_link',
  'remix_access',
];

const POST_RESOURCE_KIND_ORDER: PostResourceKind[] = ['prompt', 'workflow', 'files', 'notes', 'remix'];

const RESOURCE_ITEM_LABELS: Record<PostResourceItemType, { singular: string; plural: string }> = {
  prompt: { singular: 'prompt', plural: 'prompts' },
  workflow: { singular: 'workflow', plural: 'workflows' },
  reference_image: { singular: 'reference image', plural: 'reference images' },
  reference_video: { singular: 'reference video', plural: 'reference videos' },
  reference_audio: { singular: 'reference audio', plural: 'reference audio files' },
  source_file: { singular: 'source file', plural: 'source files' },
  preset: { singular: 'preset', plural: 'presets' },
  settings: { singular: 'settings note', plural: 'settings notes' },
  note: { singular: 'note', plural: 'notes' },
  external_link: { singular: 'link', plural: 'links' },
  remix_link: { singular: 'remix link', plural: 'remix links' },
  remix_access: { singular: 'remix access', plural: 'remix access' },
};

export function isPostResourceBundleAccessMode(
  value: string | null | undefined
): value is PostResourceBundleAccessMode {
  return value === 'none' || value === 'free' || value === 'paid';
}

export function normalizePostResourceBundleAccessMode(
  value: string | null | undefined
): PostResourceBundleAccessMode {
  if (isPostResourceBundleAccessMode(value)) {
    return value;
  }

  return 'none';
}

export function normalizeMarketplaceResourceFilter(
  value: string | null | undefined
): MarketplaceResourceFilter {
  if (value === 'free' || value === 'paid') {
    return value;
  }

  return 'all';
}

export function normalizeMarketplaceResourceSort(
  value: string | null | undefined
): MarketplaceResourceSort {
  return value === 'top-sales' || value === 'price-low' || value === 'price-high' ? value : 'recent';
}

export function isPostResourceKind(value: string | null | undefined): value is PostResourceKind {
  return value === 'prompt' || value === 'workflow' || value === 'files' || value === 'notes' || value === 'remix';
}

export function normalizeMarketplaceResourceKindFilter(
  value: string | null | undefined
): MarketplaceResourceKindFilter {
  return isPostResourceKind(value) ? value : 'all';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeTextValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : null;
}

function isPostResourceItemType(value: string | null | undefined): value is PostResourceItemType {
  return Boolean(value && POST_RESOURCE_ITEM_TYPES.includes(value as PostResourceItemType));
}

function isPostResourceItemRole(value: string | null | undefined): value is PostResourceItemRole {
  return Boolean(value && POST_RESOURCE_ITEM_ROLES.includes(value as PostResourceItemRole));
}

function isPostResourceRemixUse(value: string | null | undefined): value is PostResourceRemixUse {
  return Boolean(value && POST_RESOURCE_REMIX_USES.includes(value as PostResourceRemixUse));
}

function isPostResourceSectionKind(value: string | null | undefined): value is PostResourceSectionKind {
  return Boolean(value && POST_RESOURCE_SECTION_KINDS.includes(value as PostResourceSectionKind));
}

function normalizeResourceItemId(value: unknown, fallbackIndex: number, usedIds: Set<string>): string {
  const normalized = typeof value === 'string'
    ? value.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
    : '';
  const baseId = normalized || `item-${fallbackIndex + 1}`;
  let candidate = baseId;
  let suffix = 2;

  while (usedIds.has(candidate)) {
    const suffixText = `-${suffix}`;
    candidate = `${baseId.slice(0, 80 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }

  usedIds.add(candidate);
  return candidate;
}

export function normalizePostResourceItemScope(value: unknown): PostResourceItemScope {
  if (!isRecord(value) || value.kind !== 'media' || !Array.isArray(value.mediaKeys)) {
    return { kind: 'all' };
  }

  const mediaKeys = Array.from(new Set(
    value.mediaKeys
      .map((mediaKey) => normalizePostMediaKey(mediaKey))
      .filter((mediaKey): mediaKey is string => Boolean(mediaKey))
  ));

  return mediaKeys.length > 0 ? { kind: 'media', mediaKeys } : { kind: 'all' };
}

function normalizeResourceSectionId(value: unknown, fallbackIndex: number, usedIds: Set<string>): string {
  const normalized = typeof value === 'string'
    ? value.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)
    : '';
  const baseId = normalized || `section-${fallbackIndex + 1}`;
  let candidate = baseId;
  let suffix = 2;

  while (usedIds.has(candidate)) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }

  usedIds.add(candidate);
  return candidate;
}

export function normalizePostResourceSections(value: unknown): PostResourceSection[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const usedIds = new Set<string>();

  return value
    .map((item, index): PostResourceSection | null => {
      if (!isRecord(item)) {
        return null;
      }

      const id = normalizeResourceSectionId(item.id, index, usedIds);
      const title = normalizeTextValue(item.title) ?? `Section ${index + 1}`;
      const kindValue = normalizeTextValue(item.kind);
      const resourceTypeValue = normalizeTextValue(item.resourceType);

      return {
        id,
        title,
        kind: isPostResourceSectionKind(kindValue) ? kindValue : 'other',
        description: normalizeTextValue(item.description),
        sortOrder: normalizeNonNegativeNumber(item.sortOrder) ?? index,
        publicTitle: normalizeTextValue(item.publicTitle),
        resourceType: isPostResourceItemType(resourceTypeValue) ? resourceTypeValue : null,
        scope: normalizePostResourceItemScope(item.scope),
      };
    })
    .filter((section): section is PostResourceSection => section !== null)
    .sort((first, second) => first.sortOrder - second.sortOrder);
}

function defaultRoleForResourceItemType(type: PostResourceItemType): PostResourceItemRole {
  if (type === 'reference_image' || type === 'reference_video' || type === 'reference_audio') {
    return 'style_reference';
  }

  if (type === 'workflow') {
    return 'primary';
  }

  return 'primary';
}

function defaultTitleForResourceItemType(type: PostResourceItemType): string {
  switch (type) {
    case 'prompt':
      return 'Prompt';
    case 'workflow':
      return 'Workflow';
    case 'reference_image':
      return 'Reference image';
    case 'reference_video':
      return 'Reference video';
    case 'reference_audio':
      return 'Reference audio';
    case 'source_file':
      return 'Source file';
    case 'preset':
      return 'Preset';
    case 'settings':
      return 'Settings';
    case 'note':
      return 'Note';
    case 'external_link':
      return 'Link';
    case 'remix_link':
      return 'Remix link';
    case 'remix_access':
      return 'Remix access';
    default:
      return 'Resource';
  }
}

function defaultRemixUseForResourceItemType(type: PostResourceItemType): PostResourceRemixUse {
  if (type === 'reference_image' || type === 'reference_video' || type === 'reference_audio') {
    return 'reference_only';
  }

  if (type === 'workflow') {
    return 'import_source';
  }

  if (type === 'remix_access') {
    return 'direct_remix';
  }

  if (type === 'remix_link') {
    return 'none';
  }

  return 'none';
}

function inferResourceItemTypeFromAttachment(attachment: PostResourceAttachment): PostResourceItemType {
  const resourceType = attachment.resourceType ?? null;
  if (isPostResourceItemType(resourceType)) {
    return resourceType;
  }

  const searchable = [
    attachment.label,
    attachment.url,
    attachment.storagePath,
    attachment.contentType,
  ].filter(Boolean).join(' ').toLowerCase();

  if (attachment.contentType?.startsWith('image/')) {
    return 'reference_image';
  }

  if (attachment.contentType?.startsWith('video/')) {
    return 'reference_video';
  }

  if (attachment.contentType?.startsWith('audio/')) {
    return 'reference_audio';
  }

  if (searchable.includes('workflow') || searchable.endsWith('.json')) {
    return 'workflow';
  }

  return attachment.kind === 'file' ? 'source_file' : 'external_link';
}

function normalizePostResourceItem(
  value: unknown,
  fallbackSortOrder: number,
  usedIds: Set<string>,
  validSectionIds?: Set<string>
): NormalizedPostResourceItem | null {
  if (!isRecord(value)) {
    return null;
  }

  const typeValue = normalizeTextValue(value.type);
  if (!isPostResourceItemType(typeValue)) {
    return null;
  }

  const roleValue = normalizeTextValue(value.role);
  const remixUseValue = normalizeTextValue(value.remixUse);
  const title = normalizeTextValue(value.title) ?? defaultTitleForResourceItemType(typeValue);
  const sectionId = normalizeTextValue(value.sectionId);
  const textContent = normalizeTextValue(value.textContent);
  const externalUrl = normalizeTextValue(value.externalUrl);
  const storagePath = normalizeTextValue(value.storagePath)?.replace(/^\/+/, '') ?? null;
  const workflowSnapshot = isRecord(value.workflowSnapshot)
    ? value.workflowSnapshot as unknown as SerializedWorkflowCanvasGraph
    : null;

  return {
    id: normalizeResourceItemId(value.id, fallbackSortOrder, usedIds),
    scope: normalizePostResourceItemScope(value.scope),
    type: typeValue,
    role: isPostResourceItemRole(roleValue) ? roleValue : defaultRoleForResourceItemType(typeValue),
    sectionId: sectionId && (!validSectionIds || validSectionIds.has(sectionId)) ? sectionId : null,
    title,
    description: normalizeTextValue(value.description),
    textContent,
    externalUrl,
    storagePath,
    contentType: normalizeTextValue(value.contentType),
    sizeBytes: normalizeNonNegativeNumber(value.sizeBytes),
    workflowSnapshot,
    sortOrder: normalizeNonNegativeNumber(value.sortOrder) ?? fallbackSortOrder,
    isPrimary: typeof value.isPrimary === 'boolean' ? value.isPrimary : fallbackSortOrder === 0,
    remixUse: typeValue === 'remix_link'
      ? 'none'
      : isPostResourceRemixUse(remixUseValue)
        ? remixUseValue
        : defaultRemixUseForResourceItemType(typeValue),
  };
}

function createLegacyResourceItem(
  item: Partial<PostResourceItem> & Pick<PostResourceItem, 'type' | 'title'>,
  sortOrder: number
): NormalizedPostResourceItem {
  return {
    ...item,
    role: item.role ?? defaultRoleForResourceItemType(item.type),
    sectionId: item.sectionId ?? null,
    description: item.description ?? null,
    textContent: item.textContent ?? null,
    externalUrl: item.externalUrl ?? null,
    storagePath: item.storagePath ?? null,
    contentType: item.contentType ?? null,
    sizeBytes: item.sizeBytes ?? null,
    workflowSnapshot: item.workflowSnapshot ?? null,
    sortOrder,
    isPrimary: item.isPrimary ?? sortOrder === 0,
    remixUse: item.remixUse ?? defaultRemixUseForResourceItemType(item.type),
    id: item.id ?? `item-${sortOrder + 1}`,
    scope: item.scope ?? { kind: 'all' },
  };
}

export function normalizePostResourceItems(
  value: unknown,
  legacyResources?: Partial<PostResourceBundleResources> | null
): NormalizedPostResourceItem[] {
  const sectionIds = new Set(normalizePostResourceSections(legacyResources?.sections).map((section) => section.id));
  const usedIds = new Set<string>();
  const explicitItems = Array.isArray(value)
    ? value
      .map((item, index) => normalizePostResourceItem(item, index, usedIds, sectionIds.size > 0 ? sectionIds : undefined))
      .filter((item): item is NormalizedPostResourceItem => item !== null)
    : [];

  if (explicitItems.length > 0) {
    return explicitItems.sort((first, second) => first.sortOrder - second.sortOrder);
  }

  const legacyItems: NormalizedPostResourceItem[] = [];
  const pushLegacyItem = (item: Partial<PostResourceItem> & Pick<PostResourceItem, 'type' | 'title'>) => {
    legacyItems.push(createLegacyResourceItem(item, legacyItems.length));
  };

  const promptText = normalizeTextValue(legacyResources?.promptText);
  if (promptText) {
    pushLegacyItem({
      type: 'prompt',
      title: 'Prompt',
      textContent: promptText,
      remixUse: 'none',
    });
  }

  const workflowShareUrl = normalizeTextValue(legacyResources?.workflowShareUrl);
  if (workflowShareUrl || legacyResources?.workflowSnapshot) {
    pushLegacyItem({
      type: 'workflow',
      title: 'Workflow',
      externalUrl: workflowShareUrl,
      workflowSnapshot: legacyResources?.workflowSnapshot ?? null,
      remixUse: 'import_source',
    });
  }

  for (const attachment of normalizePostResourceAttachments(legacyResources?.attachments)) {
    const itemType = inferResourceItemTypeFromAttachment(attachment);
    pushLegacyItem({
      type: itemType,
      role: isPostResourceItemRole(attachment.role ?? undefined)
        ? attachment.role ?? undefined
        : defaultRoleForResourceItemType(itemType),
      title: attachment.label,
      externalUrl: attachment.kind === 'file' ? null : attachment.url ?? null,
      storagePath: attachment.kind === 'file' ? attachment.storagePath ?? null : null,
      contentType: attachment.contentType ?? null,
      sizeBytes: attachment.sizeBytes ?? null,
      remixUse: isPostResourceRemixUse(attachment.remixUse ?? undefined)
        ? attachment.remixUse ?? undefined
        : defaultRemixUseForResourceItemType(itemType),
    });
  }

  const notesMarkdown = normalizeTextValue(legacyResources?.notesMarkdown);
  if (notesMarkdown) {
    pushLegacyItem({
      type: 'note',
      title: 'Notes',
      textContent: notesMarkdown,
      remixUse: 'none',
    });
  }

  if (legacyResources?.allowRemix) {
    pushLegacyItem({
      type: 'remix_access',
      title: 'Remix access',
      remixUse: 'direct_remix',
    });
  }

  return legacyItems;
}

export function formatUsdCents(amountUsdCents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountUsdCents / 100);
}

export function getBundleAccessLabel(
  accessMode: PersistedPostResourceBundleAccessMode,
  priceUsdCents: number
): string {
  if (accessMode === 'free' || priceUsdCents === 0) {
    return 'Free recipe';
  }

  return `${formatUsdCents(priceUsdCents)} recipe`;
}

export function formatUnlockCountLabel(
  accessMode: PersistedPostResourceBundleAccessMode,
  count: number
): string {
  const normalizedCount = Math.max(0, Math.round(count));

  if (accessMode === 'free') {
    return `${normalizedCount} opened`;
  }

  return `${normalizedCount} sold`;
}

export function getPostResourceKinds(
  resources: Partial<PostResourceBundleResources> | null | undefined
): PostResourceKind[] {
  if (!resources) {
    return [];
  }

  const itemKinds = normalizePostResourceItems(resources.items, resources).reduce<PostResourceKind[]>((kinds, item) => {
    const kind = getPostResourceKindForItemType(item.type);
    return kinds.includes(kind) ? kinds : [...kinds, kind];
  }, []);

  if (itemKinds.length > 0) {
    return POST_RESOURCE_KIND_ORDER.filter((kind) => itemKinds.includes(kind));
  }

  const kinds: PostResourceKind[] = [];

  if (resources.promptText?.trim()) {
    kinds.push('prompt');
  }

  if (resources.workflowShareUrl?.trim() || resources.workflowSnapshot) {
    kinds.push('workflow');
  }

  if (Array.isArray(resources.attachments) && resources.attachments.length > 0) {
    kinds.push('files');
  }

  if (resources.notesMarkdown?.trim()) {
    kinds.push('notes');
  }

  if (resources.allowRemix) {
    kinds.push('remix');
  }

  return POST_RESOURCE_KIND_ORDER.filter((kind) => kinds.includes(kind));
}

function getPostResourceKindForItemType(type: PostResourceItemType): PostResourceKind {
  switch (type) {
    case 'prompt':
      return 'prompt';
    case 'workflow':
      return 'workflow';
    case 'settings':
    case 'note':
      return 'notes';
    case 'remix_access':
    case 'remix_link':
      return 'remix';
    default:
      return 'files';
  }
}

function getPostResourceItemCounts(items: PostResourceItem[]): PostResourceItemCounts {
  return items.reduce<PostResourceItemCounts>((counts, item) => ({
    ...counts,
    [item.type]: (counts[item.type] ?? 0) + 1,
  }), {});
}

export function normalizePostResourceAttachments(value: unknown): PostResourceAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): PostResourceAttachment | null => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const record = item as Record<string, unknown>;
      const label = typeof record.label === 'string' ? record.label.trim() : '';
      const kind = record.kind === 'file' ? 'file' : 'link';
      const url = typeof record.url === 'string' ? record.url.trim() : '';
      const storagePath = typeof record.storagePath === 'string' ? record.storagePath.trim().replace(/^\/+/, '') : '';
      const contentType = typeof record.contentType === 'string' ? record.contentType.trim() : null;
      const sizeBytes = typeof record.sizeBytes === 'number' && Number.isFinite(record.sizeBytes)
        ? Math.max(0, Math.round(record.sizeBytes))
        : null;
      const resourceType = isPostResourceItemType(normalizeTextValue(record.resourceType))
        ? normalizeTextValue(record.resourceType) as PostResourceItemType
        : null;
      const role = isPostResourceItemRole(normalizeTextValue(record.role))
        ? normalizeTextValue(record.role) as PostResourceItemRole
        : null;
      const remixUse = isPostResourceRemixUse(normalizeTextValue(record.remixUse))
        ? normalizeTextValue(record.remixUse) as PostResourceRemixUse
        : null;

      if (kind === 'file') {
        if (!storagePath) {
          return null;
        }

        return {
          label: label || storagePath.split('/').pop() || 'File',
          kind,
          storagePath,
          contentType,
          sizeBytes,
          resourceType,
          role,
          remixUse,
        } satisfies PostResourceAttachment;
      }

      if (!url) {
        return null;
      }

      return {
        label: label || url,
        kind,
        url,
        resourceType,
        role,
        remixUse,
      } satisfies PostResourceAttachment;
    })
    .filter((item): item is PostResourceAttachment => item !== null);
}

function isSafePostResourceUrl(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isSafePostResourceStoragePath(value: string | null | undefined, ownerUserId?: string | null): boolean {
  if (!value) return false;
  return parseCanonicalStorageObjectPath(value, {
    ...(ownerUserId ? { ownerUserId } : {}),
  }) !== null;
}

function validateResourceItemIdentityAndScope(
  value: unknown,
  usedIds: Set<string>,
  availableMediaKeys: Set<string> | null,
  fallbackId?: string
): string | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.id != null) {
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    if (!id || id.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
      return 'Resource item ids may only use letters, numbers, hyphens, and underscores.';
    }
    if (usedIds.has(id)) {
      return 'Resource item ids must be unique within a recipe.';
    }
    usedIds.add(id);
  } else if (fallbackId) {
    if (usedIds.has(fallbackId)) {
      return 'Resource item ids must be unique within a recipe.';
    }
    usedIds.add(fallbackId);
  }

  if (value.scope == null) {
    return null;
  }
  if (!isRecord(value.scope) || (value.scope.kind !== 'all' && value.scope.kind !== 'media')) {
    return 'Choose whether each resource applies to all outputs or selected media.';
  }
  if (value.scope.kind === 'all') {
    return null;
  }
  if (!Array.isArray(value.scope.mediaKeys) || value.scope.mediaKeys.length === 0) {
    return 'Select at least one proof media item for a media-scoped resource.';
  }

  const seenMediaKeys = new Set<string>();
  for (const valueMediaKey of value.scope.mediaKeys) {
    const mediaKey = normalizePostMediaKey(valueMediaKey);
    if (!mediaKey) {
      return 'Resource media keys may only use letters, numbers, hyphens, and underscores.';
    }
    if (seenMediaKeys.has(mediaKey)) {
      return 'Resource media keys must be unique within an item scope.';
    }
    if (availableMediaKeys && !availableMediaKeys.has(mediaKey)) {
      return 'A resource references proof media that is not part of this post.';
    }
    seenMediaKeys.add(mediaKey);
  }

  return null;
}

export function validatePostResourceBundleInput(
  bundle: unknown,
  options: PostResourceBundleValidationOptions = {}
): string | null {
  if (bundle != null && typeof bundle !== 'object') {
    return 'Invalid recipe payload.';
  }

  const typedBundle = bundle as PostResourceBundleInput | null | undefined;
  const accessMode = typedBundle?.accessMode ?? 'none';

  if (!isPostResourceBundleAccessMode(accessMode)) {
    return 'Choose whether the recipe should be free or paid.';
  }

  if (accessMode === 'none') {
    return null;
  }

  const priceUsdCents = Number.isFinite(typedBundle?.priceUsdCents)
    ? Math.round(typedBundle?.priceUsdCents ?? 0)
    : 0;

  if (
    accessMode === 'paid'
    && (
      priceUsdCents < POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS
      || priceUsdCents % POST_RESOURCE_PRICE_INCREMENT_USD_CENTS !== 0
    )
  ) {
    return 'Paid recipes must cost at least 10 tokens and use 10-token increments.';
  }

  const resources = typedBundle?.resources ?? {};
  const promptText = resources.promptText?.trim() ?? '';
  const notesMarkdown = resources.notesMarkdown?.trim() ?? '';
  const workflowShareUrl = resources.workflowShareUrl?.trim() ?? '';
  const attachments = normalizePostResourceAttachments(resources.attachments);
  const resourceItems = normalizePostResourceItems(resources.items, resources);
  const availableMediaKeys = options.mediaKeys == null
    ? null
    : new Set(
        Array.from(options.mediaKeys)
          .map((mediaKey) => normalizePostMediaKey(mediaKey))
          .filter((mediaKey): mediaKey is string => Boolean(mediaKey))
      );
  const usedItemIds = new Set<string>();

  if (Array.isArray(resources.items)) {
    for (const [index, item] of resources.items.entries()) {
      const identityOrScopeError = validateResourceItemIdentityAndScope(
        item,
        usedItemIds,
        availableMediaKeys,
        `item-${index + 1}`
      );
      if (identityOrScopeError) {
        return identityOrScopeError;
      }
    }
  }

  if (Array.isArray(resources.sections)) {
    for (const section of resources.sections) {
      if (!isRecord(section)) {
        continue;
      }

      if (
        section.publicTitle != null
        && (typeof section.publicTitle !== 'string' || !section.publicTitle.trim() || section.publicTitle.trim().length > 80)
      ) {
        return 'Public resource card titles must be between 1 and 80 characters.';
      }

      const sectionScopeError = validateResourceItemIdentityAndScope(
        { scope: section.scope },
        new Set<string>(),
        availableMediaKeys
      );
      if (sectionScopeError) {
        return sectionScopeError;
      }
    }
  }

  if (workflowShareUrl && !isSafePostResourceUrl(workflowShareUrl)) {
    return 'Workflow links must start with http:// or https://.';
  }

  for (const attachment of attachments) {
    if ((attachment.kind ?? 'link') === 'file') {
      if (!isSafePostResourceStoragePath(attachment.storagePath, options.ownerUserId)) {
        return 'Uploaded unlock files must belong to the creator publishing this post.';
      }
    } else if (!isSafePostResourceUrl(attachment.url ?? null)) {
      return 'Unlock links must start with http:// or https://.';
    }
  }

  for (const item of resourceItems) {
    if (item.externalUrl && !isSafePostResourceUrl(item.externalUrl)) {
      return 'Resource links must start with http:// or https://.';
    }

    if (item.type === 'remix_link' && !item.externalUrl) {
      return 'Add an http:// or https:// remix link.';
    }

    if (item.storagePath && !isSafePostResourceStoragePath(item.storagePath, options.ownerUserId)) {
      return 'Uploaded resource files must belong to the creator publishing this post.';
    }
  }

  const hasResourceContent = Boolean(
    promptText ||
    notesMarkdown ||
    workflowShareUrl ||
    resources.workflowSnapshot ||
    attachments.length > 0 ||
    resources.allowRemix ||
    resourceItems.length > 0
  );

  if (!hasResourceContent) {
    return 'Add content for at least one unlock item before publishing.';
  }

  return null;
}

function buildPostResourceCardPreviews(
  sections: PostResourceSection[],
  items: PostResourceItem[]
): PostResourceCardPreview[] {
  return sections.flatMap((section) => {
    // Never fall back to the private section title. Existing bundles did not
    // opt into publishing their creator-authored organization metadata.
    if (!section.publicTitle) {
      return [];
    }

    const sectionItems = items.filter((item) => item.sectionId === section.id);
    const resourceType = section.resourceType ?? sectionItems[0]?.type ?? null;
    if (!resourceType) {
      return [];
    }

    return [{
      sectionId: section.id,
      publicTitle: section.publicTitle,
      resourceType,
      scope: section.scope ?? { kind: 'all' },
      itemCount: sectionItems.length,
      hasRemix: resourceType === 'remix_link'
        || sectionItems.some((item) => item.type === 'remix_link' || item.type === 'remix_access'),
    }];
  });
}

export function buildPostResourceBundleLockedPreview(
  resources: Partial<PostResourceBundleResources> | null | undefined,
  updatedAt: string | null = null
): PostResourceBundleLockedPreview {
  const attachments = normalizePostResourceAttachments(resources?.attachments);
  const sections = normalizePostResourceSections(resources?.sections);
  const normalizedResources: Partial<PostResourceBundleResources> = {
    promptText: resources?.promptText ?? null,
    notesMarkdown: resources?.notesMarkdown ?? null,
    workflowShareUrl: resources?.workflowShareUrl ?? null,
    workflowSnapshot: resources?.workflowSnapshot ?? null,
    attachments,
    allowRemix: Boolean(resources?.allowRemix),
    sections,
    items: normalizePostResourceItems(resources?.items, {
      promptText: resources?.promptText ?? null,
      notesMarkdown: resources?.notesMarkdown ?? null,
      workflowShareUrl: resources?.workflowShareUrl ?? null,
      workflowSnapshot: resources?.workflowSnapshot ?? null,
      attachments,
      allowRemix: Boolean(resources?.allowRemix),
      sections,
    }),
  };
  const items = normalizedResources.items ?? [];

  return {
    resourceKinds: getPostResourceKinds(normalizedResources),
    attachmentPreviews: attachments.map((attachment) => ({
      label: attachment.label,
      kind: attachment.kind ?? 'link',
      contentType: attachment.kind === 'file' ? attachment.contentType ?? null : null,
      sizeBytes: attachment.kind === 'file' ? attachment.sizeBytes ?? null : null,
    })),
    itemCounts: getPostResourceItemCounts(items),
    sectionCount: sections.length,
    sectionPreviews: sections.map((section) => ({
      id: section.id,
      title: section.title,
      kind: section.kind,
      description: section.description,
      publicTitle: section.publicTitle,
      resourceType: section.resourceType,
      scope: section.scope,
    })),
    cardPreviews: buildPostResourceCardPreviews(sections, items),
    itemPreviews: items.map((item) => ({
      id: item.id,
      scope: item.scope,
      type: item.type,
      title: item.title,
      role: item.role,
      sectionId: item.sectionId,
      contentType: item.contentType,
      sizeBytes: item.sizeBytes,
      remixUse: item.remixUse,
    })),
    hasPrompt: Boolean(normalizedResources.promptText?.trim() || items.some((item) => item.type === 'prompt')),
    hasNotes: Boolean(normalizedResources.notesMarkdown?.trim() || items.some((item) => item.type === 'note' || item.type === 'settings')),
    hasWorkflow: Boolean(normalizedResources.workflowShareUrl?.trim() || normalizedResources.workflowSnapshot || items.some((item) => item.type === 'workflow')),
    hasRemix: Boolean(normalizedResources.allowRemix || items.some((item) => (
      item.type === 'remix_access'
      || item.type === 'remix_link'
      || item.remixUse === 'direct_remix'
    ))),
    updatedAt,
  };
}

/**
 * Removes creator-authored resource metadata before a locked bundle is sent to
 * a discovery surface. Counts and resource capabilities are safe sales context;
 * filenames, item titles, section labels, and descriptions are part of the
 * paid recipe and must stay behind the access check.
 */
export function sanitizePostResourceBundleLockedPreview(
  preview: PostResourceBundleLockedPreview | null | undefined
): PostResourceBundleLockedPreview | undefined {
  if (!preview) {
    return undefined;
  }

  return {
    resourceKinds: [...preview.resourceKinds],
    attachmentPreviews: preview.attachmentPreviews.map((attachment, index) => ({
      label: attachment.kind === 'file' ? `File ${index + 1}` : `Link ${index + 1}`,
      kind: attachment.kind,
      contentType: null,
      sizeBytes: null,
    })),
    itemCounts: { ...preview.itemCounts },
    itemPreviews: preview.itemPreviews.map((item) => {
      const typeLabel = getPostResourceItemTypeLabel(item.type);
      return {
        id: item.id,
        scope: item.scope,
        type: item.type,
        title: `${typeLabel.charAt(0).toUpperCase()}${typeLabel.slice(1)}`,
        role: 'other',
        sectionId: null,
        contentType: null,
        sizeBytes: null,
        // The remix mode is required to resolve whether the public action should
        // be available, but does not reveal the resource itself.
        remixUse: item.remixUse,
      };
    }),
    sectionCount: preview.sectionCount ?? 0,
    sectionPreviews: [],
    cardPreviews: (preview.cardPreviews ?? []).map((card) => ({
      sectionId: card.sectionId,
      publicTitle: card.publicTitle,
      resourceType: card.resourceType,
      scope: normalizePostResourceItemScope(card.scope),
      itemCount: Math.max(0, Math.round(card.itemCount)),
      hasRemix: Boolean(card.hasRemix),
    })),
    hasPrompt: preview.hasPrompt,
    hasNotes: preview.hasNotes,
    hasWorkflow: preview.hasWorkflow,
    hasRemix: preview.hasRemix,
    updatedAt: preview.updatedAt,
  };
}

export function getPostResourceKindLabel(kind: PostResourceKind): string {
  switch (kind) {
    case 'prompt':
      return 'Prompt';
    case 'workflow':
      return 'Workflow';
    case 'files':
      return 'Files';
    case 'notes':
      return 'Notes';
    case 'remix':
      return 'Remix';
    default:
      return kind;
  }
}

export function getPostResourceItemTypeLabel(type: PostResourceItemType, count = 1): string {
  const labels = RESOURCE_ITEM_LABELS[type];
  return count === 1 ? labels.singular : labels.plural;
}

export function formatPostResourceItemCountSummary(counts: PostResourceItemCounts | null | undefined): string {
  const parts = RESOURCE_ITEM_COUNT_ORDER.flatMap((type) => {
    const count = counts?.[type] ?? 0;
    return count > 0 ? [`${count} ${getPostResourceItemTypeLabel(type, count)}`] : [];
  });

  return parts.join(', ');
}

export function formatPostResourceBundleCountSummary(
  preview: Pick<PostResourceBundleLockedPreview, 'itemCounts' | 'sectionCount'> | null | undefined
): string {
  const parts: string[] = [];
  const sectionCount = preview?.sectionCount ?? 0;

  if (sectionCount > 0) {
    parts.push(`${sectionCount} ${sectionCount === 1 ? 'section' : 'sections'}`);
  }

  const itemSummary = formatPostResourceItemCountSummary(preview?.itemCounts);
  if (itemSummary) {
    parts.push(itemSummary);
  }

  return parts.join(', ');
}

export function describePostResourceKinds(kinds: PostResourceKind[]): string {
  if (kinds.length === 0) {
    return 'Open the reusable unlock attached to this post.';
  }

  if (kinds.length === 1) {
    return `Unlock the ${getPostResourceKindLabel(kinds[0]).toLowerCase()} attached to this post.`;
  }

  const labels = kinds.map((kind) => getPostResourceKindLabel(kind).toLowerCase());
  const lastLabel = labels.pop();

  return `Unlock the ${labels.join(', ')} and ${lastLabel} attached to this post.`;
}

function targetForMediaCategory(category: string | null | undefined): Exclude<PostRemixTarget, null> {
  if (category === 'video') {
    return 'video';
  }

  if (category === 'motion') {
    return 'motion';
  }

  return 'image';
}

function normalizePostResourceRemixDescriptors(value: unknown): PostResourceRemixDescriptor[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): PostResourceRemixDescriptor | null => {
      if (!isRecord(item)) {
        return null;
      }

      const type = normalizeTextValue(item.type);
      if (!isPostResourceItemType(type)) {
        return null;
      }

      const remixUse = normalizeTextValue(item.remixUse);
      return {
        type,
        remixUse: type === 'remix_link'
          ? 'none'
          : isPostResourceRemixUse(remixUse)
            ? remixUse
            : defaultRemixUseForResourceItemType(type),
      };
    })
    .filter((item): item is PostResourceRemixDescriptor => item !== null);
}

function resolveResourceRemixDescriptorTarget(items: PostResourceRemixDescriptor[]): PostRemixTarget {
  if (items.some((item) => item.remixUse === 'text_template')) {
    return 'text_template';
  }

  if (items.some((item) => item.type !== 'remix_link' && item.remixUse === 'direct_remix')) {
    return 'image';
  }

  if (items.some((item) => item.type === 'workflow' && item.remixUse === 'import_source')) {
    return 'workflow';
  }

  if (items.some((item) => item.type !== 'remix_link' && item.remixUse === 'reference_only')) {
    return 'image';
  }

  return null;
}

export function resolvePostRemixCapability(input: PostRemixResolutionInput): {
  capability: PostRemixCapability;
  target: PostRemixTarget;
} {
  const resourceBundle = input.resourceBundle ?? null;
  const items = normalizePostResourceRemixDescriptors(resourceBundle?.items ?? []);
  const bundleRequiresUnlock = Boolean(resourceBundle && !resourceBundle.viewerCanAccess);
  const resourceTarget = resolveResourceRemixDescriptorTarget(items);
  const isTextPost = input.postFormat === 'text' || input.category === 'text';
  const hasGeneration = typeof input.generationId === 'string' && input.generationId.length > 0;

  if (isTextPost) {
    if (resourceTarget === 'text_template') {
      return {
        capability: bundleRequiresUnlock ? 'unlock_required' : 'public',
        target: 'text_template',
      };
    }

    return {
      capability: 'none',
      target: null,
    };
  }

  if (hasGeneration) {
    return {
      capability: resourceBundle?.allowRemix && bundleRequiresUnlock ? 'unlock_required' : 'public',
      target: targetForMediaCategory(input.category),
    };
  }

  if (resourceTarget) {
    return {
      capability: bundleRequiresUnlock ? 'unlock_required' : 'public',
      target: resourceTarget,
    };
  }

  if (input.sourceKind === 'external' || input.sourceKind === 'manual') {
    return {
      capability: 'unsupported',
      target: null,
    };
  }

  return {
    capability: 'none',
    target: null,
  };
}
