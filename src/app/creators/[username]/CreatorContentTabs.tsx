'use client';

import Link from 'next/link';
import { useState } from 'react';
import { BookText, Heart, ShoppingBag, Wand2 } from 'lucide-react';
import MediaDetailsPreviewModal from '@/app/components/MediaDetailsPreviewModal';
import PublicShareButton from '@/app/components/PublicShareButton';
import type { CreatorProfilePageData } from '@/lib/creator-profile';
import { getBundleAccessLabel } from '@/lib/post-resource-bundles';
import { buildShowcaseDetailPath } from '@/lib/share';

type TabType = 'creations' | 'remixes' | 'saved';

interface CreatorContentTabsProps {
  items: CreatorProfilePageData['items'];
}

export function CreatorContentTabs({ items }: CreatorContentTabsProps) {
  const [activeTab, setActiveTab] = useState<TabType>('creations');
  const [selectedItem, setSelectedItem] = useState<CreatorProfilePageData['items'][number] | null>(null);
  const getItemSummary = (item: CreatorProfilePageData['items'][number]) => item.body || item.prompt || 'No note or prompt captured yet.';

  return (
    <div className="mt-10">
      {/* Tabs Header */}
      <div className="mb-6 flex items-center gap-6 border-b border-white/10 pb-4">
        <button
          onClick={() => setActiveTab('creations')}
          className={`flex items-center gap-2 pb-4 -mb-[17px] border-b-2 text-sm font-semibold transition-colors ${
            activeTab === 'creations' ? 'border-purple-400 text-white' : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Creations
        </button>
        <button
          onClick={() => setActiveTab('remixes')}
          className={`flex items-center gap-2 pb-4 -mb-[17px] border-b-2 text-sm font-semibold transition-colors ${
            activeTab === 'remixes' ? 'border-purple-400 text-white' : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Remixes
        </button>
        <button
          onClick={() => setActiveTab('saved')}
          className={`flex items-center gap-2 pb-4 -mb-[17px] border-b-2 text-sm font-semibold transition-colors ${
            activeTab === 'saved' ? 'border-purple-400 text-white' : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Liked & Saved
        </button>
      </div>

      {/* Tab Content */}
      <div className="mt-8">
        {activeTab === 'creations' && (
          <>
            {items.length === 0 ? (
              <div className="rounded-3xl border border-white/5 bg-zinc-900/20 p-10 text-center text-zinc-400">
                No public creations yet. The next published showcase piece will appear here.
              </div>
            ) : (
              <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
                {items.map((item) => (
                  <article
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedItem(item)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedItem(item);
                      }
                    }}
                    className="group overflow-hidden rounded-3xl border border-white/5 bg-zinc-900/30 shadow-[0_0_40px_-30px_rgba(255,255,255,0.3)] hover:border-purple-500/30 transition-all duration-300"
                  >
                    <div className="relative bg-black">
                      {item.postFormat === 'text' ? (
                        <div className="flex aspect-[4/5] items-start bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.16),transparent_38%),linear-gradient(180deg,rgba(10,10,14,1),rgba(7,7,10,1))] p-5">
                          <div className="w-full rounded-[1.5rem] border border-white/8 bg-zinc-950/80 p-5">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Tip / Note</div>
                            <p className="mt-4 line-clamp-8 whitespace-pre-wrap text-sm leading-7 text-zinc-100">
                              {getItemSummary(item)}
                            </p>
                          </div>
                        </div>
                      ) : item.mediaKind === 'video' && item.mediaUrl ? (
                        <video
                          src={item.mediaUrl}
                          muted
                          loop
                          playsInline
                          autoPlay
                          className="aspect-[4/5] w-full object-cover"
                        />
                      ) : item.mediaUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.mediaUrl} alt={item.title} className="aspect-[4/5] w-full object-cover transition-transform duration-500 group-hover:scale-105" />
                      ) : (
                        <div className="flex aspect-[4/5] items-center justify-center text-zinc-500">
                          <BookText className="h-10 w-10" />
                        </div>
                      )}
                      <div className="absolute left-4 top-4 rounded-full border border-white/10 bg-black/50 px-3 py-1 text-xs font-medium capitalize text-zinc-100 backdrop-blur">
                        {item.category}
                      </div>
                    </div>

                    <div className="space-y-4 p-5">
                      <div>
                        <h3 className="text-lg font-semibold text-white group-hover:text-purple-300 transition-colors">{item.title}</h3>
                        {item.asset ? (
                          <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-100">
                            <ShoppingBag className="h-3.5 w-3.5" />
                            {getBundleAccessLabel(item.asset.accessMode, item.asset.priceUsdCents)}
                          </div>
                        ) : null}
                        <p className="mt-2 line-clamp-3 text-sm leading-6 text-zinc-400">
                          {getItemSummary(item)}
                        </p>
                      </div>

                      <div className="flex items-center gap-3 text-sm text-zinc-500">
                        <span>{new Date(item.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                        <span>•</span>
                        <span className="flex items-center gap-1"><Heart className="w-3 h-3" /> {item.saveCount}</span>
                        <span>•</span>
                        <span className="flex items-center gap-1"><Wand2 className="w-3 h-3" /> {item.remixCount}</span>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <PublicShareButton
                          generationId={item.id}
                          title={item.title}
                          description={item.body || item.prompt}
                          sourceSurface="creator-profile"
                          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
                        />
                        <Link
                          href={buildShowcaseDetailPath(item.id)}
                          onClick={(event) => event.stopPropagation()}
                          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
                        >
                          Open page
                        </Link>
                        {item.asset ? (
                          <Link
                            href={`${buildShowcaseDetailPath(item.id)}#resources`}
                            onClick={(event) => event.stopPropagation()}
                            className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/40 hover:bg-emerald-500/15"
                          >
                            View resource
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}

        {activeTab === 'remixes' && (
          <div className="rounded-3xl border border-white/5 bg-zinc-900/20 p-10 text-center text-zinc-400">
            No remixes available to display yet.
          </div>
        )}

        {activeTab === 'saved' && (
          <div className="rounded-3xl border border-white/5 bg-zinc-900/20 p-10 text-center text-zinc-400">
            Saved items are private or not available.
          </div>
        )}
      </div>

      <MediaDetailsPreviewModal
        isOpen={Boolean(selectedItem)}
        onClose={() => setSelectedItem(null)}
        mediaType={
          selectedItem
            ? selectedItem.postFormat === 'text'
              ? 'text'
              : selectedItem.mediaKind === 'video'
                ? 'video'
                : 'image'
            : 'image'
        }
        src={selectedItem?.mediaUrl ?? null}
        alt={selectedItem?.title ?? 'Creator creation preview'}
        title={selectedItem?.title ?? 'Creator creation'}
        prompt={selectedItem?.prompt ?? ''}
        body={selectedItem?.body ?? ''}
        creator={selectedItem?.creator}
        actions={selectedItem ? (
          <>
            <PublicShareButton
              generationId={selectedItem.id}
              title={selectedItem.title}
              description={selectedItem.body || selectedItem.prompt}
              sourceSurface="creator-profile"
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
            />
            <Link
              href={buildShowcaseDetailPath(selectedItem.id)}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
            >
              Open page
            </Link>
            {selectedItem.asset ? (
              <Link
                href={`${buildShowcaseDetailPath(selectedItem.id)}#resources`}
                className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/40 hover:bg-emerald-500/15"
              >
                View resource
              </Link>
            ) : null}
          </>
        ) : null}
      />
    </div>
  );
}
