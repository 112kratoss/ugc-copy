import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  POST_REPORT_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';

const REPORT_REASONS = new Set([
  'spam',
  'stolen_content',
  'misleading_unlock',
  'unsafe_content',
  'payment_issue',
  'other',
]);

type PostReportBody = {
  reason?: unknown;
  details?: unknown;
  bundleId?: unknown;
};

export type PostReportRouteResult =
  | {
      ok: true;
      body: { success: true };
    }
  | {
      ok: false;
      status: 400 | 404 | 429 | 500;
      body: {
        error: string;
        code?: 'RATE_LIMITED';
        retryAfterSeconds?: number;
        limit?: number;
        resetAt?: string;
      };
      rateLimitError?: BackendRateLimitError;
    };

function normalizeBody(value: unknown): PostReportBody {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as PostReportBody
    : {};
}

function normalizeReason(value: unknown) {
  return typeof value === 'string' && REPORT_REASONS.has(value) ? value : null;
}

function normalizeDetails(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 1000) : null;
}

function normalizeBundleId(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function createRateLimitResult(error: BackendRateLimitError): PostReportRouteResult {
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

export async function submitPostReportForRoute({
  postId,
  reporterUserId,
  readBody,
  createAdminSupabase,
}: {
  postId: string;
  reporterUserId: string;
  readBody: () => Promise<unknown>;
  createAdminSupabase: () => SupabaseClient;
}): Promise<PostReportRouteResult> {
  const body = normalizeBody(await readBody());
  const reason = normalizeReason(body.reason);
  if (!reason) {
    return { ok: false, status: 400, body: { error: 'Choose a valid report reason.' } };
  }

  const details = normalizeDetails(body.details);
  const bundleId = normalizeBundleId(body.bundleId);
  const adminSupabase = createAdminSupabase();

  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...POST_REPORT_RATE_LIMIT,
      key: reporterUserId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    console.error('Post report rate limit check failed:', error);
    return { ok: false, status: 500, body: { error: 'Failed to check report submission limits.' } };
  }

  const { data: post, error: postError } = await adminSupabase
    .from('posts')
    .select('id')
    .eq('id', postId)
    .is('archived_at', null)
    .maybeSingle();

  if (postError || !post) {
    return { ok: false, status: 404, body: { error: 'Post not found.' } };
  }

  if (bundleId) {
    const { data: bundle, error: bundleError } = await adminSupabase
      .from('post_resource_bundles')
      .select('id')
      .eq('id', bundleId)
      .eq('post_id', postId)
      .maybeSingle();

    if (bundleError) {
      console.error('Failed to validate reported unlock:', bundleError);
      return { ok: false, status: 500, body: { error: 'Failed to validate unlock report.' } };
    }

    if (!bundle) {
      return { ok: false, status: 400, body: { error: 'That unlock does not belong to this post.' } };
    }
  }

  const { error } = await adminSupabase.from('post_reports').insert({
    post_id: postId,
    bundle_id: bundleId,
    reporter_user_id: reporterUserId,
    reason,
    details,
  });

  if (error) {
    console.error('Failed to create post report:', error);
    return { ok: false, status: 500, body: { error: 'Failed to submit report.' } };
  }

  return { ok: true, body: { success: true } };
}
