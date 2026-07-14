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
  previousHmacKey?: string | null;
  legacySecret: string | null;
  previousLegacySecret?: string | null;
  requestSecret: string | null;
  nowSeconds: number;
}): boolean {
  const legacySecretMatches = Boolean(input.requestSecret && [
    input.legacySecret,
    input.previousLegacySecret,
  ].some((secret) => secret && safeEqual(secret, input.requestSecret!)));

  const hmacKeys = [input.hmacKey, input.previousHmacKey]
    .filter((key): key is string => Boolean(key));

  if (hmacKeys.length === 0) {
    return legacySecretMatches;
  }

  if (!input.timestamp && !input.signature) return legacySecretMatches;
  if (!input.timestamp || !input.signature) return false;
  if (!isFreshWebhookTimestamp(input.timestamp, input.nowSeconds)) return false;

  return hmacKeys.some((key) => {
    const expectedSignature = createHmac('sha256', key)
      .update(`${input.taskId}.${input.timestamp}`)
      .digest('base64');
    return safeEqual(expectedSignature, input.signature!);
  });
}

export function buildKieWebhookCallbackUrl(params: { generationId?: string | null } = {}) {
  const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()
    || process.env.VERCEL_URL?.trim();
  const siteUrl = configuredSiteUrl
    || (vercelUrl ? `https://${vercelUrl}` : null);

  const configuredProviderCallbackUrl = process.env.KIE_PROVIDER_CALLBACK_URL?.trim();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
    || process.env.SUPABASE_URL?.trim();
  const callbackUrl = configuredProviderCallbackUrl
    ? new URL(configuredProviderCallbackUrl)
    : supabaseUrl
      ? new URL('/functions/v1/kie-webhook', `${supabaseUrl.replace(/\/$/, '')}/`)
      : siteUrl
        ? new URL(`${siteUrl.replace(/\/$/, '')}/api/webhooks/kie`)
        : null;

  if (!callbackUrl) {
    throw new Error('KIE provider callback URL is not configured');
  }
  if (callbackUrl.protocol !== 'https:' || callbackUrl.username || callbackUrl.password) {
    throw new Error('KIE provider callback URL must use HTTPS without embedded credentials');
  }

  const providerSecret = process.env.KIE_PROVIDER_WEBHOOK_SECRET?.trim()
    || process.env.WEBHOOK_SECRET?.trim();
  if (!providerSecret) {
    throw new Error('KIE provider webhook secret is not configured');
  }

  const generationId = params.generationId?.trim();
  if (generationId) {
    callbackUrl.searchParams.set('generationId', generationId);
  }
  callbackUrl.searchParams.set('secret', providerSecret);
  return callbackUrl.toString();
}
