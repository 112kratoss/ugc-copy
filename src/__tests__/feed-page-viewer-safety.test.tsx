import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getShowcaseFeedPageMock, getServerAuthStateMock } = vi.hoisted(() => ({
    getShowcaseFeedPageMock: vi.fn(),
    getServerAuthStateMock: vi.fn(),
}));

vi.mock('@/lib/showcase-feed', () => ({
    getShowcaseFeedPage: (options: unknown) => getShowcaseFeedPageMock(options),
}));

vi.mock('@/lib/supabase-server', () => ({
    getServerAuthState: () => getServerAuthStateMock(),
}));

vi.mock('@/app/feed/FeedClient', () => ({
    default: () => null,
}));

import FeedPage from '@/app/feed/page';

describe('feed page viewer safety', () => {
    beforeEach(() => {
        getShowcaseFeedPageMock.mockReset();
        getServerAuthStateMock.mockReset();
        getShowcaseFeedPageMock.mockResolvedValue({
            items: [],
            pageInfo: {
                hasMore: false,
                nextOffset: null,
                limit: 12,
                offset: 0,
            },
        });
    });

    it('applies the authenticated viewer to the initial server feed page', async () => {
        getServerAuthStateMock.mockResolvedValue({
            session: { user: { id: 'viewer-1' } },
            credits: 0,
        });

        await FeedPage({ searchParams: Promise.resolve({ chip: 'recent' }) });

        expect(getShowcaseFeedPageMock).toHaveBeenCalledWith(expect.objectContaining({
            sort: 'recent',
            viewerUserId: 'viewer-1',
        }));
    });

    it('keeps the anonymous feed viewer-neutral', async () => {
        getServerAuthStateMock.mockResolvedValue({
            session: null,
            credits: null,
        });

        await FeedPage({ searchParams: Promise.resolve({}) });

        expect(getShowcaseFeedPageMock).toHaveBeenCalledWith(expect.objectContaining({
            viewerUserId: null,
        }));
    });
});
