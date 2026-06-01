import localforage from 'localforage';

const persistedMediaStore = localforage.createInstance({
  name: 'magicbooklet-persisted-media',
});

const legacyPersistedMediaStore = localforage.createInstance({
  name: 'emptybooklet-persisted-media',
});

const legacyUgcCopyPersistedMediaStore = localforage.createInstance({
  name: 'ugc-copy-persisted-media',
});

interface StoredMediaFile {
  file: Blob;
  name: string;
  type: string;
  lastModified: number;
}

export interface PersistedImageElementRecord {
  id: string;
  displayName: string;
  file: File;
}

export interface PersistedMediaRecord {
  id: string;
  displayName: string;
  file: File;
  durationSeconds: number | null;
}

interface StoredImageElementRecord {
  id: string;
  displayName: string;
  file: StoredMediaFile | File | Blob;
}

interface StoredMediaRecord {
  id: string;
  displayName: string;
  durationSeconds?: number | null;
  file: StoredMediaFile | File | Blob;
}

export const PERSISTED_MEDIA_KEYS = {
  createMotionCharacterImage: 'create-motion:character-image',
  createMotionReferenceVideo: 'create-motion:reference-video',
  createImageElements: 'create-image:elements',
  createVideoElements: 'create-video:elements',
  createVideoReferenceMode: 'create-video:reference-mode',
  createImageReferences: 'create-image:reference-images',
  createImageElementDrafts: 'create-image:element-drafts',
  createVideoStartImage: 'create-video:start-image',
  createVideoEndImage: 'create-video:end-image',
  createVideoReferenceVideos: 'create-video:reference-videos',
  createVideoReferenceAudios: 'create-video:reference-audios',
  createVideoKlingVideoElements: 'create-video:kling-video-elements',
  createVideoSeedanceAssets: 'create-video:seedance-assets',
} as const;

function getFallbackExtension(type: string | undefined): string {
  const rawExtension = type?.split('/')[1]?.split(';')[0];
  return rawExtension && rawExtension.length > 0 ? rawExtension : 'bin';
}

function isStoredMediaFile(value: unknown): value is StoredMediaFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'file' in value &&
    value.file instanceof Blob
  );
}

function isStoredImageElementRecord(value: unknown): value is StoredImageElementRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'displayName' in value &&
    typeof value.displayName === 'string' &&
    'file' in value
  );
}

function isStoredMediaRecord(value: unknown): value is StoredMediaRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'displayName' in value &&
    typeof value.displayName === 'string' &&
    'file' in value
  );
}

function toStoredMediaFile(file: File): StoredMediaFile {
  return {
    file,
    name: file.name,
    type: file.type,
    lastModified: file.lastModified,
  };
}

function restoreFile(value: unknown, fallbackBaseName: string): File | null {
  if (value instanceof File) {
    return value;
  }

  if (isStoredMediaFile(value)) {
    return new File([value.file], value.name, {
      type: value.type || value.file.type,
      lastModified: value.lastModified,
    });
  }

  if (value instanceof Blob) {
    return new File([value], `${fallbackBaseName}.${getFallbackExtension(value.type)}`, {
      type: value.type,
      lastModified: Date.now(),
    });
  }

  return null;
}

async function getPersistedItem<T>(key: string): Promise<T | null> {
  const value = await persistedMediaStore.getItem<T | null>(key);
  if (value !== null && value !== undefined) {
    return value;
  }

  const legacyValue = await legacyPersistedMediaStore.getItem<T | null>(key);
  if (legacyValue !== null && legacyValue !== undefined) {
    return legacyValue;
  }

  return legacyUgcCopyPersistedMediaStore.getItem<T | null>(key);
}

async function removePersistedItem(key: string): Promise<void> {
  await Promise.all([
    persistedMediaStore.removeItem(key),
    legacyPersistedMediaStore.removeItem(key),
    legacyUgcCopyPersistedMediaStore.removeItem(key),
  ]);
}

export async function getPersistedFile(key: string): Promise<File | null> {
  const value = await getPersistedItem<StoredMediaFile | File | Blob>(key);
  return restoreFile(value, key);
}

export async function setPersistedFile(key: string, file: File): Promise<void> {
  await persistedMediaStore.setItem(key, toStoredMediaFile(file));
}

export async function getPersistedImageElementRecords(key: string): Promise<PersistedImageElementRecord[]> {
  const value = await getPersistedItem<StoredImageElementRecord[]>(key);
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index) => {
      if (!isStoredImageElementRecord(item)) {
        return null;
      }

      const restoredFile = restoreFile(item.file, `${key}-${index + 1}`);
      if (!restoredFile) {
        return null;
      }

      return {
        id: item.id,
        displayName: item.displayName,
        file: restoredFile,
      } satisfies PersistedImageElementRecord;
    })
    .filter((item): item is PersistedImageElementRecord => item !== null);
}

export async function setPersistedImageElementRecords(
  key: string,
  elements: PersistedImageElementRecord[]
): Promise<void> {
  if (elements.length === 0) {
    await removePersistedItem(key);
    return;
  }

  await persistedMediaStore.setItem(
    key,
    elements.map((element) => ({
      id: element.id,
      displayName: element.displayName,
      file: toStoredMediaFile(element.file),
    }))
  );
}

export async function getPersistedMediaRecords(key: string): Promise<PersistedMediaRecord[]> {
  const value = await getPersistedItem<StoredMediaRecord[]>(key);
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index) => {
      if (!isStoredMediaRecord(item)) {
        return null;
      }

      const restoredFile = restoreFile(item.file, `${key}-${index + 1}`);
      if (!restoredFile) {
        return null;
      }

      return {
        id: item.id,
        displayName: item.displayName,
        durationSeconds: typeof item.durationSeconds === 'number' ? item.durationSeconds : null,
        file: restoredFile,
      } satisfies PersistedMediaRecord;
    })
    .filter((item): item is PersistedMediaRecord => item !== null);
}

export async function setPersistedMediaRecords(
  key: string,
  records: PersistedMediaRecord[]
): Promise<void> {
  if (records.length === 0) {
    await removePersistedItem(key);
    return;
  }

  await persistedMediaStore.setItem(
    key,
    records.map((record) => ({
      id: record.id,
      displayName: record.displayName,
      durationSeconds: typeof record.durationSeconds === 'number' ? record.durationSeconds : null,
      file: toStoredMediaFile(record.file),
    }))
  );
}

export async function getPersistedFiles(key: string): Promise<File[]> {
  const value = await persistedMediaStore.getItem<Array<StoredMediaFile | File | Blob> | null>(key);
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => restoreFile(item, `${key}-${index + 1}`))
    .filter((item): item is File => item !== null);
}

export async function removePersistedMedia(key: string): Promise<void> {
  await persistedMediaStore.removeItem(key);
}

export async function getPersistedValue<T>(key: string): Promise<T | null> {
  const value = await persistedMediaStore.getItem<T | null>(key);
  return value ?? null;
}

export async function setPersistedValue<T>(key: string, value: T | null): Promise<void> {
  if (
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0)
  ) {
    await persistedMediaStore.removeItem(key);
    return;
  }

  await persistedMediaStore.setItem(key, value);
}
