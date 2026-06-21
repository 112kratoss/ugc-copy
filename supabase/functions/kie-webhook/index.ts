// @ts-nocheck
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

async function buildSignature(taskId: string, timestamp: string, hmacKey: string): Promise<string> {
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
    new TextEncoder().encode(`${taskId}.${timestamp}`),
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

serve(async (request: Request) => {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const legacySecret = configuredValue('WEBHOOK_SECRET');
  if (!legacySecret) {
    return jsonResponse({ error: 'Webhook secret is not configured' }, 500);
  }

  const incomingUrl = new URL(request.url);
  if (!safeEqual(legacySecret, incomingUrl.searchParams.get('secret'))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const body = await request.text();
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
  const headers = new Headers({
    'Content-Type': request.headers.get('content-type') || 'application/json',
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  let forwardUrl = `${siteUrl.replace(/\/$/, '')}/api/webhooks/kie`;

  if (hmacKey) {
    headers.set('x-webhook-timestamp', timestamp);
    headers.set('x-webhook-signature', await buildSignature(taskId, timestamp, hmacKey));
  } else {
    forwardUrl = `${forwardUrl}?secret=${encodeURIComponent(legacySecret)}`;
  }

  const response = await fetch(forwardUrl, {
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
