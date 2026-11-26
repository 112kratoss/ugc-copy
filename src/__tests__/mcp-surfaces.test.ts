import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { MCP_POSTS_ROUTE_PATH, MCP_ROUTE_PATH } from '@/lib/agent-token';
import { MCP_POSTS_SERVER_URL, MCP_SERVER_ORIGIN, MCP_SERVER_URL } from '@/lib/mcp-client-directory';
import { MCP_SURFACE_ROUTE_PATHS } from '@/lib/mcp-surfaces';
import { routeIdentityPolicyForRequest } from '@/lib/route-identity-policy';
import { usesRouteOwnedIdentityAdmission } from '@/lib/route-owned-identity-admission';

/**
 * The MCP server's two paths are written in three places: the surfaces' own map, the
 * registered-route policy and the list of routes that run their own admission. A path in one and not the others is either open or unreachable, so they are
 * held together here.
 */
describe('the MCP surfaces and their paths', () => {
  it('names one path per surface', () => {
    expect(MCP_SURFACE_ROUTE_PATHS).toEqual({ full: MCP_ROUTE_PATH, posts: MCP_POSTS_ROUTE_PATH });
    expect(MCP_SERVER_URL).toBe(`${MCP_SERVER_ORIGIN}${MCP_SURFACE_ROUTE_PATHS.full}`);
    expect(MCP_POSTS_SERVER_URL).toBe(`${MCP_SERVER_ORIGIN}${MCP_SURFACE_ROUTE_PATHS.posts}`);
  });

  it('holds every path to the same two rules: registered, and admitted at the route', () => {
    for (const pathname of Object.values(MCP_SURFACE_ROUTE_PATHS)) {
      for (const method of ['GET', 'POST', 'DELETE']) {
        const request = new NextRequest(`https://magicbooklet.test${pathname}`, { method });
        expect(usesRouteOwnedIdentityAdmission(request), `${method} ${pathname}`).toBe(true);
        // A registered account only: a guest's token is refused, as on every registered route.
        expect(routeIdentityPolicyForRequest(pathname, method), `${method} ${pathname}`).toBe('registered');
      }
    }
  });
});
