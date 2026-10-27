import { beforeEach, describe, expect, it, vi } from 'vitest';

const { permanentRedirectMock } = vi.hoisted(() => ({
    permanentRedirectMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
    permanentRedirect: (url: string) => permanentRedirectMock(url),
}));

import FeedPage from '@/app/feed/page';

// /feed drew Home's feed again, and nothing in the app linked to it any more.
describe('the old /feed address', () => {
    beforeEach(() => {
        permanentRedirectMock.mockReset();
    });

    it('goes to Home', async () => {
        await FeedPage({ searchParams: Promise.resolve({}) });

        expect(permanentRedirectMock).toHaveBeenCalledWith('/');
    });

    it('keeps the lane it named', async () => {
        await FeedPage({ searchParams: Promise.resolve({ chip: 'notes' }) });

        expect(permanentRedirectMock).toHaveBeenCalledWith('/?chip=notes');
    });

    it('reads only the first of a repeated lane', async () => {
        await FeedPage({ searchParams: Promise.resolve({ chip: ['recent', 'notes'] }) });

        expect(permanentRedirectMock).toHaveBeenCalledWith('/?chip=recent');
    });
});
