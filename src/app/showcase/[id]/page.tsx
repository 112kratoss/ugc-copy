import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { ArrowLeft, BarChart3, Eye, Heart, Share2, Wand2 } from 'lucide-react';

import CreatorIdentity from '@/app/components/CreatorIdentity';
import { recordGenerationShareEvent } from '@/lib/generation-share-events';
import { getPublicGenerationDetail } from '@/lib/public-generations';
import { createMetadata } from '@/lib/seo';
import { buildShowcaseDetailPath } from '@/lib/share';
import ShowcaseDetailActions from './ShowcaseDetailActions';

type ShowcaseDetailPageProps = {
  params: Promise<{ id: string }>;
};

function shouldTrackShareVisit(headerStore: Headers): boolean {
  const purpose = headerStore.get('purpose');
  const prefetchHeader = headerStore.get('next-router-prefetch');

  return purpose !== 'prefetch' && prefetchHeader === null;
}

export async function generateMetadata({ params }: ShowcaseDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const detail = await getPublicGenerationDetail(id);

  if (!detail) {
    return {
      title: 'Creation Not Found',
    };
  }

  return createMetadata({
    title: detail.title,
    description: detail.description,
    path: buildShowcaseDetailPath(detail.id),
    image: detail.category === 'image' ? detail.url : undefined,
  });
}

export default async function ShowcaseDetailPage({ params }: ShowcaseDetailPageProps) {
  const { id } = await params;
  const detail = await getPublicGenerationDetail(id);

  if (!detail) {
    notFound();
  }

  const headerStore = await headers();
  if (shouldTrackShareVisit(headerStore)) {
    await recordGenerationShareEvent({
      generationId: detail.id,
      eventType: 'share_visit',
      sourceSurface: 'detail-page',
    });
  }

  return (
    <div className="min-h-screen bg-black py-8 text-white">
      <div className="fixed inset-0 z-0 pointer-events-none">
        <div className="absolute left-[-10%] top-[-15%] h-[44%] w-[44%] rounded-full bg-purple-900/15 blur-[140px] mix-blend-screen" />
        <div className="absolute bottom-[-12%] right-[-8%] h-[38%] w-[38%] rounded-full bg-pink-900/10 blur-[140px] mix-blend-screen" />
      </div>

      <div className="studio-shell relative z-10 pt-20">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <Link
            href="/showcase"
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.08] hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to showcase
          </Link>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-400">
            <Share2 className="h-3.5 w-3.5" />
            Shared creation
          </div>
        </div>

        <div className="grid gap-8 xl:grid-cols-[minmax(0,1.2fr)_420px]">
          <section className="overflow-hidden rounded-[32px] border border-white/8 bg-zinc-950/70 p-4 shadow-[0_28px_80px_rgba(0,0,0,0.45)] backdrop-blur-sm sm:p-6">
            <div className="overflow-hidden rounded-[24px] border border-white/5 bg-black/70">
              {detail.category === 'image' ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={detail.url}
                  alt={detail.title}
                  className="block max-h-[76vh] w-full object-contain"
                />
              ) : (
                <video
                  src={detail.url}
                  controls
                  autoPlay
                  loop
                  playsInline
                  preload="metadata"
                  className="block max-h-[76vh] w-full object-contain"
                />
              )}
            </div>
          </section>

          <aside className="space-y-6">
            <div className="rounded-[30px] border border-white/8 bg-zinc-900/70 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">UGC copy public page</div>
              <h1 className="mt-3 bg-gradient-to-r from-white to-zinc-400 bg-clip-text text-3xl font-bold tracking-tight text-transparent">
                {detail.title}
              </h1>
              <div className="mt-5">
                <CreatorIdentity creator={detail.creator} />
              </div>
              <p className="mt-4 text-sm leading-7 text-zinc-300">
                {detail.description}
              </p>
              <div className="mt-6">
                <ShowcaseDetailActions
                  generationId={detail.id}
                  title={detail.title}
                  description={detail.description}
                  creatorUsername={detail.creator.username}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-2">
              <div className="rounded-[24px] border border-white/8 bg-black/40 p-5">
                <div className="flex items-center gap-2 text-sm text-zinc-400">
                  <Heart className="h-4 w-4 text-pink-300" />
                  Saves
                </div>
                <div className="mt-3 text-2xl font-semibold text-white">{detail.saveCount}</div>
              </div>
              <div className="rounded-[24px] border border-white/8 bg-black/40 p-5">
                <div className="flex items-center gap-2 text-sm text-zinc-400">
                  <Wand2 className="h-4 w-4 text-purple-300" />
                  Remixes
                </div>
                <div className="mt-3 text-2xl font-semibold text-white">{detail.remixCount}</div>
              </div>
              <div className="rounded-[24px] border border-white/8 bg-black/40 p-5">
                <div className="flex items-center gap-2 text-sm text-zinc-400">
                  <BarChart3 className="h-4 w-4 text-blue-300" />
                  Shares
                </div>
                <div className="mt-3 text-2xl font-semibold text-white">{detail.shareCount}</div>
              </div>
              <div className="rounded-[24px] border border-white/8 bg-black/40 p-5">
                <div className="flex items-center gap-2 text-sm text-zinc-400">
                  <Eye className="h-4 w-4 text-emerald-300" />
                  Visits
                </div>
                <div className="mt-3 text-2xl font-semibold text-white">{detail.shareVisitCount}</div>
              </div>
            </div>

            <div className="rounded-[30px] border border-white/8 bg-zinc-900/70 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Prompt</div>
              <p className="mt-3 max-h-64 overflow-y-auto pr-2 text-sm leading-7 text-zinc-300 custom-scrollbar">
                {detail.prompt || 'No prompt available for this creation.'}
              </p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
