/**
 * The official MCP registry's proof that this domain may publish servers named
 * `com.magicbooklet/*` (registry docs, "Authentication" → "HTTP Authentication"; the entry
 * itself is `server.json` at the repository root).
 *
 * The registry fetches `https://magicbooklet.com/.well-known/mcp-registry-auth` when an operator
 * runs `mcp-publisher login http --domain magicbooklet.com --private-key <hex seed>`, and checks
 * the signature the publisher made with the private key against the public key this record
 * names. Only the public key is here: the private key never enters the repository, the app or
 * its environment (`docs/mcp-server-operations.md`, "Distribution" → "MCP registry", which also
 * covers the DNS TXT alternative and rotating the key).
 *
 * The registry's fetch follows no redirect, reads at most 4096 bytes, trims surrounding
 * whitespace and gives up after 10 seconds, so the route answers this one line, statically.
 */

export const MCP_REGISTRY_AUTH_PATH = '/.well-known/mcp-registry-auth';

export const MCP_REGISTRY_AUTH_ALGORITHM = 'ed25519';

/** The raw 32-byte Ed25519 public key, base64 (`openssl pkey -pubout -outform DER | tail -c 32 | base64`). */
export const MCP_REGISTRY_PUBLIC_KEY = 'FATsjTfnwNWvdsFAiufJ/lOb8DG9KmELhZDLjVMuQo8=';

/** The proof record, exactly as `mcp-publisher login` prints it under "Expected proof record". */
export function mcpRegistryAuthRecord(publicKey: string = MCP_REGISTRY_PUBLIC_KEY): string {
  return `v=MCPv1; k=${MCP_REGISTRY_AUTH_ALGORITHM}; p=${publicKey}`;
}

/**
 * Short-lived at the CDN: after a key rotation the next login must see the new record within
 * minutes, not hours.
 */
const REGISTRY_AUTH_CACHE_CONTROL = 'public, max-age=300, s-maxage=300';

export function createMcpRegistryAuthResponse(): Response {
  return new Response(mcpRegistryAuthRecord(), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': REGISTRY_AUTH_CACHE_CONTROL,
    },
  });
}
