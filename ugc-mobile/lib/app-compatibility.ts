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
