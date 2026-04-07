import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type RouteContext = {
  params: Promise<{ postId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const { postId } = await context.params;
  const supabase = createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const adminSupabase = createServiceClient();
    const { data: post, error: postError } = await adminSupabase
      .from('posts')
      .update({
        archived_at: new Date().toISOString(),
        archived_by_user_id: user.id,
      })
      .eq('id', postId)
      .eq('user_id', user.id)
      .is('archived_at', null)
      .select('id, generation_id')
      .maybeSingle();

    if (postError) {
      console.error('Failed to archive post:', postError);
      return NextResponse.json({ error: 'Failed to archive post.' }, { status: 500 });
    }

    if (!post) {
      return NextResponse.json({ error: 'Post not found.' }, { status: 404 });
    }

    await adminSupabase
      .from('post_resource_bundles')
      .update({
        status: 'draft',
      })
      .eq('post_id', postId)
      .eq('owner_user_id', user.id)
      .eq('status', 'published');

    if (post.generation_id) {
      await adminSupabase
        .from('generations')
        .update({
          is_public: false,
          showcase_asset_path: null,
        })
        .eq('id', post.generation_id);
    }

    return NextResponse.json({
      success: true,
      archived: true,
    });
  } catch (error) {
    console.error('Failed to archive owner post:', error);
    return NextResponse.json({ error: 'Failed to archive post.' }, { status: 500 });
  }
}
