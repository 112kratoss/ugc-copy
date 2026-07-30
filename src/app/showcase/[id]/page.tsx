import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { after } from 'next/server';

import { recordPostShareEvent } from '@/lib/post-share-events';
import {
  getPostReferenceForShowcaseId,
  getPublicPostDetail,
  getPublicPostMetaDescription,
} from '@/lib/public-posts';
import { createMetadata } from '@/lib/seo';
import { buildShowcaseDetailPath, getShowcaseReturnContext } from '@/lib/share';
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
    image: detail.mediaKind === 'image' ? detail.mediaUrl ?? undefined : undefined,
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

  // A share visit means someone arrived from outside. An in-app open always
  // carries `from`, and a shared URL never does (buildShowcaseDetailUrl passes
  // no options), so the absence of that param is the exact test.
  //
  // Deferred with `after` so an analytics write never sits between the click and
  // the post appearing — nothing in this render depends on its result, and the
  // recorder swallows its own failures.
  if (detail.visibility === 'public' && !returnFrom && shouldTrackShareVisit(headerStore)) {
    after(recordPostShareEvent({
      postId: detail.id,
      eventType: 'share_visit',
      sourceSurface: 'detail-page',
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
