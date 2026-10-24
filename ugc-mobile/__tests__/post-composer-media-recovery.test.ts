import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api-client';
import {
  applyPostComposerMediaRecovery,
  applyPostComposerMediaRecoveryToDraft,
  describeFailedRecoveryReuploads,
  describeLostRecoveryMedia,
  forgetConsumedMediaUploads,
  getMediaAwaitingUpload,
  planPostComposerMediaRecovery,
  saveMayHaveConsumedUploads,
  saveRefusedForStaleMediaIds,
  withSavedPostMedia,
  type MediaVerification,
} from '@/lib/post-composer-media-recovery';
import {
  buildCreatePostFormData,
  buildPostComposerMediaItemsPayload,
  getDefaultPostComposerDraft,
  hydratePostComposerMediaItems,
  type PostComposerMediaItem,
} from '@/lib/post-new-view-model';
import type { ShowcaseMediaItem } from '@/lib/types';

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

// The server moves each staged upload into the post, deleting the staged copy,
// before it checks the Made with catalog: that refusal, a server error, and a
// request whose answer never came may all follow the move, and a second finalize
// of a moved upload is refused. The web's rule (readSaveResponse in
// src/app/post/new/NewPostClient.tsx); every other refusal comes first.
describe('a save that may have used the staged uploads', () => {
  const url = 'https://magicbooklet.com/api/posts';

  it.each([
    ['no answer at all', new ApiError('Network request failed.', 0, { url, cause: 'Network request failed' })],
    ['a deadline that ran out after the request left', new ApiError('Network request failed.', 0, { url, cause: 'Request timed out', timedOut: true })],
    ['a server error', new ApiError('Failed to publish post.', 500, { error: 'Failed to publish post.' })],
    ['a gateway error page', new ApiError('Request failed with status 504', 504, '<html>Gateway Timeout</html>')],
    ['the Made with refusal', new ApiError('Choose a tool from the list.', 400, { error: 'Choose a tool from the list.', field: 'sourceTools' })],
  ])('counts %s as having used them', (_label, error) => {
    expect(saveMayHaveConsumedUploads(error)).toBe(true);
  });

  it.each([
    ['a refusal decided before the move', new ApiError('Add a title for your post.', 400, { error: 'Add a title for your post.', field: 'title' })],
    ['the profile refusal', new ApiError('Complete your profile before publishing publicly.', 400, { error: 'Complete your profile before publishing publicly.', field: 'profile' })],
    ['a refusal with no field', new ApiError('Replace the placeholder title with something specific to this post.', 400, { error: 'Replace the placeholder title with something specific to this post.' })],
    ['a request that never left the device', new ApiError('Network request failed.', 0, { url, cause: 'Request timed out before it was sent', timedOut: true, sent: false })],
    ['a check the composer made before sending', new Error('Add a title for your post.')],
  ])('keeps them after %s', (_label, error) => {
    expect(saveMayHaveConsumedUploads(error)).toBe(false);
  });

  it('tells a refusal for stale media ids apart, and keeps the uploads after it', () => {
    const stale = new ApiError('An existing media item no longer belongs to this post.', 400, {
      error: 'An existing media item no longer belongs to this post.',
      field: 'mediaItems',
    });
    expect(saveRefusedForStaleMediaIds(stale)).toBe(true);
    expect(saveMayHaveConsumedUploads(stale)).toBe(false);
    expect(saveRefusedForStaleMediaIds(new ApiError('Add a title for your post.', 400, { field: 'title' }))).toBe(false);
    expect(saveRefusedForStaleMediaIds(new ApiError('Failed to update post.', 500, { field: 'mediaItems' }))).toBe(false);
    expect(saveRefusedForStaleMediaIds(new Error('An existing media item no longer belongs to this post.'))).toBe(false);
  });

  const sent = mediaItem({ id: 'sent', storagePath: 'uploads/user-1/sent.jpg' });
  const saved = mediaItem({ id: 'saved', existingId: 'row-1', storagePath: null, uri: 'https://cdn.example.com/saved.jpg' });
  const draft = { ...getDefaultPostComposerDraft(), mode: 'upload' as const, proofMode: 'media' as const, title: 'Gallery' };

  it('forgets the paths the save sent, and keeps saved media and media added since', () => {
    const later = mediaItem({ id: 'later', storagePath: 'uploads/user-1/later.jpg' });
    const submitted = { ...draft, mediaItems: [sent, saved] };
    const current = { ...draft, mediaItems: [sent, saved, later] };

    const result = forgetConsumedMediaUploads(current, submitted);
    expect(result.mediaItems).toEqual([{ ...sent, storagePath: null }, saved, later]);
    // The next publish uploads the forgotten one again, from the file on the device.
    expect(getMediaAwaitingUpload(result.mediaItems)).toEqual([{ ...sent, storagePath: null }]);
  });

  it('changes nothing when the save sent no new upload', () => {
    const current = { ...draft, mediaItems: [saved] };
    expect(forgetConsumedMediaUploads(current, current)).toBe(current);
    expect(getMediaAwaitingUpload(current.mediaItems)).toEqual([]);
  });
});

// An edit save that sends media deletes and re-inserts every media row of the
// post (`replace_post_media`), so every id changes. After one that may have gone
// through before it failed, or in a draft kept from before one, the draft's ids
// named rows that were gone, and the server refused every save with "An existing
// media item no longer belongs to this post."
describe('withSavedPostMedia', () => {
  const row = (id: string, mediaKey: string, name = `${mediaKey}.jpg`) => ({
    id,
    mediaKey,
    url: `https://cdn.example.com/${name}`,
    previewUrl: null,
    mediaKind: 'image',
    contentType: 'image/jpeg',
    originalName: name,
    width: null,
    height: null,
    durationSeconds: null,
    sortOrder: 0,
  }) satisfies ShowcaseMediaItem;
  const post = (mediaItems: ShowcaseMediaItem[]) => ({
    id: 'post-1',
    title: 'Gallery',
    mediaUrl: mediaItems[0]?.url ?? null,
    mediaKind: 'image' as const,
    mediaItems,
  });
  // As the edit prefill loads a saved item.
  const savedItem = (id: string, mediaKey: string, name = `${mediaKey}.jpg`) => mediaItem({
    id,
    mediaKey,
    existingId: id,
    storagePath: undefined,
    uri: `https://cdn.example.com/${name}`,
    name,
  });
  const draft = { ...getDefaultPostComposerDraft(), mode: 'upload' as const, proofMode: 'media' as const, title: 'Gallery', category: 'image' as const };

  it('names media the post holds by its row now, and forgets the upload that save used', () => {
    const first = savedItem('row-1', 'media-first');
    // Its staged path was forgotten after the failed save, or is still set in a draft kept before it.
    const added = mediaItem({ id: 'media-added', mediaKey: 'media-added', uri: 'file:///local/added.jpg', storagePath: 'uploads/user-1/added.jpg' });

    const result = withSavedPostMedia(
      { ...draft, mediaItems: [first, added] },
      post([row('row-9', 'media-first'), row('row-10', 'media-added')]),
      neverLocal,
    );

    expect(result.lost).toEqual([]);
    expect(result.draft.mediaItems).toEqual([
      { ...first, existingId: 'row-9' },
      { ...added, existingId: 'row-10', storagePath: null },
    ]);
    expect(buildPostComposerMediaItemsPayload(result.draft)).toEqual([
      { existingId: 'row-9', mediaKey: 'media-first' },
      { existingId: 'row-10', mediaKey: 'media-added' },
    ]);
  });

  it('leaves alone a draft whose rows the post still holds under the same ids', () => {
    const first = savedItem('row-1', 'media-first');
    const second = savedItem('row-2', 'media-second');
    const input = { ...draft, mediaItems: [first, second] };

    const result = withSavedPostMedia(input, post([row('row-1', 'media-first'), row('row-2', 'media-second')]), neverLocal);

    // The same items: a reopened draft that matches the post must not count as changed.
    expect(result.draft.mediaItems[0]).toBe(first);
    expect(result.draft.mediaItems[1]).toBe(second);
    expect(JSON.stringify(result.draft)).toBe(JSON.stringify(input));
    expect(result.lost).toEqual([]);
  });

  it('keeps new media the post does not hold as the new upload it is', () => {
    const staged = mediaItem({ id: 'media-staged', mediaKey: 'media-staged', uri: 'file:///local/staged.jpg', storagePath: 'uploads/user-1/staged.jpg' });
    const awaiting = mediaItem({ id: 'media-awaiting', mediaKey: 'media-awaiting', uri: 'file:///local/awaiting.jpg', storagePath: null });

    const result = withSavedPostMedia(
      { ...draft, mediaItems: [staged, awaiting] },
      post([row('row-1', 'media-first')]),
      (uri) => uri === 'file:///local/awaiting.jpg',
    );

    expect(result.draft.mediaItems[0]).toBe(staged);
    expect(result.draft.mediaItems[1]).toBe(awaiting);
    expect(getMediaAwaitingUpload(result.draft.mediaItems)).toEqual([awaiting]);
    expect(result.lost).toEqual([]);
  });

  it('sends what the post no longer holds again from the device, and drops what is on neither', () => {
    // Saved earlier from this phone, so its file is still here.
    const fromDevice = mediaItem({ id: 'row-2', mediaKey: 'media-device', existingId: 'row-2', storagePath: null, uri: 'file:///local/device.jpg' });
    const gone = savedItem('row-3', 'media-gone', 'gone.jpg');
    const unsent = mediaItem({ id: 'media-unsent', mediaKey: 'media-unsent', uri: 'file:///local/unsent.jpg', storagePath: null, name: 'unsent.jpg' });

    const result = withSavedPostMedia(
      { ...draft, mediaItems: [savedItem('row-1', 'media-first'), fromDevice, gone, unsent] },
      post([row('row-1', 'media-first')]),
      (uri) => uri === 'file:///local/device.jpg',
    );

    expect(result.draft.mediaItems.map((item) => item.id)).toEqual(['row-1', 'row-2']);
    expect(result.draft.mediaItems[1]).toEqual({ ...fromDevice, existingId: null });
    expect(getMediaAwaitingUpload(result.draft.mediaItems)).toEqual([{ ...fromDevice, existingId: null }]);
    expect(result.lost).toEqual([gone, unsent]);
    expect(describeLostRecoveryMedia(result.lost))
      .toBe('gone.jpg and unsent.jpg could not be restored and were removed. Add them again before publishing.');
  });

  // The edit prefill names the cover of a post listed with no media rows after the
  // post itself; checked the same way, that cover is the post's, not a lost item.
  it('keeps the cover of a post listed without media rows', () => {
    const legacy = { id: 'post-1', title: 'Gallery', mediaUrl: 'https://cdn.example.com/legacy.jpg', mediaKind: 'image' as const, mediaItems: [] };
    const [cover] = hydratePostComposerMediaItems(legacy);

    const result = withSavedPostMedia({ ...draft, mediaItems: [cover] }, legacy, neverLocal);

    expect(result.draft.mediaItems[0]).toBe(cover);
    expect(result.lost).toEqual([]);
  });

  it('hands the cover fields to the item that becomes first when the cover is dropped', () => {
    const video = mediaItem({ id: 'row-1', mediaKey: 'media-video', existingId: 'row-1', storagePath: null, uri: 'https://cdn.example.com/clip.mp4', name: 'clip.mp4', type: 'video/mp4', mediaKind: 'video' });
    const image = savedItem('row-2', 'media-image');

    const result = withSavedPostMedia(
      { ...draft, category: 'video', upload: { uri: video.uri, name: video.name, type: video.type }, mediaItems: [video, image] },
      post([row('row-8', 'media-image')]),
      neverLocal,
    );

    expect(result.draft.mediaItems).toEqual([{ ...image, existingId: 'row-8' }]);
    expect(result.draft.category).toBe('image');
    expect(result.draft.upload).toEqual({ uri: image.uri, name: image.name, type: image.type });
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
