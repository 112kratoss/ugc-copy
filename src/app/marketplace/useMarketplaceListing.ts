'use client';

import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { useAuth } from '@/components/AuthProvider';
import {
  useHasHydratedSupabaseAuthCookieHint,
  useSupabaseAuthCookieHint,
} from '@/components/useSupabaseAuthCookieHint';
import { MARKETPLACE_INITIAL_PAGE_SIZE } from '@/lib/marketplace-resource-list-cache-policy';
import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';

import {
  DEFAULT_MARKETPLACE_FILTERS,
  buildMarketplaceListQuery,
  marketplaceFiltersKey,
  readMarketplaceAddress,
  type MarketplaceFilters,
} from './marketplace-address';

export interface MarketplaceListingPage {
  items: MarketplaceResourceListItem[];
  pageInfo: {
    hasMore: boolean;
    nextOffset: number | null;
    offset: number;
    limit: number;
  };
}

/** 'loading': a listing the page has not got yet; 'failed': one it could not read. */
export type MarketplaceListingStatus = 'ready' | 'loading' | 'failed';

export interface MarketplaceListing {
  filters: MarketplaceFilters;
  shortQuery: string;
  /** The first page for the address; null while one the page does not hold is read. */
  page: MarketplaceListingPage | null;
  status: MarketplaceListingStatus;
  retry: () => void;
  /** For `MarketplaceSearchParamsReporter`. */
  reportSearch: (search: string) => void;
  /**
   * Moves to another listing in place: the address changes (a history entry,
   * which Next's router follows), the page reads the new listing, nothing
   * reloads. The links still carry their addresses for a page without script.
   */
  navigate: (href: string) => void;
}

const VISITOR = 'visitor';

/**
 * `/marketplace` is one cached render for everyone (ISR, `page.tsx`): every
 * recipe, newest first, priced in no country, drawn for a signed-out visitor.
 * The address's filters and search, and the viewer, are read here once the
 * page is live:
 *
 * - the address (`?access=…&q=…`) through `useSearchParams` (the
 *   reporter below, which the cached render skips);
 * - the first page for it from the list API, which the CDN keeps per country
 *   for a visitor and filters a signed-in viewer's blocks for them
 *   (`GET /api/marketplace/resources`, the API "Load more" already read).
 *
 * The cached page stands for the plain address until its read lands, so a
 * visitor sees the recipes at once and in their currency a moment later; any
 * other address shows its own listing loading, never the cached one.
 */
export function useMarketplaceListing({
  serverPage,
  serverFilters = DEFAULT_MARKETPLACE_FILTERS,
  serverShortQuery = '',
}: {
  /** `null`: the server could not read it, and the browser reads it as any other. */
  serverPage: MarketplaceListingPage | null;
  /** The address the server drew: the plain one, for the cached page. */
  serverFilters?: MarketplaceFilters;
  serverShortQuery?: string;
}): MarketplaceListing {
  const { session, user, isLoading } = useAuth();
  const hasAuthCookie = useSupabaseAuthCookieHint();
  const hydrated = useHasHydratedSupabaseAuthCookieHint();
  const accessToken = session?.access_token ?? null;
  const viewerUserId = accessToken ? user?.id ?? null : null;
  // As the post page reads it (`useShowcasePostViewer`): null until it is
  // known whether anyone is signed in, so a viewer is never first read as a
  // visitor and the listing read twice.
  const viewerKey = viewerUserId ?? (!hydrated || (hasAuthCookie && isLoading) ? null : VISITOR);

  // `null` until the reporter has read the address; the server's until then.
  const [search, setSearch] = useState<string | null>(null);
  const [read, setRead] = useState<{ key: string; page: MarketplaceListingPage | null } | null>(null);
  const [attempt, setAttempt] = useState(0);

  const address = useMemo(
    () => (search === null ? { filters: serverFilters, shortQuery: serverShortQuery } : readMarketplaceAddress(search)),
    [search, serverFilters, serverShortQuery],
  );
  const isServerAddress = marketplaceFiltersKey(address.filters) === marketplaceFiltersKey(serverFilters)
    && address.shortQuery === serverShortQuery;
  // The first page the address names, as the list API is asked for it.
  const listQuery = buildMarketplaceListQuery(address.filters, {
    offset: 0,
    limit: MARKETPLACE_INITIAL_PAGE_SIZE,
  }).toString();
  // A query under the minimum is answered with the hint and lists nothing.
  // Keyed on who is looking, never on their token: Supabase renews the token
  // about hourly, and a read for each renewal would put page one back in place
  // of what "Load more" added and the search typed.
  const requestKey = search === null || viewerKey === null || address.shortQuery
    ? null
    : `${listQuery}\u0001${viewerKey}\u0001${attempt}`;

  // A signed-in viewer's page is filtered for their blocks, which the API can
  // do only with the session; a visitor's request stays bare so the edge can
  // keep serving its shared copy. The token is the one current when it is sent.
  const requestListing = useEffectEvent((query: string, signal: AbortSignal) => fetch(
    `/api/marketplace/resources?${query}`,
    {
      headers: accessToken
        ? { Accept: 'application/json', Authorization: `Bearer ${accessToken}` }
        : { Accept: 'application/json' },
      signal,
    },
  ));

  useEffect(() => {
    if (requestKey === null) return;
    const controller = new AbortController();
    void requestListing(listQuery, controller.signal).then(async (response) => {
      const body = await response.json().catch(() => null) as Partial<MarketplaceListingPage> | null;
      if (controller.signal.aborted) return;
      if (!response.ok || !Array.isArray(body?.items) || !body?.pageInfo) {
        setRead({ key: requestKey, page: null });
        return;
      }
      setRead({ key: requestKey, page: { items: body.items, pageInfo: body.pageInfo } });
    }).catch(() => {
      if (!controller.signal.aborted) setRead({ key: requestKey, page: null });
    });
    return () => controller.abort();
  }, [listQuery, requestKey]);

  const landed = read && read.key === requestKey ? read : null;
  // The cached page stands for its own address while the read is out, and if
  // the read fails: it lists what a visitor is shown.
  const page = landed?.page ?? (isServerAddress ? serverPage : null);
  const status: MarketplaceListingStatus = page ? 'ready' : landed ? 'failed' : 'loading';

  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  const navigate = useCallback((href: string) => {
    window.history.pushState(null, '', href);
  }, []);

  return {
    filters: address.filters,
    shortQuery: address.shortQuery,
    page: address.shortQuery ? null : page,
    status: address.shortQuery ? 'ready' : status,
    retry,
    reportSearch: setSearch,
    navigate,
  };
}

/**
 * Hands the address over once the page is live: `useSearchParams` makes the
 * cached render skip this (inside its own Suspense, with no fallback). Outside
 * Next's router (a test rendering the shell alone) there is no address to
 * read, and the server's stands.
 */
export function MarketplaceSearchParamsReporter({ onSearch }: { onSearch: (search: string) => void }) {
  const searchParams = useSearchParams();
  const search = searchParams === null ? null : searchParams.toString();
  useLayoutEffect(() => {
    if (search !== null) onSearch(search);
  }, [onSearch, search]);
  return null;
}
