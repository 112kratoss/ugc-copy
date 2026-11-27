import type { Metadata } from 'next';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import { Eye, Heart, Images, LockKeyhole, Repeat2 } from 'lucide-react';

import {
  getCreatorProfilePageData,
  getCreatorProfileSummary,
  type CreatorProfilePageData,
} from '@/lib/creator-profile';
import { buildCreatorProfilePath } from '@/lib/profile';
import { JsonLd } from '@/components/JsonLd';
import { OptionalAuth } from '@/components/RouteAuthBoundary';
import {
  cachePublicPageRead,
  creatorHandlePageCacheTags,
  creatorPageCacheTags,
} from '@/lib/public-page-cache';
import {
  buildBreadcrumbSchema,
  buildProfilePageSchema,
  createMetadata,
} from '@/lib/seo';
import { CreatorPageViewer, CreatorPosts } from './CreatorPageViewer';
import { CreatorProfileHeader } from './CreatorProfileHeader';

import { VIEW_COUNT_TOTAL_LABEL, viewCountLabels } from '../../../../ugc-mobile/lib/view-count/view-count';

type CreatorPageProps = {
  params: Promise<{ username: string }>;
};

/**
 * One render of each creator page for everyone, kept until an event changes
 * it (ISR). The page reads the creator as a signed-out visitor in no country
 * would, and never the session, a cookie, a header or the query: a block with
 * the viewer, a share visit and the creator's own just-saved profile are read
 * in the browser (`CreatorPageViewer`, `CreatorProfileHeader`), and Follow,
 * Edit profile and saves already were. The reads below carry their tags into
 * this page's cache entry: the public pages' removal tag (an archive, a
 * delete, an account deletion or a take-down expires it at once), the
 * creator's own (`creatorPageCacheTags`: a publish or an edit of a post the
 * page lists, or of a post a listed remix credits, refreshes it in the
 * background), and the handle's (`creatorHandlePageCacheTags`: a profile
 * taking the handle expires a not-found drawn before). A profile edit
 * refreshes every page in the background; a block or a report does nothing
 * here. Kept equal to PUBLIC_PAGE_REVALIDATE_SECONDS (five minutes: that file
 * says why).
 */
export const revalidate = 300;

/** No creator is drawn at build time; each is drawn on its first visit, then cached. */
export async function generateStaticParams(): Promise<Array<{ username: string }>> {
  return [];
}

/**
 * Whom the handle names: a write knows its creator by id, never by handle, so
 * the page is tagged by the id this lookup finds. Null for an unknown handle
 * or an account being deleted (`loadCreatorProfileRow`). A handle moves only
 * with a profile saved or an account deleted, which refresh or expire every
 * page, this lookup included.
 */
async function readCreatorId(username: string): Promise<string | null> {
  return (await getCreatorProfileSummary(username))?.id ?? null;
}

const readCachedCreatorId = cachePublicPageRead(readCreatorId, ['creator-id-v1'], creatorHandlePageCacheTags);

/**
 * The first page: the header, the creator's totals and their first posts.
 * Prices are quoted in no country: the cards price recipes in credits, and
 * every later page is the API's. A page whose handle has meanwhile come to
 * name someone else is none, rather than that person's page under the tags
 * of the one the lookup found.
 */
async function readCreatorPage(username: string, creatorId: string): Promise<CreatorProfilePageData | null> {
  const data = await getCreatorProfilePageData(username, { limit: 24, offset: 0 });
  return data?.profile.id === creatorId ? data : null;
}

const readCachedCreatorPage = cachePublicPageRead(
  readCreatorPage,
  ['creator-page-v2'],
  (_username, creatorId) => creatorPageCacheTags(creatorId),
);

/** One read per render, shared by the metadata and the page. */
const loadCreatorPage = cache(async (username: string) => {
  const creatorId = await readCachedCreatorId(username);
  return creatorId ? readCachedCreatorPage(username, creatorId) : null;
});

/**
 * A creator page earns indexing by having published something. The count is the
 * whole gate: it excludes abandoned signups and the test accounts that were
 * indexable — `batman`, `testcreator123`, `fluffy` — without a hand-written
 * blocklist that goes stale the moment someone makes another one.
 */
const MIN_PUBLIC_POSTS_FOR_INDEXING = 1;

/**
 * The description used to be the raw `bio` field, so profiles went to search
 * with whatever the user had typed — one live profile's entire meta description
 * was the word "Building". The bio is still preferred when it says something,
 * but it now has a floor and a composed fallback that describes the actual
 * contents of the page.
 */
const MIN_BIO_LENGTH_FOR_DESCRIPTION = 40;

function buildCreatorDescription(
  displayName: string,
  username: string,
  bio: string | null | undefined,
  publicCreations: number
): string {
  const trimmedBio = bio?.trim() ?? '';
  if (trimmedBio.length >= MIN_BIO_LENGTH_FOR_DESCRIPTION) {
    return trimmedBio;
  }

  const countLabel = publicCreations === 1
    ? '1 public AI creation'
    : `${publicCreations} public AI creations`;

  return `${displayName} (@${username}) has published ${countLabel} — AI images, videos, and motion-transfer work, with the prompts and workflows behind them.`;
}

export async function generateMetadata({ params }: CreatorPageProps): Promise<Metadata> {
  const { username } = await params;
  const data = await loadCreatorPage(username);

  if (!data) {
    return { title: 'Creator Not Found' };
  }

  // The page's own read, which counts the posts the page lists. (A viewer the
  // creator blocked is told the creator is not there by the browser, which
  // titles that page too: this title is everyone's.)
  const { profile } = data;
  const publicCreations = data.stats.publicCreations;

  return createMetadata({
    title: `${profile.displayName} (@${profile.username})`,
    description: buildCreatorDescription(
      profile.displayName,
      profile.username,
      profile.bio,
      publicCreations
    ),
    path: buildCreatorProfilePath(profile.username),
    image: profile.coverUrl || profile.avatarUrl || undefined,
    noIndex: publicCreations < MIN_PUBLIC_POSTS_FOR_INDEXING,
  });
}

export default async function CreatorPage({ params }: CreatorPageProps) {
  const { username } = await params;
  const data = await loadCreatorPage(username);

  if (!data) notFound();

  const profilePath = buildCreatorProfilePath(data.profile.username);
  // The views of the posts the page lists (post view counts), beside saves and remixes: compact, as
  // every view count reads ("1.2K"), the whole number for a screen reader, and none at 0.
  const viewTotal = viewCountLabels(data.stats.totalViews);
  const stats: Array<{ label: string; value: string; spoken?: string; icon: typeof Images }> = [
    { label: 'Posts', value: data.stats.publicCreations.toLocaleString(), icon: Images },
    ...(viewTotal ? [{ label: VIEW_COUNT_TOTAL_LABEL, value: viewTotal.compact, spoken: viewTotal.spoken, icon: Eye }] : []),
    { label: 'Saves', value: data.stats.totalSaves.toLocaleString(), icon: Heart },
    { label: 'Remixes', value: data.stats.totalRemixes.toLocaleString(), icon: Repeat2 },
    { label: 'Recipes', value: data.stats.unlocks.toLocaleString(), icon: LockKeyhole },
  ];
  return (
    <OptionalAuth>
      <CreatorPageViewer creatorId={data.profile.id} username={data.profile.username}>
        <div className="ui-page pb-16 pt-5 sm:pb-24 sm:pt-8">
          {data.stats.publicCreations >= MIN_PUBLIC_POSTS_FOR_INDEXING ? (
            <JsonLd
              data={[
                buildProfilePageSchema({
                  name: data.profile.displayName,
                  handle: data.profile.username,
                  path: profilePath,
                  description: buildCreatorDescription(
                    data.profile.displayName,
                    data.profile.username,
                    data.profile.bio,
                    data.stats.publicCreations
                  ),
                  image: data.profile.avatarUrl ?? undefined,
                }),
                buildBreadcrumbSchema([
                  { name: 'Home', path: '/' },
                  { name: 'Creators', path: '/showcase' },
                  { name: `@${data.profile.username}`, path: profilePath },
                ]),
              ]}
            />
          ) : null}
          <div className="studio-shell max-w-[1560px]">
            <CreatorProfileHeader
              profile={data.profile}
              stats={(
                <div className={`mt-5 grid ${stats.length === 5 ? 'grid-cols-5' : 'grid-cols-4'} divide-x divide-white/8 border-t border-white/8 pt-5`}>
                  {stats.map(({ label, value, spoken, icon: Icon }) => (
                    <div
                      key={label}
                      data-creator-stat={label}
                      className="flex min-w-0 flex-col items-center gap-1 px-1 text-center sm:flex-row sm:justify-center sm:gap-2.5"
                    >
                      <Icon className="hidden h-4 w-4 text-zinc-500 sm:block" aria-hidden="true" />
                      {/* A compact figure is read whole, once: the drawn pair is hidden from a screen reader. */}
                      <div className="min-w-0" aria-hidden={spoken ? true : undefined} title={spoken}>
                        {/* Five columns leave a 360px phone about 57px each: a five-figure total ("12,345")
                            fits only a size down. */}
                        <div className={`${stats.length === 5 ? 'text-base' : 'text-lg'} font-black tabular-nums text-white sm:text-xl`}>{value}</div>
                        <div className="truncate text-[11px] font-semibold text-zinc-500 sm:text-xs">{label}</div>
                      </div>
                      {spoken ? <span className="sr-only">{spoken}</span> : null}
                    </div>
                  ))}
                </div>
              )}
            />

            {/* The posts, or for a viewer who blocked the creator Unblock in their place. */}
            <CreatorPosts initialData={data} profilePath={profilePath} />
          </div>
        </div>
      </CreatorPageViewer>
    </OptionalAuth>
  );
}
