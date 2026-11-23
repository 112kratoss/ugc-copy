import { after, NextRequest } from 'next/server';

import { MCP_POSTS_ROUTE_PATH, MCP_ROUTE_PATH } from '@/lib/agent-token';
import {
  createAdmittedIdentityHeaders,
  evaluateUserFacingRouteIdentity,
  type ProxyIdentityAdmission,
  type ProxyIdentityDependencies,
  type VerifiedRouteToken,
} from '@/lib/route-identity-admission';

/**
 * The API requests whose identity admission runs at the route itself instead of in the proxy.
 *
 * The proxy strips every incoming assertion and timing header and defers only these; every
 * other API path keeps central proxy admission. Each entry must be wrapped at its actual route
 * export, with `withRouteOwnedIdentityAdmission` or an admission of its own built from the same
 * evaluator (the MCP adapter's): a path listed here and not wrapped is open. Keep the list short.
 *
 * - The showcase feed's reads run admission next to the database, in the API function's
 *   Mumbai region, so the lifecycle round trip is a local one, and count a signed-in read
 *   against its read limit beside that round trip (`besideLifecycle`).
 * - The MCP server, at both its paths, answers an agent's missing or invalid token with the
 *   `WWW-Authenticate` challenge MCP clients need, which the proxy's 401 does not carry, and
 *   requires the agent-token claim the proxy refuses everywhere else (`agent-token.ts`).
 */
const ROUTE_OWNED_ADMISSION: ReadonlyArray<{
  pathname: string;
  /** The methods deferred, or every method. */
  methods: ReadonlySet<string> | 'all';
}> = [
  { pathname: '/api/showcase/feed', methods: new Set(['GET', 'HEAD']) },
  { pathname: MCP_ROUTE_PATH, methods: 'all' },
  { pathname: MCP_POSTS_ROUTE_PATH, methods: 'all' },
];

export function usesRouteOwnedIdentityAdmission(request: NextRequest): boolean {
  const method = request.method.toUpperCase();
  return ROUTE_OWNED_ADMISSION.some((entry) => (
    entry.pathname === request.nextUrl.pathname
    && (entry.methods === 'all' || entry.methods.has(method))
  ));
}

/**
 * The request a route hands its adapter once admission has passed: the caller's request with
 * the admitted headers (the fresh assertion in place of anything the caller sent) and, for a
 * method with a body, the body the caller sent.
 *
 * App Router supplies a Proxy around the native Request. Node 24's Request copy constructor
 * reads private fields on it and throws (#state), so the request is rebuilt from public fields
 * instead of passing the proxied object to the native copy constructor. A GET or HEAD has no
 * body; a POST's is read here, once, since the proxied body stream cannot be handed on either.
 */
export async function rebuildAdmittedRequest(
  request: NextRequest,
  admission: ProxyIdentityAdmission,
): Promise<NextRequest> {
  const headers = createAdmittedIdentityHeaders(request, admission, 'route');
  const method = request.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : await request.text();
  return new NextRequest(request.url, {
    method: request.method,
    headers,
    signal: request.signal,
    ...(body === undefined ? {} : { body }),
  });
}

/**
 * Work a route starts beside the lifecycle round trip (`besideLifecycle`). Neither promise may
 * reject. `release` runs after the request has been answered, whatever the answer, and undoes the
 * work unless the route's handler used it (the feed gives back a count no handler read).
 */
export type StartedBesideLifecycle = {
  readonly settled: Promise<unknown>;
  readonly release: () => Promise<void>;
};

/**
 * Runs a task after the response is sent (`after()`). Outside a request's scope, where `after`
 * throws (a route export called directly, as the tests do), the task runs at once, unawaited.
 */
function runAfterResponseByDefault(task: () => Promise<void>) {
  try {
    after(task);
  } catch {
    void task();
  }
}

/**
 * Run the same fresh checks at the route, before any route work.
 *
 * `besideLifecycle`, when given, is started from the token's locally verified subject the moment
 * it is verified, so it runs beside the lifecycle round trip instead of after it; it must be
 * work that only needs that subject and that the route would do for an admitted request anyway
 * (the feed's read limit). The route's handler, which runs only once admission has passed, gets
 * what it started (null when nothing was: no token, or a token refused before the round trip).
 * A refusal answers at once, exactly as it would without it, and never reads what the work found.
 * Every answer is followed by the work's `release`, after the response (`runAfterResponse`), so
 * work no handler used is undone without delaying any answer.
 */
export async function withRouteOwnedIdentityAdmission<Started extends StartedBesideLifecycle = never>(
  request: NextRequest,
  handler: (admitted: NextRequest, started: Started | null) => Promise<Response>,
  dependencies: ProxyIdentityDependencies = {},
  besideLifecycle?: (token: VerifiedRouteToken) => Started | null,
  runAfterResponse: (task: () => Promise<void>) => void = runAfterResponseByDefault,
): Promise<Response> {
  const beside: { started: Started | null } = { started: null };
  // Never trust an incoming assertion, even a still-valid one: revocation and
  // lifecycle changes must be checked on each request at this boundary.
  const admission = await evaluateUserFacingRouteIdentity(request, besideLifecycle
    ? {
        ...dependencies,
        onTokenVerified: (token) => {
          beside.started = besideLifecycle(token);
          // Handled from the start: the lifecycle round trip is awaited before anything reads it.
          beside.started?.settled.catch(() => undefined);
        },
      }
    : dependencies);
  try {
    if (admission.rejection) return admission.rejection;
    return await handler(await rebuildAdmittedRequest(request, admission), beside.started);
  } finally {
    const { started } = beside;
    if (started) runAfterResponse(() => started.release().catch(() => undefined));
  }
}
