import 'server-only';

import { createHash } from 'node:crypto';

import type { NextResponse } from 'next/server';

import {
  FEED_ANONYMOUS_COOKIE_NAME,
  FEED_INSTALLATION_ID_HEADER,
  createFeedInstallationId,
  isSameSiteBrowserFetch,
  isValidFeedInstallationId,
  readRequestCookie,
  setFeedAnonymousCookie,
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
 * holds for an account (20261110070035). `referral-device.test.ts` and
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

/**
 * Reads the request's device.
 *
 * A browser is known by the feed cookie this site set (httpOnly, so no page
 * script can write it), never by an id it puts in a header or a body: any page
 * can send those, so a browser could name a made-up device and slip past the
 * guard (review of 2026-11-10). A browser with no cookie yet is given one, but
 * only on a fetch from a page of this site.
 *
 * Anything else is the app, which names its installation in a header and, on
 * a visit, in the body (`allowBodyInstallationId`). A caller that names
 * nothing at all gets no device: the guard holds a claim whose visit and claim
 * both came without one.
 */
export function resolveReferralDevice(
  request: Request,
  options: { bodyInstallationId?: unknown; allowBodyInstallationId?: boolean } = {},
): ReferralDevice {
  const cookieId = readRequestCookie(request, FEED_ANONYMOUS_COOKIE_NAME);
  if (request.headers.has('sec-fetch-site')) {
    if (isValidFeedInstallationId(cookieId)) {
      return { deviceHash: hashReferralDevice(cookieId), cookieValueToSet: null };
    }
    if (!isSameSiteBrowserFetch(request)) {
      return { deviceHash: null, cookieValueToSet: null };
    }
    const generatedId = createFeedInstallationId();
    return { deviceHash: hashReferralDevice(generatedId), cookieValueToSet: generatedId };
  }

  const headerId = request.headers.get(FEED_INSTALLATION_ID_HEADER);
  if (isValidFeedInstallationId(headerId)) {
    return { deviceHash: hashReferralDevice(headerId), cookieValueToSet: null };
  }

  const bodyId = options.allowBodyInstallationId && typeof options.bodyInstallationId === 'string'
    ? options.bodyInstallationId
    : null;
  if (isValidFeedInstallationId(bodyId)) {
    return { deviceHash: hashReferralDevice(bodyId), cookieValueToSet: null };
  }

  if (isValidFeedInstallationId(cookieId)) {
    return { deviceHash: hashReferralDevice(cookieId), cookieValueToSet: null };
  }

  return { deviceHash: null, cookieValueToSet: null };
}

/** Sets the feed cookie exactly as the feed route does, when one was minted. */
export function applyReferralDeviceCookie(response: NextResponse, device: ReferralDevice): void {
  if (device.cookieValueToSet) setFeedAnonymousCookie(response, device.cookieValueToSet);
}
