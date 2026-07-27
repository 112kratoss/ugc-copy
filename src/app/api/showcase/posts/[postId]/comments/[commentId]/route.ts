import { NextRequest } from 'next/server';
import { deletePostCommentRouteResponse, type PostCommentRouteContext } from '@/lib/post-comments-route-adapter-service';

export async function DELETE(request: NextRequest, context: PostCommentRouteContext) {
  return deletePostCommentRouteResponse({ request, context });
}
