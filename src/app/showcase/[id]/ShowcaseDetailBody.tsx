'use client';

import NsfwPostReveal from '@/components/NsfwPostReveal';
import Link from 'next/link';
import { Suspense, useRef } from 'react';
import { BookText, ShoppingBag } from 'lucide-react';

import { InviteHandoffBar } from '@/components/InviteHandoffBar';
import PostCommentAvatar from '@/components/PostCommentAvatar';
import {
  getPostFeedTitle,
  getPostMadeWithLabel,
  type PostPreviewKind,
} from '@/lib/post-feed-presentation';
import ShowcaseMediaCarousel from '@/app/showcase/ShowcaseMediaCarousel';
import {
  formatPostResourcePriceLabel,
  getPostResourceKindLabel,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';
import type { PostResourceBundleDetail } from '@/lib/post-resource-bundles-server';
import type { PublicPostDetail } from '@/lib/public-posts';

import RemixCreditLine from '@/app/showcase/RemixCreditLine';

import PostGenerationSetupLine from './PostGenerationSetupLine';
import PostRelativeTime from './PostRelativeTime';
import PostResourceBundlePanel from './PostResourceBundlePanel';
import { ownerFirstPaintRules } from './owner-first-paint';
import { showRecipeJump } from './recipe-jump';
import { buildRecipePanelProps, getRecipeRemixOffer } from './recipe-panel-props';
import ReportPostButton from './ReportPostButton';
import ShowcaseDetailActions from './ShowcaseDetailActions';
import ShowcaseDetailBackLink from './ShowcaseDetailBackLink';
import {
  ShowcaseDetailCommentCountProvider,
  ShowcaseDetailComments,
  ShowcaseDetailCommentsPanel,
} from './ShowcaseDetailCommentCount';
import ShowcaseDetailEngagementRow from './ShowcaseDetailEngagementRow';
import ShowcasePostUnavailable from './ShowcasePostUnavailable';
import { usePostRailTop } from './usePostRailTop';
import { ShowcaseSearchParamsReporter, useShowcasePostViewer } from './useShowcasePostViewer';

/**
 * The post detail page body: full-bleed background, ambient glow, the return
 * link, and a viewport-fixed unlock CTA around the shared document layout.
 *
 * A client component since the page is cached for everyone (2026-11-04): the
 * server draws it for a signed-out visitor, and `useShowcasePostViewer` turns
 * it into this viewer's page in the browser (their recipe, Owner tools, their
 * Remix, a block, the way back the address names).
 */

function formatResourceKinds(kinds: PostResourceKind[]): string {
  if (kinds.length === 0) {
    return 'Reusable parts';
  }

  return kinds.map((kind) => getPostResourceKindLabel(kind)).join(' + ');
}

function normalizeComparableText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The rail's pointer to the recipe, as one viewer reads it. */
type RecipeLinkWords = { label: string; action: string };

/** The creator's words for their own recipe, whatever it costs anyone else. */
const OWN_RECIPE_WORDS: RecipeLinkWords = { label: 'Your recipe', action: 'View' };

/**
 * The pointer's words for a viewer whose recipe it is not: "Unlocked" once they have it, else
 * its price (or "Free recipe") and what the click does.
 */
function recipeLinkWords(bundle: PostResourceBundleDetail, lockedViewer: boolean): RecipeLinkWords {
  if (bundle.viewerIsOwner) return OWN_RECIPE_WORDS;
  return {
    label: !lockedViewer
      ? 'Unlocked'
      : bundle.accessMode !== 'free'
        ? formatPostResourcePriceLabel(bundle.priceUsdCents, bundle.priceQuote.formatted)
        : 'Free recipe',
    action: lockedViewer && bundle.accessMode !== 'free' ? 'Unlock' : 'View',
  };
}

/**
 * The words this render knows the viewer reads. The server's HTML, and the render that hydrates
 * it, know no viewer: there they are everyone else's, drawn beside the creator's, and the page's
 * rule shows one (`ownerFirstPaintRules`).
 */
function RecipeWords({
  words,
  creators,
  mark,
}: {
  words: string;
  creators: string;
  /** The creator's account, in the server's HTML and the render that hydrates it only. */
  mark: string | undefined;
}) {
  if (!mark || words === creators) return words;
  return (
    <>
      <span data-post-recipe-pitch={mark}>{words}</span>
      <span data-post-recipe-owner={mark}>{creators}</span>
    </>
  );
}

function getPostTypeLabel({
  category,
  creationMode,
  mediaKind,
  postFormat,
}: {
  category: string;
  creationMode: 'motion' | null;
  mediaKind: string | null;
  postFormat: string;
}): string {
  // "Text", beside Image, Video and Motion, as the feed card and the app name it.
  if (postFormat === 'text' || category === 'text') {
    return 'Text';
  }

  // A motion post is a video by category, so it has to be asked first; the
  // feed card names it the same way (`getPostFeedTitle`).
  if (creationMode === 'motion') {
    return 'Motion creation';
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
  shareDescription,
  renderedAt,
}: {
  /** The post as a signed-out visitor reads it: the page's cached read. */
  detail: PublicPostDetail;
  /** `getPublicPostMetaDescription(detail)`, which only the server can import. */
  shareDescription: string;
  /** When the server drew the page, for the post's age in the cached HTML. */
  renderedAt: number;
}) {
  // The server never reveals, so an NSFW post arrives as its cover: the
  // creator, counts and visibility are real, the content is a placeholder. The
  // gate takes the place of the content only; the byline, the rail (Report,
  // Block, Owner tools) and the engagement row stay, as the app keeps them.
  const isNsfwCovered = Boolean(detail.isNsfw && !detail.nsfwRevealed);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const pageRemix = {
    canRemix: detail.canRemix,
    remixCapability: detail.remixCapability,
    remixTarget: detail.remixTarget,
  };
  const viewer = useShowcasePostViewer({
    postId: detail.id,
    creatorId: detail.creator.id,
    visibility: detail.visibility,
    isNsfwCovered,
    pageBundle: detail.resourceBundle,
    pageRemix,
    pageRemixCredit: detail.remixCredit ?? null,
    hasCreation: Boolean(detail.generationId),
  });
  // For the owner, the visibility they just saved here: the cached page may not have caught up.
  const { bundle, lockedViewer, ownership, deliveryId, returnContext, visibility } = viewer;
  // The creator's rail from the first frame, whatever the session check has said so far: their
  // tools, and no report of their own post, which other readers get (`ShowcasePostOwnership`).
  const ownerTools = ownership === 'owner'
    ? 'ready'
    : ownership === 'owner-checking'
      ? 'checking'
      : ownership === 'unread'
        ? 'unread'
        : null;
  const drawsReportRows = ownership === 'unread' || ownership === 'other';
  // The creator's recipe is theirs from the first frame, decided as their tools are: "Your recipe"
  // in the rail, and no bar along the bottom edge pitching it to them. It waited for their own read
  // of the recipe, which the cached page cannot hold, and until it landed they were offered their
  // own recipe (sweep of 2026-11-17). A buyer's "Unlocked" is their read's alone, and comes with it.
  const viewerIsCreator = ownership === 'owner' || ownership === 'owner-checking';
  // In the server's HTML and the render that hydrates it, the creator's words are drawn beside
  // everyone else's, and the page's rule shows the creator theirs (`ownerFirstPaintRules`).
  const recipeMark = ownership === 'unread' && detail.creator.id ? detail.creator.id : undefined;
  const recipeWords = !bundle ? null : viewerIsCreator ? OWN_RECIPE_WORDS : recipeLinkWords(bundle, lockedViewer);
  // The unlock bar and the room kept for it under the post, for a viewer who has not got the recipe.
  const pitchesRecipe = Boolean(bundle && lockedViewer && !viewerIsCreator);
  // The rail ends inside the window: it is told where its top is.
  usePostRailTop(layoutRef, `${detail.id}:${viewer.blocked ? 'blocked' : 'drawn'}`);
  const previewKinds = bundle?.lockedPreview?.resourceKinds ?? bundle?.resourceKinds ?? [];
  const previewKindSummary = formatResourceKinds(previewKinds);
  const postTypeLabel = getPostTypeLabel({
    category: detail.category,
    creationMode: detail.creationMode,
    mediaKind: detail.mediaKind,
    postFormat: detail.postFormat,
  });
  const isTextOnlyPost = (detail.postFormat === 'text' || detail.category === 'text') && !detail.mediaUrl;
  // What the post was made with: its model by the name the feed card gives it
  // (the slug, "nano-banana-2", was printed here), else an outside tool its
  // creator named; nothing on a text post (`getPostMadeWithLabel`, which the
  // search card's line reads too).
  const madeWithLabel = getPostMadeWithLabel(detail);
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
    madeWithLabel ? `Made with ${madeWithLabel}` : null,
    `${detail.category === 'text' ? 'Text' : detail.category} by ${detail.creator.name}`,
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
    creationMode: detail.creationMode,
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
  // A creation post's recipe brings its Remix (S1): locked behind the recipe
  // for a viewer without it, and named in the panel either way (B-F3).
  const remixOffer = getRecipeRemixOffer({
    ...viewer.remix,
    bundle,
  });
  // Whether the recipe includes the Remix is the recipe's to say, whoever is looking: read from the
  // page's own offer, it reads the same for the creator of a post with no creation, who has no Remix
  // of their own, and the same as before for everyone else.
  const recipeIncludesRemix = getRecipeRemixOffer({ ...pageRemix, bundle }).remixIncluded;
  const resourceBundlePanel = bundle ? (
    <PostResourceBundlePanel
      // Starts again from the viewer's own read of the recipe when it lands;
      // the panel's own unlock moves the rest of the page with it instead.
      key={viewer.bundlePanelKey}
      {...buildRecipePanelProps(bundle, {
        postId: detail.id,
        mediaItems: detailMediaItems,
        displayTitle,
        remixIncluded: recipeIncludesRemix,
      })}
      onAccessChange={viewer.applyBundleAccess}
    />
  ) : null;
  /*
   * Every post reads as one column: the post, then its recipe, then the
   * conversation — all beside the rail. The recipe sat after the whole thread
   * (its buy button some 1,270px down on a laptop); it comes before it now, and
   * is pitched nowhere else. The rail's pointer and the locked-viewer bottom
   * CTA still reach it from anywhere on the page.
   */
  const recipeBlock = resourceBundlePanel ? (
    <div
      data-testid="canonical-post-recipe"
      className="mt-8 w-full min-w-0 max-w-4xl border-t border-white/8 pt-8"
    >
      {resourceBundlePanel}
    </div>
  ) : null;
  /*
   * The prompt of a post with no recipe, where a recipe would show its own:
   * under the post, in the document column. It sat in the rail's card, so the
   * same words were beside the picture on one post and under it on the next
   * (owner, 2026-11-13). A post with a recipe sends no prompt at all
   * (`sanitizePublicPostContent`), so the two never draw together.
   */
  const promptBlock = detail.prompt ? (
    <div
      data-testid="canonical-post-prompt"
      className="mt-8 w-full min-w-0 max-w-4xl border-t border-white/8 pt-8"
    >
      <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
        {detail.postFormat === 'text' ? 'Workflow notes' : 'Prompt'}
      </h2>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-300 [overflow-wrap:anywhere]">
        {detail.prompt}
      </p>
    </div>
  ) : null;
  // The conversation is a panel in the rail, beside the post. Under an NSFW
  // cover it stays in the document column, where the gate shows it with the
  // post it reveals: the rail is outside the gate and knows nothing of it.
  const commentsAreOpen = visibility === 'public';
  const coveredCommentsBlock = commentsAreOpen && isNsfwCovered ? (
    <div
      id="comments"
      data-testid="canonical-post-comments"
      className="mt-8 w-full min-w-0 max-w-4xl scroll-mt-24"
    >
      <ShowcaseDetailComments
        postId={detail.id}
        postCreatorId={detail.creator.id}
        commentCount={detail.commentCount}
        deliveryId={deliveryId}
      />
    </div>
  ) : null;
  const engagementRow = (
    <ShowcaseDetailEngagementRow
      postId={detail.id}
      generationId={detail.generationId}
      creatorId={detail.creator.id}
      title={displayTitle}
      shareDescription={shareDescription}
      canRemix={viewer.remix.canRemix}
      saveCount={detail.saveCount}
      commentCount={detail.commentCount}
      remixCount={detail.remixCount}
      shareVisitCount={detail.shareVisitCount}
      showComments={commentsAreOpen}
      recipeRemix={remixOffer.recipeRemix}
      creatorRemixMark={recipeMark}
      creatorCanRemix={viewer.creatorRemix.canRemix}
      remixHeld={ownership === 'owner-checking'}
    />
  );

  if (viewer.blocked) {
    return <ShowcasePostUnavailable />;
  }

  return (
    <div className="min-h-screen overflow-x-clip bg-[#050506] py-6 text-white">
      {/* Ahead of everything it picks between (the engagement row's Remix, the rail's rows and the
          recipe's bar), so none is painted before it applies. */}
      {ownership === 'unread' && detail.creator.id ? <style>{ownerFirstPaintRules(detail.creator.id)}</style> : null}
      {/* The page's query, read once it is live: the cached render has none. */}
      <Suspense fallback={null}>
        <ShowcaseSearchParamsReporter onSearch={viewer.reportSearch} />
      </Suspense>
      <div className="fixed inset-0 z-0 pointer-events-none">
        <div className="absolute left-[8%] top-[-18%] h-[34rem] w-[34rem] rounded-full bg-blue-600/10 blur-[150px] mix-blend-screen" />
        <div className="absolute bottom-[-18%] right-[-8%] h-[34rem] w-[34rem] rounded-full bg-emerald-500/10 blur-[150px] mix-blend-screen" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
      </div>

      {/* A visitor a shared link's invite came with: the way to keep it, here or in the app. */}
      <div className="relative z-10">
        <InviteHandoffBar handoff={viewer.inviteHandoff} />
      </div>

      <div className="canonical-post-shell studio-shell-wide relative z-10 pt-4 sm:pt-6">
        {/* Its own row, drawn only for a viewer who came here from another page of the site. */}
        <ShowcaseDetailBackLink
          href={returnContext.href}
          label={returnContext.label}
          stepsBackOnly={returnContext.source === 'unnamed'}
        />

        <ShowcaseDetailCommentCountProvider key={detail.id} initialCount={detail.commentCount}>
        <div ref={layoutRef} className="canonical-post-layout">
          {/*
            * The masthead owns its own grid row: attribution reads above the
            * post, the way a document titles itself. The rail runs beside
            * both rows since it took the conversation in.
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
                  <PostRelativeTime createdAt={detail.createdAt} renderedAt={renderedAt} />
                  {madeWithLabel ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{`Made with ${madeWithLabel}`}</span>
                    </>
                  ) : null}
                  {visibility === 'unlisted' ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>Unlisted</span>
                    </>
                  ) : null}
                  {isNsfwCovered ? null : (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-300/20 bg-sky-400/10 px-2.5 py-0.5 text-[11px] font-semibold text-sky-100">
                      {isTextOnlyPost ? <BookText className="h-3 w-3" aria-hidden="true" /> : null}
                      {postTypeLabel}
                    </span>
                  )}
                </div>

                {/*
                  * A remix credits what it remixed, automatically (owner, 2026-11-05):
                  * part of the attribution, so it stays under the NSFW cover too.
                  */}
                <RemixCreditLine credit={viewer.remixCredit} className="mt-3" />

                {/*
                  * The creation's settings under Made with: a standard detail everyone sees
                  * without unlocking anything (owner, 2026-11-03). The read sends none for an
                  * upload, a text post, a template's result or a post under its cover.
                  */}
                <PostGenerationSetupLine entries={detail.generationSetup} />

                {/* On a covered post the gate holds the heading: "Mature content", then the title once revealed. */}
                {isNsfwCovered ? null : (
                  <h1 className="mt-4 text-balance text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                    {displayTitle}
                  </h1>
                )}

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
              {isNsfwCovered ? (
                <div data-testid="nsfw-detail-gate" className="w-full max-w-4xl">
                  <NsfwPostReveal key={detail.id} postId={detail.id} afterReveal={coveredCommentsBlock}>
                    {engagementRow}
                  </NsfwPostReveal>
                </div>
              ) : (
                <>
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

                      {engagementRow}
                  </article>
                  {promptBlock}
                  {recipeBlock}
                </>
              )}
          </section>

          <aside
            data-testid="canonical-post-actions"
            className="canonical-post-actions flex min-w-0 flex-col gap-4"
          >
            <div className="overflow-hidden rounded-3xl border border-white/10 bg-[linear-gradient(180deg,rgba(24,24,27,0.86),rgba(10,10,12,0.9))] shadow-[0_24px_80px_rgba(0,0,0,0.42)] backdrop-blur-xl">
              {/*
                * A pointer, not a pitch: the recipe is presented once, in the
                * document column, under the post — this sticky one-liner keeps
                * it reachable at any scroll depth.
                */}
              {recipeWords ? (
                <Link
                  data-testid="recipe-jump-link"
                  href="#recipe"
                  onClick={() => showRecipeJump()}
                  className="flex items-center justify-between gap-3 border-b border-white/8 px-5 py-3.5 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-500/[0.06] sm:px-6"
                >
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <ShoppingBag className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">
                      <RecipeWords words={recipeWords.label} creators={OWN_RECIPE_WORDS.label} mark={recipeMark} />
                    </span>
                  </span>
                  <span className="shrink-0 text-xs font-medium text-emerald-200/70">
                    <RecipeWords words={recipeWords.action} creators={OWN_RECIPE_WORDS.action} mark={recipeMark} />
                  </span>
                </Link>
              ) : null}
              <div className="p-5 sm:p-6">
                <ShowcaseDetailActions
                  postId={detail.id}
                  generationId={detail.generationId}
                  title={displayTitle}
                  creatorUsername={detail.creator.username}
                  visibility={visibility}
                  ownerTools={ownerTools}
                  ownerToolsMark={detail.creator.id}
                  hasResourceBundle={Boolean(bundle)}
                  bundle={bundle
                    ? {
                        accessMode: bundle.accessMode,
                        status: bundle.status,
                        salesCount: bundle.salesCount,
                        // Free unlocks are not sales, but their owners keep them
                        // and the confirmations still say so.
                        freeUnlockCount: bundle.freeUnlockCount,
                      }
                    : null}
                />
              </div>

              {/* Not on the creator's own post: the feed card's menu and the app
                  leave it out there too, and the server refuses the report. In the
                  server's HTML the creator's browser hides it (`ownerFirstPaintRules`). */}
              {drawsReportRows ? (
                <div data-post-report-rows={ownership === 'unread' ? detail.creator.id ?? undefined : undefined}>
                  <ReportPostButton
                    postId={detail.id}
                    bundleId={bundle?.id ?? null}
                    creator={detail.creator}
                    deliveryId={deliveryId}
                    onCreatorBlocked={viewer.markCreatorBlocked}
                  />
                </div>
              ) : null}
            </div>

            {commentsAreOpen && !isNsfwCovered ? (
              <ShowcaseDetailCommentsPanel
                postId={detail.id}
                postCreatorId={detail.creator.id}
                commentCount={detail.commentCount}
                deliveryId={deliveryId}
              />
            ) : null}
          </aside>
        </div>
        </ShowcaseDetailCommentCountProvider>
      </div>

      {bundle && pitchesRecipe ? (
        <>
          {/* The room the bar takes along the bottom edge (below 1180px), so the post's end scrolls clear of it. */}
          <div aria-hidden="true" className="canonical-post-cta-room" data-post-recipe-pitch={recipeMark} />
          {/* Above the app shell's bottom navigation, which floats over the page's
              bottom edge below 768px (z-60) and was drawn over the whole CTA there. */}
          <Link
            href="#recipe"
            onClick={() => showRecipeJump()}
            data-testid="recipe-bar"
            data-post-recipe-pitch={recipeMark}
            className="canonical-post-mobile-cta fixed inset-x-3 bottom-[calc(var(--app-shell-bottom-nav-space,0px)+0.75rem)] z-40 flex items-center justify-between gap-3 rounded-full border border-emerald-300/25 bg-emerald-300 px-4 py-3 text-slate-950 shadow-[0_18px_60px_rgba(0,0,0,0.45)]"
          >
            <span>
              <span className="block text-sm font-bold">
                {bundle.accessMode === 'free'
                  ? 'View free recipe'
                  : `Unlock recipe for ${formatPostResourcePriceLabel(bundle.priceUsdCents, bundle.priceQuote.formatted)}`}
              </span>
              <span className="block text-xs font-medium text-slate-800">{previewKindSummary}</span>
            </span>
            <ShoppingBag className="h-5 w-5" />
          </Link>
        </>
      ) : null}
    </div>
  );
}
