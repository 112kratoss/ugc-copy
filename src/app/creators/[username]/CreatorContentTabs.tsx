'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  FileText,
  Heart,
  Images,
  Layers3,
  Loader2,
  LockKeyhole,
  RefreshCw,
  Repeat2,
} from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import { useOptimisticPostSave } from '@/app/components/useOptimisticPostSave';
import ShowcaseMediaCarousel from '@/app/showcase/ShowcaseMediaCarousel';
import ShowcaseReelViewer from '@/app/showcase/ShowcaseReelViewer';
import type { CreatorProfilePageData } from '@/lib/creator-profile';
import { formatBundleAccessLabel } from '@/lib/marketplace-trust';
import { getBundleAccessLabel } from '@/lib/post-resource-bundles';
import { buildShowcaseDetailPath } from '@/lib/share';
import type { ShowcaseFeedItem, ShowcaseMediaItem } from '@/lib/showcase';

type CreatorTab = 'creations' | 'unlocks' | 'tools';

const PAGE_SIZE = 24;
const tabHashes: Record<CreatorTab, string> = {
  creations: '#creator-creations',
  unlocks: '#creator-unlocks',
  tools: '#creator-tools',
};

function getTabFromHash(hash: string): CreatorTab {
  if (hash === tabHashes.unlocks) return 'unlocks';
  if (hash === tabHashes.tools) return 'tools';
  return 'creations';
}

function getItemMediaItems(item: ShowcaseFeedItem): ShowcaseMediaItem[] {
  if (item.mediaItems?.length) return item.mediaItems;
  if (!item.mediaUrl || !item.mediaKind) return [];

  return [{
    id: `${item.id}:cover`,
    url: item.mediaUrl,
    mediaKind: item.mediaKind,
    contentType: null,
    originalName: null,
    width: null,
    height: null,
    durationSeconds: null,
    sortOrder: 0,
  }];
}

function itemDisplayText(item: ShowcaseFeedItem) {
  return item.body?.trim() || item.prompt?.trim() || item.title || 'Creator note';
}

function assetLabel(item: ShowcaseFeedItem) {
  if (!item.asset) return null;
  if (item.asset.priceQuote) {
    return formatBundleAccessLabel({
      accessMode: item.asset.accessMode,
      priceQuote: item.asset.priceQuote,
    });
  }
  return getBundleAccessLabel(item.asset.accessMode, item.asset.priceUsdCents);
}

export function CreatorContentTabs({
  initialData,
  profilePath,
}: {
  initialData: CreatorProfilePageData;
  profilePath: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { session, user } = useAuth();
  const [activeTab, setActiveTab] = useState<CreatorTab>(() =>
    typeof window === 'undefined' ? 'creations' : getTabFromHash(window.location.hash)
  );
  const [pageInfo, setPageInfo] = useState(initialData.pageInfo);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [observerSupported, setObserverSupported] = useState(true);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedMediaIndex, setSelectedMediaIndex] = useState(() => {
    const value = Number(searchParams.get('media'));
    return Number.isInteger(value) && value >= 0 ? value : 0;
  });
  const loadingMoreRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const reelHistoryModeRef = useRef<'pushed' | 'direct' | null>(searchParams.get('post') ? 'direct' : null);
  const directPostRequestRef = useRef<string | null>(null);
  const {
    items,
    setItems,
    savedItemIds,
    setSavedItemIds,
    savingItemIds,
    toggleSave,
  } = useOptimisticPostSave({
    initialItems: initialData.items,
    accessToken: session?.access_token ?? null,
    isSignedIn: Boolean(user && session?.access_token),
    onAuthRequired: () => router.push(`/login?returnUrl=${encodeURIComponent(profilePath)}`),
    onError: (error) => console.error('Creator profile save failed:', error),
    sourceSurface: 'creator-profile',
  });

  const unlockItems = useMemo(() => items.filter((item) => Boolean(item.asset)), [items]);
  const visibleItems = activeTab === 'unlocks' ? unlockItems : items;
  const viewerItems = selectedItemId && !visibleItems.some((item) => item.id === selectedItemId)
    ? items
    : visibleItems;
  const tabs = [
    { id: 'creations' as const, label: 'Creations', count: initialData.stats.publicCreations },
    { id: 'unlocks' as const, label: 'Unlocks', count: initialData.stats.unlocks },
    { id: 'tools' as const, label: 'Tools', count: initialData.stats.toolsUsed.length },
  ];

  const updateLocation = useCallback((postId: string | null, mode: 'push' | 'replace', mediaIndex = 0) => {
    const params = new URLSearchParams(window.location.search);
    if (postId) {
      params.set('post', postId);
      if (mediaIndex > 0) params.set('media', String(mediaIndex));
      else params.delete('media');
    } else {
      params.delete('post');
      params.delete('media');
    }

    const query = params.size ? `?${params.toString()}` : '';
    const nextUrl = `${pathname}${query}${tabHashes[activeTab]}`;
    if (mode === 'push') window.history.pushState(null, '', nextUrl);
    else window.history.replaceState(null, '', nextUrl);
  }, [activeTab, pathname]);

  const selectViewerItem = useCallback((id: string) => {
    setSelectedMediaIndex(0);
    setSelectedItemId(id);
    updateLocation(id, 'replace', 0);
  }, [updateLocation]);

  const openViewer = useCallback((item: ShowcaseFeedItem, mediaIndex = 0) => {
    reelHistoryModeRef.current = 'pushed';
    setSelectedMediaIndex(mediaIndex);
    setSelectedItemId(item.id);
    updateLocation(item.id, 'push', mediaIndex);
  }, [updateLocation]);

  const closeViewer = useCallback(() => {
    setSelectedItemId(null);
    if (reelHistoryModeRef.current === 'pushed') {
      reelHistoryModeRef.current = null;
      window.history.back();
      return;
    }
    reelHistoryModeRef.current = null;
    updateLocation(null, 'replace');
  }, [updateLocation]);

  useEffect(() => {
    const handleHashChange = () => setActiveTab(getTabFromHash(window.location.hash));
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      const postId = params.get('post');
      const mediaIndex = Number(params.get('media'));
      setSelectedItemId(postId);
      setSelectedMediaIndex(Number.isInteger(mediaIndex) && mediaIndex >= 0 ? mediaIndex : 0);
      reelHistoryModeRef.current = postId ? 'direct' : null;
      setActiveTab(getTabFromHash(window.location.hash));
    };
    window.addEventListener('hashchange', handleHashChange);
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('hashchange', handleHashChange);
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    const postId = searchParams.get('post');
    if (!postId) {
      directPostRequestRef.current = null;
      return;
    }
    if (items.some((item) => item.id === postId)) {
      setSelectedItemId(postId);
      return;
    }
    if (directPostRequestRef.current === postId) return;
    directPostRequestRef.current = postId;

    const controller = new AbortController();
    void fetch(`/api/showcase/posts/${encodeURIComponent(postId)}`, {
      headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
      signal: controller.signal,
    }).then(async (response) => {
      const payload = await response.json();
      const item = payload?.item as ShowcaseFeedItem | undefined;
      if (!response.ok || !item || item.creator.username !== initialData.profile.username) {
        throw new Error(payload?.error || 'Creator post not found.');
      }
      setItems((current) => current.some((candidate) => candidate.id === item.id) ? current : [...current, item]);
      setSelectedItemId(item.id);
    }).catch((error) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.error('Failed to load creator post:', error);
      }
    });

    return () => controller.abort();
  }, [initialData.profile.username, items, searchParams, session?.access_token, setItems]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !pageInfo.hasMore || pageInfo.nextOffset === null) return;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    setLoadError(null);

    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(pageInfo.nextOffset),
      });
      const response = await fetch(
        `/api/creators/${encodeURIComponent(initialData.profile.username)}?${params.toString()}`,
        session?.access_token ? { headers: { Authorization: `Bearer ${session.access_token}` } } : undefined
      );
      const nextPage = await response.json() as CreatorProfilePageData;
      if (!response.ok || !Array.isArray(nextPage.items)) {
        throw new Error('Could not load more creations.');
      }

      setItems((current) => [
        ...current,
        ...nextPage.items.filter((item) => !current.some((candidate) => candidate.id === item.id)),
      ]);
      setSavedItemIds((current) => {
        const next = new Set(current);
        nextPage.items.forEach((item) => {
          if (item.isSaved) next.add(item.id);
        });
        return next;
      });
      setPageInfo(nextPage.pageInfo);
    } catch (error) {
      console.error('Failed to load more creator posts:', error);
      setLoadError(error instanceof Error ? error.message : 'Could not load more creations.');
    } finally {
      loadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [initialData.profile.username, pageInfo.hasMore, pageInfo.nextOffset, session?.access_token, setItems, setSavedItemIds]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setObserverSupported(false);
      return;
    }
    const sentinel = sentinelRef.current;
    if (!sentinel || !pageInfo.hasMore || activeTab === 'tools') return;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: '900px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [activeTab, loadMore, pageInfo.hasMore]);

  const handleTabSelect = (tab: CreatorTab) => {
    setActiveTab(tab);
    const params = new URLSearchParams(window.location.search);
    params.delete('post');
    params.delete('media');
    const query = params.size ? `?${params.toString()}` : '';
    window.history.replaceState(null, '', `${pathname}${query}${tabHashes[tab]}`);
  };

  const handleRemix = async (id: string) => {
    if (!user || !session?.access_token) {
      router.push(`/login?returnUrl=${encodeURIComponent(profilePath)}`);
      return;
    }
    try {
      const response = await fetch('/api/showcase/remix', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ generationId: id }),
      });
      const payload = await response.json();
      if (response.ok && payload.redirectTo) router.push(payload.redirectTo);
    } catch (error) {
      console.error('Creator profile remix failed:', error);
    }
  };

  const buildDetailPath = (id: string, section?: string) => buildShowcaseDetailPath(id, {
    from: 'creator',
    returnTo: `${profilePath}${tabHashes[activeTab]}`,
    section,
  });

  return (
    <section className="mt-7" aria-label="Creator portfolio">
      <div className="sticky top-16 z-20 -mx-1 rounded-[20px] border border-white/8 bg-black/80 p-1.5 shadow-lg backdrop-blur-xl sm:top-20 sm:mx-0">
        <div className="grid grid-cols-3 gap-1" role="tablist" aria-label="Creator profile sections">
          {tabs.map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => handleTabSelect(tab.id)}
                className={`ui-focus-ring min-h-11 rounded-[15px] px-2 text-sm font-bold transition ${
                  selected ? 'bg-white text-black' : 'text-zinc-400 hover:bg-white/[0.06] hover:text-white'
                }`}
              >
                {tab.label} <span className={selected ? 'text-black/55' : 'text-zinc-600'}>{tab.count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-6">
        {activeTab === 'tools' ? (
          <ToolsGrid tools={initialData.stats.toolsUsed} />
        ) : visibleItems.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-4">
            {visibleItems.map((item) => (
              <CreatorCard key={item.id} item={item} onOpen={openViewer} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={activeTab === 'unlocks' ? <LockKeyhole className="h-6 w-6" /> : <Images className="h-6 w-6" />}
            title={activeTab === 'unlocks' ? 'No unlocks yet' : 'No creations yet'}
            body={activeTab === 'unlocks'
              ? 'Reusable prompts, files, notes, and remix access will appear here.'
              : 'Published creator work will appear here.'}
          />
        )}
      </div>

      {activeTab !== 'tools' && pageInfo.hasMore ? (
        <div ref={sentinelRef} className="flex min-h-24 items-center justify-center py-6" aria-live="polite">
          {loadError ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="inline-flex items-center gap-2 text-sm font-semibold text-rose-300">
                <AlertCircle className="h-4 w-4" />
                {loadError}
              </div>
              <button type="button" onClick={() => void loadMore()} className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-white/12 bg-white/[0.05] px-4 text-sm font-bold text-white">
                <RefreshCw className="h-4 w-4" /> Retry
              </button>
            </div>
          ) : isLoadingMore ? (
            <div className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading creations
            </div>
          ) : !observerSupported ? (
            <button type="button" onClick={() => void loadMore()} className="ui-focus-ring min-h-11 rounded-full border border-white/12 bg-white/[0.05] px-5 text-sm font-bold text-white">
              Load more creations
            </button>
          ) : null}
        </div>
      ) : null}

      <ShowcaseReelViewer
        isOpen={Boolean(selectedItemId)}
        items={viewerItems}
        selectedItemId={selectedItemId}
        initialMediaIndex={selectedMediaIndex}
        savedItemIds={savedItemIds}
        savingItemIds={savingItemIds}
        accessToken={session?.access_token ?? null}
        hasMoreItems={pageInfo.hasMore}
        isLoadingMoreItems={isLoadingMore}
        onLoadMoreItems={loadMore}
        onClose={closeViewer}
        onSelectItemId={selectViewerItem}
        onMediaIndexChange={(index) => {
          setSelectedMediaIndex(index);
          if (selectedItemId) updateLocation(selectedItemId, 'replace', index);
        }}
        onToggleSave={toggleSave}
        onRemix={handleRemix}
        buildDetailPath={buildDetailPath}
      />
    </section>
  );
}

function CreatorCard({
  item,
  onOpen,
}: {
  item: ShowcaseFeedItem;
  onOpen: (item: ShowcaseFeedItem, mediaIndex?: number) => void;
}) {
  const mediaItems = getItemMediaItems(item);
  const isText = item.postFormat === 'text';
  const unlockLabel = assetLabel(item);

  return (
    <article className="group min-w-0 overflow-hidden rounded-[20px] border border-white/8 bg-[#111215] transition hover:border-white/18 hover:bg-[#15161a] focus-within:border-white/24">
      <div className="relative aspect-[4/5] overflow-hidden bg-black">
        {isText ? (
          <button
            type="button"
            onClick={() => onOpen(item, 0)}
            aria-label={`Open ${item.title}`}
            className="ui-focus-ring flex h-full w-full flex-col justify-between bg-[linear-gradient(145deg,#181128,#111215_55%,#0a1118)] p-4 text-left sm:p-5"
          >
            <FileText className="h-6 w-6 text-violet-300" />
            <span className="line-clamp-7 text-sm font-bold leading-6 text-zinc-100 sm:text-base">
              {itemDisplayText(item)}
            </span>
          </button>
        ) : mediaItems.length > 0 ? (
          <ShowcaseMediaCarousel
            mediaItems={mediaItems}
            title={item.title}
            mode="feed"
            onOpen={(mediaIndex) => onOpen(item, mediaIndex)}
            className="h-full"
          />
        ) : (
          <button type="button" onClick={() => onOpen(item, 0)} className="ui-focus-ring flex h-full w-full items-center justify-center text-zinc-600" aria-label={`Open ${item.title}`}>
            <Images className="h-9 w-9" />
          </button>
        )}

        {unlockLabel ? (
          <div className="pointer-events-none absolute left-2.5 top-2.5 z-[5] inline-flex max-w-[75%] items-center gap-1.5 rounded-full border border-amber-300/20 bg-black/75 px-2.5 py-1 text-[11px] font-black text-amber-300 backdrop-blur-md">
            <LockKeyhole className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{unlockLabel}</span>
          </div>
        ) : null}
      </div>

      <button type="button" onClick={() => onOpen(item, 0)} className="ui-focus-ring block w-full p-3 text-left sm:p-4" aria-label={`Open ${item.title}`}>
        <h3 className="line-clamp-2 min-h-10 text-sm font-black leading-5 text-white sm:text-base sm:leading-6">
          {item.title || itemDisplayText(item)}
        </h3>
        <div className="mt-2 min-h-4 truncate text-[11px] font-semibold text-zinc-500 sm:text-xs">
          {item.sourceTool ? `Made with ${item.sourceTool}` : '\u00a0'}
        </div>
        <div className="mt-3 flex items-center justify-between text-xs font-semibold text-zinc-500">
          <span className="inline-flex items-center gap-1.5"><Heart className="h-3.5 w-3.5" /> {item.saveCount}</span>
          <span className="inline-flex items-center gap-1.5"><Repeat2 className="h-3.5 w-3.5" /> {item.remixCount}</span>
        </div>
      </button>
    </article>
  );
}

function ToolsGrid({ tools }: { tools: CreatorProfilePageData['stats']['toolsUsed'] }) {
  if (!tools.length) {
    return <EmptyState icon={<Layers3 className="h-6 w-6" />} title="No tagged tools yet" body="Tools will appear when this creator tags where a creation was made." />;
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {tools.map((tool) => (
        <Link
          key={tool.slug}
          href={`/showcase?tool=${encodeURIComponent(tool.slug)}`}
          className="ui-focus-ring flex min-h-20 items-center gap-3 rounded-[18px] border border-white/8 bg-[#111215] px-4 transition hover:border-sky-300/25 hover:bg-[#15161a]"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-400/10 text-sky-300">
            <Layers3 className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-bold text-white">{tool.label}</span>
            <span className="mt-1 block text-xs font-semibold text-zinc-500">{tool.count} creation{tool.count === 1 ? '' : 's'}</span>
          </span>
        </Link>
      ))}
    </div>
  );
}

function EmptyState({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center border-y border-white/8 px-6 text-center">
      <div className="text-zinc-500">{icon}</div>
      <h2 className="mt-4 text-lg font-bold text-white">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-zinc-500">{body}</p>
    </div>
  );
}
