import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, renderHook } from '@testing-library/react';

import {
  forgetPostCommentSortsForTests,
  POST_COMMENT_SORT_MAX_POSTS,
  readPostCommentSort,
  rememberPostCommentSort,
  usePostCommentSort,
} from '@/lib/post-comment-sort-memory';

// The order chosen for a post's comments, kept for that post in this tab (owner, 2026-11-15); the
// thread's half is post-comments-component's, the browser's tests/e2e/comment-sort-kept.spec.ts.

afterEach(() => {
  window.sessionStorage.clear();
  forgetPostCommentSortsForTests();
  vi.restoreAllMocks();
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
    forgetPostCommentSortsForTests();
    window.sessionStorage.setItem('post-comment-sort', 'not json');
    expect(readPostCommentSort('post-1')).toBe('top');
  });

  it('comes back after a reload, from what the tab stored', () => {
    rememberPostCommentSort('post-1', 'newest');
    forgetPostCommentSortsForTests();

    expect(readPostCommentSort('post-1')).toBe('newest');
  });

  // Review of #821: storage full, or site data blocked, left the order unchangeable.
  it('changes the order where storage refuses it, for this document', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError');
    });
    const { result } = renderHook(() => usePostCommentSort('post-1'));

    act(() => result.current[1]('newest'));

    expect(result.current[0]).toBe('newest');
  });
});
