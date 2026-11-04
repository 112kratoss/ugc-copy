import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';

import { JsonLd } from '@/components/JsonLd';
import { OptionalAuth } from '@/components/RouteAuthBoundary';
import { cachePublicPageRead } from '@/lib/public-page-cache';
import {
  getPostReferenceForShowcaseId,
  getPublicPostDetail,
  getPublicPostMetaDescription,
  type PublicPostDetail,
} from '@/lib/public-posts';
import {
  buildBreadcrumbSchema,
  buildImageObjectSchema,
  buildVideoObjectSchema,
  createMetadata,
  type MetadataImage,
} from '@/lib/seo';
import {
  composeShowcaseTitle,
  isShowcaseDetailIndexable,
} from '@/lib/showcase-seo';
import { buildShowcaseDetailPath } from '@/lib/share';
import ShowcaseDetailBody from './ShowcaseDetailBody';

type ShowcaseDetailPageProps = {
  params: Promise<{ id: string }>;
};

/**
 * One render of each post for everyone, kept until an event changes it (ISR).
 * The page reads the post as a signed-out visitor in no country would, and
 * never the session, a cookie, a header or the query: everything that depends
 * on who is looking (their recipe, Owner tools, a block, the way back, a share
 * visit) is read in the browser by `useShowcasePostViewer`. A private,
 * archived or moderation-hidden post is not in the read at all
 * (`getPublicPostDetail`), so it answers not-found for everyone, its owner
 * included, as it did before.
 *
 * Every publish, edit, visibility change, archive, delete, console moderation
 * decision, profile change and account deletion invalidates the public pages'
 * tag (`PUBLIC_PAGE_CACHE_TAG`), which the read below carries into this page's
 * cache entry; a block or a report does not, as the page draws neither.
 * `revalidate` is the backstop for what moves without one: counts, and a
 * take-down made with the moderation CLI (PUBLIC_PAGE_REVALIDATE_SECONDS says
 * why five minutes; kept equal to it).
 */
export const revalidate = 300;

/** No post is drawn at build time; each is drawn on its first visit, then cached. */
export async function generateStaticParams(): Promise<Array<{ id: string }>> {
  return [];
}

type ShowcasePostPageRead =
  /** `readAt`: when the post was read, which the cached HTML's "3h" counts from. */
  | { kind: 'post'; detail: PublicPostDetail; readAt: number }
  | { kind: 'redirect'; postId: string }
  | { kind: 'missing' };

/**
 * A post id is the common case, so its row is read first and only a miss
 * looks for a legacy generation id to redirect: an ordinary open reads the
 * post once, not once to resolve the id and again to show it.
 */
async function readShowcasePostPage(id: string): Promise<ShowcasePostPageRead> {
  const detail = await getPublicPostDetail(id);
  if (detail) {
    return { kind: 'post', detail, readAt: Date.now() };
  }

  const reference = await getPostReferenceForShowcaseId(id);
  return reference && reference.id !== id
    ? { kind: 'redirect', postId: reference.id }
    : { kind: 'missing' };
}

const readCachedShowcasePostPage = cachePublicPageRead(readShowcasePostPage, ['showcase-post-page-v1']);

/** A post id, and a legacy generation id, are both UUIDs. */
const SHOWCASE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One read per render, shared by the metadata and the page. Anything but a
 * UUID is no post: it answers not-found before any read, so an address made
 * up by a crawler costs no database read and leaves no cache entry, and the
 * database never sees text where it expects a UUID.
 */
const loadShowcasePostPage = cache((id: string): Promise<ShowcasePostPageRead> => (
  SHOWCASE_ID_PATTERN.test(id) ? readCachedShowcasePostPage(id) : Promise.resolve({ kind: 'missing' })
));

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
  if (detail.isNsfw) return undefined;
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
 * Structured data for the creation itself.
 *
 * Video and image posts are the product's core output and were shipping no
 * media schema at all, which kept every one of them out of video rich results
 * and image packs. The poster frame already resolved for the social card is
 * reused as `thumbnailUrl`, which Google requires for a video result.
 */
function buildShowcaseMediaSchema(detail: PublicPostDetail) {
  const path = buildShowcaseDetailPath(detail.id);
  const ogImage = resolveShowcaseOgImage(detail);
  const shared = {
    name: composeShowcaseTitle(detail),
    description: getPublicPostMetaDescription(detail),
    path,
    uploadDate: detail.createdAt,
    creatorName: detail.creator?.name || undefined,
  };

  const mediaSchema = detail.mediaKind === 'video'
    ? buildVideoObjectSchema({
      ...shared,
      thumbnailUrl: ogImage?.url,
      contentUrl: detail.mediaUrl ?? undefined,
    })
    : buildImageObjectSchema({
      ...shared,
      contentUrl: detail.mediaUrl ?? undefined,
    });

  return [
    mediaSchema,
    buildBreadcrumbSchema([
      { name: 'Home', path: '/' },
      { name: 'Showcase', path: '/showcase' },
      { name: shared.name, path },
    ]),
  ];
}

export async function generateMetadata({ params }: ShowcaseDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const page = await loadShowcasePostPage(id);

  if (page.kind === 'redirect') {
    return {
      title: 'Creation Redirect',
      robots: {
        index: false,
        follow: true,
      },
    };
  }

  if (page.kind === 'missing') {
    return {
      title: 'Creation Not Found',
    };
  }

  const { detail } = page;
  return createMetadata({
    title: composeShowcaseTitle(detail),
    description: getPublicPostMetaDescription(detail),
    path: buildShowcaseDetailPath(detail.id),
    image: resolveShowcaseOgImage(detail),
    // Unlisted, untitled, and media-less posts stay out of the index. The same
    // gate runs in `sitemap-entries.ts`, so a URL is never submitted for
    // indexing and then told not to be indexed.
    noIndex: !isShowcaseDetailIndexable(detail),
  });
}

/**
 * The one and only post surface — a direct visit, a refresh, a shared link, or
 * a click from the feed all land here. Opening a post used to be intercepted
 * into an overlay; that slot is gone, so every route in the app now arrives at
 * this page and gets the legacy-id redirect and `notFound()` alike, and, in
 * the browser, the share-visit tracking and the way back its link names.
 */
export default async function ShowcaseDetailPage({ params }: ShowcaseDetailPageProps) {
  const { id } = await params;
  const page = await loadShowcasePostPage(id);

  if (page.kind === 'redirect') {
    // To the post's own address. The cached redirect cannot carry the query
    // of the link that reached it (the page never reads one), so a legacy id
    // opened from a ranked card lands without its way back or delivery.
    redirect(buildShowcaseDetailPath(page.postId));
  }

  if (page.kind === 'missing') {
    notFound();
  }

  const { detail, readAt } = page;
  return (
    <OptionalAuth>
      {isShowcaseDetailIndexable(detail) ? (
        <JsonLd data={buildShowcaseMediaSchema(detail)} />
      ) : null}
      <ShowcaseDetailBody
        detail={detail}
        shareDescription={getPublicPostMetaDescription(detail)}
        renderedAt={readAt}
      />
    </OptionalAuth>
  );
}
