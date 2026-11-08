import { suggestProfileHandle } from '@/lib/post-publish-policy/post-publish-policy';

const HANDLE_MAX_LENGTH = 24;

/** How many times the creator-name step swaps a taken suggestion for a numbered one, in all. */
export const MAX_HANDLE_SUGGESTION_SWAPS = 3;

/**
 * The handle the creator-name step starts with (owner, 2026-11-08: "a random
 * unique name ... as default"). From the name or the email, as the post
 * composer's identity sheet suggests one ("Kiran Das" → "kiran-das"), else
 * "creator" and three digits ("creator482") for a name that gives no handle,
 * such as one in another script. The server still decides whether it is free.
 */
export function firstHandleSuggestion(
  displayName: string | null | undefined,
  email: string | null | undefined,
  isUsable: (handle: string) => boolean = () => true,
  random: () => number = Math.random,
): string {
  return suggestProfileHandle(displayName, email, isUsable) || numberedHandleSuggestion('', random);
}

/**
 * The next try once a suggestion turned out taken: the same handle with three
 * digits after a hyphen ("kiran-das-482"), cut so the whole stays within the
 * 24 characters a handle may have. No base gives "creator482".
 */
export function numberedHandleSuggestion(base: string, random: () => number = Math.random): string {
  const digits = String(100 + Math.floor(random() * 900));
  if (!base) return `creator${digits}`;
  const stem = base.slice(0, HANDLE_MAX_LENGTH - digits.length - 1).replace(/-+$/, '');
  return `${stem}-${digits}`;
}

/**
 * The handle for a display name being typed, while the field still holds a
 * suggestion: from the name alone, never the email, so typing a name does not
 * fall back to it. Empty for a name that makes no handle; the caller then
 * keeps the one it has.
 */
export function handleForTypedName(
  displayName: string,
  isUsable: (handle: string) => boolean = () => true,
): string {
  return suggestProfileHandle(displayName, null, isUsable);
}

/**
 * The suggestion the creator-name step is keeping, while the field still holds
 * it. `taken` remembers every handle the check refused, so a name edited back
 * does not bring one of them again (review of #735); `swaps` counts across the
 * whole visit, never reset by a name edit.
 */
export interface HandleSuggestion {
  current: string;
  swaps: number;
  taken: readonly string[];
}

export function startHandleSuggestion(handle: string): HandleSuggestion {
  return { current: handle, swaps: 0, taken: [] };
}

/**
 * Whether a taken suggestion should be swapped now. Never while the handle
 * field has the cursor (nothing moves under it, owner 11-08), never while a
 * save is running (the fields hold still), and not past the cap.
 */
export function shouldSwapHandleSuggestion(
  suggestion: HandleSuggestion | null,
  { username, taken, fieldFocused, saving }: { username: string; taken: boolean; fieldFocused: boolean; saving: boolean },
): suggestion is HandleSuggestion {
  return Boolean(suggestion)
    && suggestion!.current === username
    && taken
    && !fieldFocused
    && !saving
    && suggestion!.swaps < MAX_HANDLE_SUGGESTION_SWAPS;
}

/** The suggestion after its current handle was found taken. */
export function swapHandleSuggestion(suggestion: HandleSuggestion, random: () => number = Math.random): HandleSuggestion {
  const base = suggestion.current.replace(/-\d{3}$/, '');
  return {
    current: numberedHandleSuggestion(base, random),
    swaps: suggestion.swaps + 1,
    taken: [...suggestion.taken, suggestion.current],
  };
}

/**
 * The suggestion after the display name changed to `displayName`, or null to
 * keep it as it is: a name that makes no handle, or the same handle. A handle
 * already found taken comes back numbered straight away while swaps remain,
 * and is passed over once they are spent.
 */
export function followNameWithHandleSuggestion(
  suggestion: HandleSuggestion,
  displayName: string,
  isUsable: (handle: string) => boolean = () => true,
  random: () => number = Math.random,
): HandleSuggestion | null {
  const handle = handleForTypedName(displayName, isUsable);
  if (!handle || handle === suggestion.current) return null;
  if (!suggestion.taken.includes(handle)) return { ...suggestion, current: handle };
  if (suggestion.swaps >= MAX_HANDLE_SUGGESTION_SWAPS) return null;
  return { ...suggestion, current: numberedHandleSuggestion(handle, random), swaps: suggestion.swaps + 1 };
}
