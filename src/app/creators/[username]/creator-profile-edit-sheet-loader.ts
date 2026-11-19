import { lazy, useSyncExternalStore } from 'react';

type CreatorProfileEditSheetModule = typeof import('./CreatorProfileEditSheet');

/** How long the owner's page waits for an idle moment before it loads the editor's code. */
export const CREATOR_PROFILE_EDIT_SHEET_WARM_IDLE_TIMEOUT_MS = 2_000;

let editSheetPromise: Promise<CreatorProfileEditSheetModule> | null = null;
// The module once it has arrived in this document (`useLoadedCreatorProfileEditSheet`).
let loadedEditSheet: CreatorProfileEditSheetModule | null = null;
const loadedEditSheetListeners = new Set<() => void>();

/**
 * The owner's Edit profile dialog, loaded once per document, as the reel's code is
 * (`showcase-reel-loader.ts`): one promise for the warm-up and the press, and a load that failed
 * is asked for again by the next one.
 */
export function loadCreatorProfileEditSheet(): Promise<CreatorProfileEditSheetModule> {
  editSheetPromise ??= import('./CreatorProfileEditSheet')
    .then((module) => {
      loadedEditSheet = module;
      loadedEditSheetListeners.forEach((listener) => listener());
      return module;
    })
    .catch((error) => {
      editSheetPromise = null;
      throw error;
    });

  return editSheetPromise;
}

/** Loads the editor ahead of the press: a load that fails here is the press's to try again. */
export function warmCreatorProfileEditSheet(): void {
  void loadCreatorProfileEditSheet().catch(() => undefined);
}

function lazyCreatorProfileEditSheet() {
  return lazy(() => loadCreatorProfileEditSheet().then((module) => ({ default: module.CreatorProfileEditSheet })));
}

/**
 * The dialog for an Edit press made before its code had arrived, drawn once it lands; from then on
 * the page draws the loaded module's own (`useLoadedCreatorProfileEditSheet`), which the loader
 * hands over before this lazy hears of the load, so the dialog is mounted once. A load that failed
 * stays failed in it, for the page's lifetime: its error boundary offers a reload.
 */
export let CreatorProfileEditSheetOnItsWay = lazyCreatorProfileEditSheet();

function subscribeToLoadedEditSheet(listener: () => void): () => void {
  loadedEditSheetListeners.add(listener);
  return () => {
    loadedEditSheetListeners.delete(listener);
  };
}

/**
 * The dialog's module once it is in this document, else null (and always null on the server).
 * Once it is, the dialog is drawn directly, in the render that opens it: drawn through a lazy
 * component every first open would wait in a Suspense boundary, its code loaded or not, and React
 * holds content back for 300 ms after a fallback it has shown (`ShowcaseReel` says more).
 */
export function useLoadedCreatorProfileEditSheet(): CreatorProfileEditSheetModule | null {
  return useSyncExternalStore(
    subscribeToLoadedEditSheet,
    () => loadedEditSheet,
    () => null,
  );
}

/** For tests: each case starts with no editor loaded, as a page does. */
export function forgetCreatorProfileEditSheetForTests(): void {
  editSheetPromise = null;
  loadedEditSheet = null;
  CreatorProfileEditSheetOnItsWay = lazyCreatorProfileEditSheet();
}
