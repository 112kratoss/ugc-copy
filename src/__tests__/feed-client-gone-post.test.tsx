import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedClient, { forgetFeedRemovalsForTests } from '@/app/feed/FeedClient';
import type { ShowcaseFeedItem, ShowcaseFeedPage } from '@/lib/showcase';

vi.mock('@/components/AuthProvider', () => ({
    useAuth: () => ({ session: null, user: null }),
}));

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));

// The card's media failing is the carousel's to notice (its own tests); here a
// button stands for it, so the test drives the lane's real answer.
vi.mock('@/app/feed/FeedPostCard', () => ({
    default: function MockFeedPostCard({ card, onMediaUnavailable }: {
        card: { id: string };
        onMediaUnavailable?: (postId: string) => Promise<'removed' | 'retry'>;
    }) {
        const [answer, setAnswer] = useState<string | null>(null);
        return (
            <article data-testid={`card:${card.id}`}>
                <button
                    type="button"
                    onClick={() => void onMediaUnavailable?.(card.id).then(setAnswer)}
                >
                    {`fail:${card.id}`}
                </button>
                {answer ? <span>{`answer:${card.id}:${answer}`}</span> : null}
            </article>
        );
    },
}));

function item(id: string): ShowcaseFeedItem {
    return {
        id,
        mediaUrl: null,
        mediaKind: null,
        model: 'external',
        title: id,
        prompt: '',
        body: '',
        category: 'image',
        postFormat: 'media',
        saveCount: 0,
        remixCount: 0,
        commentCount: 0,
        createdAt: '2026-11-14T00:00:00.000Z',
        creator: { id: 'creator-1', username: 'creator', name: 'Creator', avatar: null },
        isSaved: false,
        sourceKind: 'external',
        sourceTool: null,
        generationId: null,
        asset: null,
        canRemix: false,
    } as ShowcaseFeedItem;
}

const feed: ShowcaseFeedPage = {
    items: [item('archived-post'), item('live-post')],
    pageInfo: { hasMore: false, nextOffset: null },
} as ShowcaseFeedPage;

const resolverAnswers: Record<string, number> = {
    '/api/showcase/posts/archived-post/resolve': 404,
    '/api/showcase/posts/live-post/resolve': 200,
};

describe('FeedClient: a card whose post left public view', () => {
    beforeEach(() => {
        forgetFeedRemovalsForTests();
        vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
            const status = resolverAnswers[String(input)];
            // The guest's own page one, which the signed-out feed asks for: never answered here.
            if (!status) return new Promise(() => undefined);
            return Promise.resolve(new Response(JSON.stringify({}), { status }));
        }));
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('removes the card when the resolver says the post is gone', async () => {
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        await act(async () => {
            fireEvent.click(screen.getByText('fail:archived-post'));
        });

        await waitFor(() => expect(screen.queryByTestId('card:archived-post')).not.toBeInTheDocument());
        expect(screen.getByTestId('card:live-post')).toBeInTheDocument();
        expect(fetch).toHaveBeenCalledWith('/api/showcase/posts/archived-post/resolve', expect.anything());
    });

    it('keeps the card, to retry, when the post is still public', async () => {
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        await act(async () => {
            fireEvent.click(screen.getByText('fail:live-post'));
        });

        expect(await screen.findByText('answer:live-post:retry')).toBeInTheDocument();
        expect(screen.getByTestId('card:live-post')).toBeInTheDocument();
        expect(screen.getByTestId('card:archived-post')).toBeInTheDocument();
    });
});
