export type Platform = 'ios' | 'android';

export interface PublishOtaOptions {
  platforms: Platform[];
  ref: string;
  message: string | null;
  rollout: number | null;
  expect: string[];
  artifactsDir: string | null;
  targetsFile: string | null;
  publish: boolean;
  allowUnmerged: boolean;
  allowRollback: boolean;
  allowRepublish: boolean;
  keepWorktree: boolean;
}

export interface BundleCheck {
  ok: boolean;
  label: string;
}

export const REQUIRED_PRODUCTION_CLIENT_ENV: string[];
export const FORBIDDEN_BUNDLE_STRINGS: string[];
export const MAX_DEBUG_INFO_BYTES: number;

export function parseArgs(argv: string[]): PublishOtaOptions;
export function assertAsciiMarker(marker: string): void;
export function setAsideFor(targets: Record<string, { setAside?: unknown }> | undefined, platform: Platform): string[];
export function formatMessage(message: string, sha: string): string;
export function sourceCommitCandidates(message: string): string[];
export function latestUpdatePerPlatform<T extends { platforms?: string }>(updates: T[]): Partial<Record<Platform, T>>;
export function hermesDebugInfoBytes(bytes: Buffer): number | null | undefined;
export function inspectBundle(input: {
  bytes: Buffer;
  hasSourceMap: boolean;
  env: Record<string, string | undefined>;
  expect?: string[];
}): BundleCheck[];
export function shellQuote(value: string): string;
