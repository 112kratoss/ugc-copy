import { MCP_POSTS_ROUTE_PATH, MCP_ROUTE_PATH } from '@/lib/agent-token';

/**
 * The MCP server's two surfaces: the same server at two paths, differing only in which tools
 * each registers and in the words that go with them.
 *
 * - `full`, at `/api/mcp`: every tool. Creators add it by URL, through the Claude Code plugin or
 *   from the setup page (`/developers/mcp`).
 * - `posts`, at `/api/mcp/posts`: the tools that stage a file, publish, read and delete a post
 *   and list the creator's creations. Nothing on it starts a run, prices one, enhances a prompt
 *   or spends a credit. It exists because Claude's connectors directory lists no connector that
 *   generates images, video or audio with AI (Anthropic Software Directory Policy, 4.B), so the
 *   server submitted there is this one (`docs/mcp-server-operations.md`, "Anthropic's Connectors
 *   Directory").
 *
 * The tool list is not the only line. An OAuth client registered for the directory listing is
 * posting-only (`MCP_POSTING_ONLY_CLIENT_IDS` in `mcp-client-directory.ts`): a token issued to
 * it is refused at `/api/mcp` (403 `AGENT_SURFACE_NOT_ALLOWED`, in the route adapter), and the
 * consent page shows that client the posting-only access list. So what the person approved on
 * the consent page is what the token can do on this app's routes. Every other client may use
 * either path: `posts` is a subset of what it was granted.
 */

export type McpSurface = 'full' | 'posts';

export const MCP_SURFACE_ROUTE_PATHS: Readonly<Record<McpSurface, string>> = {
  full: MCP_ROUTE_PATH,
  posts: MCP_POSTS_ROUTE_PATH,
};
