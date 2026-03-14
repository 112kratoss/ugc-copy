/**
 * Shared server-side helpers for API routes.
 * Centralizes Supabase client creation, user authentication,
 * and credit deduction logic to eliminate duplication.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const KIE_API_KEY = process.env.KIE_AI_API_KEY;

// ─── Supabase Client Factories ────────────────────────────────────────────────

/** Creates a Supabase client scoped to the calling user's JWT. */
export function createUserClient(request: NextRequest): SupabaseClient {
    return createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            global: { headers: { Authorization: request.headers.get('Authorization')! } },
        }
    );
}

/** Creates a privileged Supabase client for server-only operations (webhooks, service tasks). */
export function createServiceClient(): SupabaseClient {
    return createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
}

export type MediaBucket = 'generated_images' | 'generated_videos';

export function isMediaBucket(bucket: string): bucket is MediaBucket {
    return bucket === 'generated_images' || bucket === 'generated_videos';
}

export function getStoredMediaLocation(outputUrl: string): { bucket: MediaBucket; filePath: string } | null {
    if (outputUrl.startsWith('generated_images/')) {
        return {
            bucket: 'generated_images',
            filePath: outputUrl.replace('generated_images/', ''),
        };
    }

    if (outputUrl.startsWith('generated_videos/')) {
        return {
            bucket: 'generated_videos',
            filePath: outputUrl.replace('generated_videos/', ''),
        };
    }

    try {
        const url = new URL(outputUrl);
        const match = url.pathname.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)$/);

        if (!match) {
            return null;
        }

        const [, bucket, rawPath] = match;
        if (!isMediaBucket(bucket)) {
            return null;
        }

        return {
            bucket,
            filePath: decodeURIComponent(rawPath),
        };
    } catch {
        return null;
    }
}

/**
 * Converts stored media paths and legacy Supabase storage URLs into a fresh signed URL.
 * Returns the original value for non-storage URLs such as provider temp URLs.
 */
export async function signStoredMediaUrl(
    adminSupabase: SupabaseClient,
    outputUrl: string
): Promise<string> {
    const location = getStoredMediaLocation(outputUrl);

    if (!location) {
        return outputUrl;
    }

    const { data, error } = await adminSupabase.storage
        .from(location.bucket)
        .createSignedUrl(location.filePath, 3600);

    if (error || !data?.signedUrl) {
        console.error(`Failed to sign media URL for ${location.bucket}/${location.filePath}:`, error);
        return outputUrl;
    }

    return data.signedUrl;
}

export function buildMediaProxyUrl(bucket: MediaBucket, filePath: string): string {
    const params = new URLSearchParams({
        bucket,
        path: filePath,
    });

    return `/api/media?${params.toString()}`;
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

    if (!location) {
        return outputUrl;
    }

    const signedUrl = await signStoredMediaUrl(adminSupabase, outputUrl);
    if (signedUrl !== outputUrl) {
        return signedUrl;
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
    request: NextRequest
): Promise<AuthResult | NextResponse> {
    const supabase = createUserClient(request);
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error || !user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return { userId: user.id, supabase };
}

// ─── Credits ──────────────────────────────────────────────────────────────────

/**
 * Deducts credits from the user's profile.
 * Returns the remaining credit count, or a NextResponse error on failure.
 */
export async function deductCredits(
    supabase: SupabaseClient,
    userId: string,
    cost: number
): Promise<{ remainingCredits: number } | NextResponse> {
    const { data, error } = await supabase.rpc('use_credits', { amount: cost });

    if (error) {
        console.error('Credit deduction failed:', error);
        return NextResponse.json(
            { error: 'Insufficient credits or credit error' },
            { status: 402 }
        );
    }

    return { remainingCredits: data };
}

/**
 * Attempts to refund credits for a failed generation.
 * Calls the idempotent refund_generation RPC.
 */
export async function refundGeneration(
    supabase: SupabaseClient,
    predictionId: string
): Promise<void> {
    try {
        await supabase.rpc('refund_generation', { p_prediction_id: predictionId });
    } catch (err) {
        console.error(`Refund failed for prediction ${predictionId}:`, err);
    }
}

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

/**
 * Calls the Kie.ai prediction API.
 * Returns the parsed JSON response or throws on network errors.
 */
export async function callKieApi(
    endpoint: string,
    body: Record<string, unknown>
): Promise<{ data: Record<string, unknown>; status: number }> {
    const response = await fetch(`https://api.kie.ai/api/v1${endpoint}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${KIE_API_KEY}`,
        },
        body: JSON.stringify(body),
    });

    const data = await response.json();
    return { data, status: response.status };
}

/**
 * Fetches the status of a Kie.ai prediction.
 */
export async function getKiePredictionStatus(
    predictionId: string
): Promise<Record<string, unknown>> {
    const response = await fetch(
        `https://api.kie.ai/api/v1/predictions/${predictionId}`,
        {
            headers: { 'Authorization': `Bearer ${KIE_API_KEY}` },
        }
    );
    return response.json();
}

// ─── Generation Record ────────────────────────────────────────────────────────

export interface GenerationRecord {
    user_id: string;
    model: string;
    prediction_id: string;
    status: string;
    prompt?: string;
    cost: number;
    duration?: number;
}

/**
 * Inserts a generation record into the database.
 */
export async function insertGeneration(
    supabase: SupabaseClient,
    record: GenerationRecord
): Promise<void> {
    const { error } = await supabase.from('generations').insert(record);
    if (error) {
        console.error('Failed to insert generation record:', error);
    }
}
