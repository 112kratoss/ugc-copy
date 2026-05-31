import { NextResponse } from 'next/server';

import { processPendingMobilePushReceipts } from '@/lib/mobile-notifications';
import { createServiceClient } from '@/lib/server-helpers';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const summary = await processPendingMobilePushReceipts(createServiceClient());
    return NextResponse.json({ success: true, summary });
  } catch (error) {
    console.error('Mobile push receipts cron failed:', error);
    return NextResponse.json({ error: 'Failed to process mobile push receipts.' }, { status: 500 });
  }
}
