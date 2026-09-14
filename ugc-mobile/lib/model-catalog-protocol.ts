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
