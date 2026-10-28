import 'server-only';

import { createHmac } from 'node:crypto';

import { CREATOR_WELCOME_PARAM, isCreatorPath } from '@/lib/auth-onboarding';
import { REFERRAL_CLAIM_REASON_PATTERN, REFERRAL_CLAIM_STATUS_PARAM } from '@/lib/referral-claim-copy';
import { logBackendWarning } from '@/lib/backend-logger';
import { getClientNetworkKey } from '@/lib/client-network-key';

export const REFERRAL_VISIT_COOKIE_NAME = 'mb_referral_visit';
export const REFERRAL_VISIT_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const DEFAULT_REFERRAL_DESTINATION = '/login?mode=signup&next=%2Fcreate';

const REFERRAL_CODE_PATTERN = /^[a-z0-9]{8,24}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_TOP_LEVEL_PATHS = new Set([
  '',
  'ai-image-generator',
  'ai-motion-transfer',
  'ai-video-generator',
  'ai-workflow-builder',
  'blog',
  'contact',
  'create',
  'create-image',
  'create-motion',
  'create-video',
  'create-workflow',
  'creations',
  'creators',
  'invite',
  'login',
  'marketplace',
  'post',
  'pricing',
  'privacy',
  'profile',
  'showcase',
  'templates',
  'terms',
]);

export function normalizeReferralCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return REFERRAL_CODE_PATTERN.test(normalized) ? normalized : null;
}

export function normalizeReferralVisitToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return UUID_PATTERN.test(normalized) ? normalized.toLowerCase() : null;
}

export function getSafeReferralDestination(
  value: unknown,
  fallback = DEFAULT_REFERRAL_DESTINATION,
): string {
  if (typeof value !== 'string' || value.length > 2048) return fallback;
  const normalized = value.trim();
  if (!normalized.startsWith('/') || normalized.startsWith('//') || normalized.includes('\\')) {
    return fallback;
  }

  try {
    const parsed = new URL(normalized, 'https://magicbooklet.local');
    if (parsed.origin !== 'https://magicbooklet.local') return fallback;

    const topLevel = parsed.pathname.split('/')[1] ?? '';
    if (!SAFE_TOP_LEVEL_PATHS.has(topLevel)) return fallback;

    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return fallback;
  }
}

export function getReferralSiteOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost')) {
        return url.origin;
      }
    } catch {
      // Use the production origin fallback.
    }
  }

  return 'https://magicbooklet.com';
}

export function buildReferralShareUrl(code: string, destination?: unknown): string {
  const normalizedCode = normalizeReferralCode(code);
  if (!normalizedCode) throw new Error('Invalid referral code');

  const url = new URL(`/r/${normalizedCode}`, getReferralSiteOrigin());
  if (destination !== undefined && destination !== null && destination !== '') {
    url.searchParams.set('next', getSafeReferralDestination(destination, '/create'));
  }
  return url.toString();
}

export function readReferralVisitCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName !== REFERRAL_VISIT_COOKIE_NAME) continue;
    try {
      return normalizeReferralVisitToken(decodeURIComponent(rawValue.join('=')));
    } catch {
      return null;
    }
  }

  return null;
}

// The query parameter and the shape of a claim status live with the copy that reads them on
// the client (the welcome-reward page and the creators' welcome card).
export { REFERRAL_CLAIM_STATUS_PARAM };

const REFERRAL_PATH_BASE = 'https://magicbooklet.local';
const WELCOME_REWARD_PATH = '/welcome-reward';
const PROFILE_SETUP_PATH = '/profile';

/**
 * What a post-auth redirect tells the new account about the invite it opened:
 * "applied", or the reason `claim_referral_visit` refused it
 * (`existing_account`, `self_referral`, `already_attributed`,
 * `visit_unavailable`). Null while the claim has not concluded: a profile that
 * is not there yet keeps the cookie for the next sign-in, so there is nothing
 * to say.
 */
export function referralClaimStatus(outcome: {
  claimed: boolean;
  clearCookie: boolean;
  reason?: string;
}): string | null {
  if (outcome.claimed) return 'applied';
  if (!outcome.clearCookie) return null;
  return outcome.reason && REFERRAL_CLAIM_REASON_PATTERN.test(outcome.reason)
    ? outcome.reason
    : 'not_applied';
}

/**
 * Puts the claim status on the page a post-auth destination leads to that
 * greets a new account: the welcome-reward page, usually the `next` of
 * `/profile` since a new account sets up its profile first, or a creator a
 * sign-up came back to (its welcome card). Any other destination drops the
 * status rather than carry it somewhere that cannot show it.
 */
export function withReferralClaimStatus(destination: string, status: string | null): string {
  if (!status) return destination;

  try {
    const url = new URL(destination, REFERRAL_PATH_BASE);
    if (url.origin !== REFERRAL_PATH_BASE) return destination;
    if (
      url.pathname === WELCOME_REWARD_PATH
      || (isCreatorPath(url.pathname) && url.searchParams.get(CREATOR_WELCOME_PARAM) === '1')
    ) {
      url.searchParams.set(REFERRAL_CLAIM_STATUS_PARAM, status);
      return `${url.pathname}${url.search}${url.hash}`;
    }
    if (url.pathname !== PROFILE_SETUP_PATH) return destination;

    const nested = url.searchParams.get('next');
    if (!nested || !nested.startsWith('/') || nested.startsWith('//')) return destination;
    const nestedUrl = new URL(nested, REFERRAL_PATH_BASE);
    if (nestedUrl.origin !== REFERRAL_PATH_BASE || nestedUrl.pathname !== WELCOME_REWARD_PATH) {
      return destination;
    }
    nestedUrl.searchParams.set(REFERRAL_CLAIM_STATUS_PARAM, status);
    url.searchParams.set('next', `${nestedUrl.pathname}${nestedUrl.search}`);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return destination;
  }
}

let hasWarnedAboutAttributionSecretFallback = false;

/**
 * Domain separator for the fallback subkey derivation. Fixed and versioned so
 * the derived secret is stable across restarts; bumping the suffix deliberately
 * rotates every referral risk digest.
 */
const ATTRIBUTION_HASH_SUBKEY_LABEL = 'magicbooklet/referral-attribution-hash/v1';

function getAttributionHashSecret(): string {
  const dedicatedSecret = process.env.REFERRAL_ATTRIBUTION_HASH_SECRET?.trim();
  if (dedicatedSecret) return dedicatedSecret;

  const fallbackRootKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (fallbackRootKey) {
    if (!hasWarnedAboutAttributionSecretFallback) {
      hasWarnedAboutAttributionSecretFallback = true;
      logBackendWarning('referral_attribution_hash_secret_fallback', {
        message: 'REFERRAL_ATTRIBUTION_HASH_SECRET is not set; falling back to a key derived from SUPABASE_SERVICE_ROLE_KEY for referral risk hashing. Configure the dedicated secret.',
      });
    }
    // Derive a dedicated subkey rather than handing the service-role key itself
    // to the hashing path. The key that bypasses every RLS policy should not
    // also be the value this module holds, passes around, and could surface in
    // a stack frame or diagnostic. HMAC-SHA256 is a PRF, so the service-role
    // key is not recoverable from the derived subkey.
    //
    // Note: this changes digests relative to the previous raw-key fallback. It
    // only matters if production is actually on the fallback -- if the
    // dedicated secret is configured, nothing changes. In the fallback case,
    // stored ipHash/userAgentHash values rotate once, so referral fraud history
    // restarts; rate-limit buckets simply re-fill.
    return createHmac('sha256', fallbackRootKey)
      .update(ATTRIBUTION_HASH_SUBKEY_LABEL)
      .digest('hex');
  }

  if (process.env.NODE_ENV !== 'production') return 'local-referral-attribution-secret';
  throw new Error('REFERRAL_ATTRIBUTION_HASH_SECRET is not configured');
}

export function hashReferralRiskSignal(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return createHmac('sha256', getAttributionHashSecret()).update(normalized).digest('hex');
}

export function getReferralClientIp(headers: Headers): string {
  return getClientNetworkKey(headers);
}

export function getReferralRiskContext(headers: Headers) {
  const ip = getReferralClientIp(headers);
  return {
    rateLimitKey: hashReferralRiskSignal(`rate:${ip}`) ?? 'unknown',
    ipHash: hashReferralRiskSignal(`ip:${ip}`),
    userAgentHash: hashReferralRiskSignal(`ua:${headers.get('user-agent') ?? ''}`),
  };
}

export function getReferralStoreUrls() {
  return {
    appStore: process.env.NEXT_PUBLIC_APP_STORE_URL?.trim() || null,
    playStore: process.env.NEXT_PUBLIC_PLAY_STORE_URL?.trim() || null,
  };
}
