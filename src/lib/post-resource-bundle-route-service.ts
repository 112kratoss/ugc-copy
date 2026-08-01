import 'server-only';

import {
  BackendRateLimitError,
} from '@/lib/backend-rate-limit';
import { getPostResourceBundleDetailByPostId } from '@/lib/post-resource-bundles-server';

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
};

/**
 * Read-only. Bundle writes belong to the post create/update services, which own
 * the media-scope validation and moderation locks this route never had.
 */
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
