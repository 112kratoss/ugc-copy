import { NextRequest, NextResponse } from 'next/server';

import { getMarketplaceResourceList } from '@/lib/post-resource-bundles-server';
import {
  normalizeMarketplaceResourceFilter,
  normalizeMarketplaceResourceKindFilter,
  normalizeMarketplaceResourceSort,
} from '@/lib/post-resource-bundles';
import { slugifySourceTool } from '@/lib/source-tools';

function normalizeNumber(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const page = await getMarketplaceResourceList({
      filter: normalizeMarketplaceResourceFilter(searchParams.get('access')),
      resource: normalizeMarketplaceResourceKindFilter(searchParams.get('resource')),
      tool: slugifySourceTool(searchParams.get('tool') ?? undefined),
      q: (searchParams.get('q') ?? '').trim().slice(0, 80),
      sort: normalizeMarketplaceResourceSort(searchParams.get('sort')),
      offset: normalizeNumber(searchParams.get('offset'), 0),
      limit: Math.min(48, Math.max(1, normalizeNumber(searchParams.get('limit'), 24))),
      countryCode: request.headers.get('x-vercel-ip-country'),
    });

    return NextResponse.json(page);
  } catch (error) {
    console.error('Failed to load marketplace resources:', error);
    return NextResponse.json({ error: 'Failed to load marketplace unlocks.' }, { status: 500 });
  }
}
