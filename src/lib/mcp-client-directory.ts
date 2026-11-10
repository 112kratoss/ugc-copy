import { MCP_POSTS_ROUTE_PATH, MCP_ROUTE_PATH } from '@/lib/agent-token';

/**
 * The agents a creator can connect to the MCP server, and the OAuth client each one signs in
 * with (`docs/mcp-server-operations.md`, "Registering a client" and "Distribution").
 *
 * One constant per fact, read by everything that states it: the setup page (`/developers/mcp`)
 * and the protected-resource metadata's documentation link import it, and since a JSON file
 * cannot import anything, tests hold the Claude Code plugin (`plugins/magicbooklet/`), its
 * marketplace (`.claude-plugin/marketplace.json`) and the MCP registry entry (`server.json`) to
 * these values.
 *
 * Production only. Each client id is a row in the production project's OAuth server and the
 * consent page lives on the production Site URL, so the URLs here are production's whatever
 * deployment renders the page: a preview cannot run the OAuth flow.
 *
 * A client id is public (every authorize URL carries it), so it lives in code. Until the operator
 * registers a surface's client (`npm run ops:oauth-clients -- create ... --apply`, with the
 * redirect URIs below), its id is a `CLIENT_ID_PENDING_<SURFACE>` placeholder and the page shows
 * that surface as coming soon rather than a command that cannot sign in.
 */

export const MCP_SERVER_ORIGIN = 'https://magicbooklet.com';

/** The server's URL, as every client is told to connect to it. */
export const MCP_SERVER_URL = `${MCP_SERVER_ORIGIN}${MCP_ROUTE_PATH}`;

/**
 * The posting-only server's URL (`mcp-surfaces.ts`): what Claude's connectors directory lists.
 * No setup command names it; a person connects it from the directory, or by URL.
 */
export const MCP_POSTS_SERVER_URL = `${MCP_SERVER_ORIGIN}${MCP_POSTS_ROUTE_PATH}`;

/** The name the setup commands and config files give the server. */
export const MCP_SERVER_KEY = 'magicbooklet';

/** The public setup page, which the protected-resource metadata names as its documentation. */
export const MCP_DEVELOPERS_PAGE_PATH = '/developers/mcp';
export const MCP_DEVELOPERS_PAGE_URL = `${MCP_SERVER_ORIGIN}${MCP_DEVELOPERS_PAGE_PATH}`;

/** The posting-only server's own page: the documentation its directory listing links to. */
export const MCP_POSTS_PAGE_PATH = '/developers/mcp/posting';

/**
 * Production's RFC 9728 document for the server, as `protectedResourceMetadataUrl` builds it for
 * any origin (`oauth-protected-resource-metadata.ts`, which imports this module, so the value is
 * spelled out here and the test holds the two together).
 */
export const MCP_PROTECTED_RESOURCE_METADATA_URL = `${MCP_SERVER_ORIGIN}/.well-known/oauth-protected-resource${MCP_ROUTE_PATH}`;
export const MCP_POSTS_PROTECTED_RESOURCE_METADATA_URL = `${MCP_SERVER_ORIGIN}/.well-known/oauth-protected-resource${MCP_POSTS_ROUTE_PATH}`;

/**
 * The Claude Code plugin marketplace this public repository serves (`.claude-plugin/marketplace.json`)
 * and its one plugin (`plugins/magicbooklet/`): the marketplace and the plugin share the name.
 */
export const MCP_PLUGIN_REPOSITORY = '112kratoss/ugc-copy';
export const MCP_PLUGIN_MARKETPLACE_NAME = 'magicbooklet';
export const MCP_PLUGIN_NAME = 'magicbooklet';
export const MCP_PLUGIN_MARKETPLACE_ADD_COMMAND = `claude plugin marketplace add ${MCP_PLUGIN_REPOSITORY}`;
export const MCP_PLUGIN_INSTALL_COMMAND = `claude plugin install ${MCP_PLUGIN_NAME}@${MCP_PLUGIN_MARKETPLACE_NAME}`;

/**
 * Claude Code's OAuth callback listener. GoTrue matches a redirect URI exactly (no
 * port-agnostic loopback), so the port is fixed and the client's redirect URI is
 * `http://localhost:8976/callback`.
 */
export const CLAUDE_CODE_CALLBACK_PORT = 8976;

/** Codex's listener, pinned with `callback_port` for the same reason; Codex otherwise picks one. */
export const CODEX_CALLBACK_PORT = 8977;

/**
 * The callback ID Codex appends to its redirect path for this server, because GoTrue sends no
 * RFC 9207 `iss` and Codex then always adds one, ignoring a configured `callback_url` that lacks
 * it. Codex derives it from the server URL alone (the first 9 bytes of the SHA-256 of the URL
 * without its fragment, base64url with no padding: `callback_id_from_server_url` in openai/codex,
 * `codex-rs/rmcp-client/src/oauth_callback.rs`), so every creator's Codex sends the same redirect
 * URI. `mcp-client-directory.test.ts` recomputes it from `MCP_SERVER_URL`.
 */
export const CODEX_CALLBACK_ID = 'PPpoTd8EYBlz';

export const PENDING_CLIENT_ID_PREFIX = 'CLIENT_ID_PENDING_';

export type McpClientSurface = 'claude' | 'claudeCode' | 'chatgpt' | 'codex' | 'cursor';

export type McpClientIds = Readonly<Record<McpClientSurface, string>>;

/**
 * Each surface's production OAuth client id: a placeholder until its client is registered.
 * Registered 2026-11-09 (runbook, "Registered clients"); ChatGPT's waits for its connector, whose
 * redirect URI exists only once the connector does.
 */
export const MCP_CLIENT_IDS: McpClientIds = {
  claude: 'cf5743f9-c83c-4f6c-9afb-0803d5aee698',
  claudeCode: '0b968a27-4f37-4972-8d7a-f3c67b365a33',
  chatgpt: 'CLIENT_ID_PENDING_CHATGPT',
  codex: '6508034a-cdb9-4f23-9263-7bf332096acb',
  cursor: 'cd3b041d-a942-4917-b37f-735744ca4026',
};

/**
 * The production OAuth clients that are posting-only: a token issued to one drives
 * `/api/mcp/posts` and is refused at `/api/mcp`, and the consent page and Connected apps show it
 * the posting-only access (`mcp-surfaces.ts`). Both were registered 2026-11-10 with the hosted
 * Claude apps' redirect URI (`https://claude.ai/api/mcp/auth_callback`):
 *
 * - `claudeDirectory`: the confidential client of the listing in Claude's connectors directory,
 *   whose secret Anthropic holds.
 * - `claudeByUrl`: the public client a person types into a custom connector for the posting
 *   server's URL (`/developers/mcp/posting`). The `claude` client above is the full server's; a
 *   person who adds the posting server with it has approved the full list, and has it.
 *
 * The line is a deny-list, so it fails open: an id leaves this list only after its client is
 * deleted from the OAuth server. A client replaced by a new one (a lost secret) is deleted
 * first, or its id stays here beside the new one (the runbook, "Its OAuth clients").
 */
export const MCP_POSTING_ONLY_CLIENT_IDS: Readonly<Record<'claudeDirectory' | 'claudeByUrl', string>> = {
  claudeDirectory: '1b4db392-2141-413b-be41-f833dfdcab42',
  claudeByUrl: '1e2e3615-17a1-448f-9d4c-5cbcd2a572a7',
};

/** Whether an OAuth client is one of the posting-only ones. */
export function isPostingOnlyClientId(clientId: string | null | undefined): boolean {
  if (typeof clientId !== 'string') return false;
  const trimmed = clientId.trim().toLowerCase();
  return trimmed !== '' && Object.values(MCP_POSTING_ONLY_CLIENT_IDS).includes(trimmed);
}

/**
 * The exact redirect URIs each client sends, which its OAuth client must be registered with
 * (GoTrue matches them exactly). ChatGPT's is per connector,
 * `https://chatgpt.com/connector/oauth/{callback_id}`, shown on the connector's page once it is
 * created, so it has no entry here: register what that page shows.
 */
export const MCP_CLIENT_REDIRECT_URIS: Readonly<Record<McpClientSurface, readonly string[]>> = {
  claude: ['https://claude.ai/api/mcp/auth_callback'],
  claudeCode: [`http://localhost:${CLAUDE_CODE_CALLBACK_PORT}/callback`],
  chatgpt: [],
  // The first is the one Codex sends; production also carries the `localhost` form as a spare.
  codex: [
    `http://127.0.0.1:${CODEX_CALLBACK_PORT}/callback/${CODEX_CALLBACK_ID}`,
    `http://localhost:${CODEX_CALLBACK_PORT}/callback/${CODEX_CALLBACK_ID}`,
  ],
  // Desktop, then the web and Cursor Agents; with a client id set, the desktop sends only its own.
  cursor: ['http://localhost:8787/callback', 'https://www.cursor.com/agents/mcp/oauth/callback'],
};

/** Whether a surface still waits for its client: its id is blank or the placeholder. */
export function isPendingClientId(clientId: string): boolean {
  const trimmed = clientId.trim();
  return trimmed === '' || trimmed.startsWith(PENDING_CLIENT_ID_PREFIX);
}

/**
 * Claude Code, in a terminal: adds the server under the fixed callback port, for the user. The
 * default scope is `local`, the project folder the command ran in, so a server added from the home
 * folder would be missing from every project the creator opens afterwards.
 */
export function claudeCodeAddCommand(clientId: string): string {
  return `claude mcp add --transport http --scope user --client-id ${clientId} --callback-port ${CLAUDE_CODE_CALLBACK_PORT} ${MCP_SERVER_KEY} ${MCP_SERVER_URL}`;
}

/**
 * The server entry the Claude Code plugin declares in `plugins/magicbooklet/.claude-plugin/plugin.json`
 * (`mcpServers`), the same shape as a project `.mcp.json` entry.
 */
export function claudeCodeServerEntry(clientId: string) {
  return {
    type: 'http',
    url: MCP_SERVER_URL,
    oauth: { clientId, callbackPort: CLAUDE_CODE_CALLBACK_PORT },
  } as const;
}

/** Codex, in a terminal: adds the server with the client id, which skips registration. */
export function codexAddCommand(clientId: string): string {
  return `codex mcp add ${MCP_SERVER_KEY} --url ${MCP_SERVER_URL} --oauth-client-id ${clientId}`;
}

/** Codex's sign-in, which opens the browser on the consent page. */
export function codexLoginCommand(): string {
  return `codex mcp login ${MCP_SERVER_KEY}`;
}

/** What `~/.codex/config.toml` holds for the server, the pinned callback port included. */
export function codexConfigToml(clientId: string): string {
  return [
    `[mcp_servers.${MCP_SERVER_KEY}]`,
    `url = "${MCP_SERVER_URL}"`,
    '',
    `[mcp_servers.${MCP_SERVER_KEY}.oauth]`,
    `client_id = "${clientId}"`,
    `callback_port = ${CODEX_CALLBACK_PORT}`,
  ].join('\n');
}

/** Cursor's `mcp.json` entry: a remote server with a static OAuth client. */
export function cursorMcpJson(clientId: string): string {
  return JSON.stringify(
    { mcpServers: { [MCP_SERVER_KEY]: { url: MCP_SERVER_URL, auth: { CLIENT_ID: clientId } } } },
    null,
    2,
  );
}
