export function resolveExpectedValues(
  systemEnv?: Record<string, string | undefined>,
): Record<string, string>;

export function findBundledEnvProblems(
  bundleText: string,
  expected: Record<string, string>,
): string[];
