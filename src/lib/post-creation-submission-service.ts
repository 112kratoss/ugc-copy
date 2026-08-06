import path from 'node:path';

import { TITLE_MAX_LENGTH } from '@/lib/posts-server';
import {
  isPostResourceBundleAccessMode,
  validatePostResourceBundleInput,
  type PostResourceBundleInput,
} from '@/lib/post-resource-bundles';
import { getMediaKindFromContentType, MAX_POST_MEDIA_ITEMS } from '@/lib/post-media';
import { defaultPostMediaKey, normalizePostMediaKey } from '@/lib/post-media-key';
import {
  normalizeSourceToolInputWithCatalog,
  normalizeSourceToolSelectionsWithCatalog,
  validateSourceToolSelections,
  type SourceToolOption,
  type SourceToolSelection,
} from '@/lib/source-tools';
import {
  isShowcaseItemCategory,
  type ShowcaseItemCategory,
  type ShowcaseMediaKind,
  type ShowcasePostFormat,
  type ShowcaseSourceKind,
  type ShowcaseVisibility,
} from '@/lib/showcase';

const UPLOADS_BUCKET = 'uploads';
const BODY_MAX_LENGTH = 2000;

export type SubmittedPostMediaItem =
  | {
      source: 'file';
      mediaKey: string;
      file: File;
      originalName: string;
      contentType: string;
    }
  | {
      source: 'uploaded';
      mediaKey: string;
      filePath: string;
      temporaryStoragePath: string;
      originalName: string;
      contentType: string;
    };

export interface PostCreationSubmission {
  submittedMediaItems: SubmittedPostMediaItem[];
  hasSubmittedMedia: boolean;
  body: string | null;
  postFormat: ShowcasePostFormat;
  mediaMimeType: string;
  category: ShowcaseItemCategory;
  visibility: ShowcaseVisibility;
  title: string | null;
  description: string | null;
  sourceTools: SourceToolSelection[];
  normalizedSourceTool: { label: string | null; slug: string | null };
  sourceKind: ShowcaseSourceKind;
  resourceBundle: PostResourceBundleInput | null;
}

export type PostCreationSubmissionResult =
  | {
      ok: true;
      submission: PostCreationSubmission;
    }
  | {
      ok: false;
      status: 400;
      body: {
        error: string;
        field?: string;
      };
    };

export function sanitizeFileStem(fileName: string): string {
  const stem = path.basename(fileName, path.extname(fileName)).toLowerCase();
  const sanitized = stem.replace(/[^a-z0-9-_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return sanitized || 'upload';
}

export function inferExtension(fileName: string, mimeType: string): string {
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

export function getSubmittedMediaKind(item: SubmittedPostMediaItem): ShowcaseMediaKind {
  return getMediaKindFromContentType(item.contentType) ?? 'image';
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

function parseMediaItemsPayload(params: {
  rawValue: FormDataEntryValue | null;
  userId: string;
}): { items: SubmittedPostMediaItem[] | null; error: string | null } {
  if (typeof params.rawValue !== 'string' || !params.rawValue.trim()) {
    return { items: null, error: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(params.rawValue);
  } catch {
    return { items: null, error: 'Post media metadata is invalid.' };
  }

  if (!Array.isArray(parsed)) {
    return { items: null, error: 'Post media metadata is invalid.' };
  }

  const items: SubmittedPostMediaItem[] = [];
  for (const [index, value] of parsed.entries()) {
    if (!value || typeof value !== 'object') {
      return { items: null, error: 'Post media metadata is invalid.' };
    }

    const descriptor = value as Record<string, unknown>;
    const mediaKey = descriptor.mediaKey == null
      ? defaultPostMediaKey(index)
      : normalizePostMediaKey(descriptor.mediaKey);
    if (!mediaKey) {
      return { items: null, error: 'Post media keys may only use letters, numbers, hyphens, and underscores.' };
    }
    const { location, error } = parseUploadedMediaLocation({
      storagePath: typeof descriptor.storagePath === 'string' ? descriptor.storagePath : null,
      userId: params.userId,
      originalName: typeof descriptor.originalName === 'string' ? descriptor.originalName : null,
      contentType: typeof descriptor.contentType === 'string' ? descriptor.contentType : null,
    });

    if (error) {
      return { items: null, error };
    }

    if (!location) {
      return { items: null, error: 'Each post media item needs an uploaded media file.' };
    }

    items.push({
      source: 'uploaded',
      mediaKey,
      filePath: location.filePath,
      temporaryStoragePath: location.filePath,
      originalName: location.originalName,
      contentType: location.contentType,
    });
  }

  return { items, error: null };
}

function validateSubmittedMediaItems(items: SubmittedPostMediaItem[]): string | null {
  if (items.length > MAX_POST_MEDIA_ITEMS) {
    return `Add up to ${MAX_POST_MEDIA_ITEMS} media items per post.`;
  }

  const mediaKeys = new Set<string>();
  for (const item of items) {
    if (mediaKeys.has(item.mediaKey)) {
      return 'Post media keys must be unique.';
    }
    mediaKeys.add(item.mediaKey);

    if (item.contentType.startsWith('audio/')) {
      return 'Audio uploads are not supported in Showcase yet.';
    }

    if (!getMediaKindFromContentType(item.contentType)) {
      return 'Post media must be an image or video.';
    }
  }

  return null;
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

  return requestedCategory === inferred ? requestedCategory : null;
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

function parseResourceBundle(
  value: FormDataEntryValue | null,
  ownerUserId: string,
  mediaKeys: Iterable<string>
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
        error: 'Choose whether the unlock should be free or paid.',
      };
    }

    const validationError = validatePostResourceBundleInput(parsed, { ownerUserId, mediaKeys });
    if (validationError) {
      return {
        bundle: null,
        error: validationError,
      };
    }

    return {
      bundle: parsed,
      error: null,
    };
  } catch {
    return {
      bundle: null,
      error: 'The attached recipe could not be parsed.',
    };
  }
}

function badRequest(error: string, field?: string): PostCreationSubmissionResult {
  return {
    ok: false,
    status: 400,
    body: {
      error,
      ...(field ? { field } : {}),
    },
  };
}

export async function preparePostCreationSubmission({
  formData,
  userId,
  sourceToolCatalog,
}: {
  formData: FormData;
  userId: string;
  sourceToolCatalog: SourceToolOption[];
}): Promise<PostCreationSubmissionResult> {
  const rawMediaFiles = formData
    .getAll('media')
    .filter((entry): entry is File => entry instanceof File && entry.size > 0);
  const { location: legacyUploadedMedia, error: uploadedMediaError } = parseUploadedMediaLocation({
    storagePath: formData.get('mediaStoragePath'),
    userId,
    originalName: formData.get('mediaOriginalName'),
    contentType: formData.get('mediaContentType'),
  });
  if (uploadedMediaError) {
    return badRequest(uploadedMediaError);
  }

  const { items: parsedMediaItems, error: parsedMediaItemsError } = parseMediaItemsPayload({
    rawValue: formData.get('mediaItems'),
    userId,
  });
  if (parsedMediaItemsError) {
    return badRequest(parsedMediaItemsError);
  }

  const body = normalizeBody(formData.get('body'));
  const postFormat = normalizePostFormat(
    typeof formData.get('postFormat') === 'string' ? String(formData.get('postFormat')) : null
  );
  const submittedMediaItems: SubmittedPostMediaItem[] = parsedMediaItems ?? (
    legacyUploadedMedia
      ? [{
          source: 'uploaded' as const,
          mediaKey: defaultPostMediaKey(0),
          filePath: legacyUploadedMedia.filePath,
          temporaryStoragePath: legacyUploadedMedia.filePath,
          originalName: legacyUploadedMedia.originalName,
          contentType: legacyUploadedMedia.contentType,
        }]
      : rawMediaFiles.map((mediaFile, index) => ({
          source: 'file' as const,
          mediaKey: defaultPostMediaKey(index),
          file: mediaFile,
          originalName: mediaFile.name,
          contentType: mediaFile.type,
        }))
  );

  const submittedMediaValidationError = validateSubmittedMediaItems(submittedMediaItems);
  if (submittedMediaValidationError) {
    return badRequest(submittedMediaValidationError);
  }

  const hasSubmittedMedia = submittedMediaItems.length > 0;
  if (!body && !hasSubmittedMedia) {
    return badRequest('Add a note or upload media to publish a post.');
  }

  if (body && body.length > BODY_MAX_LENGTH) {
    return badRequest(`Text posts are limited to ${BODY_MAX_LENGTH} characters.`);
  }

  if (postFormat === 'text' && !body) {
    return badRequest('Text posts need a note or tip to publish.');
  }

  if (postFormat === 'mixed' && !body) {
    return badRequest('Media + note posts need both media and written context.');
  }

  if ((postFormat === 'media' || postFormat === 'mixed') && !hasSubmittedMedia) {
    return badRequest('Upload an image or video for this post type.');
  }

  const coverSubmittedMedia = submittedMediaItems[0] ?? null;
  const mediaMimeType = coverSubmittedMedia?.contentType ?? '';
  const category =
    postFormat === 'text'
      ? 'text'
      : resolveCategory(
          typeof formData.get('category') === 'string' ? String(formData.get('category')) : null,
          mediaMimeType
        );

  if (!category) {
    return badRequest('Please upload an image or video and choose a matching category.');
  }

  const visibility = normalizeVisibility(
    typeof formData.get('visibility') === 'string' ? String(formData.get('visibility')) : null
  );
  const submittedTitle = normalizeText(formData.get('title'));
  if (submittedTitle && submittedTitle.length > TITLE_MAX_LENGTH) {
    return badRequest(`Titles are limited to ${TITLE_MAX_LENGTH} characters.`);
  }

  // Every new post is named by its author, on every format. Text posts used to
  // fall back to a title derived from the body; that fallback is gone here, so
  // there is nothing left to resolve. Posts written before this rule keep
  // whatever title they were given.
  if (!submittedTitle) {
    return badRequest('Add a title for your post.', 'title');
  }

  const title = submittedTitle;
  const description = normalizeText(formData.get('description'));
  const sourceTool = hasSubmittedMedia ? normalizeText(formData.get('sourceTool')) : null;
  const sourceToolSlugRaw = normalizeText(formData.get('sourceToolSlug'));
  const normalizedSourceTool = normalizeSourceToolInputWithCatalog(sourceToolCatalog, {
    label: sourceTool,
    slug: sourceToolSlugRaw,
  });
  const sourceToolsRaw = normalizeText(formData.get('sourceTools'));
  let parsedSourceTools: unknown = null;
  if (sourceToolsRaw) {
    try {
      parsedSourceTools = JSON.parse(sourceToolsRaw);
    } catch {
      return badRequest('Source tool metadata is invalid.');
    }
  }
  const fallbackSourceTools = sourceTool || normalizedSourceTool.label
    ? [{
        toolLabel: normalizedSourceTool.label ?? sourceTool ?? '',
        toolSlug: normalizedSourceTool.slug,
      }]
    : [];
  const sourceToolsInput = parsedSourceTools ?? fallbackSourceTools;
  const sourceToolsValidationError = validateSourceToolSelections(sourceToolsInput);
  if (sourceToolsValidationError) {
    return badRequest(sourceToolsValidationError, 'sourceTools');
  }

  const sourceTools = normalizeSourceToolSelectionsWithCatalog(sourceToolCatalog, sourceToolsInput);
  const sourceKind = postFormat === 'text' ? 'manual' : 'external';
  const { bundle: resourceBundle, error: resourceBundleError } = parseResourceBundle(
    formData.get('resourceBundle'),
    userId,
    submittedMediaItems.map((item) => item.mediaKey)
  );
  if (resourceBundleError) {
    return badRequest(resourceBundleError);
  }

  return {
    ok: true,
    submission: {
      submittedMediaItems,
      hasSubmittedMedia,
      body,
      postFormat,
      mediaMimeType,
      category,
      visibility,
      title,
      description,
      sourceTools,
      normalizedSourceTool,
      sourceKind,
      resourceBundle,
    },
  };
}
