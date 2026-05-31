import { NextRequest, NextResponse } from 'next/server';

import { getShowcaseFeedItemById } from '@/lib/showcase-feed';
import { createUserClient } from '@/lib/server-helpers';

type RouteContext = {
  params: Promise<{ postId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { postId } = await context.params;
    let viewerUserId: string | null = null;

    if (request.headers.get('Authorization')) {
      const supabase = createUserClient(request);
      const {
        data: { user },
      } = await supabase.auth.getUser();
      viewerUserId = user?.id ?? null;
    }

    const item = await getShowcaseFeedItemById({
      postId,
      viewerUserId,
      countryCode: request.headers.get('x-vercel-ip-country'),
    });

    if (!item) {
      return NextResponse.json({ error: 'Post not found.' }, { status: 404 });
    }

    return NextResponse.json({ success: true, item });
  } catch (error) {
    console.error('Showcase post detail error:', error);
    return NextResponse.json({ error: 'Failed to fetch showcase post.' }, { status: 500 });
  }
}
