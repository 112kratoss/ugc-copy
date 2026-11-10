import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { MCP_POSTS_ROUTE_PATH, MCP_ROUTE_PATH, MCP_ROUTE_PATHS, routeAcceptsAgentToken } from '@/lib/agent-token';
import { MCP_POSTS_SERVER_URL, MCP_SERVER_ORIGIN, MCP_SERVER_URL } from '@/lib/mcp-client-directory';
import { MCP_SURFACE_ROUTE_PATHS } from '@/lib/mcp-surfaces';
import { routeIdentityPolicyForRequest } from '@/lib/route-identity-policy';
import { usesRouteOwnedIdentityAdmission } from '@/lib/route-owned-identity-admission';

/**
 * The MCP server's two paths are written in four places: the paths an agent token is admitted
 * to, the surfaces' own map, the registered-route policy and the list of routes that run their
 * own admission. A path in one and not the others is either open or unreachable, so they are
 * held together here.
 */
describe('the MCP surfaces and their paths', () => {
  it('names one path per surface, the same paths an agent token is admitted to', () => {
    expect(MCP_SURFACE_ROUTE_PATHS).toEqual({ full: MCP_ROUTE_PATH, posts: MCP_POSTS_ROUTE_PATH });
    expect(Object.values(MCP_SURFACE_ROUTE_PATHS).sort()).toEqual([...MCP_ROUTE_PATHS].sort());
    expect(MCP_SERVER_URL).toBe(`${MCP_SERVER_ORIGIN}${MCP_SURFACE_ROUTE_PATHS.full}`);
    expect(MCP_POSTS_SERVER_URL).toBe(`${MCP_SERVER_ORIGIN}${MCP_SURFACE_ROUTE_PATHS.posts}`);
  });

  it('holds every path to the same three rules: registered, admitted at the route, open to an agent token', () => {
    for (const pathname of Object.values(MCP_SURFACE_ROUTE_PATHS)) {
      expect(routeAcceptsAgentToken(pathname), pathname).toBe(true);
      for (const method of ['GET', 'POST', 'DELETE']) {
        const request = new NextRequest(`https://magicbooklet.test${pathname}`, { method });
        expect(usesRouteOwnedIdentityAdmission(request), `${method} ${pathname}`).toBe(true);
        // A registered account only: a guest's token is refused, as on every registered route.
        expect(routeIdentityPolicyForRequest(pathname, method), `${method} ${pathname}`).toBe('registered');
      }
    }
  });
});
