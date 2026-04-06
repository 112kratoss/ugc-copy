import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { isAudioModel } from '@/lib/models';
import {
    isMissingMarketplaceSchemaError,
    isMissingPostsSchemaError,
} from '@/lib/posts-server';
import { createServiceClient, createUserClient, getStoredMediaLocation } from '@/lib/server-helpers';
import type { ShowcaseItemCategory } from '@/lib/showcase';

type ShowcaseCategory = Exclude<ShowcaseItemCategory, 'text'>;

const SHOWCASE_MEDIA_BUCKET = 'showcase_media';

function detectCategoryFromModel(model: string): ShowcaseCategory {
    if (model.includes('banana')) return 'image';
    if (model === 'kling-3.0/video' || model.includes('/video')) return 'video';
    if (model.startsWith('kling-')) return 'motion';
    return 'image';
}

function isPublishableShowcaseCategory(value: string | null | undefined): value is ShowcaseCategory {
    return value === 'image' || value === 'video' || value === 'motion' || value === 'ugc-ad';
}

function inferExtension(sourceName: string, category: ShowcaseCategory): string {
    const candidate = sourceName.split('.').pop();
    if (candidate && candidate.length <= 5) {
        return candidate;
    }

    if (category === 'image') return 'jpg';
    return 'mp4';
}

function normalizeTextValue(value: unknown): string | null {
    return typeof value === 'string' ? value.trim() : null;
}

async function upsertPublishedPost(params: {
    supabase: ReturnType<typeof createUserClient>;
    generation: {
        id: string;
        user_id: string;
        output_url: string | null;
        title?: string | null;
        description?: string | null;
        prompt?: string | null;
    };
    visibility: 'public' | 'private';
    category: ShowcaseCategory;
    showcaseAssetPath: string | null;
    title?: unknown;
    description?: unknown;
    prompt?: unknown;
}) {
    const {
        supabase,
        generation,
        visibility,
        category,
        showcaseAssetPath,
        title,
        description,
        prompt,
    } = params;

    const payload = {
        user_id: generation.user_id,
        visibility,
        category,
        title: normalizeTextValue(title) ?? generation.title?.trim() ?? null,
        description: normalizeTextValue(description) ?? generation.description?.trim() ?? null,
        prompt: normalizeTextValue(prompt) ?? generation.prompt?.trim() ?? null,
        body: null,
        post_format: 'media' as const,
        source_kind: 'ugc_copy' as const,
        source_tool: null,
        generation_id: generation.id,
        showcase_asset_path: showcaseAssetPath,
        output_url: generation.output_url,
    };

    const { data, error } = await supabase
        .from('posts')
        .upsert(payload, {
            onConflict: 'generation_id',
        })
        .select('id')
        .single();

    if (error || !data?.id) {
        throw new Error(`Failed to sync post visibility: ${error?.message ?? 'Unknown error'}`);
    }

    return data.id as string;
}

async function downgradeAttachedListingToUnlisted(params: {
    supabase: ReturnType<typeof createUserClient>;
    postId: string | null;
    sellerUserId: string;
}) {
    const { supabase, postId, sellerUserId } = params;
    if (!postId) {
        return;
    }

    const { error } = await supabase
        .from('marketplace_assets')
        .update({
            status: 'unlisted',
        })
        .eq('post_id', postId)
        .eq('seller_user_id', sellerUserId)
        .eq('status', 'active');

    if (error && !isMissingMarketplaceSchemaError(error)) {
        throw error;
    }
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
            .select('id, user_id, status, model, category, output_url, showcase_asset_path, title, description, prompt')
            .eq('id', generationId)
            .single();

        let hasShowcaseAssetColumn = true;
        if (generationQuery.error?.code === '42703') {
            hasShowcaseAssetColumn = false;
            generationQuery = await supabase
                .from('generations')
                .select('id, user_id, status, model, category, output_url, title, description, prompt')
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

        let detectedCategory: ShowcaseCategory | undefined = isPublishableShowcaseCategory(category)
            ? category
            : isPublishableShowcaseCategory(generation.category)
                ? generation.category
                : undefined;
        if (!detectedCategory && isPublic) {
            detectedCategory = detectCategoryFromModel(generation.model);
        }

        const updatePayload: { is_public: boolean; [key: string]: unknown } = { is_public: isPublic };

        let nextShowcaseAssetPath = hasShowcaseAssetColumn ? generation.showcase_asset_path ?? null : null;

        if (isPublic) {
            if (!generation.output_url) {
                return NextResponse.json({ error: 'This creation has no media to publish yet' }, { status: 400 });
            }

            if (hasShowcaseAssetColumn) {
                nextShowcaseAssetPath = await createShowcaseDerivative(
                    generationId,
                    generation.output_url,
                    detectedCategory ?? 'image'
                );
                updatePayload.showcase_asset_path = nextShowcaseAssetPath;
            }

            if (title !== undefined) updatePayload.title = title;
            if (description !== undefined) updatePayload.description = description;
            if (prompt !== undefined) updatePayload.prompt = prompt;
            if (detectedCategory !== undefined) updatePayload.category = detectedCategory;
            if (workflowSettings !== undefined) updatePayload.workflow_settings = workflowSettings;
        } else if (hasShowcaseAssetColumn) {
            updatePayload.showcase_asset_path = null;
            nextShowcaseAssetPath = null;
        }

        const { error: updateError } = await supabase
            .from('generations')
            .update(updatePayload)
            .eq('id', generationId);

        if (updateError) {
            console.error('Error updating generation visibility:', updateError);
            return NextResponse.json({ error: 'Failed to update visibility' }, { status: 500 });
        }

        let postId: string | null = null;
        try {
            postId = await upsertPublishedPost({
                supabase,
                generation,
                visibility: isPublic ? 'public' : 'private',
                category: detectedCategory ?? 'image',
                showcaseAssetPath: nextShowcaseAssetPath,
                title,
                description,
                prompt,
            });
        } catch (postError) {
            if (isMissingPostsSchemaError(postError)) {
                postId = null;
            } else {
                console.error('Failed to sync generation post:', postError);
                return NextResponse.json({ error: 'Failed to sync showcase post' }, { status: 500 });
            }
        }

        if (!isPublic) {
            try {
                await downgradeAttachedListingToUnlisted({
                    supabase,
                    postId,
                    sellerUserId: user.id,
                });
            } catch (listingError) {
                console.error('Failed to downgrade attached marketplace listing:', listingError);
                return NextResponse.json({ error: 'Failed to update attached marketplace listing' }, { status: 500 });
            }
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
            postId,
            message: isPublic ? 'Successfully published to showcase' : 'Successfully removed from showcase',
        });
    } catch (error) {
        console.error('Publish error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
