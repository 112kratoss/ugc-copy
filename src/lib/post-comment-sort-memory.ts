import { useCallback, useSyncExternalStore } from 'react';

import type { PostCommentSort } from '@/lib/post-comments-client';

/**
 * The order a reader chose for a post's comments, kept for that post in this tab. A refresh, or
 * Back to the post from a page it linked to, used to draw the thread in Top again (owner,
 * 2026-11-15: "fix the comment sort … too"). Every thread of the post follows it: the post page,
 * the reel and a feed card.
 *
 * The tab's own copy is the authority: read from session storage once per document, written back
 * to it whenever storage allows, so a choice holds even where storage refuses it (full, or site
 * data blocked) until the next load (review of #821). The latest choices are kept, the oldest
 * giving way first; Top, the default, is never kept. The server and the render that hydrates
 * draw Top, as the server's HTML did.
 */
const STORAGE_KEY = 'post-comment-sort';
/** Posts whose order is kept at once. */
export const POST_COMMENT_SORT_MAX_POSTS = 50;

let keptOrders: Map<string, PostCommentSort> | null = null;
const listeners = new Set<() => void>();

function orders(): Map<string, PostCommentSort> {
  if (keptOrders) return keptOrders;
  keptOrders = new Map();
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const stored = raw ? JSON.parse(raw) as unknown : null;
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const [postId, sort] of Object.entries(stored)) {
        if (sort === 'newest') keptOrders.set(postId, sort);
      }
    }
  } catch {
    // Nothing readable kept: every thread opens on Top.
  }
  return keptOrders;
}

/** The order kept for `postId`'s comments, Top when none is. */
export function readPostCommentSort(postId: string): PostCommentSort {
  return orders().get(postId) ?? 'top';
}

/** Keeps the order chosen for `postId`'s comments, and tells every thread of it. */
export function rememberPostCommentSort(postId: string, sort: PostCommentSort): void {
  const kept = orders();
  kept.delete(postId);
  if (sort !== 'top') kept.set(postId, sort);
  while (kept.size > POST_COMMENT_SORT_MAX_POSTS) kept.delete(kept.keys().next().value as string);
  try {
    if (kept.size > 0) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage refused: the choice holds for this document, and the next load opens on Top.
  }
  for (const listener of listeners) listener();
}

/** Tests only: the tab's copy is read from session storage again. */
export function forgetPostCommentSortsForTests(): void {
  keptOrders = null;
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
