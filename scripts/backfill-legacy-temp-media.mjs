import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
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
const SIGNATURE_PREFIX_BYTES = 64;
const SIGNATURE_TAIL_BYTES = 16;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_LIMITS = {
    generated_images: 25 * 1024 * 1024,
    generated_videos: 250 * 1024 * 1024,
};
const MIME_TARGETS = new Map([
    ['image/jpeg', { bucket: 'generated_images', extension: 'jpg', kind: 'image' }],
    ['image/png', { bucket: 'generated_images', extension: 'png', kind: 'image' }],
    ['image/webp', { bucket: 'generated_images', extension: 'webp', kind: 'image' }],
    ['video/mp4', { bucket: 'generated_videos', extension: 'mp4', kind: 'video' }],
    ['video/quicktime', { bucket: 'generated_videos', extension: 'mov', kind: 'video' }],
]);

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
        && /^[A-Za-z0-9_-]{1,200}$/.test(value);
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
    if (responseContentType !== null && responseContentType !== undefined) {
        const responseTarget = MIME_TARGETS.get(contentType);
        const expectedTarget = inferMediaTarget(generation, null);
        if (!responseTarget || !expectedTarget || responseTarget.kind !== expectedTarget.kind) return null;
        return { ...responseTarget, contentType };
    }
    const model = String(generation.model || '').toLowerCase();
    const category = String(generation.category || '').toLowerCase();
    const extensionMatch = pathname.match(/\.([a-z0-9]+)$/);
    const extensionFromPath = extensionMatch?.[1] ?? '';
    const isVideo = ['video', 'motion', 'ugc-ad'].includes(category)
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

    const isImage = category === 'image'
        || ['png', 'jpg', 'jpeg', 'webp'].includes(extensionFromPath);
    if (!isImage) return null;

    const extension = (extensionFromPath === 'jpeg' ? 'jpg' : extensionFromPath)
        || 'png';
    if (!['png', 'jpg', 'webp'].includes(extension)) return null;

    return {
        bucket: 'generated_images',
        extension,
        contentType: contentType || `image/${extension === 'jpg' ? 'jpeg' : extension}`,
        kind: 'image',
    };
}

function buildStorageTargetFromMedia(generation, media) {
    if (!safePathSegment(generation.user_id) || !safePathSegment(generation.prediction_id)) {
        return null;
    }
    if (!media) return null;
    const filePath = `${generation.user_id}/generated_${generation.prediction_id}.${media.extension}`;
    return {
        ...media,
        dbPath: `${media.bucket}/${filePath}`,
        filePath,
    };
}

export function buildStorageTarget(generation, responseContentType = null) {
    return buildStorageTargetFromMedia(
        generation,
        inferMediaTarget(generation, responseContentType),
    );
}

export function buildPotentialStorageTargets(generation) {
    const expected = inferMediaTarget(generation, null);
    if (!expected) return [];
    const targets = [];
    for (const [contentType, media] of MIME_TARGETS) {
        if (media.kind !== expected.kind) continue;
        const target = buildStorageTargetFromMedia(generation, { ...media, contentType });
        if (target) targets.push(target);
    }
    return targets;
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

function parseIpv4(address) {
    if (isIP(address) !== 4) return null;
    const octets = address.split('.').map(Number);
    return octets.length === 4
        && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
        ? octets
        : null;
}

function expandIpv6(address) {
    if (isIP(address) !== 6) return null;
    let normalized = address.toLowerCase().split('%')[0] ?? '';
    const ipv4Tail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (ipv4Tail) {
        const octets = parseIpv4(ipv4Tail);
        if (!octets) return null;
        normalized = normalized.slice(0, -ipv4Tail.length)
            + `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    }

    const halves = normalized.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
    const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
    if (groups.length !== 8 || groups.some((group) => !/^[a-f0-9]{1,4}$/.test(group))) return null;
    return groups.map((group) => Number.parseInt(group, 16));
}

export function isPrivateOrSpecialIp(address) {
    const ipv4 = parseIpv4(address);
    if (ipv4) {
        const [a, b, c] = ipv4;
        return a === 0
            || a === 10
            || a === 127
            || (a === 100 && b >= 64 && b <= 127)
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 0 && (c === 0 || c === 2))
            || (a === 192 && b === 88 && c === 99)
            || (a === 192 && b === 168)
            || (a === 198 && (b === 18 || b === 19))
            || (a === 198 && b === 51 && c === 100)
            || (a === 203 && b === 0 && c === 113)
            || a >= 224;
    }

    const words = expandIpv6(address);
    if (!words) return true;
    const [first, second, third, fourth, , sixth, seventh, eighth] = words;
    if (words.slice(0, 7).every((word) => word === 0) && eighth <= 1) return true;
    if (words.slice(0, 6).every((word) => word === 0)) return true;
    if (words.slice(0, 5).every((word) => word === 0) && sixth === 0xffff) {
        return isPrivateOrSpecialIp(`${seventh >> 8}.${seventh & 0xff}.${eighth >> 8}.${eighth & 0xff}`);
    }
    if ((first & 0xfe00) === 0xfc00) return true;
    if ((first & 0xffc0) === 0xfe80) return true;
    if ((first & 0xff00) === 0xff00) return true;
    if (first === 0x0100 && second === 0 && third === 0 && fourth === 0) return true;
    if (first === 0x2001 && second === 0x0db8) return true;
    if (first === 0x2001 && (second === 0 || second === 2 || (second >= 0x10 && second <= 0x1f))) return true;
    if (first === 0x0064 && second === 0xff9b && third === 1) return true;
    if (first === 0x2002) {
        const embedded = `${second >> 8}.${second & 0xff}.${third >> 8}.${third & 0xff}`;
        if (isPrivateOrSpecialIp(embedded)) return true;
    }
    return (first & 0xe000) !== 0x2000;
}

async function defaultDnsLookup(hostname) {
    return dnsLookup(hostname, { all: true, verbatim: true });
}

async function resolvePublicDns(hostname, lookup) {
    const literalFamily = isIP(hostname);
    const addresses = literalFamily
        ? [{ address: hostname, family: literalFamily }]
        : await lookup(hostname);
    if (
        !Array.isArray(addresses)
        || addresses.length === 0
        || addresses.some(({ address, family }) => (
            typeof address !== 'string'
            || ![4, 6].includes(Number(family))
            || isIP(address) !== Number(family)
            || isPrivateOrSpecialIp(address)
        ))
    ) {
        throw new Error('download host resolves to a private or unsafe address');
    }
    return addresses.map(({ address, family }) => ({ address, family: Number(family) }));
}

function createPinnedLookup(addresses) {
    return (_hostname, options, callback) => {
        const requestedFamily = typeof options === 'number'
            ? options
            : Number(options?.family || 0);
        const candidates = requestedFamily
            ? addresses.filter(({ family }) => family === requestedFamily)
            : addresses;
        if (candidates.length === 0) {
            const error = new Error('No validated address matches the requested family');
            error.code = 'ENOTFOUND';
            callback(error);
            return;
        }
        if (typeof options === 'object' && options?.all) {
            callback(null, candidates);
            return;
        }
        callback(null, candidates[0].address, candidates[0].family);
    };
}

async function fetchPinnedHttpsResponse(url, addresses) {
    return new Promise((resolve, reject) => {
        const request = httpsRequest(url, {
            method: 'GET',
            headers: { Accept: 'image/*, video/*' },
            lookup: createPinnedLookup(addresses),
            signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        }, (response) => {
            const status = Number(response.statusCode || 0);
            const headers = new Headers();
            for (const [name, rawValue] of Object.entries(response.headers)) {
                if (Array.isArray(rawValue)) {
                    for (const value of rawValue) headers.append(name, value);
                } else if (rawValue !== undefined) {
                    headers.set(name, rawValue);
                }
            }
            resolve({
                body: Readable.toWeb(response),
                headers,
                ok: status >= 200 && status < 300,
                status,
            });
        });
        request.on('error', reject);
        request.end();
    });
}

async function fetchLegacyResponse(rawUrl, fetcher = null, lookup = defaultDnsLookup) {
    let url = parseDownloadUrl(rawUrl, { initial: true });

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
        const addresses = await resolvePublicDns(url.hostname, lookup);
        // Tests may inject a controlled fetcher. Real operator runs use the
        // pinned HTTPS request so DNS cannot change between validation and use.
        const response = fetcher
            ? await fetcher(url, {
                method: 'GET',
                redirect: 'manual',
                signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
                headers: { Accept: 'image/*, video/*' },
            })
            : await fetchPinnedHttpsResponse(url, addresses);

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

function ascii(bytes, start, length) {
    return String.fromCharCode(...bytes.subarray(start, start + length));
}

function uint32BigEndian(bytes, offset) {
    return ((bytes[offset] * 0x1000000)
        + (bytes[offset + 1] << 16)
        + (bytes[offset + 2] << 8)
        + bytes[offset + 3]) >>> 0;
}

function uint32LittleEndian(bytes, offset) {
    return (bytes[offset]
        + (bytes[offset + 1] << 8)
        + (bytes[offset + 2] << 16)
        + (bytes[offset + 3] * 0x1000000)) >>> 0;
}

function isRecognizedMp4Brand(brand) {
    return /^(?:isom|iso[2-9]|avc[1-9]|mp4[1-9]|dash|M4(?:[ABP] |V[ HP])|F4[ABPV] |MSNV|3g[p2e][0-9a-z])$/.test(brand);
}

function hasMediaSignature(prefix, tail, totalBytes, contentType) {
    if (contentType === 'image/jpeg') {
        return totalBytes >= 5
            && prefix[0] === 0xff
            && prefix[1] === 0xd8
            && prefix[2] === 0xff
            && tail[tail.length - 2] === 0xff
            && tail[tail.length - 1] === 0xd9;
    }
    if (contentType === 'image/png') {
        return totalBytes >= 20
            && prefix[0] === 0x89
            && ascii(prefix, 1, 3) === 'PNG'
            && prefix[4] === 0x0d
            && prefix[5] === 0x0a
            && prefix[6] === 0x1a
            && prefix[7] === 0x0a
            && ascii(tail, tail.length - 8, 4) === 'IEND'
            && tail[tail.length - 4] === 0xae
            && tail[tail.length - 3] === 0x42
            && tail[tail.length - 2] === 0x60
            && tail[tail.length - 1] === 0x82;
    }
    if (contentType === 'image/webp') {
        return totalBytes >= 12
            && ascii(prefix, 0, 4) === 'RIFF'
            && ascii(prefix, 8, 4) === 'WEBP'
            && uint32LittleEndian(prefix, 4) + 8 === totalBytes;
    }
    if (contentType === 'video/mp4' || contentType === 'video/quicktime') {
        if (totalBytes < 16 || ascii(prefix, 4, 4) !== 'ftyp') return false;
        const boxSize = uint32BigEndian(prefix, 0);
        if (boxSize < 16 || boxSize > totalBytes) return false;
        const brands = [ascii(prefix, 8, 4)];
        const availableBoxBytes = Math.min(boxSize, prefix.length);
        for (let offset = 16; offset + 4 <= availableBoxBytes; offset += 4) {
            brands.push(ascii(prefix, offset, 4));
        }
        if (contentType === 'video/quicktime') return brands[0] === 'qt  ';
        return brands[0] !== 'qt  ' && brands.some(isRecognizedMp4Brand);
    }
    return false;
}

function assertMediaSignature(prefix, tail, totalBytes, target) {
    if (!hasMediaSignature(prefix, tail, totalBytes, target.contentType)) {
        throw new Error('media bytes do not match the declared content type');
    }
}

function readDeclaredContentLength(response, maxBytes) {
    const rawValue = response.headers.get('content-length');
    if (rawValue === null) return null;
    const normalized = rawValue.trim();
    if (!/^\d+$/.test(normalized)) throw new Error('download returned an invalid content length');
    const contentLength = Number(normalized);
    if (!Number.isSafeInteger(contentLength) || contentLength > maxBytes) {
        throw new Error(`download exceeds ${maxBytes} bytes`);
    }
    return contentLength;
}

async function readBoundedResponse(response, target, { collect }) {
    const maxBytes = MEDIA_LIMITS[target.bucket];
    const responseContentType = String(response.headers.get('content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
    if (responseContentType !== target.contentType) {
        await response.body?.cancel();
        throw new Error('download content type changed before persistence');
    }
    let contentLength;
    try {
        contentLength = readDeclaredContentLength(response, maxBytes);
    } catch (error) {
        await response.body?.cancel();
        throw error;
    }
    if (!response.body) throw new Error('download returned an empty body');

    const reader = response.body.getReader();
    const destination = collect && contentLength !== null
        ? Buffer.allocUnsafe(contentLength)
        : null;
    const chunks = collect && destination === null ? [] : null;
    let prefix = Buffer.alloc(0);
    let tail = Buffer.alloc(0);
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            const chunk = Buffer.from(value);
            const nextTotal = totalBytes + chunk.byteLength;
            if (nextTotal > maxBytes || (contentLength !== null && nextTotal > contentLength)) {
                await reader.cancel('download is too large');
                throw new Error(contentLength !== null
                    ? 'download body does not match its declared content length'
                    : `download exceeds ${maxBytes} bytes`);
            }
            if (prefix.length < SIGNATURE_PREFIX_BYTES) {
                const remaining = SIGNATURE_PREFIX_BYTES - prefix.length;
                prefix = Buffer.concat([prefix, chunk.subarray(0, remaining)]);
            }
            tail = chunk.length >= SIGNATURE_TAIL_BYTES
                ? chunk.subarray(chunk.length - SIGNATURE_TAIL_BYTES)
                : Buffer.concat([tail, chunk]).subarray(-SIGNATURE_TAIL_BYTES);
            if (destination) chunk.copy(destination, totalBytes);
            else if (chunks) chunks.push(chunk);
            totalBytes = nextTotal;
        }
    } finally {
        reader.releaseLock();
    }
    if (totalBytes === 0) throw new Error('download returned an empty body');
    if (contentLength !== null && totalBytes !== contentLength) {
        throw new Error('download body does not match its declared content length');
    }
    assertMediaSignature(prefix, tail, totalBytes, target);
    if (!collect) return null;
    return destination ?? Buffer.concat(chunks, totalBytes);
}

function storageErrorStatus(error) {
    const status = Number(error?.status);
    if (Number.isFinite(status)) return status;
    const statusCode = Number(error?.statusCode);
    return Number.isFinite(statusCode) ? statusCode : null;
}

function storageObjectIsMissing(error) {
    const status = storageErrorStatus(error);
    const code = String(error?.statusCode ?? error?.code ?? '').trim().toLowerCase();
    const message = String(error?.message ?? '').trim().toLowerCase();
    return status === 404
        || code === '404'
        || code === 'not_found'
        || code === 'nosuchkey'
        || (status === 400 && message === 'object not found');
}

function normalizedContentType(value) {
    return String(value || '').split(';')[0].trim().toLowerCase();
}

async function storageObjectExists(supabase, target) {
    const result = await supabase.storage.from(target.bucket).info(target.filePath);
    if (result.data) {
        const size = Number(result.data.size);
        const contentType = normalizedContentType(result.data.contentType);
        if (
            !Number.isSafeInteger(size)
            || size <= 0
            || size > MEDIA_LIMITS[target.bucket]
            || contentType !== target.contentType
        ) {
            throw new Error('existing storage object has an invalid size or content type');
        }

        const download = await supabase.storage.from(target.bucket).download(target.filePath);
        if (download.error || !download.data) throw download.error ?? new Error('existing storage object could not be read');
        if (
            download.data.size <= 0
            || download.data.size > MEDIA_LIMITS[target.bucket]
            || download.data.size !== size
            || normalizedContentType(download.data.type) !== target.contentType
        ) throw new Error('existing storage object bytes do not match its metadata');
        const [prefix, tail] = await Promise.all([
            download.data.slice(0, SIGNATURE_PREFIX_BYTES).arrayBuffer(),
            download.data.slice(-SIGNATURE_TAIL_BYTES).arrayBuffer(),
        ]);
        assertMediaSignature(Buffer.from(prefix), Buffer.from(tail), size, target);
        return true;
    }
    if (result.error && storageObjectIsMissing(result.error)) return false;
    if (result.error) throw result.error;
    throw new Error('storage object lookup returned no metadata or explicit not-found error');
}

async function findExistingStorageTarget(supabase, generation) {
    const matches = [];
    for (const target of buildPotentialStorageTargets(generation)) {
        if (await storageObjectExists(supabase, target)) matches.push(target);
    }
    if (matches.length > 1) {
        throw new Error('multiple deterministic storage objects exist for this generation');
    }
    return matches[0] ?? null;
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
    if (
        !Number.isSafeInteger(generationResult.count)
        || generationResult.count < 0
        || !Number.isSafeInteger(postResult.count)
        || postResult.count < 0
    ) {
        throw new Error('database did not return exact media reference counts');
    }
    return generationResult.count > 0 || postResult.count > 0;
}

async function fetchLinkedPosts(supabase, generation, target) {
    const { data, error } = await supabase
        .from('posts')
        .select('id, user_id, output_url')
        .eq('generation_id', generation.id);
    if (error) throw error;

    if (!Array.isArray(data)) throw new Error('linked post lookup returned an invalid response');
    const posts = data;
    const conflicting = posts.find((post) => (
        post.user_id !== generation.user_id
        || (
            post.output_url !== generation.output_url
            && post.output_url !== target.dbPath
            && post.output_url !== null
        )
    ));
    if (conflicting) {
        throw new Error(`linked post ${conflicting.id} conflicts with the generation owner or output URL`);
    }
    return posts;
}

async function relinkGenerationAndPosts(supabase, generation, target) {
    const { data, error } = await supabase.rpc('relink_legacy_generation_media', {
        p_generation_id: generation.id,
        p_expected_output_url: generation.output_url,
        p_new_output_url: target.dbPath,
    });
    if (error) throw error;
    const postsChanged = Number(data?.posts_changed);
    if (
        !data
        || Array.isArray(data)
        || !['relinked', 'already_relinked'].includes(data.status)
        || data.generation_id !== generation.id
        || data.output_url !== target.dbPath
        || typeof data.generation_changed !== 'boolean'
        || (data.status === 'relinked') !== data.generation_changed
        || !Number.isSafeInteger(postsChanged)
        || postsChanged < 0
    ) {
        throw new Error('atomic legacy media relink returned an invalid response');
    }
    return postsChanged;
}

async function fetchLegacyGenerations(supabase, generationId) {
    const allRows = [];
    const pageSize = 100;

    for (let page = 0; ; page += 1) {
        const from = page * pageSize;
        const to = from + pageSize - 1;
        let query = supabase
            .from('generations')
            .select('id, user_id, prediction_id, output_url, model, category, created_at')
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
    fetcher = null,
    lookup = defaultDnsLookup,
    logger = console,
}) {
    const generations = await fetchLegacyGenerations(supabase, generationId);
    logger.log(`Found ${generations.length} legacy media record(s) on ${LEGACY_HOST}.`);

    let migrated = 0;
    let skipped = 0;
    let failed = generationId && generations.length === 0 ? 1 : 0;
    if (failed > 0) {
        logger.log(`[fail] generation ${generationId} is not a pending legacy-media candidate`);
    }

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
        let linkedPostsChecked = false;
        try {
            const existingTarget = await findExistingStorageTarget(supabase, generation);
            let existingObject = Boolean(existingTarget);
            if (existingTarget) target = existingTarget;

            if (!existingTarget) {
                const response = await fetchLegacyResponse(generation.output_url, fetcher, lookup);
                if (!response.ok) {
                    await response.body?.cancel();
                    throw new Error(`download returned ${response.status}`);
                }

                const responseContentType = response.headers.get('content-type');
                if (!responseContentType) {
                    await response.body?.cancel();
                    throw new Error('download did not declare a content type');
                }
                const responseTarget = buildStorageTarget(
                    generation,
                    responseContentType,
                );
                if (!responseTarget || responseTarget.bucket !== initialTarget.bucket) {
                    await response.body?.cancel();
                    throw new Error('download content type does not match the generation');
                }
                target = responseTarget;
                const fileBuffer = await readBoundedResponse(response, target, {
                    collect: !dryRun,
                });
                existingObject = await storageObjectExists(supabase, target);
                await fetchLinkedPosts(supabase, generation, target);
                linkedPostsChecked = true;

                if (!dryRun && !existingObject) {
                    if (!fileBuffer) throw new Error('downloaded media buffer is unavailable');
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

            if (!linkedPostsChecked) await fetchLinkedPosts(supabase, generation, target);

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
                        logger.error(`[warn] ${generation.id} retained uploaded media for a safe deterministic retry after relinking failed`);
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
