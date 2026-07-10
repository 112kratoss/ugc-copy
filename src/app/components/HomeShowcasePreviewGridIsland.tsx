'use client';

import type { Session } from '@supabase/supabase-js';

import { AuthProvider } from '@/app/components/AuthProvider';
import HomeShowcasePreviewGrid from '@/app/components/HomeShowcasePreviewGrid';
import type { ShowcaseFeedItem } from '@/lib/showcase';

interface HomeShowcasePreviewGridIslandProps {
  items: ShowcaseFeedItem[];
  initialSession: Session | null;
  initialCredits: number | null;
}

export default function HomeShowcasePreviewGridIsland({
  items,
  initialSession,
  initialCredits,
}: HomeShowcasePreviewGridIslandProps) {
  return (
    <AuthProvider
      initialSession={initialSession}
      initialCredits={initialCredits}
      hasResolvedInitialState={initialSession !== null}
    >
      <HomeShowcasePreviewGrid items={items} />
    </AuthProvider>
  );
}
