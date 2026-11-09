import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { createClient, type CreateOAuthClientParams, type OAuthClient } from '@supabase/supabase-js';

/**
 * The OAuth clients of the agents' MCP server (`docs/mcp-server-operations.md`): the apps
 * Claude.ai, Claude Code, ChatGPT, Codex and Cursor sign a creator in through, registered with
 * Supabase Auth's OAuth server under the service role.
 *
 * Read-only unless `--apply` is given. A client's id is public and printed; a confidential
 * client's secret is shown by GoTrue once, at creation, and goes to the clipboard, never to the
 * terminal, a log or a file.
 */

const USAGE = `
Magicbooklet OAuth clients (service role only)

Usage:
  npm run ops:oauth-clients -- list [--json]
  npm run ops:oauth-clients -- create --name <name> --redirect-uri <uri> [--redirect-uri <uri> ...]
                                     [--client-uri <https url>] [--confidential] [--json]
  npm run ops:oauth-clients -- create ... --apply

Environment:
  SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
  SUPABASE_SERVICE_ROLE_KEY

Safety:
  - list is read-only; create without --apply only shows what it would register.
  - A client is public (token_endpoint_auth_method none) unless --confidential is given.
  - A redirect URI must be https, or http on a loopback host (localhost, 127.0.0.1, [::1]).
  - Output names client ids, never a secret: a confidential client's secret is copied to the
    clipboard (pbcopy) and nowhere else.
`.trim();

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export type OAuthClientsOpsDependencies = {
  createClient?: typeof createClient;
  /** Puts a secret where only the operator reads it; true when it got there. */
  copyToClipboard?: (text: string) => boolean;
  log?: (line: string) => void;
};

type Flags = Map<string, string[] | true>;

export function parseArguments(args: string[]): { command: string | null; flags: Flags } {
  const [command = null, ...rest] = args;
  const flags: Flags = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}\n\n${USAGE}`);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.set(token, true);
      continue;
    }
    const existing = flags.get(token);
    flags.set(token, Array.isArray(existing) ? [...existing, next] : [next]);
    index += 1;
  }
  return { command, flags };
}

function stringFlag(flags: Flags, name: string): string | null {
  const value = flags.get(name);
  if (Array.isArray(value)) return value[value.length - 1];
  if (value === true) throw new Error(`${name} needs a value.\n\n${USAGE}`);
  return null;
}

function listFlag(flags: Flags, name: string): string[] {
  const value = flags.get(name);
  if (value === true) throw new Error(`${name} needs a value.\n\n${USAGE}`);
  return value ?? [];
}

/** A redirect URI GoTrue will match exactly: https anywhere, http only on a loopback host, no fragment. */
export function validateRedirectUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Not a URL: ${value}`);
  }
  if (url.hash) throw new Error(`A redirect URI cannot carry a fragment: ${value}`);
  const loopback = LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
  if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return url.toString();
  throw new Error(`A redirect URI must be https, or http on a loopback host: ${value}`);
}

export function buildCreateParams(flags: Flags): CreateOAuthClientParams {
  const name = stringFlag(flags, '--name')?.trim();
  if (!name) throw new Error(`--name is required.\n\n${USAGE}`);
  const redirectUris = listFlag(flags, '--redirect-uri').map(validateRedirectUri);
  if (redirectUris.length === 0) throw new Error(`At least one --redirect-uri is required.\n\n${USAGE}`);
  const clientUri = stringFlag(flags, '--client-uri');
  if (clientUri !== null) {
    let parsed: URL;
    try {
      parsed = new URL(clientUri);
    } catch {
      throw new Error(`--client-uri is not a URL: ${clientUri}`);
    }
    if (parsed.protocol !== 'https:') throw new Error(`--client-uri must be https: ${clientUri}`);
  }
  return {
    client_name: name,
    ...(clientUri ? { client_uri: clientUri } : {}),
    redirect_uris: [...new Set(redirectUris)],
    token_endpoint_auth_method: flags.get('--confidential') === true ? 'client_secret_post' : 'none',
  };
}

/** A client as this CLI shows it: everything but a secret. */
export function describeClient(client: OAuthClient): Record<string, unknown> {
  return {
    client_id: client.client_id,
    client_name: client.client_name,
    client_type: client.client_type,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    registration_type: client.registration_type,
    client_uri: client.client_uri ?? null,
    redirect_uris: client.redirect_uris,
    created_at: client.created_at,
  };
}

function copyWithPbcopy(text: string): boolean {
  const result = spawnSync('pbcopy', { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
  return result.status === 0;
}

export async function runOAuthClientsOps(
  args: string[],
  environment: Record<string, string | undefined> = process.env,
  dependencies: OAuthClientsOpsDependencies = {},
): Promise<void> {
  const log = dependencies.log ?? ((line: string) => console.log(line));
  const { command, flags } = parseArguments(args);
  if (!command || command === 'help' || command === '--help' || flags.has('--help')) {
    log(USAGE);
    return;
  }
  if (command !== 'list' && command !== 'create') throw new Error(`Unknown command: ${command}\n\n${USAGE}`);

  const json = flags.get('--json') === true;
  const apply = flags.get('--apply') === true;

  // The dry run needs no credentials: it only shows what would be registered.
  if (command === 'create' && !apply) {
    const params = buildCreateParams(flags);
    log(json ? JSON.stringify({ wouldCreate: params }, null, 2) : `Would register (add --apply to do it):\n${JSON.stringify(params, null, 2)}`);
    return;
  }

  const supabaseUrl = environment.SUPABASE_URL || environment.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  }
  const supabase = (dependencies.createClient ?? createClient)(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });

  if (command === 'list') {
    const { data, error } = await supabase.auth.admin.oauth.listClients();
    if (error) throw new Error(`Could not list OAuth clients: ${error.message}`);
    const clients = (data?.clients ?? []).map(describeClient);
    if (json) {
      log(JSON.stringify({ clients }, null, 2));
    } else {
      log(`${clients.length} OAuth client${clients.length === 1 ? '' : 's'}`);
      for (const client of clients) {
        log(`- ${client.client_id}  ${client.client_name} (${client.client_type}, ${client.registration_type}) → ${(client.redirect_uris as string[]).join(', ')}`);
      }
    }
    return;
  }

  const params = buildCreateParams(flags);
  const { data, error } = await supabase.auth.admin.oauth.createClient(params);
  if (error || !data) throw new Error(`Could not register the OAuth client: ${error?.message ?? 'no client returned'}`);
  const { client_secret: secret, ...rest } = data;
  const shown = describeClient(rest as OAuthClient);
  let secretNote: string;
  if (secret) {
    const copied = (dependencies.copyToClipboard ?? copyWithPbcopy)(secret);
    secretNote = copied
      ? 'The client secret is on the clipboard: paste it into the connector form now; it is shown nowhere else.'
      : 'The client secret could not be copied to the clipboard and was not printed: delete this client in the dashboard and register it again.';
  } else {
    secretNote = 'Public client: no secret.';
  }
  if (json) {
    log(JSON.stringify({ created: shown, secret: secret ? 'clipboard' : null }, null, 2));
  } else {
    log(`Registered ${shown.client_name} as ${shown.client_id}`);
    log(JSON.stringify(shown, null, 2));
  }
  log(secretNote);
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  runOAuthClientsOps(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
