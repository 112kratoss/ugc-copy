import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readTaskId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extractTaskId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;

  const data = isRecord(payload.data) ? payload.data : null;
  return readTaskId(data?.taskId)
    || readTaskId(data?.task_id)
    || readTaskId(payload.taskId)
    || readTaskId(payload.task_id)
    || readTaskId(payload.id);
}

function configuredValue(name: string): string | null {
  return Deno.env.get(name)?.trim() || null;
}

function safeEqual(left: string | null, right: string | null): boolean {
  if (!left || !right || left.length !== right.length) return false;

  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

function buildSigningMessage(
  taskId: string,
  timestamp: string,
  generationId: string | null,
  rawBody: string,
) {
  return JSON.stringify([
    'kie-webhook-v2',
    taskId,
    timestamp,
    generationId?.trim() ?? '',
    rawBody,
  ]);
}

async function buildSignature(message: string, hmacKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(hmacKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  );

  let binary = '';
  for (const byte of new Uint8Array(signature)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function jsonResponse(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readBoundedBody(request: Request, maxBytes = 256 * 1024): Promise<string | null> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;
  if (!request.body) return '';

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('Webhook payload too large');
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

serve(async (request: Request) => {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const providerSecrets = [
    configuredValue('KIE_PROVIDER_WEBHOOK_SECRET'),
    configuredValue('KIE_PROVIDER_WEBHOOK_SECRET_PREVIOUS'),
  ].filter((secret): secret is string => Boolean(secret));
  if (providerSecrets.length === 0) {
    return jsonResponse({ error: 'Provider webhook secret is not configured' }, 500);
  }

  const incomingUrl = new URL(request.url);
  const requestSecret = incomingUrl.searchParams.get('secret');
  if (!providerSecrets.some((secret) => safeEqual(secret, requestSecret))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const body = await readBoundedBody(request);
  if (body === null) {
    return jsonResponse({ error: 'Webhook payload too large' }, 413);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return jsonResponse({ error: 'Invalid JSON payload' }, 400);
  }

  const taskId = extractTaskId(payload);
  if (!taskId) {
    return jsonResponse({ error: 'Missing provider task id' }, 400);
  }

  const siteUrl = configuredValue('NEXT_PUBLIC_SITE_URL') || 'https://magicbooklet.com';
  const hmacKey = configuredValue('KIE_WEBHOOK_HMAC_KEY');
  if (!hmacKey) {
    return jsonResponse({ error: 'Webhook forwarding key is not configured' }, 500);
  }
  const headers = new Headers({
    'Content-Type': request.headers.get('content-type') || 'application/json',
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const forwardUrl = new URL(`${siteUrl.replace(/\/$/, '')}/api/webhooks/kie`);
  const generationId = incomingUrl.searchParams.get('generationId')?.trim();
  if (generationId) {
    forwardUrl.searchParams.set('generationId', generationId);
  }

  headers.set('x-webhook-timestamp', timestamp);
  headers.set(
    'x-webhook-payload-signature',
    await buildSignature(
      buildSigningMessage(taskId, timestamp, generationId ?? null, body),
      hmacKey,
    ),
  );

  const response = await fetch(forwardUrl.toString(), {
    method: 'POST',
    headers,
    body,
  });
  const responseBody = await response.text();

  return new Response(responseBody, {
    status: response.status,
    headers: {
      'Content-Type': response.headers.get('content-type') || 'application/json',
    },
  });
});
