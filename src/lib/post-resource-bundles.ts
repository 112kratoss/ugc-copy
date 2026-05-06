import type { SerializedWorkflowCanvasGraph } from '@/lib/workflow-canvas';

export type PostResourceBundleAccessMode = 'none' | 'free' | 'paid';
export type PersistedPostResourceBundleAccessMode = Exclude<PostResourceBundleAccessMode, 'none'>;
export type PostResourceBundleStatus = 'draft' | 'published';
export type PostResourceKind = 'prompt' | 'workflow' | 'files' | 'notes' | 'remix';
export type MarketplaceResourceFilter = 'all' | 'free' | 'paid';
export type MarketplaceResourceKindFilter = 'all' | PostResourceKind;
export type MarketplaceResourceSort = 'recent' | 'top-sales';
export type MarketplaceCheckoutCurrency = 'INR' | 'USD';

export type PostResourceAttachmentKind = 'link' | 'file';

export interface PostResourceAttachment {
  label: string;
  kind?: PostResourceAttachmentKind;
  url?: string | null;
  storagePath?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
}

export interface PostResourceBundleResources {
  promptText: string | null;
  notesMarkdown: string | null;
  workflowShareUrl: string | null;
  workflowSnapshot: SerializedWorkflowCanvasGraph | null;
  attachments: PostResourceAttachment[];
  allowRemix: boolean;
}

export interface PostResourceAttachmentPreview {
  label: string;
  kind: PostResourceAttachmentKind;
  contentType?: string | null;
  sizeBytes?: number | null;
}

export interface PostResourceBundleLockedPreview {
  resourceKinds: PostResourceKind[];
  attachmentPreviews: PostResourceAttachmentPreview[];
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

export interface PostResourceBundleSummary {
  id: string;
  postId: string;
  title: string;
  accessMode: PersistedPostResourceBundleAccessMode;
  priceUsdCents: number;
  previewText: string;
  status: PostResourceBundleStatus;
  allowRemix: boolean;
  resourceKinds: PostResourceKind[];
}

export interface MarketplacePriceQuote {
  currency: MarketplaceCheckoutCurrency;
  amountSubunits: number;
  formatted: string;
  note: string | null;
}

export function isPostResourceBundleAccessMode(
  value: string | null | undefined
): value is PostResourceBundleAccessMode {
  return value === 'none' || value === 'free' || value === 'paid';
}

export function isPersistedPostResourceBundleAccessMode(
  value: string | null | undefined
): value is PersistedPostResourceBundleAccessMode {
  return value === 'free' || value === 'paid';
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
  return value === 'top-sales' ? 'top-sales' : 'recent';
}

export function isPostResourceKind(value: string | null | undefined): value is PostResourceKind {
  return value === 'prompt' || value === 'workflow' || value === 'files' || value === 'notes' || value === 'remix';
}

export function normalizeMarketplaceResourceKindFilter(
  value: string | null | undefined
): MarketplaceResourceKindFilter {
  return isPostResourceKind(value) ? value : 'all';
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
    return 'Free unlock';
  }

  return `${formatUsdCents(priceUsdCents)} unlock`;
}

export function getPostResourceKinds(
  resources: Partial<PostResourceBundleResources> | null | undefined
): PostResourceKind[] {
  if (!resources) {
    return [];
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

  return kinds;
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
        } satisfies PostResourceAttachment;
      }

      if (!url) {
        return null;
      }

      return {
        label: label || url,
        kind,
        url,
      } satisfies PostResourceAttachment;
    })
    .filter((item): item is PostResourceAttachment => item !== null);
}

export function buildPostResourceBundleLockedPreview(
  resources: Partial<PostResourceBundleResources> | null | undefined,
  updatedAt: string | null = null
): PostResourceBundleLockedPreview {
  const attachments = normalizePostResourceAttachments(resources?.attachments);
  const normalizedResources: Partial<PostResourceBundleResources> = {
    promptText: resources?.promptText ?? null,
    notesMarkdown: resources?.notesMarkdown ?? null,
    workflowShareUrl: resources?.workflowShareUrl ?? null,
    workflowSnapshot: resources?.workflowSnapshot ?? null,
    attachments,
    allowRemix: Boolean(resources?.allowRemix),
  };

  return {
    resourceKinds: getPostResourceKinds(normalizedResources),
    attachmentPreviews: attachments.map((attachment) => ({
      label: attachment.label,
      kind: attachment.kind ?? 'link',
      contentType: attachment.kind === 'file' ? attachment.contentType ?? null : null,
      sizeBytes: attachment.kind === 'file' ? attachment.sizeBytes ?? null : null,
    })),
    hasPrompt: Boolean(normalizedResources.promptText?.trim()),
    hasNotes: Boolean(normalizedResources.notesMarkdown?.trim()),
    hasWorkflow: Boolean(normalizedResources.workflowShareUrl?.trim() || normalizedResources.workflowSnapshot),
    hasRemix: Boolean(normalizedResources.allowRemix),
    updatedAt,
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
