import { createHash } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';

import { listSourceToolsCatalog } from '@/lib/source-tools-server';

const CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=3600';

function createCatalogEtag(payload: unknown) {
  return `"${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)}"`;
}

export async function GET(request?: NextRequest) {
  const tools = await listSourceToolsCatalog();
  const payload = { tools };
  const etag = createCatalogEtag(payload);
  const headers = { 'Cache-Control': CACHE_CONTROL, ETag: etag };

  if (request?.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers });
  }

  return NextResponse.json(payload, { headers });
}
