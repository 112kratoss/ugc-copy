import { CREATOR_DRAFT_TOOLS, moveCreatorToolData, type CreatorDraftTool } from '@/lib/persisted-media';

/**
 * A creator used signed out. A visitor sets up a run (prompt, settings, the
 * pictures they picked) and is asked to sign in only at Generate; the form they
 * set up is what they sign in for, so it must be there when they come back.
 *
 * Their draft is saved like an account's, under an owner that is never an
 * account id (those are UUIDs). Leaving for sign-in from the creator's sign-up
 * sheet stores a one-time nonce for that creator here and carries it on the way
 * back (`?handover=`, `creatorSignUpReturnPath`). Only a page that comes back with
 * the same nonce, within the hour, moves the draft to the account signed in,
 * replacing the account's own draft for that tool. A sign-up abandoned on the
 * way, or any other sign-in on the browser, carries no nonce and moves nothing,
 * so nobody else's account ever opens a visitor's pictures.
 *
 * The mark is kept in localStorage, which answers at once: a page with no nonce
 * (nearly every signed-in page) reads its account's draft without waiting.
 */
export const VISITOR_DRAFT_OWNER = 'visitor';

/** How long after sign-up was opened its return still takes the visitor's draft. */
export const VISITOR_DRAFT_HANDOVER_MAX_AGE_MS = 60 * 60 * 1000;

export const VISITOR_DRAFT_HANDOVER_STORAGE_KEY = 'magicbooklet:creator-draft-handover';

type HandoverMark = { version: 2; tool: CreatorDraftTool; nonce: string; markedAt: number };

function isDraftTool(value: unknown): value is CreatorDraftTool {
  return (CREATOR_DRAFT_TOOLS as readonly unknown[]).includes(value);
}

/** The stored mark, or null when there is none or it cannot be read. */
function readStoredMark(): HandoverMark | null {
  try {
    const mark = JSON.parse(window.localStorage.getItem(VISITOR_DRAFT_HANDOVER_STORAGE_KEY) ?? 'null') as Partial<HandoverMark> | null;
    return mark?.version === 2
      && isDraftTool(mark.tool)
      && typeof mark.nonce === 'string'
      && mark.nonce.length > 0
      && typeof mark.markedAt === 'number'
      && Number.isFinite(mark.markedAt)
      ? { version: 2, tool: mark.tool, nonce: mark.nonce, markedAt: mark.markedAt }
      : null;
  } catch {
    // Storage refused (a private window, say), or a value that is not JSON.
    return null;
  }
}

function clearStoredMark() {
  try {
    window.localStorage.removeItem(VISITOR_DRAFT_HANDOVER_STORAGE_KEY);
  } catch {
    // Nothing to clear where nothing could be kept.
  }
}

function isFresh(mark: HandoverMark, now: number) {
  return mark.markedAt <= now && now - mark.markedAt <= VISITOR_DRAFT_HANDOVER_MAX_AGE_MS;
}

function createNonce() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Marks a creator's visitor draft for the sign-in about to start, and answers the
 * nonce its way back carries; null when the browser keeps nothing, and then
 * nothing is handed over. A later mark replaces an earlier one.
 */
export function markVisitorDraftForHandover(tool: CreatorDraftTool, now = Date.now()): string | null {
  const nonce = createNonce();
  try {
    window.localStorage.setItem(
      VISITOR_DRAFT_HANDOVER_STORAGE_KEY,
      JSON.stringify({ version: 2, tool, nonce, markedAt: now } satisfies HandoverMark),
    );
    return nonce;
  } catch {
    return null;
  }
}

/** Whether this page came back from this creator's sign-up with its nonce, within the hour. */
export function hasVisitorDraftHandover(tool: CreatorDraftTool, nonce: string | null | undefined, now = Date.now()): boolean {
  const mark = readStoredMark();
  return Boolean(nonce && mark && mark.tool === tool && mark.nonce === nonce && isFresh(mark, now));
}

/**
 * Moves this creator's visitor draft to the account signed in, when this page came
 * back from the creator's sign-up with its nonce within the hour. Says whether it
 * moved one. The mark is spent either way, so a reload of the same address moves
 * nothing again.
 */
export async function adoptVisitorDraft(
  tool: CreatorDraftTool,
  userId: string,
  nonce: string | null | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (!userId || userId === VISITOR_DRAFT_OWNER || !hasVisitorDraftHandover(tool, nonce, now)) return false;
  clearStoredMark();
  await moveCreatorToolData(tool, VISITOR_DRAFT_OWNER, userId);
  return true;
}
