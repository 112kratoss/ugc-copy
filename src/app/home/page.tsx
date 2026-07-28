import Link from 'next/link';
import { Suspense, use } from 'react';

import AnonymousHome from '@/app/components/AnonymousHome';
import { StatusCallout } from '@/app/components/DesignSystem';
import HomeExperience from '@/app/components/HomeExperience';
import QuickStartsCard from '@/app/components/QuickStartsCard';
import WhatsNewModelsCard from '@/app/components/WhatsNewModelsCard';
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

const FEED_DETAIL_CONTEXT = { from: 'home', returnTo: '/' };

function HomeFeedSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-label="Loading feed">
      {[220, 320, 260].map((height, index) => (
        <div
          key={index}
          className="relative overflow-hidden rounded-[1.5rem] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)]"
          style={{ minHeight: height }}
        >
          <div className="absolute inset-0 -translate-x-full animate-[skeleton-shimmer_1.5s_linear_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
        </div>
      ))}
    </div>
  );
}

function HomeFeedSection({
  data,
  initialChipId,
}: {
  data: Promise<ShowcaseFeedPage | null>;
  initialChipId: ReturnType<typeof getFeedChip>['id'];
}) {
  const feed = use(data);

  if (!feed) {
    return (
      <div className="space-y-3">
        <StatusCallout
          tone="danger"
          title="Could not load the feed"
          body="Your creation tools are still available. Check the connection, then try again."
        />
        <Link href="/" prefetch={false} className="ui-button ui-button-secondary ui-focus-ring">
          Retry feed
        </Link>
      </div>
    );
  }

  return (
    <FeedClient
      initialFeed={feed}
      initialChipId={initialChipId}
      variant="embedded"
      detailContext={FEED_DETAIL_CONTEXT}
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

  // Kicked off in parallel; each section streams in behind its own Suspense
  // boundary as its data settles.
  const feedPromise = loadHomeFeed({ viewerUserId, chip });
  const workspacePromise = loadHomeWorkspaceGenerations({ userId: viewerUserId });
  const modelsPromise = loadHomeWhatsNewModels();

  return (
    <HomeExperience
      inlineStrip={(
        <Suspense fallback={null}>
          <HomeWorkspaceSection data={workspacePromise} credits={auth.credits} variant="inline" />
        </Suspense>
      )}
      feed={(
        <Suspense fallback={<HomeFeedSkeleton />}>
          <HomeFeedSection data={feedPromise} initialChipId={chip.id} />
        </Suspense>
      )}
      rail={(
        <>
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
