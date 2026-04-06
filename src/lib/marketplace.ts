import type { ShowcaseAssetType } from '@/lib/showcase';

export type MarketplaceAssetStatus = 'draft' | 'active' | 'unlisted' | 'deleted';
export type MarketplaceSort = 'recent' | 'top-sales';
export type MarketplaceCheckoutCurrency = 'INR' | 'USD';

export interface MarketplacePriceQuote {
  currency: MarketplaceCheckoutCurrency;
  amountSubunits: number;
  formatted: string;
  note: string | null;
}

export const MARKETPLACE_ASSET_TYPES: ShowcaseAssetType[] = ['workflow', 'prompt_pack', 'guide'];
export const MARKETPLACE_SORT_OPTIONS: MarketplaceSort[] = ['recent', 'top-sales'];

export function isMarketplaceAssetType(value: string | null | undefined): value is ShowcaseAssetType {
  return value === 'workflow' || value === 'prompt_pack' || value === 'guide';
}

export function isMarketplaceAssetStatus(value: string | null | undefined): value is MarketplaceAssetStatus {
  return value === 'draft' || value === 'active' || value === 'unlisted' || value === 'deleted';
}

export function normalizeMarketplaceAssetType(
  value: string | null | undefined
): ShowcaseAssetType | 'all' {
  if (isMarketplaceAssetType(value)) {
    return value;
  }

  return 'all';
}

export function normalizeMarketplaceSort(value: string | null | undefined): MarketplaceSort {
  return value === 'top-sales' ? 'top-sales' : 'recent';
}

export function getMarketplaceAssetTypeLabel(type: ShowcaseAssetType): string {
  switch (type) {
    case 'prompt_pack':
      return 'Prompt pack';
    case 'guide':
      return 'Guide';
    default:
      return 'Workflow';
  }
}

export function formatUsdCents(amountUsdCents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountUsdCents / 100);
}
