'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { adoptVisitorDraft, hasVisitorDraftHandover, VISITOR_DRAFT_OWNER } from '@/lib/creator-visitor-draft';
import type { CreatorDraftTool } from '@/lib/persisted-media';

/** Past this the page goes on without a hand-over that never answered, as it does without a draft. */
const HANDOVER_WAIT_MS = 10_000;

/**
 * One move per return, whichever run of the effect asks: React runs a development
 * effect twice, and the first run spends the mark, so a second run starting its
 * own move would find nothing and let the page read the account's keys while the
 * first move was still writing them.
 */
const moves = new Map<string, Promise<MoveAnswer>>();

/** The move moved the draft, found nothing to move (the mark was spent or gone), or failed. */
type MoveAnswer = 'moved' | 'nothing' | 'failed';

function moveOnce(tool: CreatorDraftTool, userId: string, nonce: string): Promise<MoveAnswer> {
  const key = `${tool}\n${userId}\n${nonce}`;
  let move = moves.get(key);
  if (!move) {
    move = adoptVisitorDraft(tool, userId, nonce).then(
      (moved): MoveAnswer => (moved ? 'moved' : 'nothing'),
      (): MoveAnswer => 'failed',
    );
    moves.set(key, move);
  }
  return move;
}

export type CreatorDraftOwner = {
  /** Whose draft the page reads and saves; null while it waits for a hand-over, or once a signed-in page has lost its session. */
  owner: string | null;
  /** The visitor's draft was moved to this account on the way back from sign-up. */
  carriedDraft: boolean;
  /**
   * The page came back from this creator's sign-up and the move of the visitor's draft gave up
   * or failed. The form the page holds is the person's own and, until the move lands, the only
   * copy the page has, so it stays as it is: neither taken off as another owner's nor covered
   * by what the account had saved before. Only until the account leaves the page: what is on
   * it after that is nobody's work of theirs.
   */
  keepsVisitorForm: boolean;
};

/**
 * Whose saved draft a creator keeps.
 * - A page that opened signed out keeps the visitor's.
 * - A signed-in page keeps the account's. When it came back from this creator's
 *   sign-up with the hand-over nonce, it waits until the visitor's draft has
 *   moved to the account, so it reads its draft back only once the move is done.
 *   That is the first account to sign in on the page; one signing in after it is
 *   an ordinary sign-in.
 * - A page that opened signed in and then lost its session keeps nothing, so the
 *   account's form never lands in the browser's visitor slot, where the next
 *   person would open it.
 * - Once a sign-out made in this browser ends the session (`signedOut`, from any of
 *   its tabs), the page is the visitor's: the account's form leaves it (owner,
 *   2026-11-01, "Yes, clear it"). A session that lapses keeps it, as above.
 */
export function useCreatorDraftOwner(
  tool: CreatorDraftTool,
  userId: string | null,
  handoverNonce: string | null,
  signedOut = false,
): CreatorDraftOwner {
  const [openedSignedIn] = useState(() => userId !== null);
  // Read once, as the page opens: the nonce is in this page's own address.
  const [awaitsHandover] = useState(() => typeof window !== 'undefined' && hasVisitorDraftHandover(tool, handoverNonce));
  const [moved, setMoved] = useState<{ userId: string; answer: MoveAnswer | 'gave-up' } | null>(null);
  // The hand-over's account has left the page: another account signed in, or the page went
  // back to the visitor, a sign-out included. A session that lapses on a page that opened
  // signed in has not.
  const [handOverLeft, setHandOverLeft] = useState(false);
  if (moved && !handOverLeft && userId !== moved.userId && (userId !== null || !openedSignedIn || signedOut)) {
    setHandOverLeft(true);
  }

  useEffect(() => {
    if (!userId || !awaitsHandover || !handoverNonce || moved) return;
    let cancelled = false;
    // The first answer stands: a move that lands after the give-up has already let
    // the page read its draft, so it cannot be told the draft came back. The page
    // keeps the visitor's form instead.
    let answered = false;
    const done = (answer: MoveAnswer | 'gave-up') => {
      if (cancelled || answered) return;
      answered = true;
      setMoved({ userId, answer });
    };
    const giveUp = window.setTimeout(() => done('gave-up'), HANDOVER_WAIT_MS);
    void moveOnce(tool, userId, handoverNonce).then((answer) => {
      window.clearTimeout(giveUp);
      done(answer);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(giveUp);
    };
  }, [awaitsHandover, handoverNonce, moved, tool, userId]);

  if (!userId) return { owner: openedSignedIn && !signedOut ? null : VISITOR_DRAFT_OWNER, carriedDraft: false, keepsVisitorForm: false };
  if (!awaitsHandover || (moved && moved.userId !== userId)) return { owner: userId, carriedDraft: false, keepsVisitorForm: false };
  if (!moved) return { owner: null, carriedDraft: false, keepsVisitorForm: false };
  return {
    owner: userId,
    carriedDraft: moved.answer === 'moved',
    // Nothing to move means another tab moved it, or there was no draft: the form is not this page's to keep.
    keepsVisitorForm: !handOverLeft && (moved.answer === 'gave-up' || moved.answer === 'failed'),
  };
}

/** Whose form a creator holds, and the key its body is drawn under while it holds it. */
export type CreatorFormHolder = { owner: string | null; key: number };

/**
 * Whose form the creator holds once the draft is `draft.owner`'s. It keeps the same form, under
 * the same key:
 * - while the draft has no owner: a hand-over on its way, or a session that lapsed or signed out
 *   on a page that opened signed in, whose form waits for its account as it always has;
 * - for the page's first owner, learned after it opened (a hand-over that answered);
 * - for the account a hand-over that gave up or failed leaves the visitor's form to
 *   (`keepsVisitorForm`).
 * Any other owner gets a form of their own under a new key: the creator's body is drawn anew, so
 * the earlier owner's form, unanswered start, result and remix go with it.
 */
export function nextCreatorFormHolder(holder: CreatorFormHolder, draft: CreatorDraftOwner): CreatorFormHolder {
  if (draft.owner === null || draft.owner === holder.owner) return holder;
  if (holder.owner === null || draft.keepsVisitorForm) return { owner: draft.owner, key: holder.key };
  return { owner: draft.owner, key: holder.key + 1 };
}

/**
 * The form a creator draws its body for (`nextCreatorFormHolder`).
 * - `key`: the body is drawn under it, so another owner's form is a new body and nothing of the
 *   earlier owner's stays on the page.
 * - `owner`: whose form it is, through a lapse too, when the draft has none. A press goes out only
 *   under that account's session.
 * - `replaced`: aborted once another owner's form takes this one's place, in the commit that swaps
 *   them, so the earlier body's work still out (an upload, a save as it unmounts) stops there. A
 *   page that is only left aborts nothing: what the body started for its owner goes on.
 * - `pageViewer`: whether the form is the page's own viewer's, the visitor's before any account and
 *   then the first account's. What the server drew for the page (the sign-up's welcome, the posts
 *   to start from, read for that viewer) is theirs, and no later account's.
 */
export type CreatorForm = { key: number; owner: string | null; replaced: AbortSignal; pageViewer: boolean };

const isAccount = (owner: string | null) => owner !== null && owner !== VISITOR_DRAFT_OWNER;

export function useCreatorForm(draft: CreatorDraftOwner): CreatorForm {
  const [held, setHeld] = useState(() => ({
    owner: draft.owner,
    key: 0,
    replacement: new AbortController(),
    // The key of the first account's form, once there is one.
    viewerKey: isAccount(draft.owner) ? 0 : null as number | null,
  }));
  const next = nextCreatorFormHolder(held, draft);
  // Moved as the page draws, so the earlier owner's body is never drawn for the next owner.
  if (next !== held) {
    setHeld({
      ...next,
      replacement: next.key === held.key ? held.replacement : new AbortController(),
      viewerKey: held.viewerKey ?? (isAccount(next.owner) ? next.key : null),
    });
  }
  // A layout effect, so the earlier body learns it was replaced before its own unmount effects run.
  const drawn = useRef(held.replacement);
  useLayoutEffect(() => {
    if (drawn.current !== held.replacement) drawn.current.abort();
    drawn.current = held.replacement;
  }, [held.replacement]);
  return {
    key: held.key,
    owner: held.owner,
    replaced: held.replacement.signal,
    pageViewer: held.viewerKey === null || held.viewerKey === held.key,
  };
}
