import 'server-only';

import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  isCompatibleGenerationMediaType,
  persistGenerationMediaBlob,
  type CreatedGenerationMediaLocation,
} from '@/lib/durable-generation-media';

const UPLOADS_BUCKET = 'uploads';

type GenerationRestoreMediaBody = {
  storagePath?: unknown;
  originalName?: unknown;
  contentType?: unknown;
};

type GenerationRestoreRow = {
  id: string;
  user_id: string;
  status: string;
  model: string;
  category: string | null;
  output_url: string | null;
  showcase_asset_path: string | null;
  is_public: boolean;
};

type LinkedPostRow = {
  id: string;
  visibility: 'public' | 'unlisted' | 'private';
  output_url: string | null;
  showcase_asset_path: string | null;
};

export type GenerationRestoreMediaDependencies = {
  isCompatibleGenerationMediaType: typeof isCompatibleGenerationMediaType;
  persistGenerationMediaBlob: typeof persistGenerationMediaBlob;
};

export type GenerationRestoreMediaRouteResult =
  | {
      ok: true;
      body: {
        success: true;
        outputUrl: string;
      };
    }
  | {
      ok: false;
      status: 400 | 404 | 409 | 500;
      body: {
        error: string;
      };
    };

function resolveDependencies(
  dependencies: Partial<GenerationRestoreMediaDependencies> | undefined,
): GenerationRestoreMediaDependencies {
  return {
    isCompatibleGenerationMediaType:
      dependencies?.isCompatibleGenerationMediaType ?? isCompatibleGenerationMediaType,
    persistGenerationMediaBlob:
      dependencies?.persistGenerationMediaBlob ?? persistGenerationMediaBlob,
  };
}

function parseOwnerUploadPath(value: unknown, userId: string): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().replace(/^\/+/, '');
  if (!normalized.startsWith(`${UPLOADS_BUCKET}/${userId}/`)) {
    return null;
  }

  return normalized.slice(`${UPLOADS_BUCKET}/`.length);
}

async function cleanupTemporaryUpload(adminSupabase: SupabaseClient, uploadFilePath: string) {
  const result = await adminSupabase.storage.from(UPLOADS_BUCKET).remove([uploadFilePath]);
  if (result.error) {
    console.warn('Failed to remove temporary generation restore upload:', result.error);
  }
}

async function cleanupCreatedMedia(
  adminSupabase: SupabaseClient,
  location: CreatedGenerationMediaLocation | null,
) {
  if (!location) {
    return;
  }

  const result = await adminSupabase.storage.from(location.bucket).remove([location.filePath]);
  if (result.error) {
    console.warn('Failed to remove restored generation media after failure:', result.error);
  }
}

export async function restoreGenerationMediaForRoute({
  adminSupabase,
  body,
  dependencies,
  generationId,
  userId,
}: {
  adminSupabase: SupabaseClient;
  body: GenerationRestoreMediaBody;
  dependencies?: Partial<GenerationRestoreMediaDependencies>;
  generationId: string;
  userId: string;
}): Promise<GenerationRestoreMediaRouteResult> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const uploadFilePath = parseOwnerUploadPath(body.storagePath, userId);
  if (!uploadFilePath) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Replacement media must come from your uploads folder.' },
    };
  }

  let createdMediaLocation: CreatedGenerationMediaLocation | null = null;

  try {
    const { data: generation, error: generationError } = await adminSupabase
      .from('generations')
      .select('id, user_id, status, model, category, output_url, showcase_asset_path, is_public')
      .eq('id', generationId)
      .eq('user_id', userId)
      .is('template_run_id', null)
      .is('template_run_step_id', null)
      .maybeSingle();
    const ownedGeneration = generation as GenerationRestoreRow | null;

    if (generationError) {
      console.error('Failed to load generation for media restore:', generationError);
      await cleanupTemporaryUpload(adminSupabase, uploadFilePath);
      return { ok: false, status: 500, body: { error: 'Failed to restore preview.' } };
    }

    if (!ownedGeneration) {
      await cleanupTemporaryUpload(adminSupabase, uploadFilePath);
      return { ok: false, status: 404, body: { error: 'Creation not found.' } };
    }

    if (ownedGeneration.status !== 'succeeded') {
      await cleanupTemporaryUpload(adminSupabase, uploadFilePath);
      return { ok: false, status: 400, body: { error: 'Only completed creations can restore their preview.' } };
    }

    const { data: linkedPostData, error: linkedPostError } = await adminSupabase
      .from('posts')
      .select('id, visibility, output_url, showcase_asset_path')
      .eq('generation_id', generationId)
      .eq('user_id', userId)
      .maybeSingle();
    const linkedPost = linkedPostData as LinkedPostRow | null;

    if (linkedPostError) {
      console.error('Failed to load linked post for media restore:', linkedPostError);
      await cleanupTemporaryUpload(adminSupabase, uploadFilePath);
      return { ok: false, status: 500, body: { error: 'Failed to restore preview.' } };
    }

    if (ownedGeneration.is_public || (linkedPost && linkedPost.visibility !== 'private')) {
      await cleanupTemporaryUpload(adminSupabase, uploadFilePath);
      return {
        ok: false,
        status: 409,
        body: { error: 'Make the linked post private before replacing its preview.' },
      };
    }

    const downloadedUpload = await adminSupabase.storage
      .from(UPLOADS_BUCKET)
      .download(uploadFilePath);

    if (downloadedUpload.error || !downloadedUpload.data) {
      console.error('Failed to download generation restore upload:', downloadedUpload.error);
      await cleanupTemporaryUpload(adminSupabase, uploadFilePath);
      return { ok: false, status: 500, body: { error: 'Failed to load replacement media.' } };
    }

    const requestedContentType = typeof body.contentType === 'string' ? body.contentType.trim() : '';
    const contentType = downloadedUpload.data.type || requestedContentType;
    if (
      (!contentType.startsWith('image/') && !contentType.startsWith('video/'))
      || !resolvedDependencies.isCompatibleGenerationMediaType(
        {
          category: ownedGeneration.category,
          model: ownedGeneration.model,
        },
        contentType,
      )
    ) {
      await cleanupTemporaryUpload(adminSupabase, uploadFilePath);
      return {
        ok: false,
        status: 400,
        body: { error: 'The replacement media type does not match this creation.' },
      };
    }

    const sourceName = typeof body.originalName === 'string' && body.originalName.trim()
      ? body.originalName.trim()
      : path.basename(uploadFilePath);
    const persistedMedia = await resolvedDependencies.persistGenerationMediaBlob({
      supabase: adminSupabase,
      generation: {
        id: ownedGeneration.id,
        userId: ownedGeneration.user_id,
        model: ownedGeneration.model,
        category: ownedGeneration.category,
      },
      blob: downloadedUpload.data,
      sourceName,
      contentType,
    });
    createdMediaLocation = persistedMedia.createdLocation;

    const { error: generationUpdateError } = await adminSupabase
      .from('generations')
      .update({
        output_url: persistedMedia.outputUrl,
        showcase_asset_path: null,
        is_public: false,
      })
      .eq('id', ownedGeneration.id)
      .eq('user_id', userId)
      .is('template_run_id', null)
      .is('template_run_step_id', null);

    if (generationUpdateError) {
      console.error('Failed to update restored generation preview:', generationUpdateError);
      await cleanupCreatedMedia(adminSupabase, persistedMedia.createdLocation);
      createdMediaLocation = null;
      await cleanupTemporaryUpload(adminSupabase, uploadFilePath);
      return { ok: false, status: 500, body: { error: 'Failed to restore preview.' } };
    }

    if (linkedPost) {
      const { error: postUpdateError } = await adminSupabase
        .from('posts')
        .update({
          output_url: persistedMedia.outputUrl,
          showcase_asset_path: null,
        })
        .eq('id', linkedPost.id)
        .eq('user_id', userId)
        .eq('visibility', 'private');

      if (postUpdateError) {
        console.error('Failed to update linked post restored preview:', postUpdateError);
        const { error: rollbackError } = await adminSupabase
          .from('generations')
          .update({
            output_url: ownedGeneration.output_url,
            showcase_asset_path: ownedGeneration.showcase_asset_path,
            is_public: ownedGeneration.is_public,
          })
          .eq('id', ownedGeneration.id)
          .eq('user_id', userId)
          .is('template_run_id', null)
          .is('template_run_step_id', null);
        if (rollbackError) {
          console.error('Failed to roll back generation preview after linked post update failure:', rollbackError);
        } else {
          await cleanupCreatedMedia(adminSupabase, persistedMedia.createdLocation);
          createdMediaLocation = null;
        }
        await cleanupTemporaryUpload(adminSupabase, uploadFilePath);
        return { ok: false, status: 500, body: { error: 'Failed to restore preview.' } };
      }
    }

    await cleanupTemporaryUpload(adminSupabase, uploadFilePath);
    createdMediaLocation = null;
    return {
      ok: true,
      body: {
        success: true,
        outputUrl: persistedMedia.outputUrl,
      },
    };
  } catch (error) {
    console.error('Failed to restore generation media:', error);
    await cleanupCreatedMedia(adminSupabase, createdMediaLocation);
    await cleanupTemporaryUpload(adminSupabase, uploadFilePath);
    return { ok: false, status: 500, body: { error: 'Failed to restore preview.' } };
  }
}
