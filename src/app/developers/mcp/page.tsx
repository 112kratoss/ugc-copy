import type { Metadata } from 'next';

import { MCP_CLIENT_IDS, MCP_DEVELOPERS_PAGE_PATH } from '@/lib/mcp-client-directory';
import { createMetadata } from '@/lib/seo';

import McpDeveloperGuide from './McpDeveloperGuide';

export const metadata: Metadata = createMetadata({
  title: 'Connect AI agents with MCP',
  description:
    'Connect Claude, ChatGPT, Codex or Cursor to Magic Booklet’s MCP server: create AI images and videos with your credits, quoted first, and publish them as posts.',
  path: MCP_DEVELOPERS_PAGE_PATH,
  keywords: [
    'Magic Booklet MCP server',
    'MCP server for AI video',
    'Claude custom connector',
    'ChatGPT MCP connector',
    'Claude Code MCP',
    'Codex MCP',
    'Cursor MCP',
  ],
});

/**
 * `/developers/mcp`: how to connect an agent to the MCP server. Public and static; the client ids
 * are `src/lib/mcp-client-directory.ts`'s, and a client whose id is still a placeholder shows as
 * coming soon.
 */
export default function McpDevelopersPage() {
  return <McpDeveloperGuide clientIds={MCP_CLIENT_IDS} />;
}
