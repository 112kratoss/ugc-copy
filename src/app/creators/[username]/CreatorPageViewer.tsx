'use client';

import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useSearchParams } from 'next/navigation';

import { useAuth } from '@/components/AuthProvider';
import {
  useHasHydratedSupabaseAuthCookieHint,
  useSupabaseAuthCookieHint,
} from '@/components/useSupabaseAuthCookieHint';
import type { CreatorProfilePageData } from '@/lib/creator-profile';
import { useOwnerCreatorProfile, type OwnerCreatorProfile } from '@/lib/owner-page-edits';
import type { EditableCreatorProfile } from '@/lib/profile';
import { SHARE_SOURCE_QUERY_PARAM } from '@/lib/share';

import { BlockedCreatorPanel } from './BlockedCreatorPanel';
import { CreatorContentTabs } from './CreatorContentTabs';
import CreatorNotFound from './not-found';
import { ProfileActions } from './ProfileActions';

/**
 * The creator page is one cached render for everyone (ISR, `page.tsx`), drawn
 * for a signed-out visitor: the server never reads the session, a cookie, a
 * header or the query. What depends on who is looking is read here, after the
 * page has drawn:
 *
 * - which way a block runs between a signed-in viewer and the creator, from
 *   the page's own API (`GET /api/creators/{username}`): a creator who blocked
 *   the viewer is not there for them (the not-found page), and a viewer who
 *   blocked the creator sees whom they blocked, with Unblock where the posts
 *   would be and no Follow or Share;
 * - the visit a shared link brought (`?s=`), recorded by `POST /api/profile/share`;
 * - for the creator on their own page, the profile they have just saved, which
 *   the cache may not have caught up with yet (`useCreatorPageProfile`).
 *
 * Follow, Edit profile, saves and the reel already read the viewer in the
 * browser (`ProfileActions`, `CreatorContentTabs`).
 */

type CreatorBlock = 'none' | 'viewer-blocked-creator' | 'creator-blocked-viewer';

interface CreatorPageViewerState {
  block: CreatorBlock;
  /** The signed-in viewer is the creator. */
  viewerIsOwner: boolean;
  /** The viewer unblocked the creator from this page. */
  markUnblocked: () => void;
}

const CreatorPageViewerContext = createContext<CreatorPageViewerState>({
  block: 'none',
  viewerIsOwner: false,
  markUnblocked: () => undefined,
});

const VISITOR = 'visitor';

/**
 * Hands the page's query over once the page is live: the cached render has
 * none (`useSearchParams` makes the prerender skip this, inside its own
 * Suspense with no fallback).
 */
function CreatorSearchParamsReporter({ onSearch }: { onSearch: (search: string) => void }) {
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? '';
  useLayoutEffect(() => {
    onSearch(search);
  }, [onSearch, search]);
  return null;
}

export function CreatorPageViewer({
  creatorId,
  username,
  children,
}: {
  creatorId: string;
  username: string;
  children: ReactNode;
}) {
  const { session, user, isLoading } = useAuth();
  const hasAuthCookie = useSupabaseAuthCookieHint();
  const hydrated = useHasHydratedSupabaseAuthCookieHint();
  const accessToken = session?.access_token ?? null;
  const viewerUserId = accessToken ? user?.id ?? null : null;
  // As the post page reads its viewer (`useShowcasePostViewer`): null until it
  // is known whether anyone is signed in.
  const viewerKey = viewerUserId ?? (!hydrated || (hasAuthCookie && isLoading) ? null : VISITOR);
  const [search, setSearch] = useState<string | null>(null);
  const [blockRead, setBlockRead] = useState<{ viewerUserId: string; block: CreatorBlock } | null>(null);
  const shareVisitSent = useRef(false);

  // The page's own API answers a creator who blocked the viewer as missing,
  // and says so when the viewer blocked the creator. One post is enough: only
  // the answer's shape is read. A read that fails leaves the page as everyone
  // sees it; every action on it still checks the block on the server.
  useEffect(() => {
    if (!viewerUserId || !accessToken || viewerUserId === creatorId) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: '1', offset: '0' });
    void fetch(`/api/creators/${encodeURIComponent(username)}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    }).then(async (response) => {
      if (response.status === 404) {
        if (!controller.signal.aborted) setBlockRead({ viewerUserId, block: 'creator-blocked-viewer' });
        return;
      }
      if (!response.ok) return;
      const body = await response.json().catch(() => null) as { viewer?: { blockedByViewer?: unknown } } | null;
      if (controller.signal.aborted) return;
      setBlockRead({
        viewerUserId,
        block: body?.viewer?.blockedByViewer === true ? 'viewer-blocked-creator' : 'none',
      });
    }).catch(() => undefined);
    return () => controller.abort();
  }, [accessToken, creatorId, username, viewerUserId]);

  // A shared profile link carries `?s=<surface>`; links inside the product
  // never do. Sent once the viewer is known, with their session when there is
  // one, so the server records no visit across a block either way. A prefetch
  // never mounts this, and a refresh of the page does not mount it again.
  useEffect(() => {
    if (shareVisitSent.current || search === null || viewerKey === null) return;
    shareVisitSent.current = true;
    const sourceSurface = new URLSearchParams(search).get(SHARE_SOURCE_QUERY_PARAM);
    if (!sourceSurface) return;
    void fetch('/api/profile/share', {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ username, eventType: 'share_visit', sourceSurface }),
    }).catch(() => undefined);
  }, [accessToken, search, username, viewerKey]);

  const markUnblocked = useCallback(() => {
    if (viewerUserId) setBlockRead({ viewerUserId, block: 'none' });
  }, [viewerUserId]);

  const block = blockRead && blockRead.viewerUserId === viewerUserId ? blockRead.block : 'none';
  const viewerIsOwner = viewerUserId === creatorId;
  const value = useMemo(() => ({ block, viewerIsOwner, markUnblocked }), [block, markUnblocked, viewerIsOwner]);

  if (block === 'creator-blocked-viewer') {
    // The answer an unknown handle gets, its title included.
    return (
      <>
        <title>Creator Not Found | Magic Booklet</title>
        <CreatorNotFound />
      </>
    );
  }

  return (
    <CreatorPageViewerContext.Provider value={value}>
      <Suspense fallback={null}>
        <CreatorSearchParamsReporter onSearch={setSearch} />
      </Suspense>
      {children}
    </CreatorPageViewerContext.Provider>
  );
}

/**
 * The profile the page shows: the page's read, or for the creator the one they
 * last saved in this tab. A save invalidates the cached page only after its
 * answer was sent, so the refresh it starts can still be served the old one.
 */
export function useCreatorPageProfile(pageProfile: OwnerCreatorProfile): OwnerCreatorProfile {
  const { viewerIsOwner } = useContext(CreatorPageViewerContext);
  return useOwnerCreatorProfile(pageProfile.id, viewerIsOwner) ?? pageProfile;
}

/** Follow, Share and the menu, or only the menu for a viewer who blocked the creator. */
export function CreatorProfileActions({ profile }: { profile: EditableCreatorProfile }) {
  const { block } = useContext(CreatorPageViewerContext);
  return <ProfileActions profile={profile} blockedByViewer={block === 'viewer-blocked-creator'} />;
}

/** The posts, or, for a viewer who blocked the creator, Unblock where they would be. */
export function CreatorPosts({
  initialData,
  profilePath,
}: {
  initialData: CreatorProfilePageData;
  profilePath: string;
}) {
  const { block, markUnblocked } = useContext(CreatorPageViewerContext);
  return block === 'viewer-blocked-creator' ? (
    <BlockedCreatorPanel
      creatorId={initialData.profile.id}
      username={initialData.profile.username}
      onUnblocked={markUnblocked}
    />
  ) : (
    <CreatorContentTabs initialData={initialData} profilePath={profilePath} />
  );
}
