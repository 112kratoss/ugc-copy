import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as ImagePicker from 'expo-image-picker';

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn(),
}));

vi.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: vi.fn(),
}));

vi.mock('../lib/env', () => ({
  env: { supabaseUrl: 'https://storage.example.com' },
  getMissingMobileEnvKeys: () => [],
}));

import {
  describeOversizedResourceFiles,
  partitionResourceFilesBySize,
  pickResourcePhotos,
  RESOURCE_FILE_SIZE_LIMIT_LABEL,
} from '../lib/media';

const MB = 1024 * 1024;

/**
 * Reference media from the photo library (recipe audit H6, 2026-10-27): the
 * item editor's only picker was the document picker, which on an iPhone opens
 * Files, so a reference in the camera roll could not be attached at all.
 * expo-image-picker is in every binary already (the post's own media use it).
 */
describe('photos for a recipe item', () => {
  beforeEach(() => {
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockReset();
  });

  it('opens the library for several photos and videos, in the order they were chosen, at full quality', async () => {
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({ canceled: true, assets: null });

    await expect(pickResourcePhotos()).resolves.toEqual([]);
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      orderedSelection: true,
      quality: 1,
    });
  });

  it('hands each one on as a file the reference-media upload accepts', async () => {
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({
      canceled: false,
      assets: [
        // iOS: the original's name, and the copy the picker wrote in another format.
        { uri: 'file:///cache/ImagePicker/6F3B.jpeg', fileName: 'IMG_0001.HEIC', mimeType: 'image/jpeg', fileSize: 2048, type: 'image', width: 10, height: 10 },
        // A video whose name the picker could not read.
        { uri: 'file:///cache/ImagePicker/9A1C.mov', fileName: null, mimeType: 'video/quicktime', fileSize: 4096, type: 'video', width: 10, height: 10 },
        // Android's system picker: a media id for a name, and no extension on the copy.
        { uri: 'content://media/picker/0/1000333161', fileName: '1000333161.jpg', mimeType: 'image/png', type: 'image', width: 10, height: 10 },
        // Nothing to go on but the kind.
        { uri: 'file:///cache/ImagePicker/blob', fileName: null, type: 'image', width: 10, height: 10 },
      ],
    } as never);

    await expect(pickResourcePhotos()).resolves.toEqual([
      { uri: 'file:///cache/ImagePicker/6F3B.jpeg', name: 'IMG_0001.jpeg', mimeType: 'image/jpeg', size: 2048 },
      { uri: 'file:///cache/ImagePicker/9A1C.mov', name: 'video-2.mov', mimeType: 'video/quicktime', size: 4096 },
      { uri: 'content://media/picker/0/1000333161', name: '1000333161.png', mimeType: 'image/png', size: null },
      { uri: 'file:///cache/ImagePicker/blob', name: 'photo-4.jpg', mimeType: null, size: null },
    ]);
  });

  it('says the limit before picking, and leaves out what is over it', () => {
    expect(RESOURCE_FILE_SIZE_LIMIT_LABEL).toBe('Up to 50 MB each');
    const small = { uri: 'a', name: 'a.jpg', size: 2 * MB };
    const unknown = { uri: 'b', name: 'b.jpg', size: null };
    const exact = { uri: 'c', name: 'c.mov', size: 50 * MB };
    const huge = { uri: 'd', name: 'd.mov', size: 50 * MB + 1 };
    expect(partitionResourceFilesBySize([small, huge, unknown, exact])).toEqual({
      accepted: [small, unknown, exact],
      oversized: [huge],
    });
    expect(describeOversizedResourceFiles(0)).toBeNull();
    expect(describeOversizedResourceFiles(1)).toBe('A file over 50 MB was not added.');
    expect(describeOversizedResourceFiles(3)).toBe('3 files over 50 MB were not added.');
  });
});
