import { NextRequest } from 'next/server';
import { deletePostCommentRouteResponse, updatePostCommentRouteResponse, type PostCommentRouteContext } from '@/lib/post-comments-route-adapter-service';

export async function DELETE(request: NextRequest, context: PostCommentRouteContext) {
  return deletePostCommentRouteResponse({ request, context });
}

// One change to a comment: its words, the reader's like or dislike, the creator's heart or pin.
export async function PATCH(request: NextRequest, context: PostCommentRouteContext) {
  return updatePostCommentRouteResponse({ request, context });
}
