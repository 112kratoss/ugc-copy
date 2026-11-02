import { describe, expect, it } from 'vitest';

import {
  STORAGE_BUCKET_ALLOWED_MIME_TYPES,
  STORAGE_MEDIA_MIME_TYPES,
  STORAGE_MEDIA_MIME_TYPE_ALIASES,
  canonicalStorageMediaMimeType,
} from '@/lib/storage-upload-mime-policy';

describe('storage upload MIME aliases', () => {
  // An iPhone's document picker reports UTType(filenameExtension:).preferredMIMEType,
  // which Apple's type database answers (checked 2026-11-02) with audio/x-m4a for an
  // .m4a (Voice Memos, most phone recordings) and audio/vnd.wave for a .wav. Chrome
  // types an .m4a file audio/x-m4a too.
  it.each([
    ['audio/x-m4a', 'audio/mp4'],
    ['audio/vnd.wave', 'audio/wav'],
    [' Audio/X-M4A ', 'audio/mp4'],
  ])('reads %j as %s', (claimed, canonical) => {
    expect(canonicalStorageMediaMimeType(claimed)).toBe(canonical);
  });

  it('leaves every other type as it is, lowercased', () => {
    for (const type of Object.values(STORAGE_MEDIA_MIME_TYPES).flat()) {
      expect(canonicalStorageMediaMimeType(type)).toBe(type);
    }
    expect(canonicalStorageMediaMimeType('Audio/FLAC')).toBe('audio/flac');
    expect(canonicalStorageMediaMimeType('constructor')).toBe('constructor');
  });

  it('names each alias after an audio type the lists keep, never one of them', () => {
    for (const [alias, canonical] of Object.entries(STORAGE_MEDIA_MIME_TYPE_ALIASES)) {
      expect(STORAGE_MEDIA_MIME_TYPES.audio as readonly string[], alias).toContain(canonical);
      expect(Object.values(STORAGE_MEDIA_MIME_TYPES).flat() as string[], alias).not.toContain(alias);
    }
  });

  // Storage judges the content-type header of the upload itself, and an installed
  // app takes that header from its picker, so the uploads bucket has to take the
  // alias for the file to arrive. Every other bucket only ever receives a canonical
  // name: the server writes them, and the workflow asset signer refuses an alias.
  it('lets only the uploads bucket take an alias', () => {
    for (const alias of Object.keys(STORAGE_MEDIA_MIME_TYPE_ALIASES)) {
      for (const [bucket, types] of Object.entries(STORAGE_BUCKET_ALLOWED_MIME_TYPES)) {
        expect((types as readonly string[]).includes(alias), `${bucket} ${alias}`).toBe(bucket === 'uploads');
      }
    }
  });
});
