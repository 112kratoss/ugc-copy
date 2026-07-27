import type { ShowcaseSort, ShowcaseUnlockFilter } from '@/lib/showcase';

/**
 * The feed's lanes. Deliberately the same three the mobile home feed offers
 * (`ugc-mobile/lib/home-feed-view-model.ts`), mapped onto feed params the
 * showcase API already supports so no new server surface is needed.
 */
export type FeedChipId = 'for-you' | 'recent' | 'unlocks';

export interface FeedChip {
    id: FeedChipId;
    label: string;
    sort: ShowcaseSort;
    unlock: ShowcaseUnlockFilter;
}

export const FEED_PAGE_SIZE = 12;

export const FEED_CHIPS: FeedChip[] = [
    { id: 'for-you', label: 'For you', sort: 'for-you', unlock: 'all' },
    { id: 'recent', label: 'Recent', sort: 'recent', unlock: 'all' },
    { id: 'unlocks', label: 'Unlocks', sort: 'for-you', unlock: 'with-unlock' },
];

export function getFeedChip(id: string | null | undefined): FeedChip {
    return FEED_CHIPS.find((chip) => chip.id === id) ?? FEED_CHIPS[0];
}
