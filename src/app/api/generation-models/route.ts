import { NextRequest, NextResponse } from 'next/server';

import {
  GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
  buildGenerationModelCatalog,
  type CatalogPlatform,
} from '@/lib/generation-model-catalog';

const CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=3600';

export async function GET(request: NextRequest) {
  const platformValue = request.nextUrl.searchParams.get('platform');
  const platform: CatalogPlatform = platformValue === 'mobile' ? 'mobile' : 'web';
  const requestedSchemaVersion = Number(request.nextUrl.searchParams.get('schemaVersion'));
  const schemaVersion = Number.isInteger(requestedSchemaVersion) && requestedSchemaVersion >= 0
    ? requestedSchemaVersion
    : GENERATION_MODEL_CATALOG_SCHEMA_VERSION;
  const catalog = buildGenerationModelCatalog({ platform, schemaVersion });
  const etag = `"${catalog.revision}"`;
  const headers = { 'Cache-Control': CACHE_CONTROL, ETag: etag };

  if (request.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers });
  }

  return NextResponse.json(catalog, { headers });
}
