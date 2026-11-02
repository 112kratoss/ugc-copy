'use client';

import { useCallback, useEffect, useRef } from 'react';

import { renewedRemixLink } from '@/lib/remix-link-renewal';
import type { RemixSourceBundle } from '@/lib/remix-source';
import { isSignedMediaUrlExpiring } from '@/lib/template-run-stable-media';
import { readRemixSource, type RemixReader } from '@/lib/use-remix-source-read';

/**
 * A link that opens now to what `link` opened: the same file, or for a link to the original, the
 * original as it is now (its post's copy, once it is posted). The link itself where none is found.
 */
export type RenewRemixLink = (link: string) => Promise<string>;

type RemixRead = RemixReader & {
  remixId: string | null;
  remixPostId: string | null;
  /** The form's link to the original's result, by whose file a link to the original is known. */
  originalResult: string | null;
};

/** A read of the remix while it is out: for one form's remix and account (`key`). */
type ReadOut = { key: string; answer: Promise<RemixSourceBundle | null> };

/**
 * How long a read for fresh links may take. Past it the read is given up and the link left as it
 * was: every press and preview that asked meanwhile waits on the one read, so a read that stalled
 * held them all.
 */
export const REMIX_LINK_READ_TIMEOUT_MS = 12_000;

/**
 * Reads the remix again, as the form's own read reads it (`readRemixSource`: the same session rule and
 * the same fetch), for the links its answer signs. Null where it cannot be read, or once `signal` gave
 * the read up.
 */
async function fetchRemixAnswer(
  { remixId, remixPostId, formAccount, pageToken }: RemixRead,
  signal: AbortSignal,
): Promise<RemixSourceBundle | null> {
  try {
    return await readRemixSource({ id: remixId ?? '', postId: remixPostId }, { formAccount, pageToken }, signal);
  } catch {
    return null;
  }
}

/**
 * `fetchRemixAnswer` given up by the timeout: the request is aborted then, and a session read still
 * waiting (on the auth lock, say) is left to finish unwatched, then asks nothing. Null where the read
 * fails or is given up.
 */
async function readRemixAnswer(read: RemixRead): Promise<RemixSourceBundle | null> {
  const controller = new AbortController();
  const givenUp = new Promise<null>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(null), { once: true });
  });
  const timer = setTimeout(() => controller.abort(), REMIX_LINK_READ_TIMEOUT_MS);
  try {
    return await Promise.race([fetchRemixAnswer(read, controller.signal), givenUp]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A remix page's links, renewed where they are used. The remix source signs a remix's media for
 * an hour and a form reads its remix once (#664), so past the hour "Use as reference" read no
 * length from the original's clip and a preview drew nothing. A link about to lapse is swapped,
 * at the press or the preview that uses it, for the same file's link in a fresh read of the remix:
 * the same gate as the form's own read, whose answer is used for its links alone, so the form
 * keeps everything the creator changed. Each press and preview asks only on a remix page, and only
 * for a link `isSignedMediaUrlExpiring` calls lapsing. The asks made while a read is out share it,
 * whatever it answers; one made after it reads again, as no answer is kept past its read. A read
 * that fails, or stalls past REMIX_LINK_READ_TIMEOUT_MS, leaves each link as it was.
 */
export function useRemixLinkRenewal({ remixId, remixPostId, formAccount, pageToken, originalResult }: RemixRead): RenewRemixLink {
  const readRef = useRef<RemixRead>({ remixId, remixPostId, formAccount, pageToken, originalResult });
  useEffect(() => {
    readRef.current = { remixId, remixPostId, formAccount, pageToken, originalResult };
  }, [formAccount, originalResult, pageToken, remixId, remixPostId]);
  const readOutRef = useRef<ReadOut | null>(null);

  return useCallback<RenewRemixLink>(async (link) => {
    const read = readRef.current;
    // The read out is shared only by asks for its own remix and account: another account's form is
    // answered by its own read, through its own gate.
    const key = JSON.stringify([read.remixId, read.remixPostId, read.formAccount]);
    let readOut = readOutRef.current?.key === key ? readOutRef.current : null;
    if (!readOut) {
      const started: ReadOut = {
        key,
        answer: readRemixAnswer(read).finally(() => {
          if (readOutRef.current === started) readOutRef.current = null;
        }),
      };
      readOutRef.current = started;
      readOut = started;
    }
    const answer = await readOut.answer;
    const renewed = answer ? renewedRemixLink(link, answer, read.originalResult) : null;
    return renewed && !isSignedMediaUrlExpiring(renewed) ? renewed : link;
  }, []);
}
