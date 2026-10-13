import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  POST_REPORT_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import type { RunAfterResponse } from '@/lib/deferrable-notification';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';
import {
  parseFeedDeliveryIdField,
  scheduleAuthoritativeFeedEvent,
} from '@/lib/showcase-feed-events-service';

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
  /** The feed delivery the post was reported from, when a ranked feed showed it. */
  deliveryId?: unknown;
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
  invalidateFeedCache = invalidateShowcaseFeedCache,
  runAfterResponse,
  scheduleFeedEvent = scheduleAuthoritativeFeedEvent,
}: {
  postId: string;
  reporterUserId: string;
  readBody: () => Promise<unknown>;
  createAdminSupabase: () => SupabaseClient;
  invalidateFeedCache?: typeof invalidateShowcaseFeedCache;
  /**
   * The route passes one so the report's feed event is written behind the
   * answer; without it the event is written, bounded by its timeout, first.
   */
  runAfterResponse?: RunAfterResponse;
  scheduleFeedEvent?: typeof scheduleAuthoritativeFeedEvent;
}): Promise<PostReportRouteResult> {
  const body = normalizeBody(await readBody().catch(() => null));
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

    logBackendError('post_report_rate_limit_check_failed', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to check report submission limits.' } };
  }

  const { data: post, error: postError } = await adminSupabase
    .from('posts')
    .select('id, user_id')
    .eq('id', postId)
    .is('archived_at', null)
    .maybeSingle();

  if (postError || !post) {
    return { ok: false, status: 404, body: { error: 'Post not found.' } };
  }

  // A report asks moderators to look at someone else's post or recipe. Both
  // clients leave the row out on the viewer's own post; this answers the ones
  // that still send it, as the subject-report route answers a report on your
  // own profile or comment (`moderation-service.ts`).
  if (String(post.user_id) === reporterUserId) {
    return { ok: false, status: 400, body: { error: 'You cannot report your own post.' } };
  }

  if (bundleId) {
    const { data: bundle, error: bundleError } = await adminSupabase
      .from('post_resource_bundles')
      .select('id')
      .eq('id', bundleId)
      .eq('post_id', postId)
      .maybeSingle();

    if (bundleError) {
      logBackendError('failed_to_validate_reported_unlock', { error: bundleError });
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
    logBackendError('failed_to_create_post_report', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to submit report.' } };
  }
  // Its feed event is dated by the report, not by when the event is written.
  const reportedAt = new Date().toISOString();

  // A report also takes the post out of the reporter's own feed, through the
  // same hard exclusion a "not interested" writes (`feed_user_post_feedback`,
  // read by the candidate SQL and the feed's visibility stage). The RPC is
  // service-role only. The report is already stored, so a failure here is
  // logged and never fails it: the visibility stage drops posts the viewer
  // reported straight from `post_reports` as well.
  try {
    const { error: feedbackError } = await adminSupabase.rpc('set_feed_post_feedback', {
      p_user_id: reporterUserId,
      p_post_id: postId,
      p_is_active: true,
      p_reason: 'reported',
    });
    if (feedbackError) {
      logBackendError('failed_to_hide_reported_post_from_feed', { error: feedbackError });
    }
  } catch (feedbackError) {
    logBackendError('failed_to_hide_reported_post_from_feed', { error: feedbackError });
  }

  invalidateFeedCache();

  // The report is stored and out of the reporter's feed. Its feed event is
  // v4's `report` signal. Attributed to the feed delivery the client reported
  // from, when it sent one, it stamps that delivery's `reported_at`, and the
  // ranker's refreshes count it against the post and in the reporter's
  // interests (they read a report only through its delivery). It is
  // telemetry: it never fails or holds this answer, and is written once per
  // reporter, post and delivery.
  await scheduleFeedEvent(runAfterResponse, adminSupabase, {
    eventType: 'report',
    viewerUserId: reporterUserId,
    postId,
    deliveryId: parseFeedDeliveryIdField(body.deliveryId),
    occurredAt: reportedAt,
  });

  return { ok: true, body: { success: true } };
}
