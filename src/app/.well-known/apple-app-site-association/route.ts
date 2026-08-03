import { NextResponse } from 'next/server';

import { UNIVERSAL_LINK_PATHS } from '@/lib/app-links';

export const dynamic = 'force-static';

export function GET() {
  const teamId = process.env.APPLE_TEAM_ID?.trim();
  const bundleId = process.env.IOS_BUNDLE_ID?.trim() || 'com.magicbooklet.mobile';
  const appId = teamId ? `${teamId}.${bundleId}` : null;

  return NextResponse.json({
    applinks: {
      apps: [],
      details: appId ? [{ appID: appId, paths: [...UNIVERSAL_LINK_PATHS] }] : [],
    },
  }, {
    headers: {
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      'Content-Type': 'application/json',
    },
  });
}
