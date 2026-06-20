import { NextResponse } from 'next/server';

import { repairMediaPreviews } from '@/lib/media-preview-repair';
import { createServiceClient } from '@/lib/server-helpers';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const summary = await repairMediaPreviews(createServiceClient());
    return NextResponse.json({ success: true, summary });
  } catch (error) {
    console.error('Media preview repair cron failed:', error);
    return NextResponse.json({ error: 'Failed to repair media previews.' }, { status: 500 });
  }
}
