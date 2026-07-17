'use client';

import dynamic from 'next/dynamic';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, ShoppingBag } from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import { HoverVideo } from '@/app/components/HoverVideo';
import { OptimizedPreviewImage } from '@/app/components/OptimizedPreviewImage';
import TextPostPreviewCard from '@/app/components/TextPostPreviewCard';
import { useOptimisticPostSave } from '@/app/components/useOptimisticPostSave';
import { getBundleAccessLabel, isPostResourceKind, type PostResourceKind } from '@/lib/post-resource-bundles';
import { formatBundleAccessLabel } from '@/lib/marketplace-trust';
import type { ShowcaseFeedItem } from '@/lib/showcase';
import { buildShowcaseDetailPath } from '@/lib/share';

interface HomeShowcasePreviewGridProps {
  items: ShowcaseFeedItem[];
}

function ShowcaseReelLoadingFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 text-sm font-bold text-white backdrop-blur-sm"
    >
      <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-zinc-950 px-5 py-3 shadow-2xl">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Opening Showcase
      </span>
    </div>
  );
}

const ShowcaseReelViewer = dynamic(
  () => import('@/app/showcase/ShowcaseReelViewer'),
  {
    ssr: false,
    loading: ShowcaseReelLoadingFallback,
  }
);

function getCoverMedia(item: ShowcaseFeedItem) {
  return item.mediaItems?.reduce(
    (cover, media) => media.sortOrder < cover.sortOrder ? media : cover
  ) ?? null;
}

function getCoverAspectRatio(coverMedia: ReturnType<typeof getCoverMedia>): string {
  if (coverMedia?.width && coverMedia.height) {
    return `${coverMedia.width} / ${coverMedia.height}`;
  }

  return '4 / 5';
}

function getItemSummary(item: ShowcaseFeedItem) {
  const publicText = item.body?.trim() || item.prompt?.trim();
  if (publicText) {
    return publicText;
  }

  const source = item.sourceTool || item.model;
  const unlock = item.asset ? 'Recipe attached.' : 'Public community post.';
  return [source ? `Made with ${source}` : null, `${item.category} post`, unlock].filter(Boolean).join(' / ');
}

function getItemResourceKinds(item: ShowcaseFeedItem): PostResourceKind[] {
  return (item.asset?.resourceKinds ?? []).filter(isPostResourceKind);
}

function getAssetAccessLabel(asset: NonNullable<ShowcaseFeedItem['asset']>): string {
  if (asset.priceQuote) {
    return formatBundleAccessLabel({
      accessMode: asset.accessMode,
      priceQuote: asset.priceQuote,
    }).replace(/\s+unlock$/i, ' recipe');
  }

  return getBundleAccessLabel(asset.accessMode, asset.priceUsdCents).replace(/\s+unlock$/i, ' recipe');
}

function formatHomeDate(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}

export default function HomeShowcasePreviewGrid({
  items,
}: HomeShowcasePreviewGridProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { session, user } = useAuth();
  const {
    items: feedItems,
    savedItemIds,
    savingItemIds,
    toggleSave,
  } = useOptimisticPostSave({
    initialItems: items,
    accessToken: session?.access_token ?? null,
    isSignedIn: Boolean(user && session?.access_token),
    onAuthRequired: () => router.push('/login?returnUrl=/'),
    onError: (error) => console.error('Failed to save homepage showcase item:', error),
    sourceSurface: 'home',
  });
  const [selectedItemId, setSelectedItemId] = useState<string | null>(() => searchParams.get('post'));
  const [selectedMediaIndex, setSelectedMediaIndex] = useState(() => {
    const value = Number(searchParams.get('media'));
    return Number.isInteger(value) && value >= 0 ? value : 0;
  });
  const reelHistoryModeRef = useRef<'pushed' | 'direct' | null>(searchParams.get('post') ? 'direct' : null);

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

    const query = params.size > 0 ? `?${params.toString()}` : '';
    const nextUrl = `${pathname}${query}${window.location.hash}`;
    if (mode === 'push') window.history.pushState(null, '', nextUrl);
    else window.history.replaceState(null, '', nextUrl);
  }, [pathname]);

  const openViewer = useCallback((item: ShowcaseFeedItem) => {
    reelHistoryModeRef.current = 'pushed';
    setSelectedMediaIndex(0);
    setSelectedItemId(item.id);
    updateLocation(item.id, 'push');
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
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      const postId = params.get('post');
      const mediaIndex = Number(params.get('media'));
      setSelectedItemId(postId);
      setSelectedMediaIndex(Number.isInteger(mediaIndex) && mediaIndex >= 0 ? mediaIndex : 0);
      reelHistoryModeRef.current = postId ? 'direct' : null;
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const handleRemix = async (id: string) => {
    if (!user || !session?.access_token) {
      router.push('/login?returnUrl=/');
      return;
    }

    try {
      const response = await fetch('/api/showcase/remix', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ generationId: id }),
      });
      const data = await response.json();

      if (data.success && data.redirectTo) {
        router.push(data.redirectTo);
      }
    } catch (error) {
      console.error('Failed to remix homepage showcase item:', error);
    }
  };

  if (feedItems.length === 0) {
    return (
      <div className="rounded-[24px] border border-white/8 bg-white/[0.03] p-10 text-center text-zinc-400">
        No community inspiration is available yet.
      </div>
    );
  }

  return (
    <>
      <div className="columns-2 gap-4 space-y-4 md:columns-3 xl:columns-4 2xl:columns-5">
        {feedItems.map((item) => {
          const coverMedia = getCoverMedia(item);
          const mediaUrl = coverMedia?.url ?? item.mediaUrl;
          const mediaKind = coverMedia?.mediaKind ?? item.mediaKind;
          const previewUrl = coverMedia?.previewUrl ?? null;

          return (
            <button
              key={item.id}
              type="button"
              aria-label={`Preview ${item.title}`}
              onClick={() => openViewer(item)}
              className="group relative block w-full break-inside-avoid overflow-hidden rounded-[24px] border border-white/8 bg-[#111215] text-left"
            >
              {item.postFormat === 'text' ? (
                <TextPostPreviewCard
                  title={item.title}
                  summary={getItemSummary(item)}
                  sourceLabel={item.sourceTool || item.model}
                  dateLabel={formatHomeDate(item.createdAt)}
                  saveCount={item.saveCount}
                  remixCount={item.remixCount}
                  unlockLabel={item.asset ? getAssetAccessLabel(item.asset) : null}
                  resourceKinds={getItemResourceKinds(item)}
                  className="rounded-none border-0 shadow-none"
                />
              ) : mediaKind === 'video' && mediaUrl ? (
                <div className="relative w-full" style={{ aspectRatio: getCoverAspectRatio(coverMedia) }}>
                  <HoverVideo
                    src={mediaUrl}
                    poster={previewUrl}
                    className="absolute inset-0 h-full w-full object-cover opacity-90 transition-opacity group-hover:opacity-100"
                  />
                </div>
              ) : mediaUrl ? (
                <div className="relative w-full" style={{ aspectRatio: getCoverAspectRatio(coverMedia) }}>
                  <OptimizedPreviewImage
                    previewSrc={previewUrl ?? mediaUrl}
                    fallbackSrc={mediaUrl}
                    alt={item.title}
                    sizes="(min-width: 1536px) 20vw, (min-width: 1280px) 25vw, (min-width: 768px) 33vw, 50vw"
                    className="object-cover opacity-90 transition-opacity group-hover:opacity-100"
                  />
                </div>
              ) : (
                <div className="flex min-h-[280px] items-center justify-center bg-zinc-950 text-zinc-500">
                  No media preview
                </div>
              )}
              {item.postFormat !== 'text' ? (
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/70 to-transparent p-4">
                  <p className="line-clamp-2 text-sm font-medium text-white">{item.title}</p>
                  {item.asset ? (
                    <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-100">
                      <ShoppingBag className="h-3.5 w-3.5" />
                      {getAssetAccessLabel(item.asset)}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </button>
          );
        })}
      </div>

      {selectedItemId ? (
        <ShowcaseReelViewer
          isOpen={feedItems.some((item) => item.id === selectedItemId)}
          items={feedItems}
          selectedItemId={selectedItemId}
          initialMediaIndex={selectedMediaIndex}
          savedItemIds={savedItemIds}
          savingItemIds={savingItemIds}
          accessToken={session?.access_token ?? null}
          hasMoreItems={false}
          isLoadingMoreItems={false}
          onLoadMoreItems={() => undefined}
          onClose={closeViewer}
          onSelectItemId={(id) => {
            setSelectedMediaIndex(0);
            setSelectedItemId(id);
            updateLocation(id, 'replace');
          }}
          onMediaIndexChange={(index) => {
            setSelectedMediaIndex(index);
            updateLocation(selectedItemId, 'replace', index);
          }}
          onToggleSave={toggleSave}
          onRemix={handleRemix}
          buildDetailPath={(id, section) => buildShowcaseDetailPath(id, {
            from: 'home',
            returnTo: '/',
            section,
          })}
        />
      ) : null}
    </>
  );
}
