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
