/**
 * The invite code of the account signed in on this phone, as the app's share
 * links read it (`buildShareUrl`, `ownProfileShareUrl`).
 *
 * Only the holder lives here, with no imports: the view models that build links
 * read it, and they stay free of Expo and React Native so they run under vitest.
 * What fills it, from the phone's storage and from the server, is
 * `invite-share-code.ts`.
 */
let held: { userId: string; code: string | null; readAt: number | null } | null = null;

/** The signed-in account's invite code, when the app holds it. Null otherwise. */
export function currentInviteShareCode(): string | null {
  return held?.code ?? null;
}

/** What is held, for the module that fills it. */
export function heldInviteShareCode(): { userId: string; code: string | null; readAt: number | null } | null {
  return held;
}

export function holdInviteShareCode(userId: string, code: string | null, readAt: number | null): void {
  held = { userId, code, readAt };
}

/**
 * Lets go of the code, when the account signs out or another signs in: a link
 * shared after that must not carry the last account's invite.
 */
export function forgetInviteShareCode(): void {
  held = null;
}
