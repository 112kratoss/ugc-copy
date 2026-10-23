import { describe, expect, it } from 'vitest';

import {
  applyPostComposerMediaRecovery,
  applyPostComposerMediaRecoveryToDraft,
  describeFailedRecoveryReuploads,
  describeLostRecoveryMedia,
  planPostComposerMediaRecovery,
  type MediaVerification,
} from '@/lib/post-composer-media-recovery';
import { buildCreatePostFormData, getDefaultPostComposerDraft, type PostComposerMediaItem } from '@/lib/post-new-view-model';

function mediaItem(overrides: Partial<PostComposerMediaItem> = {}): PostComposerMediaItem {
  return {
    id: 'media-1',
    mediaKey: 'media-1',
    uri: 'file:///local/media-1.jpg',
    name: 'media-1.jpg',
    type: 'image/jpeg',
    mediaKind: 'image',
    storagePath: 'uploads/user-1/media-1.jpg',
    ...overrides,
  };
}

const present: MediaVerification = { exists: true, inconclusive: false };
const missing: MediaVerification = { exists: false, inconclusive: false };
const unknown: MediaVerification = { exists: false, inconclusive: true };

const alwaysLocal = () => true;
const neverLocal = () => false;

describe('planPostComposerMediaRecovery', () => {
  it('leaves staged media alone when it is still there', () => {
    const item = mediaItem();
    const plan = planPostComposerMediaRecovery(
      [item],
      new Map([[item.storagePath!, present]]),
      alwaysLocal,
    );

    expect(plan.items[0].status).toBe('available');
    expect(plan.toReupload).toEqual([]);
    expect(plan.lost).toEqual([]);
  });

  it('re-uploads reclaimed media when the local file survived', () => {
    const item = mediaItem();
    const plan = planPostComposerMediaRecovery(
      [item],
      new Map([[item.storagePath!, missing]]),
      alwaysLocal,
    );

    expect(plan.items[0].status).toBe('reupload');
    expect(plan.toReupload).toEqual([item]);
  });

  it('marks media lost only when both the upload and the local file are gone', () => {
    const item = mediaItem();
    const plan = planPostComposerMediaRecovery(
      [item],
      new Map([[item.storagePath!, missing]]),
      neverLocal,
    );

    expect(plan.items[0].status).toBe('lost');
    expect(plan.lost).toEqual([item]);
  });

  it('keeps media it could not verify rather than guessing it is gone', () => {
    // A storage blip is not evidence that a user's media vanished. Publishing
    // re-validates, so an optimistic keep costs a clear error later, while an
    // over-eager drop destroys work silently.
    const item = mediaItem();
    for (const verifications of [
      new Map([[item.storagePath!, unknown]]),
      new Map<string, MediaVerification>(),
    ]) {
      const plan = planPostComposerMediaRecovery([item], verifications, neverLocal);
      expect(plan.items[0].status).toBe('unverified');
      expect(plan.lost).toEqual([]);
      expect(plan.toReupload).toEqual([]);
    }
  });

  it('never touches media already attached to a published post', () => {
    // Those bytes live in showcase_media, which the reclaim sweep cannot reach.
    const item = mediaItem({ existingId: 'post-media-1', storagePath: null });
    const plan = planPostComposerMediaRecovery([item], new Map(), neverLocal);
    expect(plan.items[0].status).toBe('available');
  });
});

describe('applyPostComposerMediaRecovery', () => {
  it('swaps in new storage paths and drops lost items while preserving order', () => {
    // The first item is the Showcase cover, so reordering during a recovery the
    // user never asked for would change what their post looks like.
    const items = [
      mediaItem({ id: 'a', storagePath: 'uploads/user-1/a.jpg' }),
      mediaItem({ id: 'b', storagePath: 'uploads/user-1/b.jpg' }),
      mediaItem({ id: 'c', storagePath: 'uploads/user-1/c.jpg' }),
    ];

    const result = applyPostComposerMediaRecovery(items, {
      reuploaded: new Map([['b', { storagePath: 'uploads/user-1/b-new.jpg' }]]),
      lost: new Set(['c']),
    });

    expect(result.map((item) => item.id)).toEqual(['a', 'b']);
    expect(result[1].storagePath).toBe('uploads/user-1/b-new.jpg');
  });

  it('returns the list unchanged when nothing needed recovery', () => {
    const items = [mediaItem()];
    expect(applyPostComposerMediaRecovery(items, {
      reuploaded: new Map(),
      lost: new Set(),
    })).toEqual(items);
  });
});

describe('applyPostComposerMediaRecoveryToDraft', () => {
  const video = mediaItem({ id: 'video', uri: 'file:///local/clip.mp4', name: 'clip.mp4', type: 'video/mp4', mediaKind: 'video', storagePath: 'uploads/user-1/clip.mp4' });
  const image = mediaItem({ id: 'image', uri: 'file:///local/still.jpg', name: 'still.jpg', storagePath: 'uploads/user-1/still.jpg' });
  const draft = {
    ...getDefaultPostComposerDraft(),
    mode: 'upload' as const,
    proofMode: 'media' as const,
    title: 'Restored gallery',
    category: 'video' as const,
    upload: { uri: video.uri, name: video.name, type: video.type },
    mediaItems: [video, image],
  };

  it('hands the cover fields to the item that becomes first', () => {
    const restored = applyPostComposerMediaRecoveryToDraft(draft, {
      reuploaded: new Map(),
      lost: new Set(['video']),
    });

    expect(restored.mediaItems.map((item) => item.id)).toEqual(['image']);
    expect(restored.upload).toEqual({ uri: image.uri, name: image.name, type: image.type });
    expect(restored.category).toBe('image');
    // What the create route checks against the cover's type.
    expect(buildCreatePostFormData(restored).get('category')).toBe('image');
  });

  it('leaves no file behind for the single-file fallback once every item is lost', () => {
    const restored = applyPostComposerMediaRecoveryToDraft(draft, {
      reuploaded: new Map(),
      lost: new Set(['video', 'image']),
    });

    expect(restored.mediaItems).toEqual([]);
    expect(restored.upload).toBeNull();
    expect(buildCreatePostFormData(restored).get('media')).toBeNull();
  });

  it('keeps a text-format draft filed as text', () => {
    const restored = applyPostComposerMediaRecoveryToDraft(
      { ...draft, mode: 'text', proofMode: 'text', category: 'text' },
      { reuploaded: new Map([['video', { storagePath: 'uploads/user-1/clip-new.mp4' }]]), lost: new Set() },
    );

    expect(restored.category).toBe('text');
    expect(restored.mediaItems[0].storagePath).toBe('uploads/user-1/clip-new.mp4');
  });
});

describe('describeLostRecoveryMedia', () => {
  it('says nothing when everything was recovered', () => {
    expect(describeLostRecoveryMedia([])).toBeNull();
  });

  it('names what was dropped so the user can replace it', () => {
    expect(describeLostRecoveryMedia([mediaItem({ name: 'clip.mp4', mediaKind: 'video', type: 'video/mp4' })]))
      .toBe('clip.mp4 could not be restored and was removed. Add it again before publishing.');
    expect(describeLostRecoveryMedia([
      mediaItem({ id: 'a', name: 'a.jpg' }),
      mediaItem({ id: 'b', name: 'b.jpg' }),
    ])).toBe('a.jpg and b.jpg could not be restored and were removed. Add them again before publishing.');
  });

  // Android's photo picker hands a picture over under its media id, and the notice read "One item
  // (1000333162.jpg) could not be restored" (redundant-UI audit, 2026-10-21).
  it('calls an item whose file name says nothing by its kind', () => {
    expect(describeLostRecoveryMedia([mediaItem({ name: '1000333162.jpg' })]))
      .toBe('An image could not be restored and was removed. Add it again before publishing.');
    expect(describeLostRecoveryMedia([
      mediaItem({ id: 'a', name: '1000333161.mp4', mediaKind: 'video', type: 'video/mp4' }),
      mediaItem({ id: 'b', name: 'clip.mp4', mediaKind: 'video', type: 'video/mp4' }),
      // An edited post's item with no original name is named by its id (app/post/new.tsx).
      mediaItem({ id: 'c', name: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' }),
    ])).toBe('clip.mp4, a video and an image could not be restored and were removed. Add them again before publishing.');
  });
});

describe('describeFailedRecoveryReuploads', () => {
  it('names the media the restore could not upload again', () => {
    expect(describeFailedRecoveryReuploads([mediaItem({ name: 'cover.png' })]))
      .toBe('cover.png could not be re-uploaded. Remove and re-add it, or try opening this draft again.');
    expect(describeFailedRecoveryReuploads([mediaItem({ id: 'a', name: '1000333161.jpg' }), mediaItem({ id: 'b', name: '1000333162.jpg' })]))
      .toBe('2 images could not be re-uploaded. Remove and re-add them, or try opening this draft again.');
  });
});
