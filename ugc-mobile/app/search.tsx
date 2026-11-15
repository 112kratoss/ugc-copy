import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useWindowDimensions } from 'react-native';

import { ExploreSearchOverlay } from '@/components/explore-search-overlay';
import { useAuth } from '@/lib/auth';
import { searchScreenOpener } from '@/lib/open-search-screen';
import { usableSearchEntranceOrigin } from '@/lib/search-entrance';
import { searchScreenParams } from '@/lib/search-screen-route';

/**
 * Search as a screen of its own (search UX audit 2026-11-13, finding 7),
 * pushed over the tabs from Home and from Explore: the navigator cross-fades it
 * in and out (app/_layout.tsx) while its field grows out of the control it was
 * opened from and the keyboard rises with it (lib/search-entrance.ts); it keeps
 * the back swipe and Android's back key, and covers the floating tab bar; a
 * post or a profile opened from it comes back to it. Each
 * opening starts on an empty field, the recent searches and the ideas to start
 * from; `q` and `type` (a search link's) open it on that search, which is not
 * the person's commit and is not kept among their recent searches by itself,
 * with the order, filters and exact reading the address names as the web's
 * does (`searchScreenHref`: where a visitor's Follow comes back to).
 */
export default function SearchRoute() {
  const { api } = useAuth();
  const params = searchScreenParams(useLocalSearchParams<Record<string, string | string[]>>());
  const window = useWindowDimensions();
  // The control this opening was pressed from, taken once: none for a link.
  const [origin] = useState(() => usableSearchEntranceOrigin(searchScreenOpener.takeOrigin(), window));

  // Home's and Explore's entries push nothing more while this screen is up.
  useEffect(() => {
    searchScreenOpener.screenMounted();
    return () => searchScreenOpener.screenUnmounted();
  }, []);

  // One pop per press: a second press during the pop would step back a tab.
  // And none once the screen is leaving another way: Close pops 110 ms after
  // the press (lib/search-entrance.ts), and Android's back key or the back
  // swipe in that window would otherwise be followed by a second pop
  // (review of #812, 1).
  const closing = useRef(false);
  const navigation = useNavigation();
  useEffect(() => navigation.addListener('beforeRemove' as never, () => {
    closing.current = true;
  }), [navigation]);
  return (
    <ExploreSearchOverlay
      api={api}
      visible
      initialQuery={params.query}
      initialType={params.type}
      initialSort={params.sort}
      initialFilters={params.filters}
      initialExact={params.exact}
      entranceFrom={origin}
      onClose={() => {
        if (closing.current || navigation.isFocused?.() === false) return;
        closing.current = true;
        // Opened from a link with nothing under it: Back lands on Home.
        if (router.canGoBack()) router.back();
        else router.replace('/');
      }}
    />
  );
}
