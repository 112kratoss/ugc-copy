'use client';

import { useCallback, useEffect, useRef } from 'react';

import { remixAnswerNeedsRenewal, remixLinkNeedsRenewal, renewedRemixLink } from '@/lib/remix-link-renewal';
import type { RemixSourceBundle } from '@/lib/remix-source';
import { supabase } from '@/lib/supabase';

/** A link to the same file that opens now: the link itself while it lasts. */
export type RenewRemixLink = (link: string, options?: { result?: boolean }) => Promise<string>;

type RemixRead = {
  remixId: string | null;
  remixPostId: string | null;
  /** The account whose form this is: the browser's own session is used for it alone. */
  formAccount: string | null;
  /** The page's session token, used where the browser's session is another account's or none. */
  pageToken: string | null;
};

type HeldAnswer = { key: string; answer: Promise<RemixSourceBundle | null> };

/**
 * Reads the remix again, as the form's own read reads it (the browser's session where it is the
 * form's account, which auth-js renews as it nears its end, else the page's), for the links its
 * answer signs. Null where it cannot be read.
 */
async function readRemixAnswer({ remixId, remixPostId, formAccount, pageToken }: RemixRead): Promise<RemixSourceBundle | null> {
  if (!remixId) return null;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const accessToken = session && session.user.id === formAccount ? session.access_token : pageToken;
    if (!accessToken) return null;
    const params = new URLSearchParams({ id: remixId });
    if (remixPostId) params.set('postId', remixPostId);
    const response = await fetch(`/api/remix-source?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return response.ok ? await response.json() as RemixSourceBundle : null;
  } catch {
    return null;
  }
}

/**
 * A remix page's links, renewed where they are used. The remix source signs a remix's media for
 * an hour and a form reads its remix once (#664), so past the hour "Use as reference" read no
 * length from the original's clip and a preview drew nothing. A link about to lapse is swapped,
 * at the press or the preview that uses it, for the same file's link in a fresh read of the
 * remix: the same gate as the form's own read, whose answer is used for its links alone, so the
 * form keeps everything the creator changed. One answer serves every link while its own last,
 * and a read that fails leaves the link as it was.
 */
export function useRemixLinkRenewal({ remixId, remixPostId, formAccount, pageToken }: RemixRead): RenewRemixLink {
  const readRef = useRef<RemixRead>({ remixId, remixPostId, formAccount, pageToken });
  useEffect(() => {
    readRef.current = { remixId, remixPostId, formAccount, pageToken };
  }, [formAccount, pageToken, remixId, remixPostId]);
  const heldRef = useRef<HeldAnswer | null>(null);

  return useCallback<RenewRemixLink>(async (link, options = {}) => {
    const read = readRef.current;
    if (!read.remixId || !remixLinkNeedsRenewal(link, Date.now())) return link;
    const key = JSON.stringify([read.remixId, read.remixPostId, read.formAccount]);
    const freshLink = (answer: RemixSourceBundle | null) => {
      const renewed = answer ? renewedRemixLink(link, answer, options) : null;
      return renewed && !remixLinkNeedsRenewal(renewed, Date.now()) ? renewed : null;
    };

    const held = heldRef.current?.key === key ? heldRef.current : null;
    if (held) {
      const answer = await held.answer;
      const renewed = freshLink(answer);
      if (renewed) return renewed;
      // An answer still current without this file: reading again would not bring it.
      if (answer && !remixAnswerNeedsRenewal(answer, Date.now())) return link;
    }

    const next: HeldAnswer = { key, answer: readRemixAnswer(read) };
    heldRef.current = next;
    const answer = await next.answer;
    // A read that failed is not kept: the next use reads again.
    if (!answer && heldRef.current === next) heldRef.current = null;
    return freshLink(answer) ?? link;
  }, []);
}
