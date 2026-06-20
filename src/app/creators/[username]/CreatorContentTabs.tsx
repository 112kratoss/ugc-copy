'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  ArrowRight,
  BookText,
  CalendarDays,
  Heart,
  ImageIcon,
  Layers3,
  ShoppingBag,
  Video,
  Wand2,
} from 'lucide-react';
import MediaDetailsPreviewModal from '@/app/components/MediaDetailsPreviewModal';
import PublicShareButton from '@/app/components/PublicShareButton';
import TextPostPreviewCard from '@/app/components/TextPostPreviewCard';
import type { CreatorProfilePageData } from '@/lib/creator-profile';
import {
  describePostResourceKinds,
  getBundleAccessLabel,
  getPostResourceKindLabel,
  isPostResourceKind,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';
import { formatBundleAccessLabel } from '@/lib/marketplace-trust';
import { buildShowcaseDetailPath } from '@/lib/share';

type TabType = 'collection' | 'unlocks' | 'tools';
type CreatorItem = CreatorProfilePageData['items'][number];

interface CreatorContentTabsProps {
  items: CreatorProfilePageData['items'];
  tools?: CreatorProfilePageData['stats']['toolsUsed'];
  profilePath?: string;
  pageInfo?: CreatorProfilePageData['pageInfo'];
}

const tabHashes: Record<TabType, string> = {
  collection: '#creator-collection',
  unlocks: '#creator-unlocks',
  tools: '#creator-tools',
};

const categoryLabels: Record<CreatorItem['category'], string> = {
  image: 'Image',
  video: 'Video',
  text: 'Tip',
};

function getTabFromHash(hash: string): TabType {
  if (hash === tabHashes.unlocks) {
    return 'unlocks';
  }

  if (hash === tabHashes.tools) {
    return 'tools';
  }

  return 'collection';
}

function getItemSourceLabel(item: CreatorItem) {
  return item.sourceTool || item.model || null;
}

function getItemResourceKinds(item: CreatorItem): PostResourceKind[] {
  return (item.asset?.resourceKinds ?? []).filter(isPostResourceKind);
}

function getCategoryLabel(category: CreatorItem['category']) {
  return categoryLabels[category] ?? 'Creation';
}

function getAssetAccessLabel(asset: NonNullable<CreatorItem['asset']>): string {
  if (asset.priceQuote) {
    return formatBundleAccessLabel({
      accessMode: asset.accessMode,
      priceQuote: asset.priceQuote,
    });
  }

  return getBundleAccessLabel(asset.accessMode, asset.priceUsdCents);
}

function getItemSummary(item: CreatorItem) {
  const publicText = item.body?.trim() || item.prompt?.trim();
  if (publicText) {
    return publicText;
  }

  const tool = getItemSourceLabel(item);
  const resourceKinds = getItemResourceKinds(item);
  const unlock = item.asset
    ? resourceKinds.length > 0
      ? describePostResourceKinds(resourceKinds)
      : `${getAssetAccessLabel(item.asset)} attached.`
    : 'Public portfolio piece.';

  return [
    tool ? `Made with ${tool}` : null,
    `${getCategoryLabel(item.category)} creation`,
    unlock,
  ].filter(Boolean).join(' / ');
}

function formatPortfolioDate(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

function getTabTitle(tab: TabType) {
  switch (tab) {
    case 'unlocks':
      return 'Unlocks';
    case 'tools':
      return 'Tools used';
    default:
      return 'Collection';
  }
}

function getTabDescription(tab: TabType) {
  switch (tab) {
    case 'unlocks':
      return 'Reusable prompts, workflows, files, notes, and remix access attached to this portfolio.';
    case 'tools':
      return 'Source tools this creator tags across public portfolio pieces.';
    default:
      return 'A browsable archive of public creations, tips, references, and experiments.';
  }
}

export function CreatorContentTabs({ items, tools = [], profilePath = '', pageInfo }: CreatorContentTabsProps) {
  const pathname = usePathname();
  const unlockItems = items.filter((item) => item.asset);
  const [activeTab, setActiveTab] = useState<TabType>(() =>
    typeof window !== 'undefined' ? getTabFromHash(window.location.hash) : 'collection'
  );
  const [selectedItem, setSelectedItem] = useState<CreatorItem | null>(null);
  const creatorReturnPath = `${pathname}${tabHashes[activeTab]}`;
  const visibleItems = activeTab === 'unlocks' ? unlockItems : items;
  const tabs = [
    { id: 'collection' as const, label: 'Collection', count: items.length },
    { id: 'unlocks' as const, label: 'Unlocks', count: unlockItems.length },
    { id: 'tools' as const, label: 'Tools', count: tools.length },
  ];
  const buildCreatorDetailPath = (id: string, section?: string) =>
    buildShowcaseDetailPath(id, {
      from: 'creator',
      returnTo: creatorReturnPath,
      section,
    });

  useEffect(() => {
    const handleHashChange = () => {
      setActiveTab(getTabFromHash(window.location.hash));
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const handleTabSelect = (tab: TabType) => {
    setActiveTab(tab);

    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `${pathname}${tabHashes[tab]}`);
    }
  };

  return (
    <section id="creator-collection" className="mt-10 scroll-mt-24">
      <div id="creator-unlocks" className="scroll-mt-24" />
      <div id="creator-tools" className="scroll-mt-24" />

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-xs font-semibold text-zinc-500">Portfolio archive</div>
          <h2 className="mt-2 text-2xl font-semibold text-white">{getTabTitle(activeTab)}</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">{getTabDescription(activeTab)}</p>
        </div>

        <div className="flex gap-2 overflow-x-auto rounded-full border border-white/8 bg-white/[0.03] p-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleTabSelect(tab.id)}
              className={`inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition ${
                activeTab === tab.id
                  ? 'bg-white text-black'
                  : 'text-zinc-400 hover:bg-white/[0.06] hover:text-white'
              }`}
            >
              {tab.label}
              <span className={`rounded-full px-2 py-0.5 text-xs ${
                activeTab === tab.id ? 'bg-black/10 text-black' : 'bg-white/[0.06] text-zinc-400'
              }`}>
                {tab.count}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div>
        {(activeTab === 'collection' || activeTab === 'unlocks') && (
          <>
            {visibleItems.length === 0 ? (
              <div className="rounded-[28px] border border-white/8 bg-zinc-950/60 p-8 text-center text-zinc-400 sm:p-10">
                <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-300">
                  {activeTab === 'unlocks' ? <ShoppingBag className="h-5 w-5" /> : <Layers3 className="h-5 w-5" />}
                </div>
                <h3 className="mt-4 text-lg font-semibold text-white">
                  {activeTab === 'unlocks' ? 'No portfolio unlocks yet' : 'No public collection pieces yet'}
                </h3>
                <p className="mx-auto mt-2 max-w-xl text-sm leading-6">
                  {activeTab === 'unlocks'
                    ? 'Unlocks will appear here when this creator attaches reusable prompts, workflows, files, notes, or remix access to public posts.'
                    : 'Published creations, tips, and references will collect here as this creator builds their public portfolio.'}
                </p>
              </div>
            ) : (
              <>
                <div className="columns-1 gap-5 space-y-5 sm:columns-2 xl:columns-3">
                  {visibleItems.map((item) => {
                  const resourceKinds = getItemResourceKinds(item);
                  const source = getItemSourceLabel(item);
                  const isTextPost = item.postFormat === 'text';

                  return (
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
                      className="group mb-5 break-inside-avoid overflow-hidden rounded-[26px] border border-white/8 bg-zinc-950/72 shadow-[0_20px_70px_-56px_rgba(255,255,255,0.45)] transition hover:border-violet-300/25"
                    >
                      <div className="relative bg-black">
                        {isTextPost ? (
                          <TextPostPreviewCard
                            title={item.title}
                            summary={getItemSummary(item)}
                            sourceLabel={source}
                            dateLabel={formatPortfolioDate(item.createdAt)}
                            saveCount={item.saveCount}
                            remixCount={item.remixCount}
                            unlockLabel={item.asset ? getAssetAccessLabel(item.asset) : null}
                            resourceKinds={resourceKinds}
                            className="rounded-none border-0 border-b border-white/8 shadow-none"
                          />
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
                          <div className="flex aspect-[4/5] items-center justify-center bg-zinc-950 text-zinc-500">
                            <ImageIcon className="h-10 w-10" />
                          </div>
                        )}

                        {!isTextPost ? (
                          <div className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full border border-black/20 bg-black/60 px-3 py-1 text-xs font-medium text-zinc-100 backdrop-blur">
                            {item.mediaKind === 'video' ? <Video className="h-3.5 w-3.5" /> : <BookText className="h-3.5 w-3.5" />}
                            {getCategoryLabel(item.category)}
                          </div>
                        ) : null}

                        {!isTextPost && source ? (
                          <div className="absolute right-3 top-3 max-w-[70%] truncate rounded-full border border-black/20 bg-black/60 px-3 py-1 text-xs font-medium text-zinc-100 backdrop-blur">
                            {source}
                          </div>
                        ) : null}
                      </div>

                      <div className={`space-y-4 p-5 ${isTextPost ? 'pt-4' : ''}`}>
                        {!isTextPost ? (
                        <div>
                          <div className="flex items-start justify-between gap-3">
                            <h3 className="min-w-0 text-lg font-semibold text-white transition group-hover:text-violet-200">
                              {item.title}
                            </h3>
                            <span className="shrink-0 text-xs text-zinc-500">
                              {formatPortfolioDate(item.createdAt)}
                            </span>
                          </div>

                          <div className="mt-3 flex flex-wrap gap-2">
                            {item.asset ? (
                              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-100">
                                <ShoppingBag className="h-3.5 w-3.5" />
                                {getAssetAccessLabel(item.asset)}
                              </span>
                            ) : null}
                            {resourceKinds.map((kind) => (
                              <span
                                key={`${item.id}-${kind}`}
                                className="rounded-full border border-white/10 bg-white/[0.035] px-2.5 py-1 text-[11px] font-medium text-zinc-300"
                              >
                                {getPostResourceKindLabel(kind)}
                              </span>
                            ))}
                          </div>

                          <p className="mt-3 line-clamp-3 text-sm leading-6 text-zinc-400">
                            {getItemSummary(item)}
                          </p>
                        </div>
                        ) : null}

                        {!isTextPost ? (
                        <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-500">
                          <span className="inline-flex items-center gap-1.5">
                            <CalendarDays className="h-3.5 w-3.5" />
                            {formatPortfolioDate(item.createdAt)}
                          </span>
                          <span className="inline-flex items-center gap-1.5" aria-label={`${item.saveCount} saves`}>
                            <Heart className="h-3.5 w-3.5" aria-hidden="true" />
                            <span aria-hidden="true">{item.saveCount}</span>
                          </span>
                          <span className="inline-flex items-center gap-1.5" aria-label={`${item.remixCount} remixes`}>
                            <Wand2 className="h-3.5 w-3.5" aria-hidden="true" />
                            <span aria-hidden="true">{item.remixCount}</span>
                          </span>
                        </div>
                        ) : null}

                        <div className="flex flex-wrap gap-2">
                          <PublicShareButton
                            generationId={item.id}
                            title={item.title}
                            description={item.body || item.prompt}
                            sourceSurface="creator-profile"
                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
                          />
                          <Link
                            href={buildCreatorDetailPath(item.id)}
                            onClick={(event) => event.stopPropagation()}
                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
                          >
                            Open page
                          </Link>
                          {item.asset ? (
                            <Link
                              href={buildCreatorDetailPath(item.id, 'resources')}
                              onClick={(event) => event.stopPropagation()}
                              className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/40 hover:bg-emerald-500/15"
                            >
                              View unlock
                              <ArrowRight className="h-4 w-4" />
                            </Link>
                          ) : null}
                        </div>
                      </div>
                    </article>
                  );
                  })}
                </div>
                {activeTab === 'collection' && pageInfo?.hasMore && pageInfo.nextLimit ? (
                  <div className="mt-8 flex justify-center">
                    <Link
                      href={`${profilePath}?limit=${pageInfo.nextLimit}${tabHashes.collection}`}
                      className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-5 py-2.5 text-sm font-semibold text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08]"
                    >
                      Load more collection
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  </div>
                ) : null}
              </>
            )}
          </>
        )}

        {activeTab === 'tools' && (
          tools.length === 0 ? (
            <div className="rounded-[28px] border border-white/8 bg-zinc-950/60 p-8 text-center text-zinc-400 sm:p-10">
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-300">
                <Layers3 className="h-5 w-5" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-white">No tagged source tools yet</h3>
              <p className="mx-auto mt-2 max-w-xl text-sm leading-6">
                Tools will appear here when this creator tags where portfolio pieces were made.
              </p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {tools.map((tool) => (
                <Link
                  key={tool.slug}
                  href={`/showcase?tool=${encodeURIComponent(tool.slug)}`}
                  className="rounded-[24px] border border-white/8 bg-zinc-950/70 p-5 transition hover:border-sky-400/30 hover:bg-zinc-900/70"
                >
                  <div className="inline-flex items-center gap-2 rounded-full border border-sky-300/15 bg-sky-400/10 px-3 py-1 text-xs font-semibold text-sky-100">
                    <Layers3 className="h-3.5 w-3.5" />
                    Source tool
                  </div>
                  <div className="mt-4 text-xl font-semibold text-white">{tool.label}</div>
                  <div className="mt-2 text-sm text-zinc-400">{tool.count} portfolio piece{tool.count === 1 ? '' : 's'}</div>
                </Link>
              ))}
            </div>
          )
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
              href={buildCreatorDetailPath(selectedItem.id)}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
            >
              Open page
            </Link>
            {selectedItem.asset ? (
              <Link
                href={buildCreatorDetailPath(selectedItem.id, 'resources')}
                className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/40 hover:bg-emerald-500/15"
              >
                View unlock
              </Link>
            ) : null}
          </>
        ) : null}
      />
    </section>
  );
}
