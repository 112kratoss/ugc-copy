'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { useAuth } from '@/components/AuthProvider';
import {
  useHasHydratedSupabaseAuthCookieHint,
  useSupabaseAuthCookieHint,
} from '@/components/useSupabaseAuthCookieHint';
import { useCreatorOwnershipAndSessionCheck, type CreatorOwnership } from '@/lib/creator-ownership';
import type { PostRemixCapability, PostRemixTarget } from '@/lib/post-resource-bundles';
import type { PostResourceBundleDetail } from '@/lib/post-resource-bundles-server';
import type { StoredInviteHandoff } from '@/lib/invite-handoff';
import { useInviteVisitFromSharedLink } from '@/lib/invite-share-landing';
import { useOwnerPostVisibility } from '@/lib/owner-page-edits';
import { postRecipeReadPath } from '@/lib/post-recipe-read';
import { isPostResourceWebCashEligible } from '@/lib/post-resource-commerce';
import {
  SHARE_SOURCE_QUERY_PARAM,
  SHOWCASE_DELIVERY_QUERY_PARAM,
  getShowcaseReturnContext,
  type ShowcaseReturnContext,
} from '@/lib/share';
import { fetchShowcaseViewerExclusions } from '@/lib/showcase-viewer-exclusions-client';
import { SESSION_CHECK_DEADLINE_MS } from '@/lib/viewer-session-check';
import {
  remixCreditUserIds,
  withoutBlockedRemixCredit,
  type RemixCredit,
} from '../../../../ugc-mobile/lib/remix-credit/remix-credit';

import type { BundleRefreshPayload } from './PostResourceBundlePanel';

/**
 * The post page is one cached render for everyone (ISR, `page.tsx`): the
 * server reads the post as a signed-out visitor would, in no country, and
 * never reads the session, the request's headers or its query. Everything that
 * depends on who is looking, from where, or how they got here is read here, in
 * the browser, after the page has drawn:
 *
 * - who the viewer is (`useAuth`), and so whether the post is theirs, decided
 *   from the session cookie while the provider checks it (`ownership`);
 * - the recipe as this viewer may read it (`GET /api/posts/{id}/resource-bundle`):
 *   unlocked for its buyers and its owner, a delisted or retired one for the
 *   people who bought it, priced in the viewer's currency; none for everyone
 *   else, answered as none rather than not found (`post-recipe-read.ts`);
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

/**
 * Whether the post is the viewer's own, as the page knows it at this render (`CreatorOwnership`,
 * which the creator page shares): it draws the rail's Owner tools for the creator and "Report post
 * or recipe" for everyone else, the creator's open Remix and their recipe as theirs, in the rail and
 * in the panel under the post. A client navigation starts the page's session check again
 * (`OptionalAuth`), and the creator saw the report row in their tools' place until it ended, about
 * 16 frames (sweep of 2026-11-17). Past the check's deadline their parts stay theirs: drawn as
 * anyone else's there, their Remix read "Remix", "Remix · Free", "Remix" when a late answer named
 * them (CI, 2026-11-17: the dev server sent supabase-js 8.2 s after the page's script).
 */
export type ShowcasePostOwnership = CreatorOwnership;

export interface ShowcasePostViewer {
  /** The signed-in viewer, once the session check found one. */
  viewerUserId: string | null;
  viewerIsOwner: boolean;
  ownership: ShowcasePostOwnership;
  /** The page's visibility, or for its owner the one they last saved here. */
  visibility: 'public' | 'unlisted';
  /** The recipe as this viewer may read it: the page's (a visitor's) until their own read lands. */
  bundle: PostResourceBundleDetail | null;
  /**
   * Changes once, when the viewer's own read of the recipe lands, so the panel
   * starts again from it; never when the panel itself reports an unlock.
   */
  bundlePanelKey: string;
  /**
   * The viewer's own read of the recipe failed (an error, or an answer that names neither a recipe
   * nor none): the page keeps its own recipe, and the creator's own, held until their read brings
   * it, says so (`creatorHold` in ShowcaseDetailBody).
   */
  bundleReadFailed: boolean;
  /**
   * The check of a session cookie naming the creator has outlasted its deadline (`owner-checking`
   * while `useViewerSessionCheck` reads `visitor`): their Owner tools and Remix still wait for its
   * answer, but their recipe, held for a read only that answer lets go out, says it could not be
   * opened, with Try again (`retryCreatorRecipe`), where it waited for good when supabase-js never
   * loaded or Supabase never answered (review of #866).
   */
  creatorCheckOverdue: boolean;
  /**
   * The creator's held recipe's Try again: the session check asked again while it is overdue
   * (`refreshSessionState`), drawn as opening for at most a check's deadline; else their read of the
   * recipe asked again.
   */
  retryCreatorRecipe: () => void;
  /** The viewer has not got the recipe: the page pitches it. */
  lockedViewer: boolean;
  /**
   * The post's Remix as this viewer has it: for the creator, from the first frame they are known
   * (`ownership`), the open Remix of their own creation, never one locked behind its recipe.
   */
  remix: ShowcasePostRemix;
  /** The creator's own Remix, which the server's HTML draws beside everyone else's (`ownership` 'unread'). */
  creatorRemix: ShowcasePostRemix;
  /** A block either way between the viewer and the creator: the post is not shown. */
  blocked: boolean;
  /**
   * The post's remix credit as this viewer may see it: the page's, without
   * anyone a block stands between them and the viewer, either way.
   */
  remixCredit: RemixCredit | null;
  returnContext: ShowcaseReturnContext;
  deliveryId: string | null;
  /** For `ShowcaseSearchParamsReporter`. */
  reportSearch: (search: string) => void;
  /** The invite a visitor with no account holds, for the page's offer to carry it on (`InviteHandoffBar`). */
  inviteHandoff: StoredInviteHandoff | null;
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

/** The recipe as its creator holds it, for `remixForViewer`. */
const CREATORS_RECIPE_ACCESS = { viewerCanAccess: true, viewerIsOwner: true } as const;

/** No Remix at all. */
const NO_REMIX: ShowcasePostRemix = { canRemix: false, remixCapability: 'none', remixTarget: null };

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
  pageRemixCredit = null,
  hasCreation,
}: {
  postId: string;
  creatorId: string | null;
  visibility: 'public' | 'unlisted';
  /** The post is under its NSFW cover: its recipe comes with the reveal, never from here. */
  isNsfwCovered: boolean;
  pageBundle: PostResourceBundleDetail | null;
  pageRemix: ShowcasePostRemix;
  /** The remix credit the page was drawn with, for everyone. */
  pageRemixCredit?: RemixCredit | null;
  /** The post was made from a creation (`generationId`), the only kind a Remix can start from. */
  hasCreation: boolean;
}): ShowcasePostViewer {
  const { session, user, isLoading, refreshSessionState } = useAuth();
  const hasAuthCookie = useSupabaseAuthCookieHint();
  const hydrated = useHasHydratedSupabaseAuthCookieHint();
  const accessToken = session?.access_token ?? null;
  const viewerUserId = accessToken ? user?.id ?? null : null;
  // Who is looking, once that is known: the viewer's id, VISITOR when no one is
  // signed in, null on the server, during hydration and while a sign-in cookie
  // is being checked, so a signed-in viewer is never first read as a visitor.
  const viewerKey = viewerUserId ?? (!hydrated || (hasAuthCookie && isLoading) ? null : VISITOR);
  const viewerIsOwner = Boolean(viewerUserId && creatorId && viewerUserId === creatorId);
  const { ownership, viewerCheck } = useCreatorOwnershipAndSessionCheck(creatorId);
  const effectiveVisibility = useOwnerPostVisibility(postId, viewerIsOwner) ?? visibility;

  // `null` until `ShowcaseSearchParamsReporter` has read the address.
  const [search, setSearch] = useState<string | null>(null);
  const [viewerBundle, setViewerBundle] = useState<ViewerBundle | null>(null);
  // The viewer the read of the recipe last failed for, and how many times it has been asked again.
  const [bundleReadFailedFor, setBundleReadFailedFor] = useState<string | null>(null);
  const [bundleReadAttempt, setBundleReadAttempt] = useState(0);
  const [blockedFor, setBlockedFor] = useState<string | null>(null);
  // The people the credit names that a block stands between, for the viewer it was asked for.
  const [blockedCreditPeople, setBlockedCreditPeople] = useState<{ viewer: string; ids: string[] } | null>(null);
  const shareVisitSent = useRef(false);

  const ownBundle = viewerBundle && viewerBundle.viewerKey === viewerKey ? viewerBundle : null;
  const bundle = ownBundle ? ownBundle.bundle : pageBundle;
  const lockedViewer = Boolean(bundle && !bundle.viewerCanAccess && !bundle.viewerIsOwner);
  // The creator remixes their own creation as its owner: the server lets them whatever the recipe
  // (`resolveRemixAccess`), so it opens for them as soon as they are known, before their own read of
  // the recipe lands. Until then they were offered it to claim or to unlock (review of #847). A post
  // with no creation (a picture made elsewhere) has nothing to remix: the server answers its Remix
  // "Only generation-backed posts can be remixed" (`remixShowcasePostForRoute`), so nobody gets one,
  // its creator included, whatever the page or a read of the recipe says (owner, 2026-11-17).
  const creatorRemix = useMemo(
    () => (hasCreation ? remixForViewer(pageRemix, CREATORS_RECIPE_ACCESS) : NO_REMIX),
    [hasCreation, pageRemix],
  );
  const viewerIsCreator = ownership === 'owner' || ownership === 'owner-checking';
  const remix = useMemo(
    () => (!hasCreation ? NO_REMIX : viewerIsCreator ? creatorRemix : remixForViewer(pageRemix, bundle)),
    [bundle, creatorRemix, hasCreation, pageRemix, viewerIsCreator],
  );

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
    // Said for the viewer it was asked for: the creator's own recipe, held until this read brings it,
    // says so and offers to ask again. Anyone else keeps the page's recipe, as before.
    const failed = () => {
      if (!controller.signal.aborted) setBundleReadFailedFor(viewerKey);
    };
    // Asked on every post a signed-in reader opens, recipe or not: the cached page cannot say
    // whether one is held back for them. None for them is answered as none, not as a 404 the
    // browser logs as a failed load on every such post (`postRecipeReadPath`).
    void fetch(postRecipeReadPath(postId), {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
      signal: controller.signal,
    }).then(async (response) => {
      // Gone for this viewer: never published to them, taken off sale since
      // the page was cached, or a block; answered as none, or as a 404 by a
      // server from before `absent=none`. Any other failure keeps the page's.
      if (response.status !== 404 && !response.ok) {
        failed();
        return;
      }
      const body = response.ok
        ? await response.json().catch(() => null) as { bundle?: PostResourceBundleDetail | null } | null
        : null;
      if (controller.signal.aborted) return;
      // An answer that says neither keeps the page's too.
      if (response.ok && body?.bundle === undefined) {
        failed();
        return;
      }
      const read = response.ok ? body?.bundle ?? null : null;
      setBundleReadFailedFor(null);
      // What the panel reported after an unlock is newer than a read sent before it.
      setViewerBundle((current) => (
        current?.viewerKey === viewerKey && current.source === 'panel'
          ? current
          : { viewerKey, bundle: read, source: 'read', panelStart: 'read' }
      ));
    }).catch(failed);
    return () => controller.abort();
  }, [accessToken, bundleReadAttempt, postId, readsBundle, viewerKey]);

  const retryBundleRead = useCallback(() => {
    setBundleReadFailedFor(null);
    setBundleReadAttempt((attempt) => attempt + 1);
  }, []);

  // The creator's read of their recipe goes out only once the check names them, and a check that
  // never ends (supabase-js failing to load after a deploy, `getUser` hanging) held their recipe at
  // "Opening your recipe…" for good. Past the check's deadline it says it could not be opened, with
  // Try again, which asks the check again; their Owner tools and Remix still wait for its answer.
  // While the check asked again runs, the recipe is drawn opening, for at most another deadline.
  const [creatorCheckRetry, setCreatorCheckRetry] = useState<number | null>(null);
  // Whether this page is still the one on screen when a retry's failure lands: its reload is for
  // this page alone, never for one the creator went on to.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (creatorCheckRetry === null) return undefined;
    const deadline = setTimeout(() => setCreatorCheckRetry(null), SESSION_CHECK_DEADLINE_MS);
    return () => clearTimeout(deadline);
  }, [creatorCheckRetry]);
  const creatorCheckOverdue = ownership === 'owner-checking' && viewerCheck === 'visitor' && creatorCheckRetry === null;
  const retryCreatorRecipe = useCallback(() => {
    if (!creatorCheckOverdue) {
      retryBundleRead();
      return;
    }
    const startedAt = performance.now();
    setCreatorCheckRetry(startedAt);
    void refreshSessionState()
      // supabase-js itself would not load (a deploy renamed its chunk): only a new page has it.
      .catch(() => {
        if (mountedRef.current) window.location.reload();
      })
      .finally(() => setCreatorCheckRetry((current) => (current === startedAt ? null : current)));
  }, [creatorCheckOverdue, refreshSessionState, retryBundleRead]);

  // A block either way hides the post, as the app's by-id read does and as
  // blocking promises ("You will stop seeing their posts"). A check that could
  // not be made leaves the post as everyone sees it.
  // The same question, in the same read, takes out of the remix credit anyone
  // a block stands between and the viewer, as the app's reads do on the server.
  const asksAboutCredit = remixCreditUserIds(pageRemixCredit).some((id) => id !== viewerUserId);
  useEffect(() => {
    if (!viewerUserId || !accessToken || !creatorId) return;
    if (creatorId === viewerUserId && !asksAboutCredit) return;
    const controller = new AbortController();
    void fetchShowcaseViewerExclusions({
      items: [{ id: postId, creator: { id: creatorId }, remixCredit: pageRemixCredit }],
      accessToken,
      signal: controller.signal,
    }).then((exclusions) => {
      if (controller.signal.aborted || !exclusions) return;
      const blocked = new Set(exclusions.blockedCreatorIds.map((id) => id.toLowerCase()));
      if (creatorId !== viewerUserId && blocked.has(creatorId.toLowerCase())) {
        setBlockedFor(viewerUserId);
      }
      setBlockedCreditPeople({
        viewer: viewerUserId,
        ids: remixCreditUserIds(pageRemixCredit).filter((id) => blocked.has(id.toLowerCase())),
      });
    });
    return () => controller.abort();
  }, [accessToken, asksAboutCredit, creatorId, pageRemixCredit, postId, viewerUserId]);

  const blockedCreditIds = blockedCreditPeople && blockedCreditPeople.viewer === viewerUserId
    ? blockedCreditPeople.ids
    : null;
  const remixCredit = useMemo(() => (
    blockedCreditIds?.length
      ? withoutBlockedRemixCredit(pageRemixCredit, (id) => blockedCreditIds.includes(id), creatorId)
      : pageRemixCredit
  ), [blockedCreditIds, creatorId, pageRemixCredit]);

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

  // A link shared by a signed-in account also carries that account's invite,
  // `?r=<code>`. For a visitor with no account it is recorded here, once the
  // viewer is known, as the invite landing would record it; the visitor sees
  // the post, not a landing. Whatever the post's visibility: the invite is the
  // sharer's, not the post's.
  const inviteHandoff = useInviteVisitFromSharedLink({
    search,
    path: `/showcase/${postId}`,
    viewerKnown: viewerKey !== null,
    viewerHasAccount: Boolean(viewerUserId) && user?.is_anonymous !== true,
  });

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
    ownership,
    visibility: effectiveVisibility,
    bundle,
    bundlePanelKey: `${viewerKey ?? 'unknown'}:${ownBundle?.panelStart ?? 'page'}`,
    bundleReadFailed: viewerKey !== null && bundleReadFailedFor === viewerKey,
    creatorCheckOverdue,
    retryCreatorRecipe,
    lockedViewer,
    remix,
    creatorRemix,
    blocked: Boolean(viewerUserId && blockedFor === viewerUserId),
    remixCredit,
    returnContext,
    deliveryId,
    reportSearch: setSearch,
    applyBundleAccess,
    markCreatorBlocked,
    inviteHandoff,
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
