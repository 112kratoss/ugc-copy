/**
 * Public Showcase objects are written to versioned paths and never mutated in
 * place, so browsers and the storage CDN can safely retain them for one year.
 * Private generation inputs and paid recipe files intentionally do not use
 * this policy.
 */
export const SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL = '31536000';
export const SHOWCASE_PUBLIC_MEDIA_MINIMUM_CACHE_TTL_SECONDS = 31_536_000;
