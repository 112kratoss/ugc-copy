import { describe, expect, it } from 'vitest';

import {
    DELETED_COMMENT_LABEL,
    adjustReplyCount,
    buildCommentThreads,
    buildCommentsQuery,
    canDeleteComment,
    canRemoveComment,
    canReportComment,
    describeCommentRequestFailure,
    getCommentDisplay,
    markCommentRemoved,
    mergeCommentPage,
    prependComment,
    withPendingComments,
    type PostComment,
} from '@/lib/post-comments-client';

function comment(overrides: Partial<PostComment> = {}): PostComment {
    return {
        id: 'comment-1',
        parentId: null,
        body: 'Nice work',
        status: 'active',
        createdAt: '2026-07-28T00:00:00.000Z',
        replyCount: 0,
        author: {
            id: 'user-1',
            username: 'batman',
            displayName: 'Batman',
            avatarUrl: null,
        },
        ...overrides,
    };
}

describe('post comments client', () => {
    describe('display', () => {
        it('prefers the handle and links to the creator', () => {
            const display = getCommentDisplay(comment());

            expect(display.authorLabel).toBe('@batman');
            expect(display.authorHref).toBe('/creators/batman');
            expect(display.isDeleted).toBe(false);
        });

        it('falls back to the display name when there is no handle', () => {
            const display = getCommentDisplay(comment({
                author: { id: 'user-1', username: null, displayName: 'Batman', avatarUrl: null },
            }));

            expect(display.authorLabel).toBe('Batman');
            expect(display.authorHref).toBeNull();
        });

        it('withholds body and author once a comment is removed', () => {
            const display = getCommentDisplay(comment({ status: 'removed_by_owner', body: 'leaked', author: null }));

            expect(display.isDeleted).toBe(true);
            expect(display.bodyText).toBe(DELETED_COMMENT_LABEL);
            expect(display.authorLabel).toBe(DELETED_COMMENT_LABEL);
            expect(display.authorHref).toBeNull();
        });
    });

    describe('thread assembly', () => {
        it('adds a toggle row under any comment that has replies', () => {
            const rows = buildCommentThreads({
                topLevel: [comment({ id: 'a', replyCount: 2 }), comment({ id: 'b' })],
            });

            expect(rows.map((row) => [row.kind, row.key])).toEqual([
                ['comment', 'a'],
                ['replies-toggle', 'a:toggle'],
                ['comment', 'b'],
            ]);
        });

        it('inlines replies only for expanded parents', () => {
            const rows = buildCommentThreads({
                topLevel: [comment({ id: 'a', replyCount: 2 })],
                repliesByParent: { a: [comment({ id: 'a1', parentId: 'a' }), comment({ id: 'a2', parentId: 'a' })] },
                expandedIds: new Set(['a']),
            });

            expect(rows.map((row) => row.kind)).toEqual(['comment', 'reply', 'reply', 'replies-toggle']);
            expect(rows.at(-1)?.expanded).toBe(true);
        });

        it('keeps the toggle collapsed when replies were never fetched', () => {
            const rows = buildCommentThreads({ topLevel: [comment({ id: 'a', replyCount: 3 })] });

            expect(rows.at(-1)).toMatchObject({ kind: 'replies-toggle', replyCount: 3, expanded: false });
        });
    });

    describe('permissions', () => {
        const author = comment({ author: { id: 'author-1', username: 'a', displayName: 'A', avatarUrl: null } });

        it('lets an author delete only their own live comment', () => {
            expect(canDeleteComment(author, 'author-1')).toBe(true);
            expect(canDeleteComment(author, 'someone-else')).toBe(false);
            expect(canDeleteComment(author, null)).toBe(false);
            expect(canDeleteComment({ ...author, status: 'removed_by_author' }, 'author-1')).toBe(false);
        });

        it("lets a post owner remove someone else's comment but not their own", () => {
            expect(canRemoveComment(author, 'owner-1', 'owner-1')).toBe(true);
            expect(canRemoveComment(author, 'author-1', 'author-1')).toBe(false);
            expect(canRemoveComment(author, null, 'owner-1')).toBe(false);
        });

        it('lets a signed-in viewer report anyone but themselves', () => {
            expect(canReportComment(author, 'someone-else')).toBe(true);
            expect(canReportComment(author, 'author-1')).toBe(false);
            expect(canReportComment(author, null)).toBe(false);
        });
    });

    describe('local list updates', () => {
        it('puts a new comment first without duplicating a retry', () => {
            const existing = [comment({ id: 'old' })];
            const fresh = comment({ id: 'new' });

            expect(prependComment(existing, fresh).map((c) => c.id)).toEqual(['new', 'old']);
            expect(prependComment(prependComment(existing, fresh), fresh).map((c) => c.id))
                .toEqual(['new', 'old']);
        });

        it('deduplicates rows when mutable offset pages overlap', () => {
            const firstPage = [comment({ id: 'a' }), comment({ id: 'b' })];
            const shiftedSecondPage = [comment({ id: 'b' }), comment({ id: 'c' })];

            expect(mergeCommentPage(firstPage, shiftedSecondPage).map((item) => item.id))
                .toEqual(['a', 'b', 'c']);
            expect(mergeCommentPage(firstPage, shiftedSecondPage, true).map((item) => item.id))
                .toEqual(['b', 'c']);
        });

        it('drops a removed comment that anchors nothing', () => {
            const result = markCommentRemoved([comment({ id: 'a' })], 'a', 'removed_by_author');

            expect(result).toEqual([]);
        });

        it('keeps a removed comment that still anchors replies, stripped of content', () => {
            const [kept] = markCommentRemoved(
                [comment({ id: 'a', replyCount: 2 })],
                'a',
                'removed_by_owner'
            );

            expect(kept).toMatchObject({ id: 'a', status: 'removed_by_owner', body: '', author: null, replyCount: 2 });
        });

        it('leaves other comments untouched', () => {
            const list = [comment({ id: 'a' }), comment({ id: 'b' })];

            expect(markCommentRemoved(list, 'a', 'removed_by_author').map((c) => c.id)).toEqual(['b']);
        });

        it('adjusts a parent reply count and never goes negative', () => {
            const list = [comment({ id: 'a', replyCount: 1 })];

            expect(adjustReplyCount(list, 'a', 1)[0].replyCount).toBe(2);
            expect(adjustReplyCount(list, 'a', -1)[0].replyCount).toBe(0);
            expect(adjustReplyCount(list, 'a', -5)[0].replyCount).toBe(0);
            expect(adjustReplyCount(list, 'missing', 1)[0].replyCount).toBe(1);
        });

        it("keeps the viewer's new comment on screen until a read returns it", () => {
            const loaded = [comment({ id: 'a' }), comment({ id: 'b' })];
            const mine = comment({ id: 'mine' });

            expect(withPendingComments(loaded, [mine], 'first').map((c) => c.id))
                .toEqual(['mine', 'a', 'b']);
            expect(withPendingComments(loaded, [mine], 'last').map((c) => c.id))
                .toEqual(['a', 'b', 'mine']);
            // Once the server's list holds it, it shows where the server put it.
            const returned = [comment({ id: 'a' }), mine, comment({ id: 'b' })];
            expect(withPendingComments(returned, [mine], 'first')).toBe(returned);
            expect(withPendingComments(loaded, [], 'first')).toBe(loaded);
        });
    });

    describe('request failures', () => {
        it('tells a reader a closed thread is closed, without a retry', () => {
            expect(describeCommentRequestFailure('load', 404, { error: 'Post not found.' })).toEqual({
                message: 'Comments are closed on this post.',
                retryable: false,
                signIn: false,
            });
            expect(describeCommentRequestFailure('post', 404).message)
                .toBe('Comments are closed on this post.');
            expect(describeCommentRequestFailure('reply', 404).message)
                .toBe('That comment is no longer available.');
            expect(describeCommentRequestFailure('remove', 404).message)
                .toBe('That comment is no longer available.');
        });

        it('says how long to wait after a rate limit', () => {
            expect(describeCommentRequestFailure('load', 429, { retryAfterSeconds: 30 })).toEqual({
                message: 'Too many requests. Wait 30 seconds, then try again.',
                retryable: true,
                signIn: false,
            });
            expect(describeCommentRequestFailure('post', 429, { retryAfterSeconds: 1 }).message)
                .toBe('Too many requests. Wait 1 second, then try again.');
            expect(describeCommentRequestFailure('post', 429, { retryAfterSeconds: 541 }).message)
                .toBe('Too many requests. Wait 10 minutes, then try again.');
            expect(describeCommentRequestFailure('report', 429, {}).message)
                .toBe('Too many requests. Wait a moment, then try again.');
        });

        it('asks for sign-in when the session has ended', () => {
            expect(describeCommentRequestFailure('post', 401, { error: 'Unauthorized' })).toEqual({
                message: 'Your session ended. Sign in to post.',
                retryable: true,
                signIn: true,
            });
            expect(describeCommentRequestFailure('load', 401).message)
                .toBe('Your session ended. Sign in again to continue.');
        });

        it("keeps the server's words for a write, never for a read or a non-JSON body", () => {
            expect(describeCommentRequestFailure('reply', 403, {
                error: 'Replying is unavailable on this comment.',
            }).message).toBe('Replying is unavailable on this comment.');
            expect(describeCommentRequestFailure('load', 500, { error: 'Failed to load comments.' }).message)
                .toBe('We could not load this conversation.');
            expect(describeCommentRequestFailure('post', 502, {}).message).toBe('Could not post comment.');
            expect(describeCommentRequestFailure('remove', null).message).toBe('Could not remove comment.');
        });
    });

    describe('query building', () => {
        it('defaults to the first page sorted by top', () => {
            expect(buildCommentsQuery()).toBe('limit=20&offset=0&sort=top');
        });

        it('adds a parent only when fetching a reply set', () => {
            expect(buildCommentsQuery({ parentId: 'a' })).toContain('parentId=a');
            expect(buildCommentsQuery({ parentId: null })).not.toContain('parentId');
        });

        it('carries the requested page and sort', () => {
            expect(buildCommentsQuery({ offset: 40, sort: 'newest', limit: 5 }))
                .toBe('limit=5&offset=40&sort=newest');
        });
    });
});
