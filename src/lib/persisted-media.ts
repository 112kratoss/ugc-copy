import localforage from 'localforage';

const persistedMediaStore = localforage.createInstance({
  name: 'magicbooklet-persisted-media',
});

/**
 * Databases the creators wrote under the product's earlier names. Nothing reads
 * them any more: what they hold was saved for no particular account.
 */
const LEGACY_PERSISTED_MEDIA_DATABASES = ['emptybooklet-persisted-media', 'ugc-copy-persisted-media'] as const;

interface StoredMediaFile {
  file: Blob;
  name: string;
  type: string;
  lastModified: number;
}

export interface PersistedImageElementRecord {
  id: string;
  displayName: string;
  /**
   * The @handle the prompt mentions this element by, saved so a reload shows
   * the same one. Built again from the name it could differ, when two elements
   * share a name. Null on a record saved before handles were kept.
   */
  handle?: string | null;
  file: File;
  /** The copy a run staged in `uploads`, so a reload sends it again instead of uploading the file. */
  staged?: PersistedStagedUpload | null;
}

/** `uploadedAt` is epoch ms: the sweep reclaims a staged copy a fixed time after it was staged. */
export type PersistedStagedUpload = { storagePath: string; uploadedAt: number };

export interface PersistedMediaRecord {
  id: string;
  displayName: string;
  /** As on an image element. Only a Kling video element has one. */
  handle?: string | null;
  file: File;
  durationSeconds: number | null;
}

/**
 * A named multi-image subject (Kling O3): one identity backed by several
 * images. Grouped rather than flat because the provider fuses the whole set,
 * so a partially-restored subject would silently change what it depicts.
 */
export interface PersistedSubjectRecord {
  id: string;
  displayName: string;
  /** As on an image element. Null on a subject saved before handles were kept. */
  handle?: string | null;
  images: Array<{ id: string; file: File }>;
}

interface StoredImageElementRecord {
  id: string;
  displayName: string;
  handle?: string | null;
  file: StoredMediaFile | File | Blob;
  staged?: unknown;
}

function readStagedUpload(value: unknown): PersistedStagedUpload | null {
  const { storagePath, uploadedAt } = (value ?? {}) as Record<string, unknown>;
  return typeof storagePath === 'string' && storagePath && typeof uploadedAt === 'number' && Number.isFinite(uploadedAt)
    ? { storagePath, uploadedAt }
    : null;
}

interface StoredMediaRecord {
  id: string;
  displayName: string;
  handle?: string | null;
  durationSeconds?: number | null;
  file: StoredMediaFile | File | Blob;
}

interface StoredSubjectRecord {
  id: string;
  displayName: string;
  handle?: string | null;
  images: Array<{ id: string; file: StoredMediaFile | File | Blob }>;
}

export const PERSISTED_MEDIA_KEYS = {
  createMotionCharacterImage: 'create-motion:character-image',
  createMotionReferenceVideo: 'create-motion:reference-video',
  createImageElements: 'create-image:elements',
  createVideoElements: 'create-video:elements',
  createImageReferences: 'create-image:reference-images',
  createImageElementDrafts: 'create-image:element-drafts',
  createVideoStartImage: 'create-video:start-image',
  createVideoEndImage: 'create-video:end-image',
  createVideoReferenceVideos: 'create-video:reference-videos',
  createVideoReferenceAudios: 'create-video:reference-audios',
  createVideoKlingVideoElements: 'create-video:kling-video-elements',
  createVideoKlingSubjects: 'create-video:kling-subjects',
  createVideoSeedanceAssets: 'create-video:seedance-assets',
} as const;

/**
 * The key a creator saves its media under for one account. The unscoped keys
 * were shared by everyone who used the browser, so the next account to sign in
 * opened the last one's photos and clips and could send them with its own run.
 */
export function scopedPersistedMediaKey(key: string, userId: string): string {
  if (!userId) {
    throw new Error('Creator media is saved per account; a user id is required.');
  }
  return `${key}:${userId}`;
}

export const CREATOR_DRAFT_TOOLS = ['image', 'video', 'motion'] as const;
export type CreatorDraftTool = (typeof CREATOR_DRAFT_TOOLS)[number];

/** Where persisted-creator-draft.ts keeps a tool's text draft, defined here so clearing an account's data reaches it. */
export function creatorDraftStorageKey(tool: CreatorDraftTool, userId: string): string {
  if (!userId) {
    throw new Error('Creator drafts are saved per account; a user id is required.');
  }
  return `creator-draft:${tool}:${userId}`;
}

// Once per page: each creator calls the purge on mount, and dropping a database
// opens it first, so a second run would only open and delete an empty one again.
let legacyPurge: Promise<void> | null = null;

/**
 * Deletes what the creators saved before media was kept per account: every
 * unscoped key, and the two databases from the product's earlier names. A
 * browser that still holds them loses those staged files once.
 */
export function purgeLegacyPersistedMedia(): Promise<void> {
  legacyPurge ??= (async () => {
    for (const name of LEGACY_PERSISTED_MEDIA_DATABASES) {
      // Not awaited: deleting a database waits until every tab still holding it
      // open (one on an older build) lets go, and nothing here needs it gone first.
      void persistedMediaStore.dropInstance({ name }).catch(() => undefined);
    }
    await Promise.allSettled(
      Object.values(PERSISTED_MEDIA_KEYS).map((key) => persistedMediaStore.removeItem(key)),
    );
  })();
  return legacyPurge;
}

/** Everything the creators saved for one account: staged media and text drafts. */
export async function clearPersistedCreatorData(userId: string): Promise<void> {
  await Promise.all([
    ...Object.values(PERSISTED_MEDIA_KEYS).map((key) => (
      persistedMediaStore.removeItem(scopedPersistedMediaKey(key, userId))
    )),
    ...CREATOR_DRAFT_TOOLS.map((tool) => persistedMediaStore.removeItem(creatorDraftStorageKey(tool, userId))),
  ]);
}

/** The media keys one creator saves under, by the tool's own prefix ("create-video:…"). */
export function creatorToolMediaKeys(tool: CreatorDraftTool): string[] {
  return Object.values(PERSISTED_MEDIA_KEYS).filter((key) => key.startsWith(`create-${tool}:`));
}

/**
 * Moves what one creator saved for one owner to another: its text draft and its
 * staged media, as they are stored. A visitor's form goes to the account they
 * sign in to as a whole, so a key the visitor left empty empties the account's
 * too: a mix of the two would be a form neither of them saw. The source keys go
 * last, so a move cut short is done again from the start.
 */
export async function moveCreatorToolData(tool: CreatorDraftTool, fromOwner: string, toOwner: string): Promise<void> {
  const pairs = [
    [creatorDraftStorageKey(tool, fromOwner), creatorDraftStorageKey(tool, toOwner)],
    ...creatorToolMediaKeys(tool).map((key) => [scopedPersistedMediaKey(key, fromOwner), scopedPersistedMediaKey(key, toOwner)]),
  ];
  for (const [from, to] of pairs) {
    const value = await persistedMediaStore.getItem<unknown>(from);
    if (value === null) {
      await persistedMediaStore.removeItem(to);
    } else {
      await persistedMediaStore.setItem(to, value);
    }
  }
  await Promise.all(pairs.map(([from]) => persistedMediaStore.removeItem(from)));
}

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

function isStoredSubjectRecord(value: unknown): value is StoredSubjectRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'displayName' in value &&
    typeof value.displayName === 'string' &&
    'images' in value &&
    Array.isArray(value.images)
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
  return value ?? null;
}

// The one store is every namespace there is: a cleared file has nowhere left
// to come back from.
async function removePersistedItem(key: string): Promise<void> {
  await persistedMediaStore.removeItem(key);
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
    .map((item, index): PersistedImageElementRecord | null => {
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
        handle: typeof item.handle === 'string' ? item.handle : null,
        file: restoredFile,
        staged: readStagedUpload(item.staged),
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
      handle: element.handle ?? null,
      file: toStoredMediaFile(element.file),
      // A signed link expires; a later run renews one from the path.
      staged: element.staged ? { storagePath: element.staged.storagePath, uploadedAt: element.staged.uploadedAt } : null,
    }))
  );
}

export async function getPersistedSubjectRecords(key: string): Promise<PersistedSubjectRecord[]> {
  const value = await getPersistedItem<StoredSubjectRecord[]>(key);
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index): PersistedSubjectRecord | null => {
      if (!isStoredSubjectRecord(item)) {
        return null;
      }

      const images = item.images
        .map((image, imageIndex) => {
          const restoredFile = restoreFile(image?.file, `${key}-${index + 1}-${imageIndex + 1}`);
          if (!restoredFile) {
            return null;
          }
          return {
            id: typeof image?.id === 'string' && image.id ? image.id : `${item.id}-image-${imageIndex + 1}`,
            file: restoredFile,
          };
        })
        .filter((image): image is { id: string; file: File } => image !== null);

      // A subject whose images did not all survive would depict something other
      // than what the user grouped, so drop it rather than restore it partially.
      if (images.length !== item.images.length || images.length === 0) {
        return null;
      }

      return {
        id: item.id,
        displayName: item.displayName,
        handle: typeof item.handle === 'string' ? item.handle : null,
        images,
      } satisfies PersistedSubjectRecord;
    })
    .filter((item): item is PersistedSubjectRecord => item !== null);
}

export async function setPersistedSubjectRecords(
  key: string,
  subjects: PersistedSubjectRecord[]
): Promise<void> {
  if (subjects.length === 0) {
    await removePersistedItem(key);
    return;
  }

  await persistedMediaStore.setItem(
    key,
    subjects.map((subject) => ({
      id: subject.id,
      displayName: subject.displayName,
      handle: subject.handle ?? null,
      images: subject.images.map((image) => ({
        id: image.id,
        file: toStoredMediaFile(image.file),
      })),
    }))
  );
}

export async function getPersistedMediaRecords(key: string): Promise<PersistedMediaRecord[]> {
  const value = await getPersistedItem<StoredMediaRecord[]>(key);
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index): PersistedMediaRecord | null => {
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
        handle: typeof item.handle === 'string' ? item.handle : null,
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
      handle: record.handle ?? null,
      durationSeconds: typeof record.durationSeconds === 'number' ? record.durationSeconds : null,
      file: toStoredMediaFile(record.file),
    }))
  );
}

export async function getPersistedFiles(key: string): Promise<File[]> {
  const value = await getPersistedItem<Array<StoredMediaFile | File | Blob>>(key);
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => restoreFile(item, `${key}-${index + 1}`))
    .filter((item): item is File => item !== null);
}

export async function removePersistedMedia(key: string): Promise<void> {
  await removePersistedItem(key);
}

export async function getPersistedValue<T>(key: string): Promise<T | null> {
  return getPersistedItem<T>(key);
}

export async function setPersistedValue<T>(key: string, value: T | null): Promise<void> {
  if (
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0)
  ) {
    await removePersistedItem(key);
    return;
  }

  await persistedMediaStore.setItem(key, value);
}
