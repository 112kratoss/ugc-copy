import { describe, expect, it } from 'vitest';

import {
  AGENT_TOKEN_CLAIM,
  MCP_ROUTE_PATH,
  agentTokenClientId,
  isAgentToken,
  routeAcceptsAgentToken,
} from '@/lib/agent-token';

describe('agent tokens', () => {
  it('is the client_id claim an OAuth-issued token carries, and nothing an app session has', () => {
    expect(AGENT_TOKEN_CLAIM).toBe('client_id');
    expect(agentTokenClientId({ sub: 'u', client_id: ' client-claude ' })).toBe('client-claude');
    expect(isAgentToken({ client_id: 'client-claude' })).toBe(true);
    for (const claims of [
      { sub: 'u', role: 'authenticated' },
      { client_id: '' },
      { client_id: '   ' },
      { client_id: 42 },
      { client_id: null },
      null,
      undefined,
    ]) {
      expect(agentTokenClientId(claims), JSON.stringify(claims)).toBeNull();
      expect(isAgentToken(claims), JSON.stringify(claims)).toBe(false);
    }
  });

  it('is admitted to the MCP route and to no other path', () => {
    expect(MCP_ROUTE_PATH).toBe('/api/mcp');
    expect(routeAcceptsAgentToken('/api/mcp')).toBe(true);
    for (const pathname of ['/api/mcp/', '/api/mcp/other', '/api/generations', '/api/showcase/feed', '/api', '/']) {
      expect(routeAcceptsAgentToken(pathname), pathname).toBe(false);
    }
  });
});
