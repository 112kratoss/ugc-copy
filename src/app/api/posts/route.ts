import { createPostsRouteHandlers } from '@/lib/posts-route-adapter-service';

export const runtime = 'nodejs';
// Publishing returns as soon as the post exists, then transcodes the video in
// an after() callback. The budget covers that post-response work, not the
// request the user waits on.
export const maxDuration = 300;

export const { GET, POST } = createPostsRouteHandlers();
