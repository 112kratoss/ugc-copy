import type { Metadata } from 'next';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import { Heart, Images, LockKeyhole, Repeat2 } from 'lucide-react';

import {
  getCreatorProfilePageData,
  type CreatorProfilePageData,
} from '@/lib/creator-profile';
import { buildCreatorProfilePath } from '@/lib/profile';
import { JsonLd } from '@/components/JsonLd';
import { OptionalAuth } from '@/components/RouteAuthBoundary';
import { cachePublicPageRead } from '@/lib/public-page-cache';
import {
  buildBreadcrumbSchema,
  buildProfilePageSchema,
  createMetadata,
} from '@/lib/seo';
import { CreatorPageViewer, CreatorPosts } from './CreatorPageViewer';
import { CreatorProfileHeader } from './CreatorProfileHeader';

type CreatorPageProps = {
  params: Promise<{ username: string }>;
};

/**
 * One render of each creator page for everyone, kept until an event changes
 * it (ISR). The page reads the creator as a signed-out visitor in no country
 * would, and never the session, a cookie, a header or the query: a block with
 * the viewer, a share visit and the creator's own just-saved profile are read
 * in the browser (`CreatorPageViewer`, `CreatorProfileHeader`), and Follow,
 * Edit profile and saves already were. A profile edit, a publish, an archive,
 * a delete, an account deletion and a moderation decision invalidate the
 * public pages' tag (`PUBLIC_PAGE_CACHE_TAG`), which the read below carries
 * into this page's cache entry; a block or a report does not. Kept equal to
 * PUBLIC_PAGE_REVALIDATE_SECONDS (five minutes: that file says why).
 */
export const revalidate = 300;

/** No creator is drawn at build time; each is drawn on its first visit, then cached. */
export async function generateStaticParams(): Promise<Array<{ username: string }>> {
  return [];
}

/**
 * The first page: the header, the creator's totals and their first posts. An
 * unknown handle, or an account being deleted, reads as none before anything
 * else is read (`loadCreatorProfileRow`). Prices are quoted in no country: the
 * cards price recipes in credits, and every later page is the API's.
 */
async function readCreatorPage(username: string): Promise<CreatorProfilePageData | null> {
  return getCreatorProfilePageData(username, { limit: 24, offset: 0 });
}

const readCachedCreatorPage = cachePublicPageRead(readCreatorPage, ['creator-page-v1']);

/** One read per render, shared by the metadata and the page. */
const loadCreatorPage = cache((username: string) => readCachedCreatorPage(username));

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
  const stats = [
    { label: 'Posts', value: data.stats.publicCreations, icon: Images },
    { label: 'Saves', value: data.stats.totalSaves, icon: Heart },
    { label: 'Remixes', value: data.stats.totalRemixes, icon: Repeat2 },
    { label: 'Recipes', value: data.stats.unlocks, icon: LockKeyhole },
  ];
  return (
    <OptionalAuth>
      <CreatorPageViewer creatorId={data.profile.id} username={data.profile.username}>
        <main className="ui-page pb-16 pt-5 sm:pb-24 sm:pt-8">
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
                <div className="mt-5 grid grid-cols-4 divide-x divide-white/8 border-t border-white/8 pt-5">
                  {stats.map(({ label, value, icon: Icon }) => (
                    <div key={label} className="flex min-w-0 flex-col items-center gap-1 px-1 text-center sm:flex-row sm:justify-center sm:gap-2.5">
                      <Icon className="hidden h-4 w-4 text-zinc-500 sm:block" aria-hidden="true" />
                      <div>
                        <div className="text-lg font-black tabular-nums text-white sm:text-xl">{value.toLocaleString()}</div>
                        <div className="truncate text-[11px] font-semibold text-zinc-500 sm:text-xs">{label}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            />

            {/* The posts, or for a viewer who blocked the creator Unblock in their place. */}
            <CreatorPosts initialData={data} profilePath={profilePath} />
          </div>
        </main>
      </CreatorPageViewer>
    </OptionalAuth>
  );
}
