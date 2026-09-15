import { extractPromptHandles, type CreationDraft, type MediaDraft } from './media-creation-view-model';
import { signedStorageUrlExpiresAt } from './media-url-expiry';
import type { RemixSourceBundle } from './types';

/** A link with less than this left is treated as already gone. */
const LINK_EXPIRY_MARGIN_MS = 60_000;

export type ReferenceLinkClock = { now: number; storageBaseUrl: string };

/** Every piece of media a draft holds behind a link. */
function draftMedia(draft: CreationDraft): MediaDraft[] {
  const media = draft.tool === 'image'
    ? draft.references
    : draft.tool === 'video'
      ? [...draft.references, ...draft.referenceVideos, ...draft.referenceAudios, draft.startFrame, draft.endFrame]
      : [draft.characterImage, draft.referenceVideo];
  return media.filter((item): item is MediaDraft => Boolean(item));
}

/** The draft with `map` applied to each piece of media, and the same draft when nothing changed. */
function mapDraftMedia<T extends CreationDraft>(draft: T, map: (media: MediaDraft) => MediaDraft): T {
  const mapList = (list: MediaDraft[]) => {
    const next = list.map(map);
    return next.some((media, index) => media !== list[index]) ? next : list;
  };
  const mapOne = (media: MediaDraft | null) => (media ? map(media) : media);
  if (draft.tool === 'image') {
    const references = mapList(draft.references);
    return references === draft.references ? draft : { ...draft, references };
  }
  if (draft.tool === 'video') {
    const next = {
      references: mapList(draft.references),
      referenceVideos: mapList(draft.referenceVideos),
      referenceAudios: mapList(draft.referenceAudios),
      startFrame: mapOne(draft.startFrame),
      endFrame: mapOne(draft.endFrame),
    };
    const unchanged = next.references === draft.references
      && next.referenceVideos === draft.referenceVideos
      && next.referenceAudios === draft.referenceAudios
      && next.startFrame === draft.startFrame
      && next.endFrame === draft.endFrame;
    return unchanged ? draft : { ...draft, ...next };
  }
  const characterImage = mapOne(draft.characterImage);
  const referenceVideo = mapOne(draft.referenceVideo);
  return characterImage === draft.characterImage && referenceVideo === draft.referenceVideo
    ? draft
    : { ...draft, characterImage, referenceVideo };
}

/** The same media elsewhere: by where it is stored, or by id for media stored nowhere.
 *  Restored frames and clips get new ids on every restore; their storage path holds. */
function isSameMedia(saved: MediaDraft, candidate: { id?: string | null; storagePath?: string | null }) {
  return saved.storagePath ? candidate.storagePath === saved.storagePath : candidate.id === saved.id;
}

function hasExpiredLink(draft: CreationDraft, { now, storageBaseUrl }: ReferenceLinkClock) {
  return draftMedia(draft).some((media) => {
    const expiresAt = signedStorageUrlExpiresAt(media.url, storageBaseUrl);
    return expiresAt !== null && expiresAt - LINK_EXPIRY_MARGIN_MS <= now;
  });
}

/**
 * Whether a completed remix restore needs its source read again.
 *
 * An empty image rail can be a saved, failed restore. Normal reference removal
 * also removes its prompt handle, so do not retry drafts without mentions, or
 * drafts where the creator has supplied replacement inputs.
 *
 * Media still in the draft keep the signed links the restore handed out, and
 * those last an hour (audit A6). Given a clock, a link that has run out needs
 * the source too: reading it again is the only way to a fresh link for media
 * someone else owns.
 */
export function needsRemixReferenceRecovery(draft: CreationDraft, clock?: ReferenceLinkClock): boolean {
  if (clock && hasExpiredLink(draft, clock)) return true;
  if (draft.tool === 'motion' || draft.references.length > 0) return false;
  if (draft.tool === 'video' && (draft.startFrame || draft.endFrame || draft.referenceVideos.length > 0)) return false;
  return extractPromptHandles(draft.prompt).length > 0;
}

/**
 * Repair a saved remix from its authorized source. The saved prompt and
 * settings stay, and so does every edit made since, removals included.
 *
 * Media still in the draft take the source's fresh link and nothing else.
 * Missing images come back only while the prompt still mentions them.
 */
export function recoverRemixReferences(current: CreationDraft, restored: CreationDraft): CreationDraft {
  const sourceMedia = draftMedia(restored);
  const renewed = mapDraftMedia(current, (media) => {
    const match = sourceMedia.find((candidate) => isSameMedia(media, candidate));
    return match?.url && match.url !== media.url ? { ...media, url: match.url } : media;
  });
  if (!needsRemixReferenceRecovery(renewed) || renewed.tool === 'motion' || restored.tool === 'motion'
    || renewed.tool !== restored.tool || renewed.model !== restored.model) return renewed;
  const handles = new Set(extractPromptHandles(renewed.prompt));
  const references = restored.references.filter(reference => reference.handle && handles.has(reference.handle));
  return references.length ? { ...renewed, references } : renewed;
}

/** A fresh link for saved media from its source read again, or null when the source no longer has it. */
export function remixSourceMediaUrl(bundle: RemixSourceBundle, media: MediaDraft): string | null {
  const { image, video, motion } = bundle.inputs;
  const candidates: { id?: string | null; storagePath?: string | null; url: string | null }[] = [
    ...(image?.elements ?? []),
    ...(video?.elements ?? []),
    ...(video?.referenceVideos ?? []),
    ...(video?.referenceAudios ?? []),
    ...[video?.startFrame, video?.endFrame, motion?.characterImage, motion?.referenceVideo]
      .filter((asset): asset is NonNullable<typeof asset> => Boolean(asset)),
  ];
  return candidates.find((candidate) => candidate.url && isSameMedia(media, candidate))?.url ?? null;
}

/** The draft with one piece of media on a renewed link, and nothing else changed. */
export function replaceDraftMediaUrl<T extends CreationDraft>(draft: T, mediaId: string, url: string): T {
  return mapDraftMedia(draft, (media) => (media.id === mediaId && media.url !== url ? { ...media, url } : media));
}
