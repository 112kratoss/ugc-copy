import { beforeEach, describe, expect, it, vi } from 'vitest';

type LocalforageInstance = {
  getItem: <T>(key: string) => Promise<T | null>;
  setItem: <T>(key: string, value: T) => Promise<T>;
  removeItem: (key: string) => Promise<void>;
};

const stores = new Map<string, Map<string, unknown>>();

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
    createInstance: ({ name }: { name: string }): LocalforageInstance => {
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
      };
    },
  },
}));

describe('persisted media storage namespaces', () => {
  beforeEach(() => {
    stores.clear();
    vi.resetModules();
  });

  it('reads persisted files from the legacy emptybooklet namespace', async () => {
    getStore('emptybooklet-persisted-media').set('demo-file', {
      file: new Blob(['legacy-emptybooklet'], { type: 'image/png' }),
      name: 'legacy-emptybooklet.png',
      type: 'image/png',
      lastModified: 42,
    });

    const { getPersistedFile } = await import('@/lib/persisted-media');
    const file = await getPersistedFile('demo-file');

    expect(file).not.toBeNull();
    expect(file?.name).toBe('legacy-emptybooklet.png');
    expect(await file?.text()).toBe('legacy-emptybooklet');
  });

  it('reads persisted files from the legacy ugc-copy namespace', async () => {
    getStore('ugc-copy-persisted-media').set('demo-file', {
      file: new Blob(['legacy-ugc-copy'], { type: 'image/png' }),
      name: 'legacy-ugc-copy.png',
      type: 'image/png',
      lastModified: 84,
    });

    const { getPersistedFile } = await import('@/lib/persisted-media');
    const file = await getPersistedFile('demo-file');

    expect(file).not.toBeNull();
    expect(file?.name).toBe('legacy-ugc-copy.png');
    expect(await file?.text()).toBe('legacy-ugc-copy');
  });

  it('writes new persisted files only to the magicbooklet namespace', async () => {
    const { setPersistedFile } = await import('@/lib/persisted-media');
    const file = new File(['fresh-file'], 'fresh-file.png', {
      type: 'image/png',
      lastModified: 128,
    });

    await setPersistedFile('demo-file', file);

    expect(getStore('magicbooklet-persisted-media').has('demo-file')).toBe(true);
    expect(getStore('emptybooklet-persisted-media').has('demo-file')).toBe(false);
    expect(getStore('ugc-copy-persisted-media').has('demo-file')).toBe(false);
  });
});
