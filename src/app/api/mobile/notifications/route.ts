import { NextRequest, NextResponse } from 'next/server';

import {
  MobileNotificationError,
  toMobileNotificationRecord,
} from '@/lib/mobile-notifications';
import { createUserClient } from '@/lib/server-helpers';

export const runtime = 'nodejs';

function clampLimit(value: string | null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 30;
  }
  return Math.max(1, Math.min(80, Math.trunc(parsed)));
}

export async function GET(request: NextRequest) {
  try {
    const supabase = createUserClient(request);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const limit = clampLimit(request.nextUrl.searchParams.get('limit'));
    const before = request.nextUrl.searchParams.get('before');
    let query = supabase
      .from('mobile_notifications')
      .select('id, type, category, title, body, deep_link, object_type, object_id, event_count, is_read, created_at, updated_at')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (before) {
      query = query.lt('updated_at', before);
    }

    const [{ data, error }, unreadResult] = await Promise.all([
      query,
      supabase
        .from('mobile_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('is_read', false),
    ]);

    if (error || unreadResult.error) {
      throw new MobileNotificationError('Failed to load notifications.', 500);
    }

    return NextResponse.json({
      success: true,
      notifications: (data ?? []).map((row) => toMobileNotificationRecord(row)),
      unreadCount: unreadResult.count ?? 0,
    });
  } catch (error) {
    if (error instanceof MobileNotificationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error('Mobile notifications list failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
