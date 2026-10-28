'use client';

import { useEffect, useState } from 'react';

import { adoptVisitorDraft, hasVisitorDraftHandover, VISITOR_DRAFT_OWNER } from '@/lib/creator-visitor-draft';
import type { CreatorDraftTool } from '@/lib/persisted-media';

/** Past this the page goes on without a hand-over that never answered, as it does without a draft. */
const HANDOVER_WAIT_MS = 3000;

/**
 * Whose saved draft a creator keeps: the account signed in, or the visitor while
 * nobody is. A page that opens signed in right after this creator's sign-up was
 * opened (the hand-over mark) gets null until the visitor's draft has been moved
 * to the account, so it reads its draft back only once the move is done. Every
 * other page has its owner at once.
 */
export function useCreatorDraftOwner(tool: CreatorDraftTool, userId: string | null): string | null {
  // Read once: a mark is left by this tab's own sign-up, just before it leaves the page.
  const [awaitsHandover] = useState(() => typeof window !== 'undefined' && hasVisitorDraftHandover(tool));
  const [movedFor, setMovedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!userId || !awaitsHandover) return;
    let cancelled = false;
    const done = () => {
      if (!cancelled) setMovedFor(userId);
    };
    const giveUp = window.setTimeout(done, HANDOVER_WAIT_MS);
    void adoptVisitorDraft(tool, userId)
      .catch(() => false)
      .finally(() => {
        window.clearTimeout(giveUp);
        done();
      });
    return () => {
      cancelled = true;
      window.clearTimeout(giveUp);
    };
  }, [awaitsHandover, tool, userId]);

  if (!userId) return VISITOR_DRAFT_OWNER;
  return !awaitsHandover || movedFor === userId ? userId : null;
}
