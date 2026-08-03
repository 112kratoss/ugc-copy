/**
 * Reclaim policy for staged media uploads.
 *
 * `uploads` is a shared staging bucket: the post composer and the generation
 * input pipeline both sign objects into it, and both copy the bytes elsewhere
 * once the work is claimed. Nothing removed the objects that were never claimed,
 * so an abandoned composer draft -- and every generation input, which was copied
 * into `generation_inputs` and then forgotten -- left a permanent copy behind.
 *
 * `media_upload_intents` records what was signed and what claimed it. This
 * module decides, for an unclaimed intent, whether it is safe to delete. It is
 * deliberately pure so the decision can be unit-tested without storage or a
 * database.
 */

export const SIGNED_UPLOAD_EXPIRES_IN_SECONDS = 2 * 60 * 60;

/**
 * How long an uploaded-but-unclaimed object is kept.
 *
 * Web signs, uploads, and publishes within one submit handler, so anything that
 * survives a day was abandoned. Mobile uploads at media-pick time and can resume
 * a draft later, but a resuming draft re-verifies its storage paths and
 * re-uploads whatever is missing, so a reclaimed object costs a re-upload rather
 * than a failed publish.
 *
 * That re-verification is what makes this number safe, and it only exists in
 * builds that shipped it -- see MEDIA_UPLOAD_RECLAIM_ABANDONED in
 * media-upload-reclaim-service.ts, which gates the never-consumed half on
 * adoption rather than relying on a larger constant here. No upload-age TTL can
 * protect the old builds:
 * they refresh a draft's expiry every time the composer is opened, so a draft
 * can outlive its media by an unbounded margin.
 */
export const RECLAIM_AFTER_HOURS = 48;

export type UploadIntentKind = 'image' | 'video' | 'audio';

export type UploadIntentConsumer =
  | 'post_publish'
  | 'post_update'
  | 'generation_input'
  | 'generation_restore';

/**
 * An intent whose staged object has not been deleted yet.
 *
 * Being *consumed* and having its storage *cleared* are separate facts. The post
 * paths copy the bytes and delete the staging object in the same request, so
 * they arrive here already cleared and never appear. The generation input path
 * deliberately leaves the object behind -- a second generation started from the
 * same unchanged picker selection re-sends the same staged path -- so it is
 * consumed but not cleared, and the sweep is what eventually collects it.
 */
export type UnclearedUploadIntent = {
  storagePath: string;
  kind: UploadIntentKind;
  /** What the client declared at sign time; the object may be smaller or absent. */
  declaredBytes: number | null;
  createdAt: string;
  /** Null when nothing ever claimed these bytes -- an abandoned composer draft. */
  consumedBy: UploadIntentConsumer | null;
  /**
   * False when the signed URL expired without the object ever being written --
   * there are no bytes to reclaim, only a stale row.
   */
  objectExists: boolean;
};

export type ReclaimDecision =
  | { action: 'keep'; reason: string }
  /** Delete the storage object, then the row. */
  | { action: 'reclaim'; reason: string }
  /** No object was ever written; drop the row without touching storage. */
  | { action: 'drop-row'; reason: string };

/** Age in hours, exposed so the policy and its tests agree on the arithmetic. */
export function getUploadIntentAgeHours(intent: UnclearedUploadIntent, now: Date): number {
  const createdAt = Date.parse(intent.createdAt);
  if (!Number.isFinite(createdAt)) {
    return 0;
  }

  return (now.getTime() - createdAt) / (60 * 60 * 1000);
}

/**
 * Decide what to do with an intent whose staged object still exists.
 *
 * Every branch names its reason because the sweep logs it, and that log is how
 * an operator tells "working as intended" from "deleting live drafts".
 *
 * Which intents reach this function is the caller's decision, not this one's --
 * the sweep withholds never-consumed rows until the mobile fix has rolled out.
 * See selectReclaimableIntents in media-upload-reclaim-service.ts.
 *
 * Deliberately not kind-aware: a 250 MB video and a 25 KB image differ by four
 * orders of magnitude in cost, but reclaiming video sooner buys at most 46 hours
 * of storage on objects that are already rare. Revisit if the sweep's reported
 * byte totals say otherwise.
 */
export function resolveUploadIntentReclaim(
  intent: UnclearedUploadIntent,
  now: Date,
): ReclaimDecision {
  const ageHours = getUploadIntentAgeHours(intent, now);

  // An unwritten object cannot become written once the signed URL lapses, so the
  // row is garbage well before the storage TTL would apply. There is nothing to
  // delete, which is why this is cheap enough to do early.
  if (!intent.objectExists) {
    return ageHours >= SIGNED_UPLOAD_EXPIRES_IN_SECONDS / 3600
      ? { action: 'drop-row', reason: 'signed_url_expired_without_upload' }
      : { action: 'keep', reason: 'signed_url_still_valid' };
  }

  if (ageHours < RECLAIM_AFTER_HOURS) {
    return { action: 'keep', reason: 'within_reclaim_window' };
  }

  return {
    action: 'reclaim',
    reason: `${intent.consumedBy ?? 'unclaimed'}_after_${Math.floor(ageHours)}h`,
  };
}
