import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';

import {
  isCompatibleGenerationMediaType,
  persistGenerationMediaBlob,
  type CreatedGenerationMediaLocation,
} from '@/lib/durable-generation-media';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

const UPLOADS_BUCKET = 'uploads';

type RouteContext = {
  params: Promise<{ id: string }>;
};

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

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let requestBody: {
    storagePath?: unknown;
    originalName?: unknown;
    contentType?: unknown;
  };
  try {
    requestBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid restore request.' }, { status: 400 });
  }

  const uploadFilePath = parseOwnerUploadPath(requestBody.storagePath, user.id);
  if (!uploadFilePath) {
    return NextResponse.json({ error: 'Replacement media must come from your uploads folder.' }, { status: 400 });
  }

  const adminSupabase = createServiceClient();
  const cleanupTemporaryUpload = async () => {
    const result = await adminSupabase.storage.from(UPLOADS_BUCKET).remove([uploadFilePath]);
    if (result.error) {
      console.warn('Failed to remove temporary generation restore upload:', result.error);
    }
  };
  const cleanupCreatedMedia = async (location: CreatedGenerationMediaLocation | null) => {
    if (!location) {
      return;
    }

    const result = await adminSupabase.storage.from(location.bucket).remove([location.filePath]);
    if (result.error) {
      console.warn('Failed to remove restored generation media after failure:', result.error);
    }
  };
  let createdMediaLocation: CreatedGenerationMediaLocation | null = null;

  try {
    const { data: generation, error: generationError } = await adminSupabase
      .from('generations')
      .select('id, user_id, status, model, category, output_url, showcase_asset_path, is_public')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (generationError) {
      console.error('Failed to load generation for media restore:', generationError);
      await cleanupTemporaryUpload();
      return NextResponse.json({ error: 'Failed to restore preview.' }, { status: 500 });
    }

    if (!generation) {
      await cleanupTemporaryUpload();
      return NextResponse.json({ error: 'Creation not found.' }, { status: 404 });
    }

    if (generation.status !== 'succeeded') {
      await cleanupTemporaryUpload();
      return NextResponse.json({ error: 'Only completed creations can restore their preview.' }, { status: 400 });
    }

    const { data: linkedPost, error: linkedPostError } = await adminSupabase
      .from('posts')
      .select('id, visibility, output_url, showcase_asset_path')
      .eq('generation_id', id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (linkedPostError) {
      console.error('Failed to load linked post for media restore:', linkedPostError);
      await cleanupTemporaryUpload();
      return NextResponse.json({ error: 'Failed to restore preview.' }, { status: 500 });
    }

    if (generation.is_public || (linkedPost && linkedPost.visibility !== 'private')) {
      await cleanupTemporaryUpload();
      return NextResponse.json(
        { error: 'Make the linked post private before replacing its preview.' },
        { status: 409 }
      );
    }

    const downloadedUpload = await adminSupabase.storage
      .from(UPLOADS_BUCKET)
      .download(uploadFilePath);

    if (downloadedUpload.error || !downloadedUpload.data) {
      console.error('Failed to download generation restore upload:', downloadedUpload.error);
      await cleanupTemporaryUpload();
      return NextResponse.json({ error: 'Failed to load replacement media.' }, { status: 500 });
    }

    const requestedContentType = typeof requestBody.contentType === 'string' ? requestBody.contentType.trim() : '';
    const contentType = downloadedUpload.data.type || requestedContentType;
    if (
      (!contentType.startsWith('image/') && !contentType.startsWith('video/'))
      || !isCompatibleGenerationMediaType(
        {
          category: generation.category,
          model: generation.model,
        },
        contentType
      )
    ) {
      await cleanupTemporaryUpload();
      return NextResponse.json(
        { error: 'The replacement media type does not match this creation.' },
        { status: 400 }
      );
    }

    const sourceName = typeof requestBody.originalName === 'string' && requestBody.originalName.trim()
      ? requestBody.originalName.trim()
      : path.basename(uploadFilePath);
    const persistedMedia = await persistGenerationMediaBlob({
      supabase: adminSupabase,
      generation: {
        id: generation.id,
        userId: generation.user_id,
        model: generation.model,
        category: generation.category,
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
      .eq('id', generation.id)
      .eq('user_id', user.id);

    if (generationUpdateError) {
      console.error('Failed to update restored generation preview:', generationUpdateError);
      await cleanupCreatedMedia(persistedMedia.createdLocation);
      createdMediaLocation = null;
      await cleanupTemporaryUpload();
      return NextResponse.json({ error: 'Failed to restore preview.' }, { status: 500 });
    }

    if (linkedPost) {
      const { error: postUpdateError } = await adminSupabase
        .from('posts')
        .update({
          output_url: persistedMedia.outputUrl,
          showcase_asset_path: null,
        })
        .eq('id', linkedPost.id)
        .eq('user_id', user.id)
        .eq('visibility', 'private');

      if (postUpdateError) {
        console.error('Failed to update linked post restored preview:', postUpdateError);
        const { error: rollbackError } = await adminSupabase
          .from('generations')
          .update({
            output_url: generation.output_url,
            showcase_asset_path: generation.showcase_asset_path,
            is_public: generation.is_public,
          })
          .eq('id', generation.id)
          .eq('user_id', user.id);
        if (rollbackError) {
          console.error('Failed to roll back generation preview after linked post update failure:', rollbackError);
        } else {
          await cleanupCreatedMedia(persistedMedia.createdLocation);
          createdMediaLocation = null;
        }
        await cleanupTemporaryUpload();
        return NextResponse.json({ error: 'Failed to restore preview.' }, { status: 500 });
      }
    }

    await cleanupTemporaryUpload();
    createdMediaLocation = null;
    return NextResponse.json({
      success: true,
      outputUrl: persistedMedia.outputUrl,
    });
  } catch (error) {
    console.error('Failed to restore generation media:', error);
    await cleanupCreatedMedia(createdMediaLocation);
    await cleanupTemporaryUpload();
    return NextResponse.json({ error: 'Failed to restore preview.' }, { status: 500 });
  }
}
