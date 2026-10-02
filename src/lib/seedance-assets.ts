export type SeedanceAssetKind = 'Image' | 'Video' | 'Audio';
export type SeedanceAssetStatus = 'idle' | 'processing' | 'active' | 'failed';

export interface SeedanceAssetMetadata {
  assetId: string | null;
  assetType: SeedanceAssetKind | null;
  status: SeedanceAssetStatus;
  sourceUrl: string | null;
  error: string | null;
  lastCheckedAt: string | null;
}

export interface SeedanceAssetCollections {
  images?: SeedanceAssetMetadata[];
  videos?: SeedanceAssetMetadata[];
  audios?: SeedanceAssetMetadata[];
}

export function createSeedanceAssetMetadata(
  overrides?: Partial<SeedanceAssetMetadata>
): SeedanceAssetMetadata {
  return {
    assetId: null,
    assetType: null,
    status: 'idle',
    sourceUrl: null,
    error: null,
    lastCheckedAt: null,
    ...overrides,
  };
}

export function isSeedance2VideoModelId(modelId: string): modelId is 'seedance-2' | 'seedance-2-fast' | 'seedance-2-mini' | 'seedance-2-5' {
  return modelId === 'seedance-2'
    || modelId === 'seedance-2-fast'
    || modelId === 'seedance-2-mini'
    || modelId === 'seedance-2-5';
}

export function getSeedanceAssetStatusLabel(status: SeedanceAssetStatus): string {
  if (status === 'processing') return 'Processing';
  if (status === 'active') return 'Active';
  if (status === 'failed') return 'Failed';
  return 'Idle';
}

/**
 * The file an asset's source points at, for display.
 *
 * `sourceUrl` is whatever the reference was last read from. Once a reference is
 * uploaded, or restored from a remix, that is a signed storage link, and its
 * token is several hundred characters with nowhere to break. Printed whole it
 * ran out of its box and across the page, and it showed a working link to the
 * file. The file name identifies the source just as well.
 *
 * A `blob:` or `data:` preview exists only in this browser, so nothing has been
 * uploaded yet and there is no source to name.
 */
export function getSeedanceAssetSourceName(sourceUrl: string | null | undefined): string | null {
  const value = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';
  if (!value || /^(blob|data):/i.test(value)) {
    return null;
  }

  const name = value.split(/[?#]/, 1)[0].split('/').filter(Boolean).pop();
  if (!name) {
    return null;
  }

  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export function normalizeSeedanceAssetStatus(value: unknown): SeedanceAssetStatus {
  if (typeof value !== 'string') {
    return 'processing';
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return 'processing';
  }

  if (
    normalized.includes('success')
    || normalized.includes('active')
    || normalized.includes('ready')
    || normalized.includes('completed')
    || normalized.includes('available')
  ) {
    return 'active';
  }

  if (
    normalized.includes('fail')
    || normalized.includes('error')
    || normalized.includes('reject')
    || normalized.includes('invalid')
  ) {
    return 'failed';
  }

  if (
    normalized.includes('processing')
    || normalized.includes('pending')
    || normalized.includes('queue')
    || normalized.includes('running')
    || normalized.includes('creating')
  ) {
    return 'processing';
  }

  return 'processing';
}

export function getPreferredSeedanceReferenceValue(
  sourceUrl: string | null,
  asset?: Partial<SeedanceAssetMetadata> | null
): string | null {
  const assetId = typeof asset?.assetId === 'string' ? asset.assetId.trim() : '';
  if (asset?.status === 'active' && assetId) {
    return assetId;
  }

  const normalizedUrl = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';
  return normalizedUrl || null;
}

export function hasSeedanceAssetCollections(value: SeedanceAssetCollections | null | undefined): boolean {
  if (!value) {
    return false;
  }

  return Boolean(
    (value.images && value.images.length > 0)
    || (value.videos && value.videos.length > 0)
    || (value.audios && value.audios.length > 0)
  );
}
