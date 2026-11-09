import { createMcpRegistryAuthResponse } from '@/lib/mcp-registry-auth';

// The MCP registry's HTTP proof of the domain (`src/lib/mcp-registry-auth.ts`): one plain-text
// line naming the publishing key's public half. It reads no env and no data, so it is built once
// and served from the CDN. The proxy's matcher does not cover /.well-known, and nothing redirects
// it, which the registry's fetch would not follow.
export const dynamic = 'force-static';

export function GET() {
  return createMcpRegistryAuthResponse();
}
