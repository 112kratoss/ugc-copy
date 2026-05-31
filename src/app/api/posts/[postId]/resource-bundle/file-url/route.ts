import { NextRequest, NextResponse } from 'next/server';

import { getPostResourceBundleDetailByPostId } from '@/lib/post-resource-bundles-server';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

const RESOURCE_FILES_BUCKET = 'post_resource_files';

type RouteContext = {
  params: Promise<{ postId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const { postId } = await context.params;
  const supabase = createUserClient(request);
  const adminSupabase = createServiceClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json()) as { storagePath?: unknown };
  const requestedPath = typeof body.storagePath === 'string' ? body.storagePath.trim().replace(/^\/+/, '') : '';
  if (!requestedPath) {
    return NextResponse.json({ error: 'Missing resource file path.' }, { status: 400 });
  }

  const detail = await getPostResourceBundleDetailByPostId(postId, {
    viewerUserId: user.id,
    countryCode: request.headers.get('x-vercel-ip-country'),
  });

  if (!detail || !detail.viewerCanAccess || !detail.resources) {
    return NextResponse.json({ error: 'Unlock this resource before downloading files.' }, { status: 403 });
  }

  const attachment = detail.resources.attachments.find((item) => item.kind === 'file' && item.storagePath === requestedPath);
  const resourceItem = detail.resources.items?.find((item) => item.storagePath === requestedPath) ?? null;
  if (!attachment && !resourceItem) {
    return NextResponse.json({ error: 'Resource file not found on this unlock.' }, { status: 404 });
  }

  const { data, error } = await adminSupabase.storage
    .from(RESOURCE_FILES_BUCKET)
    .createSignedUrl(requestedPath, 600, {
      download: attachment?.label ?? resourceItem?.title ?? 'Resource file',
    });

  if (error || !data?.signedUrl) {
    console.error('Failed to sign resource file:', error);
    return NextResponse.json({ error: 'Failed to prepare resource file.' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    signedUrl: data.signedUrl,
  });
}
