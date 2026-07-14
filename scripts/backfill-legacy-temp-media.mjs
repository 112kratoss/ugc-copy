import { pathToFileURL } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import {
    logBackfillExecutionMode,
    parseBackfillExecutionMode,
} from './backfill-execution-mode.mjs';

export const LEGACY_HOST = 'tempfile.aiquickdraw.com';

const LEGACY_DOWNLOAD_HOSTS = new Set([
    LEGACY_HOST,
    'file.aiquickdraw.com',
]);
const MAX_REDIRECTS = 3;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_LIMITS = {
    generated_images: 25 * 1024 * 1024,
    generated_videos: 250 * 1024 * 1024,
};

function readArgument(argv, name) {
    const prefix = `${name}=`;
    const inline = argv.filter((argument) => argument.startsWith(prefix));
    const positions = argv.flatMap((argument, index) => argument === name ? [index] : []);

    if (inline.length + positions.length > 1) {
        throw new Error(`${name} may only be supplied once.`);
    }
    if (inline.length === 1) {
        return inline[0].slice(prefix.length).trim();
    }
    if (positions.length === 1) {
        return String(argv[positions[0] + 1] ?? '').trim();
    }
    return null;
}

export function parseGenerationIdArgument(argv = process.argv.slice(2)) {
    const value = readArgument(argv, '--generation-id');
    if (value === null) return null;
    if (!UUID_PATTERN.test(value)) {
        throw new Error('--generation-id must be a canonical UUID.');
    }
    return value.toLowerCase();
}

function safePathSegment(value) {
    return typeof value === 'string'
        && value.length > 0
        && !value.includes('/')
        && !value.includes('\\')
        && value !== '.'
        && value !== '..';
}

export function inferMediaTarget(generation, responseContentType = null) {
    const pathname = (() => {
        try {
            return new URL(generation.output_url).pathname.toLowerCase();
        } catch {
            return '';
        }
    })();

    const contentType = String(responseContentType || '').split(';')[0].trim().toLowerCase();
    const hasResponseContentType = responseContentType !== null && responseContentType !== undefined;
    const allowedResponseContentTypes = new Set([
        'image/jpeg',
        'image/png',
        'image/webp',
        'video/mp4',
        'video/quicktime',
    ]);
    if (hasResponseContentType && !allowedResponseContentTypes.has(contentType)) {
        return null;
    }
    const model = String(generation.model || '').toLowerCase();
    const category = String(generation.category || '').toLowerCase();
    const extensionMatch = pathname.match(/\.([a-z0-9]+)$/);
    const extensionFromPath = extensionMatch?.[1] ?? '';
    const isVideo = contentType.startsWith('video/')
        || ['video', 'motion', 'ugc-ad'].includes(category)
        || ['mp4', 'mov'].includes(extensionFromPath)
        || model.includes('motion-control')
        || model.startsWith('kling');

    if (isVideo) {
        return {
            bucket: 'generated_videos',
            extension: extensionFromPath === 'mov' ? 'mov' : 'mp4',
            contentType: contentType || (extensionFromPath === 'mov' ? 'video/quicktime' : 'video/mp4'),
            kind: 'video',
        };
    }

    const isImage = contentType.startsWith('image/')
        || category === 'image'
        || ['png', 'jpg', 'jpeg', 'webp'].includes(extensionFromPath);
    if (!isImage) return null;

    const contentTypeExtension = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
    }[contentType];
    const extension = contentTypeExtension
        || (extensionFromPath === 'jpeg' ? 'jpg' : extensionFromPath)
        || 'png';
    if (!['png', 'jpg', 'webp'].includes(extension)) return null;

    return {
        bucket: 'generated_images',
        extension,
        contentType: contentType || `image/${extension === 'jpg' ? 'jpeg' : extension}`,
        kind: 'image',
    };
}

export function buildStorageTarget(generation, responseContentType = null) {
    if (!safePathSegment(generation.user_id) || !safePathSegment(generation.prediction_id)) {
        return null;
    }
    const media = inferMediaTarget(generation, responseContentType);
    if (!media) return null;
    const filePath = `${generation.user_id}/generated_${generation.prediction_id}.${media.extension}`;
    return {
        ...media,
        dbPath: `${media.bucket}/${filePath}`,
        filePath,
    };
}

function parseDownloadUrl(value, { initial = false } = {}) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('download URL is invalid');
    }

    const allowedHost = initial ? url.hostname === LEGACY_HOST : LEGACY_DOWNLOAD_HOSTS.has(url.hostname);
    if (
        url.protocol !== 'https:'
        || url.username
        || url.password
        || (url.port && url.port !== '443')
        || !allowedHost
    ) {
        throw new Error('download URL is not an allowed HTTPS provider URL');
    }
    return url;
}

async function fetchLegacyResponse(rawUrl, fetcher = fetch) {
    let url = parseDownloadUrl(rawUrl, { initial: true });

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
        const response = await fetcher(url, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
            headers: { Accept: 'image/*, video/*' },
        });

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location || redirectCount === MAX_REDIRECTS) {
                throw new Error('download redirect could not be followed safely');
            }
            await response.body?.cancel();
            url = parseDownloadUrl(new URL(location, url).toString());
            continue;
        }

        return response;
    }

    throw new Error('download redirect limit exceeded');
}

async function readBoundedResponse(response, maxBytes) {
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await response.body?.cancel();
        throw new Error(`download exceeds ${maxBytes} bytes`);
    }
    if (!response.body) throw new Error('download returned an empty body');

    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
                await reader.cancel('download is too large');
                throw new Error(`download exceeds ${maxBytes} bytes`);
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }
    if (totalBytes === 0) throw new Error('download returned an empty body');
    return Buffer.concat(chunks, totalBytes);
}

function storageErrorStatus(error) {
    const status = Number(error?.statusCode ?? error?.status);
    return Number.isFinite(status) ? status : null;
}

async function storageObjectExists(supabase, target) {
    const result = await supabase.storage.from(target.bucket).exists(target.filePath);
    if (result.data) return true;
    const status = storageErrorStatus(result.error);
    if (result.error && status !== 400 && status !== 404) throw result.error;
    return false;
}

async function removeUploadedObject(supabase, target) {
    const result = await supabase.storage.from(target.bucket).remove([target.filePath]);
    if (result.error) throw result.error;
}

async function storageTargetIsReferenced(supabase, target) {
    const [generationResult, postResult] = await Promise.all([
        supabase
            .from('generations')
            .select('id', { count: 'exact', head: true })
            .eq('output_url', target.dbPath),
        supabase
            .from('posts')
            .select('id', { count: 'exact', head: true })
            .eq('output_url', target.dbPath),
    ]);
    if (generationResult.error) throw generationResult.error;
    if (postResult.error) throw postResult.error;
    return (generationResult.count ?? 0) > 0 || (postResult.count ?? 0) > 0;
}

async function fetchLinkedPosts(supabase, generation, target) {
    const { data, error } = await supabase
        .from('posts')
        .select('id, output_url')
        .eq('generation_id', generation.id)
        .eq('user_id', generation.user_id);
    if (error) throw error;

    const posts = data ?? [];
    const conflicting = posts.find((post) => (
        post.output_url !== generation.output_url
        && post.output_url !== target.dbPath
        && post.output_url !== null
    ));
    if (conflicting) {
        throw new Error(`linked post ${conflicting.id} has a different output URL`);
    }
    return posts;
}

function generationRelinkValues(generation, dbPath) {
    const values = { output_url: dbPath };
    if (generation.preview_status === 'failed') {
        Object.assign(values, {
            preview_url: null,
            preview_thumbhash: null,
            preview_status: 'pending',
            preview_attempt_count: 0,
            preview_error: null,
            preview_generated_at: null,
        });
    }
    return values;
}

function generationRollbackValues(generation) {
    return {
        output_url: generation.output_url,
        preview_url: generation.preview_url,
        preview_thumbhash: generation.preview_thumbhash,
        preview_status: generation.preview_status,
        preview_attempt_count: generation.preview_attempt_count,
        preview_error: generation.preview_error,
        preview_generated_at: generation.preview_generated_at,
    };
}

async function relinkGenerationAndPosts(supabase, generation, target) {
    const linkedPosts = await fetchLinkedPosts(supabase, generation, target);
    const { data: updatedGenerations, error: generationError } = await supabase
        .from('generations')
        .update(generationRelinkValues(generation, target.dbPath))
        .eq('id', generation.id)
        .eq('user_id', generation.user_id)
        .eq('output_url', generation.output_url)
        .select('id');
    if (generationError) throw generationError;
    if (updatedGenerations?.length !== 1) {
        throw new Error('generation changed before it could be relinked');
    }

    const postIds = linkedPosts
        .filter((post) => post.output_url === generation.output_url)
        .map((post) => post.id);
    if (postIds.length === 0) return 0;

    const { data: updatedPosts, error: postError } = await supabase
        .from('posts')
        .update({ output_url: target.dbPath })
        .in('id', postIds)
        .eq('user_id', generation.user_id)
        .eq('output_url', generation.output_url)
        .select('id');
    if (!postError && updatedPosts?.length === postIds.length) return postIds.length;

    const { error: postRollbackError } = await supabase
        .from('posts')
        .update({ output_url: generation.output_url })
        .in('id', postIds)
        .eq('user_id', generation.user_id)
        .eq('output_url', target.dbPath);
    const { data: rolledBackGenerations, error: generationRollbackError } = await supabase
        .from('generations')
        .update(generationRollbackValues(generation))
        .eq('id', generation.id)
        .eq('user_id', generation.user_id)
        .eq('output_url', target.dbPath)
        .select('id');

    if (postRollbackError || generationRollbackError || rolledBackGenerations?.length !== 1) {
        throw new Error('linked post update failed and the compensating rollback was incomplete');
    }
    throw postError ?? new Error('linked post update count did not match');
}

async function fetchLegacyGenerations(supabase, generationId) {
    const allRows = [];
    const pageSize = 100;

    for (let page = 0; ; page += 1) {
        const from = page * pageSize;
        const to = from + pageSize - 1;
        let query = supabase
            .from('generations')
            .select('id, user_id, prediction_id, output_url, model, category, created_at, preview_url, preview_thumbhash, preview_status, preview_attempt_count, preview_error, preview_generated_at')
            .eq('status', 'succeeded')
            .like('output_url', `https://${LEGACY_HOST}/%`);
        if (generationId) query = query.eq('id', generationId);

        const { data, error } = await query
            .order('created_at', { ascending: true })
            .range(from, to);
        if (error) throw error;
        if (!data || data.length === 0) break;

        allRows.push(...data);
        if (data.length < pageSize) break;
    }

    return allRows;
}

export async function runBackfill({
    supabase,
    dryRun,
    generationId = null,
    fetcher = fetch,
    logger = console,
}) {
    const generations = await fetchLegacyGenerations(supabase, generationId);
    logger.log(`Found ${generations.length} legacy media record(s) on ${LEGACY_HOST}.`);

    let migrated = 0;
    let skipped = 0;
    let failed = 0;

    for (const generation of generations) {
        if (!generation.user_id || !generation.prediction_id || !generation.output_url) {
            skipped += 1;
            logger.log(`[skip] ${generation.id} is missing user_id, prediction_id, or output_url`);
            continue;
        }

        let parsedUrl;
        try {
            parsedUrl = parseDownloadUrl(generation.output_url, { initial: true });
        } catch (error) {
            failed += 1;
            logger.log(`[fail] ${generation.id} ${error instanceof Error ? error.message : 'has an invalid URL'}`);
            continue;
        }
        if (parsedUrl.hostname !== LEGACY_HOST) {
            skipped += 1;
            logger.log(`[skip] ${generation.id} is no longer on ${LEGACY_HOST}`);
            continue;
        }

        const initialTarget = buildStorageTarget(generation);
        if (!initialTarget) {
            failed += 1;
            logger.log(`[fail] ${generation.id} could not infer a safe target bucket/type`);
            continue;
        }

        let target = initialTarget;
        let uploaded = false;
        let relinked = false;
        try {
            const existingObject = await storageObjectExists(supabase, initialTarget);
            if (!existingObject) {
                const response = await fetchLegacyResponse(generation.output_url, fetcher);
                if (!response.ok) {
                    await response.body?.cancel();
                    throw new Error(`download returned ${response.status}`);
                }

                const responseTarget = buildStorageTarget(
                    generation,
                    response.headers.get('content-type'),
                );
                if (!responseTarget || responseTarget.bucket !== initialTarget.bucket) {
                    await response.body?.cancel();
                    throw new Error('download content type does not match the generation');
                }
                target = responseTarget;

                if (dryRun) {
                    const contentLength = Number(response.headers.get('content-length'));
                    if (Number.isFinite(contentLength) && contentLength > MEDIA_LIMITS[target.bucket]) {
                        await response.body?.cancel();
                        throw new Error(`download exceeds ${MEDIA_LIMITS[target.bucket]} bytes`);
                    }
                    await response.body?.cancel();
                } else {
                    const fileBuffer = await readBoundedResponse(response, MEDIA_LIMITS[target.bucket]);
                    const { error: uploadError } = await supabase.storage
                        .from(target.bucket)
                        .upload(target.filePath, fileBuffer, {
                            contentType: target.contentType,
                            upsert: false,
                        });
                    if (uploadError) throw uploadError;
                    uploaded = true;
                }
            }

            if (dryRun) {
                const action = existingObject ? 'reuse existing object' : 'download and persist';
                logger.log(`[dry-run] ${generation.id} -> ${target.dbPath} (${action})`);
                migrated += 1;
                continue;
            }

            const postCount = await relinkGenerationAndPosts(supabase, generation, target);
            relinked = true;
            migrated += 1;
            logger.log(`[ok] ${generation.id} -> ${target.dbPath} (${postCount} linked post(s))`);
        } catch (error) {
            if (uploaded && !relinked) {
                try {
                    const stillReferenced = await storageTargetIsReferenced(supabase, target);
                    if (stillReferenced) {
                        logger.error(`[warn] ${generation.id} retained uploaded media because a database row still references it`);
                    } else {
                        await removeUploadedObject(supabase, target);
                    }
                } catch (cleanupError) {
                    logger.error(`[warn] ${generation.id} retained uploaded media because cleanup safety could not be verified: ${cleanupError instanceof Error ? cleanupError.message : 'unknown error'}`);
                }
            }
            failed += 1;
            logger.log(`[fail] ${generation.id} ${error instanceof Error ? error.message : 'unexpected error'}`);
        }
    }

    logger.log('');
    logger.log('Backfill complete');
    logger.log(`Migrated: ${migrated}`);
    logger.log(`Skipped: ${skipped}`);
    logger.log(`Failed: ${failed}`);

    return {
        selected: generations.length,
        migrated,
        skipped,
        failed,
        exitCode: skipped > 0 || failed > 0 ? 1 : 0,
    };
}

export async function main(argv = process.argv.slice(2)) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
        throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment');
    }

    const executionMode = parseBackfillExecutionMode({ argv, supabaseUrl });
    const generationId = parseGenerationIdArgument(argv);
    logBackfillExecutionMode(executionMode);
    if (generationId) console.log(`Filtering to generation ${generationId}.`);

    const result = await runBackfill({
        supabase: createClient(supabaseUrl, serviceRoleKey),
        dryRun: executionMode.dryRun,
        generationId,
    });
    process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error('Backfill failed:', error);
        process.exitCode = 1;
    });
}
