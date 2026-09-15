import type { PersistGenerationInputCandidate } from '@/lib/generation-input-media';
import type { CatalogGenerationInputAsset } from '@/lib/generation-model-adapters';

type ResolvedCatalogInput = CatalogGenerationInputAsset & { url: string | null };
type GenerationInputRole = PersistGenerationInputCandidate['role'];

/**
 * The role a catalog input is kept under. Roles are what every reader keys on:
 * remix restores a motion generation from `character_image` and
 * `motion_reference_video`, and the owner and paywall views label inputs by
 * role. A motion model's slots are plainly an image and a video, so for motion
 * the slot decides, as the legacy motion start always did.
 */
function catalogInputRole(operationKind: string, asset: ResolvedCatalogInput, mediaType: PersistGenerationInputCandidate['mediaType']): GenerationInputRole {
  if (operationKind === 'motion' && asset.slot === 'characterImage') return 'character_image';
  if (operationKind === 'motion' && asset.slot === 'referenceVideo') return 'motion_reference_video';
  if (mediaType === 'video') return 'reference_video';
  if (mediaType === 'audio') return 'reference_audio';
  if (asset.slot === 'startFrame') return 'start_frame';
  if (asset.slot === 'endFrame') return 'end_frame';
  if (asset.kind === 'character') return 'character_image';
  return 'reference_image';
}

/** The durable input rows a catalog-path generation keeps: one per input that resolved to media. */
export function buildCatalogInputMediaCandidates(
  operationKind: string,
  inputs: ResolvedCatalogInput[],
): PersistGenerationInputCandidate[] {
  // Reference images are numbered per media type so their labels read the same as
  // the legacy path's ("Reference image 1"), which downstream remix and creation
  // views display verbatim.
  let referenceImageOrdinal = 0;
  return inputs.flatMap((asset, index) => {
    if (!asset.url) return [];
    const mediaType = asset.kind === 'video'
      ? 'video'
      : asset.kind === 'audio'
        ? 'audio'
        : 'image';
    const role = catalogInputRole(operationKind, asset, mediaType);
    if (role === 'reference_image') referenceImageOrdinal += 1;
    return [{
      mediaType,
      role,
      label: asset.label
        ?? (role === 'reference_image' ? `Reference image ${referenceImageOrdinal}` : asset.slot),
      sourceUrl: asset.url,
      sourceStoragePath: asset.storagePath ?? null,
      sourceGenerationId: asset.sourceGenerationId ?? null,
      sortOrder: index,
      // Element identity must survive: toRemixImageElement reads id/displayName/handle
      // back out of this metadata, and without them remix falls back to the row id
      // and loses the name the user gave the reference.
      metadata: {
        slot: asset.slot,
        ...(asset.elementId ? { id: asset.elementId } : {}),
        ...(asset.label ? { displayName: asset.label } : {}),
        ...(asset.handle ? { handle: asset.handle } : {}),
        ...(typeof asset.durationSeconds === 'number'
          ? { durationSeconds: asset.durationSeconds }
          : {}),
      },
    } satisfies PersistGenerationInputCandidate];
  });
}
