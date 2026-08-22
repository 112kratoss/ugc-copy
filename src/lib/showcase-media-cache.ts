/**
 * Public Showcase objects are user-generated content that may have to be
 * revoked after a moderation decision. CDN copies are purged on delete;
 * already-served browser caches cannot be. This TTL is therefore a bound on how
 * long a viewer who already loaded a post can keep replaying it after a
 * takedown — it is not a freshness setting.
 *
 * One day, per open decision #5 of
 * `docs/archive/scaling-audit-2026-08-08.md`. The
 * previous value was 300s, a far more conservative answer to the same
 * question: at five minutes the CDN revalidated constantly and returning
 * visitors re-downloaded posters and clips they already held. A day cuts that
 * churn 288× while keeping the takedown window short enough to defend.
 *
 * One value covers originals and derivatives alike, because every public path
 * in this bucket is written once and never overwritten — publish keys on post
 * id and media index, edits mint a fresh uuid segment, generation publishes
 * carry a source-version hash, and previews and renditions carry a content
 * hash. A long TTL here cannot serve bytes that changed underneath it.
 *
 * Storage's SDK builds the header itself as `max-age=<seconds>`, so this is a
 * seconds count and not a directive string. `stale-while-revalidate` is not
 * expressible through it; the `max-age` half is what removes the churn.
 *
 * Private generation inputs and paid recipe files use their own policies.
 */
export const SHOWCASE_PUBLIC_MEDIA_CACHE_TTL_SECONDS = 86400;
export const SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL = String(SHOWCASE_PUBLIC_MEDIA_CACHE_TTL_SECONDS);
export const SHOWCASE_PUBLIC_MEDIA_MINIMUM_CACHE_TTL_SECONDS = SHOWCASE_PUBLIC_MEDIA_CACHE_TTL_SECONDS;
