import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { buildAppClientRow, parseArguments, runOAuthClientsOps } from '../../scripts/ops/oauth-clients';
import { hashAgentSecret } from '@/lib/agent-oauth-tokens';
import { MCP_POSTING_ONLY_CLIENT_IDS } from '@/lib/mcp-client-directory';

// The clients of the app's own authorization server, as the operator manages them
// (docs/plans/agent-token-broker-plan-2026-11-26.md, "Cutover"): `--app` on list and create, and
// import, disable, enable and rotate-secret.

const ENVIRONMENT = { SUPABASE_URL: 'https://project.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test' };
const CLIENT_ID = 'cf5743f9-c83c-4f6c-9afb-0803d5aee698';

const PUBLIC_ROW = {
  client_id: CLIENT_ID,
  client_name: 'Claude Code',
  client_uri: null,
  redirect_uris: ['http://localhost:8976/callback'],
  token_endpoint_auth_method: 'none',
  surface: 'full',
  created_at: '2026-11-26T00:00:00Z',
  disabled_at: null,
};
const CONFIDENTIAL_ROW = { ...PUBLIC_ROW, client_id: MCP_POSTING_ONLY_CLIENT_IDS.claudeDirectory, client_name: 'Claude directory', token_endpoint_auth_method: 'client_secret_post', surface: 'posts' };

function harness(rows: Array<typeof PUBLIC_ROW> = [PUBLIC_ROW, CONFIDENTIAL_ROW]) {
  const selects: string[] = [];
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ patch: Record<string, unknown>; clientId: string }> = [];
  const table = {
    select: vi.fn((columns: string) => {
      selects.push(columns);
      return {
        order: vi.fn(async () => ({ data: rows, error: null })),
        eq: vi.fn((_column: string, value: string) => ({
          maybeSingle: vi.fn(async () => ({ data: rows.find((row) => row.client_id === value) ?? null, error: null })),
        })),
      };
    }),
    insert: vi.fn(async (row: Record<string, unknown>) => { inserts.push(row); return { error: null }; }),
    update: vi.fn((patch: Record<string, unknown>) => ({
      eq: vi.fn(async (_column: string, clientId: string) => { updates.push({ patch, clientId }); return { error: null }; }),
    })),
  };
  const rpc = vi.fn(async () => ({ data: { imported: [{ client_id: CLIENT_ID }], skipped: [], source: 'supabase' }, error: null }));
  const listClients = vi.fn(async () => ({
    data: { clients: [
      { client_id: CLIENT_ID, client_name: 'Claude Code', token_endpoint_auth_method: 'none' },
      { client_id: MCP_POSTING_ONLY_CLIENT_IDS.claudeDirectory, client_name: 'Claude directory', token_endpoint_auth_method: 'client_secret_post' },
    ] },
    error: null,
  }));
  const from = vi.fn(() => table);
  const createSupabase = vi.fn(() => ({ from, rpc, auth: { admin: { oauth: { listClients, createClient: vi.fn() } } } }));
  const lines: string[] = [];
  const copied: string[] = [];
  const run = (args: string[], environment: Record<string, string | undefined> = ENVIRONMENT) => runOAuthClientsOps(args, environment, {
    createClient: createSupabase as never,
    copyToClipboard: (text) => { copied.push(text); return true; },
    log: (line) => lines.push(line),
  });
  return { run, lines, copied, selects, inserts, updates, rpc, listClients, from, table };
}

describe('oauth-clients CLI: the app\'s own authorization server', () => {
  it('lists the app\'s clients, never reading a secret hash', async () => {
    const { run, lines, selects, from, listClients } = harness();
    await run(['list', '--app']);
    expect(from).toHaveBeenCalledWith('agent_oauth_clients');
    expect(selects.join(' ')).not.toContain('client_secret_hash');
    expect(lines[0]).toBe('Supabase project: https://project.supabase.test');
    expect(lines[1]).toBe("2 OAuth clients of the app's own authorization server");
    expect(lines[2]).toBe(`- ${CLIENT_ID}  Claude Code (none, full) → http://localhost:8976/callback`);
    expect(lines[3]).toContain('(client_secret_post, posts)');
    // Without the switch, list is still Supabase's.
    expect(listClients).not.toHaveBeenCalled();
  });

  it('shows what an import would copy, with the posting-only clients marked, and copies only with --apply', async () => {
    const { run, lines, rpc, listClients } = harness();
    await run(['import']);
    expect(rpc).not.toHaveBeenCalled();
    expect(listClients).toHaveBeenCalledTimes(1);
    const shown = lines.join('\n');
    expect(shown).toContain('Would copy 2 clients');
    expect(shown).toMatch(new RegExp(`"client_id": "${CLIENT_ID}"[^}]*"surface": "full"`, 'u'));
    expect(shown).toMatch(new RegExp(`"client_id": "${MCP_POSTING_ONLY_CLIENT_IDS.claudeDirectory}"[^}]*"surface": "posts"`, 'u'));

    await run(['import', '--apply']);
    expect(rpc).toHaveBeenCalledWith('agent_oauth_import_supabase_clients', {
      p_posting_only_client_ids: Object.values(MCP_POSTING_ONLY_CLIENT_IDS),
    });
  });

  it('builds a public client by default, and a posting-only confidential one with a hashed secret', () => {
    const mint = { clientId: () => 'new-client-id', secret: () => 'mbcs_minted-secret' };
    const open = buildAppClientRow(parseArguments(['create', '--app', '--name', 'Cursor', '--redirect-uri', 'http://localhost:8787/callback']).flags, mint);
    expect(open).toEqual({
      secret: null,
      row: {
        client_id: 'new-client-id', client_name: 'Cursor', client_uri: null, redirect_uris: ['http://localhost:8787/callback'],
        token_endpoint_auth_method: 'none', client_secret_hash: null, surface: 'full',
      },
    });
    const directory = buildAppClientRow(parseArguments(['create', '--app', '--name', 'Directory', '--redirect-uri', 'https://claude.ai/api/mcp/auth_callback', '--confidential', '--posting-only']).flags, mint);
    expect(directory.secret).toBe('mbcs_minted-secret');
    expect(directory.row).toMatchObject({ token_endpoint_auth_method: 'client_secret_post', client_secret_hash: hashAgentSecret('mbcs_minted-secret'), surface: 'posts' });
    expect(() => buildAppClientRow(parseArguments(['create', '--app', '--name', 'X', '--redirect-uri', 'http://example.com/cb']).flags, mint)).toThrow(/loopback/);
  });

  it('registers a client only with --apply, and its secret goes to the clipboard alone', async () => {
    const dry = harness();
    await dry.run(['create', '--app', '--name', 'Directory', '--redirect-uri', 'https://claude.ai/api/mcp/auth_callback', '--confidential']);
    expect(dry.inserts).toEqual([]);
    expect(dry.copied).toEqual([]);

    const { run, lines, copied, inserts } = harness();
    await run(['create', '--app', '--name', 'Directory', '--redirect-uri', 'https://claude.ai/api/mcp/auth_callback', '--confidential', '--apply']);
    expect(inserts).toHaveLength(1);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatch(/^mbcs_[A-Za-z0-9_-]{43}$/);
    // The row holds the hash; nothing printed holds the secret or the hash.
    expect(inserts[0].client_secret_hash).toBe(hashAgentSecret(copied[0]));
    expect(JSON.stringify(inserts[0])).not.toContain(copied[0]);
    const printed = lines.join('\n');
    expect(printed).not.toContain(copied[0]);
    expect(printed).not.toContain(String(inserts[0].client_secret_hash));
    expect(printed).toContain('on the clipboard');
  });

  it('disables and enables a client only with --apply', async () => {
    const { run, lines, updates } = harness();
    await run(['disable', '--client-id', CLIENT_ID]);
    expect(updates).toEqual([]);
    expect(lines.at(-1)).toContain('Would disable Claude Code');
    await run(['disable', '--client-id', CLIENT_ID, '--apply']);
    expect(updates[0].clientId).toBe(CLIENT_ID);
    expect(typeof updates[0].patch.disabled_at).toBe('string');
    await run(['enable', '--client-id', CLIENT_ID, '--apply']);
    expect(updates[1]).toEqual({ clientId: CLIENT_ID, patch: { disabled_at: null } });
  });

  it('replaces a confidential client\'s secret, and refuses a public client and an unknown one', async () => {
    const { run, lines, copied, updates } = harness();
    await run(['rotate-secret', '--client-id', CONFIDENTIAL_ROW.client_id]);
    expect(updates).toEqual([]);
    await run(['rotate-secret', '--client-id', CONFIDENTIAL_ROW.client_id, '--apply']);
    expect(updates[0].patch).toEqual({ client_secret_hash: hashAgentSecret(copied[0]) });
    expect(lines.join('\n')).not.toContain(copied[0]);
    await expect(run(['rotate-secret', '--client-id', CLIENT_ID, '--apply'])).rejects.toThrow(/public client/);
    await expect(run(['disable', '--client-id', 'no-such-client-id', '--apply'])).rejects.toThrow(/No client/);
    await expect(run(['disable'])).rejects.toThrow(/--client-id is required/);
  });

  it('is on the script npm runs, with the commands in its help', () => {
    expect(JSON.parse(readFileSync('package.json', 'utf8')).scripts['ops:oauth-clients']).toContain('scripts/ops/oauth-clients.ts');
    const source = readFileSync('scripts/ops/oauth-clients.ts', 'utf8');
    for (const command of ['list --app', 'create --app', 'import [--apply]', 'disable --client-id', 'enable --client-id', 'rotate-secret --client-id']) {
      expect(source, command).toContain(command);
    }
  });
});
