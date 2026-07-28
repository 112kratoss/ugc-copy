import type { Metadata } from 'next';

import FeedClient from '@/app/feed/FeedClient';
import { createMetadata } from '@/lib/seo';
import { getShowcaseFeedPage } from '@/lib/showcase-feed';
import { FEED_PAGE_SIZE, getFeedChip } from '@/lib/post-feed-chips';
import { getServerAuthState } from '@/lib/supabase-server';

type FeedPageProps = {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = createMetadata({
    title: 'Feed',
    description:
        'A single-column feed of everything the magicbooklet community is posting — creator notes, prompts, images, videos, and unlockable recipes.',
    path: '/feed',
    keywords: ['AI creator feed', 'UGC community', 'AI prompt tips', 'creator notes'],
});

function getFirstValue(value: string | string[] | undefined) {
    return Array.isArray(value) ? value[0] : value;
}

export default async function FeedPage({ searchParams }: FeedPageProps) {
    const resolvedSearchParams = searchParams ? await searchParams : {};
    const chip = getFeedChip(getFirstValue(resolvedSearchParams.chip));
    const auth = await getServerAuthState();

    const initialFeed = await getShowcaseFeedPage({
        category: 'all',
        sort: chip.sort,
        unlock: chip.unlock,
        resource: 'all',
        offset: 0,
        limit: FEED_PAGE_SIZE,
        viewerUserId: auth.session?.user?.id ?? null,
        tool: null,
        countryCode: null,
    });

    return <FeedClient initialFeed={initialFeed} initialChipId={chip.id} />;
}
