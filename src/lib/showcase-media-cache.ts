/**
 * Public Showcase objects are versioned, but they are also user-generated
 * content that may need to be revoked after a moderation decision. Keep the
 * browser and Next image-cache window short enough that a deleted Storage
 * object cannot remain usable from a year-long client cache.
 *
 * Private generation inputs and paid recipe files use their own policies.
 */
export const SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL = '300';
export const SHOWCASE_PUBLIC_MEDIA_MINIMUM_CACHE_TTL_SECONDS = 300;
