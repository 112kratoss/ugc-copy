import { expect, test } from '@playwright/test';

/**
 * The first two steps every MCP client takes against the server, offline: the RFC 9728
 * protected-resource document (both well-known URLs) and the 401 challenge an unauthenticated
 * call is answered with, whose `resource_metadata` names that document. The E2E server runs on
 * the placeholder project (playwright.config.ts), so the authorization server it names is
 * `https://example.supabase.co/auth/v1`. Nothing here needs a token or a page.
 */

const BASE = 'http://127.0.0.1:3100';

test('the MCP server publishes its protected-resource metadata and challenges an unauthenticated call', async ({ request }) => {
  const metadata = {
    resource: `${BASE}/api/mcp`,
    authorization_servers: ['https://example.supabase.co/auth/v1'],
    bearer_methods_supported: ['header'],
    resource_name: 'Magicbooklet MCP server',
  };

  // No timeout of their own: the first request for each route waits for its compile
  // (.claude/rules/e2e.md).
  for (const path of ['/.well-known/oauth-protected-resource/api/mcp', '/.well-known/oauth-protected-resource']) {
    const response = await request.get(path, { timeout: 0 });
    expect(response.status(), path).toBe(200);
    expect(response.headers()['content-type'], path).toContain('application/json');
    expect(response.headers()['access-control-allow-origin'], path).toBe('*');
    expect(response.headers()['cache-control'], path).toContain('public');
    expect(await response.json(), path).toEqual(metadata);
  }

  const unauthenticated = await request.post('/api/mcp', {
    timeout: 0,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(unauthenticated.status()).toBe(401);
  expect(unauthenticated.headers()['www-authenticate']).toBe(
    `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/api/mcp", error="invalid_token", error_description="Sign in to Magicbooklet to use this server."`,
  );
  expect(unauthenticated.headers()['cache-control']).toBe('private, no-store');
  expect(await unauthenticated.json()).toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });

  // Stateless: no SSE stream to open and no session to end.
  const stream = await request.get('/api/mcp', { timeout: 0 });
  expect(stream.status()).toBe(405);
  expect(stream.headers().allow).toBe('POST');
});
