'use client';

import { useCallback, useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react';

import { hasCreatorEditedPromptDuringRemix, type RemixSourceBundle } from '@/lib/remix-source';
import { fetchRemixSource, REMIX_RESTORE_WARNING } from '@/lib/remix-source-client';
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
  /** `REMIX_RESTORE_WARNING` while the form's last read has failed, with Try again (`retry`) beside it. */
  failureWarning: string | null;
  /** Try again, after a failed read: one more read under the form's account. Nothing otherwise. */
  retry: () => void;
  /** The creator set this field by hand: an answer still to land leaves it as they set it. */
  noteEdit: (field: Field) => void;
};

type ReadState = { attempt: number; status: 'loading' | 'failed' | 'done' };

/**
 * A web creator's read of the remix it opened on (`/api/remix-source`), once for its form.
 *
 * - **Once.** The effect runs again for a renewed session token (Supabase renews it about hourly),
 *   a session back from a lapse, development's Strict Mode and Fast Refresh: none of them is another
 *   reader, and a second read put the original back over the creator's work. Another account's form
 *   is drawn anew (`useCreatorForm`) and so reads for itself; another remix is a new client (each
 *   page keys it by `remix|remixPost`).
 * - **Its token.** The browser client's own session where it is the form's account (`formAccount`),
 *   renewed as it nears its end, else the page's: Back can draw the page again from Next's cache with
 *   the session it was first drawn with, expired since. Never another account's session, one signed
 *   in from another tab.
 * - **Its answer** is the form's while the form is on the page (`useUnmountSignal`, read when the
 *   answer lands), whichever run of the effect is the latest. An answer gated on an effect cleanup
 *   never fills the form under Strict Mode, which unmounts the first run before the read is back.
 * - **A failed read** (a 5xx, a 429, the network, a revoked session) is final until the creator asks
 *   again (`retry`): main's token-driven re-read put the original over their work, up to an hour later.
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
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const accessToken = session?.user.id === formAccount ? session.access_token : pageToken;
        const bundle = await fetchRemixSource({ id: remixId, postId: remixPostId }, accessToken);
        if (isGone()) return;
        takeSource(bundle, promptAtFirstRead);
        answered = true;
      } catch {
        // Said on the notice, with Try again; a source read halfway is read again whole.
      }
      if (!isGone()) setRead((current) => ({ ...current, status: answered ? 'done' : 'failed' }));
    })();
  }, [formAccount, pageToken, promptRef, read.attempt, remixId, remixPostId, unmountSignal]);

  const retry = useCallback(() => {
    setRead((current) => (current.status === 'failed' ? { attempt: current.attempt + 1, status: 'loading' } : current));
  }, []);

  const noteEdit = useCallback((field: Field) => {
    editsRef.current.add(field);
  }, []);

  return {
    loading: read.status === 'loading',
    failureWarning: read.status === 'failed' ? REMIX_RESTORE_WARNING : null,
    retry,
    noteEdit,
  };
}
