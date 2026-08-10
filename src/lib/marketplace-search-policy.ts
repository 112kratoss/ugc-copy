export const MARKETPLACE_SEARCH_MIN_LENGTH = 3;
export const MARKETPLACE_SEARCH_MAX_LENGTH = 80;

export function normalizeMarketplaceSearchQuery(value: string | null | undefined) {
  return (value ?? '').trim().slice(0, MARKETPLACE_SEARCH_MAX_LENGTH);
}

export function isValidMarketplaceSearchQuery(value: string) {
  return value.length === 0 || value.length >= MARKETPLACE_SEARCH_MIN_LENGTH;
}
