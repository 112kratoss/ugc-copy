import { NextRequest, NextResponse } from 'next/server';

import {
  BackendRateLimitError,
  MOBILE_COMMERCE_RESTORE_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { MobileCommerceError, restoreMobileEntitlements } from '@/lib/mobile-commerce';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

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

    const adminSupabase = createServiceClient();
    try {
      await enforceBackendRateLimit(adminSupabase, {
        ...MOBILE_COMMERCE_RESTORE_RATE_LIMIT,
        key: user.id,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return createBackendRateLimitResponse(error);
      }

      console.error('Mobile commerce restore rate limit check failed:', error);
      return NextResponse.json({ error: 'Failed to check commerce restore limits.' }, { status: 500 });
    }

    return NextResponse.json(await restoreMobileEntitlements(adminSupabase, user.id));
  } catch (error) {
    if (error instanceof MobileCommerceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error('Mobile commerce restore failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
