export const DEFAULT_OUTPUT_DIR: string;
export const SENTINEL_TYPES: string[];

export type MappingEntry = { original: string; renamed: string };
export type Share = { total: number; renamed: number; share: number };
export type SurvivorStatus = 'kept-by-name' | 'renamed' | 'removed' | 'missing';
export type ReflectedType = { name: string; kind: 'record' | 'enumerable'; package: string; file: string };
export type KotlinType = { name: string; kind: 'class' | 'enum' | 'object'; supertypes: string };
export type ConfigurationChecks = {
  recordsKept: boolean;
  enumerablesKept: boolean;
  kotlinMetadataKept: boolean;
  blanketExpoKeep: boolean;
  dontoptimize: boolean;
  dontobfuscate: boolean;
  dontshrink: boolean;
  allowaccessmodification: boolean;
  repackageclasses: boolean;
  keepattributes: string[];
};
export type Outputs = {
  dir: string;
  mapping: { classes: MappingEntry[]; byOriginal: Map<string, MappingEntry> };
  seeds: { classes: Set<string>; members: Map<string, string[]> } | null;
  usage: { removedClasses: Set<string>; removedMembers: Map<string, string[]> } | null;
  configuration: ConfigurationChecks | null;
  resources: { removedCount: number; removed: string[] } | null;
};
export type Survivor = {
  name: string;
  kind: 'record' | 'enumerable' | 'sentinel';
  lookedUp: string;
  status: SurvivorStatus;
  renamed?: string;
};
export type Report = {
  dir: string;
  share: Share;
  configuration: ConfigurationChecks | null;
  resources: { removedCount: number } | null;
  survivors: Survivor[];
  summary: Record<SurvivorStatus, number>;
  expoClasses: Record<string, SurvivorStatus>;
  failures: string[];
};
export type Diff = {
  share: { before: Share; after: Share };
  configurationChanges: { key: string; from: unknown; to: unknown }[];
  changed: { name: string; from: string; to: string }[];
  survivorChanges: { name: string; from: string; to: string }[];
};

export function parseMapping(text: string): MappingEntry[];
export function obfuscationShare(classes: MappingEntry[]): Share;
export function parseSeeds(text: string): { classes: Set<string>; members: Map<string, string[]> };
export function parseUsage(text: string): { removedClasses: Set<string>; removedMembers: Map<string, string[]> };
export function checkConfiguration(text: string): ConfigurationChecks;
export function findKotlinTypes(source: string): KotlinType[];
export function collectExpoReflectedTypes(root?: string): ReflectedType[];
export function readOutputs(dir: string): Outputs;
export function summarizeResources(text: string): { removedCount: number; removed: string[] };
export function classStatus(name: string, outputs: Outputs): { status: SurvivorStatus; renamed?: string };
export function buildReport(outputs: Outputs, reflected?: ReflectedType[]): Report;
export function diffReports(before: Report, after: Report): Diff;
export function formatReport(report: Report): string;
export function formatDiff(diff: Diff): string;
