import 'server-only';
import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createApiTraceHeaders } from './api-cache';
import {
  logBackendError,
  logBackendInfo,
  logBackendWarning,
} from './backend-logger';
import {
  readModelCatalogCurrent,
  readModelCatalogPage,
  readModelCatalogDetails,
} from './model-catalog-read-service';
import {
  catalogBytes,
  decodeCatalogCursor,
  encodeCatalogCursor,
  isModelCatalogId,
  isModelCatalogKind,
  isModelCatalogPlatform,
  isModelCatalogRevision,
  matchesCatalogEtag,
  ModelCatalogTransportError,
  MODEL_CATALOG_BUDGETS,
  type ModelCatalogPlatform,
} from './model-catalog-transport';

type Dependencies = {
  current: typeof readModelCatalogCurrent;
  page: typeof readModelCatalogPage;
  details: typeof readModelCatalogDetails;
};
type Endpoint = keyof typeof MODEL_CATALOG_BUDGETS;
const defaults: Dependencies = {
  current: readModelCatalogCurrent,
  page: readModelCatalogPage,
  details: readModelCatalogDetails,
};
function platformParam(value: string | null): ModelCatalogPlatform {
  const platform = value ?? 'web';
  if (!isModelCatalogPlatform(platform))
    throw new ModelCatalogTransportError(
      'INVALID_PLATFORM',
      'Choose web or mobile.',
    );
  return platform;
}
function revisionParam(value: string | null): string {
  if (!isModelCatalogRevision(value))
    throw new ModelCatalogTransportError(
      'INVALID_REVISION',
      'A published catalog revision is required.',
    );
  return value;
}
function modelIds(values: string[]): string[] {
  if (
    !values.length ||
    values.length > 8 ||
    values.some((id) => !isModelCatalogId(id))
  )
    throw new ModelCatalogTransportError(
      'INVALID_MODEL_IDS',
      'Request between one and eight model IDs.',
    );
  return [...new Set(values)].sort();
}
export function createModelCatalogRouteHandler(
  endpoint: Endpoint,
  dependencies: Dependencies = defaults,
) {
  return async (
    request: Request,
    context?: { params: Promise<{ id?: string }> },
  ) => {
    const started = Date.now();
    const trace = createApiTraceHeaders(request);
    try {
      const params = new URL(request.url).searchParams;
      const platform = platformParam(params.get('platform'));
      let body: unknown;
      if (endpoint === 'current') body = await dependencies.current(platform);
      else {
        const revision = revisionParam(params.get('revision'));
        if (endpoint === 'models') {
          const kind = params.get('kind');
          if (kind !== null && !isModelCatalogKind(kind))
            throw new ModelCatalogTransportError(
              'INVALID_KIND',
              'Choose image, video, or motion.',
            );
          const limit = params.has('limit') ? Number(params.get('limit')) : 32;
          if (!Number.isInteger(limit) || limit < 1 || limit > 50)
            throw new ModelCatalogTransportError(
              'INVALID_LIMIT',
              'The model page size must be between 1 and 50.',
            );
          const after = decodeCatalogCursor(
            params.get('cursor'),
            revision,
            kind,
            platform,
          );
          const rows = await dependencies.page({
            platform,
            revision,
            kind,
            after,
            limit,
          });
          const models = rows.slice(0, limit);
          body = {
            transportVersion: 1,
            revision,
            models,
            nextCursor:
              rows.length > limit && models.length
                ? encodeCatalogCursor(
                    revision,
                    kind,
                    models[models.length - 1],
                    platform,
                  )
                : null,
          };
        } else {
          const ids = modelIds(
            endpoint === 'detail'
              ? [(await context!.params).id ?? '']
              : (params.get('ids') ?? '').split(','),
          );
          const models = await dependencies.details(revision, ids, platform);
          const missingIds = ids.filter(
            (id) => !models.some((m) => m.id === id),
          );
          if (endpoint === 'detail' && missingIds.length)
            throw new ModelCatalogTransportError(
              'MODEL_UNAVAILABLE',
              'This model is unavailable. Choose another model.',
              404,
            );
          // Same compact v3 descriptor as the legacy API; private fields have already been allowlisted by the store parser.
          const wireModels = models.map((model) => {
            const wire = { ...model } as Partial<typeof model>;
            delete wire.inputs;
            return wire;
          });
          body = {
            transportVersion: 1,
            descriptorSchemaVersion: 3,
            revision,
            models: wireModels,
            missingIds,
          };
        }
      }
      const bytes = catalogBytes(body);
      if (bytes > MODEL_CATALOG_BUDGETS[endpoint])
        throw new ModelCatalogTransportError(
          'CATALOG_RESPONSE_TOO_LARGE',
          'The model catalog response exceeds its published budget.',
          503,
        );
      const etag = `"model-catalog-v1-${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 24)}"`;
      const cacheControl =
        endpoint === 'current'
          ? 'public, max-age=0, s-maxage=30, must-revalidate'
          : 'public, max-age=31536000, immutable';
      const headers = {
        ...trace,
        ETag: etag,
        'Cache-Control': cacheControl,
        'Vercel-CDN-Cache-Control':
          endpoint === 'current'
            ? 'public, s-maxage=30, must-revalidate'
            : 'public, s-maxage=31536000, immutable',
      };
      const status = matchesCatalogEtag(
        request.headers.get('if-none-match'),
        etag,
      )
        ? 304
        : 200;
      logBackendInfo('model_catalog_read', {
        endpoint,
        platform,
        transportVersion: 1,
        revision: (body as { revision: string }).revision,
        status,
        decodedBytes: bytes,
        elapsedMs: Date.now() - started,
      });
      return status === 304
        ? new NextResponse(null, { status, headers })
        : NextResponse.json(body, { headers });
    } catch (error) {
      const known = error instanceof ModelCatalogTransportError;
      // A malformed cursor or an unknown revision is the caller's mistake;
      // only origin failures and oversized responses are backend errors.
      const log = known && error.status < 500 ? logBackendWarning : logBackendError;
      log('model_catalog_read_failed', {
        error,
        endpoint,
        code: known ? error.code : 'CATALOG_UNAVAILABLE',
        elapsedMs: Date.now() - started,
      });
      return NextResponse.json(
        {
          code: known ? error.code : 'CATALOG_UNAVAILABLE',
          error: known
            ? error.message
            : 'Could not load model settings. Please retry.',
        },
        {
          status: known ? error.status : 503,
          headers: { ...trace, 'Cache-Control': 'no-store' },
        },
      );
    }
  };
}
