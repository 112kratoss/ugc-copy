import type { InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
  DELETED_COMMENT_LABEL,
  applyCommentCountToInfiniteFeed,
  applyCommentCountToPostResponse,
  buildCommentThreads,
  canDeleteComment,
  canRemoveComment,
  canReportComment,
  createPostCommentRepliesQueryKey,
  createPostCommentsQueryKey,
  flattenCommentPages,
  getCommentDisplay,
  getCommentsPageParams,
  getNextCommentsPageOffset,
  incrementParentReplyCountInPages,
  markCommentRemovedInPages,
  prependCommentToPages,
} from '@/lib/comments-view-model';
import type { PostComment, PostCommentsResponse, ShowcaseFeedResponse } from '@/lib/types';

const VIEWER_ID = 'viewer-1';
const OWNER_ID = 'owner-1';

function comment(overrides: Partial<PostComment> = {}): PostComment {
  return {
    id: 'comment-1',
    parentId: null,
    body: 'a thoughtful comment',
    status: 'active',
    createdAt: '2026-07-27T10:00:00.000Z',
    replyCount: 0,
    author: { id: VIEWER_ID, username: 'viewer', displayName: 'Viewer', avatarUrl: null },
    ...overrides,
  };
}

function page(overrides: Partial<PostCommentsResponse> = {}): PostCommentsResponse {
  return {
    postId: 'post-1',
    postCreatorId: OWNER_ID,
    commentCount: 1,
    comments: [comment()],
    pageInfo: { hasMore: false, nextOffset: null, limit: 20, offset: 0 },
    ...overrides,
  };
}

describe('comments view model', () => {
  describe('query keys and paging', () => {
    it('scopes comment caches by post, sort, and viewer', () => {
      expect(createPostCommentsQueryKey('post-1', 'top', VIEWER_ID))
        .toEqual(['post-comments', 'post-1', 'top', VIEWER_ID]);
      expect(createPostCommentsQueryKey('post-1', 'newest', null))
        .toEqual(['post-comments', 'post-1', 'newest', 'anonymous']);
      expect(createPostCommentRepliesQueryKey('post-1', 'comment-1', VIEWER_ID))
        .toEqual(['post-comment-replies', 'post-1', 'comment-1', VIEWER_ID]);
    });

    it('builds request params and only sends parentId for reply pages', () => {
      expect(getCommentsPageParams()).toEqual({ limit: 20, offset: 0, sort: 'top' });
      expect(getCommentsPageParams({ offset: 20, parentId: 'comment-1', sort: 'newest' }))
        .toEqual({ limit: 20, offset: 20, sort: 'newest', parentId: 'comment-1' });
    });

    it('stops paging when the server reports no more comments', () => {
      expect(getNextCommentsPageOffset(page())).toBeUndefined();
      expect(getNextCommentsPageOffset(page({
        pageInfo: { hasMore: true, nextOffset: 20, limit: 20, offset: 0 },
      }))).toBe(20);
    });

    it('dedupes comments repeated across pages', () => {
      const comments = flattenCommentPages([
        page(),
        page({ comments: [comment(), comment({ id: 'comment-2' })] }),
      ]);

      expect(comments.map((item) => item.id)).toEqual(['comment-1', 'comment-2']);
    });
  });

  describe('display', () => {
    it('hides the body and author of a removed comment', () => {
      const display = getCommentDisplay(
        comment({ status: 'removed_by_author', body: '', author: null }),
        new Date('2026-07-27T10:05:00.000Z')
      );

      expect(display).toMatchObject({
        isDeleted: true,
        bodyText: DELETED_COMMENT_LABEL,
        authorLabel: DELETED_COMMENT_LABEL,
        timeLabel: '5m ago',
      });
    });

    it('prefers the author handle and pluralizes the reply label', () => {
      expect(getCommentDisplay(comment({ replyCount: 1 })).authorLabel).toBe('@viewer');
      expect(getCommentDisplay(comment({ replyCount: 1 })).replyLabel).toBe('1 reply');
      expect(getCommentDisplay(comment({ replyCount: 4 })).replyLabel).toBe('4 replies');
      expect(getCommentDisplay(comment()).replyLabel).toBeNull();
    });
  });

  describe('thread assembly', () => {
    it('renders a replies toggle for comments that have replies', () => {
      const rows = buildCommentThreads({ topLevel: [comment({ replyCount: 2 })] });

      expect(rows.map((row) => row.kind)).toEqual(['comment', 'replies-toggle']);
      expect(rows[1]).toMatchObject({ parentId: 'comment-1', replyCount: 2, expanded: false });
    });

    it('inlines replies once a thread is expanded', () => {
      const rows = buildCommentThreads({
        topLevel: [comment({ replyCount: 1 })],
        repliesByParent: { 'comment-1': [comment({ id: 'reply-1', parentId: 'comment-1' })] },
        expandedIds: new Set(['comment-1']),
      });

      expect(rows.map((row) => row.kind)).toEqual(['comment', 'reply', 'replies-toggle']);
      expect(rows[1]).toMatchObject({ key: 'reply-1', parentId: 'comment-1' });
      expect(rows[2]).toMatchObject({ expanded: true });
    });

    it('omits the toggle for comments with no replies', () => {
      expect(buildCommentThreads({ topLevel: [comment()] }).map((row) => row.kind))
        .toEqual(['comment']);
    });
  });

  describe('permissions', () => {
    it('lets the author delete and the post owner remove', () => {
      const mine = comment();
      const theirs = comment({ id: 'comment-2', author: { id: 'other', username: null, displayName: 'Other', avatarUrl: null } });

      expect(canDeleteComment(mine, VIEWER_ID)).toBe(true);
      expect(canDeleteComment(theirs, VIEWER_ID)).toBe(false);
      expect(canRemoveComment(theirs, OWNER_ID, OWNER_ID)).toBe(true);
      expect(canRemoveComment(theirs, OWNER_ID, VIEWER_ID)).toBe(false);
    });

    it('never offers actions on an already removed comment', () => {
      const removed = comment({ status: 'removed_by_author', author: null });

      expect(canDeleteComment(removed, VIEWER_ID)).toBe(false);
      expect(canRemoveComment(removed, OWNER_ID, OWNER_ID)).toBe(false);
      expect(canReportComment(removed, VIEWER_ID)).toBe(false);
    });

    it('does not let a viewer report their own comment', () => {
      expect(canReportComment(comment(), VIEWER_ID)).toBe(false);
      expect(canReportComment(comment(), OWNER_ID)).toBe(true);
    });
  });

  describe('optimistic cache updates', () => {
    const data: InfiniteData<PostCommentsResponse> = { pages: [page()], pageParams: [0] };

    it('puts a new comment at the top and refreshes every page count', () => {
      const next = prependCommentToPages(data, comment({ id: 'comment-new' }), 2);

      expect(next?.pages[0].comments.map((item) => item.id)).toEqual(['comment-new', 'comment-1']);
      expect(next?.pages[0].commentCount).toBe(2);
    });

    it('drops a removed comment that has no replies', () => {
      const next = markCommentRemovedInPages(data, 'comment-1', 'removed_by_author', 0);

      expect(next?.pages[0].comments).toEqual([]);
      expect(next?.pages[0].commentCount).toBe(0);
    });

    it('keeps a removed comment that still anchors replies, but blanks it', () => {
      const withReplies: InfiniteData<PostCommentsResponse> = {
        pages: [page({ comments: [comment({ replyCount: 2 })] })],
        pageParams: [0],
      };

      const next = markCommentRemovedInPages(withReplies, 'comment-1', 'removed_by_owner', 0);

      expect(next?.pages[0].comments[0]).toMatchObject({
        status: 'removed_by_owner',
        body: '',
        author: null,
        replyCount: 2,
      });
    });

    it('adjusts a parent reply counter without dropping below zero', () => {
      const next = incrementParentReplyCountInPages(data, 'comment-1', -1);
      expect(next?.pages[0].comments[0].replyCount).toBe(0);

      const up = incrementParentReplyCountInPages(data, 'comment-1', 1);
      expect(up?.pages[0].comments[0].replyCount).toBe(1);
    });
  });

  describe('comment count fan-out', () => {
    const feedItem = {
      id: 'post-1',
      commentCount: 1,
    } as ShowcaseFeedResponse['items'][number];

    it('writes the new count through the infinite feed cache', () => {
      const feed: InfiniteData<ShowcaseFeedResponse> = {
        pages: [{ items: [feedItem, { ...feedItem, id: 'post-2' }] }],
        pageParams: [0],
      };

      const next = applyCommentCountToInfiniteFeed(feed, { postId: 'post-1', commentCount: 7 });

      expect(next?.pages[0].items[0].commentCount).toBe(7);
      expect(next?.pages[0].items[1].commentCount).toBe(1);
    });

    it('writes the new count through the single post cache', () => {
      const next = applyCommentCountToPostResponse(
        { success: true, item: feedItem },
        { postId: 'post-1', commentCount: 4 }
      );

      expect(next?.item.commentCount).toBe(4);
    });

    it('never writes a negative count', () => {
      const next = applyCommentCountToPostResponse(
        { success: true, item: feedItem },
        { postId: 'post-1', commentCount: -3 }
      );

      expect(next?.item.commentCount).toBe(0);
    });
  });
});
