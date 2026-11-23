import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { searchThumbnailFromRow } from '@/lib/search-thumbnail';

const HOST = 'https://project.supabase.test/storage/v1/object/public/showcase_media/';
const client = {
  storage: { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: `${HOST}${path}` } }) }) },
} as unknown as SupabaseClient;

const POST_ID = '11111111-1111-4111-8111-111111111111';
const PREVIEW = 'showcase/22222222-2222-4222-8222-222222222222/output.abc123.preview.0123456789abcdef.webp';
const THUMB = 'showcase/22222222-2222-4222-8222-222222222222/output.abc123.thumb.fedcba9876543210.webp';

function pictureRow(overrides: Record<string, unknown> = {}) {
  return {
    post_id: POST_ID,
    path: PREVIEW,
    thumb_path: THUMB,
    thumbhash: '1QcSHQRnh493V4dIh4eXh1h4kJUI',
    width: 864,
    height: 1152,
    media_kind: 'image',
    ...overrides,
  };
}

describe('a search row’s picture', () => {
  it('is the cover’s row thumb where it has one: a 48 px frame needs no 720 px preview', () => {
    expect(searchThumbnailFromRow(client, pictureRow())).toEqual({
      postId: POST_ID,
      url: `${HOST}${THUMB}`,
      thumbhash: '1QcSHQRnh493V4dIh4eXh1h4kJUI',
      // The cover's own size and kind, whichever picture of it the url is.
      width: 864,
      height: 1152,
      mediaKind: 'image',
    });
  });

  it('is the cover’s preview where it has no thumb, as before thumbs existed', () => {
    for (const thumb of [null, undefined, '']) {
      expect(searchThumbnailFromRow(client, pictureRow({ thumb_path: thumb }))?.url, String(thumb)).toBe(`${HOST}${PREVIEW}`);
    }
    // A cover with no thumb answers no such key at all (search_post_picture).
    const older: Record<string, unknown> = pictureRow();
    delete older.thumb_path;
    expect(searchThumbnailFromRow(client, older)?.url).toBe(`${HOST}${PREVIEW}`);
  });

  it('never turns a path in the private bucket into an address', () => {
    // A thumb there is not drawn; the preview is.
    expect(searchThumbnailFromRow(client, pictureRow({ thumb_path: 'private-posts/post-1/0/photo.thumb.ab.webp' }))?.url)
      .toBe(`${HOST}${PREVIEW}`);
    // A private preview is no picture, whatever thumb the row names.
    expect(searchThumbnailFromRow(client, pictureRow({ path: 'private-posts/post-1/0/photo.preview.ab.webp' }))).toBeNull();
  });

  it('is none for a row with no preview or no post', () => {
    expect(searchThumbnailFromRow(client, pictureRow({ path: null }))).toBeNull();
    expect(searchThumbnailFromRow(client, pictureRow({ post_id: null }))).toBeNull();
    expect(searchThumbnailFromRow(client, null)).toBeNull();
  });
});
