import { readSupportHubTab, SUPPORT_HUB_TAB_PARAM } from '../../../ugc-mobile/lib/support-hub-policy/support-hub-policy';

import SupportHubClient from './SupportHubClient';

type SupportPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/** Help & Support, on the tab its address names (`?tab=updates`, `?tab=roadmap`), else the chat. */
export default async function SupportPage({ searchParams }: SupportPageProps) {
  const params = searchParams ? await searchParams : {};
  return <SupportHubClient initialTab={readSupportHubTab(params[SUPPORT_HUB_TAB_PARAM])} />;
}
