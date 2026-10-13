'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import PostComments from '@/components/PostComments';

type CommentCountState = {
  count: number;
  setCount: (count: number) => void;
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
  const value = useMemo(() => ({ count, setCount }), [count]);

  return <CommentCountContext.Provider value={value}>{children}</CommentCountContext.Provider>;
}

/** The live count inside the provider; the count the page was rendered with outside it. */
export function useShowcaseDetailCommentCount(renderedCount: number): number {
  return useContext(CommentCountContext)?.count ?? renderedCount;
}

/** The post's thread, reporting its count to the provider around it. */
export function ShowcaseDetailComments({
  postId,
  postCreatorId,
  commentCount,
}: {
  postId: string;
  postCreatorId: string | null;
  commentCount: number;
}) {
  const setCount = useContext(CommentCountContext)?.setCount;

  return (
    <PostComments
      postId={postId}
      postCreatorId={postCreatorId}
      commentCount={commentCount}
      onCommentCountChange={setCount}
    />
  );
}
