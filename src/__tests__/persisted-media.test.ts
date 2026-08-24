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

  it('round-trips grouped named subjects with every image intact', async () => {
    const { getPersistedSubjectRecords, setPersistedSubjectRecords } = await import('@/lib/persisted-media');

    await setPersistedSubjectRecords('create-video:kling-subjects', [{
      id: 'subject-1',
      displayName: 'Hero creator',
      images: [
        { id: 'image-1', file: new File(['front'], 'front.png', { type: 'image/png', lastModified: 1 }) },
        { id: 'image-2', file: new File(['side'], 'side.png', { type: 'image/png', lastModified: 2 }) },
      ],
    }]);

    const restored = await getPersistedSubjectRecords('create-video:kling-subjects');
    expect(restored).toHaveLength(1);
    expect(restored[0].displayName).toBe('Hero creator');
    expect(restored[0].images.map((image) => image.id)).toEqual(['image-1', 'image-2']);
    expect(restored[0].images.map((image) => image.file.name)).toEqual(['front.png', 'side.png']);
    expect(await restored[0].images[0].file.text()).toBe('front');
  });

  it('drops a subject whose images did not all survive rather than restoring it partially', async () => {
    // A subject is one identity fused from the whole set, so a half-restored
    // group would silently depict something the user never grouped.
    getStore('magicbooklet-persisted-media').set('create-video:kling-subjects', [{
      id: 'subject-1',
      displayName: 'Hero creator',
      images: [
        { id: 'image-1', file: { file: new Blob(['front'], { type: 'image/png' }), name: 'front.png', type: 'image/png', lastModified: 1 } },
        { id: 'image-2', file: null },
      ],
    }]);

    const { getPersistedSubjectRecords } = await import('@/lib/persisted-media');
    expect(await getPersistedSubjectRecords('create-video:kling-subjects')).toEqual([]);
  });

  it('clears the stored key when the last subject is removed', async () => {
    const { setPersistedSubjectRecords } = await import('@/lib/persisted-media');

    await setPersistedSubjectRecords('create-video:kling-subjects', [{
      id: 'subject-1',
      displayName: 'Hero creator',
      images: [{ id: 'image-1', file: new File(['front'], 'front.png', { type: 'image/png' }) }],
    }]);
    expect(getStore('magicbooklet-persisted-media').has('create-video:kling-subjects')).toBe(true);

    await setPersistedSubjectRecords('create-video:kling-subjects', []);
    expect(getStore('magicbooklet-persisted-media').has('create-video:kling-subjects')).toBe(false);
  });
});
