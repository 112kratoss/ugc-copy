import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  backendJobExecutionResponse,
  getBackendJobRequestId,
  type BackendJobExecutionResult,
} from '@/lib/backend-job-executions';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

type BackendJobTriggerRouteDependencies = {
  backendJobExecutionResponse?: typeof backendJobExecutionResponse;
  getBackendJobRequestId?: typeof getBackendJobRequestId;
  isAuthorizedCronRequest?: typeof isAuthorizedCronRequest;
};

type RunBackendJob = (options: { requestId: string }) => Promise<BackendJobExecutionResult>;

type BackendJobTriggerRouteHandlerOptions = {
  dependencies?: BackendJobTriggerRouteDependencies;
  failureMessage: string;
  runJob: RunBackendJob;
};

function resolveDependencies(dependencies: BackendJobTriggerRouteDependencies = {}) {
  return {
    backendJobExecutionResponse:
      dependencies.backendJobExecutionResponse ?? backendJobExecutionResponse,
    getBackendJobRequestId: dependencies.getBackendJobRequestId ?? getBackendJobRequestId,
    isAuthorizedCronRequest: dependencies.isAuthorizedCronRequest ?? isAuthorizedCronRequest,
  };
}

function cronResponse(response: NextResponse, request: Request): NextResponse {
  return applyPrivateNoStoreApiResponseHeaders(response, request);
}

export async function getBackendJobTriggerRouteResponse({
  dependencies: routeDependencies,
  failureMessage,
  request,
  runJob,
}: {
  dependencies?: BackendJobTriggerRouteDependencies;
  failureMessage: string;
  request: Request;
  runJob: RunBackendJob;
}) {
  const dependencies = resolveDependencies(routeDependencies);

  if (!dependencies.isAuthorizedCronRequest(request)) {
    return cronResponse(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }), request);
  }

  const result = await runJob({
    requestId: dependencies.getBackendJobRequestId(request),
  });

  return cronResponse(
    dependencies.backendJobExecutionResponse(result, failureMessage),
    request,
  );
}

export function createBackendJobTriggerRouteHandlers(
  options: BackendJobTriggerRouteHandlerOptions,
) {
  return {
    GET(request: Request) {
      return getBackendJobTriggerRouteResponse({
        ...options,
        request,
      });
    },
  };
}
