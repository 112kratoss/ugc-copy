import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  createPostResourceFileReadUrlForRoute,
  type PostResourceFileReadUrlClient,
} from '@/lib/post-resource-file-url-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type PostResourceFileUrlRouteContext = {
  params: Promise<{ postId: string }>;
};

type PostResourceFileUrlRouteDependencies = {
  createPostResourceFileReadUrlForRoute?: typeof createPostResourceFileReadUrlForRoute;
  createServiceClient?: () => PostResourceFileReadUrlClient;
  createUserClient?: typeof createUserClient;
  logError?: typeof console.error;
};

function resolveDependencies(dependencies: PostResourceFileUrlRouteDependencies | undefined) {
  return {
    createPostResourceFileReadUrlForRoute:
      dependencies?.createPostResourceFileReadUrlForRoute ?? createPostResourceFileReadUrlForRoute,
    createServiceClient: dependencies?.createServiceClient ?? (createServiceClient as () => PostResourceFileReadUrlClient),
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    logError: dependencies?.logError ?? console.error,
  };
}

function getResourceFileRateLimitKey(request: Request, userId: string | null) {
  if (userId) return userId;

  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = request.headers.get('x-real-ip')?.trim();

  return forwardedFor || realIp || '127.0.0.1';
}

async function getViewerUserId(request: Request, createClient: typeof createUserClient) {
  const supabase = createClient(request) as SupabaseClient;
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return user?.id ?? null;
}

async function readJsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function handlePostResourceFileUrlPOST(
  request: Request,
  context: PostResourceFileUrlRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const { postId } = await context.params;
    const viewerUserId = await getViewerUserId(request, dependencies.createUserClient);
    const result = await dependencies.createPostResourceFileReadUrlForRoute({
      body: await readJsonBody(request),
      client: dependencies.createServiceClient,
      countryCode: request.headers.get('x-vercel-ip-country'),
      postId,
      rateLimitKey: getResourceFileRateLimitKey(request, viewerUserId),
      viewerUserId,
    });

    if (!result.ok) {
      if ('rateLimitError' in result) {
        return createBackendRateLimitResponse(result.rateLimitError);
      }

      return NextResponse.json(result.body, { status: result.status });
    }

    return NextResponse.json(result.body);
  } catch (error) {
    dependencies.logError('Post resource file URL error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function postPostResourceFileUrlRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: PostResourceFileUrlRouteContext;
  dependencies?: PostResourceFileUrlRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handlePostResourceFileUrlPOST(request, context, resolveDependencies(dependencies)),
    request,
  );
}
