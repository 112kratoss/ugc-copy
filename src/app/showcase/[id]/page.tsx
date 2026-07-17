import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, BarChart3, BookText, Eye, Heart, Share2, ShoppingBag, Tag, Wand2 } from 'lucide-react';

import CreatorIdentity from '@/app/components/CreatorIdentity';
import ShowcaseMediaCarousel from '@/app/showcase/ShowcaseMediaCarousel';
import { recordPostShareEvent } from '@/lib/post-share-events';
import {
  getPostReferenceForShowcaseId,
  getPublicPostDetail,
  getPublicPostMetaDescription,
} from '@/lib/public-posts';
import { createMetadata } from '@/lib/seo';
import { buildShowcaseDetailPath, getShowcaseReturnContext } from '@/lib/share';
import { isGenerationRecipeAssetId } from '@/lib/showcase';
import { getServerAuthState } from '@/lib/supabase-server';
import { formatUnlockCountLabel, getPostResourceKindLabel, type PostResourceKind } from '@/lib/post-resource-bundles';
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

function normalizeComparableText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
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
  const isPublicRecipeBundle = Boolean(bundle && isGenerationRecipeAssetId(bundle.id));
  const previewKinds = bundle?.lockedPreview?.resourceKinds ?? bundle?.resourceKinds ?? [];
  const previewKindSummary = formatResourceKinds(previewKinds);
  const lockedViewer = Boolean(bundle && !bundle.viewerCanAccess && !bundle.viewerIsOwner);
  const postTypeLabel = getPostTypeLabel({
    category: detail.category,
    mediaKind: detail.mediaKind,
    postFormat: detail.postFormat,
  });
  const isTextOnlyPost = (detail.postFormat === 'text' || detail.category === 'text') && !detail.mediaUrl;
  const sourceToolLabel = detail.sourceTool || (detail.model !== 'external' ? detail.model : null);
  const detailMediaItems = detail.mediaItems?.length
    ? detail.mediaItems
    : detail.mediaUrl && detail.mediaKind
      ? [{
          id: `${detail.id}:cover`,
          url: detail.mediaUrl,
          mediaKind: detail.mediaKind,
          contentType: null,
          originalName: null,
          width: null,
          height: null,
          durationSeconds: null,
          sortOrder: 0,
        }]
      : [];
  const publicPostFallback = [
    detail.sourceTool ? `Made with ${detail.sourceTool}` : null,
    `${detail.category === 'text' ? 'Tip' : detail.category} by ${detail.creator.name}`,
    bundle ? `${previewKindSummary} recipe attached` : null,
  ].filter(Boolean).join(' · ');
  const publicText = detail.body || publicPostFallback || detail.description || detail.title;
  const shouldRenderTextNoteTitle =
    isTextOnlyPost &&
    normalizeComparableText(detail.title) !== normalizeComparableText(publicText);
  const statItems = [
    { singular: 'Save', plural: 'Saves', value: detail.saveCount, icon: Heart, color: 'text-[var(--ui-primary-strong)]' },
    { singular: 'Remix', plural: 'Remixes', value: detail.remixCount, icon: Wand2, color: 'text-[var(--ui-primary)]' },
    { singular: 'Share', plural: 'Shares', value: detail.shareCount, icon: BarChart3, color: 'text-blue-300' },
    { singular: 'Visit', plural: 'Visits', value: detail.shareVisitCount, icon: Eye, color: 'text-emerald-300' },
  ].filter((item) => item.value > 0);
  const resourceBundlePanel = bundle ? (
    <PostResourceBundlePanel
      postId={detail.id}
      title={bundle.title}
      summary={bundle.summary}
      previewText={bundle.previewText}
      priceLabel={bundle.priceQuote.formatted}
      priceUsdCents={bundle.priceUsdCents}
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
            sections: bundle.resources.sections,
            items: bundle.resources.items,
          }
        : null}
    />
  ) : null;

  return (
    <div className="min-h-screen overflow-x-clip bg-[#050506] py-6 text-white">
      <div className="fixed inset-0 z-0 pointer-events-none">
        <div className="absolute left-[8%] top-[-18%] h-[34rem] w-[34rem] rounded-full bg-blue-600/10 blur-[150px] mix-blend-screen" />
        <div className="absolute bottom-[-18%] right-[-8%] h-[34rem] w-[34rem] rounded-full bg-emerald-500/10 blur-[150px] mix-blend-screen" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
      </div>

      <div className="canonical-post-shell studio-shell-wide relative z-10 pt-4 sm:pt-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <Link
            href={returnContext.href}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm font-medium text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            {returnContext.label}
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            {sourceToolLabel ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-sky-300/20 bg-sky-400/10 px-3 py-1.5 text-xs font-semibold text-sky-50">
                <Tag className="h-3.5 w-3.5" />
                {sourceToolLabel}
              </span>
            ) : null}
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-400">
              <Share2 className="h-3.5 w-3.5" />
              Shared post
            </div>
          </div>
        </div>

        <div className="canonical-post-layout">
          <header
            data-testid="canonical-post-identity"
            className="canonical-post-identity min-w-0 overflow-hidden rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(24,24,27,0.86),rgba(10,10,12,0.9))] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.42)] backdrop-blur-xl sm:p-6"
          >
            <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-zinc-500">
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
            <h1 className="mt-3 text-balance text-2xl font-semibold tracking-tight text-white sm:text-3xl">
              {detail.title}
            </h1>
            <div className="mt-5">
              <CreatorIdentity creator={detail.creator} />
            </div>
            {detail.description ? (
              <p className="mt-5 line-clamp-3 border-t border-white/8 pt-4 text-sm leading-7 text-zinc-300">
                {detail.description}
              </p>
            ) : null}
          </header>

          <section
            data-testid="canonical-post-media"
            aria-label={isTextOnlyPost ? 'Post content' : 'Post media'}
            className={isTextOnlyPost
              ? 'canonical-post-media min-w-0'
              : 'canonical-post-media min-w-0 overflow-hidden rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(24,24,27,0.78),rgba(5,5,6,0.92))] p-3 shadow-[0_28px_90px_rgba(0,0,0,0.5)] backdrop-blur-sm sm:p-4'}
          >
            {isTextOnlyPost ? (
              <article
                data-testid="text-detail-note"
                className="mx-auto max-w-4xl rounded-[28px] border border-white/8 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.12),transparent_34%),linear-gradient(180deg,rgba(13,13,18,0.98),rgba(6,6,9,0.98))] p-6 shadow-[0_22px_80px_-58px_rgba(56,189,248,0.75)] sm:p-8"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-2 rounded-full border border-sky-300/20 bg-sky-400/10 px-3 py-1 text-xs font-semibold text-sky-100">
                    <BookText className="h-3.5 w-3.5" />
                    Tip / note
                  </span>
                  {sourceToolLabel ? (
                    <span className="rounded-full border border-white/10 bg-black/35 px-3 py-1 text-xs font-medium text-zinc-200">
                      {sourceToolLabel}
                    </span>
                  ) : null}
                  <span className="rounded-full border border-white/10 bg-black/35 px-3 py-1 text-xs font-medium text-zinc-200">
                    {formatPostDate(detail.createdAt)}
                  </span>
                </div>

                {shouldRenderTextNoteTitle ? (
                  <h2 className="mt-6 max-w-3xl text-3xl font-semibold tracking-tight text-white">
                    {detail.title}
                  </h2>
                ) : null}

                <div className="mt-6 max-w-3xl whitespace-pre-wrap text-base leading-8 text-zinc-100 sm:text-lg sm:leading-9">
                  {publicText}
                </div>
              </article>
            ) : (
              <div data-testid="media-detail-frame" className="relative overflow-hidden rounded-[22px] border border-white/8 bg-black">
                  <div className="absolute left-4 top-4 z-10 flex max-w-[calc(100%-7rem)] flex-wrap gap-2 sm:max-w-[calc(100%-10rem)]">
                    <span className="rounded-full border border-white/10 bg-black/55 px-3 py-1.5 text-xs font-semibold text-zinc-100 backdrop-blur-md">
                      {postTypeLabel}
                    </span>
                    <span className="rounded-full border border-white/10 bg-black/55 px-3 py-1.5 text-xs font-medium text-zinc-300 backdrop-blur-md">
                      {formatPostDate(detail.createdAt)}
                    </span>
                  </div>
                  {detailMediaItems.length > 0 ? (
                    <ShowcaseMediaCarousel
                      mediaItems={detailMediaItems}
                      title={detail.title}
                      mode="detail"
                      allowFullscreen
                      viewportClassName="canonical-post-media-viewport w-full"
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
            )}
          </section>

          <aside
            data-testid="canonical-post-actions"
            className="canonical-post-actions min-w-0 space-y-4"
          >
            <div className="overflow-hidden rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(24,24,27,0.86),rgba(10,10,12,0.9))] shadow-[0_24px_80px_rgba(0,0,0,0.42)] backdrop-blur-xl">
              {bundle ? (
                <Link
                  data-testid="unlock-summary-link"
                  href="#recipe"
                  className="m-5 block rounded-[22px] border border-emerald-300/25 bg-[radial-gradient(circle_at_top_left,rgba(52,211,153,0.2),transparent_50%),rgba(16,185,129,0.08)] p-4 text-emerald-50 transition hover:border-emerald-300/45 hover:bg-emerald-500/15 sm:m-6"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-black/30 px-3 py-1 text-xs font-semibold">
                      <ShoppingBag className="h-3.5 w-3.5" />
                      {isPublicRecipeBundle ? 'Public recipe' : bundle.accessMode === 'free' ? 'Free recipe' : 'Paid recipe'}
                    </span>
                    <span className="rounded-full border border-white/10 bg-black/25 px-3 py-1 text-xs text-emerald-50/80">
                      {formatUnlockCountLabel(bundle.accessMode, bundle.salesCount)}
                    </span>
                  </div>
                  <div className="mt-3 text-lg font-semibold tracking-tight">
                    {bundle.accessMode === 'free'
                      ? isPublicRecipeBundle ? 'Creation recipe available' : 'Free recipe available'
                      : `${bundle.priceQuote.formatted} recipe available`}
                  </div>
                  <p className="mt-2 text-sm leading-6 text-emerald-50/80">
                    {previewKindSummary} included. The public post stays visible; reusable parts open after verified access.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {previewKinds.map((kind) => (
                      <span
                        key={kind}
                        className="rounded-full border border-emerald-300/20 bg-black/25 px-2.5 py-1 text-xs font-medium text-emerald-50"
                      >
                        {getPostResourceKindLabel(kind)}
                      </span>
                    ))}
                  </div>
                  <div className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-full bg-emerald-300 px-4 py-2.5 text-sm font-semibold text-slate-950">
                    {isPublicRecipeBundle ? 'View recipe' : bundle.accessMode === 'free' ? 'Unlock free recipe' : `Unlock for ${bundle.priceQuote.formatted}`}
                    <ShoppingBag className="h-4 w-4" />
                  </div>
                </Link>
              ) : null}

              <div className={bundle ? 'border-t border-white/8 p-5 sm:p-6' : 'p-5 sm:p-6'}>
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
              <div className="canonical-post-stats grid gap-2">
                {statItems.map((item) => {
                  const Icon = item.icon;
                  const label = item.value === 1 ? item.singular : item.plural;

                  return (
                    <div
                      key={item.plural}
                      className="flex min-w-0 items-center gap-2 rounded-2xl border border-white/8 bg-white/[0.035] px-3 py-3 text-sm text-zinc-300 backdrop-blur-sm sm:gap-3"
                    >
                      <Icon className={`h-4 w-4 shrink-0 ${item.color}`} />
                      <span className="shrink-0 font-semibold text-zinc-100">{item.value}</span>
                      <span className="min-w-0 truncate text-zinc-500">{label}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {detail.body && !isTextOnlyPost ? (
              <div data-testid="post-body-panel" className="rounded-[24px] border border-white/8 bg-zinc-900/60 p-5 shadow-[0_24px_60px_rgba(0,0,0,0.28)] backdrop-blur-sm">
                <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                  {detail.postFormat === 'mixed' ? 'Note' : 'Post'}
                </div>
                <div className="mt-3 max-h-72 overflow-y-auto whitespace-pre-wrap pr-2 text-sm leading-7 text-zinc-300 custom-scrollbar">
                  {detail.body}
                </div>
              </div>
            ) : null}

            {detail.prompt ? (
              <div className="rounded-[24px] border border-white/8 bg-zinc-900/60 p-5 shadow-[0_24px_60px_rgba(0,0,0,0.28)] backdrop-blur-sm">
                <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                  {detail.postFormat === 'text' ? 'Workflow notes' : 'Prompt'}
                </div>
                <p className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap pr-2 text-sm leading-7 text-zinc-300 [overflow-wrap:anywhere] custom-scrollbar">
                  {detail.prompt}
                </p>
              </div>
            ) : null}

            <ReportPostButton
              postId={detail.id}
              bundleId={detail.resourceBundle?.id ?? null}
              accessToken={auth.session?.access_token ?? null}
            />
          </aside>
        </div>

        {resourceBundlePanel ? (
          <div data-testid="canonical-post-recipe" className="mt-6 min-w-0">
            {resourceBundlePanel}
          </div>
        ) : null}
      </div>

      {bundle && lockedViewer ? (
        <Link
          href="#recipe"
          className="canonical-post-mobile-cta fixed inset-x-3 bottom-3 z-40 flex items-center justify-between gap-3 rounded-[22px] border border-emerald-300/25 bg-emerald-300 px-4 py-3 text-slate-950 shadow-[0_18px_60px_rgba(0,0,0,0.45)]"
        >
          <span>
            <span className="block text-sm font-bold">
              {isPublicRecipeBundle ? 'View recipe' : bundle.accessMode === 'free' ? 'Unlock free recipe' : `Unlock for ${bundle.priceQuote.formatted}`}
            </span>
            <span className="block text-xs font-medium text-slate-800">{previewKindSummary}</span>
          </span>
          <ShoppingBag className="h-5 w-5" />
        </Link>
      ) : null}
    </div>
  );
}
