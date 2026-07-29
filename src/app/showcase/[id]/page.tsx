import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

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
 * The canonical post page: a direct visit, a refresh, or a shared link. Soft
 * navigations from inside the app are intercepted by `src/app/@modal` and
 * render the same body as an overlay instead — this route stays the surface
 * of record, so it keeps the share-visit tracking and the legacy-id redirect.
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

  const auth = await getServerAuthState();
  const headerStore = await headers();
  const detail = await getPublicPostDetail(reference.id, {
    viewerUserId: auth.session?.user?.id ?? null,
    countryCode: headerStore.get('x-vercel-ip-country'),
  });

  if (!detail) {
    notFound();
  }

  if (detail.visibility === 'public' && shouldTrackShareVisit(headerStore)) {
    await recordPostShareEvent({
      postId: detail.id,
      eventType: 'share_visit',
      sourceSurface: 'detail-page',
    });
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
