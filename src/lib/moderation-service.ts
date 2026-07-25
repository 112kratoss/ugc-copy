import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  MODERATION_REPORT_RATE_LIMIT,
  USER_BLOCK_MUTATION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';

const USER_REPORT_REASONS = new Set([
  'spam',
  'harassment',
  'impersonation',
  'unsafe_content',
  'other',
]);
const GENERATION_REPORT_REASONS = new Set([
  'offensive_ai_output',
  'unsafe_content',
  'other',
]);
const REPORT_SOURCE_SURFACES = new Set([
  'showcase',
  'showcase-reel',
  'creator-profile',
  'generation-viewer',
]);

export type ModerationReportTargetType = 'user' | 'generation';

type ModerationReportBody = {
  targetType?: unknown;
  targetId?: unknown;
  reason?: unknown;
  details?: unknown;
  sourceSurface?: unknown;
};

export type ModerationRouteResult =
  | {
      ok: true;
      body: { success: true; blocked?: boolean };
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function normalizeUuid(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

function normalizeDetails(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 1000) : null;
}

function normalizeReportBody(value: unknown): ModerationReportBody {
  return asRecord(value) as ModerationReportBody;
}

function rateLimitResult(error: BackendRateLimitError): ModerationRouteResult {
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

async function enforceModerationRateLimit(
  adminSupabase: SupabaseClient,
  options: typeof MODERATION_REPORT_RATE_LIMIT | typeof USER_BLOCK_MUTATION_RATE_LIMIT,
  userId: string,
) {
  try {
    await enforceBackendRateLimit(adminSupabase, { ...options, key: userId });
    return null;
  } catch (error) {
    if (error instanceof BackendRateLimitError) return rateLimitResult(error);
    logBackendError('moderation_rate_limit_check_failed', { error: error });
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to check moderation limits.' },
    } satisfies ModerationRouteResult;
  }
}

export async function submitModerationReportForRoute({
  adminSupabase,
  body: rawBody,
  reporterUserId,
}: {
  adminSupabase: SupabaseClient;
  body: unknown;
  reporterUserId: string;
}): Promise<ModerationRouteResult> {
  const body = normalizeReportBody(rawBody);
  const targetType = body.targetType === 'user' || body.targetType === 'generation'
    ? body.targetType
    : null;
  const targetId = normalizeUuid(body.targetId);
  const sourceSurface = typeof body.sourceSurface === 'string' && REPORT_SOURCE_SURFACES.has(body.sourceSurface)
    ? body.sourceSurface
    : null;
  const allowedReasons = targetType === 'user' ? USER_REPORT_REASONS : GENERATION_REPORT_REASONS;
  const reason = typeof body.reason === 'string' && allowedReasons.has(body.reason)
    ? body.reason
    : null;

  if (!targetType || !targetId || !reason || !sourceSurface) {
    return { ok: false, status: 400, body: { error: 'Choose a valid report target and reason.' } };
  }
  if (targetType === 'user' && targetId === reporterUserId) {
    return { ok: false, status: 400, body: { error: 'You cannot report your own profile.' } };
  }

  const rateLimited = await enforceModerationRateLimit(
    adminSupabase,
    MODERATION_REPORT_RATE_LIMIT,
    reporterUserId,
  );
  if (rateLimited) return rateLimited;

  if (targetType === 'user') {
    const { data, error } = await adminSupabase
      .from('profiles')
      .select('id')
      .eq('id', targetId)
      .maybeSingle();
    if (error) {
      logBackendError('failed_to_validate_reported_user', { error: error });
      return { ok: false, status: 500, body: { error: 'Failed to validate reported user.' } };
    }
    if (!data) return { ok: false, status: 404, body: { error: 'Creator not found.' } };
  } else {
    const { data, error } = await adminSupabase
      .from('generations')
      .select('id, user_id')
      .eq('id', targetId)
      .eq('user_id', reporterUserId)
      .maybeSingle();
    if (error) {
      logBackendError('failed_to_validate_reported_generation', { error: error });
      return { ok: false, status: 500, body: { error: 'Failed to validate reported generation.' } };
    }
    if (!data) return { ok: false, status: 404, body: { error: 'Generation not found.' } };
  }

  const { error } = await adminSupabase.from('moderation_reports').insert({
    reporter_user_id: reporterUserId,
    target_type: targetType,
    reported_user_id: targetType === 'user' ? targetId : null,
    generation_id: targetType === 'generation' ? targetId : null,
    reason,
    details: normalizeDetails(body.details),
    source_surface: sourceSurface,
  });
  if (error) {
    logBackendError('failed_to_create_moderation_report', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to submit report.' } };
  }

  return { ok: true, body: { success: true } };
}

export async function setUserBlockForRoute({
  actorUserId,
  adminSupabase,
  blockedUserId: rawBlockedUserId,
  shouldBlock,
  invalidateFeedCache = invalidateShowcaseFeedCache,
}: {
  actorUserId: string;
  adminSupabase: SupabaseClient;
  blockedUserId: string;
  shouldBlock: boolean;
  invalidateFeedCache?: typeof invalidateShowcaseFeedCache;
}): Promise<ModerationRouteResult> {
  const blockedUserId = normalizeUuid(rawBlockedUserId);
  if (!blockedUserId || blockedUserId === actorUserId) {
    return { ok: false, status: 400, body: { error: 'Choose a valid user to block.' } };
  }

  const rateLimited = await enforceModerationRateLimit(
    adminSupabase,
    USER_BLOCK_MUTATION_RATE_LIMIT,
    actorUserId,
  );
  if (rateLimited) return rateLimited;

  const { data: targetProfile, error: targetError } = await adminSupabase
    .from('profiles')
    .select('id')
    .eq('id', blockedUserId)
    .maybeSingle();
  if (targetError) {
    logBackendError('failed_to_validate_blocked_user', { error: targetError });
    return { ok: false, status: 500, body: { error: 'Failed to validate user block.' } };
  }
  if (!targetProfile) return { ok: false, status: 404, body: { error: 'Creator not found.' } };

  if (shouldBlock) {
    const { error } = await adminSupabase.from('user_blocks').upsert({
      blocker_user_id: actorUserId,
      blocked_user_id: blockedUserId,
    }, { onConflict: 'blocker_user_id,blocked_user_id' });
    if (error) {
      logBackendError('failed_to_block_user', { error: error });
      return { ok: false, status: 500, body: { error: 'Failed to block user.' } };
    }

    const [outgoingFollow, incomingFollow] = await Promise.all([
      adminSupabase
        .from('follows')
        .delete()
        .eq('follower_id', actorUserId)
        .eq('following_id', blockedUserId),
      adminSupabase
        .from('follows')
        .delete()
        .eq('follower_id', blockedUserId)
        .eq('following_id', actorUserId),
    ]);
    if (outgoingFollow.error || incomingFollow.error) {
      logBackendError('user_was_blocked_but_follow_cleanup_failed', { error: outgoingFollow.error ?? incomingFollow.error });
    }
  } else {
    const { error } = await adminSupabase
      .from('user_blocks')
      .delete()
      .eq('blocker_user_id', actorUserId)
      .eq('blocked_user_id', blockedUserId);
    if (error) {
      logBackendError('failed_to_unblock_user', { error: error });
      return { ok: false, status: 500, body: { error: 'Failed to unblock user.' } };
    }
  }

  invalidateFeedCache();
  return { ok: true, body: { success: true, blocked: shouldBlock } };
}

export async function loadBlockedCreatorIds({
  adminSupabase,
  creatorIds,
  viewerUserId,
}: {
  adminSupabase: SupabaseClient;
  creatorIds: string[];
  viewerUserId: string;
}): Promise<Set<string>> {
  const uniqueCreatorIds = Array.from(new Set(creatorIds.filter((id) => id && id !== viewerUserId)));
  if (!uniqueCreatorIds.length) return new Set();

  const [viewerBlocks, creatorBlocks] = await Promise.all([
    adminSupabase
      .from('user_blocks')
      .select('blocked_user_id')
      .eq('blocker_user_id', viewerUserId)
      .in('blocked_user_id', uniqueCreatorIds),
    adminSupabase
      .from('user_blocks')
      .select('blocker_user_id')
      .eq('blocked_user_id', viewerUserId)
      .in('blocker_user_id', uniqueCreatorIds),
  ]);
  if (viewerBlocks.error || creatorBlocks.error) {
    throw viewerBlocks.error ?? creatorBlocks.error;
  }

  return new Set([
    ...(viewerBlocks.data ?? []).map((row) => String(row.blocked_user_id)),
    ...(creatorBlocks.data ?? []).map((row) => String(row.blocker_user_id)),
  ]);
}

export async function isUserRelationshipBlocked({
  adminSupabase,
  firstUserId,
  secondUserId,
}: {
  adminSupabase: SupabaseClient;
  firstUserId: string;
  secondUserId: string;
}) {
  const blockedIds = await loadBlockedCreatorIds({
    adminSupabase,
    creatorIds: [secondUserId],
    viewerUserId: firstUserId,
  });
  return blockedIds.has(secondUserId);
}
