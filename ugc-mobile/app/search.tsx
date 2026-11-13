import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { ExploreSearchOverlay } from '@/components/explore-search-overlay';
import { useAuth } from '@/lib/auth';
import { searchScreenOpener } from '@/lib/open-search-screen';
import { SEARCH_SCREEN_FOCUS_FALLBACK_MS, searchScreenParams } from '@/lib/search-screen-route';

/**
 * Search as a screen of its own (search UX audit 2026-11-13, finding 7),
 * pushed over the tabs from Home and from Explore: the navigator gives it its
 * entrance and exit, the back swipe and Android's back key, and covers the
 * floating tab bar; a post or a profile opened from it comes back to it. Each
 * opening starts on an empty field, the recent searches and the ideas to start
 * from; `q` and `type` (a search link's) open it on that search, which is not
 * the person's commit and is not kept among their recent searches by itself.
 */
export default function SearchRoute() {
  const { api } = useAuth();
  const params = searchScreenParams(useLocalSearchParams<{ q?: string | string[]; type?: string | string[] }>());
  const navigation = useNavigation();

  // Home's and Explore's entries push nothing more while this screen is up.
  useEffect(() => {
    searchScreenOpener.screenMounted();
    return () => searchScreenOpener.screenUnmounted();
  }, []);

  // The keyboard rises once the push has finished sliding in (review of #795).
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const fallback = setTimeout(() => setEntered(true), SEARCH_SCREEN_FOCUS_FALLBACK_MS);
    const unsubscribe = navigation.addListener('transitionEnd' as never, (event: { data?: { closing?: boolean } }) => {
      if (!event?.data?.closing) setEntered(true);
    });
    return () => {
      clearTimeout(fallback);
      unsubscribe();
    };
  }, [navigation]);

  // One pop per press: a second press during the pop would step back a tab.
  const closing = useRef(false);
  return (
    <ExploreSearchOverlay
      api={api}
      visible
      initialQuery={params.query}
      initialType={params.type}
      focusReady={entered}
      onClose={() => {
        if (closing.current) return;
        closing.current = true;
        // Opened from a link with nothing under it: Back lands on Home.
        if (router.canGoBack()) router.back();
        else router.replace('/');
      }}
    />
  );
}
