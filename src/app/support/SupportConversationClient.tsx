'use client';

import clsx from 'clsx';
import { AlertCircle, LifeBuoy, Mail, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button, StatusCallout, Text } from '@/components/DesignSystem';
import { SupportChat } from '@/components/support-chat/SupportChat';
import { createAccountSupportTransport } from '@/components/support-chat/support-chat-transports';
import { useSupportChat } from '@/components/support-chat/use-support-chat';
import { siteConfig } from '@/lib/seo';
import { supabase } from '@/lib/supabase';

import { SUPPORT_WORDS } from '../../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';

export const SUPPORT_MAILTO = `mailto:${siteConfig.supportEmail}?subject=${encodeURIComponent('Magicbooklet support')}`;

/** Where Help & Support's sign-in goes, and comes back to the chat from. */
export const SUPPORT_SIGN_IN_HREF = '/login?returnUrl=%2Fsupport';

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

/**
 * The chat's place for a reader without an account: a visitor with no session,
 * whom Help & Support no longer sends to sign in as the page opens (owner,
 * 2026-11-26: the page is everyone's), and a guest, whom the routes answer
 * `REGISTRATION_REQUIRED`. Messages are kept with an account, so they sign in,
 * or write to the support mail without one.
 */
export function SupportChatSignInPrompt() {
  return (
    <div>
      <StatusCallout tone="info" icon={LifeBuoy} title={SUPPORT_WORDS.signInTitle} body={SUPPORT_WORDS.signInBody} />
      <div className="mt-5 flex flex-wrap gap-3">
        <Button href={SUPPORT_SIGN_IN_HREF} prefetch={false} variant="primary">Sign in</Button>
        <a href={SUPPORT_MAILTO} className="ui-button ui-button-secondary ui-focus-ring">
          {SUPPORT_WORDS.emailInstead}
          <Mail className="h-4 w-4" aria-hidden />
        </a>
      </div>
    </div>
  );
}

/** What the chat says it is for, over the thread or the sign-in prompt. */
export function SupportChatIntro() {
  return <Text variant="bodySm" className="mb-4 max-w-xl sm:text-base">{SUPPORT_WORDS.intro}</Text>;
}

/**
 * Help & Support's Chat tab: the account's conversation with support, worked
 * as a chat app (owner, 2026-11-22): new replies arrive while the page is
 * open, with ticks, "typing…", replies, reactions, edits and deletes. The
 * thread itself is the shared `SupportChat`; this adds the states around it.
 * It is drawn for a browser with a session; Help & Support draws the sign-in
 * prompt for one without, so no thread is asked for there.
 */
export default function SupportConversationClient({
  initialDraft = '',
  focusComposer = false,
  onDraftChange,
}: {
  /** What the composer opens with: the message written before another tab was opened, or "Feature idea: ". */
  initialDraft?: string;
  /** Puts the focus in the composer as it opens, after the text: "Suggest a feature". */
  focusComposer?: boolean;
  /** The message being written, as it changes. */
  onDraftChange?: (draft: string) => void;
}) {
  const transport = useMemo(() => createAccountSupportTransport(authHeaders), []);
  const chat = useSupportChat({ viewer: 'user', transport });
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    setRetrying(true);
    try {
      await chat.reload();
    } finally {
      setRetrying(false);
    }
  };

  const { state } = chat;

  return (
    <div>
      <SupportChatIntro />
      {state.kind === 'signed-out' ? (
        <div>
          <StatusCallout tone="warning" icon={AlertCircle} title="Sign in again to message support" body="Your session on this browser has ended." />
          <Button href={SUPPORT_SIGN_IN_HREF} prefetch={false} variant="primary" className="mt-5">Sign in</Button>
        </div>
      ) : state.kind === 'registration-required' ? (
        <SupportChatSignInPrompt />
      ) : state.kind === 'failed' || state.kind === 'not-found' ? (
        <div>
          <StatusCallout tone="danger" icon={RefreshCw} title="Could not load your messages" body={SUPPORT_WORDS.loadFailed} />
          <button
            type="button"
            onClick={() => void retry()}
            disabled={retrying}
            className="ui-button ui-button-primary ui-focus-ring mt-5 disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshCw className={clsx('h-4 w-4', retrying && 'animate-spin')} aria-hidden />
            Try again
          </button>
        </div>
      ) : (
        <SupportChat
          chat={chat}
          viewer="user"
          title={SUPPORT_WORDS.supportName}
          statusLine={SUPPORT_WORDS.replyTime}
          otherName={SUPPORT_WORDS.supportName}
          privacyNote={SUPPORT_WORDS.privacyNote}
          emptyTitle={SUPPORT_WORDS.emptyTitle}
          emptyBody={SUPPORT_WORDS.emptyBody}
          closedNote={SUPPORT_WORDS.resolved}
          initialDraft={initialDraft}
          autoFocusComposer={focusComposer}
          onDraftChange={onDraftChange}
          avatar={(
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--ui-primary-soft)] text-[var(--ui-primary)]">
              <LifeBuoy className="h-5 w-5" aria-hidden />
            </span>
          )}
        />
      )}
    </div>
  );
}
