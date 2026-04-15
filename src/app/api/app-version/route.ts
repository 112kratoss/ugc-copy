import { NextResponse } from 'next/server';

export async function GET() {
  const buildId = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.VERCEL_DEPLOYMENT_ID ?? 'dev';

  return NextResponse.json(
    { buildId },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    }
  );
}
