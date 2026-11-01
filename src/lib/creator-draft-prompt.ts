/**
 * What a creator's prompt box holds when an owner's saved draft is read back after the page
 * opened: one rule for the image, video and motion creators, which each decided it their own
 * way until the owner chose this one (2026-11-01).
 *
 * - Words typed on the page win over the saved prompt: typed before the page's script ran
 *   (`useTypedBeforeHydration`), while a sign-up's hand-over moved the draft, or while the draft
 *   was read.
 * - Except the prompt carried from the sign-up sheet (`?handover=`), read back the first time:
 *   it wins where it holds words, as the sheet says "Your prompt stays". On a slow phone the box
 *   is empty until it comes, and what is typed meanwhile is mostly that prompt again. A
 *   multi-shot draft's words are in its shots; what the page opens on (motion's stock sentence,
 *   saved untouched) is nobody's.
 * - A box holding nothing, or only what the page opened on, takes the saved prompt: an emptied
 *   box has nothing to lose.
 * - When the page's owner changes (another account, a sign-out, a visitor signing in from another
 *   tab), the box goes back to the page's opening prompt at once and then takes the new owner's
 *   saved one: one owner's words are never shown to another, nor saved under them. Only the
 *   sheet's hand-over moves a visitor's work into an account (`creator-visitor-draft.ts`). An
 *   Enhance answer still on its way is the earlier owner's too: its words, its notes and the
 *   balance it reports are dropped.
 */

/** The box holds words typed on the page: something, and not what the page opened on. */
export function promptHoldsTyping(prompt: string, openingPrompt: string): boolean {
  return prompt.trim().length > 0 && prompt !== openingPrompt;
}

/** Whether the box keeps what it holds over the prompt of the saved draft just read back. */
export function keepsPromptOverSavedDraft({
  boxPrompt,
  openingPrompt,
  savedPrompt,
  savedShotPrompts,
  carried,
}: {
  /** What the box holds as the draft answers. */
  boxPrompt: string;
  /** What the page opens on: a link's prompt, motion's default, or nothing. */
  openingPrompt: string;
  savedPrompt: string | undefined;
  /** A multi-shot draft's shot prompts, where its words are. */
  savedShotPrompts?: readonly string[];
  /** The draft is the visitor's, carried here from the sign-up sheet, read back for the first time. */
  carried: boolean;
}): boolean {
  const carriesWords = promptHoldsTyping(savedPrompt ?? '', openingPrompt)
    || (savedShotPrompts ?? []).some((shot) => shot.trim().length > 0);
  if (carried && carriesWords) return false;
  return promptHoldsTyping(boxPrompt, openingPrompt);
}

/**
 * The box holds another owner's words than `owner`'s: as a read of `owner`'s draft starts, or as
 * an Enhance pressed for `owner` answers. `boxOwner` is whose draft the last read was for: none
 * before the page's first. The same owner read again (Strict Mode's second run, a session that
 * lapsed and came back) is no change, nor an answer asked for while a sign-up's hand-over was on
 * its way, when the page knew no owner yet.
 */
export function isAnotherDraftOwner(boxOwner: string | null, owner: string | null): boolean {
  return boxOwner !== null && owner !== null && boxOwner !== owner;
}
