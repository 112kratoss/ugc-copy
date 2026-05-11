import Link from 'next/link';
import { headers } from 'next/headers';
import { ArrowRight, ShoppingBag } from 'lucide-react';

import MarketplaceBrowser from '@/app/marketplace/MarketplaceBrowser';
import {
  getMarketplaceResourceList,
} from '@/lib/post-resource-bundles-server';
import {
  normalizeMarketplaceResourceFilter,
  normalizeMarketplaceResourceKindFilter,
  normalizeMarketplaceResourceSort,
} from '@/lib/post-resource-bundles';
import { slugifySourceTool } from '@/lib/source-tools';

interface MarketplacePageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function getParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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
  const tool = slugifySourceTool(getParam(resolvedSearchParams.tool)) ?? '';
  const q = (getParam(resolvedSearchParams.q) ?? '').trim().slice(0, 80);
  const headerStore = await headers();
  const countryCode = headerStore.get('x-vercel-ip-country');
  const assetPage = await getMarketplaceResourceList({
    filter,
    resource,
    tool,
    q,
    sort,
    limit: 24,
    offset: 0,
    countryCode,
  });
  const initialPage = {
    items: assetPage.items ?? [],
    pageInfo: assetPage.pageInfo ?? {
      hasMore: false,
      nextOffset: null,
      offset: 0,
      limit: 24,
    },
  };

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

        <MarketplaceBrowser
          initialPage={initialPage}
          initialFilters={{
            access: filter,
            resource,
            tool,
            sort,
            q,
          }}
        />
      </div>
    </div>
  );
}
