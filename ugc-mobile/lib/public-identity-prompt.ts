import type { ProfileResponse } from './types';

/**
 * Asking for the name and handle a public post needs, as a call you can make
 * from anywhere: the post lifecycle asks when the server refuses a post made
 * public from a list because its owner has neither yet.
 *
 * Split from the sheet that draws it (`components/public-identity-sheet.tsx`)
 * as `lib/action-sheet` is from its surface, so a renderless module like
 * `post-lifecycle` can ask without importing React.
 */

export type PublicIdentityOutcome =
  | { status: 'saved'; profile: ProfileResponse }
  | { status: 'cancelled' }
  /** No sheet is mounted (a focused component test): the caller says what it would have said without asking. */
  | { status: 'unavailable' };

type Presenter = (settle: (outcome: PublicIdentityOutcome) => void) => void;

let presenter: Presenter | null = null;

/** Called by `PublicIdentitySheetHost` when it mounts. Returns the unregister. */
export function registerPublicIdentityPresenter(next: Presenter) {
  presenter = next;
  return () => {
    if (presenter === next) presenter = null;
  };
}

/**
 * Ask for the name and handle, and save them to the profile. Resolves once
 * they are saved or the sheet is put away; a second question while one is up
 * waits for the same answer.
 */
export function requestPublicIdentity(): Promise<PublicIdentityOutcome> {
  const present = presenter;
  if (!present) return Promise.resolve({ status: 'unavailable' });
  return new Promise((resolve) => present(resolve));
}
