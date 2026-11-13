import { router, useLocalSearchParams } from 'expo-router';

import { ExploreSearchOverlay } from '@/components/explore-search-overlay';
import { useAuth } from '@/lib/auth';
import { searchScreenParams } from '@/lib/search-screen-route';

/**
 * Search as a screen of its own (search UX audit 2026-11-13, finding 7),
 * pushed over the tabs from Home and from Explore: the navigator gives it its
 * entrance and exit, the back swipe and Android's back key, and covers the
 * floating tab bar; a post or a profile opened from it comes back to it. Each
 * opening starts on an empty field, the recent searches and the ideas to start
 * from; `q` and `type` (a search link's) open it on that search.
 */
export default function SearchRoute() {
  const { api } = useAuth();
  const params = searchScreenParams(useLocalSearchParams<{ q?: string | string[]; type?: string | string[] }>());
  return (
    <ExploreSearchOverlay
      api={api}
      visible
      initialQuery={params.query}
      initialType={params.type}
      onClose={() => {
        // Opened from a link with nothing under it: Back lands on Home.
        if (router.canGoBack()) router.back();
        else router.replace('/');
      }}
    />
  );
}
