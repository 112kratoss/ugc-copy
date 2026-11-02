import type { RemixSourceBundle } from '@/lib/remix-source';

/**
 * A remix hands its media out by storage links signed for an hour (`/api/remix-source`), and a
 * creator reads its remix once for its form (#664), so a page kept open past the hour holds links
 * storage no longer opens. A link is renewed where it is used, this long before it lapses, so a
 * read started on it (a clip's length, a preview's first bytes) does not find it gone midway.
 */
export const REMIX_LINK_RENEWAL_MARGIN_MS = 5 * 60 * 1000;

const STORED_OBJECT_PATH = /\/storage\/v1\/object\/(sign|public)\/(.+)$/;

function parseLink(link: string): URL | null {
  try {
    return new URL(link);
  } catch {
    return null;
  }
}

/** The claims of a token's payload segment (base64url JSON), or null. */
function tokenClaims(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims: unknown = JSON.parse(atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * When a signed storage link stops opening: its token's `exp`, in milliseconds. Null for any
 * other link (a public showcase link, a blob, another host's), which does not lapse.
 */
export function signedLinkExpiresAtMs(link: string): number | null {
  const url = parseLink(link);
  if (!url || url.pathname.match(STORED_OBJECT_PATH)?.[1] !== 'sign') return null;
  const token = url.searchParams.get('token');
  const exp = token ? tokenClaims(token)?.exp : undefined;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
}

/** Whether a link has lapsed by `nowMs`, or will within the renewal margin. */
export function remixLinkNeedsRenewal(link: string | null | undefined, nowMs: number): boolean {
  if (!link) return false;
  const expiresAtMs = signedLinkExpiresAtMs(link);
  return expiresAtMs !== null && expiresAtMs - REMIX_LINK_RENEWAL_MARGIN_MS <= nowMs;
}

/** The stored object a storage link opens (`bucket/path`), whatever its token. Null for any other link. */
export function storedObjectOfLink(link: string): string | null {
  const match = parseLink(link)?.pathname.match(STORED_OBJECT_PATH);
  if (!match) return null;
  try {
    return decodeURIComponent(match[2]);
  } catch {
    return null;
  }
}

/** Whether two links open one stored file: the same link, or two signings of it. */
export function isSameRemixMedia(first: string | null | undefined, second: string | null | undefined): boolean {
  if (!first || !second) return false;
  if (first === second) return true;
  const object = storedObjectOfLink(first);
  return object !== null && object === storedObjectOfLink(second);
}

/**
 * The links a remix's answer opens its media by, as it signed them: each `url` of the original's
 * result and of the inputs it restores. Never its settings', which name the links the run read
 * long ago, nor what a kept input records of its source (`sourceUrl`, the link its run read).
 */
function remixAnswerLinks(answer: RemixSourceBundle): string[] {
  const links: string[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'url') {
        if (typeof entry === 'string' && entry) links.push(entry);
      } else {
        collect(entry);
      }
    }
  };
  collect(answer.result);
  collect(answer.inputs);
  collect(answer.inputMedia);
  return links;
}

/** Whether any link of an answer has lapsed by `nowMs` or soon will: it is no answer to renew from. */
export function remixAnswerNeedsRenewal(answer: RemixSourceBundle, nowMs: number): boolean {
  return remixAnswerLinks(answer).some((link) => remixLinkNeedsRenewal(link, nowMs));
}

/**
 * A fresh answer's link to the file `link` opens, or null where the answer holds none. With
 * `result`, the answer's own result: the original may have been posted since, and its result is
 * then its post's public copy rather than the private file the older link opened.
 */
export function renewedRemixLink(
  link: string,
  answer: RemixSourceBundle,
  options: { result?: boolean } = {},
): string | null {
  if (options.result) return answer.result?.url || null;
  return remixAnswerLinks(answer).find((candidate) => isSameRemixMedia(candidate, link)) ?? null;
}
