'use client';

import Link from 'next/link';
import { useState } from 'react';

import { HoverVideo } from '@/app/components/HoverVideo';
import MediaDetailsPreviewModal from '@/app/components/MediaDetailsPreviewModal';
import PublicShareButton from '@/app/components/PublicShareButton';
import type { ShowcaseFeedItem } from '@/lib/showcase';
import { buildShowcaseDetailPath } from '@/lib/share';

interface HomeShowcasePreviewGridProps {
  items: ShowcaseFeedItem[];
}

export default function HomeShowcasePreviewGrid({
  items,
}: HomeShowcasePreviewGridProps) {
  const [selectedItem, setSelectedItem] = useState<ShowcaseFeedItem | null>(null);

  if (items.length === 0) {
    return (
      <div className="rounded-[24px] border border-white/8 bg-white/[0.03] p-10 text-center text-zinc-400">
        No community inspiration is available yet.
      </div>
    );
  }

  return (
    <>
      <div className="columns-2 gap-4 space-y-4 md:columns-3 xl:columns-4 2xl:columns-5">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-label={`Preview ${item.title}`}
            onClick={() => setSelectedItem(item)}
            className="group relative block w-full break-inside-avoid overflow-hidden rounded-[24px] border border-white/8 bg-[#111215] text-left"
          >
            {item.category === 'video' || item.category === 'motion' ? (
              <HoverVideo
                src={item.url}
                className="block h-auto w-full object-cover opacity-90 transition-opacity group-hover:opacity-100"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.url}
                alt={item.title}
                className="block h-auto w-full object-cover opacity-90 transition-opacity group-hover:opacity-100"
              />
            )}
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/70 to-transparent p-4">
              <p className="line-clamp-2 text-sm font-medium text-white">{item.title}</p>
            </div>
          </button>
        ))}
      </div>

      <MediaDetailsPreviewModal
        isOpen={Boolean(selectedItem)}
        onClose={() => setSelectedItem(null)}
        mediaType={selectedItem && (selectedItem.category === 'video' || selectedItem.category === 'motion') ? 'video' : 'image'}
        src={selectedItem?.url ?? null}
        alt={selectedItem?.title ?? 'Selected creation preview'}
        title={selectedItem?.title ?? 'Creation preview'}
        prompt={selectedItem?.prompt ?? ''}
        creator={selectedItem?.creator}
        actions={selectedItem ? (
          <>
            <PublicShareButton
              generationId={selectedItem.id}
              title={selectedItem.title}
              description={selectedItem.prompt}
              sourceSurface="showcase"
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
            />
            <Link
              href={buildShowcaseDetailPath(selectedItem.id)}
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
