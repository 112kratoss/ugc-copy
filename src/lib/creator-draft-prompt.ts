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
 *   tab), the creator is drawn anew for the new owner (`useCreatorForm`): the box holds the page's
 *   opening prompt and then takes the new owner's saved one. One owner's words are never shown to
 *   another, nor saved under them; an Enhance answer still on its way goes with the earlier form.
 *   Only the sheet's hand-over moves a visitor's work into an account (`creator-visitor-draft.ts`),
 *   and where its move gave up or failed the page keeps the visitor's form as it is
 *   (`keepsVisitorForm`), words, pictures and clips.
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
