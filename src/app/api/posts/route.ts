import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import {
  deriveTitleFromBody,
  isMissingPostsSchemaError,
  isMissingPostResourceBundlesSchemaError,
} from '@/lib/posts-server';
import { getOwnerPostList, type OwnerPostVisibilityFilter } from '@/lib/owner-posts';
import { savePostResourceBundle } from '@/lib/post-resource-bundles-server';
import {
  isPostResourceBundleAccessMode,
  type PostResourceBundleInput,
} from '@/lib/post-resource-bundles';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import {
  isShowcaseItemCategory,
  type ShowcaseItemCategory,
  type ShowcasePostFormat,
  type ShowcaseVisibility,
} from '@/lib/showcase';

const SHOWCASE_MEDIA_BUCKET = 'showcase_media';
const UPLOADS_BUCKET = 'uploads';
const BODY_MAX_LENGTH = 2000;
const MISSING_POSTS_SCHEMA_ERROR =
  'Posts are not enabled on the connected Supabase project yet. Apply the posts migrations and try again.';
const MISSING_POST_RESOURCE_BUNDLES_SCHEMA_ERROR =
  'Posts are working, but resource bundles are not enabled on the connected Supabase project yet. Apply supabase/migrations/20260406200000_post_resource_bundles.sql and try again.';

function sanitizeFileStem(fileName: string): string {
  const stem = path.basename(fileName, path.extname(fileName)).toLowerCase();
  const sanitized = stem.replace(/[^a-z0-9-_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return sanitized || 'upload';
}

function inferExtension(fileName: string, mimeType: string): string {
  const extension = path.extname(fileName).replace('.', '').toLowerCase();
  if (extension) {
    return extension;
  }

  if (mimeType.startsWith('image/')) {
    return mimeType.split('/')[1] || 'jpg';
  }

  if (mimeType.startsWith('video/')) {
    return mimeType.split('/')[1] || 'mp4';
  }

  return 'bin';
}

function normalizeStoragePath(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().replace(/^\/+/, '');
  return trimmed || null;
}

function parseUploadedMediaLocation(params: {
  storagePath: FormDataEntryValue | null;
  userId: string;
  originalName: FormDataEntryValue | null;
  contentType: FormDataEntryValue | null;
}): {
  location: {
    filePath: string;
    originalName: string;
    contentType: string;
  } | null;
  error: string | null;
} {
  const normalizedStoragePath = normalizeStoragePath(params.storagePath);
  if (!normalizedStoragePath) {
    return {
      location: null,
      error: null,
    };
  }

  if (!normalizedStoragePath.startsWith(`${UPLOADS_BUCKET}/`)) {
    return {
      location: null,
      error: 'Uploaded media must come from the uploads bucket.',
    };
  }

  const filePath = normalizedStoragePath.slice(`${UPLOADS_BUCKET}/`.length);
  if (!filePath.startsWith(`${params.userId}/`)) {
    return {
      location: null,
      error: 'Uploaded media must belong to the authenticated user.',
    };
  }

  const originalName =
    typeof params.originalName === 'string' && params.originalName.trim()
      ? params.originalName.trim()
      : path.basename(filePath);
  const contentType =
    typeof params.contentType === 'string' && params.contentType.trim()
      ? params.contentType.trim()
      : '';

  return {
    location: {
      filePath,
      originalName,
      contentType,
    },
    error: null,
  };
}

function inferCategoryFromMimeType(mimeType: string): ShowcaseItemCategory | null {
  if (mimeType.startsWith('image/')) {
    return 'image';
  }

  if (mimeType.startsWith('video/')) {
    return 'video';
  }

  return null;
}

function resolveCategory(
  requestedCategory: string | null,
  mimeType: string
): ShowcaseItemCategory | null {
  const inferred = inferCategoryFromMimeType(mimeType);
  if (!inferred) {
    return null;
  }

  if (!requestedCategory || !isShowcaseItemCategory(requestedCategory) || requestedCategory === 'text') {
    return inferred;
  }

  if (inferred === 'image') {
    return requestedCategory === 'image' || requestedCategory === 'ugc-ad'
      ? requestedCategory
      : null;
  }

  return requestedCategory === 'video' || requestedCategory === 'motion' || requestedCategory === 'ugc-ad'
    ? requestedCategory
    : null;
}

function normalizeVisibility(value: string | null): ShowcaseVisibility {
  if (value === 'private' || value === 'unlisted') {
    return value;
  }

  return 'public';
}

function normalizePostFormat(value: string | null): ShowcasePostFormat {
  if (value === 'text' || value === 'mixed') {
    return value;
  }

  return 'media';
}

function normalizeText(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeBody(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.replace(/\r\n/g, '\n').trim();
  return normalized ? normalized : null;
}

function resolveTitle(title: string | null, body: string | null, postFormat: ShowcasePostFormat): string | null {
  if (title) {
    return title;
  }

  if (postFormat === 'text' || postFormat === 'mixed') {
    return deriveTitleFromBody(body);
  }

  return null;
}

function parseResourceBundle(
  value: FormDataEntryValue | null
): { bundle: PostResourceBundleInput | null; error: string | null } {
  if (typeof value !== 'string' || !value.trim()) {
    return {
      bundle: null,
      error: null,
    };
  }

  try {
    const parsed = JSON.parse(value) as PostResourceBundleInput;
    const accessMode = parsed?.accessMode;
    if (!isPostResourceBundleAccessMode(accessMode)) {
      return {
        bundle: null,
        error: 'Choose whether the attached resources should be free or paid.',
      };
    }

    if (accessMode === 'paid') {
      const priceUsdCents = Number.isFinite(parsed.priceUsdCents)
        ? Math.round(parsed.priceUsdCents ?? 0)
        : 0;

      if (priceUsdCents < 100) {
        return {
          bundle: null,
          error: 'Paid resources must be priced at $1.00 or above.',
        };
      }
    }

    return {
      bundle: parsed,
      error: null,
    };
  } catch {
    return {
      bundle: null,
      error: 'The attached resource bundle could not be parsed.',
    };
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createUserClient(request);
    const adminSupabase = createServiceClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await request.formData();
    const media = formData.get('media');
    const file = media instanceof File && media.size > 0 ? media : null;
    const { location: uploadedMedia, error: uploadedMediaError } = parseUploadedMediaLocation({
      storagePath: formData.get('mediaStoragePath'),
      userId: user.id,
      originalName: formData.get('mediaOriginalName'),
      contentType: formData.get('mediaContentType'),
    });
    const body = normalizeBody(formData.get('body'));
    const postFormat = normalizePostFormat(
      typeof formData.get('postFormat') === 'string' ? String(formData.get('postFormat')) : null
    );

    if (uploadedMediaError) {
      return NextResponse.json({ error: uploadedMediaError }, { status: 400 });
    }

    if (!body && !file && !uploadedMedia) {
      return NextResponse.json({ error: 'Add a note or upload media to publish a post.' }, { status: 400 });
    }

    if (body && body.length > BODY_MAX_LENGTH) {
      return NextResponse.json({ error: `Text posts are limited to ${BODY_MAX_LENGTH} characters.` }, { status: 400 });
    }

    if (postFormat === 'text' && !body) {
      return NextResponse.json({ error: 'Text posts need a note or tip to publish.' }, { status: 400 });
    }

    if (postFormat === 'mixed' && !body) {
      return NextResponse.json({ error: 'Media + note posts need both media and written context.' }, { status: 400 });
    }

    if ((postFormat === 'media' || postFormat === 'mixed') && !file && !uploadedMedia) {
      return NextResponse.json({ error: 'Upload an image or video for this post type.' }, { status: 400 });
    }

    if (file?.type.startsWith('audio/')) {
      return NextResponse.json({ error: 'Audio uploads are not supported in the community feed yet.' }, { status: 400 });
    }

    if (uploadedMedia?.contentType.startsWith('audio/')) {
      return NextResponse.json({ error: 'Audio uploads are not supported in the community feed yet.' }, { status: 400 });
    }

    const mediaMimeType = file?.type ?? uploadedMedia?.contentType ?? '';

    const category =
      postFormat === 'text'
        ? 'text'
        : resolveCategory(
            typeof formData.get('category') === 'string' ? String(formData.get('category')) : null,
            mediaMimeType
          );

    if (!category) {
      return NextResponse.json({ error: 'Please upload an image or video and choose a matching category.' }, { status: 400 });
    }

    const requestedVisibility = normalizeVisibility(
      typeof formData.get('visibility') === 'string' ? String(formData.get('visibility')) : null
    );
    const title = resolveTitle(normalizeText(formData.get('title')), body, postFormat);
    const description = normalizeText(formData.get('description'));
    const sourceTool = file || uploadedMedia ? normalizeText(formData.get('sourceTool')) : null;
    const sourceKind = postFormat === 'text' ? 'manual' : 'external';
    const { bundle: resourceBundle, error: resourceBundleError } = parseResourceBundle(formData.get('resourceBundle'));

    if (resourceBundleError) {
      return NextResponse.json({ error: resourceBundleError }, { status: 400 });
    }

    const visibility = resourceBundle?.accessMode && resourceBundle.accessMode !== 'none'
      ? 'public'
      : requestedVisibility;

    const postId = randomUUID();
    let storagePath: string | null = null;

    if (file) {
      const extension = inferExtension(file.name, file.type);
      storagePath = `posts/${postId}/${sanitizeFileStem(file.name)}.${extension}`;

      const { error: uploadError } = await adminSupabase.storage
        .from(SHOWCASE_MEDIA_BUCKET)
        .upload(storagePath, file, {
          cacheControl: '3600',
          contentType: file.type || undefined,
          upsert: false,
        });

      if (uploadError) {
        console.error('Failed to upload external post media:', uploadError);
        return NextResponse.json({ error: 'Failed to upload media.' }, { status: 500 });
      }
    } else if (uploadedMedia) {
      const downloadedMedia = await adminSupabase.storage.from(UPLOADS_BUCKET).download(uploadedMedia.filePath);
      if (downloadedMedia.error || !downloadedMedia.data) {
        console.error('Failed to download uploaded post media:', downloadedMedia.error);
        return NextResponse.json({ error: 'Failed to load uploaded media.' }, { status: 500 });
      }

      const extension = inferExtension(uploadedMedia.originalName, uploadedMedia.contentType);
      storagePath = `posts/${postId}/${sanitizeFileStem(uploadedMedia.originalName)}.${extension}`;
      const showcaseUpload = await adminSupabase.storage
        .from(SHOWCASE_MEDIA_BUCKET)
        .upload(storagePath, downloadedMedia.data, {
          cacheControl: '3600',
          contentType: downloadedMedia.data.type || uploadedMedia.contentType || undefined,
          upsert: false,
        });

      if (showcaseUpload.error) {
        console.error('Failed to copy uploaded post media into showcase storage:', showcaseUpload.error);
        return NextResponse.json({ error: 'Failed to prepare uploaded media.' }, { status: 500 });
      }

      const cleanupUpload = await adminSupabase.storage.from(UPLOADS_BUCKET).remove([uploadedMedia.filePath]);
      if (cleanupUpload.error) {
        console.warn('Failed to remove temporary uploaded post media:', cleanupUpload.error);
      }
    }

    const { data: post, error: insertError } = await supabase
      .from('posts')
      .insert({
        id: postId,
        user_id: user.id,
        visibility,
        category,
        title,
        description,
        prompt: null,
        body,
        post_format: postFormat,
        source_kind: sourceKind,
        source_tool: sourceTool,
        showcase_asset_path: storagePath,
        output_url: null,
      })
      .select('id, visibility')
      .single();

    if (insertError || !post) {
      console.error('Failed to create external post:', insertError);
      if (storagePath) {
        await adminSupabase.storage.from(SHOWCASE_MEDIA_BUCKET).remove([storagePath]);
      }
      if (isMissingPostsSchemaError(insertError)) {
        return NextResponse.json({ error: MISSING_POSTS_SCHEMA_ERROR }, { status: 500 });
      }
      return NextResponse.json({ error: 'Failed to create post.' }, { status: 500 });
    }

    try {
      await savePostResourceBundle({
        supabase,
        postId: post.id as string,
        ownerUserId: user.id,
        postTitle: title,
        postVisibility: post.visibility as ShowcaseVisibility,
        bundle: resourceBundle,
      });
    } catch (bundleError) {
      console.error('Failed to save post resource bundle:', bundleError);
      if (isMissingPostResourceBundlesSchemaError(bundleError)) {
        return NextResponse.json({ error: MISSING_POST_RESOURCE_BUNDLES_SCHEMA_ERROR }, { status: 500 });
      }
      return NextResponse.json({ error: 'Post was created, but the attached resources could not be saved.' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      postId: post.id,
      visibility: post.visibility,
      showcasePath: post.visibility === 'private' ? null : `/showcase/${post.id}`,
      ownerPath: `/post/${post.id}/edit`,
      resourceBundlePath:
        post.visibility === 'private'
          ? `/post/${post.id}/edit#resources`
          : `/showcase/${post.id}#resources`,
    });
  } catch (error) {
    console.error('External post creation failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

function normalizeOwnerPostVisibilityFilter(value: string | null): OwnerPostVisibilityFilter {
  if (value === 'public' || value === 'unlisted' || value === 'private' || value === 'archived') {
    return value;
  }

  return 'all';
}

export async function GET(request: NextRequest) {
  try {
    const supabase = createUserClient(request);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const scope = request.nextUrl.searchParams.get('scope');
    if (scope !== 'owner') {
      return NextResponse.json({ error: 'Unsupported posts scope.' }, { status: 400 });
    }

    const visibility = normalizeOwnerPostVisibilityFilter(request.nextUrl.searchParams.get('visibility'));
    const includeArchived =
      request.nextUrl.searchParams.get('includeArchived') === 'true' || visibility === 'archived';

    const posts = await getOwnerPostList(user.id, {
      includeArchived,
      visibility,
    });

    return NextResponse.json({
      success: true,
      posts,
    });
  } catch (error) {
    console.error('Failed to fetch owner posts:', error);
    return NextResponse.json({ error: 'Failed to fetch posts.' }, { status: 500 });
  }
}
