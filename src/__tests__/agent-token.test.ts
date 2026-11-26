import { describe, expect, it } from 'vitest';

import {
  AGENT_TOKEN_CLAIM,
  MCP_POSTS_ROUTE_PATH,
  MCP_ROUTE_PATH,
  agentTokenClientId,
  isAgentToken,
  isAppAgentAccessToken,
} from '@/lib/agent-token';

describe('agent tokens', () => {
  it('knows a Supabase agent JWT by the client_id claim, which no app session has', () => {
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

  it('knows the app\'s own access token by its shape alone, and never a JWT', () => {
    expect(isAppAgentAccessToken(`mbat_${'A'.repeat(43)}`)).toBe(true);
    for (const token of [
      `mbat_${'A'.repeat(42)}`,
      `mbrt_${'A'.repeat(43)}`,
      `mbat_${'A'.repeat(42)}=`,
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln',
      '',
      null,
      undefined,
    ]) {
      expect(isAppAgentAccessToken(token), String(token)).toBe(false);
    }
  });

  it('names the MCP routes, the full server and its posting-only form', () => {
    expect(MCP_ROUTE_PATH).toBe('/api/mcp');
    expect(MCP_POSTS_ROUTE_PATH).toBe('/api/mcp/posts');
  });
});
