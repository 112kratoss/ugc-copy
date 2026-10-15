export const MOBILE_CLIENT_HEADERS = {
  client: 'x-magicbooklet-client',
  appVersion: 'x-magicbooklet-app-version',
  apiVersion: 'x-magicbooklet-api-version',
  minimumApiVersion: 'x-magicbooklet-min-api-version',
  minimumAppVersion: 'x-magicbooklet-min-app-version',
  catalogSchemaVersion: 'x-magicbooklet-catalog-schema-version',
} as const;

export const MOBILE_CLIENT_COMPATIBILITY_POLICY = {
  currentApiVersion: 1,
  minimumApiVersion: 1,
  // 0.1.7 is the first store build with the AI-data consent gate (#209,
  // 2026-09-25): the 0.1.5 installs on both stores send prompts and photos to
  // the AI services without it, and no OTA reaches their runtimes. An
  // identified client below the floor receives 426 MOBILE_UPDATE_REQUIRED and
  // the app's update screen sends it to the store (owner's decision D7 of the
  // 2026-10-15 auth and pricing pass). The floor also keeps the older
  // guarantee: it must never drop below 0.0.5, the first build that verifies a
  // restored draft's staged objects before publishing, or abandoned
  // staged-upload reclaim turns off again even with its environment flag set
  // -- see media-upload-reclaim-policy.ts.
  minimumAppVersion: '0.1.7',
  supportedCatalogSchemaVersions: [1, 2, 3],
  unversionedClientsUseApiVersion: 1,
} as const;

/**
 * The server's critical-update lever, served on `/api/app-version`. An OTA
 * published for one of `runtimeVersions` at or after `publishedAfter` is
 * critical: the app offers the restart as soon as it has downloaded it, instead
 * of waiting for the next cold start or a long absence. The app sends neither
 * its platform nor its runtime, so the list names every binary the fix was
 * published to (Android and iOS run different runtimes) and each app looks for
 * its own.
 */
export type MobileCriticalUpdate = {
  runtimeVersions: string[];
  publishedAfter: string;
};

export type MobileCriticalUpdateEnvironment = {
  MOBILE_CRITICAL_UPDATE_RUNTIME?: string;
  MOBILE_CRITICAL_UPDATE_AFTER?: string;
};

// A runtime version as expo-updates reports it: the fingerprint hash under the
// app's fingerprint policy (ugc-mobile/ota-targets.json), a version string
// under any other. Commas separate the entries; a space inside one is a paste
// error.
const RUNTIME_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
// A time without an offset would be read in the server's own time zone.
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Both variables or nothing: a missing or malformed value serves `null`, which
 * leaves every update routine rather than flagging the wrong ones. The runtime
 * variable is a comma-separated list: empty entries are dropped, one malformed
 * entry voids the list, and a list left empty is missing.
 */
export function readMobileCriticalUpdate(
  environment: MobileCriticalUpdateEnvironment,
): MobileCriticalUpdate | null {
  const runtimeVersions = (environment.MOBILE_CRITICAL_UPDATE_RUNTIME ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const publishedAfter = environment.MOBILE_CRITICAL_UPDATE_AFTER?.trim() ?? '';
  if (
    runtimeVersions.length === 0
    || !runtimeVersions.every((runtimeVersion) => RUNTIME_VERSION_PATTERN.test(runtimeVersion))
    || !ISO_INSTANT_PATTERN.test(publishedAfter)
  ) {
    return null;
  }

  const publishedAfterMs = Date.parse(publishedAfter);
  if (!Number.isFinite(publishedAfterMs)) return null;
  return { runtimeVersions, publishedAfter: new Date(publishedAfterMs).toISOString() };
}

export type MobileCompatibilityErrorCode =
  | 'MOBILE_UPDATE_REQUIRED'
  | 'MOBILE_SERVER_UPDATE_REQUIRED';

export type MobileClientCompatibilityResult =
  | { allowed: true; legacy: boolean }
  | {
      allowed: false;
      status: 409 | 426;
      code: MobileCompatibilityErrorCode;
      message: string;
    };

function parseVersionNumber(value: string | null, fallback: number): number {
  if (value === null || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseSemanticVersion(value: string | null): [number, number, number] | null {
  const match = value?.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemanticVersions(left: [number, number, number], right: [number, number, number]) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function isIdentifiedMobileClient(headers: Headers): boolean {
  return headers.get(MOBILE_CLIENT_HEADERS.client)?.trim().toLowerCase() === 'mobile';
}

export function evaluateMobileClientCompatibility(
  headers: Headers,
): MobileClientCompatibilityResult {
  if (!isIdentifiedMobileClient(headers)) {
    return { allowed: true, legacy: true };
  }

  const policy = MOBILE_CLIENT_COMPATIBILITY_POLICY;
  const requestedApiVersion = parseVersionNumber(
    headers.get(MOBILE_CLIENT_HEADERS.apiVersion),
    policy.unversionedClientsUseApiVersion,
  );
  const requestedCatalogSchemaVersion = parseVersionNumber(
    headers.get(MOBILE_CLIENT_HEADERS.catalogSchemaVersion),
    policy.supportedCatalogSchemaVersions[0],
  );
  const appVersion = parseSemanticVersion(headers.get(MOBILE_CLIENT_HEADERS.appVersion));
  const minimumAppVersion = parseSemanticVersion(policy.minimumAppVersion) as [number, number, number];

  if (
    requestedApiVersion < policy.minimumApiVersion
    || requestedCatalogSchemaVersion < policy.supportedCatalogSchemaVersions[0]
    || (appVersion && compareSemanticVersions(appVersion, minimumAppVersion) < 0)
  ) {
    return {
      allowed: false,
      status: 426,
      code: 'MOBILE_UPDATE_REQUIRED',
      message: 'Update Magicbooklet to continue using this service.',
    };
  }

  if (
    requestedApiVersion > policy.currentApiVersion
    || !policy.supportedCatalogSchemaVersions.includes(requestedCatalogSchemaVersion as 1 | 2 | 3)
  ) {
    return {
      allowed: false,
      status: 409,
      code: 'MOBILE_SERVER_UPDATE_REQUIRED',
      message: 'The service is updating for this app version. Please retry shortly.',
    };
  }

  return {
    allowed: true,
    legacy: !appVersion,
  };
}

export function createMobileCompatibilityResponseHeaders(): Record<string, string> {
  const policy = MOBILE_CLIENT_COMPATIBILITY_POLICY;
  const currentCatalogSchemaVersion = policy.supportedCatalogSchemaVersions[
    policy.supportedCatalogSchemaVersions.length - 1
  ];
  return {
    [MOBILE_CLIENT_HEADERS.apiVersion]: String(policy.currentApiVersion),
    [MOBILE_CLIENT_HEADERS.minimumApiVersion]: String(policy.minimumApiVersion),
    [MOBILE_CLIENT_HEADERS.minimumAppVersion]: policy.minimumAppVersion,
    [MOBILE_CLIENT_HEADERS.catalogSchemaVersion]: String(currentCatalogSchemaVersion),
  };
}
