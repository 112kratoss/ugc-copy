import { NextRequest } from 'next/server';

import {
  createAdmittedIdentityHeaders,
  evaluateUserFacingRouteIdentity,
  type ProxyIdentityDependencies,
} from '@/lib/route-identity-admission';

// Every entry must be wrapped at its actual route export. Keep this rollout
// narrow: all other API paths retain central proxy admission.
export function usesRegionalIdentityAdmission(request: NextRequest): boolean {
  return request.nextUrl.pathname === '/api/showcase/feed'
    && (request.method === 'GET' || request.method === 'HEAD');
}

/** Run the same fresh checks next to the database, before any feed work. */
export async function withRegionalIdentityAdmission(
  request: NextRequest,
  handler: (admitted: NextRequest) => Promise<Response>,
  dependencies: ProxyIdentityDependencies = {},
): Promise<Response> {
  // Never trust an incoming assertion, even a still-valid one: revocation and
  // lifecycle changes must be checked on each request at this boundary.
  const admission = await evaluateUserFacingRouteIdentity(request, dependencies);
  if (admission.rejection) return admission.rejection;
  const headers = createAdmittedIdentityHeaders(request, admission, 'route');
  return handler(new NextRequest(request, { headers }));
}
