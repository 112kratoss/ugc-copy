import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function signPayload({
  generationId = null,
  key,
  rawBody,
  taskId,
  timestamp,
}: {
  generationId?: string | null;
  key: string;
  rawBody: string;
  taskId: string;
  timestamp: string;
}) {
  return createHmac('sha256', key)
    .update(JSON.stringify(['kie-webhook-v2', taskId, timestamp, generationId ?? '', rawBody]))
    .digest('base64');
}

describe('KIE webhook helpers', () => {
  it('extracts task identifiers from current and legacy callback payloads', async () => {
    const webhook = await import('@/lib/kie-webhook') as unknown as {
      extractKieWebhookTaskId?: (payload: unknown) => string | null;
    };

    expect(webhook.extractKieWebhookTaskId).toBeTypeOf('function');
    expect(webhook.extractKieWebhookTaskId?.({ data: { taskId: 'task-current' } })).toBe('task-current');
    expect(webhook.extractKieWebhookTaskId?.({ data: { task_id: 'task-legacy' } })).toBe('task-legacy');
    expect(webhook.extractKieWebhookTaskId?.({ taskId: 'task-top-level' })).toBe('task-top-level');
    expect(webhook.extractKieWebhookTaskId?.({ id: 'task-kling' })).toBe('task-kling');
    expect(webhook.extractKieWebhookTaskId?.({ data: {} })).toBeNull();
  });

  it('accepts a valid KIE HMAC signature', async () => {
    const webhook = await import('@/lib/kie-webhook') as unknown as {
      verifyKieWebhookAuthorization?: (input: {
        generationId: string | null;
        taskId: string;
        rawBody: string;
        timestamp: string | null;
        signature: string | null;
        hmacKey: string | null;
        nowSeconds: number;
      }) => boolean;
    };
    const timestamp = '1782039000';
    const rawBody = JSON.stringify({ data: { taskId: 'task-signed', state: 'success' } });
    const signature = signPayload({
      key: 'hmac-key',
      rawBody,
      taskId: 'task-signed',
      timestamp,
    });

    expect(webhook.verifyKieWebhookAuthorization).toBeTypeOf('function');
    expect(webhook.verifyKieWebhookAuthorization?.({
      generationId: null,
      taskId: 'task-signed',
      rawBody,
      timestamp,
      signature,
      hmacKey: 'hmac-key',
      nowSeconds: 1782039000,
    })).toBe(true);
  });

  it('accepts the previous HMAC key during rotation', async () => {
    const { verifyKieWebhookAuthorization } = await import('@/lib/kie-webhook');
    const timestamp = '1782039000';
    const rawBody = JSON.stringify({ data: { taskId: 'task-rotating' } });
    const signature = signPayload({
      key: 'previous-hmac-key',
      rawBody,
      taskId: 'task-rotating',
      timestamp,
    });

    expect(verifyKieWebhookAuthorization({
      generationId: null,
      taskId: 'task-rotating',
      rawBody,
      timestamp,
      signature,
      hmacKey: 'current-hmac-key',
      previousHmacKey: 'previous-hmac-key',
      nowSeconds: 1782039000,
    })).toBe(true);
  });

  it('rejects signed callbacks outside the replay window', async () => {
    const { verifyKieWebhookAuthorization } = await import('@/lib/kie-webhook');
    const timestamp = '1782038000';
    const rawBody = JSON.stringify({ data: { taskId: 'task-stale' } });
    const signature = signPayload({
      key: 'hmac-key',
      rawBody,
      taskId: 'task-stale',
      timestamp,
    });

    expect(verifyKieWebhookAuthorization({
      generationId: null,
      taskId: 'task-stale',
      rawBody,
      timestamp,
      signature,
      hmacKey: 'hmac-key',
      nowSeconds: 1782039000,
    })).toBe(false);
  });

  it('rejects query-string secrets when HMAC is not configured', async () => {
    const { verifyKieWebhookAuthorization } = await import('@/lib/kie-webhook');

    expect(verifyKieWebhookAuthorization({
      generationId: null,
      taskId: 'task-legacy-secret',
      rawBody: '{}',
      timestamp: null,
      signature: null,
      hmacKey: null,
      nowSeconds: 1782039000,
    })).toBe(false);
  });

  it('rejects unsigned callbacks after HMAC cutover', async () => {
    const { verifyKieWebhookAuthorization } = await import('@/lib/kie-webhook');

    expect(verifyKieWebhookAuthorization({
      generationId: null,
      taskId: 'task-rollout-secret',
      rawBody: '{}',
      timestamp: null,
      signature: null,
      hmacKey: 'hmac-key',
      nowSeconds: 1782039000,
    })).toBe(false);
  });

  it('rejects a valid header pair when the callback body is changed', async () => {
    const { verifyKieWebhookAuthorization } = await import('@/lib/kie-webhook');
    const timestamp = '1782039000';
    const signature = signPayload({
      key: 'hmac-key',
      rawBody: JSON.stringify({ data: { taskId: 'task-bound', state: 'processing' } }),
      taskId: 'task-bound',
      timestamp,
    });

    expect(verifyKieWebhookAuthorization({
      generationId: null,
      taskId: 'task-bound',
      rawBody: JSON.stringify({ data: { taskId: 'task-bound', state: 'success' } }),
      timestamp,
      signature,
      hmacKey: 'hmac-key',
      nowSeconds: 1782039000,
    })).toBe(false);
  });

  it('rejects a valid header pair when the callback generation id is changed', async () => {
    const { verifyKieWebhookAuthorization } = await import('@/lib/kie-webhook');
    const timestamp = '1782039000';
    const rawBody = JSON.stringify({ data: { taskId: 'task-bound' } });
    const signature = signPayload({
      generationId: 'generation-one',
      key: 'hmac-key',
      rawBody,
      taskId: 'task-bound',
      timestamp,
    });

    expect(verifyKieWebhookAuthorization({
      generationId: 'generation-two',
      taskId: 'task-bound',
      rawBody,
      timestamp,
      signature,
      hmacKey: 'hmac-key',
      nowSeconds: 1782039000,
    })).toBe(false);
  });

  it('builds a secret-protected provider ingress URL when HMAC forwarding is configured', async () => {
    const previousSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
    const previousSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const previousHmacKey = process.env.KIE_WEBHOOK_HMAC_KEY;
    const previousProviderSecret = process.env.KIE_PROVIDER_WEBHOOK_SECRET;
    process.env.NEXT_PUBLIC_SITE_URL = 'https://magicbooklet.com/';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
    process.env.KIE_WEBHOOK_HMAC_KEY = 'hmac-key';
    process.env.KIE_PROVIDER_WEBHOOK_SECRET = 'provider-secret';

    try {
      const { buildKieWebhookCallbackUrl } = await import('@/lib/kie-webhook');

      expect(buildKieWebhookCallbackUrl()).toBe(
        'https://project.supabase.co/functions/v1/kie-webhook?secret=provider-secret',
      );
    } finally {
      restoreEnv('NEXT_PUBLIC_SITE_URL', previousSiteUrl);
      restoreEnv('NEXT_PUBLIC_SUPABASE_URL', previousSupabaseUrl);
      restoreEnv('KIE_WEBHOOK_HMAC_KEY', previousHmacKey);
      restoreEnv('KIE_PROVIDER_WEBHOOK_SECRET', previousProviderSecret);
    }
  });

  it('requires the provider ingress URL instead of falling back to the public app endpoint', async () => {
    const previousSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
    const previousSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const previousHmacKey = process.env.KIE_WEBHOOK_HMAC_KEY;
    const previousProviderSecret = process.env.KIE_PROVIDER_WEBHOOK_SECRET;
    process.env.NEXT_PUBLIC_SITE_URL = 'https://magicbooklet.com/';
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.KIE_PROVIDER_WEBHOOK_SECRET = 'provider-secret';

    try {
      const { buildKieWebhookCallbackUrl } = await import('@/lib/kie-webhook');

      expect(() => buildKieWebhookCallbackUrl({ generationId: 'gen-1' }))
        .toThrow('KIE provider callback URL is not configured');
    } finally {
      restoreEnv('NEXT_PUBLIC_SITE_URL', previousSiteUrl);
      restoreEnv('NEXT_PUBLIC_SUPABASE_URL', previousSupabaseUrl);
      restoreEnv('KIE_WEBHOOK_HMAC_KEY', previousHmacKey);
      restoreEnv('KIE_PROVIDER_WEBHOOK_SECRET', previousProviderSecret);
    }
  });
});
