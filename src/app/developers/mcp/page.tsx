import type { Metadata } from 'next';

import { MCP_CLIENT_IDS } from '@/lib/mcp-client-directory';

import McpDeveloperGuide from './McpDeveloperGuide';
import { mcpPageMetadata } from './mcp-page-copy';

export const metadata: Metadata = mcpPageMetadata(MCP_CLIENT_IDS);

/**
 * `/developers/mcp`: how to connect an agent to the MCP server. Public and static; the client ids
 * are `src/lib/mcp-client-directory.ts`'s, and a client whose id is still a placeholder shows as
 * coming soon, in its block, the header and the search snippet.
 */
export default function McpDevelopersPage() {
  return <McpDeveloperGuide clientIds={MCP_CLIENT_IDS} />;
}
