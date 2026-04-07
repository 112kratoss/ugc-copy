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
    const { data: post, error: restoreError } = await adminSupabase
      .from('posts')
      .update({
        archived_at: null,
        archived_by_user_id: null,
      })
      .eq('id', postId)
      .eq('user_id', user.id)
      .not('archived_at', 'is', null)
      .select('id')
      .maybeSingle();

    if (restoreError) {
      console.error('Failed to restore post:', restoreError);
      return NextResponse.json({ error: 'Failed to restore post.' }, { status: 500 });
    }

    if (!post) {
      return NextResponse.json({ error: 'Post not found.' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      restored: true,
    });
  } catch (error) {
    console.error('Failed to restore owner post:', error);
    return NextResponse.json({ error: 'Failed to restore post.' }, { status: 500 });
  }
}
