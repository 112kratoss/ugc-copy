'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

import PostComments from '@/components/PostComments';
import { formatCompactCount } from '@/lib/post-feed-presentation';

type CommentCountState = {
  count: number;
  setCount: (count: number) => void;
  /** Whether the thread's panel beside the post is open. */
  open: boolean;
  setOpen: (open: boolean) => void;
};

const CommentCountContext = createContext<CommentCountState | null>(null);

/**
 * The post page's comment count, held for the engagement row and the thread
 * under it. The page is rendered on the server, so the row printed the count
 * the post had then while the thread's own heading moved with every comment
 * posted or deleted: two numbers on one screen. The thread now reports each
 * change here and the row reads it, as the app's action bar follows its sheet.
 */
export function ShowcaseDetailCommentCountProvider({
  initialCount,
  children,
}: {
  initialCount: number;
  children: ReactNode;
}) {
  const [count, setCount] = useState(initialCount);
  const [open, setOpen] = useState(true);
  const value = useMemo(() => ({ count, setCount, open, setOpen }), [count, open]);

  return <CommentCountContext.Provider value={value}>{children}</CommentCountContext.Provider>;
}

/** The live count inside the provider; the count the page was rendered with outside it. */
export function useShowcaseDetailCommentCount(renderedCount: number): number {
  return useContext(CommentCountContext)?.count ?? renderedCount;
}

/**
 * Opens the thread's panel again; the engagement row's Comment link calls it,
 * so the link never lands on a panel its reader closed.
 */
export function useOpenShowcaseDetailComments(): () => void {
  const setOpen = useContext(CommentCountContext)?.setOpen;
  return useCallback(() => setOpen?.(true), [setOpen]);
}

/** The post's thread, reporting its count to the provider around it. */
export function ShowcaseDetailComments({
  postId,
  postCreatorId,
  commentCount,
  deliveryId = null,
}: {
  postId: string;
  postCreatorId: string | null;
  commentCount: number;
  /** The delivery of the ranked card that opened the page, sent with each new comment. */
  deliveryId?: string | null;
}) {
  const setCount = useContext(CommentCountContext)?.setCount;

  return (
    <PostComments
      postId={postId}
      postCreatorId={postCreatorId}
      commentCount={commentCount}
      onCommentCountChange={setCount}
      deliveryId={deliveryId}
    />
  );
}

/**
 * The thread as a panel in the rail beside the post (owner, 2026-11-13: the
 * conversation sat under the post and its recipe, a screen or more down). Its
 * header's close button folds it to one row, which opens it again; the thread
 * stays mounted while folded, so a draft and the pages already read survive.
 */
export function ShowcaseDetailCommentsPanel({
  postId,
  postCreatorId,
  commentCount,
  deliveryId = null,
}: {
  postId: string;
  postCreatorId: string | null;
  commentCount: number;
  deliveryId?: string | null;
}) {
  const context = useContext(CommentCountContext);
  const open = context?.open ?? true;
  const count = context?.count ?? commentCount;

  return (
    <div
      id="comments"
      data-testid="canonical-post-comments"
      data-open={open}
      className="canonical-post-comments min-w-0 scroll-mt-24 overflow-hidden rounded-3xl border border-white/10 bg-[linear-gradient(180deg,rgba(24,24,27,0.86),rgba(10,10,12,0.9))] backdrop-blur-xl"
    >
      {open ? null : (
        <button
          type="button"
          onClick={() => context?.setOpen(true)}
          aria-expanded={false}
          className="ui-focus-ring flex min-h-13 w-full items-center justify-between gap-3 rounded-3xl px-4 text-left transition hover:bg-white/[0.04]"
        >
          <span className="flex items-baseline gap-2 text-base font-bold text-[var(--ui-text-primary)]">
            Comments
            {count > 0 ? (
              <span className="text-sm font-medium text-[var(--ui-text-muted)]">{formatCompactCount(count)}</span>
            ) : null}
          </span>
          <ChevronDown className="h-4 w-4 text-zinc-400" aria-hidden="true" />
        </button>
      )}
      <div hidden={!open} className="canonical-post-comments-body">
        <PostComments
          postId={postId}
          postCreatorId={postCreatorId}
          commentCount={commentCount}
          onCommentCountChange={context?.setCount}
          deliveryId={deliveryId}
          layout="panel"
          onClose={context ? () => context.setOpen(false) : undefined}
        />
      </div>
    </div>
  );
}
