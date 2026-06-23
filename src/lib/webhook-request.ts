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
