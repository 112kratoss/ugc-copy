import { useCallback, useSyncExternalStore } from 'react';

import type { PostCommentSort } from '@/lib/post-comments-client';

/**
 * The order a reader chose for a post's comments, kept for that post in this tab. A refresh, or
 * Back to the post from a page it linked to, used to draw the thread in Top again (owner,
 * 2026-11-15: "fix the comment sort … too"). Every thread of the post follows it: the post page,
 * the reel and a feed card.
 *
 * One small map in session storage, the latest choices last; Top, the default, is never kept.
 * The server and the render that hydrates draw Top, as the server's HTML did.
 */
const STORAGE_KEY = 'post-comment-sort';
/** Posts whose order is kept at once: the oldest choice gives way first. */
export const POST_COMMENT_SORT_MAX_POSTS = 50;

const listeners = new Set<() => void>();

function readKept(): Record<string, PostCommentSort> {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const kept = raw ? JSON.parse(raw) as unknown : null;
    return kept && typeof kept === 'object' && !Array.isArray(kept) ? kept as Record<string, PostCommentSort> : {};
  } catch {
    return {};
  }
}

/** The order kept for `postId`'s comments, Top when none is. */
export function readPostCommentSort(postId: string): PostCommentSort {
  return readKept()[postId] === 'newest' ? 'newest' : 'top';
}

/** Keeps the order chosen for `postId`'s comments, and tells every thread of it. */
export function rememberPostCommentSort(postId: string, sort: PostCommentSort): void {
  try {
    const kept = readKept();
    delete kept[postId];
    if (sort !== 'top') kept[postId] = sort;
    const latest = Object.entries(kept).slice(-POST_COMMENT_SORT_MAX_POSTS);
    if (latest.length > 0) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(latest)));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage refused: the order holds until the thread is drawn again, as before.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The order of `postId`'s comments, kept for the tab, and the way to choose another. */
export function usePostCommentSort(postId: string): [PostCommentSort, (sort: PostCommentSort) => void] {
  const sort = useSyncExternalStore(subscribe, () => readPostCommentSort(postId), () => 'top' as const);
  const chooseSort = useCallback((next: PostCommentSort) => rememberPostCommentSort(postId, next), [postId]);
  return [sort, chooseSort];
}
