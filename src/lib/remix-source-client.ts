import { createElementId, type ImageElementDescriptor } from '@/lib/image-elements';
import type {
  RemixMediaAssetDescriptor,
  RemixResolvedAsset,
  RemixResolvedImageElement,
  RemixSourceBundle,
} from '@/lib/remix-source';
import {
  parseRemixInputSlots,
  type RemixInputSlot,
} from '../../ugc-mobile/lib/remix-input-slots/remix-input-slots';

export interface RemixElementSeed extends ImageElementDescriptor {
  previewUrl: string;
  providerUrl: string | null;
  source: 'remix';
}

export interface RestoredRemixAssetState {
  url: string;
  descriptor: RemixMediaAssetDescriptor;
}

/**
 * The run's references a remix can bring back, the first `limit` of those with a link: one
 * whose media could not be restored leaves its place to the next.
 */
export function createRemixElementSeeds(
  elements: RemixResolvedImageElement[],
  limit = elements.length
): RemixElementSeed[] {
  return elements
    .filter((element): element is RemixResolvedImageElement & { url: string } => typeof element.url === 'string' && element.url.length > 0)
    .slice(0, limit)
    .map((element) => ({
      id: element.id,
      displayName: element.displayName,
      handle: element.handle,
      previewUrl: element.url,
      providerUrl: element.url,
      storagePath: element.storagePath ?? null,
      sourceGenerationId: element.sourceGenerationId ?? null,
      source: 'remix',
    }));
}

/**
 * What a remix says when its model now takes fewer reference images than the run used, as
 * Nano Banana 2 (14 to 10) and MiniMax H3 (9 to 5) did on 2026-10-20. The first `limit` come
 * back (`createRemixElementSeeds`); the rest were dropped without a word before. Null when
 * nothing was left out.
 */
export function getRemixReferenceCapWarning(
  elements: RemixResolvedImageElement[],
  limit: number,
  modelName: string,
): string | null {
  const usable = elements.filter((element) => typeof element.url === 'string' && element.url.length > 0).length;
  const restored = createRemixElementSeeds(elements, limit).length;
  if (usable <= restored) return null;
  return `${modelName} takes up to ${limit} reference image${limit === 1 ? '' : 's'}, so ${restored} of this run's ${usable} came back.`;
}

/**
 * Two remix notices, one after the other (a restore problem and a model cap, in the order
 * they were found), each said once.
 */
export function joinRemixRestoreWarnings(current: string | null, next: string | null): string | null {
  if (!next || current?.includes(next)) return current;
  return current ? `${current} ${next}` : next;
}

export function createRestoredRemixAssetState(
  asset: RemixResolvedAsset | null
): RestoredRemixAssetState | null {
  if (!asset?.url) {
    return null;
  }

  return {
    url: asset.url,
    descriptor: {
      kind: asset.kind,
      label: asset.label ?? null,
      storagePath: asset.storagePath ?? null,
      sourceGenerationId: asset.sourceGenerationId ?? null,
    },
  };
}

export function getRemixResultReferenceLabel(title: string): string {
  const trimmedTitle = title.trim();
  return `Original result${trimmedTitle ? ` · ${trimmedTitle}` : ''}`;
}

/**
 * Whether a reference is the remix's original result as "Use as reference" adds it, in any of
 * the creators: kept by its link under the creation it came from, never a file of the creator's
 * own (a Replace puts their upload in its place). Not by its name, which the image creator's
 * tiles rename in place, nor by its link, which is signed anew.
 */
export function isRemixResultReference(
  reference: { sourceGenerationId?: string | null; storagePath?: string | null } | null | undefined,
  generationId: string | null | undefined,
): boolean {
  return Boolean(generationId && reference?.sourceGenerationId === generationId && !reference.storagePath);
}

/**
 * The original's result as a reference picture, drawn and sent by `resultUrl`: the bundle's own
 * link, or one renewed for it once that link's hour is up (`useRemixLinkRenewal`).
 */
export function createRemixResultReferenceElement(
  bundle: RemixSourceBundle,
  resultUrl: string | null = bundle.result?.url ?? null,
): RemixElementSeed | null {
  if (bundle.result?.mediaType !== 'image' || !resultUrl) {
    return null;
  }

  return {
    id: createElementId(),
    displayName: getRemixResultReferenceLabel(bundle.generation.title),
    handle: '@original_result',
    previewUrl: resultUrl,
    providerUrl: resultUrl,
    storagePath: null,
    sourceGenerationId: bundle.generation.id,
    source: 'remix',
  };
}

/** What a remix says when some of the run's media could not be brought back. */
export const REMIX_RESTORE_WARNING =
  'Some source media could not be restored automatically, so you may need to re-add a few references.';

export function getRemixRestoreWarning(issues: string[]): string | null {
  if (issues.length === 0) {
    return null;
  }

  return REMIX_RESTORE_WARNING;
}

/**
 * The remix notice's words: where the settings came from, then what could not be restored. The
 * inputs the creator kept to themselves are no restore failure: their empty boxes have a notice of
 * their own (`StudioRemixSlotsNotice`, `remixInputSlotsNotice`), which the remixer can put away for
 * the rest of the remix while this one, with the original and Use as reference, stays.
 */
export function getRemixNoticeDescription(title: string | null, restoreWarning: string | null): string {
  return [
    `Settings pre-filled from ${title ? `"${title}"` : 'the original creation'}.`,
    restoreWarning,
  ].filter(Boolean).join(' ');
}

/**
 * The inputs a remix is not given, as empty slots for the remixer's own (owner, 2026-11-03):
 * what the bundle names, anything malformed left out. A creator keeps them beside its form
 * and never persists, prices or sends them; a slot leaves the list once its box is filled.
 */
export function readRemixInputSlots(bundle: Pick<RemixSourceBundle, 'inputSlots'>): RemixInputSlot[] {
  return parseRemixInputSlots(bundle.inputSlots);
}

/** The slots once `slotId`'s box is filled. */
export function withoutRemixInputSlot(slots: readonly RemixInputSlot[], slotId: string): RemixInputSlot[] {
  return slots.filter((slot) => slot.id !== slotId);
}

/**
 * The side the video creator's inputs open on for a remix's slots: References where a picture,
 * clip or track waits there (which, on a model that keeps its start image beside its references,
 * shows a start frame's box too), Frames where only a frame's box does, else null, for the
 * bundle's own side. Kling 3.0's clips are named video elements beside either side, so they
 * choose none (`clipsBesideSides`), and on any other model a clip the prompt names by its handle
 * has no place at all (`remixInputSlotPlaced`), so it chooses none either.
 */
export function remixSlotsInputSide(
  slots: readonly Pick<RemixInputSlot, 'role' | 'handle'>[],
  { clipsBesideSides }: { clipsBesideSides: boolean },
): 'frames' | 'references' | null {
  const onReferences = slots.some((slot) => (
    slot.role === 'reference_image'
    || slot.role === 'reference_audio'
    || (slot.role === 'reference_video' && !clipsBesideSides && !slot.handle)
  ));
  if (onReferences) return 'references';
  return slots.some((slot) => slot.role === 'start_frame' || slot.role === 'end_frame') ? 'frames' : null;
}
