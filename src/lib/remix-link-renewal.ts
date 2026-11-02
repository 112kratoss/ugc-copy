import type { RemixSourceBundle } from '@/lib/remix-source';
import { getCanonicalStoredMediaLocation } from '@/lib/storage-ownership';
import { isSignedMediaUrlExpiring } from '@/lib/template-run-stable-media';

/*
 * A remix hands its media out by storage links signed for an hour (`/api/remix-source`), and a
 * creator reads its remix once for its form (#664), so a page kept open past the hour holds links
 * storage no longer opens. A link is renewed where it is used once it has five minutes or less to
 * live (`isSignedMediaUrlExpiring`, as a template run's page renews its media), so a read started
 * on it (a clip's length, a preview's first bytes) does not find it gone midway.
 */

/**
 * Whether two links open one stored file: the same link, or two signings of it, read as the
 * server reads a link's file (`getCanonicalStoredMediaLocation`: its bucket and path, an upload's
 * included, whatever its token).
 */
function isSameStoredFile(first: string, second: string): boolean {
  if (first === second) return true;
  const file = getCanonicalStoredMediaLocation(first);
  const other = file ? getCanonicalStoredMediaLocation(second) : null;
  return Boolean(file && other && file.bucket === other.bucket && file.filePath === other.filePath);
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
  return remixAnswerLinks(answer).find((candidate) => isSameStoredFile(candidate, link)) ?? null;
}
