import { NextResponse } from 'next/server';

export async function GET() {
  const buildId =
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.VERCEL_DEPLOYMENT_ID?.trim() ||
    process.env.VERCEL_URL?.trim() ||
    'dev';

  return NextResponse.json(
    { buildId },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    }
  );
}
