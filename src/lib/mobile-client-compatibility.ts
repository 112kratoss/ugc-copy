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
  // 0.0.5 is the first build that verifies a restored draft's staged objects
  // still exist before publishing. Older builds restore a composer draft
  // without that check, so reclaiming its media fails the publish with no
  // recovery path. Raising the floor retires them: an identified client below
  // it receives 426 MOBILE_UPDATE_REQUIRED and can never reach that state,
  // which is what unlocks abandoned staged-upload reclaim. Rolling this back
  // below 0.0.5 disables that reclaim again even if the environment flag
  // stays set -- see media-upload-reclaim-policy.ts.
  minimumAppVersion: '0.0.5',
  supportedCatalogSchemaVersions: [1, 2, 3],
  unversionedClientsUseApiVersion: 1,
} as const;

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
