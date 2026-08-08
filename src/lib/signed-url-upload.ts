import { SHOWCASE_PUBLIC_MEDIA_CACHE_TTL_SECONDS } from '@/lib/showcase-media-cache';
import { UploadCancelledError } from '@/lib/upload-queue';

/**
 * PUT a file to a Supabase signed upload URL with byte progress.
 *
 * supabase-js cannot report progress: `uploadToSignedUrl` wraps the body in
 * FormData and posts it through `fetch`, and the Fetch API exposes no
 * upload-progress events. XHR is the only browser API that does, so this issues
 * the raw PUT the mobile client already uses against the same endpoint.
 *
 * No API change was needed for this -- `signedUploadUrl` has always been in the
 * sign response, the clients just never read it.
 */

export interface SignedUrlUploadProgress {
  bytesSent: number;
  totalBytes: number;
  fraction: number;
}

/**
 * Reconstructs the upload URL when the sign response omitted it, mirroring the
 * mobile fallback. The token form is what Storage expects for a signed PUT.
 */
export function resolveSignedUploadUrl(intent: {
  bucket: string;
  path: string;
  token: string;
  signedUploadUrl?: string | null;
  supabaseUrl?: string | null;
}): string {
  if (intent.signedUploadUrl) {
    return intent.signedUploadUrl;
  }

  const base = intent.supabaseUrl ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  if (!base) {
    throw new Error('Media upload response was invalid.');
  }

  const url = new URL(`${base.replace(/\/+$/, '')}/storage/v1/object/upload/sign/${intent.bucket}/${intent.path}`);
  url.searchParams.set('token', intent.token);
  return url.toString();
}

function parseUploadFailure(status: number, body: string | null): string {
  const generic = `Upload failed with status ${status}.`;
  if (!body) return generic;

  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string };
    const message = parsed.message || parsed.error;
    return typeof message === 'string' && message.trim() ? message.trim().slice(0, 240) : generic;
  } catch {
    return generic;
  }
}

export function uploadFileToSignedUrl(
  file: File | Blob,
  signedUploadUrl: string,
  {
    mimeType,
    onProgress,
    signal,
    createRequest = () => new XMLHttpRequest(),
  }: {
    mimeType: string;
    onProgress?: (progress: SignedUrlUploadProgress) => void;
    signal?: AbortSignal;
    createRequest?: () => XMLHttpRequest;
  },
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new UploadCancelledError());
  }

  return new Promise<void>((resolve, reject) => {
    const request = createRequest();
    const totalBytes = file.size;
    let settled = false;

    const abort = () => {
      if (settled) return;
      settled = true;
      request.abort();
      reject(new UploadCancelledError());
    };

    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
    };

    signal?.addEventListener('abort', abort, { once: true });

    request.upload.onprogress = (event) => {
      const total = event.lengthComputable && event.total > 0 ? event.total : totalBytes;
      const bytesSent = Math.min(total, Math.max(0, event.loaded));
      onProgress?.({
        bytesSent,
        totalBytes: total,
        fraction: total > 0 ? bytesSent / total : 0,
      });
    };

    request.onload = () => {
      if (settled) return;
      settled = true;
      cleanup();

      if (request.status >= 200 && request.status < 300) {
        onProgress?.({ bytesSent: totalBytes, totalBytes, fraction: 1 });
        resolve();
        return;
      }

      reject(new Error(parseUploadFailure(request.status, request.responseText)));
    };

    request.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Upload failed. Check your connection and try again.'));
    };

    request.onabort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new UploadCancelledError());
    };

    request.open('PUT', signedUploadUrl, true);
    // The same headers the mobile client sends to this endpoint. supabase-js
    // sends cacheControl as a multipart field instead; Storage accepts both, but
    // the raw PUT needs it as a header.
    //
    // Publish copies this object server-side into the public bucket, and a copy
    // carries the source's cache-control with no way to override it, so this
    // header is what public viewers ultimately receive. It tracks the public
    // policy rather than sitting at a value of its own.
    request.setRequestHeader('cache-control', `max-age=${SHOWCASE_PUBLIC_MEDIA_CACHE_TTL_SECONDS}`);
    request.setRequestHeader('content-type', mimeType);
    request.setRequestHeader('x-upsert', 'false');
    request.send(file);
  });
}
