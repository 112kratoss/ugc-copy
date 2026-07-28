import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PostComments from '@/app/components/PostComments';
import type { PostComment, PostCommentsPage } from '@/lib/post-comments-client';

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

vi.mock('@/app/components/AuthProvider', () => ({
    useAuth: () => authState,
}));

vi.mock('@/app/components/PostCommentAvatar', () => ({
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
        expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument();

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
        expect(screen.getAllByRole('button', { name: 'Reply' })).toHaveLength(1);
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

        fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Write a reply' }), {
            target: { value: 'My new reply' },
        });
        fireEvent.click(screen.getAllByRole('button', { name: 'Reply' })[0]);

        expect(await screen.findByText('Existing reply one')).toBeInTheDocument();
        expect(screen.getByText('Existing reply two')).toBeInTheDocument();
        expect(screen.getByText('My new reply')).toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([input]) => (
            String(input).includes('parentId=root-1')
        ))).toBe(true);
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

        fireEvent.click(await screen.findByRole('button', { name: 'Report' }));
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
    });
});
