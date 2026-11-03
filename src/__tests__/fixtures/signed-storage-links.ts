import { screen, waitFor } from '@testing-library/react';
import { expect, onTestFinished, vi } from 'vitest';

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

/** The project's public buckets (supabase/migrations): storage serves no other by a public link. */
const PUBLIC_BUCKETS = new Set(['showcase_media', 'profiles']);

/**
 * Whether storage still opens a link, as it decides: a signed link by its token, which must name
 * the object the link asks for (its `url` claim) and not have passed its `exp` ("exp" claim
 * timestamp check failed: a page kept open past the hour holds links that no longer open), and a
 * public link only into a public bucket. What is not a storage link (a picked file's blob) opens.
 * A fragment (the remix notice's `#t=0.1`) is not part of the request.
 */
export function storageOpens(link: string, nowMs = Date.now()): boolean {
  const object = storedObjectOf(link);
  if (!object) return true;
  const request = link.split('#')[0];
  if (/\/storage\/v1\/object\/public\//.test(request.split('?')[0])) return PUBLIC_BUCKETS.has(object.split('/')[0]);
  try {
    const token = new URL(request).searchParams.get('token');
    const claims = JSON.parse(Buffer.from(token?.split('.')[1] ?? '', 'base64url').toString()) as { url?: unknown; exp?: unknown };
    return claims.url === object && typeof claims.exp === 'number' && claims.exp * 1000 > nowMs;
  } catch {
    // No token, or one storage cannot read.
    return false;
  }
}

/** The stored object a storage link opens (`bucket/path`), whatever its token. */
export function storedObjectOf(link: string): string | null {
  const match = link.split(/[?#]/)[0].match(/\/storage\/v1\/object\/(?:sign|public)\/(.+)$/);
  return match ? match[1] : null;
}

/** When the page opens, by default (`movePageClock`). */
export const PAGE_OPENED_AT = Date.UTC(2026, 10, 2, 9, 0, 0);

/**
 * Sets the clock the page reads (`Date`) to `atMs`, leaving timers and promises real, until the
 * test ends. Moving it past the hour (`advancePastTheHour`) is a page left open past its links' hour.
 */
export function movePageClock(atMs = PAGE_OPENED_AT): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(atMs);
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

/** Moves the page's clock (`movePageClock`) on sixty-one minutes: a link signed before has lapsed. */
export function advancePastTheHour(): void {
  vi.setSystemTime(Date.now() + (SIGNED_LINK_SECONDS + 60) * 1000);
}

/** That `link` is a link to `object` (`bucket/path`) which storage opens now (`storageOpens`). */
export function expectOpensObject(link: string, object: string): void {
  expect(storedObjectOf(link)).toBe(object);
  expect(storageOpens(link), `${link} is refused by storage`).toBe(true);
}

/** The link the preview dialog named `title` draws its clip or picture from, once it draws one. */
export async function previewLink(title: string): Promise<string> {
  const dialog = await screen.findByRole('dialog', { name: title });
  await waitFor(() => expect(dialog.querySelector('video, img')).not.toBeNull());
  return dialog.querySelector('video, img')!.getAttribute('src')!;
}
