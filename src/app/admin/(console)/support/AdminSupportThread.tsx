'use client';

import Link from 'next/link';
import { CheckCircle2, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';

import { StatusCallout } from '@/components/DesignSystem';
import { SupportChat } from '@/components/support-chat/SupportChat';
import { createAdminSupportTransport } from '@/components/support-chat/support-chat-transports';
import { useSupportChat } from '@/components/support-chat/use-support-chat';

import { supportInitials } from '../../../../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';

/**
 * The operator's side of one account's support thread: the shared chat, read
 * again while the tab is visible, with the account's "typing…", read receipts,
 * replies, reactions, edits and deletes, and the switch that resolves the
 * conversation or opens it again.
 */
export function AdminSupportThread({
  conversationId,
  accountName,
  accountHandle,
  userId,
}: {
  conversationId: string;
  accountName: string;
  accountHandle: string | null;
  userId: string;
}) {
  const transport = useMemo(() => createAdminSupportTransport(conversationId), [conversationId]);
  const chat = useSupportChat({ viewer: 'staff', transport });
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const status = chat.state.kind === 'ready' ? chat.state.conversation?.status ?? 'open' : null;

  const switchStatus = async (action: 'resolve' | 'reopen') => {
    setSwitching(true);
    setSwitchError(null);
    // A resolve is held to what the operator was shown: the account's latest
    // message on screen. One that came in since refuses it, so it is read first.
    const messages = chat.state.kind === 'ready' ? chat.state.messages : [];
    const seenLastUserMessageAt = messages.filter((message) => message.author === 'user').at(-1)?.createdAt ?? null;
    try {
      const response = await fetch('/api/admin/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'resolve' ? { action, conversationId, seenLastUserMessageAt } : { action, conversationId }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
        if (response.status === 401) {
          setSwitchError('Your console session has ended. Sign in again.');
          return;
        }
        setSwitchError(typeof data?.error === 'string' ? data.error : 'The action failed. Try again.');
        if (data?.code === 'CONVERSATION_CHANGED') await chat.reload();
        return;
      }
      await chat.reload();
    } catch {
      setSwitchError('The action failed. Check your connection, then try again.');
    } finally {
      setSwitching(false);
    }
  };

  if (chat.state.kind === 'not-found') {
    return <StatusCallout tone="warning" title="This conversation no longer exists" body="The account may have been deleted." />;
  }

  // An ended console session, or a thread that could not be read, is said as
  // such, never drawn as an empty conversation. The chat stays on the page
  // under it, with what the operator was writing and any reply not sent, for
  // once the session is back.
  const sessionEnded = chat.state.kind === 'signed-out';
  const loadFailed = chat.state.kind === 'failed';
  const tryAgain = (
    <button type="button" onClick={() => void chat.reload()} className="ui-button ui-button-secondary ui-focus-ring">
      <RotateCcw className="h-3.5 w-3.5" aria-hidden />
      Try again
    </button>
  );

  const initials = supportInitials(accountName);

  return (
    <div>
      {sessionEnded ? (
        <StatusCallout
          tone="warning"
          className="mb-3"
          title="Your console session has ended"
          body="Sign in again in a new tab, then come back and press Try again. What you were writing stays on this page."
          action={(
            <div className="flex flex-wrap gap-2">
              <a href="/admin/login" target="_blank" rel="noopener" className="ui-button ui-button-secondary ui-focus-ring">
                Sign in
              </a>
              {tryAgain}
            </div>
          )}
        />
      ) : loadFailed ? (
        <StatusCallout
          tone="warning"
          className="mb-3"
          title="This conversation could not be loaded"
          body="Check your connection, then try again."
          action={tryAgain}
        />
      ) : null}
      <SupportChat
        chat={chat}
        viewer="staff"
        title={accountName}
        statusLine={[accountHandle ? `@${accountHandle}` : null, status === 'resolved' ? 'Resolved' : status === 'open' ? 'Open' : null]
          .filter(Boolean)
          .join(' · ')}
        otherName={accountName}
        emptyTitle={sessionEnded ? 'Signed out' : loadFailed ? 'Not loaded' : 'No messages'}
        emptyBody={sessionEnded
          ? 'Sign in again to see this conversation.'
          : loadFailed
            ? 'The messages could not be loaded.'
            : 'This conversation has no messages yet.'}
        avatar={(
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--ui-surface-3)] text-sm font-semibold text-[var(--ui-text-secondary)]">
            {initials}
          </span>
        )}
        headerActions={(
          <div className="flex shrink-0 items-center gap-2">
            {status === 'resolved' ? (
              <button
                type="button"
                disabled={switching}
                onClick={() => void switchStatus('reopen')}
                className="ui-button ui-button-secondary ui-focus-ring"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                {switching ? 'Reopening…' : 'Reopen'}
              </button>
            ) : status === 'open' ? (
              <button
                type="button"
                disabled={switching}
                onClick={() => void switchStatus('resolve')}
                className="ui-button ui-button-secondary ui-focus-ring"
              >
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                {switching ? 'Resolving…' : 'Mark resolved'}
              </button>
            ) : null}
            <Link href={`/admin/users/${userId}`} className="ui-button ui-button-secondary ui-focus-ring hidden sm:inline-flex">
              Open account
            </Link>
          </div>
        )}
      />
      {switchError ? (
        <p role="alert" className="mt-2 text-xs font-semibold text-[var(--ui-accent-danger)]">{switchError}</p>
      ) : null}
    </div>
  );
}
