import { NextRequest, NextResponse } from 'next/server';

import { MobileCommerceError, restoreMobileEntitlements } from '@/lib/mobile-commerce';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

export const runtime = 'nodejs';

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

    return NextResponse.json(await restoreMobileEntitlements(adminSupabase, user.id));
  } catch (error) {
    if (error instanceof MobileCommerceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error('Mobile commerce restore failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
