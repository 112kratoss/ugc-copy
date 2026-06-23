import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  createShowcasePreviewForRoute,
  type ShowcasePreviewResult,
} from '@/lib/showcase-preview-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type ShowcasePreviewRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createShowcasePreviewForRoute?: typeof createShowcasePreviewForRoute;
  createUserClient?: typeof createUserClient;
};

function resolveDependencies(dependencies: ShowcasePreviewRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createShowcasePreviewForRoute:
      dependencies?.createShowcasePreviewForRoute ?? createShowcasePreviewForRoute,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
  };
}

function toJsonResponse(result: ShowcasePreviewResult) {
  if (!result.ok && 'rateLimitError' in result) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}

async function handleShowcasePreviewGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const generationId = new URL(request.url).searchParams.get('id')?.trim();
  if (!generationId) {
    return NextResponse.json({ error: 'Missing generation ID' }, { status: 400 });
  }

  const supabase = dependencies.createUserClient(request) as SupabaseClient;
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return toJsonResponse(await dependencies.createShowcasePreviewForRoute({
    generationId,
    serviceClient: dependencies.createServiceClient(),
    viewerUserId: user.id,
  }));
}

export async function getShowcasePreviewRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: ShowcasePreviewRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleShowcasePreviewGET(request, resolveDependencies(dependencies)),
    request,
  );
}

export function createShowcasePreviewRouteHandlers({
  dependencies,
}: {
  dependencies?: ShowcasePreviewRouteDependencies;
} = {}) {
  return {
    GET(request: Request) {
      return getShowcasePreviewRouteResponse({ dependencies, request });
    },
  };
}
