import { headers } from 'next/headers';
import { Suspense, use } from 'react';

import AnonymousHome from '@/components/AnonymousHome';
import { HOME_FEED_DETAIL_CONTEXT, HomeFeedSkeleton } from '@/components/HomeFeedSkeleton';
import WelcomeCreditsCard from '@/app/home/WelcomeCreditsCard';
import HomeExperience from '@/components/HomeExperience';
import HomeSlider from '@/components/HomeSlider';
import QuickStartsCard from '@/components/QuickStartsCard';
import WhatsNewModelsCard from '@/components/WhatsNewModelsCard';
import FeedClient from '@/app/feed/FeedClient';
import StaleSessionRecovery from '@/app/home/StaleSessionRecovery';
import WorkspaceCard from '@/app/home/WorkspaceCard';
import type { HomeWhatsNewModel, HomeWorkspaceGenerationView } from '@/lib/home-dashboard';
import {
  loadHomeFeed,
  loadHomeWhatsNewModels,
  loadHomeWorkspaceGenerations,
} from '@/lib/home-dashboard-service';
import { getFeedChip } from '@/lib/post-feed-chips';
import type { ShowcaseFeedPage } from '@/lib/showcase';
import { getServerAuthState } from '@/lib/supabase-server';

type HomeDashboardPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function getFirstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Mirrors the mobile rail's greeting chain: the profile's display name first
 * (the auth state already reads the profile row for the credit balance), then
 * the sign-in name, then the email's local part.
 */
function resolveDisplayName(
  user: { user_metadata?: Record<string, unknown>; email?: string },
  profileDisplayName: string | null | undefined,
) {
  const displayName = profileDisplayName?.trim() ?? '';
  const fullName = typeof user.user_metadata?.full_name === 'string'
    ? user.user_metadata.full_name.trim()
    : '';

  return displayName || fullName || user.email?.split('@')[0] || 'Creator';
}

function HomeFeedSection({
  data,
  initialChipId,
}: {
  data: Promise<ShowcaseFeedPage | null>;
  initialChipId: ReturnType<typeof getFeedChip>['id'];
}) {
  // A null feed (the loader failed) hands the client an empty lane that
  // fetches page one itself, with its own Retry: a server-side failure used to
  // show a link back to the same render.
  const feed = use(data);

  return (
    <FeedClient
      initialFeed={feed}
      initialChipId={initialChipId}
      variant="embedded"
      detailContext={HOME_FEED_DETAIL_CONTEXT}
    />
  );
}

function HomeWorkspaceSection({
  data,
  credits,
  variant,
}: {
  data: Promise<HomeWorkspaceGenerationView[]>;
  credits: number | null;
  variant: 'rail' | 'inline';
}) {
  const generations = use(data);

  return (
    <WorkspaceCard
      initialGenerations={generations}
      initialCredits={credits}
      variant={variant}
    />
  );
}

function HomeModelsSection({ data }: { data: Promise<HomeWhatsNewModel[]> }) {
  return <WhatsNewModelsCard models={use(data)} />;
}

function WorkspaceRailFallback() {
  return (
    <div className="ui-card relative min-h-40 overflow-hidden p-5" aria-label="Loading workspace">
      <div className="absolute inset-0 -translate-x-full animate-[skeleton-shimmer_1.5s_linear_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
    </div>
  );
}

/**
 * The signed-in home: the same feed-first shell the signed-out `/` renders,
 * with the rail's sign-in card swapped for live workspace context. Served on
 * `/` via the middleware rewrite (see src/proxy.ts).
 *
 * A hinted-but-invalid session falls back to the signed-out page in place —
 * a redirect back to `/` would loop through the same rewrite — and
 * StaleSessionRecovery then either refreshes into the dashboard or lets the
 * dead cookie clear.
 */
export default async function HomeDashboardPage({ searchParams }: HomeDashboardPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const auth = await getServerAuthState();

  if (!auth.session?.user) {
    return (
      <>
        <StaleSessionRecovery />
        <AnonymousHome />
      </>
    );
  }

  const chip = getFeedChip(getFirstValue(resolvedSearchParams.chip));
  const viewerUserId = auth.session.user.id;
  // Page one prices in the viewer's currency, as the API pages after it do.
  const countryCode = (await headers()).get('x-vercel-ip-country');

  // Kicked off in parallel; each section streams in behind its own Suspense
  // boundary as its data settles.
  const feedPromise = loadHomeFeed({ viewerUserId, chip, countryCode });
  const workspacePromise = loadHomeWorkspaceGenerations({ userId: viewerUserId });
  const modelsPromise = loadHomeWhatsNewModels();

  return (
    <HomeExperience
      hero={<HomeSlider displayName={resolveDisplayName(auth.session.user, auth.displayName)} />}
      inlineStrip={(
        <>
          <WelcomeCreditsCard />
          <Suspense fallback={null}>
            <HomeWorkspaceSection data={workspacePromise} credits={auth.credits} variant="inline" />
          </Suspense>
        </>
      )}
      feed={(
        <Suspense fallback={<HomeFeedSkeleton />}>
          <HomeFeedSection data={feedPromise} initialChipId={chip.id} />
        </Suspense>
      )}
      rail={(
        <>
          <WelcomeCreditsCard />
          <Suspense fallback={<WorkspaceRailFallback />}>
            <HomeWorkspaceSection data={workspacePromise} credits={auth.credits} variant="rail" />
          </Suspense>
          <QuickStartsCard />
          <Suspense fallback={null}>
            <HomeModelsSection data={modelsPromise} />
          </Suspense>
        </>
      )}
    />
  );
}
