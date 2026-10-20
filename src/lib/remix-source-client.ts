import { createElementId, type ImageElementDescriptor } from '@/lib/image-elements';
import type {
  RemixMediaAssetDescriptor,
  RemixResolvedAsset,
  RemixResolvedImageElement,
  RemixSourceBundle,
} from '@/lib/remix-source';

export interface RemixElementSeed extends ImageElementDescriptor {
  previewUrl: string;
  providerUrl: string | null;
  source: 'remix';
}

export interface RestoredRemixAssetState {
  url: string;
  descriptor: RemixMediaAssetDescriptor;
}

export function createRemixElementSeeds(
  elements: RemixResolvedImageElement[],
  limit = elements.length
): RemixElementSeed[] {
  return elements
    .slice(0, limit)
    .filter((element): element is RemixResolvedImageElement & { url: string } => typeof element.url === 'string' && element.url.length > 0)
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

/** Two remix notices, one after the other: a restore problem and a model cap. */
export function joinRemixRestoreWarnings(current: string | null, next: string | null): string | null {
  if (!next) return current;
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

export function createRemixResultReferenceElement(bundle: RemixSourceBundle): RemixElementSeed | null {
  if (bundle.result?.mediaType !== 'image' || !bundle.result.url) {
    return null;
  }

  return {
    id: createElementId(),
    displayName: getRemixResultReferenceLabel(bundle.generation.title),
    handle: '@original_result',
    previewUrl: bundle.result.url,
    providerUrl: bundle.result.url,
    storagePath: null,
    sourceGenerationId: bundle.generation.id,
    source: 'remix',
  };
}

export function getRemixRestoreWarning(issues: string[]): string | null {
  if (issues.length === 0) {
    return null;
  }

  return 'Some source media could not be restored automatically, so you may need to re-add a few references.';
}
