'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useAuth } from '@/components/AuthProvider';
import { SegmentedControl, Text, type SegmentedControlOption } from '@/components/DesignSystem';
import { siteConfig } from '@/lib/seo';
import { useSupportUpdatesUnread } from '@/lib/support-updates-unread';

import {
  SUPPORT_FEATURE_IDEA_PREFIX,
  SUPPORT_HUB_TABS,
  SUPPORT_HUB_WORDS,
  supportHubPath,
  type SupportHubTab,
} from '../../../ugc-mobile/lib/support-hub-policy/support-hub-policy';

import SupportConversationClient, {
  SUPPORT_MAILTO,
  SupportChatIntro,
  SupportChatSignInPrompt,
} from './SupportConversationClient';
import SupportRoadmapPanel from './SupportRoadmapPanel';
import SupportUpdatesPanel from './SupportUpdatesPanel';

const tabId = (tab: SupportHubTab) => `support-tab-${tab}`;
const panelId = (tab: SupportHubTab) => `support-panel-${tab}`;

/**
 * Help & Support (owner, 2026-11-26: "in the help and support when they opens
 * it, i actually want 3 option"; plan:
 * docs/plans/help-support-updates-roadmap-plan-2026-11-26.md): Chat, Updates
 * and Roadmap as tabs under the page's heading, opening on Chat.
 *
 * - The tab travels in the address (`?tab=updates`, `?tab=roadmap`; the chat
 *   has none), written with `router.replace` without a scroll, and a link to
 *   another tab of the page (the shell's Help & feedback opens the chat) is
 *   followed.
 * - The page is everyone's: a visitor reads Updates and the Roadmap, and the
 *   Chat tab asks them to sign in, or offers the support mail.
 * - The chat is drawn only while its tab is open, since it reads the thread
 *   every few seconds and marks replies read; the message being written is
 *   kept here meanwhile and given back when the tab opens again. Updates and
 *   the Roadmap stay drawn once opened, so coming back to one reads nothing.
 * - A dot on Updates while an update is newer than this device's last look.
 */
export default function SupportHubClient({ initialTab }: { initialTab: SupportHubTab }) {
  const router = useRouter();
  const { session, user } = useAuth();
  const accessToken = session?.access_token ?? null;
  const hasSession = Boolean(session);
  // Reactions are an account's: a guest's session reads like a visitor.
  const registered = Boolean(user) && user?.is_anonymous !== true;
  // A different reader reads the lists again, with their own reactions.
  const readerKey = user?.id ?? 'visitor';

  const [tab, setTab] = useState<SupportHubTab>(initialTab);
  // The tab the address names, as the page was last drawn: a navigation to another one is followed.
  const [addressTab, setAddressTab] = useState<SupportHubTab>(initialTab);
  if (initialTab !== addressTab) {
    setAddressTab(initialTab);
    setTab(initialTab);
  }
  const [openedTabs, setOpenedTabs] = useState<ReadonlySet<SupportHubTab>>(() => new Set([initialTab]));
  if (!openedTabs.has(tab)) setOpenedTabs(new Set([...openedTabs, tab]));

  const [chatDraft, setChatDraft] = useState('');
  const [focusComposer, setFocusComposer] = useState(false);
  const updatesUnread = useSupportUpdatesUnread();

  const selectTab = (next: SupportHubTab, { focusChat = false }: { focusChat?: boolean } = {}) => {
    setFocusComposer(focusChat);
    if (next === tab) return;
    setTab(next);
    router.replace(supportHubPath(next), { scroll: false });
  };

  const suggestFeature = () => {
    // A message already started is kept: it is what the chat opens with.
    setChatDraft((current) => (current.trim() ? current : SUPPORT_FEATURE_IDEA_PREFIX));
    selectTab('chat', { focusChat: true });
  };

  const tabOptions: SegmentedControlOption<SupportHubTab>[] = SUPPORT_HUB_TABS.map((value) => {
    const dot = value === 'updates' && updatesUnread && tab !== 'updates';
    return {
      value,
      label: SUPPORT_HUB_WORDS.tabs[value],
      id: tabId(value),
      controls: panelId(value),
      ...(dot
        ? {
          count: <span data-support-updates-dot className="inline-block h-2 w-2 rounded-full bg-[var(--ui-primary)]" aria-hidden />,
          ariaLabel: `${SUPPORT_HUB_WORDS.tabs.updates}, ${SUPPORT_HUB_WORDS.unreadUpdates}`,
        }
        : {}),
    };
  });

  return (
    <div className="ui-page ui-page-ambient min-h-screen pb-16">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
        <header className="ui-enter mb-5">
          <Text as="h1" variant="pageTitle">{SUPPORT_HUB_WORDS.title}</Text>
        </header>

        <SegmentedControl
          role="tab"
          ariaLabel={SUPPORT_HUB_WORDS.tabsLabel}
          options={tabOptions}
          value={tab}
          onChange={(next) => selectTab(next)}
          className="mb-6 sm:max-w-md"
        />

        <div role="tabpanel" id={panelId('chat')} aria-labelledby={tabId('chat')} hidden={tab !== 'chat'}>
          {tab !== 'chat' ? null : hasSession ? (
            <SupportConversationClient
              initialDraft={chatDraft}
              focusComposer={focusComposer}
              onDraftChange={setChatDraft}
            />
          ) : (
            <div>
              <SupportChatIntro />
              <SupportChatSignInPrompt />
            </div>
          )}
        </div>

        <div role="tabpanel" id={panelId('updates')} aria-labelledby={tabId('updates')} hidden={tab !== 'updates'}>
          {openedTabs.has('updates') ? (
            <SupportUpdatesPanel
              key={readerKey}
              active={tab === 'updates'}
              accessToken={accessToken}
              canReact={registered}
            />
          ) : null}
        </div>

        <div role="tabpanel" id={panelId('roadmap')} aria-labelledby={tabId('roadmap')} hidden={tab !== 'roadmap'}>
          {openedTabs.has('roadmap') ? (
            <SupportRoadmapPanel
              key={readerKey}
              accessToken={accessToken}
              canReact={registered}
              onSuggestFeature={suggestFeature}
            />
          ) : null}
        </div>

        {/* The shell's Help & feedback opens this page for everyone (owner, 2026-11-26), so the
            contact page's phone, address and policy links, child safety and account deletion among
            them, are reached from here. */}
        <Text variant="caption" className="mt-8 block">
          Prefer email? Write to{' '}
          <a href={SUPPORT_MAILTO} className="underline underline-offset-2">{siteConfig.supportEmail}</a>.
          {' '}Our phone, address and policies are on the{' '}
          <Link href="/contact" prefetch={false} className="underline underline-offset-2">contact page</Link>.
        </Text>
      </div>
    </div>
  );
}
