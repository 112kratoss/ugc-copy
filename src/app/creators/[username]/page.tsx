import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Film, Heart, Wand2, Globe, Twitter, Instagram, MapPin } from 'lucide-react';

import { getCreatorProfilePageData } from '@/lib/creator-profile';
import { CreatorContentTabs } from './CreatorContentTabs';
import { ProfileActions } from './ProfileActions';

type CreatorPageProps = {
  params: Promise<{ username: string }>;
};

export async function generateMetadata({ params }: CreatorPageProps): Promise<Metadata> {
  const { username } = await params;
  const data = await getCreatorProfilePageData(username);

  if (!data) {
    return {
      title: 'Creator Not Found',
    };
  }

  return {
    title: `${data.profile.displayName} (@${data.profile.username})`,
    description:
      data.profile.bio ||
      `Browse public showcase work, saves, and remixes from @${data.profile.username} on UGC copy.`,
  };
}

export default async function CreatorPage({ params }: CreatorPageProps) {
  const { username } = await params;
  const data = await getCreatorProfilePageData(username);

  if (!data) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-black py-10 text-white">
      <div className="studio-shell">
        <div className="overflow-hidden rounded-[32px] border border-white/5 bg-zinc-900/40 shadow-[0_0_50px_-30px_rgba(168,85,247,0.35)] backdrop-blur-sm">
          {/* Cover Banner */}
          <div className="h-48 w-full bg-zinc-800 relative">
            {data.profile.coverUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img 
                src={data.profile.coverUrl} 
                alt="Cover" 
                className="w-full h-full object-cover" 
              />
            ) : (
              <div className="w-full h-full bg-gradient-to-r from-purple-900/40 to-pink-900/40" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
          </div>

          <div className="p-8 pt-0 relative">
            <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
              <div className="flex items-start gap-5 -mt-10">
                {data.profile.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={data.profile.avatarUrl}
                    alt={`${data.profile.displayName} avatar`}
                    className="h-24 w-24 rounded-3xl border-4 border-zinc-900 object-cover bg-zinc-900"
                  />
                ) : (
                  <div className="flex h-24 w-24 items-center justify-center rounded-3xl border-4 border-zinc-900 bg-zinc-800 text-3xl font-semibold text-zinc-100 shadow-xl">
                    {data.profile.displayName[0]?.toUpperCase() ?? 'C'}
                  </div>
                )}

                <div className="mt-12 md:mt-10">
                  <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-4">
                    <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{data.profile.displayName}</h1>
                    {data.stats.totalSaves > 10 && (
                      <span className="inline-flex items-center rounded-full bg-purple-500/10 px-2.5 py-0.5 text-xs font-semibold text-purple-400 border border-purple-500/20">
                        Top Creator
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-zinc-400">
                    <span className="font-medium text-purple-300">@{data.profile.username}</span>
                    {data.profile.location && (
                      <>
                        <span>&middot;</span>
                        <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{data.profile.location}</span>
                      </>
                    )}
                  </div>
                  <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300">
                    {data.profile.bio || 'Publishing creator-ready experiments, remixes, and showcase work in progress.'}
                  </p>
                  
                  {/* Social Links */}
                  <div className="mt-5 flex items-center gap-3">
                    {data.profile.websiteUrl && (
                      <a href={data.profile.websiteUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-white/10 hover:text-white transition">
                        <Globe className="h-3.5 w-3.5" /> Website
                      </a>
                    )}
                    {data.profile.twitterHandle && (
                      <a href={`https://twitter.com/${data.profile.twitterHandle}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-white/10 hover:text-white transition">
                        <Twitter className="h-3.5 w-3.5" /> Twitter
                      </a>
                    )}
                    {data.profile.instagramHandle && (
                      <a href={`https://instagram.com/${data.profile.instagramHandle}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-white/10 hover:text-white transition">
                        <Instagram className="h-3.5 w-3.5" /> Instagram
                      </a>
                    )}
                    {data.profile.tiktokHandle && (
                      <a href={`https://tiktok.com/@${data.profile.tiktokHandle}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-white/10 hover:text-white transition">
                        {/* Custom TikTok SVG or fallback text */}
                        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                           <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.536.63 3.092 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93v7.2c0 1.25-.26 2.52-.77 3.65-.67 1.52-1.89 2.75-3.37 3.44-1.15.54-2.45.82-3.71.78-1.47-.03-2.93-.41-4.21-1.17-1.35-.8-2.48-1.99-3.13-3.41-.6-1.28-.86-2.69-.74-4.09.11-1.41.65-2.77 1.48-3.92.83-1.14 1.96-2.02 3.28-2.5 1.35-.5 2.82-.62 4.21-.36v4.11c-.55-.16-1.15-.22-1.72-.11-.64.12-1.22.46-1.67.93-.56.58-.87 1.38-.85 2.19.03.95.42 1.83 1.07 2.49.69.69 1.65 1.07 2.63 1.05.97-.02 1.91-.4 2.62-1.07.72-.69 1.14-1.64 1.18-2.65V.02h-2.39z"/>
                        </svg>
                        TikTok
                      </a>
                    )}
                  </div>
                </div>
              </div>

              <ProfileActions profile={{
                id: data.profile.id,
                username: data.profile.username ?? '',
                displayName: data.profile.displayName ?? '',
                bio: data.profile.bio ?? '',
                avatarUrl: data.profile.avatarUrl ?? '',
                coverUrl: data.profile.coverUrl ?? '',
                websiteUrl: data.profile.websiteUrl ?? '',
                twitterHandle: data.profile.twitterHandle ?? '',
                instagramHandle: data.profile.instagramHandle ?? '',
                tiktokHandle: data.profile.tiktokHandle ?? '',
                location: data.profile.location ?? '',
                // @ts-expect-error Extract credits safely if present, else default
                credits: data.profile.credits ?? 0,
              }} />
            </div>

          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            <div className="rounded-3xl border border-white/5 bg-black/30 p-5">
              <div className="flex items-center gap-3 text-zinc-300">
                <Film className="h-5 w-5 text-purple-300" />
                <span className="text-sm">Public creations</span>
              </div>
              <p className="mt-4 text-3xl font-semibold">{data.stats.publicCreations}</p>
            </div>
            <div className="rounded-3xl border border-white/5 bg-black/30 p-5">
              <div className="flex items-center gap-3 text-zinc-300">
                <Heart className="h-5 w-5 text-pink-300" />
                <span className="text-sm">Total saves</span>
              </div>
              <p className="mt-4 text-3xl font-semibold">{data.stats.totalSaves}</p>
            </div>
            <div className="rounded-3xl border border-white/5 bg-black/30 p-5">
              <div className="flex items-center gap-3 text-zinc-300">
                <Wand2 className="h-5 w-5 text-blue-300" />
                <span className="text-sm">Total remixes</span>
              </div>
              <p className="mt-4 text-3xl font-semibold">{data.stats.totalRemixes}</p>
            </div>
          </div>
          </div>
        </div>

        <CreatorContentTabs items={data.items} />
      </div>
    </div>
  );
}
