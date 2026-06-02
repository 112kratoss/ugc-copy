import { describe, expect, it } from 'vitest';

import { getUploadExtension, readUriUploadBody } from '../lib/upload-file';

describe('mobile upload file helpers', () => {
  it('reads picked files as ArrayBuffer upload bodies for React Native storage uploads', async () => {
    const fileBody = new Uint8Array([1, 2, 3, 4]).buffer;

    const upload = await readUriUploadBody('file:///avatar.png', {
      mimeType: 'image/png',
      sizeBytes: null,
      readArrayBuffer: async () => fileBody,
    });

    expect(upload.body).toBe(fileBody);
    expect(upload.mimeType).toBe('image/png');
    expect(upload.sizeBytes).toBe(4);
  });

  it('normalizes common image upload extensions', () => {
    expect(getUploadExtension('image/jpeg', 'photo.jpeg')).toBe('jpg');
    expect(getUploadExtension('image/heic', null)).toBe('heic');
    expect(getUploadExtension('', 'photo')).toBe('bin');
  });
});
