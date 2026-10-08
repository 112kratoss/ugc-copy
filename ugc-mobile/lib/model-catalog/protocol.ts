/** Dependency-free transport shared by the web server, browser and native client. */
export type ModelCatalogKind = 'image' | 'video' | 'motion';
export type ModelCatalogPlatform = 'web' | 'mobile';
export type ModelCatalogSummary = {
  id: string;
  kind: ModelCatalogKind;
  displayName: string;
  description: string;
  badge: string | null;
  recommended: boolean;
  sortOrder: number;
};
export type ModelCatalogCurrent = {
  transportVersion: 1;
  descriptorSchemaVersion: 3;
  revision: string;
  defaults: Record<ModelCatalogKind, string | null>;
  counts: Record<ModelCatalogKind, number>;
};
export type ModelCatalogPage = {
  transportVersion: 1;
  revision: string;
  models: ModelCatalogSummary[];
  nextCursor: string | null;
};
export type ModelCatalogDetails<T = unknown> = {
  transportVersion: 1;
  descriptorSchemaVersion: 3;
  revision: string;
  models: T[];
  missingIds: string[];
};
export const MODEL_CATALOG_BUDGETS = {
  current: 2048,
  models: 16384,
  detail: 16384,
  details: 131072,
} as const;
/**
 * Model IDs and revisions share one character set on every route, cursor and
 * client, so an ID that a client would send is one the server will accept.
 */
export const MODEL_CATALOG_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
export const MODEL_CATALOG_REVISION_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
export function isModelCatalogKind(value: unknown): value is ModelCatalogKind {
  return value === 'image' || value === 'video' || value === 'motion';
}
export function isModelCatalogPlatform(
  value: unknown,
): value is ModelCatalogPlatform {
  return value === 'web' || value === 'mobile';
}
export function isModelCatalogId(value: unknown): value is string {
  return typeof value === 'string' && MODEL_CATALOG_ID_PATTERN.test(value);
}
export function isModelCatalogRevision(value: unknown): value is string {
  return (
    typeof value === 'string' && MODEL_CATALOG_REVISION_PATTERN.test(value)
  );
}
export type CatalogConditionPrimitive = string | number | boolean;
export type CatalogConditionOperator =
  | 'equals'
  | 'notEquals'
  | 'in'
  | 'notIn'
  | 'greaterThan'
  | 'greaterThanOrEqual';
export type CatalogConditionLike = {
  source: 'setting' | 'inputCount';
  key: string;
  operator: CatalogConditionOperator;
  value: CatalogConditionPrimitive | CatalogConditionPrimitive[];
};
/**
 * One operator table for the server runtime, the native app and the web
 * pickers, so a control that the server applies is the control the UI shows.
 */
export function catalogConditionMatches(
  operator: CatalogConditionOperator,
  actual: unknown,
  expected: CatalogConditionPrimitive | CatalogConditionPrimitive[],
): boolean {
  switch (operator) {
    case 'equals':
      return actual === expected;
    case 'notEquals':
      return actual !== expected;
    case 'in':
      return (
        Array.isArray(expected) &&
        expected.includes(actual as CatalogConditionPrimitive)
      );
    case 'notIn':
      return (
        Array.isArray(expected) &&
        !expected.includes(actual as CatalogConditionPrimitive)
      );
    case 'greaterThan':
      return (
        typeof actual === 'number' &&
        typeof expected === 'number' &&
        actual > expected
      );
    case 'greaterThanOrEqual':
      return (
        typeof actual === 'number' &&
        typeof expected === 'number' &&
        actual >= expected
      );
    default:
      return false;
  }
}
export function catalogConditionsMatch(
  conditions: readonly CatalogConditionLike[] | undefined,
  settings: Record<string, CatalogConditionPrimitive | undefined>,
  inputCounts: Record<string, number> = {},
): boolean {
  return (conditions ?? []).every((condition) =>
    catalogConditionMatches(
      condition.operator,
      condition.source === 'setting'
        ? settings[condition.key]
        : (inputCounts[condition.key] ?? 0),
      condition.value,
    ),
  );
}
export function parseModelCatalogCurrent(value: unknown): ModelCatalogCurrent {
  const v = value as ModelCatalogCurrent;
  if (
    !v ||
    v.transportVersion !== 1 ||
    v.descriptorSchemaVersion !== 3 ||
    typeof v.revision !== 'string' ||
    !v.revision ||
    !v.defaults ||
    !v.counts ||
    !(['image', 'video', 'motion'] as const).every(
      (kind) =>
        (v.defaults[kind] === null || typeof v.defaults[kind] === 'string') &&
        Number.isInteger(v.counts[kind]) &&
        v.counts[kind] >= 0,
    )
  ) {
    throw new Error('Invalid model catalog revision.');
  }
  return v;
}
/**
 * What both creators draw. The server's catalog build is held to these lists
 * (`src/__tests__/model-catalog-client-parity.test.ts`), the native parser accepts
 * exactly them and drops a descriptor that uses anything else
 * (`ugc-mobile/__tests__/model-catalog-client-parity.test.ts`), and the web creator's
 * affordances answer for every input mode named here. A capability one client cannot
 * render therefore cannot be published at all: teach both clients first, then add it
 * here, then release the descriptor that uses it.
 */
export const CLIENT_RENDERED_CONTROL_TYPES = ['choice', 'boolean', 'integer'] as const;
export const CLIENT_RENDERED_INPUT_MODE_KEYS = [
  'prompt-only',
  'references',
  'frames',
  'video-elements',
  'subjects',
  'prepared-assets',
  'motion-inputs',
] as const;
export const CLIENT_RENDERED_INPUT_SLOT_KINDS = [
  'image',
  'video',
  'audio',
  'character',
  'preparedVoice',
] as const;
export const CLIENT_RENDERED_INPUT_SLOT_ROLES = [
  'reference',
  'startFrame',
  'endFrame',
] as const;
export const CLIENT_RENDERED_INPUT_CONSTRAINT_TYPES = [
  'total-count',
  'weighted-count',
  'combined-duration',
] as const;
/**
 * A named subject is several pictures of one person or thing that the provider
 * fuses into one identity, mentioned in the prompt as `@handle`. They travel in the
 * `subjectImages` slot, one asset per picture, grouped by a shared handle. The
 * server refuses a group outside this range (Kling O3's contract, live-verified
 * 2026-08-24), so both creators hold a subject to it before anything is sent.
 */
export const SUBJECT_IMAGES_SLOT_KEY = 'subjectImages';
export const SUBJECT_IMAGES_PER_NAME = { min: 2, max: 4 } as const;
/**
 * How many subjects a run takes, from its slot. The slot is sized for that many
 * subjects of the most pictures each, so a descriptor published before `maxNamed`
 * existed still answers 3 for a slot of 12, which is the count the server enforces.
 */
export function subjectsPerRun(slot: { max: number; maxNamed?: number }): number {
  const fromSlot = slot.maxNamed ?? Math.floor(slot.max / SUBJECT_IMAGES_PER_NAME.max);
  return Math.max(0, Math.min(fromSlot, slot.max));
}
/**
 * The setting values a descriptor's input modes are gated on, by setting key. A mode
 * is a shape the model takes whether or not a control lists it: Kling O3's subjects
 * mode was published on 2026-08-24 beside an Input mode control naming frames and
 * references only, and both the server's quote and the native draft turned a subjects
 * run back into frames until each learned to read the modes through this.
 */
export function modeGatedSettingValues(
  inputModes: readonly { conditions?: readonly CatalogConditionLike[] }[] | undefined,
): Map<string, Set<string>> {
  const values = new Map<string, Set<string>>();
  for (const mode of inputModes ?? []) {
    for (const condition of mode.conditions ?? []) {
      if (
        condition.source !== 'setting' ||
        condition.operator !== 'equals' ||
        typeof condition.value !== 'string'
      )
        continue;
      const named = values.get(condition.key) ?? new Set<string>();
      named.add(condition.value);
      values.set(condition.key, named);
    }
  }
  return values;
}
export function parseModelCatalogPage(
  value: unknown,
  revision: string,
): ModelCatalogPage {
  const v = value as ModelCatalogPage;
  if (
    !v ||
    v.transportVersion !== 1 ||
    v.revision !== revision ||
    !Array.isArray(v.models) ||
    v.models.length > 50 ||
    !(v.nextCursor === null || typeof v.nextCursor === 'string') ||
    !v.models.every(
      (m) =>
        m &&
        typeof m.id === 'string' &&
        isModelCatalogKind(m.kind) &&
        typeof m.displayName === 'string' &&
        typeof m.description === 'string' &&
        (m.badge === null || typeof m.badge === 'string') &&
        typeof m.recommended === 'boolean' &&
        Number.isFinite(m.sortOrder),
    )
  ) {
    throw new Error('Invalid model catalog page.');
  }
  return v;
}

/**
 * The longest prompt the generation route accepts (`GENERATION_PROMPT_MAX_LENGTH`
 * in src/lib/generation-services.ts). The web image composer allowed 20,000 and
 * the app's inputs had no limit, so the server refused after the references
 * had already uploaded.
 */
export const GENERATION_PROMPT_MAX_LENGTH = 10000;
