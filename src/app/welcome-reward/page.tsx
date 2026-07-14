import { redirect } from 'next/navigation';

import { getSafeProfileNextPath } from '@/lib/profile';
import { getServerAuthState } from '@/lib/supabase-server';
import WelcomeRewardClient from './WelcomeRewardClient';

interface WelcomeRewardPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function WelcomeRewardPage({ searchParams }: WelcomeRewardPageProps) {
  const auth = await getServerAuthState();
  const resolved = searchParams ? await searchParams : {};
  const nextPath = getSafeProfileNextPath(firstParam(resolved.next), '/create');
  if (!auth.session?.user) {
    redirect(`/login?returnUrl=${encodeURIComponent(`/welcome-reward?next=${encodeURIComponent(nextPath)}`)}`);
  }
  return <WelcomeRewardClient nextPath={nextPath} />;
}
