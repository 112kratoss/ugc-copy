'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { useAuth } from '@/components/AuthProvider';
import {
  useHasHydratedSupabaseAuthCookieHint,
  useSupabaseAuthCookieHint,
} from '@/components/useSupabaseAuthCookieHint';
import type { PostRemixCapability, PostRemixTarget } from '@/lib/post-resource-bundles';
import type { PostResourceBundleDetail } from '@/lib/post-resource-bundles-server';
import { useOwnerPostVisibility } from '@/lib/owner-page-edits';
import { isPostResourceWebCashEligible } from '@/lib/post-resource-commerce';
import {
  SHARE_SOURCE_QUERY_PARAM,
  SHOWCASE_DELIVERY_QUERY_PARAM,
  getShowcaseReturnContext,
  type ShowcaseReturnContext,
} from '@/lib/share';
import { fetchShowcaseViewerExclusions } from '@/lib/showcase-viewer-exclusions-client';

import type { BundleRefreshPayload } from './PostResourceBundlePanel';

/**
 * The post page is one cached render for everyone (ISR, `page.tsx`): the
 * server reads the post as a signed-out visitor would, in no country, and
 * never reads the session, the request's headers or its query. Everything that
 * depends on who is looking, from where, or how they got here is read here, in
 * the browser, after the page has drawn:
 *
 * - who the viewer is (`useAuth`), and so whether the post is theirs;
 * - the recipe as this viewer may read it (`GET /api/posts/{id}/resource-bundle`):
 *   unlocked for its buyers and its owner, a delisted or retired one for the
 *   people who bought it, priced in the viewer's currency;
 * - whether a block stands between the viewer and the creator either way
 *   (`POST /api/showcase/viewer-exclusions`), which hides the post as the
 *   app's by-id read does;
 * - the query the page was opened with: its way back (`from`, `returnTo`), the
 *   ranked card that opened it (`delivery`) and the share that brought a
 *   visitor (`s`), recorded as a visit by `POST /api/showcase/share`;
 * - for the owner, the visibility they have just saved from this page, which
 *   the cache may not have caught up with yet (`owner-page-edits.ts`).
 *
 * Nothing it learns is ever written back into the page the server caches.
 */

export interface ShowcasePostRemix {
  canRemix: boolean;
  remixCapability: PostRemixCapability;
  remixTarget: PostRemixTarget;
}

/** What the recipe panel reports once it has unlocked or re-read the recipe. */
export type ShowcasePostBundleAccess = BundleRefreshPayload;

export interface ShowcasePostViewer {
  /** The signed-in viewer, once the session check found one. */
  viewerUserId: string | null;
  viewerIsOwner: boolean;
  /** The page's visibility, or for its owner the one they last saved here. */
  visibility: 'public' | 'unlisted';
  /** The recipe as this viewer may read it: the page's (a visitor's) until their own read lands. */
  bundle: PostResourceBundleDetail | null;
  /**
   * Changes once, when the viewer's own read of the recipe lands, so the panel
   * starts again from it; never when the panel itself reports an unlock.
   */
  bundlePanelKey: string;
  /** The viewer has not got the recipe: the page pitches it. */
  lockedViewer: boolean;
  remix: ShowcasePostRemix;
  /** A block either way between the viewer and the creator: the post is not shown. */
  blocked: boolean;
  returnContext: ShowcaseReturnContext;
  deliveryId: string | null;
  /** For `ShowcaseSearchParamsReporter`. */
  reportSearch: (search: string) => void;
  /** The panel unlocked or re-read the recipe for this viewer. */
  applyBundleAccess: (access: ShowcasePostBundleAccess) => void;
  /** The viewer blocked the creator from this page. */
  markCreatorBlocked: () => void;
}

const VISITOR = 'visitor';

type ViewerBundle = {
  viewerKey: string;
  bundle: PostResourceBundleDetail | null;
  /** Who last said: the viewer's read of the recipe, or the panel after an unlock. */
  source: 'read' | 'panel';
  /**
   * What the panel was started from: 'read' once the viewer's read landed
   * before any unlock, which starts it again; an unlock never does.
   */
  panelStart: 'page' | 'read';
};

/**
 * A post's Remix as this viewer has it. Only the recipe's lock depends on the
 * viewer (`resolvePostRemixCapability`): a Remix the recipe holds back opens
 * for whoever has the recipe, its target unchanged.
 */
export function remixForViewer(
  pageRemix: ShowcasePostRemix,
  bundle: Pick<PostResourceBundleDetail, 'viewerCanAccess' | 'viewerIsOwner'> | null,
): ShowcasePostRemix {
  if (pageRemix.remixCapability !== 'unlock_required' || !bundle) return pageRemix;
  if (!bundle.viewerCanAccess && !bundle.viewerIsOwner) return pageRemix;
  return {
    canRemix: pageRemix.remixTarget !== 'workflow' && pageRemix.remixTarget !== 'text_template',
    remixCapability: 'public',
    remixTarget: pageRemix.remixTarget,
  };
}

/**
 * Whether a visitor's read of the recipe would price it differently from the
 * page's: only a cash price has a currency (`buildPriceQuote` quotes rupees in
 * India); a free or credits-only recipe reads the same everywhere.
 */
function needsLocalQuote(bundle: PostResourceBundleDetail | null): boolean {
  return Boolean(
    bundle
    && bundle.accessMode === 'paid'
    && isPostResourceWebCashEligible(Math.max(0, Math.round(bundle.priceUsdCents))),
  );
}

export function useShowcasePostViewer({
  postId,
  creatorId,
  visibility,
  isNsfwCovered,
  pageBundle,
  pageRemix,
}: {
  postId: string;
  creatorId: string | null;
  visibility: 'public' | 'unlisted';
  /** The post is under its NSFW cover: its recipe comes with the reveal, never from here. */
  isNsfwCovered: boolean;
  pageBundle: PostResourceBundleDetail | null;
  pageRemix: ShowcasePostRemix;
}): ShowcasePostViewer {
  const { session, user, isLoading } = useAuth();
  const hasAuthCookie = useSupabaseAuthCookieHint();
  const hydrated = useHasHydratedSupabaseAuthCookieHint();
  const accessToken = session?.access_token ?? null;
  const viewerUserId = accessToken ? user?.id ?? null : null;
  // Who is looking, once that is known: the viewer's id, VISITOR when no one is
  // signed in, null on the server, during hydration and while a sign-in cookie
  // is being checked, so a signed-in viewer is never first read as a visitor.
  const viewerKey = viewerUserId ?? (!hydrated || (hasAuthCookie && isLoading) ? null : VISITOR);
  const viewerIsOwner = Boolean(viewerUserId && creatorId && viewerUserId === creatorId);
  const effectiveVisibility = useOwnerPostVisibility(postId, viewerIsOwner) ?? visibility;

  // `null` until `ShowcaseSearchParamsReporter` has read the address.
  const [search, setSearch] = useState<string | null>(null);
  const [viewerBundle, setViewerBundle] = useState<ViewerBundle | null>(null);
  const [blockedFor, setBlockedFor] = useState<string | null>(null);
  const shareVisitSent = useRef(false);

  const ownBundle = viewerBundle && viewerBundle.viewerKey === viewerKey ? viewerBundle : null;
  const bundle = ownBundle ? ownBundle.bundle : pageBundle;
  const lockedViewer = Boolean(bundle && !bundle.viewerCanAccess && !bundle.viewerIsOwner);
  const remix = useMemo(() => remixForViewer(pageRemix, bundle), [bundle, pageRemix]);

  const params = useMemo(() => new URLSearchParams(search ?? ''), [search]);
  const returnContext = useMemo(() => getShowcaseReturnContext({
    from: params.get('from'),
    returnTo: params.get('returnTo'),
  }), [params]);
  const deliveryId = params.get(SHOWCASE_DELIVERY_QUERY_PARAM)?.trim() || null;

  // A signed-in viewer reads the recipe as theirs whatever the page drew: a
  // buyer keeps a delisted or retired one the page no longer shows. A visitor
  // reads it only for a price in their currency.
  const readsBundle = !isNsfwCovered
    && viewerKey !== null
    && (viewerKey !== VISITOR || needsLocalQuote(pageBundle));

  useEffect(() => {
    if (!readsBundle || viewerKey === null) return;
    const controller = new AbortController();
    void fetch(`/api/posts/${encodeURIComponent(postId)}/resource-bundle`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
      signal: controller.signal,
    }).then(async (response) => {
      // Gone for this viewer: never published to them, taken off sale since
      // the page was cached, or a block. Any other failure keeps the page's.
      if (response.status !== 404 && !response.ok) return;
      const body = response.ok
        ? await response.json().catch(() => null) as { bundle?: PostResourceBundleDetail } | null
        : null;
      if (controller.signal.aborted || (response.ok && !body?.bundle)) return;
      const read = response.ok ? body?.bundle ?? null : null;
      // What the panel reported after an unlock is newer than a read sent before it.
      setViewerBundle((current) => (
        current?.viewerKey === viewerKey && current.source === 'panel'
          ? current
          : { viewerKey, bundle: read, source: 'read', panelStart: 'read' }
      ));
    }).catch(() => undefined);
    return () => controller.abort();
  }, [accessToken, postId, readsBundle, viewerKey]);

  // A block either way hides the post, as the app's by-id read does and as
  // blocking promises ("You will stop seeing their posts"). A check that could
  // not be made leaves the post as everyone sees it.
  useEffect(() => {
    if (!viewerUserId || !accessToken || !creatorId || creatorId === viewerUserId) return;
    const controller = new AbortController();
    void fetchShowcaseViewerExclusions({
      items: [{ id: postId, creator: { id: creatorId } }],
      accessToken,
      signal: controller.signal,
    }).then((exclusions) => {
      if (controller.signal.aborted || !exclusions) return;
      const creator = creatorId.toLowerCase();
      if (exclusions.blockedCreatorIds.some((id) => id.toLowerCase() === creator)) {
        setBlockedFor(viewerUserId);
      }
    });
    return () => controller.abort();
  }, [accessToken, creatorId, postId, viewerUserId]);

  // A share visit is a landing from a link that left the product: the address
  // carries `?s=<surface>`, and in-app links never do (they carry `from`). It
  // is sent once the viewer is known, with their session when there is one, so
  // the server records no visit across a block. A prefetch never mounts this.
  useEffect(() => {
    if (shareVisitSent.current || search === null || viewerKey === null) return;
    shareVisitSent.current = true;
    const visitParams = new URLSearchParams(search);
    const sourceSurface = visitParams.get(SHARE_SOURCE_QUERY_PARAM);
    if (effectiveVisibility !== 'public' || !sourceSurface || visitParams.get('from')) return;
    void fetch('/api/showcase/share', {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ postId, eventType: 'share_visit', sourceSurface }),
    }).catch(() => undefined);
  }, [accessToken, effectiveVisibility, postId, search, viewerKey]);

  const applyBundleAccess = useCallback((access: ShowcasePostBundleAccess) => {
    if (viewerKey === null) return;
    setViewerBundle((current) => {
      const own = current?.viewerKey === viewerKey ? current : null;
      const base = own ? own.bundle : pageBundle;
      if (!base) return current;
      return {
        viewerKey,
        bundle: {
          ...base,
          viewerCanAccess: access.viewerCanAccess,
          viewerIsOwner: access.viewerIsOwner,
          // What the panel draws from now on; the page reads no more of it than the panel does.
          resources: access.resources ? { workflowSnapshot: null, ...base.resources, ...access.resources } : null,
        },
        source: 'panel',
        panelStart: own?.panelStart ?? 'page',
      };
    });
  }, [pageBundle, viewerKey]);

  const markCreatorBlocked = useCallback(() => {
    if (viewerUserId) setBlockedFor(viewerUserId);
  }, [viewerUserId]);

  return {
    viewerUserId,
    viewerIsOwner,
    visibility: effectiveVisibility,
    bundle,
    bundlePanelKey: `${viewerKey ?? 'unknown'}:${ownBundle?.panelStart ?? 'page'}`,
    lockedViewer,
    remix,
    blocked: Boolean(viewerUserId && blockedFor === viewerUserId),
    returnContext,
    deliveryId,
    reportSearch: setSearch,
    applyBundleAccess,
    markCreatorBlocked,
  };
}

/**
 * Hands the page's query to `useShowcasePostViewer`. The cached render cannot
 * read it: `useSearchParams` makes the prerender skip this component (inside
 * its own Suspense, with no fallback), and the browser draws it as soon as the
 * page is live. A client navigation draws it in the same pass as the page, and
 * the layout effect hands the query over before that frame is painted.
 */
export function ShowcaseSearchParamsReporter({ onSearch }: { onSearch: (search: string) => void }) {
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? '';
  useLayoutEffect(() => {
    onSearch(search);
  }, [onSearch, search]);
  return null;
}
