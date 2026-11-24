import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedClient, { forgetFeedRemovalsForTests } from '@/app/feed/FeedClient';
import type { ShowcaseFeedItem, ShowcaseFeedPage, ShowcaseMediaItem } from '@/lib/showcase';

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
        card: { id: string; item: ShowcaseFeedItem };
        onMediaUnavailable?: (postId: string, mediaItem: ShowcaseMediaItem) => Promise<'removed' | 'retry'>;
    }) {
        const [answer, setAnswer] = useState<string | null>(null);
        return (
            <article data-testid={`card:${card.id}`}>
                <button
                    type="button"
                    onClick={() => void onMediaUnavailable?.(card.id, card.item.mediaItems![0]!).then(setAnswer)}
                >
                    {`fail:${card.id}`}
                </button>
                {answer ? <span>{`answer:${card.id}:${answer}`}</span> : null}
            </article>
        );
    },
}));

function mediaUrl(postId: string) {
    return `/api/media?bucket=post_media&path=private-posts%2F${postId}%2Fphoto.jpg`;
}

function item(id: string): ShowcaseFeedItem {
    return {
        id,
        mediaUrl: mediaUrl(id),
        mediaKind: 'image',
        mediaItems: [{
            id: `${id}-media`,
            url: mediaUrl(id),
            previewUrl: null,
            mediaKind: 'image',
            contentType: 'image/jpeg',
            originalName: 'photo.jpg',
            width: 800,
            height: 1000,
            durationSeconds: null,
            sortOrder: 0,
        }],
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

// What the media route answers each post's media now: the archived post's is refused.
const mediaAnswers: Record<string, number> = {
    [mediaUrl('archived-post')]: 404,
    [mediaUrl('live-post')]: 503,
};

let answerGuestPageOne: (page: ShowcaseFeedPage) => void;

describe('FeedClient: a card whose media is gone', () => {
    beforeEach(() => {
        forgetFeedRemovalsForTests();
        vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
            const url = String(input);
            const status = mediaAnswers[url];
            if (status) return Promise.resolve(new Response(JSON.stringify({}), { status }));
            // The guest's own page one, which the signed-out feed asks for at
            // mount and merges under the cards drawn: answered when a test says.
            if (url.startsWith('/api/showcase/feed')) {
                return new Promise<Response>((resolve) => {
                    answerGuestPageOne = (page) => resolve(new Response(JSON.stringify(page), { status: 200 }));
                });
            }
            return new Promise(() => undefined);
        }));
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    async function failAndWaitForRemoval() {
        await act(async () => {
            fireEvent.click(screen.getByText('fail:archived-post'));
        });
        await waitFor(() => expect(screen.queryByTestId('card:archived-post')).not.toBeInTheDocument());
    }

    it('removes the card when its media is gone, asking the media address itself', async () => {
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        await failAndWaitForRemoval();

        expect(screen.getByTestId('card:live-post')).toBeInTheDocument();
        expect(fetch).toHaveBeenCalledWith(mediaUrl('archived-post'), expect.objectContaining({ redirect: 'manual' }));
    });

    it('keeps the card, to retry, when the media fails for another reason', async () => {
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        await act(async () => {
            fireEvent.click(screen.getByText('fail:live-post'));
        });

        expect(await screen.findByText('answer:live-post:retry')).toBeInTheDocument();
        expect(screen.getByTestId('card:live-post')).toBeInTheDocument();
        expect(screen.getByTestId('card:archived-post')).toBeInTheDocument();
    });

    it('keeps the post out when a page fetched afterwards brings it back', async () => {
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);
        await failAndWaitForRemoval();

        await act(async () => {
            answerGuestPageOne({ ...feed, items: [item('archived-post'), item('live-post'), item('new-post')] });
        });

        await waitFor(() => expect(screen.getByTestId('card:new-post')).toBeInTheDocument());
        expect(screen.queryByTestId('card:archived-post')).not.toBeInTheDocument();
    });

    // What is gone is the file the card held: a post its creator edited with
    // new media while the feed was open comes back with that media.
    it('lets the post back on a later page when it comes with other media', async () => {
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);
        await failAndWaitForRemoval();

        const edited = item('archived-post');
        edited.mediaItems = [{ ...edited.mediaItems![0]!, url: '/api/media?bucket=post_media&path=private-posts%2Farchived-post%2Fnew-photo.jpg' }];
        await act(async () => {
            answerGuestPageOne({ ...feed, items: [edited, item('live-post')] });
        });

        await waitFor(() => expect(screen.getByTestId('card:archived-post')).toBeInTheDocument());
    });

    it('keeps the post out for the rest of the visit, when the feed opens again with it', async () => {
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);
        await failAndWaitForRemoval();
        cleanup();

        // Back on Home: the page the feed opens with still names the post.
        render(<FeedClient initialFeed={feed} initialChipId="for-you" />);

        expect(screen.getByTestId('card:live-post')).toBeInTheDocument();
        expect(screen.queryByTestId('card:archived-post')).not.toBeInTheDocument();
    });
});
