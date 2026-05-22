import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { isAudioModel } from '@/lib/models';
import {
    getMarketplaceQualityErrorForPostBundle,
    publishGenerationPostWithResourceBundleAtomically,
} from '@/lib/post-resource-bundles-server';
import {
    deriveTitleFromBody,
    isMissingPostsSchemaError,
    isMissingPostResourceBundlesSchemaError,
} from '@/lib/posts-server';
import { createServiceClient, createUserClient, getStoredMediaLocation } from '@/lib/server-helpers';
import { normalizeSourceToolInput } from '@/lib/source-tools';
import { MAGICBOOKLET_SOURCE_KIND, type ShowcaseItemCategory } from '@/lib/showcase';
import {
    validatePostResourceBundleInput,
    type PostResourceBundleInput,
} from '@/lib/post-resource-bundles';

type ShowcaseCategory = Exclude<ShowcaseItemCategory, 'text'>;

const SHOWCASE_MEDIA_BUCKET = 'showcase_media';
const MISSING_POST_RESOURCE_BUNDLES_SCHEMA_ERROR =
    'Posts are working, but atomic unlock publishing is not enabled on the connected Supabase project yet. Apply the post resource bundle migrations, including 20260508120000_post_system_marketplace_reliability.sql, and try again.';

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

function normalizeRequestedVisibility(value: unknown, legacyIsPublic?: boolean): 'public' | 'unlisted' | 'private' {
    if (value === 'public' || value === 'unlisted' || value === 'private') {
        return value;
    }

    return legacyIsPublic ? 'public' : 'private';
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

        const requestBody = await request.json() as {
            generationId?: string;
            isPublic?: boolean;
            visibility?: 'public' | 'unlisted' | 'private';
            title?: string;
            description?: string;
            prompt?: string;
            body?: string;
            category?: string;
            workflowSettings?: unknown;
            exposePromptPublic?: boolean;
            shareInputMediaForRemix?: boolean;
            resourceBundle?: PostResourceBundleInput | null;
        };
        const { generationId, isPublic, title, description, prompt, body, category, workflowSettings } = requestBody;

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

        const hasResourceBundlePayload = Object.prototype.hasOwnProperty.call(requestBody, 'resourceBundle');
        const resourceBundleValidationError = hasResourceBundlePayload
            ? validatePostResourceBundleInput(requestBody.resourceBundle ?? null, { ownerUserId: user.id })
            : null;
        if (resourceBundleValidationError) {
            return NextResponse.json({ error: resourceBundleValidationError }, { status: 400 });
        }
        const shouldExposePromptPublic = requestBody.exposePromptPublic === true && !hasResourceBundlePayload;
        const requestedVisibility = normalizeRequestedVisibility(requestBody.visibility, isPublic);
        const effectiveVisibility = requestedVisibility;
        const shouldExposePost = effectiveVisibility !== 'private';
        const effectiveIsPublic = effectiveVisibility === 'public';
        const effectiveShareInputMediaForRemix = effectiveIsPublic && requestBody.shareInputMediaForRemix === true;

        if (shouldExposePost && (generation.category === 'audio' || isAudioModel(generation.model))) {
            return NextResponse.json({ error: 'Audio generations are not publishable to the showcase yet' }, { status: 400 });
        }

        let detectedCategory: ShowcaseCategory | undefined = isPublishableShowcaseCategory(category)
            ? category
            : isPublishableShowcaseCategory(generation.category)
                ? generation.category
                : undefined;
        if (!detectedCategory && shouldExposePost) {
            detectedCategory = detectCategoryFromModel(generation.model);
        }

        const normalizedBody = normalizeTextValue(body);
        const resolvedTitle =
            normalizeTextValue(title)
            ?? generation.title?.trim()
            ?? deriveTitleFromBody(normalizedBody)
            ?? null;

        const marketplaceQualityError = effectiveVisibility === 'public'
            ? await getMarketplaceQualityErrorForPostBundle({
                supabase: adminSupabase,
                ownerUserId: user.id,
                post: {
                    title: resolvedTitle,
                    body: normalizedBody,
                    visibility: effectiveVisibility,
                    archivedAt: null,
                    reviewStatus: 'visible',
                    outputUrl: generation.output_url,
                    hasMedia: Boolean(generation.output_url),
                },
                bundle: hasResourceBundlePayload ? requestBody.resourceBundle ?? null : null,
            })
            : null;

        if (marketplaceQualityError) {
            return NextResponse.json({ error: marketplaceQualityError }, { status: 400 });
        }

        const updatePayload: { is_public: boolean; [key: string]: unknown } = {
            is_public: effectiveIsPublic,
            share_input_media_for_remix: effectiveShareInputMediaForRemix,
        };

        let nextShowcaseAssetPath = hasShowcaseAssetColumn ? generation.showcase_asset_path ?? null : null;

        if (shouldExposePost) {
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

        let postId: string | null = null;
        let resourceBundleStatus: 'draft' | 'published' | null = null;
        const postPayload = {
            user_id: generation.user_id,
            visibility: effectiveVisibility,
            category: detectedCategory ?? 'image',
            title: resolvedTitle,
            description: normalizeTextValue(description) ?? generation.description?.trim() ?? null,
            prompt: shouldExposePromptPublic ? normalizeTextValue(prompt) ?? generation.prompt?.trim() ?? null : null,
            body: normalizedBody,
            post_format: normalizedBody ? 'mixed' : 'media',
            source_kind: MAGICBOOKLET_SOURCE_KIND,
            source_tool: 'magicbooklet',
            source_tool_slug: normalizeSourceToolInput({ slug: 'magicbooklet' }).slug,
            generation_id: generation.id,
            showcase_asset_path: nextShowcaseAssetPath,
            output_url: generation.output_url,
        };

        try {
            const publishResult = await publishGenerationPostWithResourceBundleAtomically({
                supabase: adminSupabase,
                generationId,
                ownerUserId: user.id,
                generationUpdate: updatePayload,
                post: postPayload,
                bundle: requestBody.resourceBundle ?? null,
                hasBundlePayload: hasResourceBundlePayload,
            });
            postId = publishResult.postId;
            resourceBundleStatus = publishResult.bundleStatus;
        } catch (postError) {
            if (hasShowcaseAssetColumn && nextShowcaseAssetPath && nextShowcaseAssetPath !== generation.showcase_asset_path) {
                void adminSupabase.storage
                    .from(SHOWCASE_MEDIA_BUCKET)
                    .remove([nextShowcaseAssetPath])
                    .catch((storageError) => {
                        console.error('Failed to delete showcase derivative after publish failure:', storageError);
                    });
            }

            if (isMissingPostsSchemaError(postError)) {
                return NextResponse.json({ error: 'Failed to sync showcase post' }, { status: 500 });
            }

            console.error('Failed to sync generation post:', postError);
            if (isMissingPostResourceBundlesSchemaError(postError)) {
                return NextResponse.json({ error: MISSING_POST_RESOURCE_BUNDLES_SCHEMA_ERROR }, { status: 500 });
            }
            return NextResponse.json({ error: 'Failed to sync showcase post' }, { status: 500 });
        }

        if (effectiveVisibility === 'private' && hasShowcaseAssetColumn && generation.showcase_asset_path) {
            void adminSupabase.storage
                .from(SHOWCASE_MEDIA_BUCKET)
                .remove([generation.showcase_asset_path])
                .catch((storageError) => {
                    console.error('Failed to delete showcase derivative after unpublish:', storageError);
                });
        }

        return NextResponse.json({
            success: true,
            isPublic: effectiveIsPublic,
            visibility: effectiveVisibility,
            postId,
            showcasePath: postId && effectiveVisibility !== 'private' ? `/showcase/${postId}` : null,
            ownerPath: postId ? `/post/${postId}/edit` : null,
            resourceBundlePath: postId
                ? resourceBundleStatus === 'draft' || effectiveVisibility === 'private'
                    ? `/post/${postId}/edit#resources`
                    : `/showcase/${postId}#resources`
                : null,
            resourceBundleStatus,
            message:
                effectiveVisibility === 'public'
                    ? 'Successfully published to showcase'
                    : effectiveVisibility === 'unlisted'
                        ? 'Saved as an unlisted post'
                        : 'Saved as a private post',
        });
    } catch (error) {
        console.error('Publish error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
