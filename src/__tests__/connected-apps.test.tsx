import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConnectedApps from '@/app/profile/edit/ConnectedApps';
import FeedbackViewport from '@/components/FeedbackViewport';
import { readFeedbackSnapshot, resetFeedbackState } from '@/components/feedback-state';
import {
  CONNECTED_APPS_COPY,
  CONNECTED_APP_ACCESS,
  POSTING_CONNECTED_APP_ACCESS,
  connectedAppAccess,
  disconnectQuestion,
  formatConnectedDate,
  isOAuthServerDisabledError,
  listConnectedApps,
  toConnectedApps,
  type ConnectedAppsClient,
} from '@/lib/connected-apps';
import { MCP_CLIENT_IDS, MCP_POSTING_ONLY_CLIENT_IDS } from '@/lib/mcp-client-directory';

// The page's own client is the browser's; the component takes the grants API as a prop, so the
// module that builds the browser client is never loaded here.
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { oauth: {} } } }));

const CLAUDE = { client: { id: 'client-claude', name: 'Claude Code', client_uri: 'https://claude.com/claude-code' }, scopes: ['openid', 'email'], granted_at: '2026-11-09T10:00:00.000Z' };
const CODEX = { client: { id: 'client-codex', name: 'Codex' }, scopes: ['openid'], granted_at: '2026-11-08T09:00:00.000Z' };

function api(overrides: Partial<ConnectedAppsClient> = {}) {
  return {
    listGrants: vi.fn(async () => ({ data: [CODEX, CLAUDE], error: null })),
    revokeGrant: vi.fn(async () => ({ error: null })),
    ...overrides,
  } satisfies ConnectedAppsClient;
}

const toasts = () => readFeedbackSnapshot().toasts.map(({ tone, message }) => ({ tone, message }));

describe('the connected apps rules', () => {
  it('lists one row per client, newest first, named by the client, and leaves out a grant with no client', () => {
    const apps = toConnectedApps([
      CODEX,
      CLAUDE,
      { client: { id: 'client-claude', name: 'Claude Code' }, granted_at: '2026-11-01T00:00:00.000Z' },
      { client: { id: 'client-bare' }, granted_at: 'not a date' },
      { client: null, granted_at: '2026-11-09T10:00:00.000Z' },
      'junk',
    ]);
    expect(apps).toEqual([
      { clientId: 'client-codex', name: 'Codex', uri: null, grantedAt: '2026-11-08T09:00:00.000Z' },
      // Approved twice: one row, at its earliest approval, which sorts it behind Codex.
      { clientId: 'client-claude', name: 'Claude Code', uri: 'https://claude.com/claude-code', grantedAt: '2026-11-01T00:00:00.000Z' },
      { clientId: 'client-bare', name: 'client-bare', uri: null, grantedAt: null },
    ]);
    expect(toConnectedApps(null)).toEqual([]);
    expect(formatConnectedDate('2026-11-09T10:00:00.000Z')).toBe('Connected Nov 9, 2026');
    expect(formatConnectedDate(null)).toBeNull();
    expect(disconnectQuestion(apps[0])).toMatchObject({ title: 'Disconnect Codex?', confirmLabel: 'Disconnect', tone: 'danger' });
  });

  it('reads a switched-off OAuth server as no apps connected, and any other failure as a failure', async () => {
    expect(isOAuthServerDisabledError({ code: 'feature_disabled', message: 'OAuth server is disabled' })).toBe(true);
    expect(isOAuthServerDisabledError({ status: 404, message: 'Not Found' })).toBe(true);
    expect(isOAuthServerDisabledError({ message: 'OAuth 2.1 server is not enabled for this project' })).toBe(true);
    expect(isOAuthServerDisabledError({ code: 'bad_jwt', message: 'invalid token' })).toBe(false);
    expect(isOAuthServerDisabledError(null)).toBe(false);
    expect(await listConnectedApps({
      listGrants: async () => ({ data: null, error: { code: 'feature_disabled', message: 'OAuth server is disabled' } }),
      revokeGrant: async () => ({ error: null }),
    })).toEqual([]);
    await expect(listConnectedApps({
      listGrants: async () => ({ data: null, error: { code: 'bad_jwt', message: 'invalid token' } }),
      revokeGrant: async () => ({ error: null }),
    })).rejects.toThrow('invalid token');
  });
});

describe('the Connected apps section', () => {
  beforeEach(() => {
    resetFeedbackState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the grants and draws each app with what it may do and the day it was approved', async () => {
    const client = api();
    render(<ConnectedApps client={client} />);
    expect(screen.getByRole('status', { name: CONNECTED_APPS_COPY.loading })).toBeInTheDocument();
    const rows = within(await screen.findByRole('list', { name: CONNECTED_APPS_COPY.title })).getAllByRole('listitem');
    expect(client.listGrants).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
    // Newest first.
    expect(rows[0]).toHaveTextContent('Claude Code');
    expect(rows[0]).toHaveTextContent(CONNECTED_APP_ACCESS);
    expect(rows[0]).toHaveTextContent('Connected Nov 9, 2026');
    expect(within(rows[0]).getByRole('button', { name: 'Disconnect Claude Code' })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('Codex');
    expect(screen.getByRole('heading', { name: CONNECTED_APPS_COPY.title })).toBeInTheDocument();
    // The section links to the setup page: nothing else in the signed-in app says how an agent is connected.
    expect(screen.getByRole('link', { name: /How to connect an agent/u })).toHaveAttribute('href', '/developers/mcp');
  });

  it('links to the setup page from the signed-out home\'s footer too', () => {
    const home = readFileSync(path.join(process.cwd(), 'src/components/AnonymousHome.tsx'), 'utf8');
    expect(home).toContain('<Link href="/developers/mcp" prefetch={false} className="hover:text-[var(--ui-text-primary)]">AI agents</Link>');
  });

  it('says of a posting-only app what it may do, not what every other app may', async () => {
    // The line under the name is the access the consent page showed that client.
    for (const id of Object.values(MCP_POSTING_ONLY_CLIENT_IDS)) expect(connectedAppAccess(id), id).toBe(POSTING_CONNECTED_APP_ACCESS);
    for (const id of [...Object.values(MCP_CLIENT_IDS), 'client-claude', '', null, undefined]) {
      expect(connectedAppAccess(id), String(id)).toBe(CONNECTED_APP_ACCESS);
    }
    expect(POSTING_CONNECTED_APP_ACCESS).toBe('Can publish, change and delete posts as you. Cannot create media or spend credits.');

    const posting = { client: { id: MCP_POSTING_ONLY_CLIENT_IDS.claudeDirectory, name: 'Claude (posting)' }, scopes: ['openid'], granted_at: '2026-11-10T10:00:00.000Z' };
    render(<ConnectedApps client={api({ listGrants: vi.fn(async () => ({ data: [CLAUDE, posting], error: null })) })} />);
    const rows = within(await screen.findByRole('list', { name: CONNECTED_APPS_COPY.title })).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Claude (posting)');
    expect(rows[0]).toHaveTextContent(POSTING_CONNECTED_APP_ACCESS);
    expect(rows[0]).not.toHaveTextContent(CONNECTED_APP_ACCESS);
    expect(rows[1]).toHaveTextContent('Claude Code');
    expect(rows[1]).toHaveTextContent(CONNECTED_APP_ACCESS);
  });

  it('disconnects an app only after the question, takes its row away at the answer, and says so', async () => {
    const client = api();
    render(<><ConnectedApps client={client} /><FeedbackViewport /></>);
    const list = await screen.findByRole('list', { name: CONNECTED_APPS_COPY.title });
    fireEvent.click(within(list).getByRole('button', { name: 'Disconnect Claude Code' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Disconnect Claude Code?');
    expect(client.revokeGrant).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(client.revokeGrant).not.toHaveBeenCalled();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);

    fireEvent.click(within(list).getByRole('button', { name: 'Disconnect Claude Code' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
    // camelCase, as the grants API takes it (the spike's check 3).
    expect(client.revokeGrant).toHaveBeenCalledWith({ clientId: 'client-claude' });
    await waitFor(() => expect(toasts()).toEqual([{ tone: 'success', message: CONNECTED_APPS_COPY.disconnected('Claude Code') }]));
    expect(list).toHaveTextContent('Codex');
  });

  it('draws the row again, and says why, when the revocation is refused', async () => {
    const client = api({ revokeGrant: vi.fn(async () => ({ error: { message: 'Network error' } })) });
    render(<><ConnectedApps client={client} /><FeedbackViewport /></>);
    const list = await screen.findByRole('list', { name: CONNECTED_APPS_COPY.title });
    fireEvent.click(within(list).getByRole('button', { name: 'Disconnect Codex' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(toasts()).toEqual([{ tone: 'error', message: 'Network error' }]));
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByRole('button', { name: 'Disconnect Codex' })).toBeInTheDocument();
  });

  it('shows the empty state for an account with no apps, and where the OAuth server is switched off', async () => {
    const client = api({ listGrants: vi.fn(async () => ({ data: [], error: null })) });
    const first = render(<ConnectedApps client={client} />);
    expect(await screen.findByText(CONNECTED_APPS_COPY.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(CONNECTED_APPS_COPY.emptyBody)).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    first.unmount();

    // The local stack as shipped and a preview project: no danger callout on every visit.
    const off = api({ listGrants: vi.fn(async () => ({ data: null, error: { code: 'feature_disabled', message: 'OAuth server is disabled' } })) });
    render(<ConnectedApps client={off} />);
    expect(await screen.findByText(CONNECTED_APPS_COPY.emptyTitle)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says when the list could not be read, never reads as empty, and reads again on Try again', async () => {
    const listGrants = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'Auth is unavailable.' } })
      .mockResolvedValueOnce({ data: [CLAUDE], error: null });
    const client = api({ listGrants });
    render(<ConnectedApps client={client} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(CONNECTED_APPS_COPY.failedTitle);
    expect(alert).toHaveTextContent('Auth is unavailable.');
    expect(screen.queryByText(CONNECTED_APPS_COPY.emptyTitle)).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: CONNECTED_APPS_COPY.retry }));
    expect(await screen.findByRole('list', { name: CONNECTED_APPS_COPY.title })).toHaveTextContent('Claude Code');
    expect(listGrants).toHaveBeenCalledTimes(2);
  });
});
