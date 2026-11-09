import { describe, expect, it, vi } from 'vitest';

import {
  buildCreateParams,
  describeClient,
  parseArguments,
  runOAuthClientsOps,
  validateRedirectUri,
} from '../../scripts/ops/oauth-clients';

const ENVIRONMENT = {
  SUPABASE_URL: 'https://project.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
};

const PUBLIC_CLIENT = {
  client_id: 'b2a9c4e1-0000-4000-8000-000000000001',
  client_name: 'Claude Code',
  client_type: 'public' as const,
  token_endpoint_auth_method: 'none' as const,
  registration_type: 'manual' as const,
  client_uri: 'https://claude.com/claude-code',
  redirect_uris: ['http://localhost:8976/callback'],
  grant_types: ['authorization_code' as const, 'refresh_token' as const],
  response_types: ['code' as const],
  created_at: '2026-11-09T00:00:00Z',
  updated_at: '2026-11-09T00:00:00Z',
};

function harness(overrides: { listClients?: unknown; createClient?: unknown } = {}) {
  const admin = {
    listClients: vi.fn(async () => ({ data: { clients: [PUBLIC_CLIENT], aud: 'authenticated' }, error: null })),
    createClient: vi.fn(async () => ({ data: PUBLIC_CLIENT, error: null })),
    ...overrides,
  };
  const createSupabase = vi.fn(() => ({ auth: { admin: { oauth: admin } } }));
  const lines: string[] = [];
  const copied: string[] = [];
  const run = (args: string[], environment: Record<string, string | undefined> = ENVIRONMENT) => runOAuthClientsOps(args, environment, {
    createClient: createSupabase as never,
    copyToClipboard: (text) => { copied.push(text); return true; },
    log: (line) => lines.push(line),
  });
  return { admin, createSupabase, lines, copied, run };
}

describe('oauth-clients CLI', () => {
  it('parses a command, repeated flags and bare switches', () => {
    const { command, flags } = parseArguments(['create', '--name', 'Claude Code', '--redirect-uri', 'a', '--redirect-uri', 'b', '--apply']);
    expect(command).toBe('create');
    expect(flags.get('--name')).toEqual(['Claude Code']);
    expect(flags.get('--redirect-uri')).toEqual(['a', 'b']);
    expect(flags.get('--apply')).toBe(true);
    expect(() => parseArguments(['list', 'stray'])).toThrow(/Unexpected argument/);
  });

  it('takes https redirect URIs, and http only on a loopback host', () => {
    expect(validateRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe('https://claude.ai/api/mcp/auth_callback');
    expect(validateRedirectUri('http://localhost:8976/callback')).toBe('http://localhost:8976/callback');
    expect(validateRedirectUri('http://127.0.0.1:8977/callback/magicbooklet')).toBe('http://127.0.0.1:8977/callback/magicbooklet');
    expect(() => validateRedirectUri('http://example.com/callback')).toThrow(/loopback/);
    expect(() => validateRedirectUri('https://claude.ai/cb#frag')).toThrow(/fragment/);
    expect(() => validateRedirectUri('nope')).toThrow(/Not a URL/);
  });

  it('builds a public client by default, with its name, site and exact redirect URIs', () => {
    const { flags } = parseArguments(['create', '--name', ' Claude Code ', '--client-uri', 'https://claude.com/claude-code', '--redirect-uri', 'http://localhost:8976/callback', '--redirect-uri', 'http://localhost:8976/callback']);
    expect(buildCreateParams(flags)).toEqual({
      client_name: 'Claude Code',
      client_uri: 'https://claude.com/claude-code',
      redirect_uris: ['http://localhost:8976/callback'],
      token_endpoint_auth_method: 'none',
    });
    const confidential = parseArguments(['create', '--name', 'ChatGPT', '--redirect-uri', 'https://chatgpt.com/connector/oauth/abc', '--confidential']);
    expect(buildCreateParams(confidential.flags).token_endpoint_auth_method).toBe('client_secret_post');
    expect(() => buildCreateParams(parseArguments(['create', '--redirect-uri', 'https://x.test/cb']).flags)).toThrow(/--name is required/);
    expect(() => buildCreateParams(parseArguments(['create', '--name', 'X']).flags)).toThrow(/--redirect-uri/);
    expect(() => buildCreateParams(parseArguments(['create', '--name', 'X', '--redirect-uri', 'https://x.test/cb', '--client-uri', 'http://x.test']).flags)).toThrow(/--client-uri must be https/);
  });

  it('describes a client without its secret', () => {
    const shown = describeClient({ ...PUBLIC_CLIENT, client_secret: 'never-shown' });
    expect(shown).not.toHaveProperty('client_secret');
    expect(shown).toMatchObject({ client_id: PUBLIC_CLIENT.client_id, redirect_uris: ['http://localhost:8976/callback'] });
  });

  it('lists clients read-only, naming ids and redirect URIs', async () => {
    const { run, lines, admin } = harness();
    await run(['list']);
    expect(admin.listClients).toHaveBeenCalledTimes(1);
    expect(admin.createClient).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain(PUBLIC_CLIENT.client_id);
    expect(lines.join('\n')).toContain('http://localhost:8976/callback');
    const { run: runJson, lines: jsonLines } = harness();
    await runJson(['list', '--json']);
    expect(JSON.parse(jsonLines[0])).toEqual({ clients: [describeClient(PUBLIC_CLIENT)] });
  });

  it('only shows what it would register without --apply, needing no credentials', async () => {
    const { run, lines, admin, createSupabase } = harness();
    await run(['create', '--name', 'Claude Code', '--redirect-uri', 'http://localhost:8976/callback'], {});
    expect(createSupabase).not.toHaveBeenCalled();
    expect(admin.createClient).not.toHaveBeenCalled();
    expect(lines[0]).toContain('Would register');
    expect(lines[0]).toContain('"token_endpoint_auth_method": "none"');
  });

  it('registers with --apply and prints the id, and a secret goes to the clipboard only', async () => {
    const { run, lines, admin, copied } = harness();
    await run(['create', '--name', 'Claude Code', '--client-uri', 'https://claude.com/claude-code', '--redirect-uri', 'http://localhost:8976/callback', '--apply']);
    expect(admin.createClient).toHaveBeenCalledWith({
      client_name: 'Claude Code',
      client_uri: 'https://claude.com/claude-code',
      redirect_uris: ['http://localhost:8976/callback'],
      token_endpoint_auth_method: 'none',
    });
    expect(lines.join('\n')).toContain(`Registered Claude Code as ${PUBLIC_CLIENT.client_id}`);
    expect(lines.join('\n')).toContain('Public client: no secret.');
    expect(copied).toEqual([]);

    const confidential = harness({
      createClient: vi.fn(async () => ({
        data: { ...PUBLIC_CLIENT, client_name: 'ChatGPT', client_type: 'confidential', token_endpoint_auth_method: 'client_secret_post', client_secret: 'sk-very-secret' },
        error: null,
      })),
    });
    await confidential.run(['create', '--name', 'ChatGPT', '--redirect-uri', 'https://chatgpt.com/connector/oauth/abc', '--confidential', '--apply', '--json']);
    expect(confidential.copied).toEqual(['sk-very-secret']);
    expect(confidential.lines.join('\n')).not.toContain('sk-very-secret');
    expect(JSON.parse(confidential.lines[0])).toMatchObject({ created: { client_name: 'ChatGPT' }, secret: 'clipboard' });
  });

  it('refuses to run against nothing, and passes GoTrue\'s refusal on', async () => {
    const { run } = harness();
    await expect(run(['list'], {})).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    const failing = harness({ createClient: vi.fn(async () => ({ data: null, error: { message: 'oauth server disabled' } })) });
    await expect(failing.run(['create', '--name', 'X', '--redirect-uri', 'https://x.test/cb', '--apply'])).rejects.toThrow(/oauth server disabled/);
    await expect(run(['frobnicate'])).rejects.toThrow(/Unknown command/);
  });
});
