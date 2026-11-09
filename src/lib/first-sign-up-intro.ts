/**
 * When the web plays the first sign-up intro ("Create / Share / Earn", the
 * dust, the note from the team: `src/components/onboarding/FirstSignUpIntro.tsx`).
 *
 * The app plays its intro at a new install's first open
 * (`ugc-mobile/lib/first-open-intro.ts`). The web plays it once per browser,
 * right after the first sign-up and before the creator-name step (owner,
 * 2026-11-09): only on `/onboarding`, whose page draws the step only for an
 * account that still needs its name, and where the gate
 * (`FirstSignUpIntroGate`) is mounted around it. Never on `/`: a full-screen
 * overlay there would sit on the page people reach from search.
 */

/** Where the intro plays: the creator-name step. */
export const FIRST_SIGN_UP_INTRO_PATH = '/onboarding';

/** Set as the intro begins, so a visit cut short never replays it. */
export const FIRST_SIGN_UP_INTRO_STORAGE_KEY = 'magicbooklet.first-sign-up-intro.seen.v1';

/**
 * What the browser remembers: `unavailable` when its storage cannot be read
 * (blocked site data, some private windows).
 */
export type FirstSignUpIntroStore = 'unseen' | 'seen' | 'unavailable';

export type FirstSignUpIntroInput = {
  pathname: string | null;
  stored: FirstSignUpIntroStore;
  /**
   * The page beneath has been on screen already: the server's cover lifted on
   * its own before the page's script could decide (`FIRST_SIGN_UP_INTRO_COVER_SCRIPT`).
   */
  pageShown: boolean;
};

export type FirstSignUpIntroDecision = 'show' | 'skip';

export function decideFirstSignUpIntro({ pathname, stored, pageShown }: FirstSignUpIntroInput): FirstSignUpIntroDecision {
  if (pathname !== FIRST_SIGN_UP_INTRO_PATH) return 'skip';
  // Seen once is seen. A store that cannot be read could never say so, and
  // the intro would play at every visit: better not at all, as in the app.
  if (stored !== 'unseen') return 'skip';
  // As the app never slides its intro over a screen someone has started to
  // use: the name step is already in front of them.
  if (pageShown) return 'skip';
  return 'show';
}

type ReadableStore = Pick<Storage, 'getItem'>;
type WritableStore = Pick<Storage, 'getItem' | 'setItem'>;

/** This browser's localStorage, or null where reading it is refused. */
export function firstSignUpIntroStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readFirstSignUpIntroStore(storage: ReadableStore | null): FirstSignUpIntroStore {
  if (!storage) return 'unavailable';
  try {
    return storage.getItem(FIRST_SIGN_UP_INTRO_STORAGE_KEY) === null ? 'unseen' : 'seen';
  } catch {
    return 'unavailable';
  }
}

/**
 * Remembers the intro as it begins. False when the store refuses the write
 * (full, or read-only in an older private window): then it does not play,
 * since nothing would stop it playing again.
 */
export function markFirstSignUpIntroSeen(storage: WritableStore | null, now: Date = new Date()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(FIRST_SIGN_UP_INTRO_STORAGE_KEY, now.toISOString());
    return storage.getItem(FIRST_SIGN_UP_INTRO_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * The mark on the root element, from the server's HTML until the page's
 * script has decided: `cover` while the intro's ground covers the page beneath
 * (the name step is never seen before the intro), `lifted` once the cover has
 * gone by itself because the script was slow, and the page is then left alone.
 */
export const FIRST_SIGN_UP_INTRO_COVER_ATTRIBUTE = 'data-first-sign-up-intro';
const COVER_DATASET_KEY = 'firstSignUpIntro';

/** How long the cover waits for the page's script before it lifts by itself (ms). */
export const FIRST_SIGN_UP_INTRO_COVER_WAIT = 5000;

/**
 * Inline in the server's HTML, ahead of the name step: covers the page with
 * the intro's ground before its first paint when this browser has not seen the
 * intro. A client navigation never runs it (React does not run a script it
 * inserts), and the gate then decides before the first paint itself.
 */
export const FIRST_SIGN_UP_INTRO_COVER_SCRIPT = `try{var d=document.documentElement;localStorage.getItem(${JSON.stringify(FIRST_SIGN_UP_INTRO_STORAGE_KEY)})===null&&(d.dataset.${COVER_DATASET_KEY}="cover",setTimeout(function(){d.dataset.${COVER_DATASET_KEY}==="cover"&&(d.dataset.${COVER_DATASET_KEY}="lifted")},${FIRST_SIGN_UP_INTRO_COVER_WAIT}))}catch(e){}`;

export type FirstSignUpIntroCover = 'cover' | 'lifted' | 'none';

export function readFirstSignUpIntroCover(root: HTMLElement): FirstSignUpIntroCover {
  const value = root.dataset[COVER_DATASET_KEY];
  return value === 'cover' || value === 'lifted' ? value : 'none';
}

/** The page beneath is shown again (the intro's own ground has taken over, or it is not playing). */
export function liftFirstSignUpIntroCover(root: HTMLElement) {
  delete root.dataset[COVER_DATASET_KEY];
}
