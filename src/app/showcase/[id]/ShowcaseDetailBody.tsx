import Link from 'next/link';
import { BookText, ShoppingBag } from 'lucide-react';

import PostCommentAvatar from '@/app/components/PostCommentAvatar';
import PostComments from '@/app/components/PostComments';
import { formatRelativeTime, getPostFeedTitle, type PostPreviewKind } from '@/lib/post-feed-presentation';
import ShowcaseMediaCarousel from '@/app/showcase/ShowcaseMediaCarousel';
import { getPostResourceKindLabel, type PostResourceKind } from '@/lib/post-resource-bundles';
import { getPublicPostMetaDescription, type PublicPostDetail } from '@/lib/public-posts';
import type { ShowcaseReturnContext } from '@/lib/share';
import { isGenerationRecipeAssetId } from '@/lib/showcase';

import PostResourceBundlePanel from './PostResourceBundlePanel';
import ReportPostButton from './ReportPostButton';
import ShowcaseDetailActions from './ShowcaseDetailActions';
import ShowcaseDetailBackLink from './ShowcaseDetailBackLink';
import ShowcaseDetailEngagementRow from './ShowcaseDetailEngagementRow';

/**
 * The post detail, rendered identically by the full page (`/showcase/[id]`)
 * and by the intercepting-route overlay that opens above the feed.
 *
 * `page` owns the standalone chrome — full-bleed background, ambient glow, the
 * return link, and a viewport-fixed unlock CTA. `overlay` drops all four: the
 * modal shell supplies the surface and the Close control, and a `fixed` CTA
 * inside a scrolling panel would pin to the viewport instead of the panel.
 * Everything between those two is shared, so the two surfaces cannot drift.
 */
export type ShowcaseDetailVariant = 'page' | 'overlay';

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

export default function ShowcaseDetailBody({
  detail,
  viewerUserId,
  accessToken,
  returnContext,
  variant = 'page',
}: {
  detail: PublicPostDetail;
  viewerUserId: string | null;
  accessToken: string | null;
  /** Required by the `page` variant, which renders the return link. */
  returnContext?: ShowcaseReturnContext;
  variant?: ShowcaseDetailVariant;
}) {
  const isOverlay = variant === 'overlay';
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
  // The same title rules as the feed card: a placeholder like "Untitled
  // Creation" gives way to the prompt or body instead of leaking into the h1.
  const previewKind: PostPreviewKind = isTextOnlyPost
    ? 'text'
    : detail.postFormat === 'mixed' && (detail.body ?? '').trim()
      ? 'mixed'
      : 'media';
  const displayTitle = getPostFeedTitle({
    title: detail.title,
    prompt: detail.prompt,
    body: detail.body,
    creationMode: null,
    mediaKind: detail.mediaKind,
    category: detail.category,
  }, previewKind);
  // The title always renders for a text post now, so it is the body that gives
  // way when the two are the same line — the fallback chain above can resolve
  // `publicText` to the title itself on a post with no body.
  const shouldRenderTextNoteBody =
    isTextOnlyPost &&
    normalizeComparableText(publicText) !== normalizeComparableText(displayTitle);
  // The description is the creator's caption. (It used to be compared against
  // the recipe's notes because the quick publish modal prefilled it with
  // them; the modal no longer does, and 20260824090000 cleared the rows it
  // had left behind.)
  const shouldRenderLede = !isTextOnlyPost && Boolean(detail.description);
  const resourceBundlePanel = bundle ? (
    <PostResourceBundlePanel
      postId={detail.id}
      mediaItems={detailMediaItems}
      title={bundle.title}
      suppressTitle={normalizeComparableText(bundle.title) === normalizeComparableText(displayTitle)}
      summary={bundle.summary}
      previewText={bundle.previewText}
      priceLabel={bundle.priceQuote.formatted}
      priceUsdCents={bundle.priceUsdCents}
      priceNote={bundle.priceQuote.note}
      isFree={bundle.accessMode === 'free'}
      isPublic={isPublicRecipeBundle}
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
      purchasedRevision={bundle.purchasedRevision
        ? {
            revisionNumber: bundle.purchasedRevision.revisionNumber,
            purchasedAt: bundle.purchasedRevision.purchasedAt,
            title: bundle.purchasedRevision.title,
            summary: bundle.purchasedRevision.summary,
            previewText: bundle.purchasedRevision.previewText,
            accessMode: bundle.purchasedRevision.accessMode,
            priceUsdCents: bundle.purchasedRevision.priceUsdCents,
            mediaItems: bundle.purchasedRevision.mediaItems,
            resources: {
              promptText: bundle.purchasedRevision.resources.promptText,
              notesMarkdown: bundle.purchasedRevision.resources.notesMarkdown,
              workflowShareUrl: bundle.purchasedRevision.resources.workflowShareUrl,
              attachments: bundle.purchasedRevision.resources.attachments,
              allowRemix: bundle.purchasedRevision.resources.allowRemix,
              sections: bundle.purchasedRevision.resources.sections,
              items: bundle.purchasedRevision.resources.items,
            },
          }
        : null}
    />
  ) : null;
  /*
   * Every post reads as one column, the way Reddit orders it: the post, then
   * the conversation, then the recipe — all beside the rail. The recipe
   * trails the comments and is pitched nowhere else; the locked-viewer
   * bottom CTA covers viewports where the panel sits below the fold.
   */
  const recipeBlock = resourceBundlePanel ? (
    <div
      data-testid="canonical-post-recipe"
      className="mt-8 w-full min-w-0 max-w-4xl border-t border-white/8 pt-8"
    >
      {resourceBundlePanel}
    </div>
  ) : null;
  const commentsBlock = detail.visibility === 'public' ? (
    <div
      id="comments"
      data-testid="canonical-post-comments"
      className="mt-8 w-full min-w-0 max-w-4xl scroll-mt-24"
    >
      <PostComments
        postId={detail.id}
        postCreatorId={detail.creator.id}
        commentCount={detail.commentCount}
      />
    </div>
  ) : null;

  return (
    <div className={isOverlay
      ? 'text-white'
      : 'min-h-screen overflow-x-clip bg-[#050506] py-6 text-white'}
    >
      {isOverlay ? null : (
        <div className="fixed inset-0 z-0 pointer-events-none">
          <div className="absolute left-[8%] top-[-18%] h-[34rem] w-[34rem] rounded-full bg-blue-600/10 blur-[150px] mix-blend-screen" />
          <div className="absolute bottom-[-18%] right-[-8%] h-[34rem] w-[34rem] rounded-full bg-emerald-500/10 blur-[150px] mix-blend-screen" />
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
        </div>
      )}

      <div className={isOverlay
        ? 'canonical-post-shell canonical-post-shell-overlay relative z-10'
        : 'canonical-post-shell studio-shell-wide relative z-10 pt-4 sm:pt-6'}
      >
        {returnContext && !isOverlay ? (
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <ShowcaseDetailBackLink href={returnContext.href} label={returnContext.label} />
          </div>
        ) : null}

        <div className="canonical-post-layout">
          {/*
            * The masthead owns its own grid row so the rail can start level
            * with the media rather than with the byline — attribution reads
            * above the post, the way a document titles itself.
            */}
          <header
            data-testid="canonical-post-head"
            className="canonical-post-head w-full min-w-0 max-w-4xl"
          >
                {/* One breath of attribution: who, when, what kind — a single line. */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-xs text-zinc-500">
                  {detail.creator.username ? (
                    <Link
                      href={`/creators/${detail.creator.username}`}
                      className="ui-focus-ring flex min-w-0 items-center gap-2 rounded-full font-semibold text-zinc-200 transition hover:text-white"
                    >
                      <PostCommentAvatar avatarUrl={detail.creator.avatar} name={detail.creator.name} size={24} />
                      <span className="truncate">{`@${detail.creator.username}`}</span>
                    </Link>
                  ) : (
                    <div className="flex min-w-0 items-center gap-2 font-semibold text-zinc-200">
                      <PostCommentAvatar avatarUrl={detail.creator.avatar} name={detail.creator.name} size={24} />
                      <span className="truncate">{detail.creator.name}</span>
                    </div>
                  )}
                  <span aria-hidden="true">·</span>
                  <span title={formatPostDate(detail.createdAt)}>{formatRelativeTime(detail.createdAt)}</span>
                  {!isTextOnlyPost && sourceToolLabel ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{sourceToolLabel}</span>
                    </>
                  ) : null}
                  {detail.visibility === 'unlisted' ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>Unlisted</span>
                    </>
                  ) : null}
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-300/20 bg-sky-400/10 px-2.5 py-0.5 text-[11px] font-semibold text-sky-100">
                    {isTextOnlyPost ? <BookText className="h-3 w-3" aria-hidden="true" /> : null}
                    {postTypeLabel}
                  </span>
                </div>

                <h1 className="mt-4 text-balance text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                  {displayTitle}
                </h1>

                {shouldRenderLede ? (
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-300">
                    {detail.description}
                  </p>
                ) : null}
          </header>

          <section
            data-testid="canonical-post-media"
            aria-label="Post content"
            className="canonical-post-media min-w-0"
          >
            {/*
              * The post body: media as an attachment, the writing, then the
              * engagement row. No card chrome — the post sits on the page.
              */}
            <article
              data-testid={isTextOnlyPost ? 'text-detail-note' : 'media-detail-document'}
              className="w-full max-w-4xl"
            >
                {/*
                  * A bare wrapper: the carousel's viewport carries the frame
                  * chrome and now shrinks to the media, so any background here
                  * would show as bars beside a narrow portrait.
                  */}
                {!isTextOnlyPost && detailMediaItems.length > 0 ? (
                  <div data-testid="media-detail-frame">
                    <ShowcaseMediaCarousel
                      mediaItems={detailMediaItems}
                      title={displayTitle}
                      mode="detail"
                      allowFullscreen
                      viewportClassName="canonical-post-media-viewport w-full border border-white/8"
                    />
                  </div>
                ) : null}

                {/* First child on a text post — the masthead row already spaced it. */}
                {isTextOnlyPost && shouldRenderTextNoteBody ? (
                  <div className="whitespace-pre-wrap text-base leading-8 text-zinc-100">
                    {publicText}
                  </div>
                ) : null}

                {!isTextOnlyPost
                  && detail.body
                  && normalizeComparableText(detail.body) !== normalizeComparableText(displayTitle) ? (
                  <div className="mt-5 whitespace-pre-wrap text-base leading-8 text-zinc-100">
                    {detail.body}
                  </div>
                ) : null}

                <ShowcaseDetailEngagementRow
                  postId={detail.id}
                  generationId={detail.generationId}
                  title={displayTitle}
                  shareDescription={getPublicPostMetaDescription(detail)}
                  canRemix={detail.canRemix}
                  saveCount={detail.saveCount}
                  commentCount={detail.commentCount}
                  remixCount={detail.remixCount}
                  shareVisitCount={detail.shareVisitCount}
                  showComments={detail.visibility === 'public'}
                />
            </article>
            {commentsBlock}
            {recipeBlock}
          </section>

          <aside
            data-testid="canonical-post-actions"
            className="canonical-post-actions min-w-0 space-y-4"
          >
            <div className="overflow-hidden rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(24,24,27,0.86),rgba(10,10,12,0.9))] shadow-[0_24px_80px_rgba(0,0,0,0.42)] backdrop-blur-xl">
              {/*
                * A pointer, not a pitch: the recipe is presented once, in the
                * document column, but it sits below the whole conversation —
                * this sticky one-liner keeps it reachable at any scroll depth.
                */}
              {bundle ? (
                <Link
                  data-testid="recipe-jump-link"
                  href="#recipe"
                  className="flex items-center justify-between gap-3 border-b border-white/8 px-5 py-3.5 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-500/[0.06] sm:px-6"
                >
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <ShoppingBag className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">
                      {isPublicRecipeBundle
                        ? 'Public recipe'
                        : lockedViewer && bundle.accessMode !== 'free'
                          ? `${bundle.priceQuote.formatted} recipe`
                          : bundle.accessMode === 'free'
                            ? 'Free recipe'
                            : 'Recipe unlocked'}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs font-medium text-emerald-200/70">
                    {lockedViewer && bundle.accessMode !== 'free' && !isPublicRecipeBundle ? 'Unlock' : 'View'}
                  </span>
                </Link>
              ) : null}
              <div className="p-5 sm:p-6">
                <ShowcaseDetailActions
                  postId={detail.id}
                  generationId={detail.generationId}
                  title={displayTitle}
                  description={getPublicPostMetaDescription(detail)}
                  creatorUsername={detail.creator.username}
                  canRemix={detail.canRemix}
                  visibility={detail.visibility}
                  viewerIsOwner={Boolean(viewerUserId && viewerUserId === detail.creator.id)}
                  hasResourceBundle={Boolean(detail.resourceBundle)}
                  bundle={bundle
                    ? { accessMode: bundle.accessMode, status: bundle.status, salesCount: bundle.salesCount }
                    : null}
                  showShare={false}
                  showRemix={false}
                />
              </div>

              {detail.prompt ? (
                <div className="border-t border-white/8 px-5 py-4 sm:px-6">
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
                accessToken={accessToken}
              />
            </div>
          </aside>
        </div>
      </div>

      {bundle && lockedViewer ? (
        <Link
          href="#recipe"
          className={isOverlay
            ? 'canonical-post-mobile-cta sticky inset-x-0 bottom-3 z-40 mx-3 flex items-center justify-between gap-3 rounded-[22px] border border-emerald-300/25 bg-emerald-300 px-4 py-3 text-slate-950 shadow-[0_18px_60px_rgba(0,0,0,0.45)]'
            : 'canonical-post-mobile-cta fixed inset-x-3 bottom-3 z-40 flex items-center justify-between gap-3 rounded-[22px] border border-emerald-300/25 bg-emerald-300 px-4 py-3 text-slate-950 shadow-[0_18px_60px_rgba(0,0,0,0.45)]'}
        >
          <span>
            <span className="block text-sm font-bold">
              {isPublicRecipeBundle ? 'View recipe' : bundle.accessMode === 'free' ? 'View free recipe' : `Unlock recipe for ${bundle.priceQuote.formatted}`}
            </span>
            <span className="block text-xs font-medium text-slate-800">{previewKindSummary}</span>
          </span>
          <ShoppingBag className="h-5 w-5" />
        </Link>
      ) : null}
    </div>
  );
}
