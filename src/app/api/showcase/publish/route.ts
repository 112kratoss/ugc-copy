import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { isAudioModel } from '@/lib/models';
import { createServiceClient, createUserClient, getStoredMediaLocation } from '@/lib/server-helpers';

type ShowcaseCategory = 'image' | 'video' | 'motion' | 'ugc-ad';

const SHOWCASE_MEDIA_BUCKET = 'showcase_media';

function detectCategoryFromModel(model: string): ShowcaseCategory {
    if (model.includes('banana')) return 'image';
    if (model === 'kling-3.0/video' || model.includes('/video')) return 'video';
    if (model.startsWith('kling-')) return 'motion';
    return 'image';
}

function inferExtension(sourceName: string, category: ShowcaseCategory): string {
    const candidate = sourceName.split('.').pop();
    if (candidate && candidate.length <= 5) {
        return candidate;
    }

    if (category === 'image') return 'jpg';
    return 'mp4';
}

async function createShowcaseDerivative(
    generationId: string,
    outputUrl: string,
    category: ShowcaseCategory
) {
    const adminSupabase = createServiceClient();
    const storedLocation = getStoredMediaLocation(outputUrl);
    let fileBlob: Blob;
    let sourceName: string;
    let contentType: string | null = null;

    if (storedLocation) {
        sourceName = storedLocation.filePath.split('/').pop() || `${generationId}.${inferExtension(outputUrl, category)}`;
        const { data, error } = await adminSupabase.storage
            .from(storedLocation.bucket)
            .download(storedLocation.filePath);

        if (error || !data) {
            throw new Error(`Failed to load source media from ${storedLocation.bucket}/${storedLocation.filePath}`);
        }

        fileBlob = data;
        contentType = data.type || null;
    } else if (outputUrl.startsWith('http')) {
        const response = await fetch(outputUrl);

        if (!response.ok) {
            throw new Error(`Failed to fetch source media from ${outputUrl}`);
        }

        const url = new URL(outputUrl);
        sourceName = path.basename(url.pathname) || `${generationId}.${inferExtension(outputUrl, category)}`;
        fileBlob = await response.blob();
        contentType = response.headers.get('content-type');
    } else {
        throw new Error('Unsupported media source for showcase publishing');
    }

    const baseName = path.basename(sourceName, path.extname(sourceName)) || generationId;
    const showcaseAssetPath = `showcase/${generationId}/${baseName}.${inferExtension(sourceName, category)}`;

    const { error: uploadError } = await adminSupabase.storage
        .from(SHOWCASE_MEDIA_BUCKET)
        .upload(showcaseAssetPath, fileBlob, {
            cacheControl: '3600',
            contentType: contentType || (category === 'image' ? 'image/jpeg' : 'video/mp4'),
            upsert: true,
        });

    if (uploadError) {
        throw new Error(`Failed to upload showcase derivative: ${uploadError.message}`);
    }

    return showcaseAssetPath;
}

export async function POST(request: NextRequest) {
    try {
        const supabase = createUserClient(request);
        const adminSupabase = createServiceClient();

        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { generationId, isPublic, title, description, prompt, category, workflowSettings } = await request.json();

        if (!generationId) {
            return NextResponse.json({ error: 'Missing generation ID' }, { status: 400 });
        }

        let generationQuery = await supabase
            .from('generations')
            .select('id, user_id, status, model, category, output_url, showcase_asset_path')
            .eq('id', generationId)
            .single();

        let hasShowcaseAssetColumn = true;
        if (generationQuery.error?.code === '42703') {
            hasShowcaseAssetColumn = false;
            generationQuery = await supabase
                .from('generations')
                .select('id, user_id, status, model, category, output_url')
                .eq('id', generationId)
                .single();
        }

        const { data: generation, error: fetchError } = generationQuery;

        if (fetchError || !generation) {
            return NextResponse.json({ error: 'Generation not found' }, { status: 404 });
        }

        if (generation.user_id !== user.id) {
            return NextResponse.json({ error: 'Unauthorized: You do not own this creation' }, { status: 403 });
        }

        if (generation.status !== 'succeeded') {
            return NextResponse.json({ error: 'Cannot publish a generation that has not succeeded' }, { status: 400 });
        }

        if (isPublic && (generation.category === 'audio' || isAudioModel(generation.model))) {
            return NextResponse.json({ error: 'Audio generations are not publishable to the showcase yet' }, { status: 400 });
        }

        let detectedCategory: ShowcaseCategory | undefined = category ?? generation.category ?? undefined;
        if (!detectedCategory && isPublic) {
            detectedCategory = detectCategoryFromModel(generation.model);
        }

        const updatePayload: { is_public: boolean; [key: string]: unknown } = { is_public: isPublic };

        if (isPublic) {
            if (!generation.output_url) {
                return NextResponse.json({ error: 'This creation has no media to publish yet' }, { status: 400 });
            }

            if (hasShowcaseAssetColumn) {
                updatePayload.showcase_asset_path = await createShowcaseDerivative(
                    generationId,
                    generation.output_url,
                    detectedCategory ?? 'image'
                );
            }

            if (title !== undefined) updatePayload.title = title;
            if (description !== undefined) updatePayload.description = description;
            if (prompt !== undefined) updatePayload.prompt = prompt;
            if (detectedCategory !== undefined) updatePayload.category = detectedCategory;
            if (workflowSettings !== undefined) updatePayload.workflow_settings = workflowSettings;
        } else if (hasShowcaseAssetColumn) {
            updatePayload.showcase_asset_path = null;
        }

        const { error: updateError } = await supabase
            .from('generations')
            .update(updatePayload)
            .eq('id', generationId);

        if (updateError) {
            console.error('Error updating generation visibility:', updateError);
            return NextResponse.json({ error: 'Failed to update visibility' }, { status: 500 });
        }

        if (!isPublic && hasShowcaseAssetColumn && generation.showcase_asset_path) {
            void adminSupabase.storage
                .from(SHOWCASE_MEDIA_BUCKET)
                .remove([generation.showcase_asset_path])
                .catch((storageError) => {
                    console.error('Failed to delete showcase derivative after unpublish:', storageError);
                });
        }

        return NextResponse.json({
            success: true,
            isPublic,
            message: isPublic ? 'Successfully published to showcase' : 'Successfully removed from showcase',
        });
    } catch (error) {
        console.error('Publish error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
