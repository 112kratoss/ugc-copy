import { NextRequest, NextResponse } from 'next/server';

import { MobileCommerceError, unlockMarketplaceAssetWithCredits } from '@/lib/mobile-commerce';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type RouteContext = {
  params: Promise<{ assetId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { assetId } = await context.params;
    const supabase = createUserClient(request);
    const adminSupabase = createServiceClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return NextResponse.json(await unlockMarketplaceAssetWithCredits({
      adminSupabase,
      userId: user.id,
      assetId,
    }));
  } catch (error) {
    if (error instanceof MobileCommerceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error('Marketplace credit unlock failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
