import type { PostComposerMediaItem } from './post-new-view-model';

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

/** The message shown when recovery could not save everything. */
export function describeLostRecoveryMedia(lost: PostComposerMediaItem[]): string | null {
  if (lost.length === 0) {
    return null;
  }

  const names = lost.map((item) => item.name).filter(Boolean);
  const subject = lost.length === 1 ? 'One item' : `${lost.length} items`;
  const detail = names.length > 0 ? ` (${names.join(', ')})` : '';
  return `${subject}${detail} could not be restored and ${lost.length === 1 ? 'was' : 'were'} removed. Add ${lost.length === 1 ? 'it' : 'them'} again before publishing.`;
}
