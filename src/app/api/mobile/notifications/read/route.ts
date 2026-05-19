import { NextRequest, NextResponse } from 'next/server';

import { createUserClient } from '@/lib/server-helpers';

export const runtime = 'nodejs';

function normalizeIds(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
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

    const ids = normalizeIds((await request.json()).ids);
    if (ids.length === 0) {
      return NextResponse.json({ error: 'Missing notification IDs.' }, { status: 400 });
    }

    const { error } = await supabase
      .from('mobile_notifications')
      .update({ is_read: true })
      .eq('user_id', user.id)
      .in('id', ids);

    if (error) {
      return NextResponse.json({ error: 'Failed to mark notifications read.' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Mobile notifications read failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
