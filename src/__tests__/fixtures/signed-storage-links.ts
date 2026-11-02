import { onTestFinished, vi } from 'vitest';

import { unsignedJwt } from './unsigned-jwt';

/** How long the remix source signs a link for (`createSignedUrl(…, 3600)`). */
export const SIGNED_LINK_SECONDS = 3600;

/**
 * A storage link signed as the remix source signs one: the object's path, and a token whose
 * `exp` is an hour after `signedAtMs` (by default the test's clock, which `movePageClock` sets).
 */
export function signedStorageLink(objectPath: string, signedAtMs = Date.now()): string {
  const iat = Math.floor(signedAtMs / 1000);
  const token = unsignedJwt({ url: objectPath, iat, exp: iat + SIGNED_LINK_SECONDS });
  return `https://project.supabase.co/storage/v1/object/sign/${objectPath}?token=${token}`;
}

/**
 * Whether storage still opens a link: it refuses one whose token's `exp` has passed ("exp" claim
 * timestamp check failed), so a page kept open past the hour holds links that no longer open.
 * A link without a token (a public showcase link, a blob) always opens. A fragment (the remix
 * notice's `#t=0.1`) is not part of the request.
 */
export function storageOpens(link: string, nowMs = Date.now()): boolean {
  let token: string | null = null;
  try {
    token = new URL(link.split('#')[0]).searchParams.get('token');
  } catch {
    return true;
  }
  if (!token) return true;
  const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { exp?: unknown };
  return typeof claims.exp === 'number' && claims.exp * 1000 > nowMs;
}

/** The stored object a storage link opens (`bucket/path`), whatever its token. */
export function storedObjectOf(link: string): string | null {
  const match = link.split(/[?#]/)[0].match(/\/storage\/v1\/object\/(?:sign|public)\/(.+)$/);
  return match ? match[1] : null;
}

/**
 * Sets the clock the page reads (`Date`) to `atMs`, leaving timers and promises real, until the
 * test ends. Moving it on an hour is a page left open past its links' hour.
 */
export function movePageClock(atMs: number): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(atMs);
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

/** Sixty-one minutes: a link signed when the page opened has lapsed. */
export const PAST_THE_HOUR_MS = (SIGNED_LINK_SECONDS + 60) * 1000;

/** Moves the page's clock (`movePageClock`) on by `ms`. */
export function advancePageClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}
