import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageState = vi.hoisted(() => ({ values: new Map<string, string>() }));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storageState.values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storageState.values.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      storageState.values.delete(key);
    }),
  },
}));

import {
  clearComposerDraftsForUser,
  clearPersistedPostComposerDraft,
  getPostComposerDraftStorageId,
  isPostComposerDraftMeaningful,
  loadPersistedPostComposerDraft,
  persistPostComposerDraft,
} from '../lib/post-composer-draft-resume';
import { getDefaultPostComposerDraft } from '../lib/post-new-view-model';

describe('post composer draft recovery', () => {
  beforeEach(() => {
    storageState.values.clear();
  });

  it('scopes drafts to the user and target post or generation', () => {
    expect(getPostComposerDraftStorageId({ userId: 'user-1' })).toBe('user-1:new');
    expect(getPostComposerDraftStorageId({ userId: 'user-1', generationId: 'gen-1' })).toBe('user-1:generation:gen-1');
    expect(getPostComposerDraftStorageId({ userId: 'user-1', postId: 'post-1' })).toBe('user-1:edit:post-1');
  });

  it('persists, restores, and clears a meaningful draft', async () => {
    const storageId = getPostComposerDraftStorageId({ userId: 'user-1' });
    const draft = {
      ...getDefaultPostComposerDraft(),
      title: 'Recovered title',
      contentText: 'Recovered body',
    };

    await persistPostComposerDraft(storageId, { draft, step: 'resources' });
    expect(await loadPersistedPostComposerDraft(storageId)).toMatchObject({
      draft,
      step: 'resources',
    });

    await clearPersistedPostComposerDraft(storageId);
    expect(await loadPersistedPostComposerDraft(storageId)).toBeNull();
  });

  it('does not consider a blank composer meaningful', () => {
    expect(isPostComposerDraftMeaningful(getDefaultPostComposerDraft())).toBe(false);
    expect(isPostComposerDraftMeaningful({
      ...getDefaultPostComposerDraft(),
      title: 'Started post',
    })).toBe(true);
  });
});

describe('what a deleted account left in post drafts (audit 04-7)', () => {
  const STORE_KEY = 'magicbooklet.post.drafts.v1';

  beforeEach(() => {
    storageState.values.clear();
  });

  it("removes that account's drafts, new posts and edits alike, and keeps everyone else's", async () => {
    storageState.values.set(STORE_KEY, JSON.stringify({
      'user-1:new': { draft: {}, savedAt: 1 },
      'user-1:edit:post-1': { draft: {}, savedAt: 1 },
      'user-2:new': { draft: {}, savedAt: 1 },
    }));

    await clearComposerDraftsForUser('user-1');

    expect(Object.keys(JSON.parse(storageState.values.get(STORE_KEY)!))).toEqual(['user-2:new']);
  });

  it('removes the store once nothing is left in it', async () => {
    storageState.values.set(STORE_KEY, JSON.stringify({ 'user-1:new': { draft: {}, savedAt: 1 } }));

    await clearComposerDraftsForUser('user-1');

    expect(storageState.values.has(STORE_KEY)).toBe(false);
  });

  it('never fails the deletion over the drafts', async () => {
    storageState.values.set(STORE_KEY, 'not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(clearComposerDraftsForUser('user-1')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
