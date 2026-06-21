import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
    findPublicPostReferenceByIdOrGenerationId,
    isMissingPostsSchemaError,
} from '@/lib/posts-server';
import { notifyPostSocialActivity } from '@/lib/mobile-notifications';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type SetPostSaveStateRow = {
    is_saved?: boolean | null;
    save_count?: number | null;
    changed?: boolean | null;
};

type PostSaveFallbackResult = {
    isSaved: boolean;
    saveCount: number;
    changed: boolean;
};

type PostSaveLookupRow = {
    id?: string | null;
};

type PostSaveCountRow = {
    save_count?: number | null;
};

function normalizeSaveSourceSurface(value: unknown) {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.trim().slice(0, 80);
    return normalized.length > 0 ? normalized : null;
}

function normalizeSetPostSaveStateResult(data: unknown) {
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== 'object') {
        return null;
    }

    const result = row as SetPostSaveStateRow;
    if (typeof result.is_saved !== 'boolean') {
        return null;
    }

    return {
        isSaved: result.is_saved,
        saveCount: typeof result.save_count === 'number' ? result.save_count : 0,
        changed: Boolean(result.changed),
    };
}

function getSupabaseErrorText(error: unknown) {
    if (!error || typeof error !== 'object') {
        return '';
    }

    const candidate = error as { message?: unknown; details?: unknown; hint?: unknown };
    return [candidate.message, candidate.details, candidate.hint]
        .filter((value): value is string => typeof value === 'string')
        .join(' ');
}

function isMissingSetPostSaveStateFunctionError(error: unknown) {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const code = (error as { code?: unknown }).code;
    return code === 'PGRST202' && getSupabaseErrorText(error).includes('set_post_save_state');
}

async function readPostSaveCount(serviceClient: SupabaseClient, postId: string) {
    const { data, error } = await serviceClient
        .from('posts')
        .select('save_count')
        .eq('id', postId)
        .maybeSingle();

    if (error) {
        throw error;
    }

    const row = data as PostSaveCountRow | null;
    return typeof row?.save_count === 'number' ? row.save_count : 0;
}

async function resolveLegacyIdempotentSaveState({
    post,
    requestedSaveState,
    serviceClient,
    userId,
}: {
    post: { id: string };
    requestedSaveState: boolean;
    serviceClient: SupabaseClient;
    userId: string;
}): Promise<PostSaveFallbackResult> {
    const { data: existingSave, error: saveLookupError } = await serviceClient
        .from('post_saves')
        .select('id')
        .eq('post_id', post.id)
        .eq('user_id', userId)
        .maybeSingle();

    if (saveLookupError) {
        throw saveLookupError;
    }

    const isCurrentlySaved = Boolean((existingSave as PostSaveLookupRow | null)?.id);

    if (isCurrentlySaved === requestedSaveState) {
        return {
            isSaved: requestedSaveState,
            saveCount: await readPostSaveCount(serviceClient, post.id),
            changed: false,
        };
    }

    const legacySaveResult = await serviceClient.rpc('toggle_post_save', {
        p_post_id: post.id,
        p_user_id: userId,
    });

    if (legacySaveResult.error) {
        throw legacySaveResult.error;
    }

    if (typeof legacySaveResult.data !== 'boolean') {
        throw new Error('Legacy save fallback returned an invalid result');
    }

    return {
        isSaved: legacySaveResult.data,
        saveCount: await readPostSaveCount(serviceClient, post.id),
        changed: true,
    };
}

async function recordPostSaveEvent({
    actorUserId,
    changed,
    isSaved,
    postId,
    requestedState,
    serviceClient,
    sourceSurface,
}: {
    actorUserId: string;
    changed: boolean;
    isSaved: boolean;
    postId: string;
    requestedState: boolean;
    serviceClient: SupabaseClient;
    sourceSurface: string | null;
}) {
    try {
        const { error } = await serviceClient
            .from('post_save_events')
            .insert({
                user_id: actorUserId,
                post_id: postId,
                requested_state: requestedState,
                result_state: isSaved,
                changed,
                source_surface: sourceSurface,
            });

        if (error) {
            console.error('Failed to record post save event:', error);
        }
    } catch (error) {
        console.error('Failed to record post save event:', error);
    }
}

export async function POST(request: NextRequest) {
    try {
        const supabase = createUserClient(request);

        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const serviceClient = createServiceClient();

        const { generationId, postId, shouldSave, sourceSurface } = await request.json();
        const referenceId = typeof postId === 'string' ? postId : generationId;
        const requestedSaveState = typeof shouldSave === 'boolean' ? shouldSave : null;
        const hasTargetSaveState = requestedSaveState !== null;

        if (!referenceId || typeof referenceId !== 'string') {
            return NextResponse.json({ error: 'Missing post ID' }, { status: 400 });
        }

        if (shouldSave !== undefined && !hasTargetSaveState) {
            return NextResponse.json({ error: 'Invalid save state' }, { status: 400 });
        }

        const post = await findPublicPostReferenceByIdOrGenerationId(referenceId);
        if (!post) {
            return NextResponse.json({ error: 'Post not found' }, { status: 404 });
        }

        let isSaved: boolean | null = null;
        let saveCount: number | null = null;
        let changed = true;
        let rpcError: unknown = null;

        if (hasTargetSaveState) {
            const postSaveResult = await serviceClient.rpc('set_post_save_state', {
                p_post_id: post.id,
                p_user_id: user.id,
                p_should_save: requestedSaveState,
            });

            const normalizedResult = normalizeSetPostSaveStateResult(postSaveResult.data);
            isSaved = normalizedResult?.isSaved ?? null;
            saveCount = normalizedResult?.saveCount ?? null;
            changed = normalizedResult?.changed ?? false;
            rpcError = postSaveResult.error;
        } else {
            const postSaveResult = await serviceClient.rpc('toggle_post_save', {
                p_post_id: post.id,
                p_user_id: user.id
            });

            isSaved = typeof postSaveResult.data === 'boolean' ? postSaveResult.data : null;
            rpcError = postSaveResult.error;
        }

        if (
            requestedSaveState !== null
            && rpcError
            && isMissingSetPostSaveStateFunctionError(rpcError)
        ) {
            const legacyState = await resolveLegacyIdempotentSaveState({
                post,
                requestedSaveState,
                serviceClient,
                userId: user.id,
            });

            isSaved = legacyState.isSaved;
            saveCount = legacyState.saveCount;
            changed = legacyState.changed;
            rpcError = null;
        } else if (rpcError && isMissingPostsSchemaError(rpcError)) {
            const legacySaveResult = await serviceClient.rpc('toggle_showcase_save', {
                p_generation_id: post.generation_id ?? post.id,
                p_user_id: user.id
            });

            isSaved = typeof legacySaveResult.data === 'boolean' ? legacySaveResult.data : null;
            saveCount = null;
            changed = true;
            rpcError = legacySaveResult.error;
        }

        if (rpcError) {
            console.error('Error toggling save:', rpcError);
            return NextResponse.json({ error: 'Failed to update save status' }, { status: 500 });
        }

        if (isSaved === null) {
            return NextResponse.json({ error: 'Failed to update save status' }, { status: 500 });
        }

        if (requestedSaveState !== null) {
            await recordPostSaveEvent({
                actorUserId: user.id,
                changed,
                isSaved,
                postId: post.id,
                requestedState: requestedSaveState,
                serviceClient,
                sourceSurface: normalizeSaveSourceSurface(sourceSurface),
            });
        }

        if (isSaved && (!hasTargetSaveState || changed)) {
            await notifyPostSocialActivity(serviceClient, {
                type: 'post_saved',
                recipientUserId: post.user_id,
                actorUserId: user.id,
                postId: post.id,
            });
        }

        return NextResponse.json({ 
            success: true, 
            isSaved,
            saveCount,
            changed,
            message: isSaved ? 'Saved to bookmarks' : 'Removed from bookmarks'
        });

    } catch (error) {
        console.error('Save error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
