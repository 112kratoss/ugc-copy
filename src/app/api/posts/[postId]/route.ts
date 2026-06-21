import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { getOwnerPostDetail } from '@/lib/owner-posts';
import {
  getPostResourceKinds,
  isPostResourceBundleAccessMode,
  normalizePostResourceAttachments,
  normalizePostResourceItems,
  normalizePostResourceSections,
  validatePostResourceBundleInput,
  type PostResourceBundleInput,
  type PostResourceBundleResources,
} from '@/lib/post-resource-bundles';
import {
  getMarketplaceQualityErrorForPostBundle,
  updatePostWithResourceBundleAtomically,
} from '@/lib/post-resource-bundles-server';
import { PostSourceToolsWriteError, replacePostSourceTools } from '@/lib/post-source-tools-server';
import {
  isMissingPostResourceBundlesSchemaError,
  isMissingPostResourceItemsColumnError,
} from '@/lib/posts-server';
import {
  getMediaKindFromContentType,
  MAX_POST_MEDIA_ITEMS,
  replacePostMediaItems,
  type PostMediaPersistInput,
} from '@/lib/post-media';
import { createPostMediaPreview } from '@/lib/post-media-preview';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { listSourceToolsCatalog } from '@/lib/source-tools-server';
import {
  normalizeSourceToolInputWithCatalog,
  normalizeSourceToolSelectionsWithCatalog,
  validateSourceToolSelections,
} from '@/lib/source-tools';
import {
  isShowcaseItemCategory,
  normalizeShowcaseSourceKind,
  type RawShowcaseSourceKind,
  type ShowcaseVisibility,
} from '@/lib/showcase';

type RouteContext = {
  params: Promise<{ postId: string }>;
};

type MutablePostRow = {
  id: string;
  user_id: string;
  generation_id: string | null;
  visibility: ShowcaseVisibility;
  title: string | null;
  description: string | null;
  body: string | null;
  category: string;
  post_format: 'text' | 'media' | 'mixed';
  source_tool: string | null;
  source_tool_slug: string | null;
  source_kind: RawShowcaseSourceKind;
  archived_at: string | null;
  showcase_asset_path: string | null;
  output_url: string | null;
  review_status: 'visible' | 'flagged' | 'hidden' | null;
};

type BundleAuditRow = {
  id: string;
  access_mode: 'free' | 'paid';
  status: 'draft' | 'published';
  price_usd_cents: number;
  sales_count: number;
  earnings_usd_cents: number;
  prompt_text: string | null;
  notes_markdown: string | null;
  workflow_share_url: string | null;
  workflow_snapshot: unknown;
  attachments: unknown;
  resource_sections?: unknown;
  resource_items?: unknown;
  allow_remix: boolean;
};

type BundleStatusRow = {
  access_mode: 'none' | 'free' | 'paid';
  status: 'draft' | 'published';
};

type ExistingPostMediaRow = {
  id: string;
  storage_path: string | null;
  preview_storage_path?: string | null;
  preview_thumbhash?: string | null;
  preview_status?: 'pending' | 'processing' | 'ready' | 'failed';
  preview_attempt_count?: number;
  preview_error?: string | null;
  preview_generated_at?: string | null;
  external_url: string | null;
  media_kind: 'image' | 'video';
  content_type: string | null;
  original_name: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  sort_order: number;
};

type SubmittedEditMediaItem =
  | { source: 'existing'; row: ExistingPostMediaRow }
  | {
      source: 'uploaded';
      filePath: string;
      temporaryStoragePath: string;
      originalName: string;
      contentType: string;
      mediaKind: 'image' | 'video';
    };

const SHOWCASE_MEDIA_BUCKET = 'showcase_media';
const UPLOADS_BUCKET = 'uploads';
type ServiceClient = ReturnType<typeof createServiceClient>;

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

  return mimeType.startsWith('video/') ? 'mp4' : 'jpg';
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeBody(value: unknown): string | null {
  return typeof value === 'string' && value.replace(/\r\n/g, '\n').trim()
    ? value.replace(/\r\n/g, '\n').trim()
    : null;
}

function normalizeVisibility(value: unknown): ShowcaseVisibility | null {
  if (value === 'public' || value === 'unlisted' || value === 'private') {
    return value;
  }

  return null;
}

function parseBundleInput(value: unknown, ownerUserId: string): { bundle: PostResourceBundleInput | null; error: string | null } {
  if (value == null) {
    return {
      bundle: null,
      error: null,
    };
  }

  if (typeof value !== 'object') {
    return {
      bundle: null,
      error: 'Invalid unlock payload.',
    };
  }

  const bundle = value as PostResourceBundleInput;
  if (!isPostResourceBundleAccessMode(bundle.accessMode)) {
    return {
      bundle: null,
      error: 'Choose whether the unlock should be free or paid.',
    };
  }

  const validationError = validatePostResourceBundleInput(bundle, { ownerUserId });
  if (validationError) {
    return {
      bundle: null,
      error: validationError,
    };
  }

  return {
    bundle,
    error: null,
  };
}

async function loadOwnedPost(
  adminSupabase: ServiceClient,
  postId: string,
  userId: string
): Promise<MutablePostRow | null> {
  const { data, error } = await adminSupabase
    .from('posts')
    .select(
      'id, user_id, generation_id, visibility, title, description, body, category, post_format, source_tool, source_tool_slug, source_kind, archived_at, showcase_asset_path, output_url, review_status'
    )
    .eq('id', postId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as MutablePostRow | null) ?? null;
}

async function loadOwnedBundleStatus(
  adminSupabase: ServiceClient,
  postId: string,
  userId: string
): Promise<BundleStatusRow | null> {
  const { data, error } = await adminSupabase
    .from('post_resource_bundles')
    .select('access_mode, status')
    .eq('post_id', postId)
    .eq('owner_user_id', userId)
    .maybeSingle();

  if (error && !isMissingPostResourceBundlesSchemaError(error)) {
    throw error;
  }

  return (data as BundleStatusRow | null) ?? null;
}

async function loadOwnedPostMedia(
  adminSupabase: ServiceClient,
  postId: string
): Promise<ExistingPostMediaRow[]> {
  const previewResult = await adminSupabase
    .from('post_media')
    .select('id, storage_path, preview_storage_path, preview_thumbhash, preview_status, preview_attempt_count, preview_error, preview_generated_at, external_url, media_kind, content_type, original_name, width, height, duration_seconds, sort_order')
    .eq('post_id', postId)
    .order('sort_order', { ascending: true });
  let data = previewResult.data as ExistingPostMediaRow[] | null;
  let error = previewResult.error;

  if (
    error
    && (error.code === '42703' || error.code === 'PGRST204')
    && /preview_(storage_path|thumbhash|status|attempt_count|error|generated_at)/.test(error.message)
  ) {
    const legacyResult = await adminSupabase
      .from('post_media')
      .select('id, storage_path, external_url, media_kind, content_type, original_name, width, height, duration_seconds, sort_order')
      .eq('post_id', postId)
      .order('sort_order', { ascending: true });
    data = legacyResult.data as ExistingPostMediaRow[] | null;
    error = legacyResult.error;
  }

  if (error) {
    throw error;
  }

  return data ?? [];
}

async function parseSubmittedEditMediaItems(params: {
  adminSupabase: ServiceClient;
  value: unknown;
  postId: string;
  userId: string;
}): Promise<{ items: SubmittedEditMediaItem[] | null; error: string | null }> {
  if (params.value === undefined) {
    return { items: null, error: null };
  }

  if (!Array.isArray(params.value)) {
    return { items: null, error: 'Post media metadata is invalid.' };
  }

  if (params.value.length === 0) {
    return { items: null, error: 'Media posts need at least one image or video.' };
  }

  if (params.value.length > MAX_POST_MEDIA_ITEMS) {
    return { items: null, error: `Add up to ${MAX_POST_MEDIA_ITEMS} media items per post.` };
  }

  const existingRows = await loadOwnedPostMedia(params.adminSupabase, params.postId);
  const existingRowsMap = new Map(existingRows.map((row) => [row.id, row]));
  const submitted: SubmittedEditMediaItem[] = [];

  for (const value of params.value) {
    if (!value || typeof value !== 'object') {
      return { items: null, error: 'Post media metadata is invalid.' };
    }

    const descriptor = value as Record<string, unknown>;
    if (typeof descriptor.existingId === 'string') {
      const existingRow = existingRowsMap.get(descriptor.existingId);
      if (!existingRow) {
        return { items: null, error: 'An existing media item no longer belongs to this post.' };
      }
      submitted.push({ source: 'existing', row: existingRow });
      continue;
    }

    const storagePath = typeof descriptor.storagePath === 'string'
      ? descriptor.storagePath.trim().replace(/^\/+/, '')
      : '';
    const expectedPrefix = `${UPLOADS_BUCKET}/${params.userId}/`;
    if (!storagePath.startsWith(expectedPrefix)) {
      return { items: null, error: 'Uploaded media must belong to the authenticated user.' };
    }

    const contentType = typeof descriptor.contentType === 'string' ? descriptor.contentType.trim() : '';
    const mediaKind = getMediaKindFromContentType(contentType);
    if (!mediaKind) {
      return { items: null, error: 'Post media must be an image or video.' };
    }

    const originalName = typeof descriptor.originalName === 'string' && descriptor.originalName.trim()
      ? descriptor.originalName.trim()
      : path.basename(storagePath);
    const filePath = storagePath.slice(`${UPLOADS_BUCKET}/`.length);
    submitted.push({
      source: 'uploaded',
      filePath,
      temporaryStoragePath: filePath,
      originalName,
      contentType,
      mediaKind,
    });
  }

  return { items: submitted, error: null };
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { postId } = await context.params;
  const supabase = createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const detail = await getOwnerPostDetail(postId, user.id, {
      countryCode: request.headers.get('x-vercel-ip-country'),
    });

    if (!detail) {
      return NextResponse.json({ error: 'Post not found.' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      post: detail,
    });
  } catch (error) {
    console.error('Failed to fetch owner post detail:', error);
    return NextResponse.json({ error: 'Failed to fetch post.' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return PUT(request, context);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { postId } = await context.params;
  const supabase = createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const adminSupabase = createServiceClient();
    const post = await loadOwnedPost(adminSupabase, postId, user.id);
    if (!post) {
      return NextResponse.json({ error: 'Post not found.' }, { status: 404 });
    }
    const existingBundle = await loadOwnedBundleStatus(adminSupabase, postId, user.id);

    const body = (await request.json()) as {
      title?: unknown;
      description?: unknown;
      body?: unknown;
      visibility?: unknown;
      category?: unknown;
      sourceTool?: unknown;
      sourceToolSlug?: unknown;
      sourceTools?: unknown;
      mediaItems?: unknown;
      resourceBundle?: unknown;
    };

    const hasResourceBundlePayload = Object.prototype.hasOwnProperty.call(body, 'resourceBundle');
    const { bundle: resourceBundle, error: resourceBundleError } = parseBundleInput(body.resourceBundle, user.id);
    if (resourceBundleError) {
      return NextResponse.json({ error: resourceBundleError }, { status: 400 });
    }

    const touchesGenerationLockedFields = ['title', 'description', 'body', 'category', 'sourceTool', 'sourceToolSlug', 'sourceTools', 'mediaItems'].some((key) =>
      Object.prototype.hasOwnProperty.call(body, key)
    );

    if (post.generation_id && touchesGenerationLockedFields) {
      return NextResponse.json(
        { error: 'Generation-backed posts should be updated through the generation publish flow.' },
        { status: 400 }
      );
    }

    const { items: submittedMediaItems, error: submittedMediaItemsError } = await parseSubmittedEditMediaItems({
      adminSupabase,
      value: body.mediaItems,
      postId,
      userId: user.id,
    });
    if (submittedMediaItemsError) {
      return NextResponse.json({ error: submittedMediaItemsError }, { status: 400 });
    }

    const nextBody = Object.prototype.hasOwnProperty.call(body, 'body') ? normalizeBody(body.body) : post.body;
    if (post.post_format === 'text' && !nextBody) {
      return NextResponse.json({ error: 'Text posts need a note or tip to save.' }, { status: 400 });
    }

    const nextVisibility = normalizeVisibility(body.visibility) ?? post.visibility;

    if (
      nextVisibility === 'public' &&
      !hasResourceBundlePayload &&
      existingBundle &&
      existingBundle.access_mode !== 'none' &&
      existingBundle.status === 'draft'
    ) {
      return NextResponse.json(
        { error: 'This post already has a draft unlock. Please resubmit the unlock payload when publishing so we can validate and publish it together.' },
        { status: 400 }
      );
    }

    const nextCategory =
      post.post_format === 'text'
        ? 'text'
        : submittedMediaItems?.[0]
          ? submittedMediaItems[0].source === 'existing'
            ? submittedMediaItems[0].row.media_kind
            : submittedMediaItems[0].mediaKind
        : Object.prototype.hasOwnProperty.call(body, 'category') && isShowcaseItemCategory(body.category as string)
          ? body.category
          : post.category;
    const nextTitle = Object.prototype.hasOwnProperty.call(body, 'title') ? normalizeText(body.title) : post.title;
    const sourceToolCatalog = await listSourceToolsCatalog();

    const updatePayload: Record<string, unknown> = {
      visibility: nextVisibility,
      category: nextCategory,
    };

    if (Object.prototype.hasOwnProperty.call(body, 'title')) {
      updatePayload.title = nextTitle;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'description')) {
      updatePayload.description = normalizeText(body.description);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'body')) {
      updatePayload.body = nextBody;
      updatePayload.post_format = nextBody ? (post.post_format === 'media' ? 'mixed' : post.post_format) : post.post_format;
    }
    const hasSourceToolsPayload = Object.prototype.hasOwnProperty.call(body, 'sourceTools');
    let sourceToolsValidationError: string | null = null;
    const sourceTools = (() => {
      if (hasSourceToolsPayload) {
        if (!Array.isArray(body.sourceTools)) {
          return null;
        }
        const validationError = validateSourceToolSelections(body.sourceTools);
        if (validationError) {
          sourceToolsValidationError = validationError;
          return [];
        }
        return normalizeSourceToolSelectionsWithCatalog(sourceToolCatalog, body.sourceTools);
      }
      if (
        Object.prototype.hasOwnProperty.call(body, 'sourceTool') ||
        Object.prototype.hasOwnProperty.call(body, 'sourceToolSlug')
      ) {
        const normalized = normalizeSourceToolInputWithCatalog(sourceToolCatalog, {
          label: Object.prototype.hasOwnProperty.call(body, 'sourceTool') ? normalizeText(body.sourceTool) : post.source_tool,
          slug: normalizeText(body.sourceToolSlug),
        });
        if (normalized.label) {
          return [{ toolLabel: normalized.label, toolSlug: normalized.slug }];
        }
      }
      return [];
    })();

    if (sourceTools === null) {
      return NextResponse.json({ error: 'Source tool metadata is invalid.' }, { status: 400 });
    }
    if (sourceToolsValidationError) {
      return NextResponse.json({
        error: sourceToolsValidationError,
        field: 'sourceTools',
      }, { status: 400 });
    }

    if (hasSourceToolsPayload) {
      updatePayload.source_tool = sourceTools[0]?.toolLabel ?? null;
      updatePayload.source_tool_slug = sourceTools[0]?.toolSlug ?? null;
    } else if (sourceTools.length > 0) {
      updatePayload.source_tool = sourceTools[0].toolLabel;
      updatePayload.source_tool_slug = sourceTools[0].toolSlug;
    } else if (
      Object.prototype.hasOwnProperty.call(body, 'sourceTool') ||
      Object.prototype.hasOwnProperty.call(body, 'sourceToolSlug')
    ) {
      const normalizedSourceTool = normalizeSourceToolInputWithCatalog(sourceToolCatalog, {
        label: Object.prototype.hasOwnProperty.call(body, 'sourceTool') ? normalizeText(body.sourceTool) : post.source_tool,
        slug: normalizeText(body.sourceToolSlug),
      });
      updatePayload.source_tool = normalizedSourceTool.label;
      updatePayload.source_tool_slug = normalizedSourceTool.slug;
    }

    const marketplaceQualityError = nextVisibility === 'public'
      ? await getMarketplaceQualityErrorForPostBundle({
          supabase: adminSupabase,
          ownerUserId: user.id,
          post: {
            title: nextTitle,
            body: nextBody,
            visibility: nextVisibility,
            archivedAt: post.archived_at,
            reviewStatus: post.review_status ?? 'visible',
            showcaseAssetPath: post.showcase_asset_path,
            outputUrl: post.output_url,
          },
          bundle: hasResourceBundlePayload ? resourceBundle : null,
        })
      : null;

    if (marketplaceQualityError) {
      return NextResponse.json({ error: marketplaceQualityError }, { status: 400 });
    }

    const updatedPost = await updatePostWithResourceBundleAtomically({
      supabase: adminSupabase,
      postId,
      ownerUserId: user.id,
      patch: updatePayload,
      hasBundlePayload: hasResourceBundlePayload,
      bundle: resourceBundle,
    });

    if (submittedMediaItems) {
      const existingMediaRows = await loadOwnedPostMedia(adminSupabase, postId);
      const persistedMediaItems: PostMediaPersistInput[] = [];
      const newStoragePaths: string[] = [];
      const temporaryStoragePaths: string[] = [];

      try {
        for (const [index, item] of submittedMediaItems.entries()) {
          if (item.source === 'existing') {
            persistedMediaItems.push({
              storagePath: item.row.storage_path,
              previewStoragePath: item.row.preview_storage_path ?? null,
              previewThumbhash: item.row.preview_thumbhash ?? null,
              previewStatus: item.row.preview_status ?? (item.row.preview_storage_path ? 'ready' : 'pending'),
              previewAttemptCount: item.row.preview_attempt_count ?? 0,
              previewError: item.row.preview_error ?? null,
              previewGeneratedAt: item.row.preview_generated_at ?? null,
              externalUrl: item.row.external_url,
              mediaKind: item.row.media_kind,
              contentType: item.row.content_type,
              originalName: item.row.original_name,
              width: item.row.width,
              height: item.row.height,
              durationSeconds: item.row.duration_seconds,
              sortOrder: index,
            });
            continue;
          }

          const downloadedMedia = await adminSupabase.storage
            .from(UPLOADS_BUCKET)
            .download(item.filePath);
          if (downloadedMedia.error || !downloadedMedia.data) {
            throw new Error('Failed to load uploaded media.');
          }

          const extension = inferExtension(item.originalName, item.contentType);
          const storagePath = `posts/${postId}/${randomUUID()}/${sanitizeFileStem(item.originalName)}.${extension}`;
          const uploadResult = await adminSupabase.storage
            .from(SHOWCASE_MEDIA_BUCKET)
            .upload(storagePath, downloadedMedia.data, {
              cacheControl: '3600',
              contentType: downloadedMedia.data.type || item.contentType || undefined,
              upsert: false,
            });
          if (uploadResult.error) {
            throw uploadResult.error;
          }

          newStoragePaths.push(storagePath);
          temporaryStoragePaths.push(item.temporaryStoragePath);
          let preview: Awaited<ReturnType<typeof createPostMediaPreview>> = null;
          try {
            preview = await createPostMediaPreview({
              body: downloadedMedia.data,
              contentType: item.contentType || downloadedMedia.data.type,
              storagePath,
              supabase: adminSupabase,
            });
            if (preview?.previewStoragePath) {
              newStoragePaths.push(preview.previewStoragePath);
            }
          } catch (previewError) {
            console.warn('Failed to create edited post media preview:', previewError);
          }

          persistedMediaItems.push({
            storagePath,
            previewStoragePath: preview?.previewStoragePath ?? null,
            previewThumbhash: preview?.previewThumbhash ?? null,
            previewStatus: preview?.previewStatus ?? 'failed',
            previewAttemptCount: 1,
            previewError: preview ? null : 'Preview generation failed.',
            previewGeneratedAt: preview ? new Date().toISOString() : null,
            externalUrl: null,
            mediaKind: item.mediaKind,
            contentType: item.contentType,
            originalName: item.originalName,
            width: preview?.width ?? null,
            height: preview?.height ?? null,
            sortOrder: index,
          });
        }

        await replacePostMediaItems({
          supabase: adminSupabase,
          postId,
          ownerUserId: user.id,
          mediaItems: persistedMediaItems,
        });

        if (temporaryStoragePaths.length > 0) {
          const temporaryCleanup = await adminSupabase.storage
            .from(UPLOADS_BUCKET)
            .remove(temporaryStoragePaths);
          if (temporaryCleanup.error) {
            console.warn('Failed to remove temporary post media after edit:', temporaryCleanup.error);
          }
        }

        const retainedStoragePaths = new Set(
          persistedMediaItems
            .flatMap((item) => [item.storagePath, item.previewStoragePath])
            .filter((storagePath): storagePath is string => Boolean(storagePath))
        );
        const removedStoragePaths = existingMediaRows
          .flatMap((row) => [row.storage_path, row.preview_storage_path])
          .filter((storagePath): storagePath is string =>
            Boolean(storagePath) && !retainedStoragePaths.has(storagePath as string)
          );
        if (removedStoragePaths.length > 0) {
          const removedMediaCleanup = await adminSupabase.storage
            .from(SHOWCASE_MEDIA_BUCKET)
            .remove(removedStoragePaths);
          if (removedMediaCleanup.error) {
            console.warn('Failed to remove deleted post media:', removedMediaCleanup.error);
          }
        }
      } catch (mediaError) {
        console.error('Failed to update post media:', mediaError);
        if (newStoragePaths.length > 0) {
          await adminSupabase.storage.from(SHOWCASE_MEDIA_BUCKET).remove(newStoragePaths);
        }
        return NextResponse.json({ error: 'Failed to update post media.' }, { status: 500 });
      }
    }

    if (hasSourceToolsPayload) {
      try {
        await replacePostSourceTools({
          supabase: adminSupabase,
          postId,
          ownerUserId: user.id,
          mediaKind: nextCategory === 'image'
            ? 'image'
            : nextCategory === 'video' || nextCategory === 'motion'
              ? 'video'
              : null,
          sourceTools,
        });
      } catch (sourceToolsError) {
        console.error('Failed to replace post_source_tools:', sourceToolsError);
        const isValidationError = sourceToolsError instanceof PostSourceToolsWriteError
          && sourceToolsError.isValidationError;
        return NextResponse.json({
          error: isValidationError ? sourceToolsError.message : 'Failed to save source tool metadata.',
          field: isValidationError ? 'sourceTools' : undefined,
        }, { status: isValidationError ? 400 : 500 });
      }
    }

    return NextResponse.json({
      success: true,
      postId,
      visibility: updatedPost.visibility,
      showcasePath: updatedPost.visibility === 'private' ? null : `/showcase/${postId}`,
      ownerPath: `/post/${postId}/edit`,
      resourceBundlePath:
        updatedPost.bundleStatus === 'draft' || updatedPost.visibility === 'private'
          ? `/post/${postId}/edit#resources`
          : `/showcase/${postId}#resources`,
      resourceBundleStatus: updatedPost.bundleStatus,
    });
  } catch (error) {
    console.error('Failed to update owner post:', error);
    if (isMissingPostResourceBundlesSchemaError(error)) {
      return NextResponse.json(
        { error: 'Posts are working, but atomic unlock publishing is not enabled yet. Apply the latest Supabase migrations and try again.' },
        { status: 500 }
      );
    }
    return NextResponse.json({ error: 'Failed to update post.' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { postId } = await context.params;
  const supabase = createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const adminSupabase = createServiceClient();
    const post = await loadOwnedPost(adminSupabase, postId, user.id);
    if (!post) {
      return NextResponse.json({ error: 'Post not found.' }, { status: 404 });
    }

    const body = request.headers.get('content-length') && request.headers.get('content-length') !== '0'
      ? ((await request.json()) as { force?: boolean })
      : { force: false };
    const forceDelete = Boolean(body.force);

    const selectBundle = (selectColumns: string) =>
      adminSupabase
        .from('post_resource_bundles')
        .select(selectColumns)
        .eq('post_id', postId)
        .maybeSingle();
    let { data: bundleData, error: bundleError } = await selectBundle(
      'id, access_mode, status, price_usd_cents, sales_count, earnings_usd_cents, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, resource_sections, resource_items, allow_remix'
    );
    if (isMissingPostResourceItemsColumnError(bundleError)) {
      ({ data: bundleData, error: bundleError } = await selectBundle(
        'id, access_mode, status, price_usd_cents, sales_count, earnings_usd_cents, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix'
      ));
    }

    if (bundleError && !isMissingPostResourceBundlesSchemaError(bundleError)) {
      console.error('Failed to load post bundle before delete:', bundleError);
      return NextResponse.json({ error: 'Failed to delete post.' }, { status: 500 });
    }

    const bundle = (bundleData as BundleAuditRow | null) ?? null;
    const hasPaidOrders = Boolean(bundle && bundle.access_mode === 'paid' && bundle.sales_count > 0);

    if (hasPaidOrders && !forceDelete) {
      return NextResponse.json(
        {
          error: 'This post already has paid unlocks. Archive is recommended, but you can still force delete it if you want to remove it permanently.',
          requiresForceDelete: true,
        },
        { status: 409 }
      );
    }

    const bundleResources: Partial<PostResourceBundleResources> | null = bundle
      ? (() => {
          const legacyResources: PostResourceBundleResources = {
            promptText: bundle.prompt_text,
            notesMarkdown: bundle.notes_markdown,
            workflowShareUrl: bundle.workflow_share_url,
            workflowSnapshot: bundle.workflow_snapshot as PostResourceBundleResources['workflowSnapshot'],
            attachments: normalizePostResourceAttachments(bundle.attachments),
            allowRemix: bundle.allow_remix,
            sections: normalizePostResourceSections(bundle.resource_sections),
          };

          return {
            ...legacyResources,
            items: normalizePostResourceItems(bundle.resource_items, legacyResources),
          };
        })()
      : null;

    const { error: auditError } = await adminSupabase.from('post_deletion_audits').insert({
      post_id: post.id,
      owner_user_id: user.id,
      generation_id: post.generation_id,
      title: normalizeText(post.title) ?? 'Deleted post',
      visibility: post.visibility,
      source_kind: normalizeShowcaseSourceKind(post.source_kind),
      bundle_access_mode: bundle?.access_mode ?? null,
      bundle_status: bundle?.status ?? null,
      bundle_price_usd_cents: bundle?.price_usd_cents ?? null,
      bundle_resource_kinds: bundle ? getPostResourceKinds(bundleResources) : [],
      sales_count: bundle?.sales_count ?? 0,
      earnings_usd_cents: bundle?.earnings_usd_cents ?? 0,
      had_paid_orders: hasPaidOrders,
    });

    if (auditError) {
      console.error('Failed to snapshot post deletion audit:', auditError);
      return NextResponse.json({ error: 'Failed to delete post.' }, { status: 500 });
    }

    let removableShowcasePath: string | null = post.showcase_asset_path;

    if (post.generation_id) {
      const { data: generation, error: generationError } = await adminSupabase
        .from('generations')
        .select('id, showcase_asset_path')
        .eq('id', post.generation_id)
        .maybeSingle();

      if (generationError) {
        console.error('Failed to load linked generation before post delete:', generationError);
      } else if (generation) {
        await adminSupabase
          .from('generations')
          .update({
            is_public: false,
            showcase_asset_path: null,
          })
          .eq('id', post.generation_id);

        if (!post.showcase_asset_path || generation.showcase_asset_path !== post.showcase_asset_path) {
          removableShowcasePath = post.showcase_asset_path;
        }
      }
    }

    const { error: deleteError } = await adminSupabase
      .from('posts')
      .delete()
      .eq('id', postId)
      .eq('user_id', user.id);

    if (deleteError) {
      console.error('Failed to delete post:', deleteError);
      return NextResponse.json({ error: 'Failed to delete post.' }, { status: 500 });
    }

    if (removableShowcasePath) {
      await adminSupabase.storage.from('showcase_media').remove([removableShowcasePath]);
    }

    return NextResponse.json({
      success: true,
      deleted: true,
    });
  } catch (error) {
    console.error('Failed to delete owner post:', error);
    return NextResponse.json({ error: 'Failed to delete post.' }, { status: 500 });
  }
}
