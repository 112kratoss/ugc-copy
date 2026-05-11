'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Heart, ShoppingBag, Wand2 } from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import { HoverVideo } from '@/app/components/HoverVideo';
import MediaDetailsPreviewModal from '@/app/components/MediaDetailsPreviewModal';
import PublicShareButton from '@/app/components/PublicShareButton';
import TextPostPreviewCard from '@/app/components/TextPostPreviewCard';
import { useOptimisticPostSave } from '@/app/components/useOptimisticPostSave';
import { getBundleAccessLabel, isPostResourceKind, type PostResourceKind } from '@/lib/post-resource-bundles';
import { formatBundleAccessLabel } from '@/lib/marketplace-trust';
import type { ShowcaseFeedItem } from '@/lib/showcase';
import { buildShowcaseDetailPath } from '@/lib/share';

interface HomeShowcasePreviewGridProps {
  items: ShowcaseFeedItem[];
}

function getItemSummary(item: ShowcaseFeedItem) {
  const publicText = item.body?.trim() || item.prompt?.trim();
  if (publicText) {
    return publicText;
  }

  const source = item.sourceTool || item.model;
  const unlock = item.asset ? 'Unlock attached.' : 'Public community post.';
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
    });
  }

  return getBundleAccessLabel(asset.accessMode, asset.priceUsdCents);
}

function formatHomeDate(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));
}

export default function HomeShowcasePreviewGrid({
  items,
}: HomeShowcasePreviewGridProps) {
  const router = useRouter();
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
  });
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  const selectedItem = useMemo(
    () => feedItems.find((item) => item.id === selectedItemId) ?? null,
    [feedItems, selectedItemId]
  );

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
        {feedItems.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-label={`Preview ${item.title}`}
            onClick={() => setSelectedItemId(item.id)}
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
            ) : item.mediaKind === 'video' && item.mediaUrl ? (
              <HoverVideo
                src={item.mediaUrl}
                className="block h-auto w-full object-cover opacity-90 transition-opacity group-hover:opacity-100"
              />
            ) : item.mediaUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.mediaUrl}
                alt={item.title}
                className="block h-auto w-full object-cover opacity-90 transition-opacity group-hover:opacity-100"
              />
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
        ))}
      </div>

      <MediaDetailsPreviewModal
        isOpen={Boolean(selectedItem)}
        onClose={() => setSelectedItemId(null)}
        mediaType={
          selectedItem?.postFormat === 'text'
            ? 'text'
            : selectedItem?.mediaKind === 'video'
              ? 'video'
              : 'image'
        }
        src={selectedItem?.mediaUrl ?? null}
        alt={selectedItem?.title ?? 'Selected creation preview'}
        title={selectedItem?.title ?? 'Creation preview'}
        prompt={selectedItem?.prompt ?? ''}
        body={selectedItem?.body ?? ''}
        creator={selectedItem?.creator}
        actions={selectedItem ? (
          <>
            <button
              type="button"
              onClick={() => void toggleSave(selectedItem.id)}
              disabled={savingItemIds.has(selectedItem.id)}
              aria-label={`${savedItemIds.has(selectedItem.id) ? 'Remove save from' : 'Save'} ${selectedItem.title}. ${selectedItem.saveCount} saves`}
              aria-pressed={savedItemIds.has(selectedItem.id)}
              aria-busy={savingItemIds.has(selectedItem.id)}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-white disabled:cursor-not-allowed disabled:opacity-70"
            >
              <Heart
                aria-hidden="true"
                className={`h-4 w-4 ${savedItemIds.has(selectedItem.id) ? 'fill-pink-500 text-pink-500' : ''}`}
              />
              <span aria-hidden="true">{selectedItem.saveCount}</span>
            </button>
            <PublicShareButton
              generationId={selectedItem.id}
              title={selectedItem.title}
              description={selectedItem.body || selectedItem.prompt}
              sourceSurface="showcase"
              accessToken={session?.access_token ?? null}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
            />
            {selectedItem.asset ? (
              <Link
                href={buildShowcaseDetailPath(selectedItem.id, {
                  from: 'home',
                  returnTo: '/',
                  section: 'resources',
                })}
                className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/40 hover:bg-emerald-500/15"
              >
                View unlock
              </Link>
            ) : null}
            {selectedItem.canRemix ? (
              <button
                type="button"
                onClick={() => void handleRemix(selectedItem.id)}
                aria-label={`Remix ${selectedItem.title}. ${selectedItem.remixCount} remixes`}
                className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-purple-600 to-fuchsia-500 px-4 py-2 text-sm font-semibold text-white transition hover:from-purple-500 hover:to-fuchsia-400"
              >
                <Wand2 aria-hidden="true" className="h-4 w-4" />
                <span aria-hidden="true">Remix</span>
                <span
                  aria-hidden="true"
                  className="rounded-full bg-black/20 px-2 py-0.5 text-xs font-bold"
                >
                  {selectedItem.remixCount}
                </span>
              </button>
            ) : null}
            <Link
              href={buildShowcaseDetailPath(selectedItem.id, {
                from: 'home',
                returnTo: '/',
              })}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
            >
              Open public page
            </Link>
          </>
        ) : null}
      />
    </>
  );
}
