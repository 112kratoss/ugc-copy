import { NextRequest, NextResponse } from 'next/server';

import { createUserClient } from '@/lib/server-helpers';

export const runtime = 'nodejs';

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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

    const body = asRecord(await request.json().catch(() => ({})));
    const expoPushToken = optionalString(body.expoPushToken ?? body.token);
    const deviceId = optionalString(body.deviceId);
    let query = supabase
      .from('mobile_push_tokens')
      .update({
        is_active: false,
        disabled_at: new Date().toISOString(),
      })
      .eq('user_id', user.id);

    query = expoPushToken ? query.eq('expo_push_token', expoPushToken) : query;
    query = !expoPushToken && deviceId ? query.eq('device_id', deviceId) : query;

    const { error } = await query;
    if (error) {
      return NextResponse.json({ error: 'Failed to unregister mobile push token.' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Mobile push token unregister failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
