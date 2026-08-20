import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import { readBoundedJsonBody } from '@/lib/bounded-json-request';
import {
  getContactRateLimitKey,
  submitContactMessageForRoute,
  type ContactSubmissionRouteResult,
} from '@/lib/contact-submission-service';
import { createServiceClient } from '@/lib/server-helpers';

type ContactRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  getContactRateLimitKey?: typeof getContactRateLimitKey;
  readBoundedJsonBody?: typeof readBoundedJsonBody;
  submitContactMessageForRoute?: typeof submitContactMessageForRoute;
};

// All valid fields at their character limits fit even when JSON represents
// every UTF-16 code unit as a six-byte escape. The remainder covers syntax.
export const CONTACT_REQUEST_BODY_MAX_BYTES = 48 * 1024;

function resolveDependencies(dependencies: ContactRouteDependencies = {}) {
  return {
    createServiceClient: dependencies.createServiceClient ?? createServiceClient,
    getContactRateLimitKey: dependencies.getContactRateLimitKey ?? getContactRateLimitKey,
    readBoundedJsonBody: dependencies.readBoundedJsonBody ?? readBoundedJsonBody,
    submitContactMessageForRoute:
      dependencies.submitContactMessageForRoute ?? submitContactMessageForRoute,
  };
}

function toJsonResponse(result: ContactSubmissionRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

export async function postContactRouteResponse({
  dependencies: routeDependencies,
  request,
}: {
  dependencies?: ContactRouteDependencies;
  request: Request;
}) {
  const dependencies = resolveDependencies(routeDependencies);

  return applyPrivateNoStoreApiResponseHeaders(
    toJsonResponse(await dependencies.submitContactMessageForRoute({
      createAdminSupabase: dependencies.createServiceClient,
      rateLimitKey: dependencies.getContactRateLimitKey(request.headers),
      readBody: () => dependencies.readBoundedJsonBody(
        request,
        CONTACT_REQUEST_BODY_MAX_BYTES,
      ),
    })),
    request,
  );
}
