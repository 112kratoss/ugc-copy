import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useOptimisticPostSave } from '@/components/useOptimisticPostSave';

type Post = { id: string; isSaved?: boolean; saveCount: number };

// Stable across renders: the hook starts over whenever `initialItems` changes.
const initialItems: Post[] = [
    { id: 'post-1', isSaved: true, saveCount: 3 },
    { id: 'post-2', isSaved: false, saveCount: 0 },
];

function renderSaveHook() {
    return renderHook(() => useOptimisticPostSave<Post>({
        initialItems,
        accessToken: null,
        isSignedIn: false,
        onAuthRequired: vi.fn(),
        onError: vi.fn(),
        sourceSurface: 'feed',
    }));
}

describe('useOptimisticPostSave', () => {
    // A later page or another lane brings its own `isSaved`; the set was
    // derived from the first page alone, so a saved post there drew unsaved.
    it('adds the saved flags of posts that arrive after the first page', () => {
        const { result } = renderSaveHook();
        expect([...result.current.savedItemIds]).toEqual(['post-1']);

        act(() => result.current.addSavedItemIds(['post-7', 'post-9']));

        expect([...result.current.savedItemIds].sort()).toEqual(['post-1', 'post-7', 'post-9']);
        // The posts themselves are the caller's to add; nothing is reset.
        expect(result.current.items).toBe(initialItems);
    });

    it('keeps the same set when nothing new arrives, so nothing re-renders for it', () => {
        const { result } = renderSaveHook();
        const before = result.current.savedItemIds;

        act(() => {
            result.current.addSavedItemIds([]);
            result.current.addSavedItemIds(['post-1']);
        });

        expect(result.current.savedItemIds).toBe(before);
    });
});
