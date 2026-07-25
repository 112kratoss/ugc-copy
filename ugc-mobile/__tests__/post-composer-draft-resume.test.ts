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
