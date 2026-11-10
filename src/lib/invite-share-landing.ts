'use client';

import { useEffect, useRef, useState } from 'react';

import { pushToast } from '@/components/feedback-state';
import {
  clearStoredInviteHandoff,
  inviteHandoffDismissed,
  isInAppBrowser,
  readInviteHandoffPreview,
  readStoredInviteHandoff,
  storeInviteHandoff,
  withoutInviteHandoffPreview,
  type StoredInviteHandoff,
} from '@/lib/invite-handoff';

import {
  INVITE_SHARE_DISCLOSURE,
  normalizeInviteShareCode,
  readInviteShareCode,
  withoutInviteShareCode,
} from '../../ugc-mobile/lib/invite-share-link/invite-share-link';

export { INVITE_SHARE_DISCLOSURE };

/** Waits before the second and third try of a visit that failed to record. */
export const INVITE_VISIT_RETRY_DELAYS_MS = [2_000, 8_000] as const;

/**
 * A shared link's invite that could not be recorded (offline, an outage), kept
 * for this tab so the sign-in page records it before an account is made: a
 * visit made after the account exists is refused (re-review of 2026-11-10).
 */
export const PENDING_SHARED_INVITE_KEY = 'mb.shared-invite-pending.v1';

function pendingStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** What recording a shared link's invite came to (`recordInviteVisitFromSharedLink`). */
export type SharedLinkInviteVisit = { recorded: boolean; keptCode: string | null };

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
 *
 * `recorded` is true when the server kept this link's visit. `keptCode` is the
 * invite this browser now holds, for handing on to the app
 * (`src/lib/invite-handoff.ts`): this link's, an earlier one the server kept
 * in its place, or this link's again when the request never got through (the
 * app records a visit of its own). Null when there is none to hand on.
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
}): Promise<SharedLinkInviteVisit> {
  const code = readInviteShareCode(search);
  if (!code || viewerHasAccount) return { recorded: false, keptCode: null };

  for (let attempt = 0; attempt <= INVITE_VISIT_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(INVITE_VISIT_RETRY_DELAYS_MS[attempt - 1]!);
    try {
      const response = await fetchImpl('/api/referrals/visit', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, source: 'web', kind: 'shared_link', next: path }),
      });
      if (response.ok) {
        pendingStorage()?.removeItem(PENDING_SHARED_INVITE_KEY);
        const body = await response.json().catch(() => null) as { code?: unknown; preserved?: unknown } | null;
        // Only this link's invite, newly kept: an earlier invite the browser
        // keeps is someone else's to disclose (re-review of 2026-11-10).
        return {
          recorded: body?.preserved !== true && body?.code === code,
          keptCode: normalizeInviteShareCode(body?.code) ?? code,
        };
      }
      if (response.status !== 429 && response.status < 500) return { recorded: false, keptCode: null };
    } catch {
      // Offline or cut off: try again.
    }
  }
  try {
    pendingStorage()?.setItem(PENDING_SHARED_INVITE_KEY, JSON.stringify({ code, path }));
  } catch {
    // Nothing to keep it in.
  }
  return { recorded: false, keptCode: code };
}

/**
 * Records the shared link's invite this tab could not record, before a sign-in
 * starts (`LoginClient`). One try, bounded: a sign-in never waits on it long.
 */
export async function settlePendingSharedInviteVisit({
  fetchImpl = fetch,
  timeoutMs = 2_500,
}: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<void> {
  const storage = pendingStorage();
  let pending: { code?: unknown; path?: unknown } | null = null;
  try {
    pending = JSON.parse(storage?.getItem(PENDING_SHARED_INVITE_KEY) ?? 'null');
  } catch {
    pending = null;
  }
  const code = typeof pending?.code === 'string' ? readInviteShareCode(`r=${pending.code}`) : null;
  if (!code) {
    storage?.removeItem(PENDING_SHARED_INVITE_KEY);
    return;
  }
  const path = typeof pending?.path === 'string' ? pending.path : '/';
  const attempt = (async () => {
    try {
      const response = await fetchImpl('/api/referrals/visit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, source: 'web', kind: 'shared_link', next: path }),
      });
      // Kept, or refused for good: either way there is nothing left to try.
      if (response.ok || (response.status !== 429 && response.status < 500)) {
        storage?.removeItem(PENDING_SHARED_INVITE_KEY);
      }
    } catch {
      // Still offline: the next sign-in tries again.
    }
  })();
  await Promise.race([attempt, wait(timeoutMs)]);
}

/**
 * The post page's and the creator page's capture of a shared link's invite,
 * once the viewer is known (`viewerKnown`): records it for a visitor with no
 * account and takes the code off the address bar either way, so a link copied
 * from there is not the sharer's (review of 2026-11-10). Once per page.
 *
 * It answers the invite this tab holds for a visitor with no account, for the
 * page's offer to carry it on (`InviteHandoffBar`, which also tells them the
 * sharer may earn from it): the one this link brought, or the one an earlier
 * page of the tab kept, so a reload still offers it. A visitor who closed the
 * offer is told by a toast instead.
 *
 * Inside another app's browser (Instagram, Facebook and the like) the code
 * stays on the address bar: nobody can join there, and "Open in browser" is the
 * way out, which opens the address as it stands.
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
}): StoredInviteHandoff | null {
  const handled = useRef(false);
  const hasAccount = useRef(viewerHasAccount);
  const [handoff, setHandoff] = useState<StoredInviteHandoff | null>(null);

  // An account holds no invite to carry on, whenever the page learns of it: a
  // session can arrive after the visit below was sent (review of 2026-11-10).
  useEffect(() => {
    hasAccount.current = viewerHasAccount;
    if (viewerKnown && viewerHasAccount) clearStoredInviteHandoff();
  }, [viewerHasAccount, viewerKnown]);

  useEffect(() => {
    if (handled.current || search === null || !viewerKnown) return;
    handled.current = true;

    if (!readInviteShareCode(search)) {
      // No invite on this link: the one an earlier page of the tab kept, if any.
      const stored = viewerHasAccount ? null : readStoredInviteHandoff();
      if (stored) queueMicrotask(() => setHandoff(stored));
      return;
    }

    // The preview switch goes off the address everywhere; the code stays on it
    // only inside another app's browser.
    const { pathname, search: currentSearch, hash } = window.location;
    const address = `${pathname}${currentSearch}${hash}`;
    const withoutPreview = withoutInviteHandoffPreview(address);
    const cleaned = isInAppBrowser(window.navigator.userAgent) ? withoutPreview : withoutInviteShareCode(withoutPreview);
    if (cleaned !== address) window.history.replaceState(window.history.state, '', cleaned);

    const preview = readInviteHandoffPreview(search);
    void recordInviteVisitFromSharedLink({ search, path, viewerHasAccount }).then(({ recorded, keptCode }) => {
      if (keptCode && !hasAccount.current) {
        const kept: StoredInviteHandoff = { code: keptCode, kind: 'shared_link', path, preview };
        storeInviteHandoff(kept);
        setHandoff(kept);
      }
      if (recorded && inviteHandoffDismissed()) {
        pushToast({ tone: 'info', message: INVITE_SHARE_DISCLOSURE, durationMs: 8_000 });
      }
    });
  }, [path, search, viewerHasAccount, viewerKnown]);

  return viewerHasAccount ? null : handoff;
}
