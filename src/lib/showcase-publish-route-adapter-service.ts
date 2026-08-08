import 'server-only';
import { logBackendRouteError, logBackendWarning } from '@/lib/backend-logger';

import { NextResponse, after } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  SHOWCASE_PUBLISH_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { repairMediaForPost } from '@/lib/media-preview-repair';
import {
  fetchWithProviderTimeout,
  withProviderFetchRequestId,
} from '@/lib/provider-fetch';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import {
  publishGenerationToShowcaseForRoute,
  type ShowcasePublishRequestBody,
} from '@/lib/showcase-publish-service';

type ShowcasePublishRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  fetchWithProviderTimeout?: typeof fetchWithProviderTimeout;
  logError?: typeof logBackendRouteError;
  publishGenerationToShowcaseForRoute?: typeof publishGenerationToShowcaseForRoute;
  repairMediaForPost?: typeof repairMediaForPost;
  /** Seam over `after` so tests can drive the post-response work directly. */
  schedulePostMediaRepair?: (callback: () => Promise<void>) => void;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: ShowcasePublishRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    fetchWithProviderTimeout: dependencies?.fetchWithProviderTimeout ?? fetchWithProviderTimeout,
    logError: dependencies?.logError ?? logBackendRouteError,
    publishGenerationToShowcaseForRoute:
      dependencies?.publishGenerationToShowcaseForRoute ?? publishGenerationToShowcaseForRoute,
    repairMediaForPost: dependencies?.repairMediaForPost ?? repairMediaForPost,
    schedulePostMediaRepair: dependencies?.schedulePostMediaRepair
      ?? ((callback: () => Promise<void>) => after(callback)),
    withProviderFetchRequestId: dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

async function getAuthenticatedUserId(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const supabase = dependencies.createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  return authError || !user
    ? { ok: false as const }
    : { ok: true as const, supabase, userId: user.id };
}

async function handleShowcasePublishPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const auth = await getAuthenticatedUserId(request, dependencies);
    if (!auth.ok) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const adminSupabase = dependencies.createServiceClient();
    try {
      await dependencies.enforceBackendRateLimit(adminSupabase, {
        ...SHOWCASE_PUBLISH_RATE_LIMIT,
        key: auth.userId,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return createBackendRateLimitResponse(error);
      }

      dependencies.logError('Showcase publish rate limit check failed:', error);
      return NextResponse.json({ error: 'Failed to check showcase publish limits.' }, { status: 500 });
    }

    const requestBody = await request.json() as Partial<ShowcasePublishRequestBody>;
    if (!requestBody.generationId) {
      return NextResponse.json({ error: 'Missing generation ID' }, { status: 400 });
    }

    const result = await dependencies.publishGenerationToShowcaseForRoute({
      adminSupabase,
      body: requestBody as ShowcasePublishRequestBody,
      dependencies: {
        fetchWithProviderTimeout: dependencies.fetchWithProviderTimeout,
      },
      userId: auth.userId,
    });

    if (!result.ok) {
      return NextResponse.json(result.body, { status: result.status });
    }

    // Publishing a generation copies the provider's file into the public bucket
    // untranscoded, so until this the only thing that ever built a rendition for
    // it was the hourly sweep -- and that sweep does five videos an hour. A
    // burst of publishes therefore served ~23 Mbps sources for hours. The two
    // sibling publish paths already kick the same repair; this one did not.
    //
    // Both layers swallow deliberately. The post is already published and the
    // sweep repairs exactly this work, so neither a scheduling failure nor a
    // repair failure may turn a successful publish into an error.
    const { postId } = result.body;
    if (postId) {
      try {
        dependencies.schedulePostMediaRepair(async () => {
          try {
            await dependencies.repairMediaForPost(adminSupabase, postId);
          } catch (error) {
            logBackendWarning('showcase_publish_async_repair_failed', { error, postId });
          }
        });
      } catch (error) {
        logBackendWarning('showcase_publish_async_repair_not_scheduled', { error, postId });
      }
    }

    return NextResponse.json(result.body);
  } catch (error) {
    dependencies.logError('Publish error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function postShowcasePublishRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: ShowcasePublishRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return resolvedDependencies.withProviderFetchRequestId(getApiRequestId(request), async () => (
    applyPrivateNoStoreApiResponseHeaders(
      await handleShowcasePublishPOST(request, resolvedDependencies),
      request,
    )
  ));
}
