import { createPostsRouteHandlers } from '@/lib/posts-route-adapter-service';

export const runtime = 'nodejs';
// Video work is queue/cron-owned (media-preview-repair) — publish defers it
// entirely on the staged path. The budget exists for the legacy multipart
// path, which still transcodes inline before responding.
export const maxDuration = 300;

export const { GET, POST } = createPostsRouteHandlers();
