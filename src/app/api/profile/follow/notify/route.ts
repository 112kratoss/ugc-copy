import { NextRequest, NextResponse } from 'next/server';

import {
  BackendRateLimitError,
  CREATOR_FOLLOW_NOTIFICATION_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
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

    const adminSupabase = createServiceClient();
    try {
      await enforceBackendRateLimit(adminSupabase, {
        ...CREATOR_FOLLOW_NOTIFICATION_RATE_LIMIT,
        key: user.id,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return createBackendRateLimitResponse(error);
      }

      console.error('Creator follow notification rate limit check failed:', error);
      return NextResponse.json({ error: 'Failed to check follow notification limits.' }, { status: 500 });
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
