import type { AuthNotice } from './auth-error-copy';
import { INVITE_SHARE_DISCLOSURE } from './invite-share-link/invite-share-link';

/** What the sign-in page tells someone who came by a shared link that carried an invite. */
export const SHARED_INVITE_NOTICE: AuthNotice = {
  title: 'Joining through a shared link',
  body: INVITE_SHARE_DISCLOSURE,
  tone: 'info',
};

/**
 * The notice for the sign-in page when this phone holds an invite a shared
 * post or profile link left (`lib/use-invite-share-capture.ts`): the person
 * who shared it may earn from it, and the app says so before an account is
 * made (Terms §5; the web says so on the post page; re-review of 2026-11-10).
 * Null otherwise, and on any failure.
 *
 * The pending invite lives in SecureStore; it is loaded only when asked, so
 * the sign-in page does not load SecureStore with itself.
 */
export async function readSharedInviteNotice(): Promise<AuthNotice | null> {
  try {
    const { getPendingReferral } = await import('./referral-attribution');
    const pending = await getPendingReferral();
    return pending?.kind === 'shared_link' ? SHARED_INVITE_NOTICE : null;
  } catch {
    return null;
  }
}
