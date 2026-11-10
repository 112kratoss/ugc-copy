import { readInviteShareCode } from '../../ugc-mobile/lib/invite-share-link/invite-share-link';

/**
 * Records the invite a shared link carried (`?r=<code>`), for the page that
 * link opened: the post page and the creator page.
 *
 * It is the invite landing's own request, `POST /api/referrals/visit`, made
 * without the landing: the visitor came to see a post, and sees it. The answer
 * sets the 30-day referral cookie, so an account made in this browser inside
 * the program's window is claimed for the sharer by `/auth/callback`, as after
 * `/r/<code>`. The route keeps the first invite a browser opened, so a second
 * shared link changes nothing.
 *
 * Only a visitor with no account is recorded. An account that exists can never
 * be invited (`claim_referral_visit` answers `existing_account`), so its visit
 * would only inflate the sharer's count; that covers the sharer opening their
 * own link. A guest is a visitor here: it has no account yet.
 *
 * Fire and forget. Nothing on the page waits for it, and a code the server no
 * longer knows (a link switched off, an account deleted) is refused there.
 */
export function recordInviteVisitFromSharedLink({
  search,
  path,
  viewerHasAccount,
  fetchImpl = fetch,
}: {
  /** The query the page was opened with, with or without its `?`. */
  search: string | null | undefined;
  /** The page's own path, kept with the visit as where the invite led. */
  path: string;
  viewerHasAccount: boolean;
  fetchImpl?: typeof fetch;
}): boolean {
  const code = readInviteShareCode(search);
  if (!code || viewerHasAccount) return false;

  void fetchImpl('/api/referrals/visit', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, source: 'web', next: path }),
  }).catch(() => undefined);
  return true;
}
