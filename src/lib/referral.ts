import 'server-only';

import { createHmac } from 'node:crypto';

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

function getAttributionHashSecret(): string {
  const secret = process.env.REFERRAL_ATTRIBUTION_HASH_SECRET?.trim()
    || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (secret) return secret;
  if (process.env.NODE_ENV !== 'production') return 'local-referral-attribution-secret';
  throw new Error('REFERRAL_ATTRIBUTION_HASH_SECRET is not configured');
}

export function hashReferralRiskSignal(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return createHmac('sha256', getAttributionHashSecret()).update(normalized).digest('hex');
}

export function getReferralClientIp(headers: Headers): string {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || headers.get('x-real-ip')?.trim()
    || '127.0.0.1';
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
