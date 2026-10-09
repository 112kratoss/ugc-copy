import type { ShowcaseCategory, ShowcaseSort, ShowcaseUnlockFilter } from '@/lib/showcase';

/**
 * The feed's lanes. Deliberately the same four the mobile home feed offers
 * (`ugc-mobile/lib/home-feed-view-model.ts`), mapped onto feed params the
 * showcase API already supports so no new server surface is needed.
 */
export type FeedChipId = 'for-you' | 'notes' | 'recent' | 'unlocks';

export interface FeedChip {
    id: FeedChipId;
    label: string;
    sort: ShowcaseSort;
    unlock: ShowcaseUnlockFilter;
    /** `text` returns posts with writing: text-only and mixed ones. */
    category: ShowcaseCategory;
}

export const FEED_PAGE_SIZE = 12;

export const FEED_CHIPS: FeedChip[] = [
    { id: 'for-you', label: 'For you', sort: 'for-you', unlock: 'all', category: 'all' },
    { id: 'notes', label: 'Notes', sort: 'for-you', unlock: 'all', category: 'text' },
    { id: 'recent', label: 'Recent', sort: 'recent', unlock: 'all', category: 'all' },
    { id: 'unlocks', label: 'Unlocks', sort: 'for-you', unlock: 'with-unlock', category: 'all' },
];

export function getFeedChip(id: string | null | undefined): FeedChip {
    return FEED_CHIPS.find((chip) => chip.id === id) ?? FEED_CHIPS[0];
}
