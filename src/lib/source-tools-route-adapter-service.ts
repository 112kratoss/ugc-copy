import 'server-only';

import { createHash } from 'node:crypto';

import { NextResponse } from 'next/server';

import { API_CACHE_CONTROL, createApiResponseHeaders } from '@/lib/api-cache';
import { listSourceToolsCatalog } from '@/lib/source-tools-server';

type SourceToolsRouteDependencies = {
  listSourceToolsCatalog?: typeof listSourceToolsCatalog;
};

function resolveDependencies(dependencies: SourceToolsRouteDependencies | undefined) {
  return {
    listSourceToolsCatalog: dependencies?.listSourceToolsCatalog ?? listSourceToolsCatalog,
  };
}

function createCatalogEtag(payload: unknown) {
  return `"${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)}"`;
}

function requestForResponseHeaders(request?: Request): Request {
  return request ?? new Request('http://localhost/api/source-tools');
}

export async function getSourceToolsRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: SourceToolsRouteDependencies;
  request?: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  const tools = await resolvedDependencies.listSourceToolsCatalog();
  const payload = { tools };
  const etag = createCatalogEtag(payload);
  const headerRequest = requestForResponseHeaders(request);
  const headers = createApiResponseHeaders(headerRequest, API_CACHE_CONTROL.publicCatalog, { etag });

  if (request?.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers });
  }

  return NextResponse.json(payload, { headers });
}
