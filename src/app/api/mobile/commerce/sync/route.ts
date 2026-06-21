import { NextRequest, NextResponse } from 'next/server';

import {
  MobileCommerceError,
  completeMobileCreditPurchase,
  completeMobileMarketplaceUnlock,
  completeMobilePostResourceUnlock,
  normalizeMobileCommercePayload,
  verifyMobilePurchase,
} from '@/lib/mobile-commerce';
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
    const payload = normalizeMobileCommercePayload(await request.json());
    const verified = await verifyMobilePurchase({
      userId: user.id,
      productId: payload.productId,
      provider: payload.provider,
      transactionId: payload.transactionId,
      receiptToken: payload.receiptToken,
    });

    if (payload.entitlement.type === 'credits') {
      return NextResponse.json(await completeMobileCreditPurchase({
        adminSupabase,
        userId: user.id,
        productId: payload.productId,
        provider: verified.provider,
        transactionId: verified.transactionId,
      }));
    }

    if (payload.entitlement.type === 'marketplace_unlock') {
      return NextResponse.json(await completeMobileMarketplaceUnlock({
        adminSupabase,
        userId: user.id,
        assetId: payload.entitlement.assetId,
        provider: verified.provider,
        transactionId: verified.transactionId,
      }));
    }

    return NextResponse.json(await completeMobilePostResourceUnlock({
      adminSupabase,
      userId: user.id,
      postId: payload.entitlement.postId,
      provider: verified.provider,
      transactionId: verified.transactionId,
    }));
  } catch (error) {
    if (error instanceof MobileCommerceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error('Mobile commerce sync failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
