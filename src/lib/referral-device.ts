import 'server-only';

import { createHash } from 'node:crypto';

import type { NextResponse } from 'next/server';

import {
  FEED_ANONYMOUS_COOKIE_MAX_AGE_SECONDS,
  FEED_ANONYMOUS_COOKIE_NAME,
  FEED_INSTALLATION_ID_HEADER,
  createFeedInstallationId,
  isSameSiteBrowserFetch,
  isValidFeedInstallationId,
} from '@/lib/showcase-feed-identity';

/**
 * The device a referral request came from, as the abuse guard reads it.
 *
 * Invite & Earn pays when a friend tops up, so the way to abuse it is to be
 * your own friend: a second account opened through your own link. Two accounts
 * of one person usually share a device, and both clients already carry an id
 * for theirs: the app's installation id (`ugc-mobile/lib/feed-installation-id.ts`,
 * sent as a header or, on a visit, in the body) and the browser's first-party
 * feed cookie. Neither is new; this module only reads them for a second purpose
 * and hands the guard a digest.
 *
 * The digest takes no secret. The id is 256 random bits, so nothing can be
 * guessed back from it, and `referral_device_hash()` in the database computes
 * the same value to compare a visit with the installations `onboarding_events`
 * holds for an account (20261109213008). `referral-device.test.ts` and
 * `referral_abuse_guard.test.sql` pin both sides to one vector.
 */
const REFERRAL_DEVICE_HASH_PREFIX = 'magicbooklet-referral-device-v1:';

export type ReferralDevice = {
  /** The digest the guard stores, or null when the request names no device. */
  deviceHash: string | null;
  /** A feed id minted for this browser, to be set on the response. */
  cookieValueToSet: string | null;
};

export function hashReferralDevice(installationId: string): string {
  return createHash('sha256')
    .update(`${REFERRAL_DEVICE_HASH_PREFIX}${installationId}`)
    .digest('hex');
}

function readCookie(request: Request, name: string): string | null {
  for (const pair of (request.headers.get('cookie') ?? '').split(';')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex < 0) continue;
    if (pair.slice(0, separatorIndex).trim() !== name) continue;
    try {
      return decodeURIComponent(pair.slice(separatorIndex + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Reads the request's device: the app's installation id when it sent one, else
 * the browser's feed cookie. A browser that has no cookie yet is given one, but
 * only on a fetch from a page of this site: a caller that keeps no cookies (a
 * script, a crawler, an app build that sends no id) would otherwise look like a
 * new device on every request.
 */
export function resolveReferralDevice(
  request: Request,
  options: { bodyInstallationId?: unknown } = {},
): ReferralDevice {
  const headerId = request.headers.get(FEED_INSTALLATION_ID_HEADER);
  if (isValidFeedInstallationId(headerId)) {
    return { deviceHash: hashReferralDevice(headerId), cookieValueToSet: null };
  }

  const bodyId = typeof options.bodyInstallationId === 'string' ? options.bodyInstallationId : null;
  if (isValidFeedInstallationId(bodyId)) {
    return { deviceHash: hashReferralDevice(bodyId), cookieValueToSet: null };
  }

  const cookieId = readCookie(request, FEED_ANONYMOUS_COOKIE_NAME);
  if (isValidFeedInstallationId(cookieId)) {
    return { deviceHash: hashReferralDevice(cookieId), cookieValueToSet: null };
  }

  if (!isSameSiteBrowserFetch(request)) {
    return { deviceHash: null, cookieValueToSet: null };
  }

  const generatedId = createFeedInstallationId();
  return { deviceHash: hashReferralDevice(generatedId), cookieValueToSet: generatedId };
}

/** Sets the feed cookie exactly as the feed route does, when one was minted. */
export function applyReferralDeviceCookie(response: NextResponse, device: ReferralDevice): void {
  if (!device.cookieValueToSet) return;
  response.cookies.set({
    name: FEED_ANONYMOUS_COOKIE_NAME,
    value: device.cookieValueToSet,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: FEED_ANONYMOUS_COOKIE_MAX_AGE_SECONDS,
  });
}
