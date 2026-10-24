import { ApiError } from './api-client';
import { listFilesInSentence } from './media-file-names';
import { hydratePostComposerMediaItems, type PostComposerDraft, type PostComposerMediaItem } from './post-new-view-model';

/**
 * Recovers a restored draft's staged media.
 *
 * A draft persists each item's `storagePath`, but staged uploads are not
 * permanent -- the server reclaims ones nothing ever published. Resuming a
 * draft without checking meant publishing failed with "Failed to load uploaded
 * media" and no way to recover, because the composer looked completely intact.
 *
 * Each item still carries the local `uri` it was picked from, so a missing
 * upload is usually recoverable by uploading it again. This module decides what
 * to do per item; the screen performs the uploads.
 */

export type MediaRecoveryStatus =
  /** The staged object is still there; nothing to do. */
  | 'available'
  /** Gone from storage, but the local file is still on the device. */
  | 'reupload'
  /** Gone from storage and the local file is gone too. */
  | 'lost'
  /** Could not be checked. Kept as-is rather than guessing. */
  | 'unverified';

export type MediaVerification = {
  /** False only when the server positively reported the object missing. */
  exists: boolean;
  /** True when the check itself failed, so `exists` carries no information. */
  inconclusive: boolean;
};

export type MediaRecoveryPlanItem = {
  item: PostComposerMediaItem;
  status: MediaRecoveryStatus;
};

export type MediaRecoveryPlan = {
  items: MediaRecoveryPlanItem[];
  /** Items needing a re-upload, in their original order. */
  toReupload: PostComposerMediaItem[];
  /** Items that cannot be recovered and must be dropped from the draft. */
  lost: PostComposerMediaItem[];
};

/**
 * Decide what each restored item needs.
 *
 * Errs toward keeping media: an unverifiable item stays in the draft, because a
 * storage blip is not evidence that a user's media is gone. The publish request
 * re-validates anyway, so an optimistic keep costs a clear error at publish
 * time, while an over-eager drop silently destroys work.
 */
export function planPostComposerMediaRecovery(
  items: PostComposerMediaItem[],
  verifications: Map<string, MediaVerification>,
  localFileExists: (uri: string) => boolean,
): MediaRecoveryPlan {
  const planned: MediaRecoveryPlanItem[] = items.map((item) => {
    // Media already attached to a published post lives in showcase_media, not
    // the staging bucket, so the sweep never touches it.
    if (item.existingId || !item.storagePath) {
      return { item, status: 'available' as const };
    }

    const verification = verifications.get(item.storagePath);
    if (!verification || verification.inconclusive) {
      return { item, status: 'unverified' as const };
    }

    if (verification.exists) {
      return { item, status: 'available' as const };
    }

    return {
      item,
      status: item.uri && localFileExists(item.uri) ? ('reupload' as const) : ('lost' as const),
    };
  });

  return {
    items: planned,
    toReupload: planned.filter((entry) => entry.status === 'reupload').map((entry) => entry.item),
    lost: planned.filter((entry) => entry.status === 'lost').map((entry) => entry.item),
  };
}

/**
 * Apply a completed recovery back onto the draft's media list.
 *
 * Order is preserved because the first item is the Showcase cover -- silently
 * reordering a gallery during a recovery the user never asked for would change
 * what their post looks like.
 */
export function applyPostComposerMediaRecovery(
  items: PostComposerMediaItem[],
  outcome: {
    reuploaded: Map<string, { storagePath: string; uri?: string }>;
    lost: Set<string>;
  },
): PostComposerMediaItem[] {
  return items.flatMap((item) => {
    if (outcome.lost.has(item.id)) {
      return [];
    }

    const replacement = outcome.reuploaded.get(item.id);
    if (!replacement) {
      return [item];
    }

    return [{
      ...item,
      storagePath: replacement.storagePath,
      ...(replacement.uri ? { uri: replacement.uri } : {}),
    }];
  });
}

/**
 * Apply a completed recovery to the whole draft. Dropping a lost item can hand
 * the cover to another item, so the fields that follow the cover follow it here:
 * a stale `category` was refused by the create route when the new cover was of
 * another kind, and a stale `upload` sent a file that is gone through the
 * single-file fallback once every item was lost. A text-format draft that kept
 * its media stays filed as text.
 */
export function applyPostComposerMediaRecoveryToDraft(
  draft: PostComposerDraft,
  outcome: Parameters<typeof applyPostComposerMediaRecovery>[1],
): PostComposerDraft {
  const mediaItems = applyPostComposerMediaRecovery(draft.mediaItems, outcome);
  const cover = mediaItems[0];
  return {
    ...draft,
    mediaItems,
    upload: cover ? { uri: cover.uri, name: cover.name, type: cover.type } : null,
    category: draft.mode === 'upload' && cover ? cover.mediaKind : draft.category,
  };
}

/**
 * Whether a failed save may have used the staged uploads it sent. The server
 * moves each one into the post, deleting the staged copy, before it checks the
 * Made with catalog: that refusal (`field: 'sourceTools'`) comes after the
 * move, a server error can, and so can a request whose answer never came back.
 * A second save of a moved upload is refused every time, so those uploads have
 * to go again. Every other refusal is decided before anything moves, and the
 * same uploads can be sent again. The web composer's rule (`readSaveResponse`).
 */
/**
 * True for an edit refused, before anything was written, because it named its
 * media by rows the post no longer has: the rows were re-inserted under new ids
 * since the composer read them (an earlier save that finished after its
 * deadline, or an edit from the web). The server marks it `field: 'mediaItems'`;
 * the uploads are untouched, and the next save reads the rows back.
 */
export function saveRefusedForStaleMediaIds(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 400) return false;
  const details = typeof error.details === 'object' && error.details !== null
    ? error.details as { field?: unknown }
    : {};
  return details.field === 'mediaItems';
}

export function saveMayHaveConsumedUploads(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const details = typeof error.details === 'object' && error.details !== null
    ? error.details as { field?: unknown; sent?: unknown }
    : {};
  // No answer: only a request that never left the device has certainly done nothing.
  if (error.status === 0) return details.sent !== false;
  return error.status >= 500 || details.field === 'sourceTools';
}

/**
 * Forgets the staged paths a failed save sent (`submitted`), on the draft as it
 * is now. Those items keep their local files, which the next publish uploads
 * again (`getMediaAwaitingUpload`); saved media and anything added since keep
 * what they have.
 */
export function forgetConsumedMediaUploads(draft: PostComposerDraft, submitted: PostComposerDraft): PostComposerDraft {
  const sentPaths = new Set(submitted.mediaItems.flatMap((item) => (
    !item.existingId && item.storagePath ? [item.storagePath] : []
  )));
  if (sentPaths.size === 0) return draft;
  return {
    ...draft,
    mediaItems: draft.mediaItems.map((item) => (
      !item.existingId && item.storagePath && sentPaths.has(item.storagePath) ? { ...item, storagePath: null } : item
    )),
  };
}

/** New media with no staged upload: the next publish uploads them from the device first. */
export function getMediaAwaitingUpload(items: PostComposerMediaItem[]): PostComposerMediaItem[] {
  return items.filter((item) => !item.existingId && !item.storagePath);
}

/**
 * Names the draft's media by what the post holds now. An edit save that sends
 * media deletes and re-inserts every media row of the post, so every id changes,
 * and the save can go through and still fail (`saveMayHaveConsumedUploads`); a
 * draft kept on the device from before such a save holds the old ids too. The
 * server refuses an id it no longer has on every save. Media is matched by its
 * key: what the post holds takes its row's id and drops its staged upload, which
 * that save used; what it does not hold goes as a new upload while it has a
 * staged upload or its file on the device, and is `lost` otherwise. Items that
 * change nothing stay the same objects, so a kept draft that matches the post
 * does not count as edited. The web composer's `withSavedMediaRows`.
 */
export function withSavedPostMedia(
  draft: PostComposerDraft,
  post: Parameters<typeof hydratePostComposerMediaItems>[0],
  hasDeviceFile: (uri: string) => boolean,
): { draft: PostComposerDraft; lost: PostComposerMediaItem[] } {
  const savedIdsByKey = new Map(hydratePostComposerMediaItems(post).flatMap((item) => (
    item.existingId ? [[item.mediaKey ?? item.id, item.existingId] as const] : []
  )));
  const lost: PostComposerMediaItem[] = [];
  const mediaItems = draft.mediaItems.map((item) => {
    const savedId = savedIdsByKey.get(item.mediaKey ?? item.id);
    if (savedId) {
      return savedId === item.existingId && !item.storagePath
        ? item
        : { ...item, existingId: savedId, ...(item.storagePath ? { storagePath: null } : {}) };
    }
    if (item.storagePath || (item.uri && hasDeviceFile(item.uri))) {
      return item.existingId ? { ...item, existingId: null } : item;
    }
    lost.push(item);
    return item;
  });

  return {
    draft: lost.length > 0
      ? applyPostComposerMediaRecoveryToDraft({ ...draft, mediaItems }, {
          reuploaded: new Map(),
          lost: new Set(lost.map((item) => item.id)),
        })
      : { ...draft, mediaItems },
    lost,
  };
}

const COMPOSER_MEDIA_NOUNS = { image: ['an image', 'images'], video: ['a video', 'videos'] } as const;

/**
 * Items named at the start of a sentence: by their file names, or by kind where a name says nothing, as
 * Android's photo picker names a picture after its media id ("1000333161.jpg").
 */
function listItems(items: PostComposerMediaItem[]) {
  return listFilesInSentence(
    items.map((item) => ({ fileName: item.name, kind: item.mediaKind })),
    COMPOSER_MEDIA_NOUNS,
    { sentenceStart: true },
  );
}

/** The message shown when recovery could not save everything. */
export function describeLostRecoveryMedia(lost: PostComposerMediaItem[]): string | null {
  if (lost.length === 0) {
    return null;
  }

  return `${listItems(lost)} could not be restored and ${lost.length === 1 ? 'was' : 'were'} removed. Add ${lost.length === 1 ? 'it' : 'them'} again before publishing.`;
}

/** The message shown when items still on the device could not be uploaded again; they stay in the draft. */
export function describeFailedRecoveryReuploads(failed: PostComposerMediaItem[]): string {
  return `${listItems(failed)} could not be re-uploaded. Remove and re-add ${failed.length === 1 ? 'it' : 'them'}, or try opening this draft again.`;
}
