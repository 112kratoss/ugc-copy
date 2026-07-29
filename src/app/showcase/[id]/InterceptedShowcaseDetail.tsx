import { RequestHintedOptionalAuth } from '@/app/components/RouteAuthBoundary';
import ShowcaseDetailBody from '@/app/showcase/[id]/ShowcaseDetailBody';
import ShowcaseDetailOverlay from '@/app/showcase/[id]/ShowcaseDetailOverlay';
import ShowcaseDetailUnavailable from '@/app/showcase/[id]/ShowcaseDetailUnavailable';
import { getPostReferenceForShowcaseId, getPublicPostDetail } from '@/lib/public-posts';
import { getServerAuthState } from '@/lib/supabase-server';

type InterceptedShowcaseDetailProps = {
  params: Promise<{ id: string }>;
};

/**
 * The post rendered as an overlay for soft navigations, shared by every
 * intercepting route that mounts it.
 *
 * There are two, because interception is resolved per layout segment and this
 * app serves its feed from two of them: `src/app/@modal` covers routes on the
 * root layout (signed-out `/`, `/feed`, `/marketplace`, …), and
 * `src/app/home/@modal` covers signed-in `/`, which the middleware rewrites to
 * `/home` (see `resolveRootHomeRouting` in src/proxy.ts). A single root slot
 * silently does nothing for signed-in home traffic.
 *
 * Deliberate differences from `src/app/showcase/[id]/page.tsx`:
 * - no `share_visit` record — opening an overlay is not arriving from a shared
 *   link, and the visit would be counted again on refresh;
 * - no `redirect()` for legacy generation ids — the resolved post renders in
 *   place, and the canonical page still redirects for anyone sharing the URL;
 * - no `notFound()` — an unavailable post reports itself inside the panel
 *   instead of replacing the list behind it with an error page.
 *
 * The auth boundary lives here rather than in a slot layout on purpose: it
 * reads cookies, and a slot layout renders on every route, which would make
 * the statically prerendered `/` dynamic.
 */
export default async function InterceptedShowcaseDetail({ params }: InterceptedShowcaseDetailProps) {
  const { id } = await params;
  const reference = await getPostReferenceForShowcaseId(id);
  const auth = reference ? await getServerAuthState() : null;
  const detail = reference
    ? await getPublicPostDetail(reference.id, {
        viewerUserId: auth?.session?.user?.id ?? null,
        countryCode: null,
      })
    : null;

  if (!detail) {
    return (
      <ShowcaseDetailOverlay title="Post unavailable">
        <ShowcaseDetailUnavailable />
      </ShowcaseDetailOverlay>
    );
  }

  return (
    <ShowcaseDetailOverlay title={detail.title}>
      <RequestHintedOptionalAuth>
        <ShowcaseDetailBody
          detail={detail}
          viewerUserId={auth?.session?.user?.id ?? null}
          accessToken={auth?.session?.access_token ?? null}
          variant="overlay"
        />
      </RequestHintedOptionalAuth>
    </ShowcaseDetailOverlay>
  );
}
