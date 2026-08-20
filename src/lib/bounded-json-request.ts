export type BoundedJsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'invalid_json' | 'too_large' };

function parseContentLength(value: string | null): number | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function cancelBody(body: ReadableStream<Uint8Array> | null) {
  if (!body || body.locked) return;
  try {
    await body.cancel('JSON request body is too large');
  } catch {
    // Cancellation is best-effort. The response must still fail closed even if
    // the runtime has already closed or errored the request stream.
  }
}

/**
 * Reads and parses a JSON request without ever buffering more than `maxBytes`.
 *
 * Content-Length is only an early rejection hint. The stream itself is always
 * counted so an absent or dishonest header cannot bypass the limit.
 */
export async function readBoundedJsonBody(
  request: Pick<Request, 'body' | 'headers'>,
  maxBytes: number,
): Promise<BoundedJsonBodyResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('JSON body limit must be a positive integer');
  }

  const contentLength = parseContentLength(request.headers.get('content-length'));
  if (contentLength !== null && contentLength > maxBytes) {
    await cancelBody(request.body);
    return { ok: false, reason: 'too_large' };
  }

  if (!request.body) {
    return { ok: false, reason: 'invalid_json' };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel('JSON request body is too large');
        } catch {
          // A runtime may report an already-aborted transport here. The byte
          // boundary was still crossed, so the HTTP outcome remains 413.
        }
        return { ok: false, reason: 'too_large' };
      }

      // Count the chunk before retaining it so buffered data stays bounded.
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return {
      ok: true,
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
    };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}
