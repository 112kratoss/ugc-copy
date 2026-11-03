import { extractPromptHandles, remixDraftInputSlots, videoDraftHandles, videoDraftMentionedHandles, videoSubjects, type CreationDraft, type MediaDraft, type SubjectDraft, type VideoCreationDraft } from './media-creation-view-model';
import type { SeedanceAssetMetadata } from './model-catalog/seedance-assets';
import { signedStorageUrlExpiresAt } from './media-url-expiry';
import { remixInputSlotHandles } from './remix-input-slots/remix-input-slots';
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
 * So does a video draft holding a clip without a handle of its own while its
 * words mention one that nothing it holds answers to: until 2026-10-30 a restore
 * gave every clip none, though a Kling 3.0 run keeps the handle its prompt
 * mentions each clip by, and such a session was resumed as saved, held for good.
 * The catalog names such a clip as the draft lands on Kling 3.0, before its
 * source is read, so a clip under a stand-in (`handleStandIn`) still counts.
 */
export function needsRemixReferenceRecovery(draft: CreationDraft, clock?: ReferenceLinkClock): boolean {
  // The source could not read what it keeps back (2026-11-03 re-review): read again, whatever the words say.
  if (draft.inputSlotsUnread === true) return true;
  if (clock && hasExpiredLink(draft, clock)) return true;
  if (draft.tool === 'video' && missesClipHandles(draft)) return true;
  return missesReferences(draft);
}

/** The handles of a remix's empty slots: a mention of one was the creator's input kept to themselves, not one lost. */
function slotHandles(draft: CreationDraft): Set<string> {
  return new Set(remixInputSlotHandles(remixDraftInputSlots(draft)));
}

/**
 * A saved restore whose rail came back empty while its prompt still mentions what was on it. A
 * mention of an empty slot is not one: the source never gives that input, and its box asks for the
 * remixer's own, so reading the source again on every visit would bring nothing back.
 */
function missesReferences(draft: CreationDraft): boolean {
  if (draft.tool === 'motion' || draft.references.length > 0) return false;
  if (draft.tool === 'video' && (draft.startFrame || draft.endFrame || draft.referenceVideos.length > 0 || videoSubjects(draft).length > 0)) return false;
  const waiting = slotHandles(draft);
  return extractPromptHandles(draft.prompt).some((handle) => !waiting.has(handle));
}

/**
 * A clip without a handle of its own (none, or a stand-in the app made up for it), beside words (the
 * prompt or a shot) that mention one nothing in the draft answers to, an empty slot included.
 */
function missesClipHandles(draft: VideoCreationDraft): boolean {
  if (!draft.referenceVideos.some((clip) => !clip.handle || clip.handleStandIn)) return false;
  const held = new Set([...videoDraftHandles(draft), ...slotHandles(draft)]);
  return [...videoDraftMentionedHandles(draft)].some((handle) => !held.has(handle));
}

/**
 * A saved remix with the empty slots its source names now, where it was saved before slots
 * existed: a session that holds its own slots keeps them, as the remixer has filled them so far.
 */
function withSourceSlots(draft: CreationDraft, restored: CreationDraft): CreationDraft {
  if (draft.inputSlots !== undefined || draft.tool !== restored.tool) return draft;
  const slots = remixDraftInputSlots(restored);
  return slots.length > 0 ? { ...draft, inputSlots: [...slots] } : draft;
}

/**
 * A saved remix whose source could not read the inputs it keeps back, with what a read that could brings:
 * the copies a bought recipe holds, put where the session has nothing (what the remixer added since
 * stays theirs, as does a handle they took), and no longer marked unread. Its slots come with
 * `withSourceSlots`. A read that still could not is no answer: the session stays as it was.
 */
function withReadInputs(draft: CreationDraft, restored: CreationDraft): CreationDraft {
  if (draft.inputSlotsUnread !== true || restored.inputSlotsUnread === true || draft.tool !== restored.tool) return draft;
  const taken = new Set(heldDraftMedia(draft).flatMap((media) => (media.handle ? [media.handle] : [])));
  const missing = (current: readonly MediaDraft[], source: readonly MediaDraft[]) => [
    ...current,
    ...source.filter((media) => !current.some((held) => isSameMedia(held, media)) && !(media.handle && taken.has(media.handle))),
  ];
  const read = { ...draft };
  delete read.inputSlotsUnread;
  if (read.tool === 'image' && restored.tool === 'image') {
    return { ...read, references: missing(read.references, restored.references) };
  }
  if (read.tool === 'video' && restored.tool === 'video') {
    const subjects = videoSubjects(read);
    return {
      ...read,
      references: missing(read.references, restored.references),
      referenceVideos: missing(read.referenceVideos, restored.referenceVideos),
      referenceAudios: missing(read.referenceAudios, restored.referenceAudios),
      startFrame: read.startFrame ?? restored.startFrame,
      endFrame: read.endFrame ?? restored.endFrame,
      subjects: [...subjects, ...videoSubjects(restored).filter((subject) => !taken.has(subject.handle))],
    };
  }
  if (read.tool === 'motion' && restored.tool === 'motion') {
    return {
      ...read,
      characterImage: read.characterImage ?? restored.characterImage,
      referenceVideo: read.referenceVideo ?? restored.referenceVideo,
      // The run's length follows its clip, which the read brings where the session had none.
      duration: read.referenceVideo ? read.duration : restored.duration,
    };
  }
  return read;
}

/**
 * Repair a saved remix from its authorized source. The saved prompt and
 * settings stay, and so does every edit made since, removals included.
 *
 * Media still in the draft take the source's fresh link and nothing else, but
 * for a clip without a handle of its own: it takes back the handle its source
 * kept (never one the restore made up for it), unless something in the draft
 * answers to it by now. A clip under a stand-in (`handleStandIn`: named by the
 * catalog as the draft landed on Kling 3.0, before the source was read) takes it
 * back over the stand-in only where the words mention it and not the stand-in.
 * Either way the recovery settles a stand-in the source answered for: one it
 * leaves is the clip's own from then on. A clip the source left out (it could
 * not sign it this time) keeps its mark, so a later visit can still give it its
 * handle. A handle the creator gave stays. Missing images come back only while
 * the prompt still mentions them. A session saved before remixes had empty
 * slots takes the ones its source names now (`withSourceSlots`).
 */
export function recoverRemixReferences(current: CreationDraft, restored: CreationDraft): CreationDraft {
  const sourceMedia = heldDraftMedia(restored);
  const mentioned = current.tool === 'video' ? videoDraftMentionedHandles(current) : new Set<string>();
  const taken = new Set(heldDraftMedia(current).flatMap((media) => (media.handle ? [media.handle] : [])));
  const renewed = mapDraftMedia(withSourceSlots(withReadInputs(current, restored), restored), (media) => {
    const match = sourceMedia.find((candidate) => isSameMedia(media, candidate));
    const url = match?.url && match.url !== media.url ? match.url : media.url;
    const sourceHandle = media.kind === 'video' && match?.handle && !match.handleStandIn ? match.handle : null;
    const replaces = !media.handle
      || (Boolean(media.handleStandIn) && !mentioned.has(media.handle) && Boolean(sourceHandle && mentioned.has(sourceHandle)));
    const keptHandle = sourceHandle && replaces && !taken.has(sourceHandle) ? sourceHandle : null;
    if (keptHandle) taken.add(keptHandle);
    const settles = Boolean(match && media.handleStandIn);
    if (url === media.url && !keptHandle && !settles) return media;
    const next: MediaDraft = keptHandle ? { ...media, url, handle: keptHandle } : { ...media, url };
    if (settles) delete next.handleStandIn;
    return next;
  });
  if (!missesReferences(renewed) || renewed.tool === 'motion' || restored.tool === 'motion'
    || renewed.tool !== restored.tool || renewed.model !== restored.model) return renewed;
  const handles = new Set(extractPromptHandles(renewed.prompt));
  const references = restored.references.filter(reference => reference.handle && handles.has(reference.handle));
  return references.length ? { ...renewed, references } : renewed;
}

/**
 * The id a remix's original result takes as a reference (`remix-original-reference.ts`): one id
 * whichever visit adds it, so a renewed link and a resumed draft find it again. It is stored
 * nowhere of the creator's, so it is told apart by id, as `isSameMedia` tells such media.
 */
export function remixOriginalReferenceId(generationId: string): string {
  return `remix-result:${generationId}`;
}

/** A fresh link for saved media from its source read again, or null when the source no longer has it. */
export function remixSourceMediaUrl(bundle: RemixSourceBundle, media: MediaDraft): string | null {
  const { image, video, motion } = bundle.inputs;
  const candidates: { id?: string | null; storagePath?: string | null; url: string | null }[] = [
    { id: remixOriginalReferenceId(bundle.generation.id), url: bundle.result?.url ?? null },
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
