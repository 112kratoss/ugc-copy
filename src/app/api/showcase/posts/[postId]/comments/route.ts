import { NextRequest } from 'next/server';
import { createPostCommentRouteResponse, getPostCommentsRouteResponse, type PostCommentsRouteContext } from '@/lib/post-comments-route-adapter-service';

export async function GET(request: NextRequest, context: PostCommentsRouteContext) {
  return getPostCommentsRouteResponse({ request, context });
}

export async function POST(request: NextRequest, context: PostCommentsRouteContext) {
  return createPostCommentRouteResponse({ request, context });
}
