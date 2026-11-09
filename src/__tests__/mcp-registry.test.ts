import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import * as registryAuthRoute from '@/app/.well-known/mcp-registry-auth/route';
import {
  MCP_DEVELOPERS_PAGE_URL,
  MCP_PLUGIN_REPOSITORY,
  MCP_SERVER_ORIGIN,
  MCP_SERVER_URL,
} from '@/lib/mcp-client-directory';
import { MCP_REGISTRY_PUBLIC_KEY, mcpRegistryAuthRecord } from '@/lib/mcp-registry-auth';
import { MCP_SERVER_VERSION } from '@/lib/mcp-server-service';

/** The DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410), before the raw 32-byte key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

type ServerJson = {
  $schema: string;
  name: string;
  title?: string;
  description: string;
  version: string;
  websiteUrl?: string;
  repository?: { url: string; source: string; id?: string };
  remotes?: Array<{ type: string; url: string }>;
  packages?: unknown[];
};

describe('the MCP registry entry', () => {
  const server = JSON.parse(readFileSync(path.join(process.cwd(), 'server.json'), 'utf8')) as ServerJson;

  it('names the domain-verified namespace and the remote server, in the current schema', () => {
    expect(server.$schema).toBe('https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
    // Domain authentication: the namespace is the reverse-DNS form of the domain that proves it.
    const reverseDomain = new URL(MCP_SERVER_ORIGIN).hostname.split('.').reverse().join('.');
    expect(server.name).toBe(`${reverseDomain}/mcp`);
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(server.remotes).toEqual([{ type: 'streamable-http', url: MCP_SERVER_URL }]);
    // Remote only: no package for the registry to verify ownership of.
    expect(server.packages).toBeUndefined();
    expect(server.websiteUrl).toBe(MCP_DEVELOPERS_PAGE_URL);
    expect(server.repository).toMatchObject({ url: `https://github.com/${MCP_PLUGIN_REPOSITORY}`, source: 'github' });
  });

  it('stays inside the schema’s limits and versions with the server', () => {
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.title?.length ?? 0).toBeLessThanOrEqual(100);
    // The registry refuses a version it already has, so each publish bumps both together.
    expect(server.version).toBe(MCP_SERVER_VERSION);
  });
});

describe('/.well-known/mcp-registry-auth', () => {
  it('serves the one-line proof record as plain text, statically', async () => {
    expect(registryAuthRoute.dynamic).toBe('force-static');
    const response = registryAuthRoute.GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300');

    const body = await response.text();
    expect(body).toBe(mcpRegistryAuthRecord());
    expect(body).toMatch(/^v=MCPv1; k=ed25519; p=[A-Za-z0-9+/]{43}=$/);
    // The registry reads at most 4096 bytes.
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(4096);
  });

  it('names a 32-byte Ed25519 public key', () => {
    const raw = Buffer.from(MCP_REGISTRY_PUBLIC_KEY, 'base64');
    expect(raw).toHaveLength(32);
    expect(raw.toString('base64')).toBe(MCP_REGISTRY_PUBLIC_KEY);
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    expect(key.asymmetricKeyType).toBe('ed25519');
  });
});
