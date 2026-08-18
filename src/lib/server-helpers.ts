/**
 * Shared server-side helpers for API routes.
 * Centralizes Supabase client creation, user authentication,
 * and credit deduction logic to eliminate duplication.
 *
 * `server-only` is load-bearing, not decorative: createServiceClient reads the
 * service-role key, so a client component importing this module must fail the
 * build rather than bundle server code into the browser.
 *
 * This module was previously reachable from a client component through
 * creator-tools -> workflow-blueprint -> prompt-enhancer -> provider-fetch ->
 * provider-fetch-attempts, which calls createServiceClient() for real. The
 * launch-URL helpers client code actually wanted now live in
 * `creator-launch-urls`, which breaks that chain and lets this guard stand.
 * If this import starts failing the build again, read the trace: something has
 * re-linked server code into the client graph.
 */
import 'server-only';

import { NextResponse } from 'next/server';
import { logBackendError } from '@/lib/backend-logger';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { buildMediaProxyUrl, getStoredMediaLocation } from '@/lib/media-urls';
import { isStorageObjectOwnedByUser } from '@/lib/storage-ownership';

const KIE_API_KEY = process.env.KIE_AI_API_KEY;
let cachedServiceClient: SupabaseClient | null = null;

// ─── Supabase Client Factories ────────────────────────────────────────────────

/** Creates a Supabase client scoped to the calling user's JWT. */
export function createUserClient(request: Request): SupabaseClient {
    const authorization = request.headers.get('Authorization');

    return createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        authorization
            ? {
                global: { headers: { Authorization: authorization } },
            }
            : undefined
    );
}

/** Creates a privileged Supabase client for server-only operations (webhooks, service tasks). */
export function createServiceClient(): SupabaseClient {
    if (!cachedServiceClient) {
        cachedServiceClient = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            {
                auth: {
                    autoRefreshToken: false,
                    detectSessionInUrl: false,
                    persistSession: false,
                },
            }
        );
    }

    return cachedServiceClient;
}

export { getStoredMediaLocation, isMediaBucket, type MediaBucket } from '@/lib/media-urls';

/**
 * Converts stored media paths and legacy Supabase storage URLs into a fresh signed URL.
 * Returns the original value for non-storage URLs such as provider temp URLs.
 */
async function signStoredMediaUrl(
    adminSupabase: SupabaseClient,
    outputUrl: string
): Promise<string> {
    const location = getStoredMediaLocation(outputUrl);

    if (!location) {
        return outputUrl;
    }

    try {
        const { data, error } = await adminSupabase.storage
            .from(location.bucket)
            .createSignedUrl(location.filePath, 3600);

        if (error || !data?.signedUrl) {
            logBackendError('failed_to_sign_media_url_for', { message: `Failed to sign media URL for ${location.bucket}/${location.filePath}:`, error: error });
            return outputUrl;
        }

        return data.signedUrl;
    } catch (err) {
        logBackendError('error_signing_media_url_for', { message: `Error signing media URL for ${location.bucket}/${location.filePath}:`, error: err });
        return outputUrl;
    }
}

/**
 * Resolves storage-backed media to a working URL.
 * Prefers a signed Supabase URL, but falls back to the app's same-origin proxy
 * when signing is unavailable in the current deployment.
 */
export async function resolveStoredMediaUrl(
    adminSupabase: SupabaseClient,
    outputUrl: string
): Promise<string> {
    const location = getStoredMediaLocation(outputUrl);
    const privateTemplateLocation = outputUrl.startsWith('template_inputs/')
        ? { bucket: 'template_inputs', filePath: outputUrl.slice('template_inputs/'.length) }
        : outputUrl.startsWith('template_assets/')
            ? { bucket: 'template_assets', filePath: outputUrl.slice('template_assets/'.length) }
            : null;

    // Template inputs and fixed assets intentionally are not accepted by the
    // generic /api/media proxy. Server-only template execution and catalog
    // routes may still resolve them with the service client.
    if (!location && privateTemplateLocation?.filePath) {
        try {
            const { data, error } = await adminSupabase.storage
                .from(privateTemplateLocation.bucket)
                .createSignedUrl(privateTemplateLocation.filePath, 3600);
            if (!error && data?.signedUrl) return data.signedUrl;
        } catch (error) {
            logBackendError('resolvestoredmediaurl_private_template_signing_failed', { error: error });
        }
        return outputUrl;
    }

    if (!location) {
        return outputUrl;
    }

    try {
        const signedUrl = await signStoredMediaUrl(adminSupabase, outputUrl);
        if (signedUrl !== outputUrl) {
            return signedUrl;
        }
    } catch (err) {
        logBackendError('resolvestoredmediaurl_signing_failed_falling_back_to_proxy', { error: err });
    }

    return buildMediaProxyUrl(location.bucket, location.filePath);
}

/**
 * Resolves media referenced by a user-owned database row without allowing the
 * service role to sign another user's object path.
 */
export async function resolveOwnedStoredMediaUrl(
    adminSupabase: SupabaseClient,
    outputUrl: string,
    ownerUserId: string
): Promise<string | null> {
    const location = getStoredMediaLocation(outputUrl);
    if (location) {
        if (!isStorageObjectOwnedByUser(location.filePath, ownerUserId)) {
            logBackendError('refused_to_sign_media_outside_owner_prefix', { message: `Refused to sign media outside owner prefix: ${location.bucket}/${location.filePath}` });
            return null;
        }
        return resolveStoredMediaUrl(adminSupabase, outputUrl);
    }

    try {
        const url = new URL(outputUrl);
        return url.protocol === 'https:' && !url.username && !url.password ? outputUrl : null;
    } catch {
        return null;
    }
}

// ─── Authentication ───────────────────────────────────────────────────────────

export interface AuthResult {
    userId: string;
    supabase: SupabaseClient;
}

/**
 * Authenticates the request and returns the userId + scoped Supabase client.
 * Returns a NextResponse error if authentication fails.
 */
export async function authenticateRequest(
    request: Request
): Promise<AuthResult | NextResponse> {
    const supabase = createUserClient(request);
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error || !user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return { userId: user.id, supabase };
}

// ─── Credits ──────────────────────────────────────────────────────────────────

// ─── Kie.ai API ───────────────────────────────────────────────────────────────

/**
 * Validates that the KIE_AI_API_KEY is set.
 * Returns a NextResponse error if missing.
 */
export function requireKieApiKey(): string | NextResponse {
    if (!KIE_API_KEY) {
        logBackendError('kie_ai_api_key_not_found_in_environment_variables');
        return NextResponse.json(
            { error: 'Server configuration error: API key missing' },
            { status: 500 }
        );
    }
    return KIE_API_KEY;
}
