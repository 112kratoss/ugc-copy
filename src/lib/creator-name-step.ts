import {
  firstHandleSuggestion,
  followNameWithHandleSuggestion,
  shouldSwapHandleSuggestion,
  startHandleSuggestion,
  swapHandleSuggestion,
  type HandleSuggestion,
} from '../../ugc-mobile/lib/post-publish-policy/handle-suggestion';
import { hasSkippedProfileOnboarding } from '@/lib/auth-onboarding';
import {
  getCreatorProfileReadiness,
  getReservedProfileUsernameError,
  isClaimedProfileUsername,
  isGeneratedProfileUsername,
  normalizeUsername,
  validateProfileUpdate,
} from '@/lib/profile';
import {
  normalizeHandleInput,
  PUBLIC_HANDLE_RULE,
  type PublicIdentityProfile,
  type SignedInUser,
} from '@/lib/public-identity';

/**
 * The creator-name step at `/onboarding` (owner, 2026-11-09: the app's
 * required name, on the web). What it opens with, what the line under the
 * handle says, and when Home opens it again. The handle's suggestion rules are
 * the app's own (`ugc-mobile/lib/post-publish-policy/handle-suggestion.ts`).
 */

/**
 * Left by the step as it opens, holding the account it opened for: Home opens the
 * step for that account at most once in six hours, so leaving it ("Try again
 * later", or the browser's Back) is not undone at the next visit to Home. As the
 * app's `markSetupShownThisRun`, which lasts until the next start. Not a session
 * cookie: a browser that restores its session keeps those for good.
 */
export const CREATOR_NAME_STEP_SHOWN_COOKIE = 'mb_name_step_shown';
const CREATOR_NAME_STEP_SHOWN_SECONDS = 6 * 60 * 60;

/** The `document.cookie` assignment that marks the step shown for `userId`. */
export function creatorNameStepShownCookie(userId: string, secure: boolean): string {
  return `${CREATOR_NAME_STEP_SHOWN_COOKIE}=${encodeURIComponent(userId)}; Max-Age=${CREATOR_NAME_STEP_SHOWN_SECONDS}; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** What the shown cookie holds: the account the step last opened for in this browser session. */
export function readCreatorNameStepShownFor(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Whether Home sends the account to the name step (owner, 2026-11-08 for the
 * app: "Yes, reopen it"): a registered account without a creator name, that
 * never chose "Set up later" (kept in its metadata from before the name was
 * required), and that the step has not opened for in this browser session.
 * Nothing is decided while the profile is unknown.
 */
export function shouldReopenCreatorNameStep({
  identity,
  userId,
  userMetadata,
  isGuest,
  shownFor,
}: {
  identity: PublicIdentityProfile | null;
  userId: string;
  userMetadata: unknown;
  isGuest: boolean;
  shownFor: string | null;
}): boolean {
  if (isGuest || !identity) return false;
  if (getCreatorProfileReadiness(identity).publicPublishReady) return false;
  if (hasSkippedProfileOnboarding(userMetadata)) return false;
  return shownFor !== userId;
}

function readSignInName(user: SignedInUser): string {
  const metadata = user?.user_metadata ?? {};
  const name = typeof metadata.full_name === 'string'
    ? metadata.full_name
    : typeof metadata.name === 'string'
      ? metadata.name
      : '';
  return name.trim();
}

/** The display name the step opens with, as the app's: the profile's, the sign-in's, the email's start, else "Creator". */
export function startingCreatorDisplayName(profileDisplayName: string | null | undefined, user: SignedInUser): string {
  return profileDisplayName?.trim()
    || readSignInName(user)
    || user?.email?.split('@')[0]?.trim()
    || 'Creator';
}

/** A suggestion never offers a reserved handle (the server would refuse it). */
export function isSuggestableHandle(handle: string): boolean {
  return !getReservedProfileUsernameError(handle, null);
}

export type CreatorNameStepStart = {
  displayName: string;
  username: string;
  /** The handle this step made, while the field still holds it; null for a handle of the account's own. */
  suggestion: HandleSuggestion | null;
};

/**
 * Where the fields start. A handle the account already claimed is kept; any
 * other (the signup placeholder `creator-xxxxxxxx`) gives way to one made from
 * the name or the email, else `creator` and three digits (owner, 2026-11-08).
 */
export function startCreatorNameStep(
  identity: PublicIdentityProfile | null,
  user: SignedInUser,
  random: () => number = Math.random,
): CreatorNameStepStart {
  const displayName = startingCreatorDisplayName(identity?.displayName, user);
  if (isClaimedProfileUsername(identity?.username)) {
    return { displayName, username: normalizeUsername(identity?.username) ?? '', suggestion: null };
  }
  const first = firstHandleSuggestion(displayName, user?.email ?? null, isSuggestableHandle, random);
  return { displayName, username: first, suggestion: startHandleSuggestion(first) };
}

/** Whether a handle has the shape every handle needs (the signup placeholder has it too). */
export function isWellFormedHandle(username: string): boolean {
  const handle = normalizeUsername(username);
  return Boolean(handle && (isClaimedProfileUsername(handle) || isGeneratedProfileUsername(handle)));
}

/**
 * A refusal the step can give with no round trip, as the app's
 * `readLocalUsernameRejection`: the signup placeholder and a reserved handle,
 * in the server's words. A handle still being typed (too short, say) is no
 * refusal: the line states the rule and Save waits.
 */
export function localHandleRefusal(username: string, savedUsername: string | null | undefined): string | null {
  const handle = normalizeUsername(username);
  if (!handle || !isWellFormedHandle(handle)) return null;
  return validateProfileUpdate({ username: handle }).fieldErrors.username
    ?? getReservedProfileUsernameError(handle, savedUsername)
    ?? null;
}

/** The line under the handle, and how it reads. */
export type HandleLine = {
  tone: 'rule' | 'checking' | 'available' | 'error';
  text: string;
};

export const HANDLE_CHECKING_TEXT = 'Checking availability…';
export const HANDLE_AVAILABLE_TEXT = 'This creator name is available.';
export const HANDLE_UNAVAILABLE_TEXT = 'This creator name is unavailable.';
export const HANDLE_JUST_CLAIMED_TEXT = 'That handle was just claimed. Try another one.';

export type HandleCheck =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available' }
  | { state: 'taken'; message: string };

/**
 * What the line says, in the app's order (`app/onboarding.tsx`): a refusal of
 * this very handle by the save, then the step's own refusal, then the live
 * check, else the rule. A taken suggestion is never drawn as taken: it is
 * swapped in the same step that learns it (`creatorNameStepReducer`), unless
 * the handle field has the cursor.
 */
export function describeHandleLine({
  username,
  refusedAtSave,
  localRefusal,
  check,
}: {
  username: string;
  refusedAtSave: { handle: string; message: string } | null;
  localRefusal: string | null;
  check: HandleCheck;
}): HandleLine {
  const refusal = (refusedAtSave?.handle === username ? refusedAtSave.message : null)
    ?? localRefusal
    ?? (check.state === 'taken' ? check.message || HANDLE_UNAVAILABLE_TEXT : null);
  if (refusal) return { tone: 'error', text: refusal };
  if (check.state === 'checking') return { tone: 'checking', text: HANDLE_CHECKING_TEXT };
  if (check.state === 'available') return { tone: 'available', text: HANDLE_AVAILABLE_TEXT };
  return { tone: 'rule', text: PUBLIC_HANDLE_RULE };
}

/** The two fields, and what the step keeps about the handle it suggested. */
export type CreatorNameStepState = {
  displayName: string;
  username: string;
  /** The handle this step made, while the field still holds it (`ugc-mobile/.../handle-suggestion.ts`). */
  suggestion: HandleSuggestion | null;
  /** The handle field has the cursor: nothing moves the handle then (owner, 2026-11-08). */
  handleFocused: boolean;
  /** A save is under way: both fields hold still. */
  saving: boolean;
  /** The live check's last word, and the handle it was about. */
  answer: { handle: string; check: HandleCheck } | null;
  /** The last swap, in words for a screen reader. */
  swapNotice: string | null;
};

/**
 * What happens to the fields. `roll` is a `Math.random()` taken by the caller,
 * so the step stays a pure function: a swap or a follow that needs a number
 * (`<handle>-NNN`) uses it.
 */
export type CreatorNameStepAction =
  | { type: 'name-typed'; value: string; roll: number }
  | { type: 'handle-typed'; value: string }
  | { type: 'handle-focused' }
  | { type: 'handle-left'; roll: number }
  | { type: 'checked'; handle: string; check: HandleCheck; roll: number }
  | { type: 'save-started' }
  | { type: 'save-ended'; roll: number };

export function initialCreatorNameStepState(start: CreatorNameStepStart): CreatorNameStepState {
  return {
    displayName: start.displayName,
    username: start.username,
    suggestion: start.suggestion,
    handleFocused: false,
    saving: false,
    answer: null,
    swapNotice: null,
  };
}

/**
 * A suggestion the check found taken becomes `<handle>-NNN`, at most three
 * times in a visit, and never while the handle field has the cursor or a save
 * runs (the app's `shouldSwapHandleSuggestion`): the swap waits for the field
 * to be left, or the save to end.
 */
function swapTakenSuggestion(state: CreatorNameStepState, roll: number): CreatorNameStepState {
  const taken = state.answer?.handle === state.username && state.answer.check.state === 'taken';
  if (!shouldSwapHandleSuggestion(state.suggestion, {
    username: state.username,
    taken,
    fieldFocused: state.handleFocused,
    saving: state.saving,
  })) {
    return state;
  }
  const next = swapHandleSuggestion(state.suggestion, () => roll);
  return {
    ...state,
    suggestion: next,
    username: next.current,
    swapNotice: `${state.suggestion.current} is taken. Suggested handle: ${next.current}.`,
  };
}

/**
 * The step's fields as the app's identity stage keeps them: the handle follows
 * the display name while it still holds the suggestion; anything typed in the
 * handle field is the creator's own and ends the suggestion; and once the
 * handle field has the cursor, nothing changes the handle until it is left.
 */
export function creatorNameStepReducer(
  state: CreatorNameStepState,
  action: CreatorNameStepAction,
): CreatorNameStepState {
  switch (action.type) {
    case 'name-typed': {
      const named = { ...state, displayName: action.value };
      if (!state.suggestion || state.suggestion.current !== state.username || state.handleFocused || state.saving) {
        return named;
      }
      // A name that makes no handle keeps the last one; a handle already found
      // taken comes back numbered (followNameWithHandleSuggestion).
      const next = followNameWithHandleSuggestion(state.suggestion, action.value, isSuggestableHandle, () => action.roll);
      return next ? swapTakenSuggestion({ ...named, suggestion: next, username: next.current }, action.roll) : named;
    }
    case 'handle-typed':
      if (state.saving) return state;
      return { ...state, suggestion: null, username: normalizeHandleInput(action.value) };
    case 'handle-focused':
      return { ...state, handleFocused: true };
    case 'handle-left':
      return swapTakenSuggestion({ ...state, handleFocused: false }, action.roll);
    case 'checked':
      return swapTakenSuggestion({ ...state, answer: { handle: action.handle, check: action.check } }, action.roll);
    case 'save-started':
      return { ...state, saving: true };
    case 'save-ended':
      return swapTakenSuggestion({ ...state, saving: false }, action.roll);
    default:
      return state;
  }
}
