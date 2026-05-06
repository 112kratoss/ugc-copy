import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, createUserClient } from '@/lib/server-helpers';

const REPORT_REASONS = new Set([
  'spam',
  'stolen_content',
  'misleading_unlock',
  'unsafe_content',
  'payment_issue',
  'other',
]);

type RouteContext = {
  params: Promise<{ postId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const { postId } = await context.params;
  const supabase = createUserClient(request);
  const adminSupabase = createServiceClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json()) as {
    reason?: unknown;
    details?: unknown;
    bundleId?: unknown;
  };
  const reason = typeof body.reason === 'string' && REPORT_REASONS.has(body.reason) ? body.reason : null;
  if (!reason) {
    return NextResponse.json({ error: 'Choose a valid report reason.' }, { status: 400 });
  }

  const details = typeof body.details === 'string' && body.details.trim() ? body.details.trim().slice(0, 1000) : null;
  const bundleId = typeof body.bundleId === 'string' && body.bundleId.trim() ? body.bundleId.trim() : null;

  const { data: post, error: postError } = await adminSupabase
    .from('posts')
    .select('id')
    .eq('id', postId)
    .is('archived_at', null)
    .maybeSingle();

  if (postError || !post) {
    return NextResponse.json({ error: 'Post not found.' }, { status: 404 });
  }

  if (bundleId) {
    const { data: bundle, error: bundleError } = await adminSupabase
      .from('post_resource_bundles')
      .select('id')
      .eq('id', bundleId)
      .eq('post_id', postId)
      .maybeSingle();

    if (bundleError) {
      console.error('Failed to validate reported unlock:', bundleError);
      return NextResponse.json({ error: 'Failed to validate unlock report.' }, { status: 500 });
    }

    if (!bundle) {
      return NextResponse.json({ error: 'That unlock does not belong to this post.' }, { status: 400 });
    }
  }

  const { error } = await adminSupabase.from('post_reports').insert({
    post_id: postId,
    bundle_id: bundleId,
    reporter_user_id: user.id,
    reason,
    details,
  });

  if (error) {
    console.error('Failed to create post report:', error);
    return NextResponse.json({ error: 'Failed to submit report.' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
  });
}
