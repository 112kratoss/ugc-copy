'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { useAuth } from '@/components/AuthProvider';
import { SegmentedControl, Text, type SegmentedControlOption } from '@/components/DesignSystem';
import { siteConfig } from '@/lib/seo';
import { useSupportUpdatesUnread } from '@/lib/support-updates-unread';

import {
  SUPPORT_FEATURE_IDEA_PREFIX,
  SUPPORT_HUB_TAB_PARAM,
  SUPPORT_HUB_TABS,
  SUPPORT_HUB_WORDS,
  readSupportHubTab,
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
 *   has none), written with the browser's `history.replaceState`, which Next's
 *   router follows without asking the server for the page again (a press is
 *   instant, and a failed or skewed fetch cannot turn into a reload that loses
 *   the chat). A link to another tab of the page (the shell's Help & feedback
 *   opens the chat) is followed through the address it leaves.
 * - The page is everyone's: a visitor reads Updates and the Roadmap, and the
 *   Chat tab asks them to sign in, or offers the support mail.
 * - Every tab stays drawn once opened, the chat too, as the app keeps it: a
 *   message on its way, a picked photo, a reply or an edit survive a look at
 *   Updates. The chat reads the thread and marks replies read only while
 *   shown; coming back to Updates or the Roadmap reads nothing.
 * - A dot on Updates while an update is newer than this device's last look.
 */
export default function SupportHubClient({ initialTab }: { initialTab: SupportHubTab }) {
  const searchParams = useSearchParams();
  const { session, user } = useAuth();
  const accessToken = session?.access_token ?? null;
  const hasSession = Boolean(session);
  // Reactions are an account's: a guest's session reads like a visitor.
  const registered = Boolean(user) && user?.is_anonymous !== true;
  // A different reader reads the lists again, with their own reactions.
  const readerKey = user?.id ?? 'visitor';

  const [tab, setTab] = useState<SupportHubTab>(initialTab);
  // The tab the address names: a navigation to another one (a link) is followed.
  // A press writes the address too, naming the tab it already shows.
  const addressTab = searchParams ? readSupportHubTab(searchParams.get(SUPPORT_HUB_TAB_PARAM) ?? undefined) : initialTab;
  const [followedAddressTab, setFollowedAddressTab] = useState<SupportHubTab>(addressTab);
  if (addressTab !== followedAddressTab) {
    setFollowedAddressTab(addressTab);
    setTab(addressTab);
  }
  const [openedTabs, setOpenedTabs] = useState<ReadonlySet<SupportHubTab>>(() => new Set([initialTab]));
  if (!openedTabs.has(tab)) setOpenedTabs(new Set([...openedTabs, tab]));

  // "Suggest a feature" asks the mounted chat to open its composer; a message already started is kept.
  // The request is the reader's who made it: another account signing in on the open page never gets it.
  const [composerRequest, setComposerRequest] = useState<{ text: string; nonce: number; readerKey: string } | null>(null);
  const readersComposerRequest = composerRequest?.readerKey === readerKey ? composerRequest : null;
  const updatesUnread = useSupportUpdatesUnread();

  const selectTab = (next: SupportHubTab) => {
    if (next === tab) return;
    setTab(next);
    window.history.replaceState(null, '', supportHubPath(next));
  };

  const suggestFeature = () => {
    setComposerRequest((current) => ({ text: SUPPORT_FEATURE_IDEA_PREFIX, nonce: (current?.nonce ?? 0) + 1, readerKey }));
    selectTab('chat');
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
          {/* Kept mounted once opened, as the app keeps it: a message on its way, a picked photo, a
              reply or an edit survive a look at Updates. It reads and marks read only while shown. */}
          {!openedTabs.has('chat') ? null : hasSession ? (
            <SupportConversationClient active={tab === 'chat'} composerRequest={readersComposerRequest} />
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
