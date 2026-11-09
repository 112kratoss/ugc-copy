/**
 * Connected apps: the agents a creator has let act as them through the MCP server (the plan,
 * `docs/plans/agent-mcp-server-plan-2026-11-09.md`, phase 2), read and revoked through Supabase
 * Auth's OAuth grants API from the web session (`supabase.auth.oauth.listGrants()`,
 * `revokeGrant({ clientId })`; the spike, `docs/research/mcp-oauth-spike-2026-11-09.md`, check 3:
 * camelCase, and a revoked grant deletes the client's sessions, so the agent's next call is
 * refused). The component on `/profile/edit` draws what this module decides; nothing here is
 * React or Supabase, so the decisions are tested on their own.
 */

export type ConnectedApp = {
  clientId: string;
  name: string;
  /** The client's own site, where it gave one. */
  uri: string | null;
  grantedAt: string | null;
};

/** What every connected app may do, in the consent screen's words: the server authorizes no finer. */
export const CONNECTED_APP_ACCESS = 'Can create media with your credits and publish posts as you.';

export const CONNECTED_APPS_COPY = {
  title: 'Connected apps',
  eyebrow: 'Agent access',
  description: 'Apps and AI agents you have let act as you on Magicbooklet. Disconnect one to end its access at once.',
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
    const clientId = text(client?.id) ?? text(client?.client_id);
    if (!clientId) continue;
    const grantedAt = text(grant?.granted_at);
    const app: ConnectedApp = {
      clientId,
      name: text(client?.name) ?? text(client?.client_name) ?? clientId,
      uri: text(client?.client_uri) ?? text(client?.uri),
      grantedAt: grantedAt && !Number.isNaN(Date.parse(grantedAt)) ? grantedAt : null,
    };
    const earlier = byClient.get(clientId);
    // A client approved twice is one app; it keeps its earliest approval.
    if (!earlier || (app.grantedAt && earlier.grantedAt && app.grantedAt < earlier.grantedAt)) byClient.set(clientId, app);
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

/** The slice of the browser client's OAuth API this module reads and writes. */
export type ConnectedAppsClient = {
  listGrants(): Promise<{ data: unknown; error: { message?: string } | null }>;
  revokeGrant(params: { clientId: string }): Promise<{ error: { message?: string } | null }>;
};

export async function listConnectedApps(client: ConnectedAppsClient): Promise<ConnectedApp[]> {
  const { data, error } = await client.listGrants();
  if (error) throw new Error(error.message || 'The connected apps could not be read.');
  return toConnectedApps(data);
}

export async function disconnectApp(client: ConnectedAppsClient, app: ConnectedApp): Promise<void> {
  const { error } = await client.revokeGrant({ clientId: app.clientId });
  if (error) throw new Error(error.message || CONNECTED_APPS_COPY.disconnectFailed(app.name));
}
