import { createMediaDraftFromRemixAsset, type CreationDraft, type MediaDraft } from './media-creation-view-model';
import { heldDraftMedia, remixOriginalReferenceId, replaceDraftMediaUrl } from './remix-draft-recovery';
import type { CreatorToolId, RemixSourceBundle } from './types';

/**
 * A remix's original result, which its creator may use as a reference (owner, 2026-11-02: "add it,
 * on the mobile too", as the web's creators offer it). The start reads it once the server finds
 * they may remix the original (`resolveRemixResultMedia`), since the file is someone else's: the
 * post's showcase copy, or the private output of a creation with none.
 */
export type RemixOriginal = {
  generationId: string;
  mediaType: 'image' | 'video';
  url: string;
  /** A clip's length where its post has measured it, so using it needs no read of the clip. */
  durationSeconds?: number;
};

/** A length a source or a saved session gives, kept only where it is one. */
function measuredSeconds(value: unknown): Pick<RemixOriginal, 'durationSeconds'> {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? { durationSeconds: value } : {};
}

/** What the original's tile is called, as the web's creators call it. */
export const REMIX_ORIGINAL_NAME = 'Original result';

/** The original a remix source offers, or none where it could not hand out its result. */
export function remixOriginalOf(bundle: RemixSourceBundle): RemixOriginal | null {
  const url = bundle.result?.url?.trim();
  return bundle.result && url
    ? { generationId: bundle.generation.id, mediaType: bundle.result.mediaType, url, ...measuredSeconds(bundle.result.durationSeconds) }
    : null;
}

/**
 * The original a saved remix session kept, so a resumed session, which reads its source no more,
 * still offers it: null where the source had none to offer, and undefined where the session does not
 * say (saved by a build without it, or unreadable), which leaves the source to be asked once.
 */
export function storedRemixOriginal(value: unknown): RemixOriginal | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const { generationId, mediaType, url, durationSeconds } = value as Record<string, unknown>;
  return typeof generationId === 'string' && generationId && (mediaType === 'image' || mediaType === 'video') && typeof url === 'string' && url
    ? { generationId, mediaType, url, ...measuredSeconds(durationSeconds) }
    : undefined;
}

/**
 * Where the original goes in a creator: a picture among an image run's references, a clip among a
 * video run's reference clips, or as a motion run's clip, which it replaces as a picked clip does.
 * None where the creator takes that kind no other way (a picture in the video or motion creator).
 */
export type RemixOriginalPlace = 'references' | 'referenceVideos' | 'motionClip';

export function remixOriginalPlace(tool: CreatorToolId, original: RemixOriginal): RemixOriginalPlace | null {
  if (original.mediaType === 'image') return tool === 'image' ? 'references' : null;
  return tool === 'video' ? 'referenceVideos' : tool === 'motion' ? 'motionClip' : null;
}

/**
 * The original itself: under its id, still the creation's media and no file of the creator's. Replace
 * keeps a tile's id (and its name and @handle) while it puts the creator's own upload in its place.
 */
function isRemixOriginalMedia(media: MediaDraft, original: RemixOriginal): boolean {
  return media.id === remixOriginalReferenceId(original.generationId)
    && media.sourceGenerationId === original.generationId
    && !media.storagePath;
}

/** Whether the draft holds the original, wherever it went. */
export function holdsRemixOriginal(draft: CreationDraft, original: RemixOriginal): boolean {
  return heldDraftMedia(draft).some((media) => isRemixOriginalMedia(media, original));
}

/**
 * Whether a tile has the original's id but another file, put in its place by Replace: the original is
 * then neither in use nor added again under the same id until that tile goes.
 */
export function replacedRemixOriginal(draft: CreationDraft, original: RemixOriginal): boolean {
  const id = remixOriginalReferenceId(original.generationId);
  return heldDraftMedia(draft).some((media) => media.id === id && !isRemixOriginalMedia(media, original));
}

/**
 * The original as a reference: kept by its link and the creation it came from, under its one id.
 * Never with a storage path: the app reads one as the creator's own upload, signs it again as
 * theirs and checks it for being swept, and the server would refuse the path itself as not theirs.
 * A clip carries its length (its post's, or else the one the phone read), which the quote and the
 * slot's caps are told.
 */
export function remixOriginalMedia(original: RemixOriginal, durationSeconds = original.durationSeconds ?? null): MediaDraft {
  const media = createMediaDraftFromRemixAsset(
    { kind: original.mediaType, url: original.url, label: REMIX_ORIGINAL_NAME, sourceGenerationId: original.generationId, durationSeconds },
    REMIX_ORIGINAL_NAME,
  );
  // Made from a link, which an original always has.
  return { ...media!, id: remixOriginalReferenceId(original.generationId) };
}

/** The draft with the original on the link its source just handed out, where the draft holds it. */
export function withRenewedRemixOriginal<T extends CreationDraft>(draft: T, original: RemixOriginal | null): T {
  return original && holdsRemixOriginal(draft, original)
    ? replaceDraftMediaUrl(draft, remixOriginalReferenceId(original.generationId), original.url)
    : draft;
}
