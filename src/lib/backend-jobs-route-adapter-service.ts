import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { runBackendJobsSchedulerForRoute } from '@/lib/backend-jobs-route-service';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

type BackendJobsRouteAdapterDependencies = {
  isAuthorizedCronRequest?: typeof isAuthorizedCronRequest;
  runBackendJobsSchedulerForRoute?: typeof runBackendJobsSchedulerForRoute;
};

function resolveDependencies(dependencies: BackendJobsRouteAdapterDependencies | undefined) {
  return {
    isAuthorizedCronRequest: dependencies?.isAuthorizedCronRequest ?? isAuthorizedCronRequest,
    runBackendJobsSchedulerForRoute: dependencies?.runBackendJobsSchedulerForRoute
      ?? runBackendJobsSchedulerForRoute,
  };
}

function cronResponse(response: NextResponse, request: Request): NextResponse {
  return applyPrivateNoStoreApiResponseHeaders(response, request);
}

export function createBackendJobsRouteHandlers({
  dependencies,
}: {
  dependencies?: BackendJobsRouteAdapterDependencies;
} = {}) {
  return {
    async GET(request: Request) {
      const resolvedDependencies = resolveDependencies(dependencies);

      if (!resolvedDependencies.isAuthorizedCronRequest(request)) {
        return cronResponse(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }), request);
      }

      const result = await resolvedDependencies.runBackendJobsSchedulerForRoute({ request });
      return cronResponse(NextResponse.json(result.body, { status: result.status }), request);
    },
  };
}
