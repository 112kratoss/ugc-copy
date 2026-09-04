export const FALLBACK_CMAKE_VERSION: string;

export function readReactNativeCmakeVersion(projectRoot: string): string | null;
export function resolveCmakeVersion(env: Record<string, string | undefined>, projectRoot: string): string;
export function shouldInstallCmake(env: Record<string, string | undefined>): boolean;
export function findSdkManager(sdkRoot: string, env?: Record<string, string | undefined>): string | null;
export function installAndroidCmake(options?: {
  env?: Record<string, string | undefined>;
  projectRoot?: string;
  log?: (line: string) => void;
}): { installed: boolean; reason?: string; version?: string };
