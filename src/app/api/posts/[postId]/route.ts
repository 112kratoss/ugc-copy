import { createOwnerPostRouteHandlers } from '@/lib/owner-post-route-adapter-service';

export const runtime = 'nodejs';
// Editing returns as soon as the post is saved, then transcodes swapped-in
// video in an after() callback. The budget covers that post-response work, not
// the request the user waits on.
export const maxDuration = 300;

export const { DELETE, GET, PATCH, PUT } = createOwnerPostRouteHandlers();
