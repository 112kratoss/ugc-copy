import { MOBILE_CLIENT_COMPATIBILITY_POLICY } from '@/lib/mobile-client-compatibility';

/**
 * The first mobile release that verifies a restored draft's staged objects
 * still exist before allowing it to publish.
 */
export const ABANDONED_RECLAIM_SAFE_MINIMUM_APP_VERSION = '0.0.5';

export type MediaUploadReclaimPolicy = {
  /** Whether the operator set the rollout flag to its one accepted value. */
  flagConfigured: boolean;
  /** The code-controlled mobile compatibility floor used by the API. */
  minimumAppVersion: string;
  /** Whether never-consumed staged uploads may actually be reclaimed. */
  effectiveEnabled: boolean;
};

type SemanticVersion = {
  core: [number, number, number];
  prerelease: string | null;
};

function parseSemanticVersion(value: string): SemanticVersion | null {
  const match = value.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
  if (!match) return null;

  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  if (core.some((part) => !Number.isSafeInteger(part))) return null;

  const prerelease = match[4] ?? null;
  if (
    prerelease?.split('.').some((identifier) => /^\d+$/.test(identifier) && /^0\d+/.test(identifier))
  ) {
    return null;
  }

  return { core, prerelease };
}

function isAtLeastStableVersion(candidate: SemanticVersion, minimum: SemanticVersion): boolean {
  for (let index = 0; index < candidate.core.length; index += 1) {
    if (candidate.core[index] !== minimum.core[index]) {
      return candidate.core[index] > minimum.core[index];
    }
  }

  // The safety threshold is a stable release. A prerelease with the same core
  // is lower than that release and therefore cannot unlock destructive work.
  if (candidate.prerelease !== null && minimum.prerelease === null) return false;
  return true;
}

/**
 * Resolve the non-secret operational state for abandoned-upload reclaim.
 *
 * The environment flag is necessary but never sufficient: deleting staged
 * draft media is safe only after the code-controlled compatibility floor has
 * excluded mobile builds that cannot recover from missing draft objects.
 */
export function getMediaUploadReclaimPolicy(options: {
  environment?: Record<string, string | undefined>;
  minimumAppVersion?: string;
} = {}): MediaUploadReclaimPolicy {
  const environment = options.environment ?? process.env;
  const minimumAppVersion = options.minimumAppVersion
    ?? MOBILE_CLIENT_COMPATIBILITY_POLICY.minimumAppVersion;
  const flagConfigured = environment.MEDIA_UPLOAD_RECLAIM_ABANDONED === 'true';
  const parsedMinimum = parseSemanticVersion(minimumAppVersion);
  const safeMinimum = parseSemanticVersion(ABANDONED_RECLAIM_SAFE_MINIMUM_APP_VERSION);

  return {
    flagConfigured,
    minimumAppVersion,
    effectiveEnabled: Boolean(
      flagConfigured
      && parsedMinimum
      && safeMinimum
      && isAtLeastStableVersion(parsedMinimum, safeMinimum),
    ),
  };
}
