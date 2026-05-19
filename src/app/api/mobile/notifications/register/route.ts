import { NextRequest, NextResponse } from 'next/server';

import {
  MobileNotificationError,
  ensureMobileNotificationPreferences,
  normalizeMobilePushTokenPayload,
} from '@/lib/mobile-notifications';
import { createUserClient } from '@/lib/server-helpers';

export const runtime = 'nodejs';

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

    const payload = normalizeMobilePushTokenPayload(await request.json());
    const { error } = await supabase
      .from('mobile_push_tokens')
      .upsert({
        user_id: user.id,
        expo_push_token: payload.expoPushToken,
        platform: payload.platform,
        device_id: payload.deviceId,
        app_version: payload.appVersion,
        is_active: true,
        disabled_at: null,
        last_seen_at: new Date().toISOString(),
      }, { onConflict: 'user_id,expo_push_token' });

    if (error) {
      throw new MobileNotificationError('Failed to register mobile push token.', 500);
    }

    await ensureMobileNotificationPreferences(supabase, user.id);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof MobileNotificationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error('Mobile push token registration failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
