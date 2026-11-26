'use client';

import clsx from 'clsx';
import { AlertCircle, LifeBuoy, Mail, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { Button, Kicker, StatusCallout, Text } from '@/components/DesignSystem';
import { SupportChat } from '@/components/support-chat/SupportChat';
import { createAccountSupportTransport } from '@/components/support-chat/support-chat-transports';
import { useSupportChat } from '@/components/support-chat/use-support-chat';
import { siteConfig } from '@/lib/seo';
import { supabase } from '@/lib/supabase';

import { SUPPORT_WORDS } from '../../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';

const SUPPORT_MAILTO = `mailto:${siteConfig.supportEmail}?subject=${encodeURIComponent('Magicbooklet support')}`;

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

/**
 * The account's conversation with support, worked as a chat app (owner,
 * 2026-11-22): new replies arrive while the page is open, with ticks,
 * "typing…", replies, reactions, edits and deletes. The thread itself is the
 * shared `SupportChat`; this page adds the sign-in states around it.
 */
export default function SupportConversationClient() {
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
    <div className="ui-page ui-page-ambient min-h-screen pb-16">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
        <header className="ui-enter mb-5">
          <Kicker icon={LifeBuoy}>Help &amp; support</Kicker>
          <Text as="h1" variant="pageTitle" className="mt-3">{SUPPORT_WORDS.title}</Text>
          <Text variant="bodySm" className="mt-2 max-w-xl sm:text-base">{SUPPORT_WORDS.intro}</Text>
        </header>

        {state.kind === 'signed-out' ? (
          <div>
            <StatusCallout tone="warning" icon={AlertCircle} title="Sign in again to message support" body="Your session on this browser has ended." />
            <Button href="/login?returnUrl=%2Fsupport" prefetch={false} variant="primary" className="mt-5">Sign in</Button>
          </div>
        ) : state.kind === 'registration-required' ? (
          <div>
            <StatusCallout tone="info" icon={LifeBuoy} title={SUPPORT_WORDS.signInTitle} body={SUPPORT_WORDS.signInBody} />
            <div className="mt-5 flex flex-wrap gap-3">
              <Button href="/login?returnUrl=%2Fsupport" prefetch={false} variant="primary">Sign in</Button>
              <a href={SUPPORT_MAILTO} className="ui-button ui-button-secondary ui-focus-ring">
                {SUPPORT_WORDS.emailInstead}
                <Mail className="h-4 w-4" aria-hidden />
              </a>
            </div>
          </div>
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
            avatar={(
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--ui-primary-soft)] text-[var(--ui-primary)]">
                <LifeBuoy className="h-5 w-5" aria-hidden />
              </span>
            )}
          />
        )}

        {/* The shell's Help & feedback opens this page for a browser with a session (owner,
            2026-11-26), so the contact page's phone, address and policy links, child safety and
            account deletion among them, are reached from here. */}
        <Text variant="caption" className="mt-5 block">
          Prefer email? Write to{' '}
          <a href={SUPPORT_MAILTO} className="underline underline-offset-2">{siteConfig.supportEmail}</a>.
          {' '}Our phone, address and policies are on the{' '}
          <Link href="/contact" prefetch={false} className="underline underline-offset-2">contact page</Link>.
        </Text>
      </div>
    </div>
  );
}
