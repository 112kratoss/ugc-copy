import type { Metadata } from 'next';

import {
  MCP_DEVELOPERS_PAGE_PATH,
  isPendingClientId,
  type McpClientIds,
  type McpClientSurface,
} from '@/lib/mcp-client-directory';
import { createMetadata } from '@/lib/seo';

/**
 * The words of `/developers/mcp` that depend on which clients are registered: the header's
 * sentence and the search snippet name only the apps a creator can connect today, and the rest as
 * coming. Kept out of `page.tsx`, which may export only Next's page fields.
 */

/** The apps the page names, each connectable once any of its surfaces has a registered client. */
const APPS: ReadonlyArray<{ name: string; surfaces: readonly McpClientSurface[] }> = [
  { name: 'Claude', surfaces: ['claude', 'claudeCode'] },
  { name: 'ChatGPT', surfaces: ['chatgpt'] },
  { name: 'Codex', surfaces: ['codex'] },
  { name: 'Cursor', surfaces: ['cursor'] },
];

/** The search phrase each client's block answers, listed only while that client can connect. */
const CLIENT_KEYWORDS: Readonly<Record<McpClientSurface, string>> = {
  claude: 'Claude custom connector',
  claudeCode: 'Claude Code MCP',
  chatgpt: 'ChatGPT MCP connector',
  codex: 'Codex MCP',
  cursor: 'Cursor MCP',
};

function joinNames(names: readonly string[], conjunction: 'or' | 'and'): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} ${conjunction} ${names[names.length - 1]}`;
}

/** Which apps a creator can connect now and which come later, from the client ids alone. */
export function connectableApps(clientIds: McpClientIds): { available: string[]; pending: string[] } {
  const available: string[] = [];
  const pending: string[] = [];
  for (const app of APPS) {
    (app.surfaces.some((surface) => !isPendingClientId(clientIds[surface])) ? available : pending).push(app.name);
  }
  return { available, pending };
}

/** "Connect Claude, Codex or Cursor today, and ChatGPT soon." Never names a waiting app as connectable. */
export function connectSentence(clientIds: McpClientIds): string {
  const { available, pending } = connectableApps(clientIds);
  if (available.length === 0) return `${joinNames(pending, 'and')} can connect soon.`;
  if (pending.length === 0) return `Connect ${joinNames(available, 'or')}.`;
  return `Connect ${joinNames(available, 'or')} today, and ${joinNames(pending, 'and')} soon.`;
}

export function mcpPageMetadata(clientIds: McpClientIds): Metadata {
  const { available, pending } = connectableApps(clientIds);
  const apps = available.length === 0
    ? 'Connect your AI agent'
    : `Connect ${joinNames(available, 'or')}${pending.length > 0 ? ` (${joinNames(pending, 'and')} soon)` : ''}`;
  return createMetadata({
    title: 'Connect AI agents with MCP',
    description: `${apps} to Magic Booklet’s MCP server: create AI images and videos with your credits, quoted first, and publish them as posts.`,
    path: MCP_DEVELOPERS_PAGE_PATH,
    keywords: [
      'Magic Booklet MCP server',
      'MCP server for AI video',
      ...(Object.keys(CLIENT_KEYWORDS) as McpClientSurface[])
        .filter((surface) => !isPendingClientId(clientIds[surface]))
        .map((surface) => CLIENT_KEYWORDS[surface]),
    ],
  });
}
