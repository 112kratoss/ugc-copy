'use client';

import { useCallback, useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react';

import { claimFreeRecipe } from '@/lib/free-recipe-claim-client';
import { hasCreatorEditedPromptDuringRemix, type RemixSourceBundle } from '@/lib/remix-source';
import { fetchRemixSource, REMIX_RESTORE_WARNING } from '@/lib/remix-source-client';
import { REMIX_UNLOCK_REQUIRED_CODE } from '@/lib/showcase-remix-client';
import { supabase } from '@/lib/supabase';
import { useUnmountSignal } from '@/lib/use-unmount-signal';

/**
 * What the creator did to the form before the answer landed, which the answer leaves as they made
 * it: the app's restore keeps every field edited while it loads, and the web creators do as it does.
 */
export type RemixEditsBeforeAnswer<Field extends string> = {
  /**
   * Words of their own in the prompt (`hasCreatorEditedPromptDuringRemix`), read against the prompt
   * as the form's first read began: words typed after a failed read are theirs too.
   */
  prompt: boolean;
  /**
   * Whether they set this field by hand (`noteEdit`): a model picked from the list, a setting chosen.
   * The original's model and settings give way only to those (owner, #649: a remix opens on its
   * original's model, length and settings whatever the balance). What they attached, each creator
   * reads off its own form.
   */
  byHand: (field: Field) => boolean;
};

export type RemixSourceRead<Field extends string> = {
  /** A read is out: the notice slot holds its placeholder, so the form never looks finished before it is. */
  loading: boolean;
  /** `REMIX_RESTORE_WARNING` while the form's last read has failed, with Try again (`retry`) beside it where `canRetry`. */
  failureWarning: string | null;
  /** The last read failed in a way a later one can get past (`remixReadMaySucceedLater`): Try again is offered. */
  canRetry: boolean;
  /** Try again, after a failed read that `canRetry`: one more read under the form's account. Nothing otherwise. */
  retry: () => void;
  /** The creator set this field by hand: an answer still to land leaves it as they set it. */
  noteEdit: (field: Field) => void;
};

type ReadState = { attempt: number; status: 'loading' | 'failed' | 'done'; retryable?: boolean };

/**
 * Whether a failed read of a remix can answer later, which is when Try again is offered: the network,
 * a timeout, a 429, a 5xx, a session refused (renewed since, or signed in again), and an answer the
 * form could not take. A 403, a 404 or any other refusal of the remix itself answers the same again
 * (2026-11-06 review), so the notice says the warning alone.
 */
export function remixReadMaySucceedLater(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') return true;
  return status < 400 || status === 401 || status === 408 || status === 429 || status >= 500;
}

/** Whom a remix page reads its remix as. */
export type RemixReader = {
  /** The account whose form this is: the browser's own session is used for it alone. */
  formAccount: string | null;
  /** The page's session token (`useAuth`), used where the browser's session is another account's or none. */
  pageToken: string | null;
};

/** The session a remix page asks as: the browser's own where it is the form's account, else the page's. */
async function remixReaderToken({ formAccount, pageToken }: RemixReader): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session && session.user.id === formAccount ? session.access_token : pageToken;
}

/**
 * Takes the post's free recipe for the form's account, under the session its reads go out under
 * (`claimFreeRecipe`, with the funnel events of every free unlock). Answers null once the recipe is
 * theirs, else why not: the claim's error with its status, where the recipe is not one to take for
 * nothing (paid, retired, withheld from this reader: a 400 or a 404) or the claim could not be made
 * (a 429, a 5xx, the network, no session).
 */
async function takeFreeRecipe(postId: string, reader: RemixReader): Promise<{ error: unknown } | null> {
  try {
    const accessToken = await remixReaderToken(reader);
    if (!accessToken) throw new Error('No session to take the recipe with');
    await claimFreeRecipe(postId, accessToken);
    return null;
  } catch (error) {
    return { error };
  }
}

/**
 * The remix's original as the form's account reads it (`fetchRemixSource`): with the browser client's
 * own session where it is that account, renewed as it nears its end, else with the page's. Back can draw
 * the page again from Next's cache with the session it was first drawn with, expired since; and never
 * another account's session, one signed in from another tab. Throws where neither session is there, and
 * on any refusal. A remix page's two readers read through it alone: its form's one read
 * (`useRemixSourceRead`) and the renewal of its links (`useRemixLinkRenewal`), which uses the answer for
 * its links only (`remix-source-read-guard.test.ts`). `signal` gives the read up: the renewal's after
 * its timeout. Given up while the session was read (the auth lock can hold that), it asks nothing.
 */
export async function readRemixSource(
  remix: { id: string; postId: string | null },
  reader: RemixReader,
  signal?: AbortSignal,
): Promise<RemixSourceBundle> {
  const accessToken = await remixReaderToken(reader);
  if (!accessToken) throw new Error('No session to read the remix with');
  if (signal?.aborted) throw new Error('The read was given up');
  return fetchRemixSource(remix, accessToken, signal);
}

/**
 * A web creator's read of the remix it opened on (`/api/remix-source`), once for its form.
 *
 * - **Once.** The effect runs again for a renewed session token (Supabase renews it about hourly),
 *   a session back from a lapse, development's Strict Mode and Fast Refresh: none of them is another
 *   reader, and a second read put the original back over the creator's work. Another account's form
 *   is drawn anew (`useCreatorForm`) and so reads for itself; another remix is a new client (each
 *   page keys it by `remix|remixPost`).
 * - **Its token** is `readRemixSource`'s: the browser client's own session where it is the form's
 *   account (`formAccount`), else the page's, and never another account's.
 * - **Its answer** is the form's while the form is on the page (`useUnmountSignal`, read when the
 *   answer lands), whichever run of the effect is the latest. An answer gated on an effect cleanup
 *   never fills the form under Strict Mode, which unmounts the first run before the read is back.
 * - **A remix behind a free recipe** (a 403 with `REMIX_UNLOCK_REQUIRED`, for a remix that names its
 *   post) is not a failure yet: the recipe is taken for the form's account and the remix read once
 *   more, the notice's placeholder held throughout. A claim the server refuses leaves the refusal;
 *   one that could not be made is a failed read with Try again. This makes opening the page the
 *   act that takes the recipe, as a tap on the feed card's Remix is: a link to a remix, from the
 *   shelf or from anywhere else, takes its post's free recipe for the signed-in account that opens
 *   it (2026-11-13 review: accepted; the endpoint's own rules and rate limit still decide, a guest
 *   and an agent token never reach it, and nothing is given that the post page would not give).
 * - **A failed read** (a 5xx, a 429, the network, a revoked session, or an answer the form could not
 *   take) is final until the creator asks again (`retry`): the token-driven re-read that #664 ended
 *   put the original over their work, up to an hour later. A refusal of the remix itself (a 403, a
 *   404) is final: no Try again (`canRetry`), as a later read would answer the same.
 *
 * `onSource` puts the source on the form, each creator its own way, with what the creator changed
 * before the answer landed (`RemixEditsBeforeAnswer`), and runs once, for the read that answers.
 */
export function useRemixSourceRead<Field extends string>({
  remixId,
  remixPostId,
  pageToken,
  formAccount,
  promptRef,
  onSource,
}: {
  remixId: string | null;
  remixPostId: string | null;
  /** The page's session token (`useAuth`). The first read waits for one. */
  pageToken: string | null;
  /** The account whose form this is, which reads go out under. */
  formAccount: string | null;
  /** The live prompt, which the first read takes as the prompt it began with. */
  promptRef: RefObject<string>;
  onSource: (bundle: RemixSourceBundle, edits: RemixEditsBeforeAnswer<Field>) => void;
}): RemixSourceRead<Field> {
  const [read, setRead] = useState<ReadState>(() => ({ attempt: 0, status: remixId ? 'loading' : 'done' }));
  const unmountSignal = useUnmountSignal();
  // The attempt whose read has started: each starts once, whichever run of the effect comes first.
  const startedAttemptRef = useRef(-1);
  // The prompt as the form's first read began. Try again keeps it.
  const promptAtFirstReadRef = useRef<string | null>(null);
  const editsRef = useRef(new Set<Field>());

  const takeSource = useEffectEvent((bundle: RemixSourceBundle, promptAtFirstRead: string) => {
    const edits = editsRef.current;
    onSource(bundle, {
      prompt: hasCreatorEditedPromptDuringRemix(promptRef.current, promptAtFirstRead),
      byHand: (field) => edits.has(field),
    });
  });

  useEffect(() => {
    if (!remixId || !pageToken || startedAttemptRef.current >= read.attempt) return;
    startedAttemptRef.current = read.attempt;
    const promptAtFirstRead = promptAtFirstReadRef.current ?? promptRef.current;
    promptAtFirstReadRef.current = promptAtFirstRead;
    // Gone once the form leaves the page or another owner's takes its place.
    const isGone = () => unmountSignal.current.aborted;

    void (async () => {
      let answered = false;
      let retryable = false;
      try {
        const remix = { id: remixId, postId: remixPostId };
        const reader = { formAccount, pageToken };
        let bundle: RemixSourceBundle;
        try {
          bundle = await readRemixSource(remix, reader);
        } catch (refusal) {
          // The remix is behind its post's recipe. Where that recipe costs nothing the page takes
          // it and reads once more: opening a remix of a free recipe takes the recipe on the way,
          // from a shelf card as from the feed card's Remix and the post page's (owner, 2026-11-12
          // and 13). The server decides what is free: a paid, retired or withheld recipe refuses
          // the claim, and the remix stays refused as it was, for good. A claim that only failed
          // to be made (a 429, a 5xx, the network) is said as that failure, so Try again is
          // offered: its read is refused again and the recipe asked for once more.
          const behindRecipe = (refusal as { code?: unknown } | null)?.code === REMIX_UNLOCK_REQUIRED_CODE;
          if (!remixPostId || !behindRecipe || isGone()) throw refusal;
          const notTaken = await takeFreeRecipe(remixPostId, reader);
          if (notTaken) throw remixReadMaySucceedLater(notTaken.error) ? notTaken.error : refusal;
          if (isGone()) return;
          bundle = await readRemixSource(remix, reader);
        }
        if (isGone()) return;
        takeSource(bundle, promptAtFirstRead);
        answered = true;
      } catch (error) {
        // Said on the notice, with Try again where a later read can get past it (a source read halfway
        // is read again whole), and in the browser's console, as each creator's own read said it.
        // eslint-disable-next-line no-console -- a browser hook: the structured logger is the server's
        console.error('Error fetching remix:', error);
        retryable = remixReadMaySucceedLater(error);
      }
      if (!isGone()) setRead((current) => ({ ...current, status: answered ? 'done' : 'failed', retryable }));
    })();
  }, [formAccount, pageToken, promptRef, read.attempt, remixId, remixPostId, unmountSignal]);

  const retry = useCallback(() => {
    setRead((current) => (current.status === 'failed' && current.retryable ? { attempt: current.attempt + 1, status: 'loading' } : current));
  }, []);

  const noteEdit = useCallback((field: Field) => {
    editsRef.current.add(field);
  }, []);

  return {
    loading: read.status === 'loading',
    failureWarning: read.status === 'failed' ? REMIX_RESTORE_WARNING : null,
    canRetry: read.status === 'failed' && read.retryable === true,
    retry,
    noteEdit,
  };
}
