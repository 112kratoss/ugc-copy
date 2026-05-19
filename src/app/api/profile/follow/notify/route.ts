import { NextRequest, NextResponse } from 'next/server';

import { notifyCreatorFollowed } from '@/lib/mobile-notifications';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

export const runtime = 'nodejs';

function readFollowingId(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? typeof (value as { followingId?: unknown }).followingId === 'string'
      ? (value as { followingId: string }).followingId.trim()
      : ''
    : '';
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createUserClient(request);
    const adminSupabase = createServiceClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const followingId = readFollowingId(await request.json().catch(() => null));
    if (!followingId || followingId === user.id) {
      return NextResponse.json({ error: 'Missing creator profile.' }, { status: 400 });
    }

    const { data: followRecord, error: followError } = await adminSupabase
      .from('follows')
      .select('follower_id')
      .eq('follower_id', user.id)
      .eq('following_id', followingId)
      .maybeSingle();

    if (followError) {
      return NextResponse.json({ error: 'Failed to verify follow state.' }, { status: 500 });
    }

    if (!followRecord) {
      return NextResponse.json({ error: 'Follow not found.' }, { status: 404 });
    }

    const { data: followerProfile } = await adminSupabase
      .from('profiles')
      .select('username')
      .eq('id', user.id)
      .maybeSingle();

    await notifyCreatorFollowed(adminSupabase, {
      followerUserId: user.id,
      followingUserId: followingId,
      followerUsername: typeof followerProfile?.username === 'string' ? followerProfile.username : null,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Creator follow notification failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
