import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { createPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { loadRemixSourceBundle, RemixSourceError } from '@/lib/remix-source-server';

type RemixSourceRouteDependencies = {
  loadRemixSourceBundle?: typeof loadRemixSourceBundle;
};

function resolveDependencies(dependencies: RemixSourceRouteDependencies | undefined) {
  return {
    loadRemixSourceBundle: dependencies?.loadRemixSourceBundle ?? loadRemixSourceBundle,
  };
}

function remixSourceJsonResponse(request: Request, body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: createPrivateNoStoreApiResponseHeaders(request),
  });
}

export async function getRemixSourceRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: RemixSourceRouteDependencies;
  request: NextRequest;
}) {
  const generationId = request.nextUrl.searchParams.get('id');
  const postId = request.nextUrl.searchParams.get('postId');

  if (!generationId) {
    return remixSourceJsonResponse(request, { error: 'Missing generation ID' }, 400);
  }

  try {
    const resolvedDependencies = resolveDependencies(dependencies);
    const bundle = await resolvedDependencies.loadRemixSourceBundle(request, generationId, { postId });
    return remixSourceJsonResponse(request, bundle);
  } catch (error) {
    if (error instanceof RemixSourceError) {
      return remixSourceJsonResponse(request, { error: error.message }, error.status);
    }

    logBackendError('failed_to_load_remix_source_bundle', { error: error });
    return remixSourceJsonResponse(request, { error: 'Failed to load remix source bundle' }, 500);
  }
}
