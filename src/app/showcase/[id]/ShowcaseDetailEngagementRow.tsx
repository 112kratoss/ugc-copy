'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Eye, Heart, Loader2, MessageCircle, Repeat2 } from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import PublicShareButton from '@/app/components/PublicShareButton';
import { useOptimisticPostSave } from '@/app/components/useOptimisticPostSave';
import { formatCompactCount } from '@/lib/post-feed-presentation';
import { getCurrentInternalPath } from '@/lib/share';
import { requestShowcaseRemix } from '@/lib/showcase-remix-client';

/**
 * The verbs under the post — Remix, Save, Comment, Share — plus passive reach,
 * framed by hairlines the way the feed card frames its action row. This is the
 * one interactive strip in the document column; the rail keeps only navigation.
 */
export default function ShowcaseDetailEngagementRow({
  postId,
  generationId,
  title,
  shareDescription,
  canRemix,
  saveCount,
  commentCount,
  remixCount,
  shareVisitCount,
  showComments,
}: {
  postId: string;
  generationId: string | null;
  title: string;
  shareDescription: string;
  canRemix: boolean;
  saveCount: number;
  commentCount: number;
  remixCount: number;
  shareVisitCount: number;
  /** Comments only mount on public posts; the anchor follows them. */
  showComments: boolean;
}) {
  const router = useRouter();
  const { session, user } = useAuth();
  const [isRemixing, setIsRemixing] = useState(false);
  const [remixError, setRemixError] = useState<string | null>(null);

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
    savingItemIds,
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

  const handleRemix = async () => {
    if (!user || !session?.access_token) {
      router.push(loginHref());
      return;
    }

    setRemixError(null);
    setIsRemixing(true);

    try {
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
    } finally {
      setIsRemixing(false);
    }
  };

  return (
    <div className="mt-6 border-y border-white/8 py-1 text-xs font-semibold text-zinc-400">
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
        {canRemix ? (
          <button
            type="button"
            onClick={() => void handleRemix()}
            disabled={isRemixing}
            className="ui-focus-ring mr-1 inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--ui-primary-strong)]/40 bg-[var(--ui-primary)]/10 px-4 text-xs font-extrabold text-[var(--ui-primary)] transition hover:bg-[var(--ui-primary)]/20 disabled:opacity-60"
          >
            {isRemixing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Repeat2 className="h-4 w-4" aria-hidden="true" />}
            {remixCount > 0 ? `Remix · ${formatCompactCount(remixCount)}` : 'Remix'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void toggleSave(postId)}
          disabled={savingItemIds.has(postId)}
          aria-pressed={isSaved}
          aria-label={`${isSaved ? 'Remove save from' : 'Save'} ${title}`}
          className={`ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full px-2 transition disabled:opacity-60 ${
            isSaved ? 'text-[var(--ui-primary)]' : 'hover:text-white'
          }`}
        >
          <Heart className={`h-4 w-4 ${isSaved ? 'fill-current' : ''}`} aria-hidden="true" />
          {liveSaveCount > 0 ? formatCompactCount(liveSaveCount) : 'Save'}
        </button>
        {showComments ? (
          <a
            href="#comments"
            className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full px-2 transition hover:text-white"
          >
            <MessageCircle className="h-4 w-4" aria-hidden="true" />
            {commentCount > 0 ? formatCompactCount(commentCount) : 'Comment'}
          </a>
        ) : null}
        <PublicShareButton
          generationId={postId}
          title={title}
          description={shareDescription}
          sourceSurface="detail-page"
          accessToken={session?.access_token ?? null}
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
