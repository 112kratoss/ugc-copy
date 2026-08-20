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
import { buildMediaProxyUrl, isMediaBucket } from '@/lib/media-urls';
import {
    getCanonicalStoredMediaLocation,
    getUserOwnedStoredMediaLocation,
} from '@/lib/storage-ownership';
import { requireIdentity } from '@/lib/account-identity';

const KIE_API_KEY = process.env.KIE_AI_API_KEY;
const GENERIC_SIGNABLE_MEDIA_BUCKETS = [
    'generated_images',
    'generated_videos',
    'generated_audio',
    'generation_inputs',
] as const;
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
    const location = getCanonicalStoredMediaLocation(outputUrl, {
        allowedBuckets: GENERIC_SIGNABLE_MEDIA_BUCKETS,
    });

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
    const location = getCanonicalStoredMediaLocation(outputUrl, {
        allowedBuckets: GENERIC_SIGNABLE_MEDIA_BUCKETS,
    });

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

    return isMediaBucket(location.bucket)
        ? buildMediaProxyUrl(location.bucket, location.filePath)
        : outputUrl;
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
    const location = getUserOwnedStoredMediaLocation(outputUrl, ownerUserId);
    if (location) {
        try {
            const { data, error } = await adminSupabase.storage
                .from(location.bucket)
                .createSignedUrl(location.filePath, 3600);
            if (!error && data?.signedUrl) return data.signedUrl;
            if (isMediaBucket(location.bucket)) {
                return buildMediaProxyUrl(location.bucket, location.filePath);
            }
        } catch (error) {
            logBackendError('resolveownedstoredmediaurl_signing_failed', { error: error });
        }
        return null;
    }

    try {
        const url = new URL(outputUrl);
        if (url.pathname.includes('/storage/v1/object/')) return null;
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

type AuthenticateRequestDependencies = {
    createServiceClient?: typeof createServiceClient;
    createUserClient?: typeof createUserClient;
    requireIdentity?: typeof requireIdentity;
};

/**
 * Authenticates the request and returns the userId + scoped Supabase client.
 * Returns a NextResponse error if authentication fails.
 */
export async function authenticateRequest(
    request: Request,
    dependencies: AuthenticateRequestDependencies = {},
): Promise<AuthResult | NextResponse> {
    const createScopedClient = dependencies.createUserClient ?? createUserClient;
    const createAdminClient = dependencies.createServiceClient ?? createServiceClient;
    const admitIdentity = dependencies.requireIdentity ?? requireIdentity;
    const supabase = createScopedClient(request);
    const result = await admitIdentity(supabase, createAdminClient);

    if (!result.ok) {
        return NextResponse.json(
            { error: result.error, code: result.code },
            { status: result.status },
        );
    }

    return { userId: result.identity.userId, supabase };
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
