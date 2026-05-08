import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, createUserClient, getStoredMediaLocation, type MediaBucket } from '@/lib/server-helpers';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
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
    const { data: generation, error: generationError } = await adminSupabase
      .from('generations')
      .select('id, user_id, output_url, showcase_asset_path')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (generationError) {
      console.error('Failed to load generation before delete:', generationError);
      return NextResponse.json({ error: 'Failed to delete creation.' }, { status: 500 });
    }

    if (!generation) {
      return NextResponse.json({ error: 'Creation not found.' }, { status: 404 });
    }

    const { data: linkedPosts, error: linkedPostsError } = await adminSupabase
      .from('posts')
      .select('id')
      .eq('generation_id', id)
      .eq('user_id', user.id);

    if (linkedPostsError) {
      console.error('Failed to load linked posts before generation delete:', linkedPostsError);
      return NextResponse.json({ error: 'Failed to delete creation.' }, { status: 500 });
    }

    const hasLinkedPosts = Array.isArray(linkedPosts) && linkedPosts.length > 0;
    const removablePaths: Array<{ bucket: MediaBucket | 'showcase_media'; path: string }> = [];

    const { data: inputMediaRows, error: inputMediaError } = await adminSupabase
      .from('generation_input_media')
      .select('storage_path')
      .eq('generation_id', id)
      .eq('user_id', user.id);

    if (inputMediaError) {
      console.error('Failed to load generation input media before delete:', inputMediaError);
    } else {
      for (const row of (inputMediaRows ?? []) as Array<{ storage_path: string | null }>) {
        const location = row.storage_path ? getStoredMediaLocation(row.storage_path) : null;
        if (location) {
          removablePaths.push({
            bucket: location.bucket,
            path: location.filePath,
          });
        }
      }
    }

    if (!hasLinkedPosts) {
      const rawLocation = typeof generation.output_url === 'string' ? getStoredMediaLocation(generation.output_url) : null;
      if (rawLocation) {
        removablePaths.push({
          bucket: rawLocation.bucket,
          path: rawLocation.filePath,
        });
      }

      if (typeof generation.showcase_asset_path === 'string' && generation.showcase_asset_path) {
        removablePaths.push({
          bucket: 'showcase_media',
          path: generation.showcase_asset_path,
        });
      }
    }

    const { error: deleteError } = await adminSupabase
      .from('generations')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);

    if (deleteError) {
      console.error('Failed to delete generation:', deleteError);
      return NextResponse.json({ error: 'Failed to delete creation.' }, { status: 500 });
    }

    for (const removablePath of removablePaths) {
      await adminSupabase.storage.from(removablePath.bucket).remove([removablePath.path]);
    }

    return NextResponse.json({
      success: true,
      deleted: true,
      linkedPostRetained: hasLinkedPosts,
      message: hasLinkedPosts
        ? 'The creation was deleted from your workspace. Any linked post stays intact, but generation-based remix linkage may no longer work.'
        : 'The creation was deleted from your workspace.',
    });
  } catch (error) {
    console.error('Failed to delete owner generation:', error);
    return NextResponse.json({ error: 'Failed to delete creation.' }, { status: 500 });
  }
}
