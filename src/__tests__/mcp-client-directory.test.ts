import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE_CALLBACK_PORT,
  CODEX_CALLBACK_ID,
  CODEX_CALLBACK_PORT,
  MCP_CLIENT_IDS,
  MCP_CLIENT_REDIRECT_URIS,
  MCP_DEVELOPERS_PAGE_URL,
  MCP_PROTECTED_RESOURCE_METADATA_URL,
  MCP_SERVER_ORIGIN,
  MCP_SERVER_URL,
  PENDING_CLIENT_ID_PREFIX,
  claudeCodeAddCommand,
  claudeCodeServerEntry,
  codexAddCommand,
  codexConfigToml,
  cursorMcpJson,
  isPendingClientId,
} from '@/lib/mcp-client-directory';
import { mcpResourceUrl, protectedResourceMetadataUrl } from '@/lib/oauth-protected-resource-metadata';

/**
 * Codex's callback ID for an MCP server URL, as openai/codex computes it
 * (`callback_id_from_server_url`, `codex-rs/rmcp-client/src/oauth_callback.rs`): the SHA-256 of the
 * URL without its fragment, its first 9 bytes, base64url with no padding.
 */
function codexCallbackId(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = '';
  return createHash('sha256').update(url.href).digest().subarray(0, 9).toString('base64url');
}

describe('the MCP client directory', () => {
  it('names production’s server, its metadata and the setup page', () => {
    expect(MCP_SERVER_URL).toBe('https://magicbooklet.com/api/mcp');
    expect(MCP_SERVER_URL).toBe(mcpResourceUrl(MCP_SERVER_ORIGIN));
    expect(MCP_PROTECTED_RESOURCE_METADATA_URL).toBe(protectedResourceMetadataUrl(MCP_SERVER_ORIGIN));
    expect(MCP_DEVELOPERS_PAGE_URL).toBe('https://magicbooklet.com/developers/mcp');
  });

  it('tells a placeholder from a registered client id', () => {
    expect(isPendingClientId(`${PENDING_CLIENT_ID_PREFIX}CODEX`)).toBe(true);
    expect(isPendingClientId('  ')).toBe(true);
    expect(isPendingClientId('9b1f2c4e-5d6a-4b7c-8d9e-0f1a2b3c4d5e')).toBe(false);
    // Every surface has an entry, whichever state it is in.
    expect(Object.keys(MCP_CLIENT_IDS).sort()).toEqual(['chatgpt', 'claude', 'claudeCode', 'codex', 'cursor']);
    for (const id of Object.values(MCP_CLIENT_IDS)) expect(id.trim()).not.toBe('');
  });

  it('derives the Codex callback ID the way Codex does, from the server URL alone', () => {
    // Codex's own test vector first, so the derivation is Codex's and not a guess.
    expect(codexCallbackId('https://mcp.example.com/mcp?tenant=one')).toBe('XuuuHAzzHOni');
    expect(codexCallbackId('https://mcp.example.com/mcp?tenant=one#unused')).toBe('XuuuHAzzHOni');
    expect(CODEX_CALLBACK_ID).toBe(codexCallbackId(MCP_SERVER_URL));
  });

  it('registers the redirect URIs each client sends, ports and paths exact', () => {
    expect(MCP_CLIENT_REDIRECT_URIS.claude).toEqual(['https://claude.ai/api/mcp/auth_callback']);
    expect(MCP_CLIENT_REDIRECT_URIS.claudeCode).toEqual([`http://localhost:${CLAUDE_CODE_CALLBACK_PORT}/callback`]);
    // GoTrue sends no `iss`, so Codex appends the callback ID, and the pinned port is inserted; the
    // `localhost` form is production's spare.
    expect(MCP_CLIENT_REDIRECT_URIS.codex).toEqual([
      `http://127.0.0.1:${CODEX_CALLBACK_PORT}/callback/${codexCallbackId(MCP_SERVER_URL)}`,
      `http://localhost:${CODEX_CALLBACK_PORT}/callback/${codexCallbackId(MCP_SERVER_URL)}`,
    ]);
    expect(MCP_CLIENT_REDIRECT_URIS.cursor).toEqual([
      'http://localhost:8787/callback',
      'https://www.cursor.com/agents/mcp/oauth/callback',
    ]);
    // Per connector, read off ChatGPT's connector page once it exists.
    expect(MCP_CLIENT_REDIRECT_URIS.chatgpt).toEqual([]);
  });

  it('builds each client’s setup from the same URL, name and ports', () => {
    expect(claudeCodeAddCommand('cc-id')).toBe(
      'claude mcp add --transport http --scope user --client-id cc-id --callback-port 8976 magicbooklet https://magicbooklet.com/api/mcp',
    );
    expect(claudeCodeServerEntry('cc-id')).toEqual({
      type: 'http',
      url: 'https://magicbooklet.com/api/mcp',
      oauth: { clientId: 'cc-id', callbackPort: 8976 },
    });
    expect(codexAddCommand('cx-id')).toBe('codex mcp add magicbooklet --url https://magicbooklet.com/api/mcp --oauth-client-id cx-id');
    expect(codexConfigToml('cx-id')).toBe([
      '[mcp_servers.magicbooklet]',
      'url = "https://magicbooklet.com/api/mcp"',
      '',
      '[mcp_servers.magicbooklet.oauth]',
      'client_id = "cx-id"',
      'callback_port = 8977',
    ].join('\n'));
    expect(JSON.parse(cursorMcpJson('cu-id'))).toEqual({
      mcpServers: { magicbooklet: { url: 'https://magicbooklet.com/api/mcp', auth: { CLIENT_ID: 'cu-id' } } },
    });
  });
});
