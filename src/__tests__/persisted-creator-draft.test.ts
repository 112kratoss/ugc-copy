import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = vi.hoisted(() => new Map<string, Map<string, unknown>>());

function getStore(name: string) {
  let store = stores.get(name);
  if (!store) {
    store = new Map<string, unknown>();
    stores.set(name, store);
  }
  return store;
}

vi.mock('localforage', () => ({
  default: {
    createInstance: ({ name }: { name: string }) => {
      const store = getStore(name);
      return {
        async getItem<T>(key: string) {
          return (store.get(key) as T | null | undefined) ?? null;
        },
        async setItem<T>(key: string, value: T) {
          store.set(key, value);
          return value;
        },
        async removeItem(key: string) {
          store.delete(key);
        },
        async dropInstance() {},
      };
    },
  },
}));

type ImageDraft = { prompt: string; modelId: string; aspectRatio: string };

const draft: ImageDraft = { prompt: 'A red fox at dawn', modelId: 'nano-banana-2', aspectRatio: '4:5' };

describe('persisted creator drafts', () => {
  beforeEach(() => {
    stores.clear();
    vi.resetModules();
  });

  it('restores the text draft a reload or a top-up round trip used to lose', async () => {
    const { loadCreatorDraft, saveCreatorDraft } = await import('@/lib/persisted-creator-draft');

    await saveCreatorDraft('image', 'user-1', draft);

    expect(await loadCreatorDraft<ImageDraft>('image', 'user-1')).toEqual(draft);
    const stored = getStore('magicbooklet-persisted-media').get('creator-draft:image:user-1');
    expect(stored).toMatchObject({ version: 1, draft });
    expect(Date.parse((stored as { savedAt: string }).savedAt)).not.toBeNaN();
  });

  it('keeps each tool and each account apart', async () => {
    const { loadCreatorDraft, saveCreatorDraft } = await import('@/lib/persisted-creator-draft');

    await saveCreatorDraft('image', 'user-1', draft);
    await saveCreatorDraft('video', 'user-1', { prompt: 'A drone shot', isMultiShot: false });

    expect(await loadCreatorDraft('image', 'user-2')).toBeNull();
    expect(await loadCreatorDraft('motion', 'user-1')).toBeNull();
    expect(await loadCreatorDraft('video', 'user-1')).toEqual({ prompt: 'A drone shot', isMultiShot: false });
  });

  it('clears one tool, or every tool for an account', async () => {
    const { clearCreatorDraft, clearCreatorDraftsForUser, loadCreatorDraft, saveCreatorDraft } = await import('@/lib/persisted-creator-draft');
    for (const tool of ['image', 'video', 'motion'] as const) {
      await saveCreatorDraft(tool, 'user-1', { prompt: tool });
      await saveCreatorDraft(tool, 'user-2', { prompt: tool });
    }

    await clearCreatorDraft('video', 'user-1');
    expect(await loadCreatorDraft('video', 'user-1')).toBeNull();
    expect(await loadCreatorDraft('image', 'user-1')).toEqual({ prompt: 'image' });

    await clearCreatorDraftsForUser('user-1');
    for (const tool of ['image', 'video', 'motion'] as const) {
      expect(await loadCreatorDraft(tool, 'user-1')).toBeNull();
      expect(await loadCreatorDraft(tool, 'user-2')).toEqual({ prompt: tool });
    }
  });

  it('is cleared with the rest of an account\'s creator data at sign-out', async () => {
    const { loadCreatorDraft, saveCreatorDraft } = await import('@/lib/persisted-creator-draft');
    const { clearPersistedCreatorData } = await import('@/lib/persisted-media');
    await saveCreatorDraft('motion', 'user-1', { prompt: 'Spin' });

    await clearPersistedCreatorData('user-1');

    expect(await loadCreatorDraft('motion', 'user-1')).toBeNull();
  });

  it('ignores a record of another version and leaves it in place', async () => {
    getStore('magicbooklet-persisted-media').set('creator-draft:image:user-1', { version: 2, savedAt: 'x', draft });
    const { loadCreatorDraft } = await import('@/lib/persisted-creator-draft');

    expect(await loadCreatorDraft('image', 'user-1')).toBeNull();
    expect(getStore('magicbooklet-persisted-media').has('creator-draft:image:user-1')).toBe(true);
  });

  it('refuses to save a draft for no account', async () => {
    const { saveCreatorDraft } = await import('@/lib/persisted-creator-draft');

    await expect(saveCreatorDraft('image', '', draft)).rejects.toThrow();
    expect(getStore('magicbooklet-persisted-media').size).toBe(0);
  });
});
