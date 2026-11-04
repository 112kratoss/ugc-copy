import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cache } from 'react';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import {
  Globe2,
  Heart,
  Images,
  Instagram,
  LockKeyhole,
  MapPin,
  Music2,
  Repeat2,
  Twitter,
} from 'lucide-react';

import {
  getCreatorProfilePageData,
  type CreatorProfilePageData,
} from '@/lib/creator-profile';
import {
  buildCreatorProfilePath,
  normalizeSocialProfileHandle,
  type SocialProfileField,
} from '@/lib/profile';
import { JsonLd } from '@/components/JsonLd';
import { OptionalAuth } from '@/components/RouteAuthBoundary';
import { cachePublicPageRead } from '@/lib/public-page-cache';
import {
  buildBreadcrumbSchema,
  buildProfilePageSchema,
  createMetadata,
} from '@/lib/seo';
import { SHOWCASE_FEED_CACHE_TAG } from '@/lib/showcase-feed-cache';
import { CreatorPageViewer, CreatorPosts, CreatorProfileActions } from './CreatorPageViewer';

type CreatorPageProps = {
  params: Promise<{ username: string }>;
};

/**
 * One render of each creator page for everyone, kept until an event changes
 * it (ISR). The page reads the creator as a signed-out visitor in no country
 * would, and never the session, a cookie, a header or the query: a block with
 * the viewer and a share visit are read in the browser (`CreatorPageViewer`),
 * and Follow, Edit profile and saves already were. A profile edit, a publish,
 * an archive, a delete and a moderation decision invalidate the feed's tag,
 * which the read below carries into this page's cache entry. Kept equal to
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

const readCachedCreatorPage = cachePublicPageRead(
  readCreatorPage,
  ['creator-page-v1'],
  [SHOWCASE_FEED_CACHE_TAG],
);

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

/**
 * Social pills, each opening the platform it names. A row saved before the
 * server checked handles can hold any text, a link to another site included,
 * so a pill is drawn only for a value that reads as that platform's handle (a
 * pasted link on its own host counts), and the handle is encoded into the path.
 */
const SOCIAL_LINKS: ReadonlyArray<{
  field: SocialProfileField;
  label: string;
  icon: ReactNode;
  buildHref: (encodedHandle: string) => string;
}> = [
  { field: 'instagramHandle', label: 'Instagram', icon: <Instagram className="h-4 w-4" />, buildHref: (handle) => `https://instagram.com/${handle}` },
  { field: 'tiktokHandle', label: 'TikTok', icon: <Music2 className="h-4 w-4" />, buildHref: (handle) => `https://tiktok.com/@${handle}` },
  { field: 'twitterHandle', label: 'X', icon: <Twitter className="h-4 w-4" />, buildHref: (handle) => `https://x.com/${handle}` },
];

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
  const profileForActions = {
    id: data.profile.id,
    username: data.profile.username,
    displayName: data.profile.displayName,
    bio: data.profile.bio ?? '',
    avatarUrl: data.profile.avatarUrl ?? '',
    coverUrl: data.profile.coverUrl ?? '',
    websiteUrl: data.profile.websiteUrl ?? '',
    twitterHandle: data.profile.twitterHandle ?? '',
    instagramHandle: data.profile.instagramHandle ?? '',
    tiktokHandle: data.profile.tiktokHandle ?? '',
    location: data.profile.location ?? '',
    credits: null,
  };

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
            <section className="overflow-hidden rounded-3xl border border-white/8 bg-[#111215] shadow-[0_24px_80px_-60px_rgba(255,122,89,0.32)]">
              <div className="relative h-40 overflow-hidden bg-[#0b0c10] sm:h-52 lg:h-60">
                {data.profile.coverUrl ? (
                  // Full-bleed banner: served at viewport width rather than at
                  // whatever the creator uploaded, which was previously the raw
                  // source at full resolution on every profile view.
                  <Image
                    src={data.profile.coverUrl}
                    alt={`${data.profile.displayName} cover`}
                    fill
                    sizes="(min-width: 1560px) 1560px, 100vw"
                    className="object-cover"
                  />
                ) : (
                  <div className="h-full w-full bg-[linear-gradient(120deg,rgba(255,122,89,0.15),rgba(17,18,21,0.92)_44%,rgba(242,185,94,0.08))]" />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-[#111215] via-transparent to-black/10" />
              </div>

              <div className="relative px-4 pb-5 sm:px-7 sm:pb-7 lg:px-9">
                <div className="-mt-12 flex flex-col gap-5 lg:-mt-14 lg:flex-row lg:items-end lg:justify-between">
                  <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-end">
                    {data.profile.avatarUrl ? (
                      // Renders at 96-112px, so there is no reason to ship the
                      // uploaded original here.
                      <Image
                        src={data.profile.avatarUrl}
                        alt={`${data.profile.displayName} avatar`}
                        width={112}
                        height={112}
                        sizes="(min-width: 640px) 112px, 96px"
                        className="h-24 w-24 shrink-0 rounded-full border-4 border-[#111215] bg-zinc-900 object-cover shadow-xl sm:h-28 sm:w-28"
                      />
                    ) : (
                      <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full border-4 border-[#111215] bg-zinc-800 text-3xl font-black text-white shadow-xl sm:h-28 sm:w-28">
                        {data.profile.displayName[0]?.toUpperCase() ?? 'C'}
                      </div>
                    )}

                    <div className="min-w-0 max-w-3xl pb-1">
                      <h1 className="truncate text-3xl font-black tracking-normal text-white sm:text-4xl">
                        {data.profile.displayName}
                      </h1>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
                        <span className="font-bold text-sky-300">@{data.profile.username}</span>
                        {data.profile.location ? (
                          <span className="inline-flex items-center gap-1.5 text-zinc-400">
                            <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                            {data.profile.location}
                          </span>
                        ) : null}
                      </div>
                      {data.profile.bio ? (
                        <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-300">{data.profile.bio}</p>
                      ) : null}
                    </div>
                  </div>

                  <div className="pb-1 lg:shrink-0">
                    {/* Follow and Share, or for a viewer who blocked the creator the menu alone. */}
                    <CreatorProfileActions profile={profileForActions} />
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap gap-2">
                  {data.profile.websiteUrl ? (
                    <SocialLink href={data.profile.websiteUrl} label="Website" icon={<Globe2 className="h-4 w-4" />} />
                  ) : null}
                  {SOCIAL_LINKS.map(({ field, label, icon, buildHref }) => {
                    const storedValue = data.profile[field];
                    const handle = storedValue ? normalizeSocialProfileHandle(field, storedValue) : null;
                    return handle ? (
                      <SocialLink key={field} href={buildHref(encodeURIComponent(handle))} label={label} icon={icon} />
                    ) : null;
                  })}
                </div>

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
              </div>
            </section>

            {/* The posts, or for a viewer who blocked the creator Unblock in their place. */}
            <CreatorPosts initialData={data} profilePath={profilePath} />
          </div>
        </main>
      </CreatorPageViewer>
    </OptionalAuth>
  );
}

function SocialLink({ href, icon, label }: { href: string; icon: ReactNode; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="ui-focus-ring inline-flex min-h-10 items-center gap-2 rounded-full border border-white/8 bg-white/[0.04] px-3.5 text-xs font-bold text-zinc-300 transition hover:border-white/18 hover:bg-white/[0.07] hover:text-white"
    >
      {icon}
      {label}
    </a>
  );
}
