import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { after } from 'next/server';

import { recordPostShareEvent } from '@/lib/post-share-events';
import {
  getPostReferenceForShowcaseId,
  getPublicPostDetail,
  getPublicPostMetaDescription,
  type PublicPostDetail,
} from '@/lib/public-posts';
import { createMetadata, type MetadataImage } from '@/lib/seo';
import {
  SHARE_SOURCE_QUERY_PARAM,
  buildShowcaseDetailPath,
  getShowcaseReturnContext,
  isGenerationShareSourceSurface,
  type GenerationShareSourceSurface,
} from '@/lib/share';
import { getServerAuthState } from '@/lib/supabase-server';
import ShowcaseDetailBody from './ShowcaseDetailBody';

type ShowcaseDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function shouldTrackShareVisit(headerStore: Headers): boolean {
  const purpose = headerStore.get('purpose');
  const prefetchHeader = headerStore.get('next-router-prefetch');

  return purpose !== 'prefetch' && prefetchHeader === null;
}

function getParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The card a shared link renders in a chat app.
 *
 * Video and motion posts used to fall straight through to the site-wide OG
 * image, which is the least appealing preview the product can produce for its
 * flagship output. The poster frame is already sitting on the cover media as a
 * public storage URL, so this costs no extra query.
 *
 * `previewStatus` is checked rather than just the URL: `previewUrl` is derived
 * from the stored path alone, so a failed render leaves a path behind that would
 * otherwise be served as a broken image.
 */
function resolveShowcaseOgImage(detail: PublicPostDetail): MetadataImage | undefined {
  const cover = detail.mediaItems?.[0];
  const dimensions = cover?.width && cover?.height
    ? { width: cover.width, height: cover.height }
    : {};

  if (detail.mediaKind === 'image' && detail.mediaUrl) {
    return { url: detail.mediaUrl, ...dimensions };
  }

  if (cover?.previewUrl && cover.previewStatus === 'ready') {
    return { url: cover.previewUrl, ...dimensions };
  }

  // Legacy posts predating post_media carry no poster at all, and a freshly
  // published video's poster is still rendering. Both fall back to the site
  // card rather than to a signed generation URL, which expires in an hour and
  // would leave crawlers caching a dead image.
  return undefined;
}

/**
 * A share visit means someone arrived from a link that left the product. Shared
 * URLs carry `?s=<surface>`; in-app links never do, so the marker is the test —
 * and it names the surface the share came from, which the landing page has no
 * other way to know.
 */
function getShareVisitSurface(
  value: string | undefined
): GenerationShareSourceSurface | null {
  if (!value) {
    return null;
  }

  return isGenerationShareSourceSurface(value) ? value : 'detail-page';
}

export async function generateMetadata({ params }: ShowcaseDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const reference = await getPostReferenceForShowcaseId(id);

  if (reference && reference.id !== id) {
    return {
      title: 'Creation Redirect',
      robots: {
        index: false,
        follow: true,
      },
    };
  }

  const detail = reference ? await getPublicPostDetail(reference.id) : null;

  if (!detail) {
    return {
      title: 'Creation Not Found',
    };
  }

  return createMetadata({
    title: detail.title,
    description: getPublicPostMetaDescription(detail),
    path: buildShowcaseDetailPath(detail.id),
    image: resolveShowcaseOgImage(detail),
  });
}

/**
 * The one and only post surface — a direct visit, a refresh, a shared link, or
 * a click from the feed all land here. Opening a post used to be intercepted
 * into an overlay; that slot is gone, so every route in the app now arrives at
 * this page and gets the share-visit tracking, the legacy-id redirect, and
 * `notFound()` alike.
 */
export default async function ShowcaseDetailPage({ params, searchParams }: ShowcaseDetailPageProps) {
  const { id } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const returnFrom = getParam(resolvedSearchParams.from);
  const returnTo = getParam(resolvedSearchParams.returnTo);
  const returnContext = getShowcaseReturnContext({
    from: returnFrom,
    returnTo,
  });
  const reference = await getPostReferenceForShowcaseId(id);

  if (!reference) {
    notFound();
  }

  if (reference.id !== id) {
    redirect(buildShowcaseDetailPath(reference.id, {
      from: returnContext.source,
      returnTo: returnContext.href,
    }));
  }

  // Independent of each other, so pay for one round trip rather than two.
  const [auth, headerStore] = await Promise.all([getServerAuthState(), headers()]);
  const detail = await getPublicPostDetail(reference.id, {
    viewerUserId: auth.session?.user?.id ?? null,
    countryCode: headerStore.get('x-vercel-ip-country'),
  });

  if (!detail) {
    notFound();
  }

  // Deferred with `after` so an analytics write never sits between the click and
  // the post appearing — nothing in this render depends on its result, and the
  // recorder swallows its own failures.
  const shareVisitSurface = getShareVisitSurface(
    getParam(resolvedSearchParams[SHARE_SOURCE_QUERY_PARAM])
  );

  if (
    detail.visibility === 'public'
    && shareVisitSurface
    && !returnFrom
    && shouldTrackShareVisit(headerStore)
  ) {
    after(recordPostShareEvent({
      postId: detail.id,
      eventType: 'share_visit',
      sourceSurface: shareVisitSurface,
    }));
  }

  return (
    <ShowcaseDetailBody
      detail={detail}
      viewerUserId={auth.session?.user?.id ?? null}
      accessToken={auth.session?.access_token ?? null}
      returnContext={returnContext}
      variant="page"
    />
  );
}
