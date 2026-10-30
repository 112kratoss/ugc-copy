import { extractPromptHandles, videoDraftHandles, videoSubjects, type CreationDraft, type MediaDraft, type SubjectDraft, type VideoCreationDraft } from './media-creation-view-model';
import type { SeedanceAssetMetadata } from './model-catalog/seedance-assets';
import { signedStorageUrlExpiresAt } from './media-url-expiry';
import type { RemixSourceBundle } from './types';

/** A link with less than this left is treated as already gone. */
const LINK_EXPIRY_MARGIN_MS = 60_000;

export type ReferenceLinkClock = { now: number; storageBaseUrl: string };

/**
 * Every piece of media a draft holds behind a link, sent with its run or not: its references,
 * clips and tracks, its frames, its subjects' pictures, and a motion draft's two inputs. A link
 * renewal and the swept-upload check reach each of them through this.
 */
export function heldDraftMedia(draft: CreationDraft): MediaDraft[] {
  const media = draft.tool === 'image'
    ? draft.references
    : draft.tool === 'video'
      ? [
          ...draft.references,
          ...draft.referenceVideos,
          ...draft.referenceAudios,
          draft.startFrame,
          draft.endFrame,
          ...videoSubjects(draft).flatMap((subject) => subject.images),
        ]
      : [draft.characterImage, draft.referenceVideo];
  return media.filter((item): item is MediaDraft => Boolean(item));
}

/** How many pieces of media a draft holds. Support diagnostics report the count, never the media. */
export function countDraftMedia(draft: CreationDraft): number {
  return heldDraftMedia(draft).length;
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
    const mapSubject = (subject: SubjectDraft) => {
      const images = mapList(subject.images);
      return images === subject.images ? subject : { ...subject, images };
    };
    const subjects = draft.subjects?.map(mapSubject);
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
      && next.endFrame === draft.endFrame
      && (subjects ?? []).every((subject, index) => subject === draft.subjects?.[index]);
    return unchanged ? draft : { ...draft, ...next, ...(subjects ? { subjects } : {}) };
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
  return heldDraftMedia(draft).some((media) => {
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
 *
 * So does a video draft holding a clip without a handle while its words mention
 * one that nothing it holds answers to: until 2026-10-30 a restore gave every
 * clip none, though a Kling 3.0 run keeps the handle its prompt mentions each
 * clip by, and such a session was resumed as saved, held for good.
 */
export function needsRemixReferenceRecovery(draft: CreationDraft, clock?: ReferenceLinkClock): boolean {
  if (clock && hasExpiredLink(draft, clock)) return true;
  if (draft.tool === 'video' && missesClipHandles(draft)) return true;
  return missesReferences(draft);
}

/** A saved restore whose rail came back empty while its prompt still mentions what was on it. */
function missesReferences(draft: CreationDraft): boolean {
  if (draft.tool === 'motion' || draft.references.length > 0) return false;
  if (draft.tool === 'video' && (draft.startFrame || draft.endFrame || draft.referenceVideos.length > 0 || videoSubjects(draft).length > 0)) return false;
  return extractPromptHandles(draft.prompt).length > 0;
}

/** A clip without a handle, beside words (the prompt or a shot) that mention one nothing in the draft answers to. */
function missesClipHandles(draft: VideoCreationDraft): boolean {
  if (!draft.referenceVideos.some((clip) => !clip.handle)) return false;
  const held = new Set(videoDraftHandles(draft));
  return [draft.prompt, ...draft.multiPrompts.map((shot) => shot.prompt)]
    .some((words) => extractPromptHandles(words).some((handle) => !held.has(handle)));
}

/**
 * Repair a saved remix from its authorized source. The saved prompt and
 * settings stay, and so does every edit made since, removals included.
 *
 * Media still in the draft take the source's fresh link and nothing else, but
 * for a clip saved without the handle its source kept: it takes that handle
 * back, unless something else in the draft answers to it by now.
 * Missing images come back only while the prompt still mentions them.
 */
export function recoverRemixReferences(current: CreationDraft, restored: CreationDraft): CreationDraft {
  const sourceMedia = heldDraftMedia(restored);
  const taken = new Set(heldDraftMedia(current).flatMap((media) => (media.handle ? [media.handle] : [])));
  const renewed = mapDraftMedia(current, (media) => {
    const match = sourceMedia.find((candidate) => isSameMedia(media, candidate));
    const url = match?.url && match.url !== media.url ? match.url : media.url;
    const keptHandle = media.kind === 'video' && !media.handle && match?.handle && !taken.has(match.handle) ? match.handle : null;
    if (keptHandle) taken.add(keptHandle);
    if (url === media.url && !keptHandle) return media;
    return keptHandle ? { ...media, url, handle: keptHandle } : { ...media, url };
  });
  if (!missesReferences(renewed) || renewed.tool === 'motion' || restored.tool === 'motion'
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
    ...(video?.subjects ?? []).flatMap((subject) => subject.images ?? []),
    ...[video?.startFrame, video?.endFrame, motion?.characterImage, motion?.referenceVideo]
      .filter((asset): asset is NonNullable<typeof asset> => Boolean(asset)),
  ];
  return candidates.find((candidate) => candidate.url && isSameMedia(media, candidate))?.url ?? null;
}

/** The draft with one piece of media on a renewed link, and nothing else changed. */
export function replaceDraftMediaUrl<T extends CreationDraft>(draft: T, mediaId: string, url: string): T {
  return mapDraftMedia(draft, (media) => (media.id === mediaId && media.url !== url ? { ...media, url } : media));
}

/** The reference with that id carrying what Seedance now holds for it; the draft is untouched when it is not there. */
export function replaceDraftMediaSeedanceAsset<T extends CreationDraft>(draft: T, mediaId: string, seedanceAsset: SeedanceAssetMetadata | null): T {
  return mapDraftMedia(draft, (media) => (media.id === mediaId ? { ...media, seedanceAsset } : media));
}
