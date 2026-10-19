import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dismissToast, readFeedbackSnapshot, resetFeedbackState, subscribeToFeedback } from '@/components/feedback-state';
import { SAVER_NOTICE_MESSAGE, resetSaverNoticeForTests } from '@/components/saver-notice';
import { useOptimisticPostSave } from '@/components/useOptimisticPostSave';

// The account signed in, and what the page has read of its saver notice
// record (`AuthProvider`): nobody, and no record, unless a case is about it.
const auth = vi.hoisted(() => ({
    user: null as { id: string } | null,
    session: null as { access_token: string } | null,
    saverNoticeRecord: null as { userId: string; seen: boolean } | null,
}));
vi.mock('@/components/AuthProvider', () => ({
    useAuth: () => auth,
}));

/** Signs `userId` in, as the hook's own `useAuth()` reads it. */
function signIn(userId: string) {
    auth.user = { id: userId };
    auth.session = { access_token: 'token' };
}

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

type SaveBody = { postId: string; shouldSave: boolean; sourceSurface: string };
type SaveAnswer = { ok: boolean; json: () => Promise<unknown> };

/** Every save POST waits for the test to answer it; the saved-state read answers at once. */
function stubSaveRequests() {
    const saves: Array<{
        body: SaveBody;
        resolve: (answer: SaveAnswer) => void;
        reject: (error: unknown) => void;
    }> = [];
    vi.stubGlobal('fetch', vi.fn((input: unknown, init?: RequestInit) => {
        if (String(input).startsWith('/api/showcase/saved-state')) {
            return Promise.resolve({ ok: true, json: async () => [] });
        }
        if (String(input) === '/api/profile/saver-notice') {
            return Promise.resolve({ ok: true, json: async () => ({ seen: false }) });
        }
        return new Promise<SaveAnswer>((resolve, reject) => {
            saves.push({ body: JSON.parse(String(init?.body)) as SaveBody, resolve, reject });
        });
    }));
    return saves;
}

function serverHolds(isSaved: boolean, saveCount: number): SaveAnswer {
    return { ok: true, json: async () => ({ success: true, isSaved, saveCount }) };
}

async function renderSignedInSaveHook(onSuccess = vi.fn()) {
    const onError = vi.fn();
    const hook = renderHook(() => useOptimisticPostSave<Post>({
        initialItems,
        accessToken: 'token',
        isSignedIn: true,
        onAuthRequired: vi.fn(),
        onError,
        onSuccess,
        sourceSurface: 'feed',
    }));
    // The saved-state read on mount.
    await act(async () => {});
    const tap = (id: string, sourceSurface?: string) => act(() => {
        void hook.result.current.toggleSave(id, sourceSurface);
    });
    const heart = (id: string) => hook.result.current.savedItemIds.has(id);
    const count = (id: string) => hook.result.current.items.find((item) => item.id === id)?.saveCount;
    return { ...hook, onError, onSuccess, tap, heart, count };
}

// The app's heart takes every tap: it flips at once, and the requests catch up
// behind it. The web's used to lock for the whole round trip.
describe('useOptimisticPostSave, tapped faster than the server answers', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('flips the heart on every tap, with one request on the wire at a time', async () => {
        const saves = stubSaveRequests();
        const { tap, heart, count } = await renderSignedInSaveHook();

        tap('post-2');
        expect([heart('post-2'), count('post-2')]).toEqual([true, 1]);
        tap('post-2');
        expect([heart('post-2'), count('post-2')]).toEqual([false, 0]);
        tap('post-2');
        expect([heart('post-2'), count('post-2')]).toEqual([true, 1]);

        expect(saves).toHaveLength(1);
        expect(saves[0].body).toMatchObject({ postId: 'post-2', shouldSave: true });
    });

    it('sends the newest tap once the wire clears, and settles on what the server then holds', async () => {
        const saves = stubSaveRequests();
        const { tap, heart, count, onSuccess, onError } = await renderSignedInSaveHook();

        tap('post-2');
        tap('post-2', 'showcase-reel');
        await act(async () => saves[0].resolve(serverHolds(true, 1)));

        // The answer to a tap already taken back does not flick the heart.
        expect(heart('post-2')).toBe(false);
        expect(saves).toHaveLength(2);
        expect(saves[1].body).toEqual({ postId: 'post-2', shouldSave: false, sourceSurface: 'showcase-reel' });

        await act(async () => saves[1].resolve(serverHolds(false, 4)));

        expect([heart('post-2'), count('post-2')]).toEqual([false, 4]);
        expect(saves).toHaveLength(2);
        // Saved and taken back: nothing changed for the ranker or a saved total.
        expect(onSuccess).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
    });

    it('sends nothing more when the taps end where the first one asked, and reports that once', async () => {
        const saves = stubSaveRequests();
        const { tap, heart, count, onSuccess } = await renderSignedInSaveHook();

        tap('post-2');
        tap('post-2');
        tap('post-2');
        await act(async () => saves[0].resolve(serverHolds(true, 5)));

        expect(saves).toHaveLength(1);
        // Someone else saved it meanwhile: the count is the server's.
        expect([heart('post-2'), count('post-2')]).toEqual([true, 5]);
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(onSuccess).toHaveBeenCalledWith({ id: 'post-2', isSaved: true, sourceSurface: 'feed' });

        // A settled post starts over on the next tap.
        tap('post-2');
        expect(saves).toHaveLength(2);
        expect(saves[1].body).toMatchObject({ postId: 'post-2', shouldSave: false });
    });

    it('saves two posts side by side', async () => {
        const saves = stubSaveRequests();
        const { tap } = await renderSignedInSaveHook();

        tap('post-1');
        tap('post-2');

        expect(saves.map((save) => save.body)).toEqual([
            { postId: 'post-1', shouldSave: false, sourceSurface: 'feed' },
            { postId: 'post-2', shouldSave: true, sourceSurface: 'feed' },
        ]);
    });

    it('puts a failed save back as the server holds it, and says so once', async () => {
        const saves = stubSaveRequests();
        const { tap, heart, count, onError, onSuccess } = await renderSignedInSaveHook();

        tap('post-2');
        await act(async () => saves[0].resolve({ ok: false, json: async () => ({ error: 'Too many requests' }) }));

        expect([heart('post-2'), count('post-2')]).toEqual([false, 0]);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onSuccess).not.toHaveBeenCalled();
    });

    it('says nothing of a failure the viewer has already taken back', async () => {
        const saves = stubSaveRequests();
        const { tap, heart, count, onError } = await renderSignedInSaveHook();

        tap('post-2');
        tap('post-2');
        await act(async () => saves[0].reject(new TypeError('Failed to fetch')));

        expect([heart('post-2'), count('post-2')]).toEqual([false, 0]);
        expect(saves).toHaveLength(1);
        expect(onError).not.toHaveBeenCalled();
    });

    it('says a later request failed, after telling of the save the first one made', async () => {
        const saves = stubSaveRequests();
        const { tap, heart, count, onError, onSuccess } = await renderSignedInSaveHook();

        tap('post-2');
        tap('post-2');
        await act(async () => saves[0].resolve(serverHolds(true, 6)));
        await act(async () => saves[1].reject(new TypeError('Failed to fetch')));

        // The server holds the save, with the count it gave for it.
        expect([heart('post-2'), count('post-2')]).toEqual([true, 6]);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(onSuccess).toHaveBeenCalledWith({ id: 'post-2', isSaved: true, sourceSurface: 'feed' });
    });

    // The feed's save event is checked against the saved state when it lands,
    // so a later tap's request must not reach the server before it.
    it('sends a tap made while the save is being told only once that is done', async () => {
        const saves = stubSaveRequests();
        let doneTelling = () => {};
        const onSuccess = vi.fn()
            .mockImplementationOnce(() => new Promise<void>((resolve) => { doneTelling = resolve; }));
        const { tap, heart, count } = await renderSignedInSaveHook(onSuccess);

        tap('post-2');
        await act(async () => saves[0].resolve(serverHolds(true, 1)));
        expect(onSuccess).toHaveBeenCalledWith({ id: 'post-2', isSaved: true, sourceSurface: 'feed' });

        tap('post-2');
        expect([heart('post-2'), count('post-2')]).toEqual([false, 0]);
        expect(saves).toHaveLength(1);

        await act(async () => doneTelling());
        expect(saves).toHaveLength(2);
        expect(saves[1].body).toMatchObject({ postId: 'post-2', shouldSave: false });

        await act(async () => saves[1].resolve(serverHolds(false, 0)));
        expect(onSuccess).toHaveBeenCalledTimes(2);
        expect(onSuccess).toHaveBeenLastCalledWith({ id: 'post-2', isSaved: false, sourceSurface: 'feed' });
    });

    it('takes a tap from the heart the viewer sees, after something else drew it anew', async () => {
        const saves = stubSaveRequests();
        const { result, tap, heart } = await renderSignedInSaveHook();

        tap('post-2');
        // A lane change, or the saved-state read, draws the post unsaved meanwhile.
        act(() => result.current.setSavedItemIds(new Set()));
        tap('post-2');
        expect(heart('post-2')).toBe(true);

        await act(async () => saves[0].resolve(serverHolds(true, 1)));
        // That tap asked for the save the first request carried: nothing more to send.
        expect(saves).toHaveLength(1);
        expect(heart('post-2')).toBe(true);
    });

    it('keeps the same set and items when the answer agrees with what is drawn', async () => {
        const saves = stubSaveRequests();
        const { result, tap } = await renderSignedInSaveHook();

        tap('post-2');
        const drawn = { savedItemIds: result.current.savedItemIds, items: result.current.items };
        await act(async () => saves[0].resolve(serverHolds(true, 1)));

        expect(result.current.savedItemIds).toBe(drawn.savedItemIds);
        expect(result.current.items).toBe(drawn.items);
    });

    it('takes the answer when the server holds another state than asked, and does not ask again', async () => {
        const saves = stubSaveRequests();
        const { tap, heart, count, onError, onSuccess } = await renderSignedInSaveHook();

        tap('post-2');
        await act(async () => saves[0].resolve(serverHolds(false, 0)));

        expect(saves).toHaveLength(1);
        expect([heart('post-2'), count('post-2')]).toEqual([false, 0]);
        expect(onError).not.toHaveBeenCalled();
        expect(onSuccess).not.toHaveBeenCalled();
    });
});

// A save names its saver only if they were told before tapping. A tap made
// while an earlier request was out leaves later, after the notice may have
// gone: what it says about its saver is still the tap's.
describe('useOptimisticPostSave, telling who saved', () => {
    let unsubscribe = () => {};

    /** Every request made of the account's saver notice record. */
    const recordRequests = () => vi.mocked(fetch).mock.calls
        .filter(([input]) => String(input) === '/api/profile/saver-notice');

    afterEach(() => {
        unsubscribe();
        auth.user = null;
        auth.session = null;
        auth.saverNoticeRecord = null;
        resetFeedbackState();
        resetSaverNoticeForTests();
        window.localStorage.clear();
        vi.unstubAllGlobals();
    });

    it.each([true, false])('asks nothing of the record, and goes by the one the page read (%s)', async (seen) => {
        signIn('viewer-1');
        auth.saverNoticeRecord = { userId: 'viewer-1', seen };
        unsubscribe = subscribeToFeedback(() => {});
        const saves = stubSaveRequests();
        const { tap } = await renderSignedInSaveHook();

        await tap('post-2');

        expect(recordRequests()).toEqual([]);
        expect(saves.map(({ body }) => body)).toEqual([
            seen
                ? { postId: 'post-2', shouldSave: true, sourceSurface: 'feed', creatorSeesSaver: true }
                : { postId: 'post-2', shouldSave: true, sourceSurface: 'feed', saverNotYetTold: true },
        ]);
        expect(readFeedbackSnapshot().toasts.map((toast) => toast.message)).toEqual(seen ? [] : [SAVER_NOTICE_MESSAGE]);
    });

    // Review 4 finding #25: the account is the hook's own `useAuth()`'s, so its
    // record is never paired with another account's id.
    it("takes the signed-in account from the session, and no other account's record", async () => {
        signIn('viewer-1');
        auth.saverNoticeRecord = { userId: 'viewer-2', seen: true };
        unsubscribe = subscribeToFeedback(() => {});
        const saves = stubSaveRequests();
        const { tap, rerender } = await renderSignedInSaveHook();
        rerender();

        await tap('post-2');

        expect(recordRequests()).toEqual([]);
        expect(saves.map(({ body }) => body)).toEqual([
            { postId: 'post-2', shouldSave: true, sourceSurface: 'feed', saverNotYetTold: true },
        ]);
    });

    it('sends a save tapped before the notice went as one that tells the creator nothing', async () => {
        signIn('viewer-1');
        // The root layout's FeedbackViewport, which draws the notice.
        unsubscribe = subscribeToFeedback(() => {});
        const saves = stubSaveRequests();
        const { tap } = await renderSignedInSaveHook();

        // post-1 starts saved: the unsave goes out, and the save tapped while
        // it is out waits behind it, telling the viewer now.
        await tap('post-1');
        await tap('post-1');
        expect(readFeedbackSnapshot().toasts.map((toast) => toast.message)).toEqual([SAVER_NOTICE_MESSAGE]);

        // The notice goes before the unsave answers, and so before the save leaves.
        act(() => dismissToast(readFeedbackSnapshot().toasts[0].id, 'closed'));
        await act(async () => saves[0].resolve(serverHolds(false, 2)));

        // And a save tapped after the notice went may name them.
        await act(async () => saves[1].resolve(serverHolds(true, 3)));
        await tap('post-2');

        expect(saves.map(({ body }) => body)).toEqual([
            { postId: 'post-1', shouldSave: false, sourceSurface: 'feed' },
            { postId: 'post-1', shouldSave: true, sourceSurface: 'feed', saverNotYetTold: true },
            { postId: 'post-2', shouldSave: true, sourceSurface: 'feed', creatorSeesSaver: true },
        ]);
    });
});
