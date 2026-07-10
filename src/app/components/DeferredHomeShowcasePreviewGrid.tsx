'use client';

import type { Session } from '@supabase/supabase-js';
import dynamic from 'next/dynamic';

import type { ShowcaseFeedItem } from '@/lib/showcase';

interface DeferredHomeShowcasePreviewGridProps {
  items: ShowcaseFeedItem[];
  initialSession: Session | null;
  initialCredits: number | null;
}

const HomeShowcasePreviewGridIsland = dynamic(
  () => import('./HomeShowcasePreviewGridIsland'),
  {
    ssr: false,
    loading: () => <HomeShowcasePreviewGridFallback />,
  }
);

function HomeShowcasePreviewGridFallback() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5" aria-hidden="true">
      {[180, 240, 210, 270, 200].map((height, index) => (
        <div
          key={index}
          className="relative overflow-hidden rounded-[24px] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)]"
          style={{ minHeight: height }}
        >
          <div className="absolute inset-0 -translate-x-full animate-[skeleton-shimmer_1.5s_linear_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
        </div>
      ))}
    </div>
  );
}

export default function DeferredHomeShowcasePreviewGrid({
  items,
  initialSession,
  initialCredits,
}: DeferredHomeShowcasePreviewGridProps) {
  return (
    <HomeShowcasePreviewGridIsland
      items={items}
      initialSession={initialSession}
      initialCredits={initialCredits}
    />
  );
}
