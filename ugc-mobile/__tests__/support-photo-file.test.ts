import { beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in for expo-file-system's File and Directory over an in-memory disk:
// a file is its uri and a modification time.
const disk = vi.hoisted(() => ({
  files: new Map<string, { time: number | null }>(),
  folders: new Set<string>(),
  // 'before' fails ahead of writing anything; 'partway' leaves part of the copy written, as a full disk does.
  failCopy: false as false | 'before' | 'partway',
}));

vi.mock('expo-file-system', () => {
  type Part = string | { uri: string };
  const join = (parts: Part[]) => parts
    .map((part) => (typeof part === 'string' ? part : part.uri))
    .map((part, index) => (index === 0 ? part.replace(/\/$/, '') : part.replace(/^\/|\/$/g, '')))
    .join('/');
  class File {
    readonly uri: string;
    constructor(...parts: Part[]) {
      this.uri = join(parts);
    }
    get exists() {
      return disk.files.has(this.uri);
    }
    get modificationTime() {
      return disk.files.get(this.uri)?.time ?? null;
    }
    get creationTime() {
      return null;
    }
    copy(destination: File) {
      if (disk.failCopy === 'before' || !disk.files.has(this.uri)) throw new Error('Unable to copy');
      disk.files.set(destination.uri, { time: Date.now() });
      if (disk.failCopy === 'partway') throw new Error('No space left on device');
    }
    delete() {
      if (!disk.files.delete(this.uri)) throw new Error('No such file');
    }
  }
  class Directory {
    readonly uri: string;
    constructor(...parts: Part[]) {
      this.uri = `${join(parts)}/`;
    }
    get exists() {
      return disk.folders.has(this.uri);
    }
    create() {
      disk.folders.add(this.uri);
    }
    list() {
      return [...disk.files.keys()]
        .filter((uri) => uri.startsWith(this.uri) && !uri.slice(this.uri.length).includes('/'))
        .map((uri) => new File(uri));
    }
  }
  return { File, Directory, Paths: { document: new Directory('file:///documents') } };
});

import {
  keepSupportPhoto,
  letGoSupportPhoto,
  SUPPORT_PHOTO_STALE_MS,
  supportPhotoCopyName,
  supportPhotoIsThere,
  sweepSupportPhotos,
} from '../lib/support-photo-file';

const PICKED = 'file:///cache/ImagePicker/0f3a.jpeg';
const FOLDER = 'file:///documents/support-photos/';

beforeEach(() => {
  disk.files.clear();
  disk.folders.clear();
  disk.failCopy = false;
  disk.files.set(PICKED, { time: Date.now() });
});

describe('a picked photo kept for a support message', () => {
  it('waits in a copy in the documents folder, which the system never empties', async () => {
    const copy = await keepSupportPhoto(PICKED, 'lq1-abc.jpg');
    expect(copy).toBe(`${FOLDER}lq1-abc.jpg`);
    expect(disk.files.has(copy)).toBe(true);
    // The picker's own file is left to the picker.
    expect(disk.files.has(PICKED)).toBe(true);
  });

  it('falls back to the picker\'s own file when no copy can be made', async () => {
    disk.failCopy = 'before';
    await expect(keepSupportPhoto(PICKED, 'lq1-abc.jpg')).resolves.toBe(PICKED);
  });

  it('leaves no copy cut short behind when the disk fills partway', async () => {
    disk.failCopy = 'partway';
    await expect(keepSupportPhoto(PICKED, 'lq1-abc.jpg')).resolves.toBe(PICKED);
    expect(disk.files.has(`${FOLDER}lq1-abc.jpg`)).toBe(false);
  });

  it('does not copy a copy again', async () => {
    const copy = await keepSupportPhoto(PICKED, 'lq1-abc.jpg');
    await expect(keepSupportPhoto(copy, 'lq2-def.jpg')).resolves.toBe(copy);
    expect([...disk.files.keys()].filter((uri) => uri.startsWith(FOLDER))).toEqual([copy]);
  });

  it('lets a copy go, and never a file of the picker\'s or one already gone', async () => {
    const copy = await keepSupportPhoto(PICKED, 'lq1-abc.jpg');
    await letGoSupportPhoto(copy);
    expect(disk.files.has(copy)).toBe(false);
    await letGoSupportPhoto(PICKED);
    expect(disk.files.has(PICKED)).toBe(true);
    await expect(letGoSupportPhoto(copy)).resolves.toBeUndefined();
    await expect(letGoSupportPhoto(null)).resolves.toBeUndefined();
  });

  it('sweeps what an earlier run of the app left and what is a day old, and keeps this run\'s copies', async () => {
    const now = Date.now();
    const runStartedAt = now - 10 * 60_000;
    disk.folders.add(FOLDER);
    // The app was stopped, or reloaded, with a photo waiting a minute before this run began.
    disk.files.set(`${FOLDER}earlier-run.jpg`, { time: runStartedAt - 60_000 });
    // A send of this run that outlived its screen, two minutes ago.
    disk.files.set(`${FOLDER}this-run.jpg`, { time: now - 2 * 60_000 });
    disk.files.set(`${FOLDER}a-day-old.jpg`, { time: now - SUPPORT_PHOTO_STALE_MS - 1 });
    await sweepSupportPhotos(now, runStartedAt);
    expect(disk.files.has(`${FOLDER}earlier-run.jpg`)).toBe(false);
    expect(disk.files.has(`${FOLDER}a-day-old.jpg`)).toBe(false);
    expect(disk.files.has(`${FOLDER}this-run.jpg`)).toBe(true);
    expect(disk.files.has(PICKED)).toBe(true);
  });

  it('tells whether a photo\'s file is still on the phone', async () => {
    await expect(supportPhotoIsThere(PICKED)).resolves.toBe(true);
    disk.files.delete(PICKED);
    await expect(supportPhotoIsThere(PICKED)).resolves.toBe(false);
  });

  it('names each copy anew, keeping the picked file\'s kind', () => {
    const now = 1_700_000_000_000;
    const random = () => 0.123456789;
    expect(supportPhotoCopyName({ fileName: 'IMG_0001.HEIC', mimeType: 'image/heic' }, now, random)).toMatch(/\.heic$/);
    expect(supportPhotoCopyName({ fileName: '171.jpg', mimeType: 'image/jpeg' }, now, random)).toMatch(/\.jpg$/);
    expect(supportPhotoCopyName({ fileName: null, mimeType: 'image/jpeg' }, now, random)).toMatch(/\.jpg$/);
    expect(supportPhotoCopyName({ fileName: null, mimeType: 'image/png' }, now, random)).toMatch(/\.png$/);
    expect(supportPhotoCopyName({ fileName: null, mimeType: null }, now, random)).toMatch(/\.jpg$/);
    expect(supportPhotoCopyName({ fileName: 'a.jpg', mimeType: null }, now, random))
      .not.toBe(supportPhotoCopyName({ fileName: 'a.jpg', mimeType: null }, now + 1, random));
  });
});
