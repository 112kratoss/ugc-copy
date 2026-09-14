/** Dependency-free transport shared by the web server, browser and native client. */
export type ModelCatalogKind = 'image' | 'video' | 'motion';
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
export function isModelCatalogKind(value: unknown): value is ModelCatalogKind {
  return value === 'image' || value === 'video' || value === 'motion';
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
