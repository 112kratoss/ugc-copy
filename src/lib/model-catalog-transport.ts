import { Buffer } from 'node:buffer';
import type { GenerationModelDescriptor } from './generation-model-catalog';
export {
  MODEL_CATALOG_BUDGETS,
  MODEL_CATALOG_ID_PATTERN,
  MODEL_CATALOG_REVISION_PATTERN,
  isModelCatalogId,
  isModelCatalogKind,
  isModelCatalogPlatform,
  isModelCatalogRevision,
} from '../../ugc-mobile/lib/model-catalog-protocol';
export type {
  ModelCatalogCurrent,
  ModelCatalogPage,
  ModelCatalogPlatform,
  ModelCatalogSummary,
  ModelCatalogKind,
} from '../../ugc-mobile/lib/model-catalog-protocol';
import {
  isModelCatalogId,
  type ModelCatalogKind,
  type ModelCatalogPlatform,
  type ModelCatalogSummary,
} from '../../ugc-mobile/lib/model-catalog-protocol';

export class ModelCatalogTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export function catalogSummary(
  model: GenerationModelDescriptor,
): ModelCatalogSummary {
  const { id, kind, displayName, description, badge, recommended, sortOrder } =
    model;
  return { id, kind, displayName, description, badge, recommended, sortOrder };
}
export function catalogBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
/** A cursor is only valid for the revision, platform and category it was issued for. */
export function encodeCatalogCursor(
  revision: string,
  kind: ModelCatalogKind | null,
  after: { id: string; sortOrder: number },
  platform: ModelCatalogPlatform = 'web',
): string {
  return Buffer.from(
    JSON.stringify({
      revision,
      platform,
      kind,
      id: after.id,
      sortOrder: after.sortOrder,
    }),
  ).toString('base64url');
}
export function decodeCatalogCursor(
  cursor: string | null,
  revision: string,
  kind: ModelCatalogKind | null,
  platform: ModelCatalogPlatform = 'web',
): { id: string; sortOrder: number } | null {
  if (cursor === null) return null;
  try {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error();
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (
      parsed.revision !== revision ||
      parsed.platform !== platform ||
      parsed.kind !== kind ||
      !isModelCatalogId(parsed.id) ||
      !Number.isFinite(parsed.sortOrder) ||
      parsed.sortOrder < 0
    )
      throw new Error();
    return { id: parsed.id, sortOrder: parsed.sortOrder };
  } catch {
    throw new ModelCatalogTransportError(
      'INVALID_CURSOR',
      'This model list cursor does not match the requested catalog.',
    );
  }
}
export function matchesCatalogEtag(
  header: string | null,
  etag: string,
): boolean {
  return Boolean(
    header
      ?.split(',')
      .some(
        (value) =>
          value.trim() === '*' ||
          value.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''),
      ),
  );
}
