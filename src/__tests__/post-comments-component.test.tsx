import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PostComments from '@/components/PostComments';
import type { PostComment, PostCommentsPage } from '@/lib/post-comments-client';

import mobileApiContract from '../../contracts/mobile-api-v1.json';

const { authState } = vi.hoisted(() => ({
    authState: {
        session: null as { access_token: string } | null,
        user: null as {
            id: string;
            email: string;
            user_metadata: Record<string, unknown>;
        } | null,
    },
}));

vi.mock('@/components/AuthProvider', () => ({
    useAuth: () => authState,
}));

vi.mock('@/components/PostCommentAvatar', () => ({
    default: ({ name }: { name: string }) => <span aria-hidden="true">{name}</span>,
}));

function comment(overrides: Partial<PostComment> = {}): PostComment {
    return {
        id: 'comment-1',
        parentId: null,
        body: 'A thoughtful comment',
        status: 'active',
        createdAt: '2026-07-28T00:00:00.000Z',
        replyCount: 0,
        author: {
            id: 'author-1',
            username: 'creator',
            displayName: 'Creator',
            avatarUrl: null,
        },
        ...overrides,
    };
}

function page(
    comments: PostComment[],
    overrides: Partial<PostCommentsPage['pageInfo']> = {}
): PostCommentsPage {
    return {
        postId: 'post-1',
        postCreatorId: 'post-owner',
        commentCount: comments.filter((item) => item.status === 'active').length,
        comments,
        pageInfo: {
            hasMore: false,
            nextOffset: null,
            limit: 20,
            offset: 0,
            ...overrides,
        },
    };
}

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

const viewerAuthor = {
    id: 'viewer-1',
    username: 'viewer',
    displayName: 'Viewer',
    avatarUrl: null,
};

function signIn(accessToken = 'token-1') {
    authState.session = { access_token: accessToken };
    authState.user = { id: 'viewer-1', email: 'viewer@example.com', user_metadata: {} };
}

function numberedComments(
    count: number,
    overrides: (position: number) => Partial<PostComment> = () => ({})
) {
    return Array.from({ length: count }, (_, index) => comment({
        id: `c${index + 1}`,
        body: `Comment ${index + 1}`,
        ...overrides(index + 1),
    }));
}

/**
 * Serves a top-level thread the way the route does: raw offsets, at most 50
 * comments a read, `nextOffset` while there are more, and a DELETE that takes
 * a comment without replies out of the thread.
 */
function serveThread(initial: PostComment[]) {
    let thread = [...initial];
    const reads: Array<{ offset: number; limit: number; authorization: string | null }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://localhost');
        if (init?.method === 'DELETE') {
            const commentId = decodeURIComponent(url.pathname.split('/').pop() ?? '');
            thread = thread.filter((item) => item.id !== commentId);
            return jsonResponse({ success: true, status: 'removed_by_author', commentCount: thread.length });
        }

        const offset = Number(url.searchParams.get('offset'));
        const requested = Number(url.searchParams.get('limit'));
        const limit = Math.min(requested, 50);
        reads.push({
            offset,
            limit: requested,
            authorization: new Headers(init?.headers).get('Authorization'),
        });
        const hasMore = offset + limit < thread.length;
        return jsonResponse({
            ...page(thread.slice(offset, offset + limit), {
                hasMore,
                nextOffset: hasMore ? offset + limit : null,
                limit,
                offset,
            }),
            commentCount: thread.length,
        });
    });
    return { fetchMock, reads };
}

function threadItems() {
    return within(screen.getByRole('list', { name: 'Comment thread' })).getAllByRole('listitem');
}

describe('PostComments', () => {
    beforeEach(() => {
        authState.session = null;
        authState.user = null;
        window.history.replaceState(null, '', '/feed?chip=recent');
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('shows a retryable load error without claiming the thread is empty', async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ error: 'Unavailable' }, 500));
        vi.stubGlobal('fetch', fetchMock);

        render(
            <PostComments
                postId="post-1"
                postCreatorId="post-owner"
                commentCount={3}
            />
        );

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'We could not load this conversation.'
        );
        expect(screen.queryByText(/No comments yet/i)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Load more comments' }))
            .not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    });

    it('preserves the current page through sign-in and hides inert reply actions', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(page([comment()]))));

        render(
            <PostComments
                postId="post-1"
                postCreatorId="post-owner"
                commentCount={1}
            />
        );

        await screen.findByText('A thoughtful comment');
        expect(screen.queryByRole('button', { name: /^Reply to / })).not.toBeInTheDocument();

        await waitFor(() => {
            expect(screen.getByRole('link', { name: /Sign in to join/i }))
                .toHaveAttribute(
                    'href',
                    '/login?returnUrl=%2Ffeed%3Fchip%3Drecent'
                );
        });
    });

    it('ignores an older sort response after the viewer changes sort', async () => {
        let resolveTop: (response: Response) => void = () => undefined;
        const topResponse = new Promise<Response>((resolve) => {
            resolveTop = resolve;
        });
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('sort=newest')) {
                return jsonResponse(page([comment({
                    id: 'newest-comment',
                    body: 'Newest result',
                })]));
            }
            return topResponse;
        });
        vi.stubGlobal('fetch', fetchMock);

        render(
            <PostComments
                postId="post-1"
                postCreatorId="post-owner"
                commentCount={1}
            />
        );

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        fireEvent.click(screen.getByRole('button', { name: 'New' }));
        expect(await screen.findByText('Newest result')).toBeInTheDocument();

        resolveTop(jsonResponse(page([comment({
            id: 'stale-top-comment',
            body: 'Stale top result',
        })])));
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(screen.queryByText('Stale top result')).not.toBeInTheDocument();
        expect(screen.getByText('Newest result')).toBeInTheDocument();
    });

    it('loads every reply page and never offers a nested reply action', async () => {
        authState.session = { access_token: 'token-1' };
        authState.user = {
            id: 'viewer-1',
            email: 'viewer@example.com',
            user_metadata: {},
        };

        const root = comment({ id: 'root-1', replyCount: 21 });
        const firstReply = comment({
            id: 'reply-1',
            parentId: root.id,
            body: 'First reply',
            replyCount: 0,
        });
        const lastReply = comment({
            id: 'reply-21',
            parentId: root.id,
            body: 'Last reply',
            replyCount: 0,
        });

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('parentId=root-1') && url.includes('offset=20')) {
                return jsonResponse(page([lastReply], {
                    offset: 20,
                    hasMore: false,
                    nextOffset: null,
                }));
            }
            if (url.includes('parentId=root-1')) {
                return jsonResponse(page([firstReply], {
                    hasMore: true,
                    nextOffset: 20,
                }));
            }
            return jsonResponse(page([root]));
        });
        vi.stubGlobal('fetch', fetchMock);

        render(
            <PostComments
                postId="post-1"
                postCreatorId="post-owner"
                commentCount={22}
            />
        );

        fireEvent.click(await screen.findByRole('button', { name: 'View 21 replies' }));
        expect(await screen.findByText('First reply')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Load more replies' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Load more replies' }));
        expect(await screen.findByText('Last reply')).toBeInTheDocument();

        // Only the top-level comment can be a reply target.
        expect(screen.getAllByRole('button', { name: /^Reply to / })).toHaveLength(1);
        expect(fetchMock.mock.calls.some(([input]) => (
            String(input).includes('parentId=root-1')
            && String(input).includes('offset=20')
        ))).toBe(true);
    });

    it('refreshes the full reply thread after posting instead of caching only the new reply', async () => {
        authState.session = { access_token: 'token-1' };
        authState.user = {
            id: 'viewer-1',
            email: 'viewer@example.com',
            user_metadata: {},
        };

        const root = comment({ id: 'root-1', replyCount: 2 });
        const oldReplyOne = comment({
            id: 'reply-old-1',
            parentId: root.id,
            body: 'Existing reply one',
        });
        const oldReplyTwo = comment({
            id: 'reply-old-2',
            parentId: root.id,
            body: 'Existing reply two',
        });
        const newReply = comment({
            id: 'reply-new',
            parentId: root.id,
            body: 'My new reply',
            author: {
                id: 'viewer-1',
                username: 'viewer',
                displayName: 'Viewer',
                avatarUrl: null,
            },
        });

        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (init?.method === 'POST') {
                return jsonResponse({
                    success: true,
                    comment: newReply,
                    commentCount: 4,
                }, 201);
            }
            if (url.includes('parentId=root-1')) {
                return jsonResponse(page([oldReplyOne, oldReplyTwo, newReply]));
            }
            return jsonResponse(page([{ ...root, replyCount: 3 }]));
        });
        vi.stubGlobal('fetch', fetchMock);

        render(
            <PostComments
                postId="post-1"
                postCreatorId="post-owner"
                commentCount={3}
            />
        );

        fireEvent.click(await screen.findByRole('button', { name: 'Reply to @creator' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Write a reply' }), {
            target: { value: 'My new reply' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }));

        expect(await screen.findByText('Existing reply one')).toBeInTheDocument();
        expect(screen.getByText('Existing reply two')).toBeInTheDocument();
        expect(screen.getByText('My new reply')).toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([input]) => (
            String(input).includes('parentId=root-1')
        ))).toBe(true);
    });

    // Feed ranking v4, §4: a comment written under a ranked feed card names the
    // delivery that showed it, in the field the app sends too
    // (`contracts/mobile-api-v1.json`, `createPostComment.request`).
    it('sends the feed delivery with a new comment, as the shared contract pins it', async () => {
        authState.session = { access_token: 'token-1' };
        authState.user = { id: 'viewer-1', email: 'viewer@example.com', user_metadata: {} };
        const pinned = mobileApiContract.endpoints.createPostComment.request;
        const posted: unknown[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'POST') {
                posted.push(JSON.parse(String(init.body)));
                return jsonResponse({ success: true, comment: comment({ id: 'comment-new', body: pinned.body }), commentCount: 1 }, 201);
            }
            return jsonResponse(page([]));
        }));

        const { unmount } = render(
            <PostComments postId="post-1" postCreatorId="post-owner" commentCount={0} deliveryId={pinned.deliveryId} />
        );
        fireEvent.change(await screen.findByRole('textbox', { name: 'Write a comment' }), { target: { value: pinned.body } });
        fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
        await waitFor(() => expect(posted).toHaveLength(1));
        expect(posted[0]).toEqual(pinned);
        unmount();

        // Reached any other way, the thread sends the body it always sent.
        render(<PostComments postId="post-1" postCreatorId="post-owner" commentCount={0} />);
        fireEvent.change(await screen.findByRole('textbox', { name: 'Write a comment' }), { target: { value: 'Plain' } });
        fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
        await waitFor(() => expect(posted).toHaveLength(2));
        expect(posted[1]).toEqual({ body: 'Plain', parentId: null });
    });

    it('submits the selected moderation reason and optional details', async () => {
        authState.session = { access_token: 'token-1' };
        authState.user = {
            id: 'viewer-1',
            email: 'viewer@example.com',
            user_metadata: {},
        };

        const reportFetch = vi.fn(async (
            input: RequestInfo | URL,
            init?: RequestInit
        ) => {
            void input;
            void init;
            return jsonResponse({ success: true });
        });
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input) === '/api/moderation/reports') {
                return reportFetch(input, init);
            }
            return jsonResponse(page([comment()]));
        }));

        render(
            <PostComments
                postId="post-1"
                postCreatorId="post-owner"
                commentCount={1}
            />
        );

        const reportButton = await screen.findByRole('button', { name: "Report @creator's comment" });
        fireEvent.click(reportButton);
        expect(screen.getByLabelText('Reason')).toHaveFocus();
        fireEvent.change(screen.getByLabelText('Reason'), {
            target: { value: 'unsafe_content' },
        });
        fireEvent.change(screen.getByLabelText(/Details/), {
            target: { value: 'Contains a dangerous instruction.' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Submit report' }));

        await waitFor(() => expect(reportFetch).toHaveBeenCalledTimes(1));
        const [, init] = reportFetch.mock.calls[0];
        expect(JSON.parse(String(init?.body))).toMatchObject({
            targetType: 'comment',
            targetId: 'comment-1',
            reason: 'unsafe_content',
            details: 'Contains a dangerous instruction.',
        });
        expect(await screen.findByText('Report submitted for review.')).toHaveClass('sr-only');
        // The form sat at the top of the thread; focus is back on the comment.
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(reportButton).toHaveFocus();
    });

    it("names each row action after the comment's author and returns focus when a report is cancelled", async () => {
        signIn();
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(page([comment()]))));

        const { unmount } = render(
            <PostComments postId="post-1" postCreatorId="post-owner" commentCount={1} />
        );

        const report = await screen.findByRole('button', { name: "Report @creator's comment" });
        expect(screen.getByRole('button', { name: 'Reply to @creator' })).toBeInTheDocument();
        fireEvent.click(report);
        expect(screen.getByLabelText('Reason')).toHaveFocus();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(report).toHaveFocus();
        unmount();

        // The post owner removes someone else's comment by name too.
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
            ...page([comment()]),
            postCreatorId: 'viewer-1',
        })));
        render(<PostComments postId="post-1" postCreatorId="viewer-1" commentCount={1} />);
        expect(await screen.findByRole('button', { name: "Remove @creator's comment" }))
            .toBeInTheDocument();
    });

    // 04-2: a delete deep in a long thread keeps every page the reader opened.
    it('keeps every loaded page after a delete on page 3, and pages on without a skip', async () => {
        signIn();
        const server = serveThread(numberedComments(61, (position) => (
            position === 50 ? { author: viewerAuthor } : {}
        )));
        vi.stubGlobal('fetch', server.fetchMock);
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        render(<PostComments postId="post-1" postCreatorId="post-owner" commentCount={61} />);
        await screen.findByText('Comment 20');
        fireEvent.click(screen.getByRole('button', { name: 'Load more comments' }));
        await screen.findByText('Comment 40');
        fireEvent.click(screen.getByRole('button', { name: 'Load more comments' }));
        await screen.findByText('Comment 60');
        expect(threadItems()).toHaveLength(60);
        server.reads.length = 0;

        fireEvent.click(screen.getByRole('button', { name: 'Delete your comment' }));
        await waitFor(() => expect(server.reads).toHaveLength(2));
        await screen.findByRole('button', { name: 'Load more comments' });

        // Everything loaded is read again from the top, 50 at a time (the
        // server's cap), rather than page 1 alone.
        expect(server.reads.map(({ offset, limit }) => [offset, limit])).toEqual([[0, 50], [50, 9]]);
        expect(screen.queryByText('Comment 50')).not.toBeInTheDocument();
        for (const position of [1, 21, 40, 41, 49, 51, 60]) {
            expect(screen.getByText(`Comment ${position}`)).toBeInTheDocument();
        }
        expect(threadItems()).toHaveLength(59);

        // "Load more" picks up at the shifted offset: nothing skipped or repeated.
        fireEvent.click(screen.getByRole('button', { name: 'Load more comments' }));
        expect(await screen.findByText('Comment 61')).toBeInTheDocument();
        expect(server.reads.at(-1)?.offset).toBe(59);
        expect(threadItems()).toHaveLength(60);
    });

    it('keeps a new reply on screen when its parent has more replies than one page', async () => {
        signIn();
        const root = comment({ id: 'root-1', replyCount: 21 });
        let replies = Array.from({ length: 21 }, (_, index) => comment({
            id: `reply-${index + 1}`,
            parentId: root.id,
            body: `Reply ${index + 1}`,
            createdAt: new Date(Date.UTC(2026, 6, 28, 1, index)).toISOString(),
        }));
        const mine = comment({
            id: 'reply-mine',
            parentId: root.id,
            body: 'My new reply',
            createdAt: '2026-07-29T00:00:00.000Z',
            author: viewerAuthor,
        });
        let topLevelReads = 0;
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input), 'http://localhost');
            if (init?.method === 'POST') {
                replies = [...replies, mine];
                return jsonResponse({ success: true, comment: mine, commentCount: 23 }, 201);
            }
            if (url.searchParams.get('parentId') === root.id) {
                const offset = Number(url.searchParams.get('offset'));
                const limit = Number(url.searchParams.get('limit'));
                const hasMore = offset + limit < replies.length;
                return jsonResponse(page(replies.slice(offset, offset + limit), {
                    hasMore,
                    nextOffset: hasMore ? offset + limit : null,
                    offset,
                }));
            }
            topLevelReads += 1;
            return jsonResponse(page([{ ...root, replyCount: replies.length }]));
        }));

        render(<PostComments postId="post-1" postCreatorId="post-owner" commentCount={22} />);
        fireEvent.click(await screen.findByRole('button', { name: 'View 21 replies' }));
        await screen.findByText('Reply 20');

        fireEvent.click(screen.getByRole('button', { name: 'Reply to @creator' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Write a reply' }), {
            target: { value: 'My new reply' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }));

        await screen.findByText('My new reply');
        await waitFor(() => expect(topLevelReads).toBe(2));
        await act(async () => {
            await Promise.resolve();
        });

        // The loaded page of replies stays, and the new reply stays after it.
        expect(screen.getByText('Reply 1')).toBeInTheDocument();
        expect(screen.getByText('Reply 20')).toBeInTheDocument();
        expect(screen.getByText('My new reply')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Load more replies' }));
        await screen.findByText('Reply 21');
        const order = screen.getAllByText(/^(Reply \d+|My new reply)$/).map((node) => node.textContent);
        expect(order).toHaveLength(22);
        expect(order.slice(-2)).toEqual(['Reply 21', 'My new reply']);
    });

    it('keeps a new comment on screen when Top ranks it past the loaded range', async () => {
        signIn();
        // Every comment has a reply, so Top ranks a new one after all of them.
        let thread = numberedComments(25, () => ({ replyCount: 1 }));
        const mine = comment({ id: 'mine', body: 'My new comment', author: viewerAuthor });
        const reads: Array<{ offset: number; limit: number }> = [];
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'POST') {
                thread = [...thread, mine];
                return jsonResponse({ success: true, comment: mine, commentCount: 26 }, 201);
            }
            const url = new URL(String(input), 'http://localhost');
            const offset = Number(url.searchParams.get('offset'));
            const limit = Number(url.searchParams.get('limit'));
            reads.push({ offset, limit });
            const hasMore = offset + limit < thread.length;
            return jsonResponse(page(thread.slice(offset, offset + limit), {
                hasMore,
                nextOffset: hasMore ? offset + limit : null,
                offset,
            }));
        }));

        render(<PostComments postId="post-1" postCreatorId="post-owner" commentCount={25} />);
        await screen.findByText('Comment 20');
        fireEvent.change(screen.getByRole('textbox', { name: 'Write a comment' }), {
            target: { value: 'My new comment' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

        await waitFor(() => expect(reads.at(-1)).toEqual({ offset: 0, limit: 21 }));
        await screen.findByRole('button', { name: 'Load more comments' });
        expect(within(threadItems()[0]).getByText('My new comment')).toBeInTheDocument();
        expect(screen.getByText('Comment 21')).toBeInTheDocument();
    });

    it('describes a delete by what happens to the comment', async () => {
        signIn();
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(page([
            comment({ id: 'mine-with-replies', body: 'Has replies', replyCount: 2, author: viewerAuthor }),
            comment({ id: 'mine-alone', body: 'Stands alone', author: viewerAuthor }),
        ]))));
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

        render(<PostComments postId="post-1" postCreatorId="post-owner" commentCount={2} />);
        await screen.findByText('Stands alone');
        const [withReplies, alone] = screen.getAllByRole('button', { name: 'Delete your comment' });

        fireEvent.click(withReplies);
        expect(confirm).toHaveBeenLastCalledWith(
            'Delete your comment? It will be replaced with “[deleted]”. Replies to it stay visible.'
        );
        fireEvent.click(alone);
        expect(confirm).toHaveBeenLastCalledWith('Delete your comment? It will be removed.');
    });

    it('says why a delete failed when the answer is not JSON', async () => {
        signIn();
        vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
            init?.method === 'DELETE'
                ? new Response('<html><body>Too Many Requests</body></html>', {
                    status: 429,
                    headers: { 'Content-Type': 'text/html' },
                })
                : jsonResponse(page([comment({ id: 'mine', body: 'Mine', author: viewerAuthor })]))
        )));
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        render(<PostComments postId="post-1" postCreatorId="post-owner" commentCount={1} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Delete your comment' }));

        expect(await screen.findByRole('alert'))
            .toHaveTextContent('Too many requests. Wait a moment, then try again.');
        expect(screen.getByText('Mine')).toBeInTheDocument();
    });

    // 04-6: Supabase hands the same viewer a new token about hourly.
    it('keeps the loaded thread through a token refresh and sends the new token afterwards', async () => {
        signIn('token-1');
        const server = serveThread(numberedComments(45));
        vi.stubGlobal('fetch', server.fetchMock);
        const view = () => <PostComments postId="post-1" postCreatorId="post-owner" commentCount={45} />;

        const { rerender } = render(view());
        await screen.findByText('Comment 20');
        fireEvent.click(screen.getByRole('button', { name: 'Load more comments' }));
        await screen.findByText('Comment 40');
        expect(server.reads).toHaveLength(2);

        signIn('token-2');
        rerender(view());
        await act(async () => {
            await Promise.resolve();
        });
        expect(server.reads).toHaveLength(2);
        expect(screen.getByText('Comment 40')).toBeInTheDocument();
        expect(screen.queryByText('Loading comments…')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Load more comments' }));
        await screen.findByText('Comment 45');
        expect(server.reads.at(-1)).toEqual({ offset: 40, limit: 20, authorization: 'Bearer token-2' });
    });

    it('retries a read that failed once the token refreshes, and only then', async () => {
        signIn('token-1');
        const sent: Array<string | null> = [];
        vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const authorization = new Headers(init?.headers).get('Authorization');
            sent.push(authorization);
            return authorization === 'Bearer token-1'
                ? jsonResponse({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
                : jsonResponse(page([comment()]));
        }));
        const view = () => <PostComments postId="post-1" postCreatorId="post-owner" commentCount={1} />;

        const { rerender } = render(view());
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Your session ended. Sign in again to continue.');
        expect(within(alert).getByRole('link', { name: 'Sign in' }))
            .toHaveAttribute('href', '/login?returnUrl=%2Ffeed%3Fchip%3Drecent');

        signIn('token-2');
        rerender(view());
        expect(await screen.findByText('A thoughtful comment')).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(sent).toEqual(['Bearer token-1', 'Bearer token-2']);

        // With nothing failed, a later refresh reads nothing.
        signIn('token-3');
        rerender(view());
        await act(async () => {
            await Promise.resolve();
        });
        expect(sent).toHaveLength(2);
    });

    it('starts the thread over for a different viewer', async () => {
        signIn('token-1');
        const server = serveThread(numberedComments(25));
        vi.stubGlobal('fetch', server.fetchMock);
        const view = () => <PostComments postId="post-1" postCreatorId="post-owner" commentCount={25} />;

        const { rerender } = render(view());
        await screen.findByText('Comment 20');
        fireEvent.click(screen.getByRole('button', { name: 'Load more comments' }));
        await screen.findByText('Comment 25');

        authState.session = null;
        authState.user = null;
        rerender(view());

        await waitFor(() => expect(server.reads.at(-1)).toEqual({ offset: 0, limit: 20, authorization: null }));
        await screen.findByRole('button', { name: 'Load more comments' });
        expect(screen.queryByText('Comment 25')).not.toBeInTheDocument();
    });

    // 04-7: the cause, not "check your connection".
    it('says comments are closed on a 404 and offers no retry', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Post not found.' }, 404)));

        render(<PostComments postId="post-1" postCreatorId="post-owner" commentCount={3} />);

        expect(await screen.findByRole('alert')).toHaveTextContent('Comments are closed on this post.');
        expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
        expect(screen.queryByText(/No comments yet/i)).not.toBeInTheDocument();
    });

    it('says how long to wait when reads are rate limited', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
            error: 'Too many requests. Please wait before trying again.',
            code: 'RATE_LIMITED',
            retryAfterSeconds: 42,
        }, 429)));

        render(<PostComments postId="post-1" postCreatorId="post-owner" commentCount={3} />);

        expect(await screen.findByRole('alert'))
            .toHaveTextContent('Too many requests. Wait 42 seconds, then try again.');
        expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    it('asks for sign-in when the session ended, and never shows a parser error', async () => {
        signIn();
        let answerPost = () => jsonResponse({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
        vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
            init?.method === 'POST' ? answerPost() : jsonResponse(page([]))
        )));

        render(<PostComments postId="post-1" postCreatorId="post-owner" commentCount={0} />);
        fireEvent.change(await screen.findByRole('textbox', { name: 'Write a comment' }), {
            target: { value: 'Hello' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Your session ended. Sign in to post.');
        expect(alert).not.toHaveTextContent('Unauthorized');
        expect(within(alert).getByRole('link', { name: 'Sign in' }))
            .toHaveAttribute('href', '/login?returnUrl=%2Ffeed%3Fchip%3Drecent');

        // The platform's own rate limit answers with an HTML page: the status
        // still picks the copy, and no parser message reaches the reader.
        answerPost = () => new Response('<html><body>Too Many Requests</body></html>', {
            status: 429,
            headers: { 'Content-Type': 'text/html' },
        });
        fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }));
        fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

        expect(await screen.findByRole('alert'))
            .toHaveTextContent('Too many requests. Wait a moment, then try again.');
        expect(screen.getByRole('alert')).not.toHaveTextContent(/JSON|Unexpected token/);

        answerPost = () => new Response('<html><body>Bad gateway</body></html>', {
            status: 502,
            headers: { 'Content-Type': 'text/html' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
        fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Could not post comment.');
        expect(screen.getByRole('alert')).not.toHaveTextContent(/JSON|Unexpected token/);
    });
});
