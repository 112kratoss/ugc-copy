/** Signed Supabase TUS transport. No auth session, platform or filesystem imports. */
export const RESUMABLE_CHUNK_BYTES = 6 * 1024 * 1024;
const RETRY_DELAYS = [0, 3000, 5000, 10000, 20000];
export type UploadProgress = { bytesSent: number; totalBytes: number; fraction: number };
export type ResumableTarget = { endpoint: string; token: string; bucket: string; path: string };

export function signedResumableTarget(signedUrl: string): ResumableTarget | null {
  const url = new URL(signedUrl);
  const match = url.pathname.match(/^\/storage\/v1\/object\/upload\/sign\/([^/]+)\/(.+)$/);
  const token = url.searchParams.get('token');
  if (!match || !token) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) return null;
  // Supabase recommends the direct Storage hostname for large transfers.
  url.hostname = url.hostname.replace(/^([a-z0-9-]+)\.supabase\.co$/, '$1.storage.supabase.co');
  return { endpoint: `${url.origin}/storage/v1/upload/resumable/sign`, token, bucket: decodeURIComponent(match[1]), path: decodeURIComponent(match[2]) };
}

function cancelled(): Error { const error = new Error('Upload cancelled.'); error.name = 'UploadCancelledError'; return error; }
class TransferError extends Error { constructor(readonly status: number) { super(`Upload failed (${status}). Please try again.`); } }
function checkSignal(signal?: AbortSignal) { if (signal?.aborted) throw cancelled(); }
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(cancelled()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}
function offsetOf(response: Response, size: number): number {
  const value = response.headers.get('Upload-Offset');
  const offset = Number(value);
  if (value === null || !/^\d+$/.test(value) || !Number.isSafeInteger(offset) || offset < 0 || offset > size) throw new TransferError(502);
  return offset;
}
function metadata(value: string): string { return btoa(String.fromCharCode(...new TextEncoder().encode(value))); }

export async function uploadResumable({ target, size, contentType, readChunk, signal, onProgress, fetchImpl = fetch, wait = pause }: {
  target: ResumableTarget;
  size: number;
  contentType: string;
  readChunk: (start: number, end: number) => Promise<BodyInit> | BodyInit;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  fetchImpl?: typeof fetch;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<void> {
  checkSignal(signal);
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Invalid upload size');
  const headers = { 'Tus-Resumable': '1.0.0', 'x-signature': target.token, 'x-upsert': 'false' };
  async function request(url: string, init: RequestInit) {
    checkSignal(signal);
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    // A bounded chunk timeout; a timed-out chunk resumes at Storage's offset.
    const timer = setTimeout(stop, 120_000);
    try {
      const response = await fetchImpl(url, { ...init, headers: { ...headers, ...init.headers }, signal: controller.signal, redirect: 'error' });
      checkSignal(signal);
      if (!response.ok) throw new TransferError(response.status);
      return response;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
  }
  let uploadUrl: string | null = null;
  let offset = 0;
  let failures = 0;
  let needsHead = false;
  while (offset < size) {
    checkSignal(signal);
    try {
      if (!uploadUrl) {
        const created = await request(target.endpoint, { method: 'POST', headers: {
          'Upload-Length': String(size),
          'Upload-Metadata': Object.entries({ bucketName: target.bucket, objectName: target.path, contentType, cacheControl: '86400' })
            .map(([key, value]) => `${key} ${metadata(value)}`).join(','),
        } });
        const location = created.headers.get('Location');
        if (!location) throw new TransferError(502);
        const parsed = new URL(location, target.endpoint);
        if (parsed.origin !== new URL(target.endpoint).origin || parsed.username || parsed.password
          || !parsed.pathname.startsWith('/storage/v1/upload/resumable/')) throw new TransferError(400);
        uploadUrl = parsed.href;
      }
      if (needsHead) {
        const response = await request(uploadUrl, { method: 'HEAD' });
        const confirmed = offsetOf(response, size);
        if (confirmed < offset) throw new TransferError(400);
        if (confirmed > offset) failures = 0;
        offset = confirmed;
        needsHead = false;
        onProgress?.({ bytesSent: offset, totalBytes: size, fraction: offset / size });
        if (offset === size) return;
      }
      const end = Math.min(size, offset + RESUMABLE_CHUNK_BYTES);
      const body = await readChunk(offset, end);
      checkSignal(signal);
      const response = await request(uploadUrl, { method: 'PATCH', body, headers: {
        'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset),
      } });
      if (offsetOf(response, size) !== end) throw new TransferError(502);
      offset = end;
      failures = 0;
      onProgress?.({ bytesSent: offset, totalBytes: size, fraction: offset / size });
    } catch (error) {
      checkSignal(signal);
      const retryable = !(error instanceof TransferError) || error.status === 409 || error.status === 429 || error.status >= 500;
      if (!retryable || failures >= RETRY_DELAYS.length) throw error;
      // Never retransmit blindly after an ambiguous PATCH result, including
      // the final chunk. HEAD may prove that the whole upload already finished.
      needsHead = uploadUrl !== null;
      await wait(RETRY_DELAYS[failures++], signal);
    }
  }
}
