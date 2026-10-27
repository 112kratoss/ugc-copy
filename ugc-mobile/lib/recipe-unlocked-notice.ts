/**
 * "Recipe unlocked", with the way to where a bought recipe is kept, after
 * every unlock (`useBundleUnlock`): on Details, on the recipe screen and in the
 * remix sheet. Nothing said where it went before (audit B-F9, B-F20).
 *
 * The remix sheet goes straight on to the editor once it is paid, so the
 * notice is not the unlocking screen's to draw: it is drawn once above every
 * screen (`components/recipe-unlocked-notice.tsx`, mounted at the root), and
 * this is the one notice it shows.
 */

export const RECIPE_UNLOCKED_MESSAGE = 'Recipe unlocked';
/** The buyer's library, in the glossary's words (the side menu's row says the same). */
export const UNLOCKED_RECIPES_LABEL = 'Unlocked recipes';
export const UNLOCKED_RECIPES_PATH = '/unlocks';
/** How long the notice stays when no screen reader is running, as the feed's Undo does. */
export const RECIPE_UNLOCKED_NOTICE_MS = 5_000;

/** New for every unlock: a second unlock replaces the notice showing and starts its time over. */
export type RecipeUnlockedNoticeModel = { id: number };

let current: RecipeUnlockedNoticeModel | null = null;
let nextNoticeId = 1;
const listeners = new Set<() => void>();

function commit(next: RecipeUnlockedNoticeModel | null) {
  current = next;
  listeners.forEach((listener) => listener());
}

export function announceRecipeUnlocked() {
  commit({ id: nextNoticeId++ });
}

/** The notice is done: its time ran out, its action was pressed, or a reader dismissed it. */
export function dismissRecipeUnlockedNotice(id: number) {
  if (current?.id === id) commit(null);
}

/** For the notice: `useSyncExternalStore(subscribeToRecipeUnlockedNotice, readRecipeUnlockedNotice)`. */
export function subscribeToRecipeUnlockedNotice(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readRecipeUnlockedNotice() {
  return current;
}
