/**
 * Connected apps: the agents a creator has let act as them through the MCP server (the plan,
 * `docs/plans/agent-mcp-server-plan-2026-11-09.md`, phase 2). The grants are the app's own
 * authorization server's (`docs/archive/agent-token-broker-plan-2026-11-26.md`), read and revoked
 * through `/api/oauth/grants` with the web session's token (`createAppGrantsClient`): revoking
 * deletes the grant's tokens, so the agent's next call and its next refresh are both refused.
 *
 * The component on `/profile/edit` draws what this module decides; nothing here is React or
 * Supabase, so the decisions are tested on their own.
 */

import { isPostingOnlyClientId } from '@/lib/mcp-client-directory';

export type ConnectedApp = {
  clientId: string;
  name: string;
  /** The client's own site, where it gave one. */
  uri: string | null;
  grantedAt: string | null;
  /** True when every grant of this app is for the posting server alone (the grant says). */
  postingOnly?: boolean;
};

/** What a connected app may do, in the consent screen's words. */
export const CONNECTED_APP_ACCESS = 'Can create media with your credits and publish posts as you.';

/** What a posting-only app may do (`MCP_POSTING_ONLY_CLIENT_IDS`): the server refuses it the rest. */
export const POSTING_CONNECTED_APP_ACCESS = 'Can publish, change and delete posts as you. Cannot create media or spend credits.';

/** The line under a connected app's name: the access its client was shown on the consent page. */
export function connectedAppAccess(clientId: string | null | undefined, postingOnly = false): string {
  return postingOnly || isPostingOnlyClientId(clientId) ? POSTING_CONNECTED_APP_ACCESS : CONNECTED_APP_ACCESS;
}

export const CONNECTED_APPS_COPY = {
  title: 'Connected apps',
  eyebrow: 'Agent access',
  description: 'Apps and AI agents you have let act as you on Magicbooklet. Disconnect one to end its access at once.',
  /** The link to the setup page (`/developers/mcp`): the only way from the app to how an agent is connected. */
  guideLabel: 'How to connect an agent',
  emptyTitle: 'No apps connected',
  emptyBody: 'When you connect Magicbooklet to an agent such as Claude, ChatGPT, Codex or Cursor and approve it, it is listed here.',
  loading: 'Loading connected apps',
  failedTitle: 'Could not load your connected apps.',
  retry: 'Try again',
  disconnect: 'Disconnect',
  disconnected: (name: string) => `${name} disconnected. It no longer has access to your account.`,
  disconnectFailed: (name: string) => `Could not disconnect ${name}. Try again.`,
} as const;

/** The question before a disconnect, in the confirm dialog's shape. */
export function disconnectQuestion(app: ConnectedApp) {
  return {
    title: `Disconnect ${app.name}?`,
    message: 'It loses access to your account at once. If you connect it again later, it will ask you to approve it again.',
    confirmLabel: 'Disconnect',
    cancelLabel: 'Keep',
    tone: 'danger' as const,
  };
}

type GrantRecord = Record<string, unknown>;

function record(value: unknown): GrantRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as GrantRecord : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The grants as the page lists them: one row per client, newest first, named by the client (its id
 * where it has no name, so a row is never blank), and a grant with no client at all left out.
 */
export function toConnectedApps(grants: unknown): ConnectedApp[] {
  if (!Array.isArray(grants)) return [];
  const byClient = new Map<string, ConnectedApp>();
  for (const entry of grants) {
    const grant = record(entry);
    const client = record(grant?.client);
    const clientId = text(client?.id);
    if (!clientId) continue;
    const grantedAt = text(grant?.granted_at);
    const postingOnly = grant?.surface === 'posts';
    const app: ConnectedApp = {
      clientId,
      name: text(client?.name) ?? clientId,
      uri: text(client?.uri),
      grantedAt: grantedAt && !Number.isNaN(Date.parse(grantedAt)) ? grantedAt : null,
      ...(postingOnly ? { postingOnly } : {}),
    };
    const earlier = byClient.get(clientId);
    if (!earlier) {
      byClient.set(clientId, app);
      continue;
    }
    // A client approved twice is one app: the first grant's name and site, the earliest approval.
    const { postingOnly: earlierPostingOnly, ...rest } = earlier;
    byClient.set(clientId, {
      ...rest,
      uri: earlier.uri ?? app.uri,
      grantedAt: app.grantedAt && (!earlier.grantedAt || app.grantedAt < earlier.grantedAt) ? app.grantedAt : earlier.grantedAt,
      // Posting-only only while every grant of the app is.
      ...(earlierPostingOnly && postingOnly ? { postingOnly: true } : {}),
    });
  }
  return [...byClient.values()].sort((a, b) => (b.grantedAt ?? '').localeCompare(a.grantedAt ?? ''));
}

/** "Connected Nov 9, 2026", or null for a grant without a readable date. */
export function formatConnectedDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : `Connected ${date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/** The grants API this module reads and writes: `createAppGrantsClient`, or a test's fake. */
export type ConnectedAppsClient = {
  listGrants(): Promise<{ data: unknown; error: { status?: number; message?: string } | null }>;
  revokeGrant(params: { clientId: string }): Promise<{ error: { message?: string } | null }>;
};


/** Where Connected apps reads and ends the grants. */
export const APP_GRANTS_API_PATH = '/api/oauth/grants';

type GrantsFetch = (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

/**
 * The grants, in the shape the rest of this module reads. Each call carries the web session's
 * token; with none there is no account to list for, which reads
 * as a failure, never as an empty list.
 */
export function createAppGrantsClient(options: {
  getAccessToken: () => Promise<string | null | undefined>;
  fetch?: GrantsFetch;
}): ConnectedAppsClient {
  const send: GrantsFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const call = async (init: RequestInit) => {
    const accessToken = await options.getAccessToken();
    if (!accessToken) return { body: null, error: { status: 401, message: 'Sign in again to manage your connected apps.' } };
    const response = await send(APP_GRANTS_API_PATH, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${accessToken}` },
      credentials: 'omit',
      cache: 'no-store',
    });
    const body = record(await response.json().catch(() => null));
    if (!response.ok) return { body: null, error: { status: response.status, message: text(body?.error) ?? undefined } };
    return { body, error: null };
  };
  return {
    async listGrants() {
      try {
        const { body, error } = await call({ method: 'GET' });
        return error ? { data: null, error } : { data: Array.isArray(body?.grants) ? body.grants : [], error: null };
      } catch {
        return { data: null, error: { message: 'The connected apps could not be read.' } };
      }
    },
    async revokeGrant({ clientId }) {
      try {
        const { error } = await call({
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId }),
        });
        return { error };
      } catch {
        return { error: { message: undefined } };
      }
    },
  };
}

export async function listConnectedApps(client: ConnectedAppsClient): Promise<ConnectedApp[]> {
  const { data, error } = await client.listGrants();
  if (error) throw new Error(error.message || 'The connected apps could not be read.');
  return toConnectedApps(data);
}

export async function disconnectApp(client: ConnectedAppsClient, app: ConnectedApp): Promise<void> {
  const { error } = await client.revokeGrant({ clientId: app.clientId });
  if (error) throw new Error(error.message || CONNECTED_APPS_COPY.disconnectFailed(app.name));
}
