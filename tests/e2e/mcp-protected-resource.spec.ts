import { expect, test } from '@playwright/test';

/**
 * The first two steps every MCP client takes against the server, offline: the RFC 9728
 * protected-resource document (both well-known URLs) and the 401 challenge an unauthenticated
 * call is answered with, whose `resource_metadata` names that document. The E2E server runs with
 * `MCP_AUTHORIZATION_SERVER=both` (playwright.config.ts), so the authorization server it names
 * is the app's own, this origin, whose RFC 8414 document is read here too
 * (docs/plans/agent-token-broker-plan-2026-11-26.md); with the flag unset it names the project's
 * `/auth/v1`, which `oauth-protected-resource-metadata.test.ts` holds. Nothing here needs a token
 * or a page.
 */

const BASE = 'http://127.0.0.1:3100';

test('the MCP server publishes its protected-resource metadata and challenges an unauthenticated call', async ({ request }) => {
  const metadata = {
    resource: `${BASE}/api/mcp`,
    authorization_servers: [BASE],
    bearer_methods_supported: ['header'],
    resource_name: 'Magicbooklet MCP server',
    resource_documentation: `${BASE}/developers/mcp`,
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

test('the authorization server the documents name publishes its own metadata, and no way to register', async ({ request }) => {
  const response = await request.get('/.well-known/oauth-authorization-server', { timeout: 0 });
  expect(response.status()).toBe(200);
  expect(response.headers()['access-control-allow-origin']).toBe('*');
  const document = await response.json();
  expect(document).toMatchObject({
    issuer: BASE,
    authorization_endpoint: `${BASE}/oauth/authorize`,
    token_endpoint: `${BASE}/oauth/token`,
    revocation_endpoint: `${BASE}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
  });
  expect(document.registration_endpoint).toBeUndefined();

  // The token endpoint answers a browser-based client's preflight, and refuses a body that is
  // not a form before it reads anything.
  const preflight = await request.fetch('/oauth/token', { method: 'OPTIONS', timeout: 0 });
  expect(preflight.status()).toBe(204);
  expect(preflight.headers()['access-control-allow-methods']).toBe('POST, OPTIONS');
});

test('the posting-only server is a resource of its own: its document names its URL and its challenge names its document', async ({ request }) => {
  const path = '/.well-known/oauth-protected-resource/api/mcp/posts';
  const document = await request.get(path, { timeout: 0 });
  expect(document.status()).toBe(200);
  expect(document.headers()['access-control-allow-origin']).toBe('*');
  expect(await document.json()).toEqual({
    resource: `${BASE}/api/mcp/posts`,
    authorization_servers: [BASE],
    bearer_methods_supported: ['header'],
    resource_name: 'Magicbooklet posting server',
    resource_documentation: `${BASE}/developers/mcp/posting`,
  });

  const unauthenticated = await request.post('/api/mcp/posts', {
    timeout: 0,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(unauthenticated.status()).toBe(401);
  expect(unauthenticated.headers()['www-authenticate']).toBe(
    `Bearer resource_metadata="${BASE}${path}", error="invalid_token", error_description="Sign in to Magicbooklet to use this server."`,
  );
  expect(await unauthenticated.json()).toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });

  const stream = await request.get('/api/mcp/posts', { timeout: 0 });
  expect(stream.status()).toBe(405);
});
