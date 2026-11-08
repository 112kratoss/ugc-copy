import { suggestProfileHandle } from '@/lib/post-publish-policy/post-publish-policy';

const HANDLE_MAX_LENGTH = 24;

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
