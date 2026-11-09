'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bot, Plug, RefreshCw } from 'lucide-react';

import { Button, SectionHeader, StatusCallout } from '@/components/DesignSystem';
import { pushToast } from '@/components/feedback-state';
import { useConfirmation } from '@/components/useConfirmation';
import {
  CONNECTED_APPS_COPY,
  CONNECTED_APP_ACCESS,
  disconnectApp,
  disconnectQuestion,
  formatConnectedDate,
  listConnectedApps,
  type ConnectedApp,
  type ConnectedAppsClient,
} from '@/lib/connected-apps';
import { supabase } from '@/lib/supabase';

type ListState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; apps: ConnectedApp[] };

/**
 * The agents this account has approved through the MCP server's consent screen, with a way to
 * end each one's access (`connected-apps.ts`). It reads and revokes through the browser's own
 * session (Supabase Auth's grants API is the user's), so no bearer token or route is involved.
 * Disconnect asks first and the row leaves at the answer, as Blocked users' Unblock does: a button
 * that waits on the network reads as a press that did not land; a refusal draws the row again and
 * says why in a toast.
 */
export default function ConnectedApps({ client }: { client?: ConnectedAppsClient } = {}) {
  const api: ConnectedAppsClient = client ?? supabase.auth.oauth;
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [disconnectedIds, setDisconnectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const askToConfirm = useConfirmation();

  useEffect(() => {
    let cancelled = false;
    listConnectedApps(api)
      .then((apps) => {
        if (!cancelled) setState({ status: 'ready', apps });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ status: 'failed', message: error instanceof Error && error.message ? error.message : 'Something went wrong.' });
      });
    return () => {
      cancelled = true;
    };
    // The API is the session's; a new attempt is the one reason to read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((current) => current + 1);
  }, []);

  const disconnect = async (app: ConnectedApp) => {
    if (state.status !== 'ready') return;
    if (!(await askToConfirm(disconnectQuestion(app)))) return;
    setDisconnectedIds((current) => new Set(current).add(app.clientId));
    try {
      await disconnectApp(api, app);
      pushToast({ tone: 'success', message: CONNECTED_APPS_COPY.disconnected(app.name) });
    } catch (error) {
      // Nothing was revoked: the row is drawn again, where it was.
      setDisconnectedIds((current) => {
        const next = new Set(current);
        next.delete(app.clientId);
        return next;
      });
      pushToast({
        tone: 'error',
        message: error instanceof Error && error.message ? error.message : CONNECTED_APPS_COPY.disconnectFailed(app.name),
      });
    }
  };

  let body: React.ReactNode;
  if (state.status === 'loading') {
    body = (
      <div role="status" aria-label={CONNECTED_APPS_COPY.loading} className="space-y-3">
        {[0, 1].map((row) => (
          <div key={row} className="h-[76px] animate-pulse rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)]" />
        ))}
      </div>
    );
  } else if (state.status === 'failed') {
    body = (
      <StatusCallout
        tone="danger"
        title={CONNECTED_APPS_COPY.failedTitle}
        body={state.message}
        action={<Button variant="secondary" icon={RefreshCw} onClick={retry}>{CONNECTED_APPS_COPY.retry}</Button>}
      />
    );
  } else {
    const apps = state.apps.filter((app) => !disconnectedIds.has(app.clientId));
    body = apps.length === 0 ? (
      <StatusCallout tone="neutral" icon={Plug} title={CONNECTED_APPS_COPY.emptyTitle} body={CONNECTED_APPS_COPY.emptyBody} />
    ) : (
      <ul aria-label={CONNECTED_APPS_COPY.title} className="space-y-3">
        {apps.map((app) => {
          const connectedOn = formatConnectedDate(app.grantedAt);
          return (
            <li
              key={app.clientId}
              className="flex min-h-[76px] items-center gap-3 rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] px-4 py-3 sm:gap-4 sm:px-5"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--ui-surface-2)] text-[var(--ui-text-secondary)]">
                <Bot className="h-5 w-5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold text-[var(--ui-text-primary)]">{app.name}</span>
                <span className="mt-0.5 block text-xs text-[var(--ui-text-muted)]">{CONNECTED_APP_ACCESS}</span>
                {connectedOn ? <span className="mt-0.5 block truncate text-xs text-[var(--ui-text-faint)]">{connectedOn}</span> : null}
              </span>
              <Button
                variant="secondary"
                className="shrink-0"
                ariaLabel={`${CONNECTED_APPS_COPY.disconnect} ${app.name}`}
                onClick={() => void disconnect(app)}
              >
                {CONNECTED_APPS_COPY.disconnect}
              </Button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section aria-labelledby="connected-apps-title" className="ui-enter mt-10">
      <SectionHeader
        compact
        eyebrow={CONNECTED_APPS_COPY.eyebrow}
        title={CONNECTED_APPS_COPY.title}
        description={CONNECTED_APPS_COPY.description}
        className="mb-5"
      />
      {body}
    </section>
  );
}
