/**
 * Seedance reference assets: the shape both creators keep beside a reference
 * and the rule for what a run sends in its place.
 *
 * Kie's `bytedance/seedance-2-asset` task takes an uploaded file once and
 * answers with an asset id; the Seedance 2 family's `reference_*_urls` then
 * accept that id in place of the file's URL, so a reference prepared once is
 * reused on every run instead of being fetched and processed again, and a file
 * the provider rejects is known before a run is paid for. The web creator and
 * the native creator both keep this metadata on a reference and both apply
 * `getPreferredSeedanceReferenceValue` when they build a run, which is why it
 * lives here with the other modules the two workspaces share: no React Native,
 * Expo or Node imports, so Metro, Next.js and Vitest all compile it.
 */
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

/**
 * Asset metadata read back from a saved draft or a remix bundle's workflow
 * settings, where it is untyped. Anything that is not an object with a known
 * status is treated as "never prepared".
 */
export function readSeedanceAssetMetadata(value: unknown): SeedanceAssetMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const status = record.status;
  if (status !== 'idle' && status !== 'processing' && status !== 'active' && status !== 'failed') {
    return null;
  }

  const assetType = record.assetType;
  return createSeedanceAssetMetadata({
    assetId: typeof record.assetId === 'string' && record.assetId.trim() ? record.assetId.trim() : null,
    assetType: assetType === 'Image' || assetType === 'Video' || assetType === 'Audio' ? assetType : null,
    status,
    sourceUrl: typeof record.sourceUrl === 'string' && record.sourceUrl.trim() ? record.sourceUrl : null,
    error: typeof record.error === 'string' && record.error.trim() ? record.error : null,
    lastCheckedAt: typeof record.lastCheckedAt === 'string' && record.lastCheckedAt.trim() ? record.lastCheckedAt : null,
  });
}

/**
 * The collections a run recorded (`workflowSettings.seedanceAssets`), each list
 * kept at its full length so an entry still pairs with its reference by index:
 * an unreadable entry becomes null rather than closing the gap.
 */
export function readSeedanceAssetCollections(
  value: unknown
): { images: Array<SeedanceAssetMetadata | null>; videos: Array<SeedanceAssetMetadata | null>; audios: Array<SeedanceAssetMetadata | null> } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const readList = (list: unknown) => (Array.isArray(list) ? list.map(readSeedanceAssetMetadata) : []);
  return {
    images: readList(record.images),
    videos: readList(record.videos),
    audios: readList(record.audios),
  };
}
