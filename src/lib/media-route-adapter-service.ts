import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { requireIdentity } from '@/lib/account-identity';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  createMediaReadSignedUrlForRoute,
  parseMediaReadRoutePayload,
} from '@/lib/media-read-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

async function createCookieSupabaseClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          // Media requests are read-only; no cookie writes are needed.
        },
      },
    },
  );
}

async function createMediaSupabaseClient(request: Request) {
  if (request.headers.get('Authorization')) {
    return createUserClient(request);
  }

  return createCookieSupabaseClient();
}

type MediaRouteAdapterDependencies = {
  createMediaSupabaseClient?: typeof createMediaSupabaseClient;
  createMediaReadSignedUrlForRoute?: typeof createMediaReadSignedUrlForRoute;
  createServiceClient?: typeof createServiceClient;
  parseMediaReadRoutePayload?: typeof parseMediaReadRoutePayload;
  logError?: typeof logBackendRouteError;
  requireIdentity?: typeof requireIdentity;
};

function resolveDependencies(dependencies: MediaRouteAdapterDependencies | undefined) {
  return {
    createMediaSupabaseClient: dependencies?.createMediaSupabaseClient ?? createMediaSupabaseClient,
    createMediaReadSignedUrlForRoute: dependencies?.createMediaReadSignedUrlForRoute
      ?? createMediaReadSignedUrlForRoute,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    parseMediaReadRoutePayload: dependencies?.parseMediaReadRoutePayload ?? parseMediaReadRoutePayload,
    logError: dependencies?.logError ?? logBackendRouteError,
    requireIdentity: dependencies?.requireIdentity ?? requireIdentity,
  };
}

export async function getMediaRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: MediaRouteAdapterDependencies;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  const url = new URL(request.url);
  const payloadResult = resolvedDependencies.parseMediaReadRoutePayload({
    bucket: url.searchParams.get('bucket'),
    filePath: url.searchParams.get('path'),
    shouldDownload: url.searchParams.get('download') === '1',
    requestedFilename: url.searchParams.get('filename'),
  });

  if (!payloadResult.ok) {
    return NextResponse.json(payloadResult.body, { status: payloadResult.status });
  }

  try {
    const supabase = await resolvedDependencies.createMediaSupabaseClient(request);
    let serviceClient: ReturnType<typeof resolvedDependencies.createServiceClient> | null = null;
    const getServiceClient = () => {
      serviceClient ??= resolvedDependencies.createServiceClient();
      return serviceClient;
    };
    const identity = await resolvedDependencies.requireIdentity(supabase, getServiceClient);

    if (!identity.ok) {
      return NextResponse.json(
        { error: identity.error, code: identity.code },
        {
          status: identity.status,
          headers: { 'Cache-Control': 'private, no-store' },
        },
      );
    }

    const result = await resolvedDependencies.createMediaReadSignedUrlForRoute({
      payload: payloadResult.payload,
      rateLimitClient: getServiceClient(),
      userClient: supabase,
      userId: identity.identity.userId,
    });

    if (!result.ok) {
      if ('rateLimitError' in result) {
        return createBackendRateLimitResponse(result.rateLimitError);
      }

      return NextResponse.json(result.body, { status: result.status });
    }

    const response = NextResponse.redirect(result.signedUrl, 302);
    response.headers.set('Cache-Control', 'private, max-age=60');
    return response;
  } catch (error) {
    resolvedDependencies.logError('Error serving media:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
