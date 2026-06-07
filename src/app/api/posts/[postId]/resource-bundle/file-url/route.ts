import { NextRequest, NextResponse } from 'next/server';

import { getPostResourceBundleDetailByPostId } from '@/lib/post-resource-bundles-server';
import { getUploadsBucketPath, isUploadsStoragePath } from '@/lib/image-elements';
import { getStoredMediaLocation } from '@/lib/media-urls';
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
  } = await supabase.auth.getUser();

  const body = (await request.json()) as { storagePath?: unknown };
  const requestedPath = typeof body.storagePath === 'string' ? body.storagePath.trim().replace(/^\/+/, '') : '';
  if (!requestedPath) {
    return NextResponse.json({ error: 'Missing resource file path.' }, { status: 400 });
  }

  const detail = await getPostResourceBundleDetailByPostId(postId, {
    viewerUserId: user?.id ?? null,
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

  const storedLocation = getStoredMediaLocation(requestedPath);
  const isUploadReference = isUploadsStoragePath(requestedPath);
  const bucket = isUploadReference ? 'uploads' : storedLocation?.bucket ?? RESOURCE_FILES_BUCKET;
  const filePath = isUploadReference
    ? getUploadsBucketPath(requestedPath)
    : storedLocation?.filePath ?? requestedPath;
  const { data, error } = await adminSupabase.storage
    .from(bucket)
    .createSignedUrl(filePath, 600, {
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
