import { NextRequest, NextResponse } from 'next/server';

import {
  getPostResourceBundleDetailByPostId,
  savePostResourceBundle,
} from '@/lib/post-resource-bundles-server';
import type { PostResourceBundleInput } from '@/lib/post-resource-bundles';
import { createUserClient } from '@/lib/server-helpers';

type RouteContext = {
  params: Promise<{ postId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const { postId } = await context.params;
  const supabase = createUserClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const detail = await getPostResourceBundleDetailByPostId(postId, {
    viewerUserId: user?.id ?? null,
    countryCode: request.headers.get('x-vercel-ip-country'),
  });

  if (!detail) {
    return NextResponse.json({ error: 'Resource bundle not found.' }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    bundle: detail,
  });
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { postId } = await context.params;
  const supabase = createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json() as {
    resourceBundle?: PostResourceBundleInput | null;
  };

  const { data: post, error: postError } = await supabase
    .from('posts')
    .select('id, user_id, title, visibility')
    .eq('id', postId)
    .maybeSingle();

  if (postError || !post || post.user_id !== user.id) {
    return NextResponse.json({ error: 'Post not found.' }, { status: 404 });
  }

  const savedBundle = await savePostResourceBundle({
    supabase,
    postId,
    ownerUserId: user.id,
    postTitle: typeof post.title === 'string' ? post.title : null,
    postVisibility: post.visibility as 'public' | 'unlisted' | 'private',
    bundle: body.resourceBundle ?? null,
  });

  return NextResponse.json({
    success: true,
    bundle: savedBundle,
  });
}
