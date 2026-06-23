import 'server-only';

import { NextResponse } from 'next/server';

import { API_CACHE_CONTROL, createApiResponseHeaders } from '@/lib/api-cache';
import {
  GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
  buildGenerationModelCatalog,
  type CatalogPlatform,
} from '@/lib/generation-model-catalog';

type GenerationModelCatalogRouteDependencies = {
  buildGenerationModelCatalog?: typeof buildGenerationModelCatalog;
};

function resolveDependencies(dependencies: GenerationModelCatalogRouteDependencies | undefined) {
  return {
    buildGenerationModelCatalog:
      dependencies?.buildGenerationModelCatalog ?? buildGenerationModelCatalog,
  };
}

function readCatalogPlatform(searchParams: URLSearchParams): CatalogPlatform {
  return searchParams.get('platform') === 'mobile' ? 'mobile' : 'web';
}

function readCatalogSchemaVersion(searchParams: URLSearchParams): number {
  const schemaVersionValue = searchParams.get('schemaVersion');
  if (!schemaVersionValue) {
    return GENERATION_MODEL_CATALOG_SCHEMA_VERSION;
  }

  const requestedSchemaVersion = Number(schemaVersionValue);
  return Number.isInteger(requestedSchemaVersion) && requestedSchemaVersion >= 0
    ? requestedSchemaVersion
    : GENERATION_MODEL_CATALOG_SCHEMA_VERSION;
}

export async function getGenerationModelCatalogRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: GenerationModelCatalogRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  const searchParams = new URL(request.url).searchParams;
  const platform = readCatalogPlatform(searchParams);
  const schemaVersion = readCatalogSchemaVersion(searchParams);
  const catalog = resolvedDependencies.buildGenerationModelCatalog({ platform, schemaVersion });
  const etag = `"${catalog.revision}"`;
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.publicCatalog, { etag });

  if (request.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers });
  }

  return NextResponse.json(catalog, { headers });
}
