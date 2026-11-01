'use client';

import { useEffect, useState } from 'react';

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
 */
export function useCreatorDraftOwner(
  tool: CreatorDraftTool,
  userId: string | null,
  handoverNonce: string | null,
): CreatorDraftOwner {
  const [openedSignedIn] = useState(() => userId !== null);
  // Read once, as the page opens: the nonce is in this page's own address.
  const [awaitsHandover] = useState(() => typeof window !== 'undefined' && hasVisitorDraftHandover(tool, handoverNonce));
  const [moved, setMoved] = useState<{ userId: string; answer: MoveAnswer | 'gave-up' } | null>(null);
  // The hand-over's account has left the page: another account signed in, or the page went
  // back to the visitor. A session that lapses on a page that opened signed in has not.
  const [handOverLeft, setHandOverLeft] = useState(false);
  if (moved && !handOverLeft && userId !== moved.userId && (userId !== null || !openedSignedIn)) {
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

  if (!userId) return { owner: openedSignedIn ? null : VISITOR_DRAFT_OWNER, carriedDraft: false, keepsVisitorForm: false };
  if (!awaitsHandover || (moved && moved.userId !== userId)) return { owner: userId, carriedDraft: false, keepsVisitorForm: false };
  if (!moved) return { owner: null, carriedDraft: false, keepsVisitorForm: false };
  return {
    owner: userId,
    carriedDraft: moved.answer === 'moved',
    // Nothing to move means another tab moved it, or there was no draft: the form is not this page's to keep.
    keepsVisitorForm: !handOverLeft && (moved.answer === 'gave-up' || moved.answer === 'failed'),
  };
}
