import 'server-only';
import {
  buildGenerationModelCatalog,
  projectGenerationModelDescriptor,
} from './generation-model-catalog';
import { parsePublishedModelDescriptor } from './generation-model-descriptor-parser';
import { createServiceClient } from './server-helpers';
import { logBackendInfo } from './backend-logger';
import {
  catalogSummary,
  ModelCatalogTransportError,
  type ModelCatalogCurrent,
  type ModelCatalogKind,
  type ModelCatalogSummary,
} from './model-catalog-transport';
import { parseModelCatalogCurrent } from '../../ugc-mobile/lib/model-catalog-protocol';

const reads = new Map<string, { expires: number; value: Promise<unknown> }>();
const MAX_CACHED_READS = 128;
function cached<T>(
  key: string,
  ttl: number,
  read: () => Promise<T>,
): Promise<T> {
  const existing = reads.get(key);
  if (existing && existing.expires > Date.now()) {
    logBackendInfo('model_catalog_cache', {
      transportVersion: 1,
      endpoint: key.split(':')[0],
      cache: 'hit',
      entries: reads.size,
    });
    return existing.value as Promise<T>;
  }
  logBackendInfo('model_catalog_cache', {
    transportVersion: 1,
    endpoint: key.split(':')[0],
    cache: 'miss',
    entries: reads.size,
  });
  if (reads.size >= MAX_CACHED_READS) reads.delete(reads.keys().next().value!);
  const value = read().catch((error) => {
    if (reads.get(key)?.value === value) reads.delete(key);
    throw error;
  });
  reads.set(key, { expires: Date.now() + ttl, value });
  return value;
}
export function clearModelCatalogReadCache() {
  reads.clear();
}
function codeCatalog() {
  const source =
    process.env.GENERATION_MODEL_CATALOG_SOURCE ??
    (process.env.NODE_ENV === 'production' ? 'database' : 'code');
  // Shadow mode must never make an unpublished release public.
  return source === 'code'
    ? buildGenerationModelCatalog({ platform: 'web', schemaVersion: 3 })
    : null;
}
async function rpc(
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const { data, error } = await createServiceClient().rpc(name, args);
  if (error) throw error;
  if (data === null)
    throw new ModelCatalogTransportError(
      'CATALOG_REVISION_UNAVAILABLE',
      'This published model catalog is unavailable. Refresh the catalog.',
      404,
    );
  return data;
}
export async function readModelCatalogCurrent(): Promise<ModelCatalogCurrent> {
  const code = codeCatalog();
  if (code)
    return {
      transportVersion: 1,
      descriptorSchemaVersion: 3,
      revision: code.revision,
      defaults: code.defaults,
      counts: {
        image: code.models.filter((m) => m.kind === 'image').length,
        video: code.models.filter((m) => m.kind === 'video').length,
        motion: code.models.filter((m) => m.kind === 'motion').length,
      },
    };
  return cached('current', 30_000, async () =>
    parseModelCatalogCurrent(await rpc('read_model_catalog_v1_current')),
  );
}
export async function readModelCatalogPage(input: {
  revision: string;
  kind: ModelCatalogKind | null;
  after: { id: string; sortOrder: number } | null;
  limit: number;
}): Promise<ModelCatalogSummary[]> {
  const code = codeCatalog();
  if (code) {
    if (code.revision !== input.revision)
      throw new ModelCatalogTransportError(
        'CATALOG_REVISION_UNAVAILABLE',
        'Refresh the model catalog.',
        404,
      );
    return code.models
      .filter((m) => !input.kind || m.kind === input.kind)
      .sort(
        (a, b) =>
          a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .filter(
        (m) =>
          !input.after ||
          m.sortOrder > input.after.sortOrder ||
          (m.sortOrder === input.after.sortOrder && m.id > input.after.id),
      )
      .slice(0, input.limit + 1)
      .map(catalogSummary);
  }
  return cached(
    `page:${JSON.stringify(input)}`,
    60 * 60_000,
    async () =>
      (await rpc('read_model_catalog_v1_page', {
        p_revision: input.revision,
        p_kind: input.kind,
        p_after_sort: input.after?.sortOrder ?? null,
        p_after_id: input.after?.id ?? null,
        p_limit: input.limit + 1,
      })) as ModelCatalogSummary[],
  );
}
export async function readModelCatalogDetails(revision: string, ids: string[]) {
  const code = codeCatalog();
  if (code) {
    if (code.revision !== revision)
      throw new ModelCatalogTransportError(
        'CATALOG_REVISION_UNAVAILABLE',
        'Refresh the model catalog.',
        404,
      );
    return code.models.filter((m) => ids.includes(m.id));
  }
  return cached(
    `details:${revision}:${ids.join(',')}`,
    60 * 60_000,
    async () => {
      const rows = (await rpc('read_model_catalog_v1_details', {
        p_revision: revision,
        p_ids: ids,
      })) as Array<{
        modelId: string;
        descriptor: unknown;
        releaseSchemaVersion: number;
      }>;
      return rows.map((row) =>
        projectGenerationModelDescriptor(
          parsePublishedModelDescriptor(
            row.descriptor,
            row.modelId,
            row.releaseSchemaVersion,
            { web: true, mobile: true },
          ),
          3,
        ),
      );
    },
  );
}
