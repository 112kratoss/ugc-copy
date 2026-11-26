import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { isStorableRedirectUri } from '../../src/lib/agent-oauth-request';
import { AGENT_CLIENT_SECRET_PREFIX, hashAgentSecret, mintAgentSecret } from '../../src/lib/agent-oauth-tokens';

/**
 * The OAuth clients of the agents' MCP server (`docs/mcp-server-operations.md`): the apps
 * Claude.ai, Claude Code, ChatGPT, Codex and Cursor sign a creator in through, registered with
 * the app's own authorization server (`docs/archive/agent-token-broker-plan-2026-11-26.md`) as
 * rows of `public.agent_oauth_clients`, under the service role.
 *
 * Read-only unless `--apply` is given. A client's id is public and printed; a confidential
 * client's secret is minted here, stored only as its hash, and goes to the clipboard, never to
 * the terminal, a log or a file.
 *
 * `--app`, which chose this table while Supabase Auth's OAuth server was the default (until
 * 2026-11-26), is still accepted and changes nothing.
 */

const USAGE = `
Magicbooklet OAuth clients (service role only)

Usage:
  npm run ops:oauth-clients -- list [--json]
  npm run ops:oauth-clients -- create --name <name> --redirect-uri <uri> [--redirect-uri <uri> ...]
                                     [--client-uri <https url>] [--confidential] [--posting-only] [--json]
  npm run ops:oauth-clients -- create ... --apply
  npm run ops:oauth-clients -- disable --client-id <id> [--apply]
  npm run ops:oauth-clients -- enable --client-id <id> [--apply]
  npm run ops:oauth-clients -- rotate-secret --client-id <id> [--apply]

Environment:
  SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
  SUPABASE_SERVICE_ROLE_KEY

Safety:
  - list is read-only; create, disable, enable and rotate-secret without --apply only show what
    they would do.
  - A client is public (token_endpoint_auth_method none) unless --confidential is given.
  - A redirect URI must be https, or http on a loopback host (localhost, 127.0.0.1, [::1]); it is
    stored as typed and matched as an exact string.
  - Output names client ids, never a secret: a confidential client's secret is copied to the
    clipboard (pbcopy) and nowhere else.
  - disable ends a client's sign-ins and refuses its tokens at once.
`.trim();

const COMMANDS = new Set(['list', 'create', 'disable', 'enable', 'rotate-secret']);

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

/** The origin of the Supabase URL in use, so the output names the project without its path or keys. */
export function supabaseOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function copyWithPbcopy(text: string): boolean {
  const result = spawnSync('pbcopy', { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
  return result.status === 0;
}

type AppClientRow = {
  client_id: string;
  client_name: string;
  client_uri: string | null;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  surface: string;
  created_at: string;
  disabled_at: string | null;
};

/** The columns this CLI reads: never `client_secret_hash`. */
const APP_CLIENT_COLUMNS = 'client_id, client_name, client_uri, redirect_uris, token_endpoint_auth_method, surface, created_at, disabled_at';

function clientIdFlag(flags: Flags): string {
  const clientId = stringFlag(flags, '--client-id')?.trim();
  if (!clientId || !/^[A-Za-z0-9_-]{8,128}$/u.test(clientId)) throw new Error(`--client-id is required.\n\n${USAGE}`);
  return clientId;
}

function describeAppClient(client: AppClientRow): string {
  const state = client.disabled_at ? ', disabled' : '';
  return `- ${client.client_id}  ${client.client_name} (${client.token_endpoint_auth_method}, ${client.surface}${state}) → ${client.redirect_uris.join(', ')}`;
}

/** A new client, from the flags `create` takes. */
export function buildAppClientRow(flags: Flags, mint: { clientId: () => string; secret: () => string }) {
  const name = stringFlag(flags, '--name')?.trim();
  if (!name) throw new Error(`--name is required.\n\n${USAGE}`);
  // As typed, once each: this server matches a redirect URI as an exact string, and the URL
  // parser's own spelling (a slash after a bare origin) is not what the client will send.
  const redirectUris = [...new Set(listFlag(flags, '--redirect-uri').map((uri) => uri.trim()))];
  if (redirectUris.length === 0) throw new Error(`At least one --redirect-uri is required.\n\n${USAGE}`);
  // The table's own rule, said here in words before the database says it as a constraint error.
  for (const uri of redirectUris) {
    if (!isStorableRedirectUri(uri)) {
      throw new Error(`Not a redirect URI this server stores: ${uri}\nUse https://host[:port]/path, or http on a loopback host (localhost, 127.0.0.1 or [::1]), in lower case, with no fragment and no user@.`);
    }
  }
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
  const confidential = flags.get('--confidential') === true;
  const secret = confidential ? mint.secret() : null;
  return {
    secret,
    row: {
      client_id: mint.clientId(),
      client_name: name,
      client_uri: clientUri,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: confidential ? 'client_secret_post' : 'none',
      client_secret_hash: secret ? hashAgentSecret(secret) : null,
      surface: flags.get('--posting-only') === true ? 'posts' : 'full',
    },
  };
}

async function runAppClientsOps(input: {
  command: string;
  flags: Flags;
  supabase: SupabaseClient;
  project: string | null;
  json: boolean;
  apply: boolean;
  log: (line: string) => void;
  copyToClipboard: (text: string) => boolean;
}): Promise<void> {
  const { command, flags, supabase, project, json, apply, log, copyToClipboard } = input;
  const table = () => supabase.from('agent_oauth_clients');

  if (command === 'list') {
    const { data, error } = await table().select(APP_CLIENT_COLUMNS).order('created_at', { ascending: true });
    if (error) throw new Error(`Could not list the app's OAuth clients: ${error.message}`);
    const clients = (data ?? []) as AppClientRow[];
    if (json) {
      log(JSON.stringify({ project, clients }, null, 2));
    } else {
      log(`${clients.length} OAuth client${clients.length === 1 ? '' : 's'}`);
      for (const client of clients) log(describeAppClient(client));
    }
    return;
  }

  if (command === 'create') {
    const { row, secret } = buildAppClientRow(flags, {
      clientId: () => randomUUID(),
      secret: () => mintAgentSecret(AGENT_CLIENT_SECRET_PREFIX),
    });
    const { client_secret_hash: hash, ...shown } = row;
    if (!apply) {
      log(json
        ? JSON.stringify({ project, wouldCreate: { ...shown, client_id: '(new)' } }, null, 2)
        : `Would register on ${project} (add --apply to do it):\n${JSON.stringify({ ...shown, client_id: '(new)' }, null, 2)}`);
      return;
    }
    const { error } = await table().insert({ ...shown, client_secret_hash: hash });
    if (error) throw new Error(`Could not register the client: ${error.message}`);
    log(json ? JSON.stringify({ project, created: shown, secret: secret ? 'clipboard' : null }, null, 2) : `Registered ${shown.client_name} as ${shown.client_id} on ${project}\n${JSON.stringify(shown, null, 2)}`);
    if (!secret) {
      log('Public client: no secret.');
    } else if (copyToClipboard(secret)) {
      log('The client secret is on the clipboard: paste it into the connector form now; it is shown nowhere else.');
    } else {
      log('The client secret could not be copied to the clipboard and was not printed: run rotate-secret for this client.');
    }
    return;
  }

  const clientId = clientIdFlag(flags);
  const { data: found, error: findError } = await table().select(APP_CLIENT_COLUMNS).eq('client_id', clientId).maybeSingle();
  if (findError) throw new Error(`Could not read the client: ${findError.message}`);
  if (!found) throw new Error(`No client ${clientId} on ${project}.`);
  const client = found as AppClientRow;

  if (command === 'rotate-secret') {
    if (client.token_endpoint_auth_method === 'none') throw new Error(`${client.client_name} is a public client: it has no secret.`);
    if (!apply) {
      log(`Would replace the secret of ${client.client_name} (${clientId}) on ${project}; its current secret stops working at once (add --apply to do it).`);
      return;
    }
    const secret = mintAgentSecret(AGENT_CLIENT_SECRET_PREFIX);
    const { error } = await table().update({ client_secret_hash: hashAgentSecret(secret) }).eq('client_id', clientId);
    if (error) throw new Error(`Could not replace the secret: ${error.message}`);
    log(`Replaced the secret of ${client.client_name} (${clientId}) on ${project}.`);
    log(copyToClipboard(secret)
      ? 'The new client secret is on the clipboard: paste it into the connector form now; it is shown nowhere else.'
      : 'The new client secret could not be copied to the clipboard and was not printed: run rotate-secret again.');
    return;
  }

  // disable, enable
  const disabledAt = command === 'disable' ? new Date().toISOString() : null;
  if (!apply) {
    log(`Would ${command} ${client.client_name} (${clientId}) on ${project} (add --apply to do it).`);
    return;
  }
  const { error } = await table().update({ disabled_at: disabledAt }).eq('client_id', clientId);
  if (error) throw new Error(`Could not ${command} the client: ${error.message}`);
  log(`${command === 'disable' ? 'Disabled' : 'Enabled'} ${client.client_name} (${clientId}) on ${project}.`);
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
  if (!COMMANDS.has(command)) throw new Error(`Unknown command: ${command}\n\n${USAGE}`);

  const json = flags.get('--json') === true;
  const apply = flags.get('--apply') === true;

  // Which project the command touches, said in every output: .env.local is hand-toggled between
  // the local stack and production, and a client registered on the wrong one is an id the other
  // has never heard of.
  const supabaseUrl = environment.SUPABASE_URL || environment.NEXT_PUBLIC_SUPABASE_URL;
  const project = supabaseOrigin(supabaseUrl);

  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  }
  if (!json) log(`Supabase project: ${project ?? supabaseUrl}`);
  const supabase = (dependencies.createClient ?? createClient)(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });

  await runAppClientsOps({
    command,
    flags,
    supabase: supabase as SupabaseClient,
    project: project ?? supabaseUrl,
    json,
    apply,
    log,
    copyToClipboard: dependencies.copyToClipboard ?? copyWithPbcopy,
  });
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
