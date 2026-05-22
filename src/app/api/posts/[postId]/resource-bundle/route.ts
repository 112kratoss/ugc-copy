import { NextRequest, NextResponse } from 'next/server';

import {
  getMarketplaceQualityErrorForPostBundle,
  getPostResourceBundleDetailByPostId,
  savePostResourceBundle,
} from '@/lib/post-resource-bundles-server';
import {
  validatePostResourceBundleInput,
  type PostResourceBundleInput,
} from '@/lib/post-resource-bundles';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

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
    .select('id, user_id, title, body, visibility, archived_at, review_status, showcase_asset_path, output_url')
    .eq('id', postId)
    .maybeSingle();

  if (postError || !post || post.user_id !== user.id) {
    return NextResponse.json({ error: 'Post not found.' }, { status: 404 });
  }

  const validationError = validatePostResourceBundleInput(body.resourceBundle ?? null, { ownerUserId: user.id });
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const marketplaceQualityError = post.visibility === 'public'
    ? await getMarketplaceQualityErrorForPostBundle({
        supabase: createServiceClient(),
        ownerUserId: user.id,
        post: {
          title: typeof post.title === 'string' ? post.title : null,
          body: typeof post.body === 'string' ? post.body : null,
          visibility: typeof post.visibility === 'string' ? post.visibility : null,
          archivedAt: typeof post.archived_at === 'string' ? post.archived_at : null,
          reviewStatus: typeof post.review_status === 'string' ? post.review_status : 'visible',
          showcaseAssetPath: typeof post.showcase_asset_path === 'string' ? post.showcase_asset_path : null,
          outputUrl: typeof post.output_url === 'string' ? post.output_url : null,
        },
        bundle: body.resourceBundle ?? null,
      })
    : null;

  if (marketplaceQualityError) {
    return NextResponse.json({ error: marketplaceQualityError }, { status: 400 });
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
