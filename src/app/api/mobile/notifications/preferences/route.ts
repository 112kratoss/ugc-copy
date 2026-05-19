import { NextRequest, NextResponse } from 'next/server';

import {
  MobileNotificationError,
  ensureMobileNotificationPreferences,
  normalizeMobileNotificationPreferencesPatch,
  toMobileNotificationPreferences,
} from '@/lib/mobile-notifications';
import { createUserClient } from '@/lib/server-helpers';

export const runtime = 'nodejs';

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

    const preferences = await ensureMobileNotificationPreferences(supabase, user.id);
    return NextResponse.json({ success: true, preferences });
  } catch (error) {
    if (error instanceof MobileNotificationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error('Mobile notification preferences load failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const supabase = createUserClient(request);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const patch = normalizeMobileNotificationPreferencesPatch(await request.json());
    const { data, error } = await supabase
      .from('mobile_notification_preferences')
      .upsert({
        user_id: user.id,
        ...(patch.pushEnabled !== undefined ? { push_enabled: patch.pushEnabled } : {}),
        ...(patch.generationEnabled !== undefined ? { generation_enabled: patch.generationEnabled } : {}),
        ...(patch.commerceEnabled !== undefined ? { commerce_enabled: patch.commerceEnabled } : {}),
        ...(patch.socialEnabled !== undefined ? { social_enabled: patch.socialEnabled } : {}),
      }, { onConflict: 'user_id' })
      .select('push_enabled, generation_enabled, commerce_enabled, social_enabled')
      .single();

    if (error) {
      throw new MobileNotificationError('Failed to update mobile notification preferences.', 500);
    }

    return NextResponse.json({
      success: true,
      preferences: toMobileNotificationPreferences(data),
    });
  } catch (error) {
    if (error instanceof MobileNotificationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error('Mobile notification preferences update failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
