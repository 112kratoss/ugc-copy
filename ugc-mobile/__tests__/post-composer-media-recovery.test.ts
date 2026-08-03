import { describe, expect, it } from 'vitest';

import {
  applyPostComposerMediaRecovery,
  describeLostRecoveryMedia,
  planPostComposerMediaRecovery,
  type MediaVerification,
} from '@/lib/post-composer-media-recovery';
import type { PostComposerMediaItem } from '@/lib/post-new-view-model';

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

describe('describeLostRecoveryMedia', () => {
  it('says nothing when everything was recovered', () => {
    expect(describeLostRecoveryMedia([])).toBeNull();
  });

  it('names what was dropped so the user can replace it', () => {
    expect(describeLostRecoveryMedia([mediaItem({ name: 'clip.mp4' })]))
      .toContain('clip.mp4');
    expect(describeLostRecoveryMedia([
      mediaItem({ id: 'a', name: 'a.jpg' }),
      mediaItem({ id: 'b', name: 'b.jpg' }),
    ])).toContain('2 items');
  });
});
