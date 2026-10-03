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

  it('round-trips an image element with the handle the prompt mentions it by', async () => {
    const { getPersistedImageElementRecords, setPersistedImageElementRecords } = await import('@/lib/persisted-media');

    // Not the handle its name would give: the creator renamed another element
    // of the same name, and this one kept the handle the prompt already uses.
    await setPersistedImageElementRecords('create-image:elements', [{
      id: 'element-1',
      displayName: 'Dancer',
      handle: '@dancer_2',
      file: new File(['dancer'], 'dancer.png', { type: 'image/png', lastModified: 1 }),
    }]);

    const restored = await getPersistedImageElementRecords('create-image:elements');
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: 'element-1', displayName: 'Dancer', handle: '@dancer_2' });
    expect(restored[0].file.name).toBe('dancer.png');
    expect(await restored[0].file.text()).toBe('dancer');
  });

  it('round-trips a Kling video element with its handle and length', async () => {
    const { getPersistedMediaRecords, setPersistedMediaRecords } = await import('@/lib/persisted-media');

    await setPersistedMediaRecords('create-video:kling-video-elements', [{
      id: 'clip-1',
      displayName: 'Dancer',
      handle: '@dancer_2',
      durationSeconds: 4.2,
      file: new File(['clip'], 'clip.mp4', { type: 'video/mp4', lastModified: 1 }),
    }]);

    const restored = await getPersistedMediaRecords('create-video:kling-video-elements');
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: 'clip-1', displayName: 'Dancer', handle: '@dancer_2', durationSeconds: 4.2 });
    expect(restored[0].file.name).toBe('clip.mp4');
  });

  it('restores an element saved before handles were kept with no handle', async () => {
    // What the page wrote until 2026-10: a name and a file. The creator pages
    // build the handle of such an element from its name, as a reload always did.
    const stored = [{
      id: 'element-1',
      displayName: 'Red jacket',
      file: { file: new Blob(['jacket'], { type: 'image/png' }), name: 'jacket.png', type: 'image/png', lastModified: 1 },
    }];
    getStore('magicbooklet-persisted-media').set('create-image:elements', stored);
    getStore('magicbooklet-persisted-media').set('create-video:kling-video-elements', stored);

    const { getPersistedImageElementRecords, getPersistedMediaRecords } = await import('@/lib/persisted-media');

    expect((await getPersistedImageElementRecords('create-image:elements'))[0])
      .toMatchObject({ displayName: 'Red jacket', handle: null });
    expect((await getPersistedMediaRecords('create-video:kling-video-elements'))[0])
      .toMatchObject({ displayName: 'Red jacket', handle: null, durationSeconds: null });
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
