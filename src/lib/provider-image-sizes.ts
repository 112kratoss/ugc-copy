import 'server-only';

import { lookup as dnsLookup } from 'node:dns/promises';
import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendWarning } from '@/lib/backend-logger';
import { GenerationServiceError } from '@/lib/generation-service-core';
import {
  providerImageSizeViolation,
  providerRequestImages,
} from '@/lib/provider-image-limits';
import { isAllowlistedRemoteMediaUrl, isPrivateOrSpecialIp } from '@/lib/remote-media-security';
import {
  getCanonicalStoredMediaLocation,
  getUserOwnedStoredMediaLocation,
} from '@/lib/storage-ownership';
import { UPLOAD_RESERVATIONS_TABLE } from '@/lib/upload-finalization';

/**
 * The sizes of the pictures a run sends its provider, learned without downloading any of
 * them, so a start can hold them to the provider's limits (provider-image-limits) before
 * it holds the run's credits. Each kind of link is sized the cheapest reliable way:
 *
 * - the caller's uploads (`uploads`, `template_inputs`): the size Storage reported when the
 *   upload was finalized, from one indexed read of `upload_byte_reservations` for the whole
 *   run (unique on bucket and path);
 * - the caller's other objects (generated and remix-imported pictures), an upload whose
 *   reservation cannot vouch for it, and a template's own asset in a run of that template:
 *   the object's metadata from Storage, one request each;
 * - any other https link (someone else's object by a link signed for the caller, or a
 *   picture on a media host): a HEAD, sent only to the project's Supabase host or a host
 *   operators allow media imports from (MEDIA_IMPORT_HOST_ALLOWLIST).
 *
 * They all run at once, and none is waited on past two seconds. A size that cannot be
 * learned (a prepared asset id, a lookup that fails or runs out of time, an answer with no
 * length) is null, and a picture of unknown size is never refused. Another account's
 * object is never read by its path, only through a link it was signed for, so a refusal
 * tells nobody the size of a file they cannot read.
 */

/** Staging buckets whose every object arrives by a signed upload with a reservation. */
const RESERVED_UPLOAD_BUCKETS = new Set(['uploads', 'template_inputs']);

/** A reservation in one of these states is for an object that is gone or going. */
const RETIRED_RESERVATION_STATUSES = new Set(['reclaiming', 'deleted', 'released']);

const LOOKUP_TIMEOUT_MS = 2_000;
const MAX_REDIRECTS = 3;

export type ImageSizeLookupContext = {
  /** A service-role client: reservations are service-role only, and so is reading metadata. */
  supabase: SupabaseClient;
  userId: string;
  /** In a template run, its own catalog assets may be sized. */
  templateAssetScope?: { templateId: string; templateVersionId: string | null };
};

type HostAddress = { address: string; family: number };

export type ImageSizeLookupDependencies = {
  fetcher?: typeof fetch;
  lookupHost?: (hostname: string) => Promise<HostAddress[]>;
  /** Hosts a HEAD may reach; by default the project's Supabase host and the media import allowlist. */
  allowedHosts?: readonly string[];
  /** How long the lookups are waited on, together. */
  timeoutMs?: number;
};

type StoredObject = { bucket: string; path: string };

type SizeSource =
  | ({ kind: 'upload' } & StoredObject)
  | ({ kind: 'object' } & StoredObject)
  | { kind: 'head'; url: string }
  | { kind: 'none' };

type HeadOptions = {
  fetcher: typeof fetch;
  lookupHost: (hostname: string) => Promise<HostAddress[]>;
  allowedHosts: readonly string[];
  /** The project's own Supabase host, whose addresses need no check. */
  supabaseHost: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function configuredSupabaseHost(): string | null {
  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  if (!configured) return null;
  try {
    return normalizeHost(new URL(configured).hostname);
  } catch {
    return null;
  }
}

function headOptions(dependencies: ImageSizeLookupDependencies): HeadOptions {
  const supabaseHost = configuredSupabaseHost();
  const mediaHosts = (process.env.MEDIA_IMPORT_HOST_ALLOWLIST ?? '').split(',').map(normalizeHost).filter(Boolean);
  return {
    fetcher: dependencies.fetcher ?? fetch,
    lookupHost: dependencies.lookupHost ?? ((hostname) => dnsLookup(hostname, { all: true, verbatim: true })),
    allowedHosts: dependencies.allowedHosts ?? [...(supabaseHost ? [supabaseHost] : []), ...mediaHosts],
    supabaseHost,
  };
}

function sizeSource(url: string, context: ImageSizeLookupContext): SizeSource {
  const owned = getUserOwnedStoredMediaLocation(url, context.userId);
  if (owned) {
    return {
      kind: RESERVED_UPLOAD_BUCKETS.has(owned.bucket) ? 'upload' : 'object',
      bucket: owned.bucket,
      path: owned.filePath,
    };
  }
  const scope = context.templateAssetScope;
  if (scope) {
    const asset = getCanonicalStoredMediaLocation(url, { allowedBuckets: ['template_assets'] });
    const prefix = scope.templateVersionId
      ? `${scope.templateId}/${scope.templateVersionId}/`
      : `${scope.templateId}/`;
    if (asset?.filePath.startsWith(prefix)) return { kind: 'object', bucket: asset.bucket, path: asset.filePath };
  }
  return /^https:\/\//i.test(url) ? { kind: 'head', url } : { kind: 'none' };
}

function byteCount(value: unknown): number | null {
  const count = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** Settles with `work`, or rejects once `signal` aborts; whatever `work` was doing is left to finish. */
function untilAborted<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Image size lookup timed out.'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** The finalized size of each upload whose reservation vouches for it, keyed `bucket/path`. */
async function reservedUploadSizes(
  uploads: readonly StoredObject[],
  context: ImageSizeLookupContext,
  signal: AbortSignal,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (uploads.length === 0) return sizes;
  try {
    const { data, error } = await untilAborted(
      context.supabase
        .from(UPLOAD_RESERVATIONS_TABLE)
        .select('bucket_id, storage_path, actual_bytes, finalization_status')
        .eq('user_id', context.userId)
        .in('bucket_id', [...new Set(uploads.map((upload) => upload.bucket))])
        .in('storage_path', [...new Set(uploads.map((upload) => upload.path))]),
      signal,
    );
    if (error || !Array.isArray(data)) return sizes;
    for (const row of data as unknown[]) {
      if (!isRecord(row) || RETIRED_RESERVATION_STATUSES.has(String(row.finalization_status))) continue;
      // Taken from Storage's own metadata when the upload was finalized; never the size the client declared.
      const size = byteCount(row.actual_bytes);
      if (size !== null) sizes.set(`${row.bucket_id}/${row.storage_path}`, size);
    }
  } catch {
    // Each upload falls back to its object's metadata.
  }
  return sizes;
}

async function storedObjectSize(
  object: StoredObject,
  context: ImageSizeLookupContext,
  signal: AbortSignal,
): Promise<number | null> {
  try {
    const { data, error } = await untilAborted(context.supabase.storage.from(object.bucket).info(object.path), signal);
    if (error || !isRecord(data)) return null;
    const metadata = isRecord(data.metadata) ? data.metadata : null;
    return byteCount(data.size ?? metadata?.size);
  } catch {
    return null;
  }
}

/** The Content-Length a HEAD is answered with, following redirects only to hosts it may ask. */
async function headContentLength(url: string, options: HeadOptions, signal: AbortSignal): Promise<number | null> {
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!isAllowlistedRemoteMediaUrl(current, options.allowedHosts)) return null;
      const host = normalizeHost(new URL(current).hostname);
      if (host !== options.supabaseHost) {
        const addresses = await untilAborted(options.lookupHost(host), signal);
        if (addresses.length === 0 || addresses.some(({ address }) => isPrivateOrSpecialIp(address))) return null;
      }
      const response = await untilAborted(
        options.fetcher(current, { method: 'HEAD', redirect: 'manual', signal }),
        signal,
      );
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return null;
        current = new URL(location, current).toString();
        continue;
      }
      return response.ok ? byteCount(response.headers.get('content-length')) : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The size in bytes of each link, or null where it cannot be learned. Each distinct link
 * is looked up once, and every lookup runs at the same time.
 */
export async function lookupImageSizes(
  urls: readonly string[],
  context: ImageSizeLookupContext,
  dependencies: ImageSizeLookupDependencies = {},
): Promise<Map<string, number | null>> {
  const sources = [...new Set(urls)].map((url) => [url, sizeSource(url.trim(), context)] as const);
  if (sources.every(([, source]) => source.kind === 'none')) {
    return new Map(sources.map(([url]) => [url, null]));
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), dependencies.timeoutMs ?? LOOKUP_TIMEOUT_MS);
  try {
    const { signal } = deadline;
    const uploads = sources.flatMap(([, source]) => (source.kind === 'upload' ? [source] : []));
    const reserved = reservedUploadSizes(uploads, context, signal);
    const head = sources.some(([, source]) => source.kind === 'head') ? headOptions(dependencies) : null;

    const entries = await Promise.all(sources.map(async ([url, source]): Promise<[string, number | null]> => {
      switch (source.kind) {
        case 'upload':
          return [url, (await reserved).get(`${source.bucket}/${source.path}`) ?? await storedObjectSize(source, context, signal)];
        case 'object':
          return [url, await storedObjectSize(source, context, signal)];
        case 'head':
          return [url, head ? await headContentLength(source.url, head, signal) : null];
        default:
          return [url, null];
      }
    }));
    return new Map(entries);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refuses, before anything is held, a run whose provider request carries a picture larger
 * than Kie takes for its model. `request` is the body createTask will be sent, or a builder
 * of it: a builder that throws leaves the start to build the request after its hold and
 * answer the failure there, as it always has. Pictures in fields Kie sets no limit on are
 * never measured, so a model without limits costs nothing here.
 */
export async function assertProviderImageSizesAccepted(
  params: ImageSizeLookupContext & {
    /** The app's model id, which the refusal names. */
    modelId: string;
    request: unknown;
  },
  dependencies: ImageSizeLookupDependencies = {},
): Promise<void> {
  let request: unknown;
  try {
    request = typeof params.request === 'function' ? (params.request as () => unknown)() : params.request;
  } catch {
    return;
  }
  const images = providerRequestImages(request);
  if (images.length === 0) return;

  const sizes = await lookupImageSizes(images.map((image) => image.url), params, dependencies);
  const violation = providerImageSizeViolation(
    params.modelId,
    images.map((image) => ({ ...image, sizeBytes: sizes.get(image.url) ?? null })),
  );
  if (!violation) return;

  logBackendWarning('generation_input_image_over_provider_limit', {
    userId: params.userId,
    model: params.modelId,
    providerModel: isRecord(request) ? request.model : null,
  });
  throw new GenerationServiceError(violation, 400);
}
