'use client';

import { useEffect, useRef } from 'react';

import { pushToast } from '@/components/feedback-state';

import { readInviteShareCode, withoutInviteShareCode } from '../../ugc-mobile/lib/invite-share-link/invite-share-link';

/** Waits before the second and third try of a visit that failed to record. */
export const INVITE_VISIT_RETRY_DELAYS_MS = [2_000, 8_000] as const;

/**
 * Told to a visitor whose invite was recorded: the person who shared the link
 * may earn credits from it, which the share itself never said (review of
 * 2026-11-10; Terms §5).
 */
export const INVITE_SHARE_DISCLOSURE =
  'Shared with an invite: the person who shared this may earn bonus credits if you join.';

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Records the invite a shared link carried (`?r=<code>`), for the page that
 * link opened: the post page and the creator page.
 *
 * It is the invite landing's own request, `POST /api/referrals/visit`, made
 * without the landing: the visitor came to see a post, and sees it. The answer
 * sets the 30-day referral cookie, so an account made in this browser inside
 * the program's window is claimed for the sharer by `/auth/callback`, as after
 * `/r/<code>`. The visit says it came by a shared link: an invite link opened
 * later in this browser replaces it, and it replaces nothing.
 *
 * Only a visitor with no account is recorded. An account that exists can never
 * be invited (`claim_referral_visit` answers `existing_account`), so its visit
 * would only inflate the sharer's count; that covers the sharer opening their
 * own link. A guest is a visitor here: it has no account yet.
 *
 * A request that fails (offline, an outage, a rate limit) is tried twice more;
 * a code the server does not know (404) or refuses (400, 403) is not.
 * Resolves true when the server kept a visit.
 */
export async function recordInviteVisitFromSharedLink({
  search,
  path,
  viewerHasAccount,
  fetchImpl = fetch,
  sleep = wait,
}: {
  /** The query the page was opened with, with or without its `?`. */
  search: string | null | undefined;
  /** The page's own path, kept with the visit as where the invite led. */
  path: string;
  viewerHasAccount: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const code = readInviteShareCode(search);
  if (!code || viewerHasAccount) return false;

  for (let attempt = 0; attempt <= INVITE_VISIT_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(INVITE_VISIT_RETRY_DELAYS_MS[attempt - 1]!);
    try {
      const response = await fetchImpl('/api/referrals/visit', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, source: 'web', kind: 'shared_link', next: path }),
      });
      if (response.ok) return true;
      if (response.status !== 429 && response.status < 500) return false;
    } catch {
      // Offline or cut off: try again.
    }
  }
  return false;
}

/**
 * The post page's and the creator page's capture of a shared link's invite,
 * once the viewer is known (`viewerKnown`): records it for a visitor with no
 * account, tells them the sharer may earn from it, and takes the code off the
 * address bar either way, so a link copied from there is not the sharer's
 * (review of 2026-11-10). Once per page.
 */
export function useInviteVisitFromSharedLink({
  search,
  path,
  viewerKnown,
  viewerHasAccount,
}: {
  search: string | null;
  path: string;
  viewerKnown: boolean;
  viewerHasAccount: boolean;
}) {
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current || search === null || !viewerKnown) return;
    if (!readInviteShareCode(search)) return;
    handled.current = true;

    const { pathname, search: currentSearch, hash } = window.location;
    const withoutCode = withoutInviteShareCode(`${pathname}${currentSearch}${hash}`);
    if (withoutCode !== `${pathname}${currentSearch}${hash}`) {
      window.history.replaceState(window.history.state, '', withoutCode);
    }

    void recordInviteVisitFromSharedLink({ search, path, viewerHasAccount }).then((recorded) => {
      if (recorded) pushToast({ tone: 'info', message: INVITE_SHARE_DISCLOSURE, durationMs: 8_000 });
    });
  }, [path, search, viewerHasAccount, viewerKnown]);
}
