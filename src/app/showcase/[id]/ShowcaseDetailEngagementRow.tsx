'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Eye, Heart, Loader2, LockKeyhole, MessageCircle, Repeat2 } from 'lucide-react';

import { useAuth } from '@/components/AuthProvider';
import { useNsfwPostRevealed } from '@/components/NsfwPostReveal';
import PublicShareButton from '@/components/PublicShareButton';
import { useOptimisticPostSave } from '@/components/useOptimisticPostSave';
import { claimFreeRecipe } from '@/lib/free-recipe-claim-client';
import { formatCompactCount } from '@/lib/post-feed-presentation';
import { getCurrentInternalPath } from '@/lib/share';
import { requestShowcaseRemix } from '@/lib/showcase-remix-client';

import PostRemixes from './PostRemixes';
import { showRecipeJump } from './recipe-jump';
import { useOpenShowcaseDetailComments, useShowcaseDetailCommentCount } from './ShowcaseDetailCommentCount';

/**
 * The verbs under the post — Remix, Save, Comment, Share — plus passive reach,
 * framed by hairlines the way the feed card frames its action row. This is the
 * one interactive strip in the document column; the rail keeps only navigation.
 */
export default function ShowcaseDetailEngagementRow({
  postId,
  generationId,
  creatorId = null,
  title,
  shareDescription,
  canRemix,
  saveCount,
  commentCount,
  remixCount,
  shareVisitCount,
  showComments,
  recipeRemix = null,
}: {
  postId: string;
  generationId: string | null;
  /** The post's creator, so a share by them may claim the work. */
  creatorId?: string | null;
  title: string;
  shareDescription: string;
  canRemix: boolean;
  saveCount: number;
  commentCount: number;
  remixCount: number;
  shareVisitCount: number;
  /** Comments only mount on public posts; the anchor follows them. */
  showComments: boolean;
  /**
   * The post's Remix comes with its recipe and this viewer has not got it
   * (S1): Remix is drawn with the recipe's price, as the feed's is (B-F3). A
   * paid one is locked and leads to the recipe; a free one takes the recipe
   * and opens the remix in the one click. Null when Remix is open or there
   * is none.
   */
  recipeRemix?: { access: 'paid' | 'free'; priceLabel: string } | null;
}) {
  const router = useRouter();
  const { session, user } = useAuth();
  const [isRemixing, setIsRemixing] = useState(false);
  const [remixError, setRemixError] = useState<string | null>(null);
  const liveCommentCount = useShowcaseDetailCommentCount(commentCount);
  const openComments = useOpenShowcaseDetailComments();
  const nsfwRevealed = useNsfwPostRevealed();
  // Under an NSFW gate the thread stays hidden until the post is revealed, and
  // the link to it goes with it.
  const isCommentsShown = showComments && nsfwRevealed !== false;

  const loginHref = () =>
    `/login?returnUrl=${encodeURIComponent(getCurrentInternalPath(`/showcase/${postId}`))}`;

  // Stable identity is load-bearing: the save hook resets its optimistic
  // state whenever `initialItems` changes identity, so an inline array here
  // would reset (and re-render) on every render, forever.
  const initialItems = useMemo(
    () => [{ id: postId, generationId, saveCount }],
    [postId, generationId, saveCount],
  );

  const {
    items,
    savedItemIds,
    toggleSave,
  } = useOptimisticPostSave({
    initialItems,
    accessToken: session?.access_token ?? null,
    isSignedIn: Boolean(user),
    onAuthRequired: () => router.push(loginHref()),
    onError: (error) => console.error('Failed to toggle save from the post page:', error),
    sourceSurface: 'detail-page',
  });

  const isSaved = savedItemIds.has(postId);
  const liveSaveCount = items[0]?.saveCount ?? saveCount;

  // `takeFreeRecipe`: the Remix comes with a recipe that costs nothing and the
  // viewer has not got it, so the click takes it on its way, as the feed
  // card's and the app's Remix do (owner, 2026-11-12). A paid recipe is never
  // taken by this click: its Remix is the link to the recipe.
  const handleRemix = async ({ takeFreeRecipe = false }: { takeFreeRecipe?: boolean } = {}) => {
    if (!user || !session?.access_token) {
      router.push(loginHref());
      return;
    }

    setRemixError(null);
    setIsRemixing(true);

    let recipeTaken = false;
    try {
      if (takeFreeRecipe) {
        await claimFreeRecipe(postId, session.access_token);
        recipeTaken = true;
      }
      const { redirectTo } = await requestShowcaseRemix({
        accessToken: session.access_token,
        postId,
      });
      router.push(redirectTo);
    } catch (error) {
      console.error('Failed to remix shared creation:', error);
      setRemixError(
        error instanceof Error && error.message
          ? error.message
          : 'Could not start the remix. Please try again.',
      );
      // The recipe is the viewer's now though the remix did not start: the
      // page is read again, so its Remix is the open one and its panel shows
      // the recipe, as after the panel's own unlock.
      if (recipeTaken) router.refresh();
    } finally {
      setIsRemixing(false);
    }
  };

  const lockedRemix = !canRemix && recipeRemix && nsfwRevealed !== false ? recipeRemix : null;

  return (
    <div className="mt-6 border-y border-white/8 py-1 text-xs font-semibold text-zinc-400">
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
        {/* A paid recipe's pill leads to the recipe (and rings it, so the click shows), which under an NSFW gate is on the page only after the reveal. */}
        {lockedRemix?.access === 'paid' ? (
          <a
            href="#recipe"
            onClick={() => showRecipeJump()}
            aria-label={`Unlock the recipe to remix ${title}, ${lockedRemix.priceLabel}`}
            className="ui-focus-ring mr-1 inline-flex min-h-11 items-center gap-2 rounded-full border border-amber-300/20 bg-amber-400/[0.08] px-4 text-xs font-extrabold text-amber-100 transition hover:border-amber-300/35"
          >
            <LockKeyhole className="h-4 w-4" aria-hidden="true" data-remix-lock />
            {`Remix · ${lockedRemix.priceLabel}`}
          </a>
        ) : null}
        {/* A free recipe's pill takes the recipe and opens the remix: one click, nothing to pay for. */}
        {lockedRemix?.access === 'free' ? (
          <button
            type="button"
            onClick={() => void handleRemix({ takeFreeRecipe: true })}
            disabled={isRemixing}
            aria-label={`Get the free recipe and remix ${title}`}
            className="ui-focus-ring mr-1 inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--ui-primary-strong)]/40 bg-[var(--ui-primary)]/10 px-4 text-xs font-extrabold text-[var(--ui-primary)] transition hover:bg-[var(--ui-primary)]/20 disabled:opacity-60"
          >
            {isRemixing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Repeat2 className="h-4 w-4" aria-hidden="true" />}
            {`Remix · ${lockedRemix.priceLabel}`}
          </button>
        ) : null}
        {canRemix ? (
          <button
            type="button"
            onClick={() => void handleRemix()}
            disabled={isRemixing}
            className="ui-focus-ring mr-1 inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--ui-primary-strong)]/40 bg-[var(--ui-primary)]/10 px-4 text-xs font-extrabold text-[var(--ui-primary)] transition hover:bg-[var(--ui-primary)]/20 disabled:opacity-60"
          >
            {isRemixing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Repeat2 className="h-4 w-4" aria-hidden="true" />}
            Remix
          </button>
        ) : null}
        {/* The count opens the remixes posted from this post (owner, 2026-11-05). */}
        {remixCount > 0 ? <PostRemixes postId={postId} remixCount={remixCount} /> : null}
        <button
          type="button"
          onClick={() => void toggleSave(postId)}
          aria-pressed={isSaved}
          aria-label={`${isSaved ? 'Remove save from' : 'Save'} ${title}`}
          className={`ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full px-2 transition ${
            isSaved ? 'text-[var(--ui-primary)]' : 'hover:text-white'
          }`}
        >
          <Heart className={`h-4 w-4 ${isSaved ? 'fill-current' : ''}`} aria-hidden="true" />
          {liveSaveCount > 0 ? formatCompactCount(liveSaveCount) : 'Save'}
        </button>
        {isCommentsShown ? (
          <a
            href="#comments"
            onClick={openComments}
            className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full px-2 transition hover:text-white"
          >
            <MessageCircle className="h-4 w-4" aria-hidden="true" />
            {liveCommentCount > 0 ? formatCompactCount(liveCommentCount) : 'Comment'}
          </a>
        ) : null}
        <PublicShareButton
          generationId={postId}
          title={title}
          description={shareDescription}
          sourceSurface="detail-page"
          accessToken={session?.access_token ?? null}
          viewerIsOwner={Boolean(creatorId && user?.id === creatorId)}
          className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full px-2 text-xs font-semibold text-zinc-400 transition hover:text-white"
        />
        {shareVisitCount > 0 ? (
          <span
            className="inline-flex min-h-11 items-center gap-2 px-2"
            title={shareVisitCount === 1 ? '1 visit' : `${shareVisitCount} visits`}
          >
            <Eye className="h-4 w-4" aria-hidden="true" />
            {formatCompactCount(shareVisitCount)}
          </span>
        ) : null}
      </div>
      {remixError ? (
        <p role="alert" className="mt-1 pb-2 text-xs font-medium text-rose-300">
          {remixError}
        </p>
      ) : null}
    </div>
  );
}
