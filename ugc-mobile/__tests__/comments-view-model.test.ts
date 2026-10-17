import type { InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api-client';
import {
  ALL_POST_COMMENT_QUERY_KEYS,
  COMMENTS_CLOSED_TITLE,
  DEFAULT_POST_COMMENT_SORT,
  DELETED_COMMENT_LABEL,
  POST_COMMENT_SORTS,
  applyCommentCountToInfiniteFeed,
  applyCommentCountToPostResponse,
  applyCommentCountToSourceData,
  appendReplyToPages,
  canBlockCommentAuthor,
  canDeleteComment,
  canRemoveComment,
  canReportComment,
  createPostCommentRepliesQueryKey,
  createPostCommentsQueryKey,
  createPostCommentsThreadQueryKey,
  flattenCommentPages,
  getCommentAuthReturnTo,
  getCommentDisplay,
  getCommentPostErrorCopy,
  getCommentsLoadErrorCopy,
  getCommentsPageParams,
  getNextCommentsPageOffset,
  getRemoveCommentConfirmation,
  getRepliesToggleLabel,
  incrementParentReplyCountInPages,
  incrementReplyCountInList,
  keepFirstCommentPage,
  markCommentRemovedInList,
  markCommentRemovedInPages,
  mergeRepliesWithPending,
  mergeTopLevelWithPending,
  prependCommentToPages,
  suspendCommentPagination,
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

    it('has a prefix for every thread and every reply list, of any post or viewer', () => {
      const [threads, replies] = ALL_POST_COMMENT_QUERY_KEYS;

      expect(createPostCommentsQueryKey('post-9', 'top', null).slice(0, threads.length)).toEqual(threads);
      expect(createPostCommentRepliesQueryKey('post-9', 'comment-9', VIEWER_ID).slice(0, replies.length))
        .toEqual(replies);
    });

    it("has a prefix for one post's thread in every order, and no other post's", () => {
      const thread = createPostCommentsThreadQueryKey('post-1');

      for (const sort of ['top', 'newest'] as const) {
        expect(createPostCommentsQueryKey('post-1', sort, VIEWER_ID).slice(0, thread.length)).toEqual(thread);
      }
      expect(createPostCommentsQueryKey('post-10', 'top', VIEWER_ID).slice(0, thread.length)).not.toEqual(thread);
    });

    it("offers the web thread's two orders under its labels, opening on Top", () => {
      // src/components/PostComments.tsx (SORTS): the same ids and words, so a
      // thread reads the same whichever client opens it.
      expect(POST_COMMENT_SORTS).toEqual([
        { id: 'top', label: 'Top' },
        { id: 'newest', label: 'New' },
      ]);
      expect(DEFAULT_POST_COMMENT_SORT).toBe('top');
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

    it('restores the exact comment and reply context after authentication', () => {
      expect(getCommentAuthReturnTo('/viewer?source=showcase-feed&initialId=post-1', 'post-1', 'comment-1'))
        .toBe('/viewer?source=showcase-feed&initialId=post-1&comments=post-1&replyTo=comment-1');
      expect(getCommentAuthReturnTo('https://unsafe.example', 'post-2'))
        .toBe('/(tabs)/index?comments=post-2');
    });

    it('merges optimistic replies in chronological order without duplicates', () => {
      const serverReply = comment({
        id: 'reply-server',
        parentId: 'comment-1',
        createdAt: '2026-07-27T10:01:00.000Z',
      });
      const pendingReply = comment({
        id: 'reply-pending',
        parentId: 'comment-1',
        createdAt: '2026-07-27T10:03:00.000Z',
      });
      const replies = mergeRepliesWithPending([
        page({ comments: [serverReply] }),
      ], [pendingReply, serverReply]);

      expect(replies.map((item) => item.id)).toEqual(['reply-server', 'reply-pending']);
    });

    it("pins the viewer's new comments above the server's pages, newest first", () => {
      const popular = comment({ id: 'popular', replyCount: 9 });
      const thread = mergeTopLevelWithPending(
        [page({ comments: [popular] })],
        [comment({ id: 'mine-2' }), comment({ id: 'mine-1' })]
      );

      expect(thread.map((item) => item.id)).toEqual(['mine-2', 'mine-1', 'popular']);
      expect(mergeTopLevelWithPending([page({ comments: [popular] })]).map((item) => item.id))
        .toEqual(['popular']);
    });

    it("lists a pinned comment once, as the server's copy, when a loaded page holds it", () => {
      const pinned = comment({ id: 'mine', replyCount: 0 });
      const serverCopy = comment({ id: 'mine', replyCount: 2 });
      const thread = mergeTopLevelWithPending(
        [page({ comments: [comment({ id: 'popular', replyCount: 9 }), serverCopy] })],
        [pinned]
      );

      expect(thread.map((item) => item.id)).toEqual(['mine', 'popular']);
      expect(thread[0].replyCount).toBe(2);
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

    it('prefers the author handle', () => {
      expect(getCommentDisplay(comment()).authorLabel).toBe('@viewer');
      expect(getCommentDisplay(comment({
        author: { id: 'other', username: null, displayName: 'Other', avatarUrl: null },
      })).authorLabel).toBe('Other');
    });

    it('counts replies in the singular and plural, and says Hide once open', () => {
      expect(getRepliesToggleLabel(1, false)).toBe('View 1 reply');
      expect(getRepliesToggleLabel(4, false)).toBe('View 4 replies');
      expect(getRepliesToggleLabel(4, true)).toBe('Hide replies');
    });

    it('promises "[deleted]" only for a comment that still holds replies', () => {
      expect(getRemoveCommentConfirmation(comment(), false)).toEqual({
        title: 'Delete your comment?',
        message: 'It will be removed.',
        confirmLabel: 'Delete',
      });
      expect(getRemoveCommentConfirmation(comment({ replyCount: 2 }), false).message)
        .toBe('Your comment will be replaced with “[deleted]”. Replies to it stay visible.');
      expect(getRemoveCommentConfirmation(comment(), true)).toEqual({
        title: 'Remove this comment?',
        message: 'It will be hidden from everyone viewing your post.',
        confirmLabel: 'Remove',
      });
    });
  });

  describe('error copy', () => {
    it('calls a 404 closed, with nothing to retry', () => {
      expect(getCommentsLoadErrorCopy(new ApiError('Post not found.', 404)))
        .toEqual({ title: COMMENTS_CLOSED_TITLE, canRetry: false });
    });

    it("asks a rate-limited reader to wait as long as the server said", () => {
      const limited = (retryAfterSeconds?: number) => new ApiError(
        'Too many requests. Please wait before trying again.',
        429,
        { code: 'RATE_LIMITED', ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) },
      );

      expect(getCommentsLoadErrorCopy(limited(90))).toEqual({
        title: 'Comments are unavailable',
        body: 'Too many requests in a short time. Try again in 2 minutes.',
        canRetry: true,
      });
      expect(getCommentsLoadErrorCopy(limited(1)).body).toContain('Try again in 1 second.');
      expect(getCommentsLoadErrorCopy(limited()).body).toContain('Wait a moment, then try again.');
    });

    it('blames the connection only when the request never reached the server', () => {
      expect(getCommentsLoadErrorCopy(new ApiError('Network request failed', 0)).body)
        .toBe('We could not load this conversation. Check your connection, then try again.');
      expect(getCommentsLoadErrorCopy(new Error('offline')).canRetry).toBe(true);
      expect(getCommentsLoadErrorCopy(new ApiError('Failed to load comments.', 500)).body)
        .toBe('We could not load this conversation. Try again in a moment.');
    });

    it('turns an ended session into a way to sign in, never "Unauthorized"', () => {
      expect(getCommentPostErrorCopy(new ApiError('Unauthorized', 401), false)).toEqual({
        title: 'Your session ended',
        message: 'Sign in to post.',
        signIn: true,
      });
    });

    it('names a closed post on a new comment, and keeps the server text for a reply', () => {
      expect(getCommentPostErrorCopy(new ApiError('Post not found.', 404), false))
        .toEqual({ title: COMMENTS_CLOSED_TITLE, signIn: false });
      expect(getCommentPostErrorCopy(new ApiError('That comment is no longer available.', 404), true))
        .toEqual({ title: 'Could not post comment', message: 'That comment is no longer available.', signIn: false });
    });

    it('asks a fast commenter to wait', () => {
      const limited = new ApiError('Too many requests.', 429, { retryAfterSeconds: 240 });
      expect(getCommentPostErrorCopy(limited, false)).toEqual({
        title: 'Could not post comment',
        message: "You're commenting too quickly. Try again in 4 minutes.",
        signIn: false,
      });
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

    it("offers Block on someone else's comment, signed in, unless they made the post", () => {
      const theirs = comment({ author: { id: 'other', username: 'other', displayName: 'Other', avatarUrl: null } });
      const byPostCreator = comment({ author: { id: OWNER_ID, username: 'owner', displayName: 'Owner', avatarUrl: null } });

      expect(canBlockCommentAuthor(theirs, OWNER_ID, VIEWER_ID)).toBe(true);
      // The post's creator blocking a commenter on their own post.
      expect(canBlockCommentAuthor(theirs, OWNER_ID, OWNER_ID)).toBe(true);
      expect(canBlockCommentAuthor(comment(), OWNER_ID, VIEWER_ID)).toBe(false);
      expect(canBlockCommentAuthor(byPostCreator, OWNER_ID, VIEWER_ID)).toBe(false);
      expect(canBlockCommentAuthor(theirs, OWNER_ID, null)).toBe(false);
      expect(canBlockCommentAuthor(comment({ status: 'removed_by_author', author: null }), OWNER_ID, VIEWER_ID))
        .toBe(false);
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

      const up = incrementParentReplyCountInPages(data, 'comment-1', 1, 2);
      expect(up?.pages[0].comments[0].replyCount).toBe(1);
      expect(up?.pages[0].commentCount).toBe(2);
    });

    it('hands back the same pinned list when the change is about another comment', () => {
      const pinned = [comment({ id: 'mine' })];

      expect(incrementReplyCountInList(pinned, 'elsewhere', 1)).toBe(pinned);
      expect(markCommentRemovedInList(pinned, 'elsewhere', 'removed_by_author')).toBe(pinned);
      expect(incrementReplyCountInList(pinned, 'mine', 1)[0].replyCount).toBe(1);
      expect(markCommentRemovedInList(pinned, 'mine', 'removed_by_author')).toEqual([]);
    });

    it('inserts a successful reply once and refreshes cached counts', () => {
      const reply = comment({ id: 'reply-1', parentId: 'comment-1' });
      const next = appendReplyToPages(data, reply, 2);
      const duplicate = appendReplyToPages(next, reply, 2);

      expect(duplicate?.pages[0].comments.map((item) => item.id))
        .toEqual(['comment-1', 'reply-1']);
      expect(duplicate?.pages[0].commentCount).toBe(2);
    });

    it('drops stale offset pages after a mutation', () => {
      const paged: InfiniteData<PostCommentsResponse> = {
        pages: [
          page(),
          page({
            comments: [comment({ id: 'comment-2' })],
            pageInfo: { hasMore: true, nextOffset: 40, limit: 20, offset: 20 },
          }),
        ],
        pageParams: [0, 20],
      };

      expect(keepFirstCommentPage(paged)).toEqual({
        pages: [paged.pages[0]],
        pageParams: [0],
      });
      const suspended = suspendCommentPagination(paged);
      expect(suspended?.pages).toHaveLength(2);
      expect(suspended?.pages[1].pageInfo).toMatchObject({
        hasMore: false,
        nextOffset: null,
      });
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

    it('updates owner-post source data without refetching the viewer feed', () => {
      const next = applyCommentCountToSourceData({
        ownerPosts: [{
          id: 'post-1',
          title: 'Owner post',
          createdAt: '2026-07-27T10:00:00.000Z',
          visibility: 'public',
          mediaUrl: null,
          mediaKind: null,
          bundle: null,
          commentCount: 1,
        }],
      }, { postId: 'post-1', commentCount: 5 });

      expect(next?.ownerPosts?.[0].commentCount).toBe(5);
    });
  });
});
