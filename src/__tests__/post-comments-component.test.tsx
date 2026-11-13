import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedbackViewport from '@/components/FeedbackViewport';
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
        likeCount: 0,
        viewerReaction: null,
        editedAt: null,
        hearted: false,
        pinned: false,
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

/** Opens a comment's menu (or the header's) and presses one of its items. */
function chooseFromMenu(trigger: HTMLElement, item: string | RegExp) {
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: item }));
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
        // The order is a menu in the thread's header, the chosen one checked.
        fireEvent.click(screen.getByRole('button', { name: 'Sort comments' }));
        expect(screen.getByRole('menuitemradio', { name: /^Top/ })).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(screen.getByRole('menuitemradio', { name: /^Newest/ }));
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

    it('loads every reply page, and a reply to a reply joins the same thread by name', async () => {
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

        expect(fetchMock.mock.calls.some(([input]) => (
            String(input).includes('parentId=root-1')
            && String(input).includes('offset=20')
        ))).toBe(true);

        // A reply can be answered too. The product keeps one reply level, so
        // the answer is sent to the thread's top comment and opens by naming
        // the reply it answers.
        const replyButtons = screen.getAllByRole('button', { name: /^Reply to / });
        expect(replyButtons).toHaveLength(3);
        fireEvent.click(replyButtons[2]);
        const composer = screen.getByRole('textbox', { name: 'Write a reply' });
        expect(composer).toHaveValue('@creator ');
        fireEvent.change(composer, { target: { value: '@creator agreed' } });
        fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
        await waitFor(() => {
            const post = fetchMock.mock.calls
                .map((call) => (call as unknown as [RequestInfo | URL, RequestInit | undefined])[1])
                .find((init) => init?.method === 'POST');
            expect(JSON.parse(String(post?.body))).toMatchObject({
                body: '@creator agreed',
                parentId: 'root-1',
            });
        });

        // The handle belongs to its target. Moved to the top comment with
        // nothing typed, the draft drops it; moved back, it returns, and it
        // alone is nothing to send.
        const freshReplyButtons = () => screen.getAllByRole('button', { name: /^Reply to / });
        // (This server answers no POST, so the draft above is still there: dropped first.)
        fireEvent.click(screen.getByRole('button', { name: 'Cancel reply' }));
        fireEvent.click(freshReplyButtons()[2]);
        expect(screen.getByRole('textbox', { name: 'Write a reply' })).toHaveValue('@creator ');
        expect(screen.getByRole('button', { name: 'Reply' })).toBeDisabled();
        fireEvent.click(freshReplyButtons()[0]);
        expect(screen.getByRole('textbox', { name: 'Write a reply' })).toHaveValue('');
        // A draft under way survives a change of target.
        fireEvent.change(screen.getByRole('textbox', { name: 'Write a reply' }), { target: { value: 'Half a reply' } });
        fireEvent.click(freshReplyButtons()[2]);
        expect(screen.getByRole('textbox', { name: 'Write a reply' })).toHaveValue('Half a reply');
        expect(screen.getByRole('button', { name: 'Reply' })).toBeEnabled();

        // Cancel drops the draft and the reply target with it, and focus goes
        // back to the Reply the reply came from.
        fireEvent.click(screen.getByRole('button', { name: 'Cancel reply' }));
        expect(screen.queryByRole('textbox', { name: 'Write a reply' })).not.toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: 'Write a comment' })).toHaveValue('');
        expect(freshReplyButtons()[2]).toHaveFocus();
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

        const reportButton = await screen.findByRole('button', { name: "More actions for @creator's comment" });
        chooseFromMenu(reportButton, 'Report');
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

        const report = await screen.findByRole('button', { name: "More actions for @creator's comment" });
        expect(screen.getByRole('button', { name: 'Reply to @creator' })).toBeInTheDocument();
        chooseFromMenu(report, 'Report');
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
        fireEvent.click(await screen.findByRole('button', { name: "More actions for @creator's comment" }));
        expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Remove' }))
            .toBeInTheDocument();
    });

    it("marks the post's creator, folds a long comment, and keeps the composer's buttons for a draft", async () => {
        signIn();
        const long = Array.from({ length: 6 }, (_, index) => `Line ${index + 1}`).join('\n');
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(page([
            comment({ id: 'by-owner', body: 'From the creator', author: { ...viewerAuthor, id: 'post-owner', username: 'owner' } }),
            // Named apart from the mark: the avatar stand-in above prints the name it is given.
            comment({ id: 'long', body: long, author: { id: 'author-2', username: 'lena', displayName: 'Lena', avatarUrl: null } }),
        ]))));
        const onClose = vi.fn();

        render(
            <PostComments postId="post-1" postCreatorId="post-owner" commentCount={2} layout="panel" onClose={onClose} />
        );
        await screen.findByText('From the creator');

        const [byOwner, longRow] = threadItems();
        expect(within(byOwner).getByText('Creator')).toBeInTheDocument();
        expect(within(longRow).queryByText('Creator')).not.toBeInTheDocument();

        // Folded to four lines until asked for; a short comment has no fold.
        expect(within(byOwner).queryByRole('button', { name: 'Read more' })).not.toBeInTheDocument();
        const body = within(longRow).getByText(/^Line 1/);
        expect(body).toHaveClass('line-clamp-4');
        fireEvent.click(within(longRow).getByRole('button', { name: 'Read more' }));
        expect(body).not.toHaveClass('line-clamp-4');
        fireEvent.click(within(longRow).getByRole('button', { name: 'Show less' }));
        expect(body).toHaveClass('line-clamp-4');

        // One line until it is used: Cancel and Comment come with the focus,
        // and Cancel drops the draft.
        const composer = screen.getByRole('textbox', { name: 'Write a comment' });
        expect(screen.queryByRole('button', { name: 'Comment' })).not.toBeInTheDocument();
        fireEvent.focus(composer);
        expect(screen.getByRole('button', { name: 'Comment' })).toBeDisabled();
        fireEvent.change(composer, { target: { value: 'Half a thought' } });
        expect(screen.getByRole('button', { name: 'Comment' })).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel comment' }));
        expect(composer).toHaveValue('');
        expect(screen.queryByRole('button', { name: 'Comment' })).not.toBeInTheDocument();
        // Cancel left the page with focus on it: the composer has it, still folded.
        expect(composer).toHaveFocus();

        // A panel ends with its composer, where a wide page draws it, so Tab
        // follows the eye: header, thread, composer.
        const thread = screen.getByRole('list', { name: 'Comment thread' });
        expect(thread.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        // A panel beside the post: the count in its header, and its close button.
        expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^Comments\s*2$/);
        expect(screen.getByRole('region', { name: 'Comments' })).toHaveClass('post-comments--panel');
        fireEvent.click(screen.getByRole('button', { name: 'Close comments' }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('sends a draft with Cmd or Ctrl and Enter, and leaves a bare Enter as a new line', async () => {
        signIn();
        const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (_input, init) => (
            init?.method === 'POST'
                ? jsonResponse({ comment: comment({ id: 'new', body: 'Sent by key', author: viewerAuthor }), commentCount: 1 })
                : jsonResponse(page([]))
        ));
        vi.stubGlobal('fetch', fetchMock);

        render(<PostComments postId="post-1" postCreatorId="post-owner" commentCount={0} />);
        const composer = await screen.findByRole('textbox', { name: 'Write a comment' });
        // No order to choose, and nothing to close, on an empty thread in a feed card.
        expect(screen.queryByRole('button', { name: 'Sort comments' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Close comments' })).not.toBeInTheDocument();

        // In a column (a feed card, the reel) the composer leads the thread.
        expect(composer.compareDocumentPosition(screen.getByText(/No comments yet/)) & Node.DOCUMENT_POSITION_FOLLOWING)
            .toBeTruthy();

        fireEvent.change(composer, { target: { value: 'Sent by key' } });
        fireEvent.keyDown(composer, { key: 'Enter' });
        expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
        fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
        await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    });

    describe('likes, the heart, the pin and edits', () => {
        type Init = RequestInit | undefined;
        /** A thread whose PATCH answers come from `answer`, and every change the page sent. */
        function serveThread(
            comments: PostComment[],
            answer: (change: Record<string, unknown>, target: PostComment) => Response,
            extra: Partial<{ postCreatorId: string }> = {}
        ) {
            const sent: Array<{ id: string; change: Record<string, unknown> }> = [];
            let thread = comments;
            const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: Init) => {
                if (init?.method === 'PATCH') {
                    const id = decodeURIComponent(new URL(String(input), 'http://localhost').pathname.split('/').pop() ?? '');
                    const change = JSON.parse(String(init.body)) as Record<string, unknown>;
                    sent.push({ id, change });
                    const response = answer(change, thread.find((item) => item.id === id) as PostComment);
                    if (response.ok) {
                        const body = await response.clone().json() as { comment: PostComment };
                        thread = thread.map((item) => (item.id === id ? body.comment : item));
                    }
                    return response;
                }
                return jsonResponse({ ...page(thread), ...extra });
            });
            vi.stubGlobal('fetch', fetchMock);
            return { sent, fetchMock };
        }
        const answered = (fresh: PostComment, unpinnedCommentId: string | null = null) => jsonResponse({
            success: true, comment: fresh, unpinnedCommentId,
        });

        it('shows a like at once, keeps the server\'s count, and never a count of dislikes', async () => {
            signIn();
            const { sent } = serveThread(
                [comment({ likeCount: 4 })],
                // Another reader liked it meanwhile: the answer says 6, not the page's guess of 5.
                (change, target) => answered({
                    ...target,
                    viewerReaction: change.reaction as PostComment['viewerReaction'],
                    likeCount: change.reaction === 'like' ? 6 : 5,
                }),
            );
            render(<PostComments postId="post-1" postCreatorId="post-owner" commentCount={1} />);

            const like = await screen.findByRole('button', { name: "Like @creator's comment" });
            const dislike = screen.getByRole('button', { name: "Dislike @creator's comment" });
            expect(like).toHaveAttribute('aria-pressed', 'false');
            expect(like).toHaveTextContent('4');
            expect(dislike).toHaveTextContent('');

            fireEvent.click(like);
            // At once, before any answer.
            expect(like).toHaveAttribute('aria-pressed', 'true');
            expect(like).toHaveTextContent('5');
            await waitFor(() => expect(like).toHaveTextContent('6'));
            expect(sent).toEqual([{ id: 'comment-1', change: { reaction: 'like' } }]);

            // The other one replaces it; a dislike moves no count the page shows.
            fireEvent.click(dislike);
            await waitFor(() => expect(dislike).toHaveAttribute('aria-pressed', 'true'));
            expect(like).toHaveAttribute('aria-pressed', 'false');
            expect(like).toHaveTextContent('5');
            expect(dislike).toHaveTextContent('');
            // Pressed again, it is taken back.
            fireEvent.click(dislike);
            await waitFor(() => expect(sent.at(-1)?.change).toEqual({ reaction: null }));
        });

        it('puts a like back when the server refuses it, and says why', async () => {
            signIn();
            serveThread(
                [comment({ likeCount: 4 })],
                () => jsonResponse({ error: 'Reacting is unavailable on this comment.' }, 403),
            );
            render(<PostComments postId="post-1" postCreatorId="post-owner" commentCount={1} />);

            const like = await screen.findByRole('button', { name: "Like @creator's comment" });
            fireEvent.click(like);
            expect(like).toHaveTextContent('5');

            expect(await screen.findByRole('alert')).toHaveTextContent('Reacting is unavailable on this comment.');
            expect(like).toHaveAttribute('aria-pressed', 'false');
            expect(like).toHaveTextContent('4');
        });

        it('sends a reaction pressed before the last one was answered, instead of dropping it', async () => {
            signIn();
            let release: () => void = () => {};
            const held = new Promise<void>((resolve) => { release = resolve; });
            const sent: Array<Record<string, unknown>> = [];
            let thread = [comment({ likeCount: 4 })];
            vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: Init) => {
                if (init?.method !== 'PATCH') return jsonResponse(page(thread));
                const change = JSON.parse(String(init.body)) as Record<string, unknown>;
                sent.push(change);
                // The first answer is slow: the correction is pressed while it is out.
                if (sent.length === 1) await held;
                const fresh = {
                    ...thread[0],
                    viewerReaction: change.reaction as PostComment['viewerReaction'],
                    likeCount: change.reaction === 'like' ? 5 : 4,
                };
                thread = [fresh];
                return answered(fresh);
            }));
            render(<PostComments postId="post-1" postCreatorId="post-owner" commentCount={1} />);

            const like = await screen.findByRole('button', { name: "Like @creator's comment" });
            const dislike = screen.getByRole('button', { name: "Dislike @creator's comment" });
            fireEvent.click(like);
            fireEvent.click(dislike);

            // Both presses show at once; only the first is on its way.
            expect(dislike).toHaveAttribute('aria-pressed', 'true');
            expect(like).toHaveAttribute('aria-pressed', 'false');
            expect(like).toHaveTextContent('4');
            expect(sent).toEqual([{ reaction: 'like' }]);

            release();
            await waitFor(() => expect(sent).toEqual([{ reaction: 'like' }, { reaction: 'dislike' }]));
            await waitFor(() => expect(dislike).toHaveAttribute('aria-pressed', 'true'));
            expect(like).toHaveAttribute('aria-pressed', 'false');
            expect(like).toHaveTextContent('4');
            expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        });

        it('leads the thread with a comment the moment it is pinned, whatever becomes of the re-read', async () => {
            signIn();
            const first = comment({ id: 'first', body: 'From an early reader' });
            const second = comment({ id: 'second', body: 'From a later reader' });
            let reads = 0;
            vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: Init) => {
                if (init?.method === 'PATCH') return answered({ ...second, pinned: true });
                reads += 1;
                // The read after the pin fails: the list is left as the page has it.
                return reads === 1
                    ? jsonResponse({ ...page([first, second]), postCreatorId: 'viewer-1' })
                    : jsonResponse({ error: 'Unavailable' }, 500);
            }));
            render(<PostComments postId="post-1" postCreatorId="viewer-1" commentCount={2} />);
            await screen.findByText('From a later reader');

            const menus = screen.getAllByRole('button', { name: /^More actions for/ });
            chooseFromMenu(menus[1], 'Pin');

            const pinnedRow = (await screen.findByText('Pinned by the creator')).closest('li') as HTMLElement;
            expect(within(pinnedRow).getByText('From a later reader')).toBeInTheDocument();
            const bodies = screen.getAllByText(/^From an? (early|later) reader$/).map((node) => node.textContent);
            expect(bodies).toEqual(['From a later reader', 'From an early reader']);
        });

        it('shows a visitor the likes, the heart, the pin and the edit mark, and sends a press to sign-in', async () => {
            vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(page([comment({
                likeCount: 12, hearted: true, pinned: true, editedAt: '2026-11-01T00:00:00.000Z',
            })]))));
            render(<PostComments postId="post-1" postCreatorId="post-owner" commentCount={1} />);

            const row = (await screen.findByText('A thoughtful comment')).closest('li') as HTMLElement;
            expect(within(row).getByText('Pinned by the creator')).toBeInTheDocument();
            expect(within(row).getByText(/\(edited\)/)).toBeInTheDocument();
            expect(within(row).getByText('Loved by the creator')).toBeInTheDocument();
            const signInToLike = within(row).getByRole('link', { name: "Sign in to like @creator's comment" });
            expect(signInToLike).toHaveTextContent('12');
            expect(signInToLike.getAttribute('href')).toMatch(/^\/login\?returnUrl=/);
            // Nothing a visitor could press as if it were theirs.
            expect(within(row).queryByRole('button', { name: /^(Like|Dislike|Heart) / })).not.toBeInTheDocument();
        });

        it('gives the post\'s creator the heart on other people\'s comments, and the pin behind the menu', async () => {
            signIn();
            const mine = comment({ id: 'mine', body: 'From the creator', author: viewerAuthor });
            const theirs = comment({ id: 'theirs', body: 'From a reader' });
            const { sent } = serveThread(
                [mine, theirs],
                (change, target) => answered({ ...target, ...change } as PostComment),
                { postCreatorId: 'viewer-1' },
            );
            render(<PostComments postId="post-1" postCreatorId="viewer-1" commentCount={2} />);
            await screen.findByText('From a reader');

            // The heart is for someone else's comment.
            expect(screen.queryByRole('button', { name: "Heart @viewer's comment" })).not.toBeInTheDocument();
            const heart = screen.getByRole('button', { name: "Heart @creator's comment" });
            expect(heart).toHaveAttribute('aria-pressed', 'false');
            fireEvent.click(heart);
            expect(heart).toHaveAttribute('aria-pressed', 'true');
            await waitFor(() => expect(sent).toEqual([{ id: 'theirs', change: { hearted: true } }]));
            expect(await screen.findByText('Comment hearted.')).toHaveClass('sr-only');

            // The pin: on any top-level comment, the creator's own included.
            chooseFromMenu(screen.getByRole('button', { name: 'More actions for your comment' }), 'Pin');
            await waitFor(() => expect(sent.at(-1)).toEqual({ id: 'mine', change: { pinned: true } }));
            const row = (await screen.findByText('Pinned by the creator')).closest('li') as HTMLElement;
            expect(within(row).getByText('From the creator')).toBeInTheDocument();
            // Pinned, its menu offers the way back.
            fireEvent.click(screen.getByRole('button', { name: 'More actions for your comment' }));
            expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Unpin' })).toBeInTheDocument();
            expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'Pin' })).not.toBeInTheDocument();
        });

        it('offers no heart and no pin to a reader who is not the post\'s creator', async () => {
            signIn();
            serveThread([comment()], (_change, target) => answered(target));
            render(<PostComments postId="post-1" postCreatorId="post-owner" commentCount={1} />);

            await screen.findByText('A thoughtful comment');
            expect(screen.queryByRole('button', { name: /^Heart / })).not.toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: "More actions for @creator's comment" }));
            expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent))
                .toEqual(['Report']);
        });

        it('rewords a comment in place: its author only, saved as an edit, focus back on its menu', async () => {
            signIn();
            const { sent } = serveThread(
                [comment({ id: 'mine', body: 'First words', author: viewerAuthor, hearted: true })],
                (change, target) => answered({
                    ...target, body: String(change.body), editedAt: '2026-11-13T12:00:00.000Z', hearted: false,
                }),
            );
            render(<PostComments postId="post-1" postCreatorId="post-owner" commentCount={1} />);

            const menu = await screen.findByRole('button', { name: 'More actions for your comment' });
            chooseFromMenu(menu, 'Edit');
            const editor = screen.getByRole('textbox', { name: 'Edit your comment' });
            expect(editor).toHaveValue('First words');
            expect(editor).toHaveFocus();
            // The same words are nothing to save; neither is nothing at all.
            expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
            fireEvent.change(editor, { target: { value: '   ' } });
            expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

            // Escape drops the edit and leaves the comment as it was.
            fireEvent.change(editor, { target: { value: 'Half an edit' } });
            fireEvent.keyDown(editor, { key: 'Escape' });
            expect(screen.queryByRole('textbox', { name: 'Edit your comment' })).not.toBeInTheDocument();
            expect(screen.getByText('First words')).toBeInTheDocument();
            expect(menu).toHaveFocus();
            expect(sent).toEqual([]);

            chooseFromMenu(menu, 'Edit');
            fireEvent.change(screen.getByRole('textbox', { name: 'Edit your comment' }), {
                target: { value: '  Better words  ' },
            });
            fireEvent.click(screen.getByRole('button', { name: 'Save' }));

            // The editor closes on the answer and the row reads the new words.
            await waitFor(() => (
                expect(screen.queryByRole('textbox', { name: 'Edit your comment' })).not.toBeInTheDocument()
            ));
            expect(screen.getByText('Better words')).toBeInTheDocument();
            expect(sent).toEqual([{ id: 'mine', change: { body: 'Better words' } }]);
            expect(screen.getByText(/\(edited\)/)).toBeInTheDocument();
            // The creator hearted other words: the answer took the heart off.
            expect(screen.queryByText('Loved by the creator')).not.toBeInTheDocument();
            expect(await screen.findByText('Comment edited.')).toHaveClass('sr-only');
            expect(menu).toHaveFocus();
        });

        it('keeps the editor open with the draft when a save fails', async () => {
            signIn();
            serveThread(
                [comment({ id: 'mine', body: 'First words', author: viewerAuthor })],
                () => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }),
            );
            render(<PostComments postId="post-1" postCreatorId="post-owner" commentCount={1} />);

            chooseFromMenu(await screen.findByRole('button', { name: 'More actions for your comment' }), 'Edit');
            fireEvent.change(screen.getByRole('textbox', { name: 'Edit your comment' }), {
                target: { value: 'Better words' },
            });
            fireEvent.click(screen.getByRole('button', { name: 'Save' }));

            expect(await screen.findByRole('alert')).toHaveTextContent('Could not save your edit.');
            expect(screen.getByRole('textbox', { name: 'Edit your comment' })).toHaveValue('Better words');
        });
    });

    // 04-2: a delete deep in a long thread keeps every page the reader opened.
    it('keeps every loaded page after a delete on page 3, and pages on without a skip', async () => {
        signIn();
        const server = serveThread(numberedComments(61, (position) => (
            position === 50 ? { author: viewerAuthor } : {}
        )));
        vi.stubGlobal('fetch', server.fetchMock);
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        // Sixty comments are drawn and re-read here, so under a loaded runner each step
        // can take longer than the default one-second wait (main's Quality run missed
        // it twice on 2026-10-13/14 while the PR runs passed).
        render(<PostComments postId="post-1" postCreatorId="post-owner" commentCount={61} />);
        await screen.findByText('Comment 20', undefined, { timeout: 5000 });
        fireEvent.click(screen.getByRole('button', { name: 'Load more comments' }));
        await screen.findByText('Comment 40', undefined, { timeout: 5000 });
        fireEvent.click(screen.getByRole('button', { name: 'Load more comments' }));
        await screen.findByText('Comment 60', undefined, { timeout: 5000 });
        expect(threadItems()).toHaveLength(60);
        server.reads.length = 0;

        chooseFromMenu(screen.getByRole('button', { name: 'More actions for your comment' }), 'Delete');
        await waitFor(() => expect(server.reads).toHaveLength(2), { timeout: 5000 });
        await screen.findByRole('button', { name: 'Load more comments' }, { timeout: 5000 });

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
        expect(await screen.findByText('Comment 61', undefined, { timeout: 5000 })).toBeInTheDocument();
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

        // The first Reply is the top comment's; each reply under it has its own.
        fireEvent.click(screen.getAllByRole('button', { name: 'Reply to @creator' })[0]);
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
        const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => jsonResponse(page([
            comment({ id: 'mine-with-replies', body: 'Has replies', replyCount: 2, author: viewerAuthor }),
            comment({ id: 'mine-alone', body: 'Stands alone', author: viewerAuthor }),
        ])));
        vi.stubGlobal('fetch', fetchMock);

        render(
            <>
                <PostComments postId="post-1" postCreatorId="post-owner" commentCount={2} />
                <FeedbackViewport />
            </>
        );
        await screen.findByText('Stands alone');
        const [withReplies, alone] = screen.getAllByRole('button', { name: 'More actions for your comment' });

        chooseFromMenu(withReplies, 'Delete');
        let question = await screen.findByRole('alertdialog', { name: 'Delete your comment?' });
        expect(question).toHaveAccessibleDescription('It will be replaced with “[deleted]”. Replies to it stay visible.');
        fireEvent.click(within(question).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());

        chooseFromMenu(alone, 'Delete');
        question = await screen.findByRole('alertdialog', { name: 'Delete your comment?' });
        expect(question).toHaveAccessibleDescription('It will be removed from this post.');
        expect(within(question).getByRole('button', { name: 'Delete comment' })).toBeInTheDocument();
        fireEvent.click(within(question).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());

        // Declined both times: nothing was deleted.
        expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
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
        chooseFromMenu(await screen.findByRole('button', { name: 'More actions for your comment' }), 'Delete');

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
