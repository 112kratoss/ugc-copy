import { beforeEach, describe, expect, it, vi } from 'vitest';

type LocalforageInstance = {
  getItem: <T>(key: string) => Promise<T | null>;
  setItem: <T>(key: string, value: T) => Promise<T>;
  removeItem: (key: string) => Promise<void>;
  dropInstance: (options: { name: string }) => Promise<void>;
};

const stores = new Map<string, Map<string, unknown>>();
const droppedDatabases: string[] = [];

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
        async dropInstance({ name: databaseName }: { name: string }) {
          droppedDatabases.push(databaseName);
          stores.delete(databaseName);
        },
      };
    },
  },
}));

describe('persisted media storage namespaces', () => {
  beforeEach(() => {
    stores.clear();
    droppedDatabases.length = 0;
    vi.resetModules();
  });

  const storedFile = (text: string) => ({
    file: new Blob([text], { type: 'image/png' }),
    name: `${text}.png`,
    type: 'image/png',
    lastModified: 42,
  });

  it('no longer reads the databases of the earlier product names', async () => {
    // They hold files saved for no particular account.
    getStore('emptybooklet-persisted-media').set('demo-file', storedFile('legacy-emptybooklet'));
    getStore('ugc-copy-persisted-media').set('demo-file', storedFile('legacy-ugc-copy'));

    const { getPersistedFile } = await import('@/lib/persisted-media');

    expect(await getPersistedFile('demo-file')).toBeNull();
  });

  it('does not bring a cleared file back from an earlier database', async () => {
    getStore('magicbooklet-persisted-media').set('create-video:start-image:user-1', storedFile('current'));
    getStore('emptybooklet-persisted-media').set('create-video:start-image:user-1', storedFile('legacy'));

    const { getPersistedFile, removePersistedMedia } = await import('@/lib/persisted-media');
    await removePersistedMedia('create-video:start-image:user-1');

    expect(await getPersistedFile('create-video:start-image:user-1')).toBeNull();
  });

  it('keys each creator file to the account that saved it', async () => {
    const { PERSISTED_MEDIA_KEYS, getPersistedFile, scopedPersistedMediaKey, setPersistedFile } = await import('@/lib/persisted-media');
    const key = PERSISTED_MEDIA_KEYS.createMotionCharacterImage;

    expect(scopedPersistedMediaKey(key, 'user-1')).toBe('create-motion:character-image:user-1');
    expect(() => scopedPersistedMediaKey(key, '')).toThrow();

    await setPersistedFile(scopedPersistedMediaKey(key, 'user-1'), new File(['mine'], 'mine.png', { type: 'image/png' }));
    expect(await getPersistedFile(scopedPersistedMediaKey(key, 'user-2'))).toBeNull();
    expect(await (await getPersistedFile(scopedPersistedMediaKey(key, 'user-1')))?.text()).toBe('mine');
  });

  it('purges what was saved before media was kept per account, once per page', async () => {
    const current = getStore('magicbooklet-persisted-media');
    current.set('create-image:elements', [{ id: 'old', displayName: 'Old', file: storedFile('old') }]);
    current.set('create-image:reference-images', [storedFile('older')]);
    current.set('create-video:seedance-assets', { image: [] });
    current.set('create-image:elements:user-1', [{ id: 'kept', displayName: 'Kept', file: storedFile('kept') }]);
    current.set('creator-draft:image:user-1', { version: 1, savedAt: '2026-10-13T00:00:00.000Z', draft: { prompt: 'kept' } });
    getStore('emptybooklet-persisted-media').set('demo-file', storedFile('legacy'));

    const { PERSISTED_MEDIA_KEYS, purgeLegacyPersistedMedia } = await import('@/lib/persisted-media');
    await purgeLegacyPersistedMedia();

    for (const key of Object.values(PERSISTED_MEDIA_KEYS)) {
      expect(current.has(key), key).toBe(false);
    }
    expect(current.has('create-image:elements:user-1')).toBe(true);
    expect(current.has('creator-draft:image:user-1')).toBe(true);
    expect(droppedDatabases.sort()).toEqual(['emptybooklet-persisted-media', 'ugc-copy-persisted-media']);

    await purgeLegacyPersistedMedia();
    expect(droppedDatabases).toHaveLength(2);
  });

  it('clears one account\'s media and drafts and leaves every other account\'s', async () => {
    const current = getStore('magicbooklet-persisted-media');
    const { PERSISTED_MEDIA_KEYS, clearPersistedCreatorData, scopedPersistedMediaKey } = await import('@/lib/persisted-media');
    for (const key of Object.values(PERSISTED_MEDIA_KEYS)) {
      current.set(scopedPersistedMediaKey(key, 'user-1'), [storedFile('mine')]);
      current.set(scopedPersistedMediaKey(key, 'user-2'), [storedFile('theirs')]);
    }
    for (const tool of ['image', 'video', 'motion']) {
      current.set(`creator-draft:${tool}:user-1`, { version: 1, savedAt: '2026-10-13T00:00:00.000Z', draft: {} });
      current.set(`creator-draft:${tool}:user-2`, { version: 1, savedAt: '2026-10-13T00:00:00.000Z', draft: {} });
    }

    await clearPersistedCreatorData('user-1');

    expect([...current.keys()].filter((key) => key.endsWith(':user-1'))).toEqual([]);
    expect([...current.keys()].filter((key) => key.endsWith(':user-2'))).toHaveLength(
      Object.values(PERSISTED_MEDIA_KEYS).length + 3,
    );
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

  it('round-trips a named subject with the handle the prompt mentions it by', async () => {
    const { getPersistedSubjectRecords, setPersistedSubjectRecords } = await import('@/lib/persisted-media');

    // Not the handle its name would give: the subject of the same name before it
    // was renamed or removed, and this one kept the handle the prompt already uses.
    await setPersistedSubjectRecords('create-video:kling-subjects', [{
      id: 'subject-2',
      displayName: 'Hero',
      handle: '@hero_2',
      images: [
        { id: 'image-1', file: new File(['front'], 'front.png', { type: 'image/png', lastModified: 1 }) },
        { id: 'image-2', file: new File(['side'], 'side.png', { type: 'image/png', lastModified: 2 }) },
      ],
    }]);

    const restored = await getPersistedSubjectRecords('create-video:kling-subjects');
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: 'subject-2', displayName: 'Hero', handle: '@hero_2' });
    expect(restored[0].images.map((image) => image.file.name)).toEqual(['front.png', 'side.png']);
  });

  it('restores a subject saved before handles were kept with no handle', async () => {
    // What the page wrote until 2026-10: an id, a name and the images. The video
    // creator builds the handle of such a subject from its name.
    getStore('magicbooklet-persisted-media').set('create-video:kling-subjects', [{
      id: 'subject-1',
      displayName: 'Hero creator',
      images: [
        { id: 'image-1', file: { file: new Blob(['front'], { type: 'image/png' }), name: 'front.png', type: 'image/png', lastModified: 1 } },
        { id: 'image-2', file: { file: new Blob(['side'], { type: 'image/png' }), name: 'side.png', type: 'image/png', lastModified: 2 } },
      ],
    }]);

    const { getPersistedSubjectRecords } = await import('@/lib/persisted-media');
    const restored = await getPersistedSubjectRecords('create-video:kling-subjects');

    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: 'subject-1', displayName: 'Hero creator', handle: null });
    expect(restored[0].images).toHaveLength(2);
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
