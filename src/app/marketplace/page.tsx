import Link from 'next/link';
import { headers } from 'next/headers';
import { ArrowRight, Layers3, ShoppingBag, SlidersHorizontal } from 'lucide-react';

import TextPostPreviewCard from '@/app/components/TextPostPreviewCard';
import {
  getMarketplaceResourceList,
} from '@/lib/post-resource-bundles-server';
import {
  describePostResourceKinds,
  getBundleAccessLabel,
  getPostResourceKindLabel,
  normalizeMarketplaceResourceFilter,
  normalizeMarketplaceResourceKindFilter,
  normalizeMarketplaceResourceSort,
} from '@/lib/post-resource-bundles';
import { buildShowcaseDetailPath } from '@/lib/share';
import { CURATED_SOURCE_TOOLS, getSourceToolLabel, slugifySourceTool } from '@/lib/source-tools';

interface MarketplacePageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function getParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function formatMarketplaceDate(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));
}

export default async function MarketplacePage({ searchParams }: MarketplacePageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const filter = normalizeMarketplaceResourceFilter(
    getParam(resolvedSearchParams.access)
  );
  const resource = normalizeMarketplaceResourceKindFilter(getParam(resolvedSearchParams.resource));
  const sort = normalizeMarketplaceResourceSort(
    getParam(resolvedSearchParams.sort)
  );
  const tool = slugifySourceTool(getParam(resolvedSearchParams.tool));
  const headerStore = await headers();
  const countryCode = headerStore.get('x-vercel-ip-country');
  const assetPage = await getMarketplaceResourceList({
    filter,
    resource,
    tool,
    sort,
    limit: 24,
    offset: 0,
    countryCode,
  });

  const buildHref = (overrides: {
    access?: typeof filter;
    resource?: typeof resource;
    tool?: string;
    sort?: typeof sort;
  }) => {
    const params = new URLSearchParams();
    const nextAccess = overrides.access ?? filter;
    const nextResource = overrides.resource ?? resource;
    const nextTool = overrides.tool ?? tool;
    const nextSort = overrides.sort ?? sort;

    if (nextAccess !== 'all') {
      params.set('access', nextAccess);
    }
    if (nextResource !== 'all') {
      params.set('resource', nextResource);
    }
    if (nextTool) {
      params.set('tool', nextTool);
    }
    params.set('sort', nextSort);

    return `/marketplace?${params.toString()}`;
  };

  const buildCurrentMarketplacePath = () => {
    const params = new URLSearchParams();

    if (filter !== 'all') {
      params.set('access', filter);
    }
    if (resource !== 'all') {
      params.set('resource', resource);
    }
    if (tool) {
      params.set('tool', tool);
    }
    if (sort !== 'recent') {
      params.set('sort', sort);
    }

    return params.size > 0 ? `/marketplace?${params.toString()}` : '/marketplace';
  };

  const marketplaceReturnPath = buildCurrentMarketplacePath();

  const filterLinks = [
    { label: 'All', href: buildHref({ access: 'all' }), active: filter === 'all' },
    { label: 'Free', href: buildHref({ access: 'free' }), active: filter === 'free' },
    { label: 'Paid', href: buildHref({ access: 'paid' }), active: filter === 'paid' },
  ];

  const resourceLinks = [
    { label: 'All kinds', value: 'all' as const },
    { label: 'Prompt', value: 'prompt' as const },
    { label: 'Workflow', value: 'workflow' as const },
    { label: 'Files', value: 'files' as const },
    { label: 'Notes', value: 'notes' as const },
    { label: 'Remix', value: 'remix' as const },
  ].map((item) => ({
    ...item,
    href: buildHref({ resource: item.value }),
    active: resource === item.value,
  }));

  const toolLinks = [
    { label: 'All tools', value: '' },
    ...CURATED_SOURCE_TOOLS.map((sourceTool) => ({
      label: sourceTool.label,
      value: sourceTool.slug,
    })),
  ].map((item) => ({
    ...item,
    href: buildHref({ tool: item.value }),
    active: item.value ? tool === item.value : !tool,
  }));

  const sortLinks = [
    { label: 'Recent', href: buildHref({ sort: 'recent' }), active: sort === 'recent' },
    { label: 'Top sales', href: buildHref({ sort: 'top-sales' }), active: sort === 'top-sales' },
  ];

  const activeFilterLabels = [
    filter !== 'all' ? (filter === 'free' ? 'Free' : 'Paid') : null,
    resource !== 'all' ? getPostResourceKindLabel(resource) : null,
    tool ? getSourceToolLabel(tool) : null,
  ].filter(Boolean);

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute left-[-8%] top-[-12%] h-[36%] w-[28%] rounded-full bg-emerald-500/10 blur-[140px]" />
        <div className="absolute bottom-[-14%] right-[-8%] h-[34%] w-[26%] rounded-full bg-sky-500/10 blur-[160px]" />
      </div>

      <div className="studio-shell relative z-10 py-12 sm:py-16">
        <div className="rounded-[34px] border border-white/8 bg-[linear-gradient(135deg,rgba(5,8,12,0.98),rgba(16,18,25,0.92))] p-6 shadow-[0_28px_90px_rgba(0,0,0,0.5)] sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-100">
                <ShoppingBag className="h-3.5 w-3.5" />
                Unlocks
              </div>
              <h1 className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                Buy the reusable parts behind community posts
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-zinc-300 sm:text-base">
                Browse free and paid unlocks made from public community posts. Check the post first, then open the prompt, workflow, files, notes, or remix access after purchase or free login unlock.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/post/new"
                className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
              >
                Share a post
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/marketplace/sell"
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08]"
              >
                Seller Dashboard
              </Link>
            </div>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-5 rounded-[28px] border border-white/8 bg-zinc-950/70 p-5 backdrop-blur-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Buyer filters
              </div>
              {activeFilterLabels.length > 0 ? (
                <p className="mt-1 text-sm text-zinc-400">Showing {activeFilterLabels.join(' + ')}</p>
              ) : (
                <p className="mt-1 text-sm text-zinc-400">All public unlocks from community posts.</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {sortLinks.map((link) => (
                <Link
                  key={link.label}
                  href={link.href}
                  className={`rounded-full px-4 py-2 text-sm transition ${
                    link.active
                      ? 'border border-sky-300/30 bg-sky-400/15 text-sky-50'
                      : 'border border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] hover:text-white'
                  }`}
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </div>
          <div className="grid gap-4 lg:grid-cols-[0.75fr_1fr_1fr]">
            {[
              { label: 'Access', links: filterLinks },
              { label: 'Kind', links: resourceLinks },
              { label: 'Tool', links: toolLinks },
            ].map((group) => (
              <div key={group.label}>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
                  {group.label}
                </div>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {group.links.map((link) => (
                    <Link
                      key={link.label}
                      href={link.href}
                      className={`shrink-0 rounded-full px-3 py-1.5 text-sm transition ${
                        link.active
                          ? 'border border-emerald-300/30 bg-emerald-400/15 text-emerald-50'
                          : 'border border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] hover:text-white'
                      }`}
                    >
                      {link.label}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {assetPage.items.length === 0 ? (
          <div className="mt-10 rounded-[30px] border border-white/8 bg-zinc-950/70 p-8 text-center shadow-[0_24px_70px_rgba(0,0,0,0.35)] backdrop-blur-sm">
            <Layers3 className="mx-auto h-10 w-10 text-zinc-500" />
            <h2 className="mt-4 text-2xl font-semibold text-white">No unlocks yet</h2>
            <p className="mt-3 mx-auto max-w-xl text-sm leading-7 text-zinc-400">
              Unlocks are created from public community posts. Publish the post first, then attach a free or paid unlock so buyers can open the reusable process on the same page.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/post/new"
                className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
              >
                Share a post
              </Link>
            </div>
          </div>
        ) : (
          <div className="mt-10 columns-1 gap-6 space-y-6 md:columns-2 xl:columns-3">
            {assetPage.items.map((asset) => (
              <Link
                key={asset.id}
                href={buildShowcaseDetailPath(asset.postId, {
                  from: 'unlocks',
                  returnTo: marketplaceReturnPath,
                  section: 'resources',
                })}
                className="group mb-6 block break-inside-avoid overflow-hidden rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(18,18,22,0.98),rgba(10,10,14,0.98))] shadow-[0_24px_70px_rgba(0,0,0,0.35)] transition hover:border-white/14 hover:shadow-[0_28px_90px_rgba(0,0,0,0.45)]"
              >
                <div className="relative overflow-hidden border-b border-white/8 bg-black/60">
                  {asset.post?.mediaUrl ? (
                    asset.post.mediaKind === 'image' ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={asset.post.mediaUrl}
                        alt={asset.post.title}
                        className="h-64 w-full object-cover transition duration-500 group-hover:scale-[1.02]"
                      />
                    ) : (
                      <video
                        src={asset.post.mediaUrl}
                        muted
                        playsInline
                        loop
                        autoPlay
                        className="h-64 w-full object-cover transition duration-500 group-hover:scale-[1.02]"
                      />
                    )
                  ) : asset.post?.postFormat === 'text' ? (
                    <TextPostPreviewCard
                      title={asset.post.title}
                      summary={asset.post.body || asset.summary || asset.previewText || describePostResourceKinds(asset.resourceKinds)}
                      sourceLabel={asset.post.sourceTool || asset.post.sourceKind}
                      dateLabel={formatMarketplaceDate(asset.updatedAt)}
                      unlockLabel={getBundleAccessLabel(asset.accessMode, asset.priceUsdCents)}
                      resourceKinds={asset.resourceKinds}
                      className="rounded-none border-0 shadow-none"
                    />
                  ) : (
                    <div className="flex h-64 items-center justify-center bg-[radial-gradient(circle_at_top,rgba(52,211,153,0.25),transparent_45%),linear-gradient(180deg,rgba(24,24,30,1),rgba(10,10,12,1))] text-zinc-500">
                      <ShoppingBag className="h-9 w-9" />
                    </div>
                  )}

                  {asset.post?.postFormat !== 'text' ? (
                    <div className="absolute left-4 top-4 inline-flex items-center gap-2 rounded-full border border-black/20 bg-black/55 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-white backdrop-blur-sm">
                      {getBundleAccessLabel(asset.accessMode, asset.priceUsdCents)}
                    </div>
                  ) : null}

                  {asset.post?.postFormat !== 'text' && asset.post?.sourceTool ? (
                    <div className="absolute right-4 top-4 rounded-full border border-black/20 bg-black/55 px-3 py-1 text-[11px] font-medium text-zinc-100 backdrop-blur-sm">
                      Made with {asset.post.sourceTool}
                    </div>
                  ) : null}
                </div>

                <div className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">
                        {asset.seller.username ? `@${asset.seller.username}` : asset.seller.name}
                      </div>
                      <h2 className="mt-2 text-xl font-semibold text-white">{asset.title}</h2>
                    </div>
                    <div className="rounded-full border border-emerald-300/20 bg-emerald-400/10 px-3 py-1.5 text-sm font-semibold text-emerald-50">
                      {asset.priceQuote.formatted}
                    </div>
                  </div>

                  <p className="mt-3 line-clamp-3 text-sm leading-6 text-zinc-300">
                    {asset.summary || asset.previewText || describePostResourceKinds(asset.resourceKinds)}
                  </p>

                  <div className="mt-4 flex flex-wrap gap-2">
                    {(asset.resourceKinds ?? []).map((kind) => (
                      <div
                        key={`${asset.id}-${kind}`}
                        className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-zinc-200"
                      >
                        {getPostResourceKindLabel(kind)}
                      </div>
                    ))}
                  </div>

                  {asset.lockedPreview.attachmentPreviews.length > 0 ? (
                    <div className="mt-3 text-xs text-zinc-500">
                      {asset.lockedPreview.attachmentPreviews.length} attachment{asset.lockedPreview.attachmentPreviews.length === 1 ? '' : 's'} included
                    </div>
                  ) : null}

                  <div className="mt-5 flex items-center justify-between text-xs text-zinc-500">
                    <span>{asset.salesCount} unlock{asset.salesCount === 1 ? '' : 's'}</span>
                    <span className="font-semibold text-zinc-200">View unlock</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
