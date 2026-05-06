import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, BarChart3, Eye, Heart, Share2, ShoppingBag, Tag, Wand2 } from 'lucide-react';

import CreatorIdentity from '@/app/components/CreatorIdentity';
import { recordPostShareEvent } from '@/lib/post-share-events';
import {
  getPostReferenceForShowcaseId,
  getPublicPostDetail,
  getPublicPostMetaDescription,
} from '@/lib/public-posts';
import { createMetadata } from '@/lib/seo';
import { buildShowcaseDetailPath, getShowcaseReturnContext } from '@/lib/share';
import { getServerAuthState } from '@/lib/supabase-server';
import { getPostResourceKindLabel, type PostResourceKind } from '@/lib/post-resource-bundles';
import PostResourceBundlePanel from './PostResourceBundlePanel';
import ReportPostButton from './ReportPostButton';
import ShowcaseDetailActions from './ShowcaseDetailActions';

type ShowcaseDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function shouldTrackShareVisit(headerStore: Headers): boolean {
  const purpose = headerStore.get('purpose');
  const prefetchHeader = headerStore.get('next-router-prefetch');

  return purpose !== 'prefetch' && prefetchHeader === null;
}

function formatResourceKinds(kinds: PostResourceKind[]): string {
  if (kinds.length === 0) {
    return 'Reusable parts';
  }

  return kinds.map((kind) => getPostResourceKindLabel(kind)).join(' + ');
}

function formatPostDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

function getPostTypeLabel({
  category,
  mediaKind,
  postFormat,
}: {
  category: string;
  mediaKind: string | null;
  postFormat: string;
}): string {
  if (postFormat === 'text' || category === 'text') {
    return 'Tip / note';
  }

  if (mediaKind === 'video') {
    return 'Video creation';
  }

  if (mediaKind === 'image') {
    return 'Image creation';
  }

  return 'Community creation';
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

  const bundle = detail.resourceBundle;
  const previewKinds = bundle?.lockedPreview?.resourceKinds ?? bundle?.resourceKinds ?? [];
  const previewKindSummary = formatResourceKinds(previewKinds);
  const lockedViewer = Boolean(bundle && !bundle.viewerCanAccess && !bundle.viewerIsOwner);
  const postTypeLabel = getPostTypeLabel({
    category: detail.category,
    mediaKind: detail.mediaKind,
    postFormat: detail.postFormat,
  });
  const sourceToolLabel = detail.sourceTool || (detail.model !== 'external' ? detail.model : null);
  const publicPostFallback = [
    detail.sourceTool ? `Made with ${detail.sourceTool}` : null,
    `${detail.category === 'text' ? 'Tip' : detail.category} by ${detail.creator.name}`,
    bundle ? `${previewKindSummary} unlock attached` : null,
  ].filter(Boolean).join(' · ');
  const statItems = [
    { singular: 'Save', plural: 'Saves', value: detail.saveCount, icon: Heart, color: 'text-pink-300' },
    { singular: 'Remix', plural: 'Remixes', value: detail.remixCount, icon: Wand2, color: 'text-purple-300' },
    { singular: 'Share', plural: 'Shares', value: detail.shareCount, icon: BarChart3, color: 'text-blue-300' },
    { singular: 'Visit', plural: 'Visits', value: detail.shareVisitCount, icon: Eye, color: 'text-emerald-300' },
  ].filter((item) => item.value > 0);

  return (
    <div className="min-h-screen bg-black py-8 text-white">
      <div className="fixed inset-0 z-0 pointer-events-none">
        <div className="absolute left-[-10%] top-[-15%] h-[44%] w-[44%] rounded-full bg-purple-900/15 blur-[140px] mix-blend-screen" />
        <div className="absolute bottom-[-12%] right-[-8%] h-[38%] w-[38%] rounded-full bg-pink-900/10 blur-[140px] mix-blend-screen" />
      </div>

      <div className="studio-shell relative z-10 pt-20">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <Link
            href={returnContext.href}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.08] hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            {returnContext.label}
          </Link>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-400">
            <Share2 className="h-3.5 w-3.5" />
            Shared creation
          </div>
        </div>

        <div className="grid gap-8 xl:grid-cols-[minmax(0,1.2fr)_420px]">
          <section className="overflow-hidden rounded-[32px] border border-white/8 bg-zinc-950/70 p-4 shadow-[0_28px_80px_rgba(0,0,0,0.45)] backdrop-blur-sm sm:p-6">
            <div className="overflow-hidden rounded-[24px] border border-white/5 bg-black/70">
              {detail.mediaKind === 'image' && detail.mediaUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={detail.mediaUrl}
                  alt={detail.title}
                  className="block max-h-[76vh] w-full object-contain"
                />
              ) : detail.mediaKind === 'video' && detail.mediaUrl ? (
                <video
                  src={detail.mediaUrl}
                  controls
                  autoPlay
                  loop
                  playsInline
                  preload="metadata"
                  className="block max-h-[76vh] w-full object-contain"
                />
              ) : (
                <div className="flex min-h-[420px] items-start justify-center bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.14),transparent_40%),linear-gradient(180deg,rgba(10,10,14,1),rgba(6,6,8,1))] p-8">
                  <article className="w-full max-w-3xl rounded-[28px] border border-white/8 bg-zinc-950/85 p-8 shadow-[0_24px_70px_rgba(0,0,0,0.35)]">
                    <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Tip / Note</div>
                    <div className="mt-6 whitespace-pre-wrap text-lg leading-9 text-zinc-100">
                      {detail.body || publicPostFallback}
                    </div>
                  </article>
                </div>
              )}
            </div>
          </section>

          <aside className="space-y-6">
            <div className="rounded-[30px] border border-white/8 bg-zinc-900/70 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Portfolio post</div>
                {sourceToolLabel ? (
                  <span className="inline-flex items-center gap-2 rounded-full border border-sky-300/20 bg-sky-400/10 px-3 py-1 text-xs font-semibold text-sky-50">
                    <Tag className="h-3.5 w-3.5" />
                    {sourceToolLabel}
                  </span>
                ) : null}
              </div>
              <h1 className="mt-3 bg-gradient-to-r from-white to-zinc-400 bg-clip-text text-3xl font-bold tracking-tight text-transparent">
                {detail.title}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-medium text-zinc-500">
                <span>{postTypeLabel}</span>
                <span aria-hidden="true">/</span>
                <span>{formatPostDate(detail.createdAt)}</span>
                {detail.visibility === 'unlisted' ? (
                  <>
                    <span aria-hidden="true">/</span>
                    <span>Unlisted</span>
                  </>
                ) : null}
              </div>
              <div className="mt-5">
                <CreatorIdentity creator={detail.creator} />
              </div>
              {detail.description ? (
                <p className="mt-4 text-sm leading-7 text-zinc-300">
                  {detail.description}
                </p>
              ) : null}
              {bundle ? (
                <Link
                  href="#resources"
                  className="mt-6 block rounded-[26px] border border-emerald-400/20 bg-emerald-500/10 p-4 text-emerald-50 transition hover:border-emerald-300/35 hover:bg-emerald-500/15"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-black/25 px-3 py-1 text-xs font-semibold">
                      <ShoppingBag className="h-3.5 w-3.5" />
                      {bundle.accessMode === 'free' ? 'Free unlock' : 'Paid unlock'}
                    </span>
                    <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs text-emerald-50/80">
                      {bundle.salesCount} sold
                    </span>
                  </div>
                  <div className="mt-4 text-lg font-semibold">
                    {bundle.viewerCanAccess || bundle.viewerIsOwner
                      ? 'Open included unlock'
                      : bundle.accessMode === 'free'
                        ? 'Open free unlock'
                        : `Unlock for ${bundle.priceQuote.formatted}`}
                  </div>
                  <p className="mt-2 text-sm leading-6 text-emerald-50/80">
                    {previewKindSummary} included. The public post stays visible; reusable parts open after verified access.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {previewKinds.map((kind) => (
                      <span
                        key={kind}
                        className="rounded-full border border-emerald-300/20 bg-black/25 px-2.5 py-1 text-xs font-medium text-emerald-50"
                      >
                        {getPostResourceKindLabel(kind)}
                      </span>
                    ))}
                  </div>
                  <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-emerald-300 px-4 py-2 text-sm font-semibold text-slate-950">
                    View unlock
                    <ShoppingBag className="h-4 w-4" />
                  </div>
                </Link>
              ) : null}

              <div className="mt-6 border-t border-white/8 pt-5">
                <ShowcaseDetailActions
                  postId={detail.id}
                  generationId={detail.generationId}
                  title={detail.title}
                  description={getPublicPostMetaDescription(detail)}
                  creatorUsername={detail.creator.username}
                  canRemix={detail.canRemix}
                  visibility={detail.visibility}
                  viewerIsOwner={Boolean(auth.session?.user?.id && auth.session.user.id === detail.creator.id)}
                  hasResourceBundle={Boolean(detail.resourceBundle)}
                />
              </div>
            </div>

            {statItems.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {statItems.map((item) => {
                  const Icon = item.icon;
                  const label = item.value === 1 ? item.singular : item.plural;

                  return (
                    <div
                      key={item.plural}
                      className="inline-flex items-center gap-2 rounded-full border border-white/8 bg-black/40 px-3 py-1.5 text-sm text-zinc-300"
                    >
                      <Icon className={`h-4 w-4 ${item.color}`} />
                      <span>{item.value}</span>
                      <span className="text-zinc-500">{label}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {detail.body ? (
              <div className="rounded-[30px] border border-white/8 bg-zinc-900/70 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
                <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                  {detail.postFormat === 'mixed' ? 'Note' : 'Post'}
                </div>
                <div className="mt-3 max-h-72 overflow-y-auto whitespace-pre-wrap pr-2 text-sm leading-7 text-zinc-300 custom-scrollbar">
                  {detail.body}
                </div>
              </div>
            ) : null}

            {detail.prompt ? (
              <div className="rounded-[30px] border border-white/8 bg-zinc-900/70 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
                <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                  {detail.postFormat === 'text' ? 'Workflow notes' : 'Prompt'}
                </div>
                <p className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap pr-2 text-sm leading-7 text-zinc-300 [overflow-wrap:anywhere] custom-scrollbar">
                  {detail.prompt}
                </p>
              </div>
            ) : null}

            {bundle ? (
              <PostResourceBundlePanel
                postId={detail.id}
                title={bundle.title}
                summary={bundle.summary}
                previewText={bundle.previewText}
                priceLabel={bundle.priceQuote.formatted}
                priceNote={bundle.priceQuote.note}
                isFree={bundle.accessMode === 'free'}
                viewerCanAccess={bundle.viewerCanAccess}
                viewerIsOwner={bundle.viewerIsOwner}
                resourceKinds={bundle.resourceKinds}
                lockedPreview={bundle.lockedPreview}
                salesCount={bundle.salesCount}
                initialResources={bundle.resources
                  ? {
                      promptText: bundle.resources.promptText,
                      notesMarkdown: bundle.resources.notesMarkdown,
                      workflowShareUrl: bundle.resources.workflowShareUrl,
                      attachments: bundle.resources.attachments,
                      allowRemix: bundle.resources.allowRemix,
                    }
                  : null}
              />
            ) : null}

            <ReportPostButton
              postId={detail.id}
              bundleId={detail.resourceBundle?.id ?? null}
              accessToken={auth.session?.access_token ?? null}
            />
          </aside>
        </div>
      </div>

      {bundle && lockedViewer ? (
        <Link
          href="#resources"
          className="fixed inset-x-3 bottom-3 z-40 flex items-center justify-between gap-3 rounded-[22px] border border-emerald-300/25 bg-emerald-300 px-4 py-3 text-slate-950 shadow-[0_18px_60px_rgba(0,0,0,0.45)] xl:hidden"
        >
          <span>
            <span className="block text-sm font-bold">
              {bundle.accessMode === 'free' ? 'Open free unlock' : `Unlock for ${bundle.priceQuote.formatted}`}
            </span>
            <span className="block text-xs font-medium text-slate-800">{previewKindSummary}</span>
          </span>
          <ShoppingBag className="h-5 w-5" />
        </Link>
      ) : null}
    </div>
  );
}
