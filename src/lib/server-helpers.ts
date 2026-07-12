/**
 * Shared server-side helpers for API routes.
 * Centralizes Supabase client creation, user authentication,
 * and credit deduction logic to eliminate duplication.
 */

import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { buildMediaProxyUrl, getStoredMediaLocation } from '@/lib/media-urls';

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
            console.error(`Failed to sign media URL for ${location.bucket}/${location.filePath}:`, error);
            return outputUrl;
        }

        return data.signedUrl;
    } catch (err) {
        console.error(`Error signing media URL for ${location.bucket}/${location.filePath}:`, err);
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
            console.error('resolveStoredMediaUrl: private template signing failed:', error);
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
        console.error('resolveStoredMediaUrl: signing failed, falling back to proxy:', err);
    }

    return buildMediaProxyUrl(location.bucket, location.filePath);
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
        console.error('KIE_AI_API_KEY not found in environment variables');
        return NextResponse.json(
            { error: 'Server configuration error: API key missing' },
            { status: 500 }
        );
    }
    return KIE_API_KEY;
}
