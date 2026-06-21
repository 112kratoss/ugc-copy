import { NextResponse } from 'next/server';

import { collectBackendHealth } from '@/lib/backend-health';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';
import { createServiceClient } from '@/lib/server-helpers';

export const runtime = 'nodejs';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const health = await collectBackendHealth(createServiceClient());
    return NextResponse.json(health, {
      status: health.status === 'degraded' ? 503 : 200,
      headers: {
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'backend_health_failed',
      error: errorMessage(error),
    }));
    return NextResponse.json(
      {
        status: 'degraded',
        error: 'Failed to collect backend health.',
      },
      {
        status: 500,
        headers: {
          'Cache-Control': 'private, no-store',
        },
      },
    );
  }
}
