import 'server-only';

import type { NextRequest } from 'next/server';

import { getUploadsBucketPath, isUploadsStoragePath, normalizeSubmittedElementDescriptors } from '@/lib/image-elements';
import { isAudioModel, isImageModel, isMotionModel } from '@/lib/models';
import {
  type RemixMediaAssetDescriptor,
  normalizeRemixMediaAssetDescriptor,
  type RemixResolvedAsset,
  type RemixResolvedImageElement,
  type RemixSourceBundle,
  type RemixSourceResult,
} from '@/lib/remix-source';
import { createServiceClient, createUserClient, resolveStoredMediaUrl } from '@/lib/server-helpers';
import type { ShowcaseItemCategory } from '@/lib/showcase';

type RemixSourceGenerationRow = {
  id: string;
  user_id: string | null;
  is_public: boolean | null;
  output_url: string | null;
  showcase_asset_path: string | null;
  category: string | null;
  model: string | null;
  prompt: string | null;
  title: string | null;
  workflow_settings: Record<string, unknown> | null;
};

type ResultGenerationRow = Pick<RemixSourceGenerationRow, 'id' | 'output_url' | 'showcase_asset_path'>;

const GENERATION_SELECT =
  'id, user_id, is_public, output_url, showcase_asset_path, category, model, prompt, title, workflow_settings';

export class RemixSourceError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RemixSourceError';
    this.status = status;
  }
}

function normalizeCategory(category: string | null, model: string | null): ShowcaseItemCategory | null {
  if (category === 'image' || category === 'video' || category === 'motion' || category === 'ugc-ad') {
    return category;
  }

  if (!model) {
    return null;
  }

  if (isImageModel(model)) {
    return 'image';
  }

  if (isMotionModel(model)) {
    return 'motion';
  }

  if (isAudioModel(model)) {
    return null;
  }

  return 'video';
}

function toResultMediaType(category: ShowcaseItemCategory): RemixSourceResult['mediaType'] {
  return category === 'image' ? 'image' : 'video';
}

function getShowcaseAssetUrl(
  adminSupabase: ReturnType<typeof createServiceClient>,
  showcaseAssetPath: string
): string {
  const { data } = adminSupabase.storage.from('showcase_media').getPublicUrl(showcaseAssetPath);
  return data.publicUrl;
}

async function resolveGenerationResultUrl(
  adminSupabase: ReturnType<typeof createServiceClient>,
  generation: ResultGenerationRow
): Promise<string | null> {
  if (generation.showcase_asset_path) {
    return getShowcaseAssetUrl(adminSupabase, generation.showcase_asset_path);
  }

  if (!generation.output_url) {
    return null;
  }

  return resolveStoredMediaUrl(adminSupabase, generation.output_url);
}

async function resolveUploadsStoragePathUrl(
  adminSupabase: ReturnType<typeof createServiceClient>,
  storagePath: string
): Promise<string | null> {
  if (!isUploadsStoragePath(storagePath)) {
    return null;
  }

  const filePath = getUploadsBucketPath(storagePath);
  const { data, error } = await adminSupabase.storage.from('uploads').createSignedUrl(filePath, 3600);

  if (error || !data?.signedUrl) {
    console.error('Failed to sign remix source upload asset:', error);
    return null;
  }

  return data.signedUrl;
}

async function fetchGenerationById(
  adminSupabase: ReturnType<typeof createServiceClient>,
  generationId: string
): Promise<ResultGenerationRow | null> {
  const { data, error } = await adminSupabase
    .from('generations')
    .select('id, output_url, showcase_asset_path')
    .eq('id', generationId)
    .maybeSingle();

  if (error) {
    console.error('Failed to fetch remix referenced generation:', error);
    return null;
  }

  return data as ResultGenerationRow | null;
}

export async function loadRemixSourceBundle(
  request: NextRequest,
  generationId: string
): Promise<RemixSourceBundle> {
  const trimmedGenerationId = generationId.trim();
  if (!trimmedGenerationId) {
    throw new RemixSourceError('Missing generation ID', 400);
  }

  const userSupabase = createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await userSupabase.auth.getUser();

  if (authError || !user) {
    throw new RemixSourceError('Unauthorized', 401);
  }

  const adminSupabase = createServiceClient();
  const { data: generation, error } = await adminSupabase
    .from('generations')
    .select(GENERATION_SELECT)
    .eq('id', trimmedGenerationId)
    .maybeSingle();

  if (error) {
    console.error('Failed to fetch remix source generation:', error);
    throw new RemixSourceError('Failed to load remix source', 500);
  }

  if (!generation) {
    throw new RemixSourceError('Remix source not found', 404);
  }

  const typedGeneration = generation as RemixSourceGenerationRow;
  if (typedGeneration.user_id !== user.id && !typedGeneration.is_public) {
    throw new RemixSourceError('Remix source not found', 404);
  }

  const category = normalizeCategory(typedGeneration.category, typedGeneration.model);
  if (!category) {
    throw new RemixSourceError('This creation type does not support remix media restoration', 400);
  }

  const workflowSettings =
    typedGeneration.workflow_settings && typeof typedGeneration.workflow_settings === 'object'
      ? typedGeneration.workflow_settings
      : {};

  const restoreIssues: string[] = [];
  const referencedGenerationCache = new Map<string, Promise<ResultGenerationRow | null>>();

  const resolveDescriptorUrl = async (
    descriptor: RemixMediaAssetDescriptor,
    issueLabel: string
  ): Promise<string | null> => {
    if (descriptor.storagePath) {
      const signedUrl = await resolveUploadsStoragePathUrl(adminSupabase, descriptor.storagePath);
      if (signedUrl) {
        return signedUrl;
      }

      restoreIssues.push(issueLabel);
      return null;
    }

    if (descriptor.sourceGenerationId) {
      const cacheKey = descriptor.sourceGenerationId;
      if (!referencedGenerationCache.has(cacheKey)) {
        referencedGenerationCache.set(cacheKey, fetchGenerationById(adminSupabase, cacheKey));
      }

      const referencedGeneration = await referencedGenerationCache.get(cacheKey)!;
      if (!referencedGeneration) {
        restoreIssues.push(issueLabel);
        return null;
      }

      const resolvedUrl = await resolveGenerationResultUrl(adminSupabase, referencedGeneration);
      if (resolvedUrl) {
        return resolvedUrl;
      }

      restoreIssues.push(issueLabel);
      return null;
    }

    restoreIssues.push(issueLabel);
    return null;
  };

  const resolveElementDescriptors = async (
    issuePrefix: string
  ): Promise<RemixResolvedImageElement[]> => {
    const elements = normalizeSubmittedElementDescriptors(workflowSettings.elements);

    return Promise.all(
      elements.map(async (element) => ({
        ...element,
        url: await resolveDescriptorUrl(
          {
            kind: 'image',
            label: element.displayName,
            storagePath: element.storagePath ?? null,
            sourceGenerationId: element.sourceGenerationId ?? null,
          },
          `${issuePrefix}:${element.displayName}`
        ),
      }))
    );
  };

  const resolveAssetDescriptor = async (
    value: unknown,
    expectedKind: 'image' | 'video',
    issueLabel: string
  ): Promise<RemixResolvedAsset | null> => {
    const descriptor = normalizeRemixMediaAssetDescriptor(value, expectedKind);
    if (!descriptor) {
      return null;
    }

    return {
      ...descriptor,
      url: await resolveDescriptorUrl(descriptor, issueLabel),
    };
  };

  const resultUrl = await resolveGenerationResultUrl(adminSupabase, typedGeneration);
  const result: RemixSourceResult | null = {
    mediaType: toResultMediaType(category),
    url: resultUrl,
  };

  if (!resultUrl) {
    restoreIssues.push('result');
  }

  const bundle: RemixSourceBundle = {
    generation: {
      id: typedGeneration.id,
      title: typedGeneration.title?.trim() || 'Untitled Creation',
      prompt: typedGeneration.prompt?.trim() || '',
      category,
      model: typedGeneration.model || '',
    },
    result,
    inputs: {},
    workflowSettings,
    restoreIssues,
  };

  if (category === 'image') {
    bundle.inputs.image = {
      elements: await resolveElementDescriptors('image-element'),
    };
  }

  if (category === 'video' || category === 'ugc-ad') {
    bundle.inputs.video = {
      referenceMode: workflowSettings.referenceMode === 'elements' ? 'elements' : 'frames',
      startFrame: await resolveAssetDescriptor(
        workflowSettings.startFrame,
        'image',
        'video-start-frame'
      ),
      endFrame: await resolveAssetDescriptor(workflowSettings.endFrame, 'image', 'video-end-frame'),
      elements: await resolveElementDescriptors('video-element'),
    };
  }

  if (category === 'motion') {
    bundle.inputs.motion = {
      characterImage: await resolveAssetDescriptor(
        workflowSettings.characterImage,
        'image',
        'motion-character-image'
      ),
      referenceVideo: await resolveAssetDescriptor(
        workflowSettings.referenceVideo,
        'video',
        'motion-reference-video'
      ),
    };
  }

  return bundle;
}

