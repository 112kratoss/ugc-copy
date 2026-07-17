import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
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

import { getCreatorProfilePageData, getCreatorProfileSummary } from '@/lib/creator-profile';
import { buildCreatorProfilePath } from '@/lib/profile';
import { createMetadata } from '@/lib/seo';
import { OptionalAuth } from '@/app/components/RouteAuthBoundary';
import { CreatorContentTabs } from './CreatorContentTabs';
import { ProfileActions } from './ProfileActions';

type CreatorPageProps = {
  params: Promise<{ username: string }>;
};

export async function generateMetadata({ params }: CreatorPageProps): Promise<Metadata> {
  const { username } = await params;
  const profile = await getCreatorProfileSummary(username);

  if (!profile) {
    return { title: 'Creator Not Found' };
  }

  return createMetadata({
    title: `${profile.displayName} (@${profile.username})`,
    description: profile.bio || `Browse @${profile.username}'s public creations on Magicbooklet.`,
    path: buildCreatorProfilePath(profile.username),
    image: profile.coverUrl || profile.avatarUrl || undefined,
  });
}

export default async function CreatorPage({ params }: CreatorPageProps) {
  const { username } = await params;
  const headerStore = await headers();
  const data = await getCreatorProfilePageData(username, {
    limit: 24,
    offset: 0,
    countryCode: headerStore.get('x-vercel-ip-country'),
  });

  if (!data) notFound();

  const profilePath = buildCreatorProfilePath(data.profile.username);
  const stats = [
    { label: 'Posts', value: data.stats.publicCreations, icon: Images },
    { label: 'Saves received', value: data.stats.totalSaves, icon: Heart },
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
    <main className="ui-page pb-16 pt-5 sm:pb-24 sm:pt-8">
      <div className="studio-shell max-w-[1560px]">
        <section className="overflow-hidden rounded-[28px] border border-white/8 bg-[#111215] shadow-[0_24px_80px_-60px_rgba(255,122,89,0.32)]">
          <div className="relative h-40 overflow-hidden bg-[#0b0c10] sm:h-52 lg:h-60">
            {data.profile.coverUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={data.profile.coverUrl}
                alt={`${data.profile.displayName} cover`}
                className="h-full w-full object-cover"
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
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={data.profile.avatarUrl}
                    alt={`${data.profile.displayName} avatar`}
                    className="h-24 w-24 shrink-0 rounded-[24px] border-4 border-[#111215] bg-zinc-900 object-cover shadow-xl sm:h-28 sm:w-28"
                  />
                ) : (
                  <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-[24px] border-4 border-[#111215] bg-zinc-800 text-3xl font-black text-white shadow-xl sm:h-28 sm:w-28">
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
                <ProfileActions profile={profileForActions} />
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              {data.profile.websiteUrl ? (
                <SocialLink href={data.profile.websiteUrl} label="Website" icon={<Globe2 className="h-4 w-4" />} />
              ) : null}
              {data.profile.instagramHandle ? (
                <SocialLink href={`https://instagram.com/${data.profile.instagramHandle}`} label="Instagram" icon={<Instagram className="h-4 w-4" />} />
              ) : null}
              {data.profile.tiktokHandle ? (
                <SocialLink href={`https://tiktok.com/@${data.profile.tiktokHandle}`} label="TikTok" icon={<Music2 className="h-4 w-4" />} />
              ) : null}
              {data.profile.twitterHandle ? (
                <SocialLink href={`https://x.com/${data.profile.twitterHandle}`} label="X" icon={<Twitter className="h-4 w-4" />} />
              ) : null}
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

        <OptionalAuth>
          <CreatorContentTabs initialData={data} profilePath={profilePath} />
        </OptionalAuth>
      </div>
    </main>
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
