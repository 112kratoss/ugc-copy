import { describe, expect, it } from 'vitest';

import { getSeedanceAssetSourceName } from '@/lib/seedance-assets';

const OWNER_ID = '0b9f6c2e-51d7-4c3a-9e84-2f6a1d7c5b90';
const GENERATION_ID = '7c1e4a58-93bd-4f06-8a27-d5e0b6f3a914';
const STORAGE_PATH = `generation_inputs/${OWNER_ID}/${GENERATION_ID}/01-reference_image_1.png`;
// Shaped like a storage token (three dot-joined segments, several hundred
// characters with nowhere to break), built here so no token literal is committed.
const TOKEN = ['header', 'payload'.repeat(40), 'signature'].join('.');

describe('getSeedanceAssetSourceName', () => {
  it('names a signed storage link by its file, without the token', () => {
    const name = getSeedanceAssetSourceName(
      `https://example.supabase.co/storage/v1/object/sign/${STORAGE_PATH}?token=${TOKEN}`
    );

    expect(name).toBe('01-reference_image_1.png');
  });

  it('names a bare storage path by its file', () => {
    expect(getSeedanceAssetSourceName(STORAGE_PATH)).toBe('01-reference_image_1.png');
  });

  it('drops a fragment as well as a query', () => {
    expect(getSeedanceAssetSourceName('https://cdn.example.com/clips/dolly.mp4#t=2')).toBe('dolly.mp4');
    expect(getSeedanceAssetSourceName('uploads/user-1/dolly.mp4?download=1')).toBe('dolly.mp4');
  });

  it('decodes an encoded file name, and keeps one it cannot decode', () => {
    expect(getSeedanceAssetSourceName('https://cdn.example.com/uploads/harbour%20at%20dusk.png')).toBe('harbour at dusk.png');
    expect(getSeedanceAssetSourceName('https://cdn.example.com/uploads/100%25%ZZ.png')).toBe('100%25%ZZ.png');
  });

  it('falls back to the host when the link has no file', () => {
    expect(getSeedanceAssetSourceName('https://cdn.example.com/')).toBe('cdn.example.com');
  });

  it('has no name for a preview that only exists in this browser', () => {
    expect(getSeedanceAssetSourceName('blob:https://magicbooklet.com/3f6c1d2e-8a47-4e9b-b3c5-1d2e3f4a5b6c')).toBeNull();
    expect(getSeedanceAssetSourceName('data:image/png;base64,iVBORw0KGgo=')).toBeNull();
  });

  it('has no name when nothing was captured', () => {
    expect(getSeedanceAssetSourceName(null)).toBeNull();
    expect(getSeedanceAssetSourceName(undefined)).toBeNull();
    expect(getSeedanceAssetSourceName('   ')).toBeNull();
    expect(getSeedanceAssetSourceName('?token=only')).toBeNull();
  });
});
