import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  POST_MUTATION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  getPostResourceKinds,
  normalizePostResourceAttachments,
  normalizePostResourceItems,
  normalizePostResourceSections,
  type PostResourceBundleResources,
} from '@/lib/post-resource-bundles';
import {
  isMissingPostResourceBundlesSchemaError,
  isMissingPostResourceItemsColumnError,
} from '@/lib/posts-server';
import {
  normalizeShowcaseSourceKind,
  type RawShowcaseSourceKind,
  type ShowcaseVisibility,
} from '@/lib/showcase';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';
import { parseCanonicalStorageObjectPath } from '@/lib/storage-ownership';

const SHOWCASE_MEDIA_BUCKET = 'showcase_media';

export function getCanonicalPostShowcaseAssetPath(
  storagePath: string | null | undefined,
  postId: string,
  generationId: string | null,
): string | null {
  if (!storagePath) return null;
  const canonicalPath = parseCanonicalStorageObjectPath(storagePath, { minimumSegments: 3 });
  if (!canonicalPath) return null;
  if (canonicalPath.startsWith(`posts/${postId}/`)) return canonicalPath;
  return generationId && canonicalPath.startsWith(`showcase/${generationId}/`)
    ? canonicalPath
    : null;
}

type DeletablePostRow = {
  id: string;
  user_id: string;
  generation_id: string | null;
  visibility: ShowcaseVisibility;
  title: string | null;
  source_kind: RawShowcaseSourceKind;
  showcase_asset_path: string | null;
};

type DeletableBundleRow = {
  id: string;
  access_mode: 'free' | 'paid';
  status: 'draft' | 'published';
  price_usd_cents: number;
  sales_count: number;
  earnings_usd_cents: number;
  prompt_text: string | null;
  notes_markdown: string | null;
  workflow_share_url: string | null;
  workflow_snapshot: unknown;
  attachments: unknown;
  resource_sections?: unknown;
  resource_items?: unknown;
  allow_remix: boolean;
};

export type PostDeleteRouteResult =
  | {
      ok: true;
      body: {
        success: true;
        deleted: true;
        /**
         * True when the post had buyers and was tombstoned instead of removed:
         * gone from every public surface, still resolvable for the people who
         * paid for its unlock.
         */
        tombstoned?: true;
      };
    }
  | {
      ok: false;
      status: 404 | 409 | 500;
      body: {
        error: string;
        requiresForceDelete?: true;
      };
    }
  | {
      ok: false;
      status: 429;
      rateLimitError: BackendRateLimitError;
      body: {
        error: string;
        code: 'RATE_LIMITED';
        retryAfterSeconds: number;
        limit: number;
        resetAt: string;
      };
    };

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function loadOwnedPost(
  adminSupabase: SupabaseClient,
  postId: string,
  ownerUserId: string,
): Promise<DeletablePostRow | null> {
  const { data, error } = await adminSupabase
    .from('posts')
    .select('id, user_id, generation_id, visibility, title, source_kind, showcase_asset_path')
    .eq('id', postId)
    .eq('user_id', ownerUserId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as DeletablePostRow | null) ?? null;
}

/**
 * Entitlements, not revenue: a free unlock is as much a purchase as a paid one,
 * and both must survive the creator removing the post. This deliberately reads
 * the purchase rows rather than trusting `sales_count`, which the refund path
 * decrements.
 */
async function countBundlePurchases(
  adminSupabase: SupabaseClient,
  bundleId: string,
): Promise<boolean> {
  const { data, error } = await adminSupabase
    .from('post_resource_bundle_purchases')
    .select('bundle_id')
    .eq('bundle_id', bundleId)
    .limit(1);

  if (error) {
    if (isMissingPostResourceBundlesSchemaError(error)) {
      return false;
    }

    logBackendError('failed_to_check_bundle_purchases_before_delete', { error: error });
    throw error;
  }

  return (data ?? []).length > 0;
}

async function hasPendingBundleCashOrder(
  adminSupabase: SupabaseClient,
  bundleId: string,
): Promise<boolean> {
  const { data, error } = await adminSupabase
    .from('post_resource_bundle_orders')
    .select('id')
    .eq('bundle_id', bundleId)
    .eq('status', 'created')
    .gt('amount_subunits', 0)
    .limit(1);

  if (error) {
    if (isMissingPostResourceBundlesSchemaError(error)) {
      return false;
    }

    logBackendError('failed_to_check_pending_bundle_cash_orders_before_delete', { error });
    throw error;
  }

  return (data ?? []).length > 0;
}

async function loadPostBundleForDelete(
  adminSupabase: SupabaseClient,
  postId: string,
): Promise<DeletableBundleRow | null> {
  const selectBundle = (selectColumns: string) =>
    adminSupabase
      .from('post_resource_bundles')
      .select(selectColumns)
      .eq('post_id', postId)
      .maybeSingle();

  let { data, error } = await selectBundle(
    'id, access_mode, status, price_usd_cents, sales_count, earnings_usd_cents, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, resource_sections, resource_items, allow_remix',
  );

  if (isMissingPostResourceItemsColumnError(error)) {
    ({ data, error } = await selectBundle(
      'id, access_mode, status, price_usd_cents, sales_count, earnings_usd_cents, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix',
    ));
  }

  if (error && !isMissingPostResourceBundlesSchemaError(error)) {
    logBackendError('failed_to_load_post_bundle_before_delete', { error: error });
    throw error;
  }

  return (data as DeletableBundleRow | null) ?? null;
}

function getBundleResourcesForAudit(bundle: DeletableBundleRow): Partial<PostResourceBundleResources> {
  const legacyResources: PostResourceBundleResources = {
    promptText: bundle.prompt_text,
    notesMarkdown: bundle.notes_markdown,
    workflowShareUrl: bundle.workflow_share_url,
    workflowSnapshot: bundle.workflow_snapshot as PostResourceBundleResources['workflowSnapshot'],
    attachments: normalizePostResourceAttachments(bundle.attachments),
    allowRemix: bundle.allow_remix,
    sections: normalizePostResourceSections(bundle.resource_sections),
  };

  return {
    ...legacyResources,
    items: normalizePostResourceItems(bundle.resource_items, legacyResources),
  };
}

function createRateLimitResult(error: BackendRateLimitError): PostDeleteRouteResult {
  return {
    ok: false,
    status: 429,
    rateLimitError: error,
    body: {
      error: error.message,
      code: 'RATE_LIMITED',
      retryAfterSeconds: error.retryAfterSeconds,
      limit: error.state.limit,
      resetAt: error.state.resetAt,
    },
  };
}

export async function deleteOwnerPostForRoute({
  adminSupabase,
  ownerUserId,
  postId,
  forceDelete = false,
}: {
  adminSupabase: SupabaseClient;
  ownerUserId: string;
  postId: string;
  forceDelete?: boolean;
}): Promise<PostDeleteRouteResult> {
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...POST_MUTATION_RATE_LIMIT,
      key: ownerUserId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    logBackendError('failed_to_enforce_post_delete_rate_limit', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to delete post.' } };
  }

  const post = await loadOwnedPost(adminSupabase, postId, ownerUserId);
  if (!post) {
    return { ok: false, status: 404, body: { error: 'Post not found.' } };
  }

  let bundle: DeletableBundleRow | null;
  let hasPurchases = false;
  let hasPendingCashOrder = false;
  try {
    bundle = await loadPostBundleForDelete(adminSupabase, postId);
    if (bundle) {
      [hasPurchases, hasPendingCashOrder] = await Promise.all([
        countBundlePurchases(adminSupabase, bundle.id),
        hasPendingBundleCashOrder(adminSupabase, bundle.id),
      ]);
    }
  } catch {
    return { ok: false, status: 500, body: { error: 'Failed to delete post.' } };
  }
  const hasPaidOrders = Boolean(bundle && bundle.access_mode === 'paid' && bundle.sales_count > 0);

  if ((hasPurchases || hasPendingCashOrder) && !forceDelete) {
    return {
      ok: false,
      status: 409,
      body: {
        error: hasPurchases
          ? 'People have already unlocked this post. Deleting it removes it from your profile and every public surface, but buyers keep the version they unlocked. Archiving does the same and is reversible.'
          : 'A paid checkout for this unlock is still pending. Deleting it removes it from your profile and public surfaces while retaining the quoted version so any captured payment can still be fulfilled.',
        requiresForceDelete: true,
      },
    };
  }

  const bundleResources = bundle ? getBundleResourcesForAudit(bundle) : null;
  const { error: auditError } = await adminSupabase.from('post_deletion_audits').insert({
    post_id: post.id,
    owner_user_id: ownerUserId,
    generation_id: post.generation_id,
    title: normalizeText(post.title) ?? 'Deleted post',
    visibility: post.visibility,
    source_kind: normalizeShowcaseSourceKind(post.source_kind),
    bundle_access_mode: bundle?.access_mode ?? null,
    bundle_status: bundle?.status ?? null,
    bundle_price_usd_cents: bundle?.price_usd_cents ?? null,
    bundle_resource_kinds: bundle ? getPostResourceKinds(bundleResources) : [],
    sales_count: bundle?.sales_count ?? 0,
    earnings_usd_cents: bundle?.earnings_usd_cents ?? 0,
    had_paid_orders: hasPaidOrders,
  });

  if (auditError) {
    logBackendError('failed_to_snapshot_post_deletion_audit', { error: auditError });
    return { ok: false, status: 500, body: { error: 'Failed to delete post.' } };
  }

  let verifiedLinkedGenerationId: string | null = null;
  if (post.generation_id) {
    const { data: generation, error: generationError } = await adminSupabase
      .from('generations')
      .select('id, showcase_asset_path')
      .eq('id', post.generation_id)
      .eq('user_id', ownerUserId)
      .maybeSingle();

    if (generationError) {
      logBackendError('failed_to_load_linked_generation_before_post_delete', { error: generationError });
    } else if (generation) {
      verifiedLinkedGenerationId = post.generation_id;
      await adminSupabase
        .from('generations')
        .update({
          is_public: false,
          showcase_asset_path: null,
        })
        .eq('id', post.generation_id)
        .eq('user_id', ownerUserId);
    }
  }

  const removableShowcasePath = getCanonicalPostShowcaseAssetPath(
    post.showcase_asset_path,
    post.id,
    verifiedLinkedGenerationId,
  );

  // A post with buyers or a still-payable cash order is tombstoned, never
  // removed. The row keeps the quoted checkout fulfillable, while private +
  // archived takes it off every public read path. The database refuses the hard
  // delete too, so this is the agreeing half of an invariant rather than the
  // only guard.
  if (hasPurchases || hasPendingCashOrder) {
    const tombstonedAt = new Date().toISOString();
    const { error: tombstoneError } = await adminSupabase
      .from('posts')
      .update({
        tombstoned_at: tombstonedAt,
        archived_at: tombstonedAt,
        archived_by_user_id: ownerUserId,
        visibility: 'private',
      })
      .eq('id', postId)
      .eq('user_id', ownerUserId);

    if (tombstoneError) {
      logBackendError('failed_to_tombstone_post', { error: tombstoneError });
      return { ok: false, status: 500, body: { error: 'Failed to delete post.' } };
    }

    if (bundle) {
      const { error: retireError } = await adminSupabase
        .from('post_resource_bundles')
        .update({ status: 'draft', retired_at: tombstonedAt })
        .eq('id', bundle.id);

      if (retireError && !isMissingPostResourceBundlesSchemaError(retireError)) {
        logBackendError('failed_to_retire_bundle_on_tombstone', { error: retireError });
      }
    }

    invalidateShowcaseFeedCache();

    // Media and resource files are deliberately retained: they are what the
    // buyer paid to keep.
    return {
      ok: true,
      body: {
        success: true,
        deleted: true,
        tombstoned: true,
      },
    };
  }

  const { error: deleteError } = await adminSupabase
    .from('posts')
    .delete()
    .eq('id', postId)
    .eq('user_id', ownerUserId);

  if (deleteError) {
    logBackendError('failed_to_delete_post', { error: deleteError });
    return { ok: false, status: 500, body: { error: 'Failed to delete post.' } };
  }

  invalidateShowcaseFeedCache();

  if (removableShowcasePath) {
    await adminSupabase.storage.from(SHOWCASE_MEDIA_BUCKET).remove([removableShowcasePath]);
  }

  return {
    ok: true,
    body: {
      success: true,
      deleted: true,
    },
  };
}
