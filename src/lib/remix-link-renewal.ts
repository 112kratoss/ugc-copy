import type { RemixSourceBundle } from '@/lib/remix-source';
import { isSignedMediaUrlExpiring } from '@/lib/template-run-stable-media';

/*
 * A remix hands its media out by storage links signed for an hour (`/api/remix-source`), and a
 * creator reads its remix once for its form (#664), so a page kept open past the hour holds links
 * storage no longer opens. A link is renewed where it is used once it has five minutes or less to
 * live (`isSignedMediaUrlExpiring`, as a template run's page renews its media), so a read started
 * on it (a clip's length, a preview's first bytes) does not find it gone midway.
 */

const STORED_OBJECT_PATH = /\/storage\/v1\/object\/(sign|public)\/(.+)$/;

function parseLink(link: string): URL | null {
  try {
    return new URL(link);
  } catch {
    return null;
  }
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
  return remixAnswerLinks(answer).some((link) => isSignedMediaUrlExpiring(link, nowMs));
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
