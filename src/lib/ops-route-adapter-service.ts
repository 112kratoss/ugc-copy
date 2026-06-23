import 'server-only';

import { NextResponse } from 'next/server';

import { API_CACHE_CONTROL, createApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { isAuthorizedOpsRequest } from '@/lib/cron-auth';
import { createServiceClient } from '@/lib/server-helpers';

type OperationalStatus = {
  status?: string;
};

type OpsRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  isAuthorizedOpsRequest?: typeof isAuthorizedOpsRequest;
  logError?: (message: string) => void;
};

type ProtectedOpsRouteOptions<TReport extends OperationalStatus> = {
  collect: (client: ReturnType<typeof createServiceClient>) => Promise<TReport>;
  dependencies?: OpsRouteDependencies;
  failureLogMessage: string;
  failureResponseError: string;
  request: Request;
};

type ProtectedOpsRouteHandlerOptions<TReport extends OperationalStatus> = Omit<
  ProtectedOpsRouteOptions<TReport>,
  'request'
>;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error) || String(error);
  } catch {
    return String(error);
  }
}

function resolveDependencies(dependencies: OpsRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    isAuthorizedOpsRequest: dependencies?.isAuthorizedOpsRequest ?? isAuthorizedOpsRequest,
    logError: dependencies?.logError ?? console.error,
  };
}

export async function getProtectedOpsRouteResponse<TReport extends OperationalStatus>({
  collect,
  dependencies,
  failureLogMessage,
  failureResponseError,
  request,
}: ProtectedOpsRouteOptions<TReport>) {
  const resolvedDependencies = resolveDependencies(dependencies);
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore);
  const requestId = getApiRequestId(request);

  if (!resolvedDependencies.isAuthorizedOpsRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });
  }

  try {
    const report = await collect(resolvedDependencies.createServiceClient());
    return NextResponse.json(report, {
      status: report.status === 'degraded' ? 503 : 200,
      headers,
    });
  } catch (error) {
    resolvedDependencies.logError(JSON.stringify({
      level: 'error',
      msg: failureLogMessage,
      requestId,
      error: errorMessage(error),
    }));
    return NextResponse.json(
      {
        status: 'degraded',
        error: failureResponseError,
      },
      {
        status: 500,
        headers,
      },
    );
  }
}

export function createProtectedOpsRouteHandlers<TReport extends OperationalStatus>(
  options: ProtectedOpsRouteHandlerOptions<TReport>,
) {
  return {
    GET(request: Request) {
      return getProtectedOpsRouteResponse({
        ...options,
        request,
      });
    },
  };
}
