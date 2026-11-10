import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { loadAccountIdentityFingerprints } from '@/lib/account-identity-fingerprint';
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
  getReferralSiteOrigin,
  getSafeReferralDestination,
  hashReferralRiskSignal,
  normalizeReferralCode,
  normalizeReferralVisitToken,
  readReferralVisitCookie,
} from '@/lib/referral';
import {
  applyReferralDeviceCookie,
  resolveReferralDevice,
  type ReferralDevice,
} from '@/lib/referral-device';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type JsonRecord = Record<string, unknown>;

export type ReferralClaimOutcome = {
  claimed: boolean;
  clearCookie: boolean;
  reason?: string;
};

/** The program's terms as both clients print them: percents and days. */
export type ReferralProgramTerms = {
  inviterPercent: number;
  inviteeFirstPurchasePercent: number;
  attributionWindowDays: number;
};

const REFERRAL_PROGRAM_TERMS_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedReferralProgramTerms: { expiresAt: number; terms: ReferralProgramTerms | null } | null = null;
let pendingReferralProgramTerms: Promise<ReferralProgramTerms | null> | null = null;

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

// The program stores basis points; both clients print a percent.
function referralProgramTerms(offer: JsonRecord): ReferralProgramTerms {
  return {
    inviterPercent: numberValue(offer.inviterRewardBps) / 100,
    inviteeFirstPurchasePercent: numberValue(offer.inviteeRewardBps) / 100,
    attributionWindowDays: numberValue(offer.attributionWindowDays),
  };
}

async function readActiveReferralProgramTerms(): Promise<ReferralProgramTerms | null> {
  // get_referral_dashboard answers only for a profile, so this reads the row it
  // and create_referral_visit pick: the active program with the highest
  // version, the one a visit made now binds to.
  const { data, error } = await createServiceClient()
    .from('referral_programs')
    .select('inviter_reward_bps, invitee_reward_bps, attribution_window_days')
    .eq('status', 'active')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!isRecord(data)) return null;
  return referralProgramTerms({
    inviterRewardBps: data.inviter_reward_bps,
    inviteeRewardBps: data.invitee_reward_bps,
    attributionWindowDays: data.attribution_window_days,
  });
}

/**
 * The terms `/api/referrals/me` carries as `program`, for surfaces that show them
 * to someone without an account: the referral landing (on the visit answer) and
 * the pricing banner. `null` while no program is active or when the terms cannot
 * be read, and the surface then leaves the numbers out. Cached for five minutes
 * per server instance; a failed read is not cached.
 */
export async function loadReferralProgramTerms(): Promise<ReferralProgramTerms | null> {
  if (cachedReferralProgramTerms && cachedReferralProgramTerms.expiresAt > Date.now()) {
    return cachedReferralProgramTerms.terms;
  }
  if (!pendingReferralProgramTerms) {
    pendingReferralProgramTerms = readActiveReferralProgramTerms()
      .then((terms) => {
        cachedReferralProgramTerms = { expiresAt: Date.now() + REFERRAL_PROGRAM_TERMS_CACHE_TTL_MS, terms };
        return terms;
      })
      .catch((error: unknown) => {
        logBackendError('referral_program_terms_unavailable', { error });
        return null;
      })
      .finally(() => {
        pendingReferralProgramTerms = null;
      });
  }
  return pendingReferralProgramTerms;
}

/** Test seam: the cache lives as long as the process, so a test must be able to start clean. */
export function resetReferralProgramTermsCacheForTests(): void {
  cachedReferralProgramTerms = null;
  pendingReferralProgramTerms = null;
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
  const { data: { user }, error } = await getVerifiedAuthUserResult(userClient);
  // Registered-only. A referral reward is for signing up, so crediting one to a
  // guest identity would burn the invite on an account that does not exist yet.
  return error || !user || isGuestUser(user) ? null : user.id;
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

/**
 * Whether a browser sent this request from a page of another site.
 *
 * A visit sets a 30-day cookie that credits whoever signs up in that browser
 * to an inviter, so another site must not be able to plant one: a form posted
 * from elsewhere needs no CORS grant and reached this route until now. A
 * browser names where a request came from (`Sec-Fetch-Site`, and `Origin` on
 * the ones that predate it); the app sends neither and is let through.
 */
function isCrossSiteBrowserRequest(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'cross-site';

  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    const requestOrigin = new URL(origin).origin;
    return requestOrigin !== new URL(request.url).origin
      && requestOrigin !== getReferralSiteOrigin();
  } catch {
    return true;
  }
}

/**
 * Remembers the device an account used Invite & Earn from, for the abuse guard
 * (`claim_referral_visit` compares a new friend's device with these). It never
 * fails or delays the request it rides on: a device that was not recorded only
 * leaves the guard with what it knew before.
 */
async function recordReferralAccountDevice(
  adminSupabase: SupabaseClient,
  request: Request,
  userId: string,
  device: ReferralDevice,
): Promise<void> {
  if (!device.deviceHash) return;
  try {
    const { error } = await adminSupabase.rpc('record_referral_account_device', {
      p_user_id: userId,
      p_device_hash: device.deviceHash,
      p_ip_hash: getReferralRiskContext(request.headers).ipHash,
    });
    if (error) throw error;
  } catch (error) {
    logBackendError('referral_account_device_not_recorded', { error });
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
    program: referralProgramTerms(data.offer),
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
  const device = resolveReferralDevice(request);
  const [{ data, error }] = await Promise.all([
    adminSupabase.rpc('get_referral_dashboard', { p_user_id: userId }),
    recordReferralAccountDevice(adminSupabase, request, userId, device),
  ]);
  if (error) {
    logBackendError('referral_dashboard_failed', { error: error });
    return referralErrorResponse(request, 'Could not load Invite & Earn.', 503);
  }

  try {
    const response = referralJsonResponse(request, normalizeDashboard(data));
    applyReferralDeviceCookie(response, device);
    return response;
  } catch (parseError) {
    logBackendError('referral_dashboard_response_invalid', { error: parseError });
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

  const device = resolveReferralDevice(request);
  const [{ data, error }] = await Promise.all([
    adminSupabase.rpc('ensure_referral_code', { p_user_id: userId }),
    recordReferralAccountDevice(adminSupabase, request, userId, device),
  ]);
  const code = isRecord(data) ? normalizeReferralCode(data.code) : null;
  if (error || !code || data?.enabled !== true) {
    logBackendError('referral_code_creation_failed', { error: error });
    return referralErrorResponse(request, 'Your referral link is unavailable.', 503);
  }

  const response = referralJsonResponse(request, {
    success: true,
    code,
    shareUrl: buildReferralShareUrl(code, body.next),
  });
  applyReferralDeviceCookie(response, device);
  return response;
}

export async function recordReferralVisitResponse(request: Request) {
  if (isCrossSiteBrowserRequest(request)) {
    return referralErrorResponse(request, 'Open this invite on Magicbooklet.', 403);
  }

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
  // The device that opened the link: what the abuse guard compares with its
  // inviter's devices when the visit is claimed.
  const device = resolveReferralDevice(request, { bodyInstallationId: body.installationId });
  const { data, error } = await adminSupabase.rpc('create_referral_visit', {
    p_code: code,
    p_channel: source,
    p_destination_path: destination,
    p_existing_visit_token: existingToken,
    p_ip_hash: risk.ipHash,
    p_user_agent_hash: userAgentHash,
    p_device_hash: device.deviceHash,
  });

  if (error || !isRecord(data)) {
    logBackendError('referral_visit_creation_failed', { error: error });
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
    // The landing pages read the offer from here rather than printing their own
    // numbers (03-7).
    program: await loadReferralProgramTerms(),
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
  applyReferralDeviceCookie(response, device);
  return response;
}

/**
 * The claiming account's identity digests, for the re-registration guard in
 * `claim_referral_visit`. Null when they cannot be read: the claim then runs
 * without that one guard rather than not at all, because an invite that fails
 * to apply costs a real friend their bonus and the guard only stops an account
 * deleted and opened again.
 */
async function loadClaimIdentityFingerprints(
  adminSupabase: SupabaseClient,
  userId: string,
): Promise<string[] | null> {
  try {
    return await loadAccountIdentityFingerprints(adminSupabase, userId);
  } catch (error) {
    logBackendError('referral_claim_identity_fingerprints_unavailable', { error });
    return null;
  }
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
    p_identity_fingerprints: await loadClaimIdentityFingerprints(adminSupabase, userId),
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
    logBackendError('referral_claim_failed', { error: error });
    return referralErrorResponse(request, 'Could not apply this invite yet.', 503);
  }
}
