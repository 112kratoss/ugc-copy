import { moveCreatorToolData, type CreatorDraftTool } from '@/lib/persisted-media';

/**
 * A creator used signed out. A visitor sets up a run (prompt, settings, the
 * pictures they picked) and is asked to sign in only at Generate; the form they
 * set up is what they sign in for, so it must be there when they come back.
 *
 * Their draft is saved like an account's, under an owner that is never an
 * account id (those are UUIDs). Opening sign-up from a creator marks that
 * creator's draft for hand-over; the first page of that creator opened signed in
 * within the hour moves it to the account, replacing the account's own draft for
 * that tool. Without the mark nothing moves, so the next person to sign in on a
 * shared browser never opens a visitor's pictures.
 *
 * The mark is kept in localStorage, which answers at once: a page with no mark
 * (nearly every signed-in page) reads its account's draft without waiting.
 */
export const VISITOR_DRAFT_OWNER = 'visitor';

/** How long after sign-up was opened the next sign-in takes the visitor's draft. */
export const VISITOR_DRAFT_HANDOVER_MAX_AGE_MS = 60 * 60 * 1000;

export const VISITOR_DRAFT_HANDOVER_STORAGE_KEY = 'magicbooklet:creator-draft-handover';

type HandoverMark = { version: 1; tool: CreatorDraftTool; markedAt: number };

function readHandoverMark(value: unknown): HandoverMark | null {
  const mark = (value ?? {}) as Partial<HandoverMark>;
  return mark.version === 1
    && (mark.tool === 'image' || mark.tool === 'video' || mark.tool === 'motion')
    && typeof mark.markedAt === 'number'
    && Number.isFinite(mark.markedAt)
    ? { version: 1, tool: mark.tool, markedAt: mark.markedAt }
    : null;
}

/** The stored mark, and whether anything was stored at all (an unreadable one is cleared). */
function readStoredMark(): { mark: HandoverMark | null; stored: boolean } {
  try {
    const raw = window.localStorage.getItem(VISITOR_DRAFT_HANDOVER_STORAGE_KEY);
    if (raw === null) return { mark: null, stored: false };
    try {
      return { mark: readHandoverMark(JSON.parse(raw)), stored: true };
    } catch {
      return { mark: null, stored: true };
    }
  } catch {
    // Storage refused (a private window, say): there is no mark to follow.
    return { mark: null, stored: false };
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

/** Marks a creator's visitor draft for the account about to sign in. A later mark replaces an earlier one. */
export function markVisitorDraftForHandover(tool: CreatorDraftTool, now = Date.now()): void {
  try {
    window.localStorage.setItem(
      VISITOR_DRAFT_HANDOVER_STORAGE_KEY,
      JSON.stringify({ version: 1, tool, markedAt: now } satisfies HandoverMark),
    );
  } catch {
    // Storage refused: the account opens its own draft, as it did before.
  }
}

/** Whether sign-up was opened from this creator within the hour, so its next signed-in page waits for the move. */
export function hasVisitorDraftHandover(tool: CreatorDraftTool, now = Date.now()): boolean {
  const { mark } = readStoredMark();
  return Boolean(mark && mark.tool === tool && isFresh(mark, now));
}

/**
 * Moves this creator's visitor draft to the account signed in, when sign-up was
 * opened from this creator within the hour. Says whether it moved one. A mark
 * for another creator stays for that creator; an old or unreadable one goes.
 */
export async function adoptVisitorDraft(tool: CreatorDraftTool, userId: string, now = Date.now()): Promise<boolean> {
  if (!userId || userId === VISITOR_DRAFT_OWNER) return false;
  const { mark, stored } = readStoredMark();
  if (!stored) return false;
  if (!mark || !isFresh(mark, now)) {
    clearStoredMark();
    return false;
  }
  if (mark.tool !== tool) return false;
  await moveCreatorToolData(tool, VISITOR_DRAFT_OWNER, userId);
  clearStoredMark();
  return true;
}
