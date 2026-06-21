import { NextRequest, NextResponse } from 'next/server';

import { MobileCommerceError, unlockPostResourceBundleWithCredits } from '@/lib/mobile-commerce';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type RouteContext = {
  params: Promise<{ postId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { postId } = await context.params;
    const supabase = createUserClient(request);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const adminSupabase = createServiceClient();
    return NextResponse.json(await unlockPostResourceBundleWithCredits({
      adminSupabase,
      userId: user.id,
      postId,
    }));
  } catch (error) {
    if (error instanceof MobileCommerceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error('Post resource credit unlock failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
