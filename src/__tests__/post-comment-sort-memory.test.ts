import { afterEach, describe, expect, it } from 'vitest';

import {
  POST_COMMENT_SORT_MAX_POSTS,
  readPostCommentSort,
  rememberPostCommentSort,
} from '@/lib/post-comment-sort-memory';

// The order chosen for a post's comments, kept for that post in this tab (owner, 2026-11-15); the
// thread's half is post-comments-component's, the browser's tests/e2e/comment-sort-kept.spec.ts.

afterEach(() => {
  window.sessionStorage.clear();
});

describe("a post's comment order kept for the tab", () => {
  it('is Top until another is chosen, and each post keeps its own', () => {
    expect(readPostCommentSort('post-1')).toBe('top');

    rememberPostCommentSort('post-1', 'newest');

    expect(readPostCommentSort('post-1')).toBe('newest');
    expect(readPostCommentSort('post-2')).toBe('top');
  });

  it('keeps nothing for Top, the default', () => {
    rememberPostCommentSort('post-1', 'newest');
    rememberPostCommentSort('post-1', 'top');

    expect(readPostCommentSort('post-1')).toBe('top');
    expect(window.sessionStorage.length).toBe(0);
  });

  it('keeps the latest posts only, the oldest choice giving way first', () => {
    for (let index = 0; index <= POST_COMMENT_SORT_MAX_POSTS; index += 1) {
      rememberPostCommentSort(`post-${index}`, 'newest');
    }

    expect(readPostCommentSort('post-0')).toBe('top');
    expect(readPostCommentSort(`post-${POST_COMMENT_SORT_MAX_POSTS}`)).toBe('newest');
  });

  it('reads anything it cannot use as Top', () => {
    window.sessionStorage.setItem('post-comment-sort', '{"post-1":"sideways"}');
    expect(readPostCommentSort('post-1')).toBe('top');
    window.sessionStorage.setItem('post-comment-sort', 'not json');
    expect(readPostCommentSort('post-1')).toBe('top');
  });
});
