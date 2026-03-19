import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Film, Heart, Sparkles, Wand2 } from 'lucide-react';

import { getCreatorProfilePageData } from '@/lib/creator-profile';

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
    <div className="min-h-screen bg-black px-6 py-10 text-white sm:px-8">
      <div className="mx-auto max-w-6xl">
        <div className="rounded-[32px] border border-white/5 bg-zinc-900/40 p-8 shadow-[0_0_50px_-30px_rgba(168,85,247,0.35)] backdrop-blur-sm">
          <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
            <div className="flex items-start gap-5">
              {data.profile.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={data.profile.avatarUrl}
                  alt={`${data.profile.displayName} avatar`}
                  className="h-20 w-20 rounded-3xl border border-white/10 object-cover"
                />
              ) : (
                <div className="flex h-20 w-20 items-center justify-center rounded-3xl border border-white/10 bg-white/5 text-2xl font-semibold text-zinc-100">
                  {data.profile.displayName[0]?.toUpperCase() ?? 'C'}
                </div>
              )}

              <div>
                <p className="text-sm font-medium uppercase tracking-[0.3em] text-purple-300">Creator Profile</p>
                <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">{data.profile.displayName}</h1>
                <p className="mt-2 text-base text-zinc-400">@{data.profile.username}</p>
                <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300">
                  {data.profile.bio || 'Publishing creator-ready experiments, remixes, and showcase work in progress.'}
                </p>
              </div>
            </div>

            <Link
              href="/showcase"
              className="inline-flex items-center gap-2 self-start rounded-full border border-white/10 bg-black/30 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-white/20 hover:text-white"
            >
              Explore showcase
              <Sparkles className="h-4 w-4" />
            </Link>
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

        <div className="mt-10">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-semibold">Published Work</h2>
              <p className="mt-2 text-sm text-zinc-400">
                Showcase-ready images, videos, and motion studies published under this creator identity.
              </p>
            </div>
          </div>

          {data.items.length === 0 ? (
            <div className="rounded-3xl border border-white/5 bg-zinc-900/20 p-10 text-center text-zinc-400">
              No public creations yet. The next published showcase piece will appear here.
            </div>
          ) : (
            <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
              {data.items.map((item) => (
                <article
                  key={item.id}
                  className="overflow-hidden rounded-3xl border border-white/5 bg-zinc-900/30 shadow-[0_0_40px_-30px_rgba(255,255,255,0.3)]"
                >
                  <div className="relative bg-black">
                    {item.category === 'video' || item.category === 'motion' ? (
                      <video
                        src={item.url}
                        muted
                        loop
                        playsInline
                        autoPlay
                        className="aspect-[4/5] w-full object-cover"
                      />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.url} alt={item.title} className="aspect-[4/5] w-full object-cover" />
                    )}
                    <div className="absolute left-4 top-4 rounded-full border border-white/10 bg-black/50 px-3 py-1 text-xs font-medium capitalize text-zinc-100 backdrop-blur">
                      {item.category}
                    </div>
                  </div>

                  <div className="space-y-4 p-5">
                    <div>
                      <h3 className="text-lg font-semibold text-white">{item.title}</h3>
                      <p className="mt-2 line-clamp-3 text-sm leading-6 text-zinc-400">
                        {item.prompt || 'No prompt captured for this creation yet.'}
                      </p>
                    </div>

                    <div className="flex items-center gap-3 text-sm text-zinc-500">
                      <span>{new Date(item.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                      <span>•</span>
                      <span>{item.saveCount} saves</span>
                      <span>•</span>
                      <span>{item.remixCount} remixes</span>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
