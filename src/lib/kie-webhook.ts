import { createHmac, timingSafeEqual } from 'node:crypto';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readTaskId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function extractKieWebhookTaskId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;

  const data = isRecord(payload.data) ? payload.data : null;
  return readTaskId(data?.taskId)
    || readTaskId(data?.task_id)
    || readTaskId(payload.taskId)
    || readTaskId(payload.task_id)
    || readTaskId(payload.id);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

const KIE_WEBHOOK_REPLAY_WINDOW_SECONDS = 300;

function isFreshWebhookTimestamp(timestamp: string, nowSeconds: number): boolean {
  const parsedTimestamp = Number(timestamp);
  if (!Number.isInteger(parsedTimestamp) || parsedTimestamp <= 0) return false;

  return Math.abs(nowSeconds - parsedTimestamp) <= KIE_WEBHOOK_REPLAY_WINDOW_SECONDS;
}

export function verifyKieWebhookAuthorization(input: {
  taskId: string;
  timestamp: string | null;
  signature: string | null;
  hmacKey: string | null;
  legacySecret: string | null;
  requestSecret: string | null;
  nowSeconds: number;
}): boolean {
  const legacySecretMatches = Boolean(
    input.legacySecret
    && input.requestSecret
    && safeEqual(input.legacySecret, input.requestSecret),
  );

  if (!input.hmacKey) {
    return legacySecretMatches;
  }

  if (!input.timestamp && !input.signature) return legacySecretMatches;
  if (!input.timestamp || !input.signature) return false;
  if (!isFreshWebhookTimestamp(input.timestamp, input.nowSeconds)) return false;

  const expectedSignature = createHmac('sha256', input.hmacKey)
    .update(`${input.taskId}.${input.timestamp}`)
    .digest('base64');
  return safeEqual(expectedSignature, input.signature);
}

export function buildKieWebhookCallbackUrl(params: { generationId?: string | null } = {}) {
  const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()
    || process.env.VERCEL_URL?.trim();
  const siteUrl = configuredSiteUrl
    || (vercelUrl ? `https://${vercelUrl}` : null);

  if (!siteUrl) {
    throw new Error('NEXT_PUBLIC_SITE_URL is not configured');
  }

  const callbackUrl = new URL(`${siteUrl.replace(/\/$/, '')}/api/webhooks/kie`);
  const generationId = params.generationId?.trim();
  if (generationId) {
    callbackUrl.searchParams.set('generationId', generationId);
  }

  if (process.env.KIE_WEBHOOK_HMAC_KEY?.trim()) {
    return callbackUrl.toString();
  }

  const secret = process.env.WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error('WEBHOOK_SECRET is not configured');
  }

  callbackUrl.searchParams.set('secret', secret);
  return callbackUrl.toString();
}
