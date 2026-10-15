export function parseSemanticVersion(value: string | null | undefined): [number, number, number] | null {
  const match = value?.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function isAppVersionBelowMinimum(current: string, minimum: string) {
  const currentVersion = parseSemanticVersion(current);
  const minimumVersion = parseSemanticVersion(minimum);
  if (!currentVersion || !minimumVersion) return false;
  for (let index = 0; index < currentVersion.length; index += 1) {
    if (currentVersion[index] !== minimumVersion[index]) {
      return currentVersion[index] < minimumVersion[index];
    }
  }
  return false;
}

/** What a fresh read of the server's version floor says about this build. */
export type AppVersionFloorCheck = 'met' | 'below' | 'failed';

/**
 * Reads the server's version floor again and compares this build with it, for
 * the update screen's Check again (audit 04-10). `failed` when no usable
 * answer came back: nothing is known then, so the caller neither lets the
 * person through nor tells them they are still out of date.
 */
export async function checkAppVersionFloor(
  api: { getAppVersion: () => Promise<{ mobileCompatibility: { minimumAppVersion: string } }> },
  currentVersion: string,
): Promise<AppVersionFloorCheck> {
  let minimumAppVersion: string;
  try {
    minimumAppVersion = (await api.getAppVersion()).mobileCompatibility.minimumAppVersion;
  } catch {
    return 'failed';
  }
  if (typeof minimumAppVersion !== 'string') return 'failed';
  return isAppVersionBelowMinimum(currentVersion, minimumAppVersion) ? 'below' : 'met';
}
