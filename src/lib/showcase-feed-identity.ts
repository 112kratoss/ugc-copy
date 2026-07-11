import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

export const FEED_ANONYMOUS_COOKIE_NAME = '__Host-magicbooklet-feed-id';
export const FEED_INSTALLATION_ID_HEADER = 'x-magicbooklet-installation-id';
export const FEED_ANONYMOUS_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

const FEED_ID_PATTERN = /^fid_[a-f0-9]{64}$/;

export type FeedAnonymousIdentitySource = 'web-cookie' | 'mobile-installation' | 'network-fallback';

export type FeedAnonymousIdentity = {
  anonymousKeyHash: string;
  cookieValueToSet: string | null;
  source: FeedAnonymousIdentitySource;
};

function getFeedIdentitySalt() {
  const salt = process.env.FEED_ANALYTICS_SALT || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (salt) return salt;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('FEED_ANALYTICS_SALT is required for anonymous feed identity hashing.');
  }
  return 'local-feed-identity-only';
}

function hashFeedIdentity(namespace: string, value: string) {
  return createHash('sha256')
    .update(`${getFeedIdentitySalt()}:${namespace}:${value}`)
    .digest('hex');
}

function readCookie(request: Request, name: string) {
  for (const pair of (request.headers.get('cookie') ?? '').split(';')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex < 0) continue;
    const key = pair.slice(0, separatorIndex).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(pair.slice(separatorIndex + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function getNetworkAddress(request: Request) {
  const vercelForwardedFor = request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim();
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = request.headers.get('x-real-ip')?.trim();
  return (vercelForwardedFor || forwardedFor || realIp || 'unknown').slice(0, 128);
}

export function isValidFeedInstallationId(value: string | null | undefined): value is string {
  return typeof value === 'string' && FEED_ID_PATTERN.test(value);
}

export function createFeedInstallationId() {
  return `fid_${randomBytes(32).toString('hex')}`;
}

export function getFeedNetworkKeyHash(request: Request) {
  return hashFeedIdentity('network', getNetworkAddress(request));
}

export function resolveFeedAnonymousIdentity(request: Request): FeedAnonymousIdentity {
  const suppliedInstallationId = request.headers.get(FEED_INSTALLATION_ID_HEADER);
  if (suppliedInstallationId !== null) {
    if (isValidFeedInstallationId(suppliedInstallationId)) {
      return {
        anonymousKeyHash: hashFeedIdentity('installation', suppliedInstallationId),
        cookieValueToSet: null,
        source: 'mobile-installation',
      };
    }

    return {
      anonymousKeyHash: getFeedNetworkKeyHash(request),
      cookieValueToSet: null,
      source: 'network-fallback',
    };
  }

  const cookieId = readCookie(request, FEED_ANONYMOUS_COOKIE_NAME);
  if (isValidFeedInstallationId(cookieId)) {
    return {
      anonymousKeyHash: hashFeedIdentity('cookie', cookieId),
      cookieValueToSet: null,
      source: 'web-cookie',
    };
  }

  const generatedId = createFeedInstallationId();
  return {
    anonymousKeyHash: hashFeedIdentity('cookie', generatedId),
    cookieValueToSet: generatedId,
    source: 'web-cookie',
  };
}

export function getFeedAnonymousKeyHash(request: Request) {
  return resolveFeedAnonymousIdentity(request).anonymousKeyHash;
}
