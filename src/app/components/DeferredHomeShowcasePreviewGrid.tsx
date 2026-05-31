'use client';

import type { Session } from '@supabase/supabase-js';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

import type { ShowcaseFeedItem } from '@/lib/showcase';

interface DeferredHomeShowcasePreviewGridProps {
  items: ShowcaseFeedItem[];
  initialSession: Session | null;
  initialCredits: number | null;
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const HomeShowcasePreviewGridIsland = dynamic(
  () => import('./HomeShowcasePreviewGridIsland'),
  {
    ssr: false,
    loading: () => <HomeShowcasePreviewGridFallback />,
  }
);

function useDeferredUntilIdle() {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const idleWindow = window as IdleWindow;

    if (typeof idleWindow.requestIdleCallback === 'function') {
      const idleId = idleWindow.requestIdleCallback(() => setIsReady(true), {
        timeout: 1800,
      });

      return () => idleWindow.cancelIdleCallback?.(idleId);
    }

    const timeoutId = idleWindow.setTimeout(() => setIsReady(true), 900);
    return () => idleWindow.clearTimeout(timeoutId);
  }, []);

  return isReady;
}

function HomeShowcasePreviewGridFallback() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5" aria-hidden="true">
      {[180, 240, 210, 270, 200].map((height, index) => (
        <div
          key={index}
          className="relative overflow-hidden rounded-[24px] border border-white/8 bg-[#111215]"
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
  const isReady = useDeferredUntilIdle();

  if (!isReady) {
    return <HomeShowcasePreviewGridFallback />;
  }

  return (
    <HomeShowcasePreviewGridIsland
      items={items}
      initialSession={initialSession}
      initialCredits={initialCredits}
    />
  );
}
