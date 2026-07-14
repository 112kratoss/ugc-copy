export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

function parseContentLength(value: string | null): number | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function isWebhookPayloadTooLarge(
  request: Pick<Request, 'headers'>,
  maxBytes = WEBHOOK_MAX_BODY_BYTES,
): boolean {
  const contentLength = parseContentLength(request.headers.get('content-length'));
  return contentLength !== null && contentLength > maxBytes;
}

export type BoundedWebhookBodyResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'too_large' };

export async function readBoundedWebhookBody(
  request: Pick<Request, 'body' | 'headers'>,
  maxBytes = WEBHOOK_MAX_BODY_BYTES,
): Promise<BoundedWebhookBodyResult> {
  if (isWebhookPayloadTooLarge(request, maxBytes)) {
    return { ok: false, reason: 'too_large' };
  }
  if (!request.body) {
    return { ok: true, text: '' };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('Webhook payload too large');
        return { ok: false, reason: 'too_large' };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } finally {
    reader.releaseLock();
  }
}
