import { NextRequest, NextResponse } from 'next/server';

import { loadRemixSourceBundle, RemixSourceError } from '@/lib/remix-source-server';

export async function GET(request: NextRequest) {
  const generationId = request.nextUrl.searchParams.get('id');
  const postId = request.nextUrl.searchParams.get('postId');

  if (!generationId) {
    return NextResponse.json({ error: 'Missing generation ID' }, { status: 400 });
  }

  try {
    const bundle = await loadRemixSourceBundle(request, generationId, { postId });
    return NextResponse.json(bundle);
  } catch (error) {
    if (error instanceof RemixSourceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error('Failed to load remix source bundle:', error);
    return NextResponse.json({ error: 'Failed to load remix source bundle' }, { status: 500 });
  }
}
