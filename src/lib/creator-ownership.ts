'use client';

import { useCallback } from 'react';

import { useAuth } from '@/components/AuthProvider';
import { useSupabaseAuthCookieHint } from '@/components/useSupabaseAuthCookieHint';
import { canStyleRuleNameAuthUser } from '@/lib/app-shell-account-restore';
import { readSupabaseAuthCookieUserId } from '@/lib/supabase-auth-cookie';
import { useViewerSessionCheck, type ViewerSessionCheck } from '@/lib/viewer-session-check';

/**
 * Whether the creator of what a page shows is the one looking, as the page knows it at this render:
 * a post's creator on its post page (`useShowcasePostViewer`), a creator on their own page
 * (`CreatorContentTabs`). What only they get there (the post page's Owner tools, their Remix, their
 * recipe as theirs; the creator page's "Your recipe" on each tile) follows it from the first frame.
 * Both pages are drawn once for everyone and check the session in the browser, and a client
 * navigation starts that check again (`OptionalAuth`): drawn from the check alone, the creator saw
 * what everyone else gets until it ended, Owner tools' place taken by the report row on a post, and
 * "Free recipe" on every tile of their own page (sweeps of 2026-11-17).
 *
 * - `owner`: the check has named the creator.
 * - `owner-checking`: the browser's session cookie names the creator and the check has not ended,
 *   its deadline passed or not: their parts are drawn, inert where they act until it ends. The
 *   deadline (`useViewerSessionCheck`) stops a page waiting for the reader's own parts, never for the
 *   creator's: only the check's answer says the cookie is not theirs.
 * - `unread`: the server's HTML and the render that hydrates it, where no cookie can be read. Both
 *   are drawn, and the root element's `data-auth-user` mark, set from the session cookie before the
 *   first paint (`app-shell-account-restore.ts`), shows the creator their parts and everyone else
 *   what they get. Only for a creator a style rule can name (`canStyleRuleNameAuthUser`); any other
 *   is `other` until the check ends.
 * - `other`: anyone else: a visitor, a cookie naming someone else, and a check that ended with no one.
 */
export type CreatorOwnership = 'owner' | 'owner-checking' | 'unread' | 'other';

export function resolveCreatorOwnership({
  creatorId,
  viewerUserId,
  viewerCheck,
  checkedCookieUserId,
}: {
  /** The page's creator; null for a post with no creator account, which is no one's own. */
  creatorId: string | null;
  /** The viewer the check has named, with their session; null until then, and for no one. */
  viewerUserId: string | null;
  viewerCheck: ViewerSessionCheck;
  /** The account the session cookie names while the provider still checks it; null otherwise. */
  checkedCookieUserId: string | null;
}): CreatorOwnership {
  if (viewerUserId && creatorId && viewerUserId === creatorId) return 'owner';
  if (viewerUserId || !creatorId) return 'other';
  if (viewerCheck === 'unread') return canStyleRuleNameAuthUser(creatorId) ? 'unread' : 'other';
  return checkedCookieUserId === creatorId ? 'owner-checking' : 'other';
}

/**
 * `resolveCreatorOwnership` for this browser's viewer, with the session check it was read from
 * (`useViewerSessionCheck`), for a page that also says when a check of the creator's cookie has
 * outlasted its deadline (the post page's held recipe).
 */
export function useCreatorOwnershipAndSessionCheck(creatorId: string | null): {
  ownership: CreatorOwnership;
  viewerCheck: ViewerSessionCheck;
} {
  const { session, user, isLoading } = useAuth();
  const hasAuthCookie = useSupabaseAuthCookieHint();
  const viewerCheck = useViewerSessionCheck();
  const viewerUserId = session?.access_token ? user?.id ?? null : null;
  // Read only where the answer turns on it: once hydrated (the server and the render that hydrates
  // have no cookie to read), with no one named yet, while the provider is checking a cookie.
  const checkedCookieUserId = creatorId && !viewerUserId && viewerCheck !== 'unread' && hasAuthCookie && isLoading
    ? readSupabaseAuthCookieUserId()
    : null;
  return {
    ownership: resolveCreatorOwnership({ creatorId, viewerUserId, viewerCheck, checkedCookieUserId }),
    viewerCheck,
  };
}

/** `resolveCreatorOwnership` for this browser's viewer. */
export function useCreatorOwnership(creatorId: string | null): CreatorOwnership {
  return useCreatorOwnershipAndSessionCheck(creatorId).ownership;
}

/**
 * `resolveCreatorOwnership` for this browser's viewer and any creator, for a page that lists many
 * creators' work (the Marketplace, whose tiles are each their seller's): the viewer and the account the
 * session cookie names are read once for every tile. A new function only when what it answers changes.
 */
export function useCreatorOwnershipResolver(): (creatorId: string | null) => CreatorOwnership {
  const { session, user, isLoading } = useAuth();
  const hasAuthCookie = useSupabaseAuthCookieHint();
  const viewerCheck = useViewerSessionCheck();
  const viewerUserId = session?.access_token ? user?.id ?? null : null;
  // As above: read only once hydrated, with no one named yet, while the provider checks a cookie.
  const checkedCookieUserId = !viewerUserId && viewerCheck !== 'unread' && hasAuthCookie && isLoading
    ? readSupabaseAuthCookieUserId()
    : null;
  return useCallback(
    (creatorId: string | null) => resolveCreatorOwnership({ creatorId, viewerUserId, viewerCheck, checkedCookieUserId }),
    [viewerUserId, viewerCheck, checkedCookieUserId],
  );
}
