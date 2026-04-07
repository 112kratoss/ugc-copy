import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import {
  deriveTitleFromBody,
  isMissingPostResourceBundlesSchemaError,
  isMissingPostsSchemaError,
} from '@/lib/posts-server';
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
    const body = normalizeBody(formData.get('body'));
    const postFormat = normalizePostFormat(
      typeof formData.get('postFormat') === 'string' ? String(formData.get('postFormat')) : null
    );

    if (!body && !file) {
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

    if ((postFormat === 'media' || postFormat === 'mixed') && !file) {
      return NextResponse.json({ error: 'Upload an image or video for this post type.' }, { status: 400 });
    }

    if (file?.type.startsWith('audio/')) {
      return NextResponse.json({ error: 'Audio uploads are not supported in the community feed yet.' }, { status: 400 });
    }

    const category =
      postFormat === 'text'
        ? 'text'
        : resolveCategory(
            typeof formData.get('category') === 'string' ? String(formData.get('category')) : null,
            file?.type ?? ''
          );

    if (!category) {
      return NextResponse.json({ error: 'Please upload an image or video and choose a matching category.' }, { status: 400 });
    }

    const requestedVisibility = normalizeVisibility(
      typeof formData.get('visibility') === 'string' ? String(formData.get('visibility')) : null
    );
    const title = resolveTitle(normalizeText(formData.get('title')), body, postFormat);
    const description = normalizeText(formData.get('description'));
    const sourceTool = file ? normalizeText(formData.get('sourceTool')) : null;
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
      showcasePath: `/showcase/${post.id}`,
      resourceBundlePath: `/showcase/${post.id}#resources`,
    });
  } catch (error) {
    console.error('External post creation failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
