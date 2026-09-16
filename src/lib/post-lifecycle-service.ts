import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  POST_MUTATION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';

type ArchivedPostRow = {
  id: string;
  generation_id?: string | null;
};

type RestoredPostRow = {
  id: string;
  generation_id?: string | null;
  visibility?: 'public' | 'unlisted' | 'private' | null;
  showcase_asset_path?: string | null;
};

export type PostLifecycleResult =
  | {
    ok: true;
    body: {
      success: true;
      archived?: true;
      restored?: true;
    };
  }
  | {
    ok: false;
    status: 404 | 500;
    body: {
      error: string;
    };
  }
  | {
    ok: false;
    rateLimitError: BackendRateLimitError;
  };

async function enforcePostLifecycleRateLimit(adminSupabase: SupabaseClient, ownerUserId: string) {
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...POST_MUTATION_RATE_LIMIT,
      key: ownerUserId,
    });

    return null;
  } catch (error) {
    return error;
  }
}

export async function archiveOwnerPostForRoute({
  adminSupabase,
  now = () => new Date(),
  ownerUserId,
  postId,
}: {
  adminSupabase: SupabaseClient;
  now?: () => Date;
  ownerUserId: string;
  postId: string;
}): Promise<PostLifecycleResult> {
  const rateLimitError = await enforcePostLifecycleRateLimit(adminSupabase, ownerUserId);
  if (rateLimitError) {
    if (rateLimitError instanceof BackendRateLimitError) {
      return { ok: false, rateLimitError };
    }

    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to archive post.' },
    };
  }

  const { data, error } = await adminSupabase
    .from('posts')
    .update({
      archived_at: now().toISOString(),
      archived_by_user_id: ownerUserId,
    })
    .eq('id', postId)
    .eq('user_id', ownerUserId)
    .is('archived_at', null)
    .select('id, generation_id')
    .maybeSingle();
  const post = data as ArchivedPostRow | null;

  if (error) {
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to archive post.' },
    };
  }

  if (!post) {
    return {
      ok: false,
      status: 404,
      body: { error: 'Post not found.' },
    };
  }

  invalidateShowcaseFeedCache();

  // The posts trigger already demoted the recipe when archived_at was set;
  // this matches no rows now and stays as a belt for older schemas.
  await adminSupabase
    .from('post_resource_bundles')
    .update({ status: 'draft' })
    .eq('post_id', postId)
    .eq('owner_user_id', ownerUserId)
    .eq('status', 'published');

  // Setting archived_at took the linked generation off show in that same
  // statement: the posts trigger owns the generation's exposure. The post keeps
  // its showcase path, which is what restore puts back.

  return {
    ok: true,
    body: { success: true, archived: true },
  };
}

export async function restoreOwnerPostForRoute({
  adminSupabase,
  ownerUserId,
  postId,
}: {
  adminSupabase: SupabaseClient;
  ownerUserId: string;
  postId: string;
}): Promise<PostLifecycleResult> {
  const rateLimitError = await enforcePostLifecycleRateLimit(adminSupabase, ownerUserId);
  if (rateLimitError) {
    if (rateLimitError instanceof BackendRateLimitError) {
      return { ok: false, rateLimitError };
    }

    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to restore post.' },
    };
  }

  const { data, error } = await adminSupabase
    .from('posts')
    .update({
      archived_at: null,
      archived_by_user_id: null,
    })
    .eq('id', postId)
    .eq('user_id', ownerUserId)
    .not('archived_at', 'is', null)
    .select('id, generation_id, visibility, showcase_asset_path')
    .maybeSingle();
  const post = data as RestoredPostRow | null;

  if (error) {
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to restore post.' },
    };
  }

  if (!post) {
    return {
      ok: false,
      status: 404,
      body: { error: 'Post not found.' },
    };
  }

  invalidateShowcaseFeedCache();

  // Clearing archived_at put the linked generation back on show in that same
  // statement, from the post's own visibility and the showcase path the post
  // kept, and re-promoted the recipe: the posts triggers own both.

  return {
    ok: true,
    body: { success: true, restored: true },
  };
}
