import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  REFERRAL_VISIT_COOKIE_MAX_AGE_SECONDS,
  REFERRAL_VISIT_COOKIE_NAME,
  buildReferralShareUrl,
  getReferralRiskContext,
  getSafeReferralDestination,
  hashReferralRiskSignal,
  normalizeReferralCode,
  normalizeReferralVisitToken,
  readReferralVisitCookie,
} from '@/lib/referral';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type JsonRecord = Record<string, unknown>;

export type ReferralClaimOutcome = {
  claimed: boolean;
  clearCookie: boolean;
  reason?: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function referralErrorResponse(request: Request, message: string, status: number) {
  return applyPrivateNoStoreApiResponseHeaders(
    NextResponse.json({ success: false, error: message }, { status }),
    request,
  );
}

function referralJsonResponse(request: Request, body: unknown, status = 200) {
  return applyPrivateNoStoreApiResponseHeaders(
    NextResponse.json(body, { status }),
    request,
  );
}

async function authenticatedUserId(request: Request) {
  const userClient = createUserClient(request);
  const { data: { user }, error } = await userClient.auth.getUser();
  return error || !user ? null : user.id;
}

async function readBody(request: Request): Promise<JsonRecord | null> {
  try {
    const body: unknown = await request.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

async function enforceReferralRateLimit(
  adminSupabase: SupabaseClient,
  options: { scope: string; key: string; limit: number; windowSeconds: number },
) {
  try {
    await enforceBackendRateLimit(adminSupabase, options);
    return null;
  } catch (error) {
    if (error instanceof BackendRateLimitError) return error;
    throw error;
  }
}

function rateLimitResponse(request: Request, error: BackendRateLimitError) {
  const response = referralErrorResponse(request, error.message, 429);
  response.headers.set('Retry-After', String(error.retryAfterSeconds));
  response.headers.set('X-RateLimit-Limit', String(error.state.limit));
  response.headers.set('X-RateLimit-Remaining', String(error.state.remaining));
  response.headers.set('X-RateLimit-Reset', error.state.resetAt);
  return response;
}

function normalizeDashboard(data: unknown) {
  if (!isRecord(data) || data.status !== 'ready' || !isRecord(data.offer)
      || !isRecord(data.referral) || !isRecord(data.stats)) {
    throw new Error('Referral dashboard RPC returned an invalid response');
  }

  const code = normalizeReferralCode(data.referral.code);
  const enabled = data.referral.enabled === true;
  const recent = Array.isArray(data.recentRewards) ? data.recentRewards : [];

  return {
    success: true as const,
    program: {
      inviterPercent: numberValue(data.offer.inviterRewardBps) / 100,
      inviteeFirstPurchasePercent: numberValue(data.offer.inviteeRewardBps) / 100,
      attributionWindowDays: numberValue(data.offer.attributionWindowDays),
    },
    code: enabled ? code : null,
    shareUrl: enabled && code ? buildReferralShareUrl(code) : null,
    stats: {
      visits: Math.max(0, numberValue(data.stats.visits)),
      signups: Math.max(0, numberValue(data.stats.referredUsers)),
      purchasers: Math.max(0, numberValue(data.stats.purchasers)),
      creditsEarned: Math.max(0, numberValue(data.stats.earnedCredits)),
      creditsReversed: Math.max(0, numberValue(data.stats.reversedCredits)),
    },
    recentRewards: recent.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const id = stringValue(entry.id);
      const kind = stringValue(entry.kind);
      const entryKind = stringValue(entry.entryKind);
      const createdAt = stringValue(entry.createdAt);
      if (!id || !kind || !entryKind || !createdAt) return [];

      return [{
        id,
        credits: Math.abs(numberValue(entry.creditDelta || entry.credits)),
        status: entryKind === 'reward_reversal'
          ? 'reversed'
          : entryKind === 'reward_restoration'
            ? 'restored'
            : 'granted',
        kind,
        createdAt,
      }];
    }),
  };
}

export async function getReferralOverviewResponse(request: Request) {
  const userId = await authenticatedUserId(request);
  if (!userId) return referralErrorResponse(request, 'Unauthorized', 401);

  const adminSupabase = createServiceClient();
  const { data, error } = await adminSupabase.rpc('get_referral_dashboard', {
    p_user_id: userId,
  });
  if (error) {
    console.error('Referral dashboard failed:', error);
    return referralErrorResponse(request, 'Could not load Invite & Earn.', 503);
  }

  try {
    return referralJsonResponse(request, normalizeDashboard(data));
  } catch (parseError) {
    console.error('Referral dashboard response invalid:', parseError);
    return referralErrorResponse(request, 'Could not load Invite & Earn.', 503);
  }
}

export async function createReferralLinkResponse(request: Request) {
  const userId = await authenticatedUserId(request);
  if (!userId) return referralErrorResponse(request, 'Unauthorized', 401);

  const body = await readBody(request);
  if (!body) return referralErrorResponse(request, 'Invalid referral link request.', 400);

  const adminSupabase = createServiceClient();
  const rateLimit = await enforceReferralRateLimit(adminSupabase, {
    scope: 'referral-link:create',
    key: userId,
    limit: 30,
    windowSeconds: 10 * 60,
  });
  if (rateLimit) return rateLimitResponse(request, rateLimit);

  const { data, error } = await adminSupabase.rpc('ensure_referral_code', {
    p_user_id: userId,
  });
  const code = isRecord(data) ? normalizeReferralCode(data.code) : null;
  if (error || !code || data?.enabled !== true) {
    console.error('Referral code creation failed:', error);
    return referralErrorResponse(request, 'Your referral link is unavailable.', 503);
  }

  return referralJsonResponse(request, {
    success: true,
    code,
    shareUrl: buildReferralShareUrl(code, body.next),
  });
}

export async function recordReferralVisitResponse(request: Request) {
  const body = await readBody(request);
  if (!body) return referralErrorResponse(request, 'Invalid referral visit request.', 400);

  const code = normalizeReferralCode(body.code);
  const source = body.source === 'mobile' ? 'native' : body.source === 'web' ? 'web' : null;
  if (!code || !source) return referralErrorResponse(request, 'Invalid referral code.', 400);

  const risk = getReferralRiskContext(request.headers);
  const adminSupabase = createServiceClient();
  const rateLimit = await enforceReferralRateLimit(adminSupabase, {
    scope: 'referral-visit:create',
    key: risk.rateLimitKey,
    limit: 60,
    windowSeconds: 10 * 60,
  });
  if (rateLimit) return rateLimitResponse(request, rateLimit);

  const existingToken = normalizeReferralVisitToken(body.visitToken)
    || readReferralVisitCookie(request.headers.get('cookie'));
  const destination = getSafeReferralDestination(body.next, '/create');
  const installationId = stringValue(body.installationId)?.slice(0, 200) ?? '';
  const userAgentHash = installationId
    ? hashReferralRiskSignal(`ua:${request.headers.get('user-agent') ?? ''}|install:${installationId}`)
    : risk.userAgentHash;
  const { data, error } = await adminSupabase.rpc('create_referral_visit', {
    p_code: code,
    p_channel: source,
    p_destination_path: destination,
    p_existing_visit_token: existingToken,
    p_ip_hash: risk.ipHash,
    p_user_agent_hash: userAgentHash,
  });

  if (error || !isRecord(data)) {
    console.error('Referral visit creation failed:', error);
    return referralErrorResponse(request, 'Could not save this invite.', 503);
  }

  const status = stringValue(data.status);
  if (status === 'invalid_code') return referralErrorResponse(request, 'Referral code not found.', 404);
  if (status === 'program_unavailable') return referralErrorResponse(request, 'Invite & Earn is unavailable.', 503);
  if (status !== 'created' && status !== 'preserved') {
    return referralErrorResponse(request, 'Invalid referral visit request.', 400);
  }

  const visitToken = normalizeReferralVisitToken(data.visit_token);
  const expiresAt = stringValue(data.expires_at);
  const responseCode = normalizeReferralCode(data.code) || code;
  if (!visitToken || !expiresAt) {
    return referralErrorResponse(request, 'Could not save this invite.', 503);
  }

  const response = referralJsonResponse(request, {
    success: true,
    visitToken,
    code: responseCode,
    expiresAt,
  });
  if (source === 'web') {
    response.cookies.set({
      name: REFERRAL_VISIT_COOKIE_NAME,
      value: visitToken,
      httpOnly: true,
      sameSite: 'lax',
      secure: new URL(request.url).protocol === 'https:',
      path: '/',
      maxAge: REFERRAL_VISIT_COOKIE_MAX_AGE_SECONDS,
    });
  }
  return response;
}

export async function claimReferralForUser({
  adminSupabase,
  userId,
  visitToken,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  visitToken: string;
}): Promise<ReferralClaimOutcome> {
  const { data, error } = await adminSupabase.rpc('claim_referral_visit', {
    p_invitee_user_id: userId,
    p_visit_token: visitToken,
  });
  if (error || !isRecord(data) || typeof data.status !== 'string') {
    throw error || new Error('Referral claim RPC returned an invalid response');
  }

  if (data.status === 'claimed') return { claimed: true, clearCookie: true };
  if (data.status === 'profile_not_found') return { claimed: false, clearCookie: false, reason: data.status };
  return { claimed: false, clearCookie: true, reason: data.status };
}

export function clearReferralVisitCookie(response: NextResponse, secure = true) {
  response.cookies.set({
    name: REFERRAL_VISIT_COOKIE_NAME,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: 0,
  });
}

export async function finalizePendingReferralForAuth(request: Request, userId: string) {
  const visitToken = readReferralVisitCookie(request.headers.get('cookie'));
  if (!visitToken) return false;

  try {
    const outcome = await claimReferralForUser({
      adminSupabase: createServiceClient(),
      userId,
      visitToken,
    });
    return outcome.clearCookie;
  } catch (error) {
    // Authentication and onboarding must remain available if referral
    // attribution is temporarily unavailable. The cookie remains for retry.
    console.error('Post-auth referral finalization deferred:', error);
    return false;
  }
}

export async function claimReferralResponse(request: Request) {
  const userId = await authenticatedUserId(request);
  if (!userId) return referralErrorResponse(request, 'Unauthorized', 401);

  const body = await readBody(request);
  if (!body) return referralErrorResponse(request, 'Invalid referral claim request.', 400);
  const visitToken = normalizeReferralVisitToken(body.visitToken)
    || readReferralVisitCookie(request.headers.get('cookie'));
  if (!visitToken) {
    return referralErrorResponse(request, 'Open a referral link before creating your account.', 400);
  }

  const adminSupabase = createServiceClient();
  const rateLimit = await enforceReferralRateLimit(adminSupabase, {
    scope: 'referral-claim:create',
    key: userId,
    limit: 20,
    windowSeconds: 10 * 60,
  });
  if (rateLimit) return rateLimitResponse(request, rateLimit);

  try {
    const outcome = await claimReferralForUser({ adminSupabase, userId, visitToken });
    const response = referralJsonResponse(request, {
      success: true,
      claimed: outcome.claimed,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    });
    if (outcome.clearCookie) {
      clearReferralVisitCookie(response, new URL(request.url).protocol === 'https:');
    }
    return response;
  } catch (error) {
    console.error('Referral claim failed:', error);
    return referralErrorResponse(request, 'Could not apply this invite yet.', 503);
  }
}
