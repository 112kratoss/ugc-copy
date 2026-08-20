import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import {
  getPostResourceBundleDetailByPostId,
  type PostResourceBundleDetail,
} from '@/lib/post-resource-bundles-server';
import { loadPostMediaItemsMap } from '@/lib/post-media';
import { loadPurchasedProofMedia } from '@/lib/purchased-proof-media';
import {
  getPostResourceKinds,
  normalizePostResourceAttachments,
  normalizePostResourceItems,
  normalizePostResourceSections,
  type PersistedPostResourceBundleAccessMode,
  type PostResourceBundleResources,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';
import { normalizeWorkflowGraph, serializeWorkflowGraph } from '@/lib/workflow-canvas';
import type { ShowcaseMediaItem } from '@/lib/showcase';

type UnlockProjectionRow = {
  purchase_id: string;
  bundle_id: string | null;
  post_id: string | null;
  revision_id: string;
  purchased_at: string;
  purchase_price_usd_cents: number;
  seller_display_name: string | null;
  captured_post_title: string | null;
  bundle_retired: boolean;
  post_tombstoned: boolean;
  post_visibility: string | null;
  post_review_status: string | null;
  current_revision_id: string | null;
  purchased_revision_number: number;
  current_revision_number: number | null;
};

type RevisionRow = {
  id: string;
  revision_number: number;
  title: string;
  summary: string;
  preview_text: string;
  access_mode: PersistedPostResourceBundleAccessMode;
  price_usd_cents: number;
  prompt_text: string | null;
  notes_markdown: string | null;
  workflow_share_url: string | null;
  workflow_snapshot: unknown;
  attachments: unknown;
  allow_remix: boolean;
  resource_sections: unknown;
  resource_items: unknown;
  created_at: string;
};

export interface ViewerUnlockRevision {
  revisionId: string;
  revisionNumber: number;
  createdAt: string;
  title: string;
  summary: string;
  previewText: string;
  accessMode: PersistedPostResourceBundleAccessMode;
  priceUsdCents: number;
  resources: PostResourceBundleResources;
  mediaItems: ShowcaseMediaItem[];
}

export interface ViewerUnlockDetail {
  unlockId: string;
  bundleId: string | null;
  postId: string | null;
  title: string;
  summary: string;
  previewText: string;
  accessMode: PersistedPostResourceBundleAccessMode;
  priceUsdCents: number;
  purchasePriceUsdCents: number;
  /** Null after detachment because there is no live listing to count. */
  salesCount: number | null;
  purchasedAt: string;
  creatorDisplayName: string;
  /** Present while the live bundle exists; detached revisions rely on retained-file mappings. */
  creatorUserId: string | null;
  resourceKinds: PostResourceKind[];
  currentResources: PostResourceBundleResources | null;
  purchasedRevision: ViewerUnlockRevision;
  hasNewerRevision: boolean;
  detached: boolean;
  retired: boolean;
  tombstoned: boolean;
  postVisibility: string | null;
  post: PostResourceBundleDetail['post'] | null;
  /** Full proof-media order and stable keys power per-output resource scopes. */
  mediaItems: ShowcaseMediaItem[];
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeRevisionResources(
  row: RevisionRow,
  supplementItems: unknown,
): PostResourceBundleResources {
  const attachments = normalizePostResourceAttachments(row.attachments);
  const sections = normalizePostResourceSections(row.resource_sections);
  const baseResources: PostResourceBundleResources = {
    promptText: normalizeOptionalText(row.prompt_text),
    notesMarkdown: normalizeOptionalText(row.notes_markdown),
    workflowShareUrl: normalizeOptionalText(row.workflow_share_url),
    workflowSnapshot: row.workflow_snapshot && typeof row.workflow_snapshot === 'object'
      ? serializeWorkflowGraph(normalizeWorkflowGraph(row.workflow_snapshot))
      : null,
    attachments,
    allowRemix: Boolean(row.allow_remix),
    sections,
    items: [],
  };
  const baseItems = normalizePostResourceItems(row.resource_items, baseResources);
  const supplements = normalizePostResourceItems(supplementItems, baseResources);
  const seen = new Set<string>();

  baseResources.items = [...baseItems, ...supplements].filter((item) => {
    const identity = item.storagePath ? `path:${item.storagePath}` : `id:${item.id}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });

  return baseResources;
}

async function loadPurchasedRevision(
  adminSupabase: SupabaseClient,
  revisionId: string,
): Promise<ViewerUnlockRevision | null> {
  const [{ data: revisionData, error: revisionError }, { data: supplementData, error: supplementError }] = await Promise.all([
    adminSupabase
      .from('post_resource_bundle_revisions')
      .select('id, revision_number, title, summary, preview_text, access_mode, price_usd_cents, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix, resource_sections, resource_items, created_at')
      .eq('id', revisionId)
      .maybeSingle(),
    adminSupabase
      .from('post_resource_bundle_revision_supplements')
      .select('resource_items')
      .eq('revision_id', revisionId)
      .maybeSingle(),
  ]);

  if (revisionError || !revisionData) {
    logBackendError('viewer_unlock_revision_load_failed', { error: revisionError });
    return null;
  }
  if (supplementError) {
    logBackendError('viewer_unlock_supplement_load_failed', { error: supplementError });
  }

  const row = revisionData as RevisionRow;
  return {
    revisionId: row.id,
    revisionNumber: row.revision_number,
    createdAt: row.created_at,
    title: row.title?.trim() || 'Unlock',
    summary: row.summary ?? '',
    previewText: row.preview_text ?? '',
    accessMode: row.access_mode,
    priceUsdCents: row.price_usd_cents ?? 0,
    resources: normalizeRevisionResources(
      row,
      (supplementData as { resource_items?: unknown } | null)?.resource_items ?? [],
    ),
    mediaItems: [],
  };
}

/**
 * Resolves exactly one buyer entitlement by purchase UUID. The database RPC
 * returns no row for another buyer or a moderation-retracted purchase, so both
 * cases intentionally collapse to the same not-found result.
 */
export async function getViewerUnlockDetail({
  adminSupabase,
  unlockId,
  viewerUserId,
  countryCode = null,
}: {
  adminSupabase: SupabaseClient;
  unlockId: string;
  viewerUserId: string;
  countryCode?: string | null;
}): Promise<ViewerUnlockDetail | null> {
  const { data, error } = await adminSupabase.rpc('get_viewer_post_resource_unlock', {
    p_purchase_id: unlockId,
    p_buyer_user_id: viewerUserId,
  });

  if (error) {
    logBackendError('viewer_unlock_detail_projection_failed', { error });
    throw error;
  }

  const [projection] = (data ?? []) as UnlockProjectionRow[];
  if (!projection) return null;

  const purchasedRevision = await loadPurchasedRevision(adminSupabase, projection.revision_id);
  if (!purchasedRevision) return null;

  let liveDetail: PostResourceBundleDetail | null = null;
  if (projection.post_id && projection.bundle_id) {
    liveDetail = await getPostResourceBundleDetailByPostId(projection.post_id, {
      adminSupabase,
      viewerUserId,
      countryCode,
    });
  }

  const currentResources = liveDetail?.resources ?? null;
  const detached = !projection.bundle_id || !projection.post_id || !liveDetail;
  const title = liveDetail?.title ?? purchasedRevision.title;
  const summary = liveDetail?.summary ?? purchasedRevision.summary;
  const previewText = liveDetail?.previewText ?? purchasedRevision.previewText;
  const resourcesForKinds = currentResources ?? purchasedRevision.resources;
  const currentMediaItems = projection.post_id
    ? await loadPostMediaItemsMap(adminSupabase, [projection.post_id])
      .then((itemsByPost) => itemsByPost.get(projection.post_id ?? '') ?? [])
      .catch((mediaError) => {
        logBackendError('viewer_unlock_proof_media_load_failed', { error: mediaError });
        return [];
      })
    : [];
  const purchasedMediaItems = await loadPurchasedProofMedia({
    adminSupabase,
    purchaseId: projection.purchase_id,
    resources: purchasedRevision.resources,
    includeStoredUrls: !detached,
  });
  purchasedRevision.mediaItems = purchasedMediaItems;
  // An empty latest gallery is a valid edit, not a signal to borrow the old
  // revision's outputs. Only detached purchases (which have no live resource
  // version at all) fall back to the immutable purchase snapshot.
  const mediaItems = currentResources ? currentMediaItems : purchasedMediaItems;

  return {
    unlockId: projection.purchase_id,
    bundleId: projection.bundle_id,
    postId: projection.post_id,
    title,
    summary,
    previewText,
    accessMode: liveDetail?.accessMode ?? purchasedRevision.accessMode,
    priceUsdCents: liveDetail?.priceUsdCents ?? purchasedRevision.priceUsdCents,
    purchasePriceUsdCents: projection.purchase_price_usd_cents ?? 0,
    salesCount: liveDetail?.salesCount ?? null,
    purchasedAt: projection.purchased_at,
    creatorDisplayName: liveDetail?.seller.name
      ?? normalizeOptionalText(projection.seller_display_name)
      ?? 'Deleted creator',
    creatorUserId: liveDetail?.seller.id ?? null,
    resourceKinds: getPostResourceKinds(resourcesForKinds),
    currentResources,
    purchasedRevision,
    hasNewerRevision: Boolean(
      projection.current_revision_number
      && projection.current_revision_number > projection.purchased_revision_number
    ),
    detached,
    retired: Boolean(projection.bundle_retired || liveDetail?.retiredAt),
    tombstoned: Boolean(projection.post_tombstoned || liveDetail?.tombstoned),
    postVisibility: projection.post_visibility,
    post: liveDetail?.post ?? null,
    mediaItems,
  };
}

export function listViewerUnlockStoragePaths(detail: ViewerUnlockDetail): Set<string> {
  const resources = [detail.currentResources, detail.purchasedRevision.resources]
    .filter((value): value is PostResourceBundleResources => Boolean(value));
  const paths = new Set<string>();

  for (const resource of resources) {
    for (const attachment of resource.attachments) {
      if (attachment.kind === 'file' && attachment.storagePath) paths.add(attachment.storagePath);
    }
    for (const item of resource.items ?? []) {
      if (item.storagePath) paths.add(item.storagePath);
    }
  }

  return paths;
}
