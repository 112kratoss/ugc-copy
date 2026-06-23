import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  POST_MUTATION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';

type ArchivedPostRow = {
  id: string;
  generation_id?: string | null;
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

  await adminSupabase
    .from('post_resource_bundles')
    .update({ status: 'draft' })
    .eq('post_id', postId)
    .eq('owner_user_id', ownerUserId)
    .eq('status', 'published');

  if (post.generation_id) {
    await adminSupabase
      .from('generations')
      .update({
        is_public: false,
        showcase_asset_path: null,
      })
      .eq('id', post.generation_id);
  }

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
    .select('id')
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to restore post.' },
    };
  }

  if (!data) {
    return {
      ok: false,
      status: 404,
      body: { error: 'Post not found.' },
    };
  }

  return {
    ok: true,
    body: { success: true, restored: true },
  };
}
