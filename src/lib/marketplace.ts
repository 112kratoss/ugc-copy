import type { ShowcaseAssetType } from '@/lib/showcase';

export type MarketplaceAssetStatus = 'draft' | 'active' | 'unlisted' | 'deleted';
export type MarketplaceSort = 'recent' | 'top-sales';
type MarketplaceCheckoutCurrency = 'INR' | 'USD';

export interface MarketplacePriceQuote {
  currency: MarketplaceCheckoutCurrency;
  amountSubunits: number;
  formatted: string;
  note: string | null;
}

export function isMarketplaceAssetType(value: string | null | undefined): value is ShowcaseAssetType {
  return value === 'workflow' || value === 'prompt_pack' || value === 'guide';
}

export function isMarketplaceAssetStatus(value: string | null | undefined): value is MarketplaceAssetStatus {
  return value === 'draft' || value === 'active' || value === 'unlisted' || value === 'deleted';
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
