/**
 * Where a photo picked for a support message waits until it is sent: a copy
 * in the app's own documents folder. The picker leaves its file in the cache
 * folder, which Android empties by itself when the phone is short of space
 * (installd purges app caches about once a minute then), so a photo picked a
 * minute before Send could be gone when the upload read it, and every try
 * after that failed the same way (seen on the Pixel 9a emulator with /data
 * 94% full, 2026-11-23). The documents folder is never emptied by the system.
 *
 * Each copy is let go once its message is sent or let go, the draft is taken
 * off, or the screen closes with it unsent; the sweep takes what an earlier
 * run of the app left (it was stopped or reloaded with a photo waiting) and
 * anything a day old. expo-file-system is read lazily, as the rest of the app
 * does, and any failure here falls back to the picker's own file rather than
 * to no photo.
 */

type FileSystem = typeof import('expo-file-system');
type FileSystemDirectory = InstanceType<FileSystem['Directory']>;
type FileSystemFile = InstanceType<FileSystem['File']>;

export const SUPPORT_PHOTO_FOLDER = 'support-photos';
/** A copy older than this was left by a screen that closed before it was sent. */
export const SUPPORT_PHOTO_STALE_MS = 24 * 60 * 60 * 1000;
/**
 * When this run of the app first read this module: every copy it keeps is
 * written later, so an older one was kept by an earlier run, whose screens
 * and sends are gone.
 */
const RUN_STARTED_AT = Date.now();

/** A send whose photo is no longer on the phone: no try can read it again. */
export class SupportPhotoGoneError extends Error {
  constructor() {
    super('The photo is no longer on the phone.');
    this.name = 'SupportPhotoGoneError';
  }
}

async function loadFileSystem(): Promise<FileSystem | null> {
  try {
    return await import('expo-file-system');
  } catch {
    return null;
  }
}

function folderOf(fs: FileSystem): FileSystemDirectory {
  return new fs.Directory(fs.Paths.document, SUPPORT_PHOTO_FOLDER);
}

function insideFolder(folder: FileSystemDirectory, uri: string): boolean {
  const base = folder.uri.endsWith('/') ? folder.uri : `${folder.uri}/`;
  return uri.startsWith(base);
}

/** A name of its own for a copy, keeping the picked file's extension. */
export function supportPhotoCopyName(
  photo: { fileName: string | null; mimeType: string | null },
  now: number = Date.now(),
  random: () => number = Math.random,
): string {
  const fromName = photo.fileName?.match(/\.([A-Za-z0-9]{1,5})$/)?.[1]?.toLowerCase() ?? null;
  const fromType = photo.mimeType?.match(/^image\/([a-z0-9]+)/i)?.[1]?.toLowerCase() ?? null;
  const extension = fromName ?? (fromType === 'jpeg' ? 'jpg' : fromType) ?? 'jpg';
  return `${now.toString(36)}-${random().toString(36).slice(2, 10)}.${extension}`;
}

/** Copies a picked photo into the documents folder: the copy's uri, or the picker's own when no copy could be made. */
export async function keepSupportPhoto(uri: string, name: string): Promise<string> {
  const fs = await loadFileSystem();
  if (!fs) return uri;
  let copy: FileSystemFile | null = null;
  try {
    const folder = folderOf(fs);
    if (insideFolder(folder, uri)) return uri;
    folder.create({ idempotent: true, intermediates: true });
    copy = new fs.File(folder, name);
    new fs.File(uri).copy(copy);
    return copy.uri;
  } catch {
    // A copy cut short (a full disk) is not left behind.
    try {
      if (copy?.exists) copy.delete();
    } catch {
      // The sweep takes it.
    }
    return uri;
  }
}

/** Deletes a copy this module made; any other file (the picker's own) is left where it is. */
export async function letGoSupportPhoto(uri: string | null | undefined): Promise<void> {
  if (!uri) return;
  const fs = await loadFileSystem();
  if (!fs) return;
  try {
    if (!insideFolder(folderOf(fs), uri)) return;
    const file = new fs.File(uri);
    if (file.exists) file.delete();
  } catch {
    // Gone already, or the sweep takes it later.
  }
}

/**
 * Deletes the copies nothing can still send: those an earlier run of the app
 * kept, and those a day old (a screen of this run that closed with a send
 * still on its way lets that copy go itself when the send settles).
 */
export async function sweepSupportPhotos(
  now: number = Date.now(),
  runStartedAt: number = RUN_STARTED_AT,
): Promise<void> {
  const fs = await loadFileSystem();
  if (!fs) return;
  try {
    const folder = folderOf(fs);
    if (!folder.exists) return;
    for (const entry of folder.list()) {
      if (!(entry instanceof fs.File)) continue;
      const time = entry.modificationTime ?? entry.creationTime ?? null;
      if (time !== null && time >= runStartedAt && now - time < SUPPORT_PHOTO_STALE_MS) continue;
      try {
        entry.delete();
      } catch {
        // Tried again at the next sweep.
      }
    }
  } catch {
    // Nothing to sweep.
  }
}

/** Whether a photo's file is still on the phone; true when that cannot be told, so the upload says. */
export async function supportPhotoIsThere(uri: string): Promise<boolean> {
  const fs = await loadFileSystem();
  if (!fs) return true;
  try {
    return new fs.File(uri).exists;
  } catch {
    return true;
  }
}
