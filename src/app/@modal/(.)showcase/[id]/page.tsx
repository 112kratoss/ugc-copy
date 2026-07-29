/**
 * Intercepts post links from routes on the root layout: signed-out `/`,
 * `/feed`, `/marketplace`, `/creators/*`, `/profile`, `/creations`.
 * Signed-in `/` is served from `/home` and is covered by
 * `src/app/home/@modal` instead.
 */
export { default } from '@/app/showcase/[id]/InterceptedShowcaseDetail';
