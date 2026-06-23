import 'server-only';

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

const SHOWCASE_MEDIA_BUCKET = 'showcase_media';

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
    console.error('Failed to load post bundle before delete:', error);
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

    console.error('Failed to enforce post delete rate limit:', error);
    return { ok: false, status: 500, body: { error: 'Failed to delete post.' } };
  }

  const post = await loadOwnedPost(adminSupabase, postId, ownerUserId);
  if (!post) {
    return { ok: false, status: 404, body: { error: 'Post not found.' } };
  }

  let bundle: DeletableBundleRow | null;
  try {
    bundle = await loadPostBundleForDelete(adminSupabase, postId);
  } catch {
    return { ok: false, status: 500, body: { error: 'Failed to delete post.' } };
  }
  const hasPaidOrders = Boolean(bundle && bundle.access_mode === 'paid' && bundle.sales_count > 0);

  if (hasPaidOrders && !forceDelete) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'This post already has paid unlocks. Archive is recommended, but you can still force delete it if you want to remove it permanently.',
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
    console.error('Failed to snapshot post deletion audit:', auditError);
    return { ok: false, status: 500, body: { error: 'Failed to delete post.' } };
  }

  const removableShowcasePath = post.showcase_asset_path;

  if (post.generation_id) {
    const { data: generation, error: generationError } = await adminSupabase
      .from('generations')
      .select('id, showcase_asset_path')
      .eq('id', post.generation_id)
      .maybeSingle();

    if (generationError) {
      console.error('Failed to load linked generation before post delete:', generationError);
    } else if (generation) {
      await adminSupabase
        .from('generations')
        .update({
          is_public: false,
          showcase_asset_path: null,
        })
        .eq('id', post.generation_id);
    }
  }

  const { error: deleteError } = await adminSupabase
    .from('posts')
    .delete()
    .eq('id', postId)
    .eq('user_id', ownerUserId);

  if (deleteError) {
    console.error('Failed to delete post:', deleteError);
    return { ok: false, status: 500, body: { error: 'Failed to delete post.' } };
  }

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
