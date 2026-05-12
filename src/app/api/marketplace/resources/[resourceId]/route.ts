import { NextRequest, NextResponse } from 'next/server';

import {
  getPostResourceBundleDetailByPostId,
  resolvePostIdForResourceIdentifier,
} from '@/lib/post-resource-bundles-server';
import { createUserClient } from '@/lib/server-helpers';

type RouteContext = {
  params: Promise<{ resourceId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { resourceId } = await context.params;
    let viewerUserId: string | null = null;

    if (request.headers.get('Authorization')) {
      const supabase = createUserClient(request);
      const {
        data: { user },
      } = await supabase.auth.getUser();
      viewerUserId = user?.id ?? null;
    }

    const postId = await resolvePostIdForResourceIdentifier(resourceId);
    if (!postId) {
      return NextResponse.json({ error: 'Unlock not found.' }, { status: 404 });
    }

    const bundle = await getPostResourceBundleDetailByPostId(postId, {
      viewerUserId,
      countryCode: request.headers.get('x-vercel-ip-country'),
    });

    if (!bundle) {
      return NextResponse.json({ error: 'Unlock not found.' }, { status: 404 });
    }

    return NextResponse.json({ success: true, bundle });
  } catch (error) {
    console.error('Marketplace resource detail error:', error);
    return NextResponse.json({ error: 'Failed to fetch marketplace unlock.' }, { status: 500 });
  }
}
