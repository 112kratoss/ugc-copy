import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  POST_MUTATION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import type { PostResourceBundleInput } from '@/lib/post-resource-bundles';
import { validatePostResourceBundleInput } from '@/lib/post-resource-bundles';
import { isCreatorProfileCheckError } from '@/lib/marketplace-trust';
import {
  getMarketplaceQualityErrorForPostBundle,
  getPostResourceBundleDetailByPostId,
  savePostResourceBundle,
} from '@/lib/post-resource-bundles-server';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';

type PostResourceBundleBody = {
  resourceBundle?: PostResourceBundleInput | null;
};

type PostResourceBundlePostRow = {
  id: string;
  user_id: string;
  title: string | null;
  body: string | null;
  visibility: string | null;
  archived_at: string | null;
  review_status: string | null;
  showcase_asset_path: string | null;
  output_url: string | null;
};

type PostResourceBundleRouteBody = Record<string, unknown>;

export type PostResourceBundleRouteResult =
  | {
      ok: true;
      body: PostResourceBundleRouteBody;
    }
  | {
      ok: false;
      status: 400 | 404 | 500;
      body: PostResourceBundleRouteBody;
    }
  | {
      ok: false;
      status: 429;
      body: PostResourceBundleRouteBody;
      rateLimitError: BackendRateLimitError;
    };

export type PostResourceBundleRouteDependencies = {
  getDetailByPostId?: typeof getPostResourceBundleDetailByPostId;
  getMarketplaceQualityErrorForPostBundle?: typeof getMarketplaceQualityErrorForPostBundle;
  savePostResourceBundle?: typeof savePostResourceBundle;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeRequestBody(body: unknown): PostResourceBundleBody {
  return isRecord(body) ? body as PostResourceBundleBody : {};
}

export async function getPostResourceBundleForRoute({
  postId,
  viewerUserId,
  countryCode,
  getDetailByPostId = getPostResourceBundleDetailByPostId,
}: {
  postId: string;
  viewerUserId: string | null;
  countryCode: string | null;
  getDetailByPostId?: typeof getPostResourceBundleDetailByPostId;
}): Promise<PostResourceBundleRouteResult> {
  const detail = await getDetailByPostId(postId, {
    viewerUserId,
    countryCode,
  });

  if (!detail) {
    return { ok: false, status: 404, body: { error: 'Resource bundle not found.' } };
  }

  return {
    ok: true,
    body: {
      success: true,
      bundle: detail,
    },
  };
}

export async function putPostResourceBundleForRoute({
  postId,
  ownerUserId,
  userSupabase,
  adminSupabase,
  readBody,
  dependencies = {},
}: {
  postId: string;
  ownerUserId: string;
  userSupabase: SupabaseClient;
  adminSupabase: SupabaseClient;
  readBody: () => Promise<unknown>;
  dependencies?: PostResourceBundleRouteDependencies;
}): Promise<PostResourceBundleRouteResult> {
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...POST_MUTATION_RATE_LIMIT,
      key: ownerUserId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return {
        ok: false,
        status: 429,
        body: { error: error.message },
        rateLimitError: error,
      };
    }

    logBackendError('failed_to_enforce_resource_bundle_update_rate_limit', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to save resource bundle.' } };
  }

  const body = normalizeRequestBody(await readBody());
  const { data: post, error: postError } = await userSupabase
    .from('posts')
    .select('id, user_id, title, body, visibility, archived_at, review_status, showcase_asset_path, output_url')
    .eq('id', postId)
    .maybeSingle();

  const typedPost = (post as PostResourceBundlePostRow | null) ?? null;
  if (postError || !typedPost || typedPost.user_id !== ownerUserId) {
    return { ok: false, status: 404, body: { error: 'Post not found.' } };
  }

  const resourceBundle = body.resourceBundle ?? null;
  const validationError = validatePostResourceBundleInput(resourceBundle, { ownerUserId });
  if (validationError) {
    return { ok: false, status: 400, body: { error: validationError } };
  }

  const resolveMarketplaceQualityError =
    dependencies.getMarketplaceQualityErrorForPostBundle ?? getMarketplaceQualityErrorForPostBundle;
  const persistPostResourceBundle = dependencies.savePostResourceBundle ?? savePostResourceBundle;

  const marketplaceQualityError = typedPost.visibility === 'public'
    ? await resolveMarketplaceQualityError({
        supabase: adminSupabase,
        ownerUserId,
        post: {
          title: typeof typedPost.title === 'string' ? typedPost.title : null,
          body: typeof typedPost.body === 'string' ? typedPost.body : null,
          visibility: typeof typedPost.visibility === 'string' ? typedPost.visibility : null,
          archivedAt: typeof typedPost.archived_at === 'string' ? typedPost.archived_at : null,
          reviewStatus: typeof typedPost.review_status === 'string' ? typedPost.review_status : 'visible',
          showcaseAssetPath: typeof typedPost.showcase_asset_path === 'string' ? typedPost.showcase_asset_path : null,
          outputUrl: typeof typedPost.output_url === 'string' ? typedPost.output_url : null,
        },
        bundle: resourceBundle,
      })
    : null;

  if (marketplaceQualityError) {
    return {
      ok: false,
      status: isCreatorProfileCheckError(marketplaceQualityError) ? 500 : 400,
      body: { error: marketplaceQualityError },
    };
  }

  const savedBundle = await persistPostResourceBundle({
    supabase: userSupabase,
    postId,
    ownerUserId,
    postTitle: typeof typedPost.title === 'string' ? typedPost.title : null,
    postVisibility: typedPost.visibility as 'public' | 'unlisted' | 'private',
    bundle: resourceBundle,
  });

  if (typedPost.visibility === 'public') {
    invalidateShowcaseFeedCache();
  }

  return {
    ok: true,
    body: {
      success: true,
      bundle: savedBundle,
    },
  };
}
