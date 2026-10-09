import { describe, expect, it } from 'vitest';

import { FEED_CHIPS, getFeedChip } from '@/lib/post-feed-chips';

describe('feed lanes', () => {
    it('offers the same four lanes as the app, in the same order', () => {
        // ugc-mobile/lib/home-feed-view-model.ts HOME_FEED_CHIPS
        expect(FEED_CHIPS.map((chip) => chip.id)).toEqual(['for-you', 'notes', 'recent', 'unlocks']);
    });

    it('reads Notes as the text lane of the same ranked feed', () => {
        const notes = getFeedChip('notes');
        expect(notes.category).toBe('text');
        expect(notes.sort).toBe('for-you');
        expect(notes.unlock).toBe('all');
    });

    it('keeps the other lanes on every category', () => {
        expect(getFeedChip('for-you').category).toBe('all');
        expect(getFeedChip('recent').category).toBe('all');
        expect(getFeedChip('unlocks').category).toBe('all');
        expect(getFeedChip('nonsense').id).toBe('for-you');
    });
});
