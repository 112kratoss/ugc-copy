import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
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
        taskId: string;
        timestamp: string | null;
        signature: string | null;
        hmacKey: string | null;
        legacySecret: string | null;
        requestSecret: string | null;
        nowSeconds: number;
      }) => boolean;
    };
    const timestamp = '1782039000';
    const signature = createHmac('sha256', 'hmac-key')
      .update(`task-signed.${timestamp}`)
      .digest('base64');

    expect(webhook.verifyKieWebhookAuthorization).toBeTypeOf('function');
    expect(webhook.verifyKieWebhookAuthorization?.({
      taskId: 'task-signed',
      timestamp,
      signature,
      hmacKey: 'hmac-key',
      legacySecret: null,
      requestSecret: null,
      nowSeconds: 1782039000,
    })).toBe(true);
  });

  it('accepts the previous HMAC key during rotation', async () => {
    const { verifyKieWebhookAuthorization } = await import('@/lib/kie-webhook');
    const timestamp = '1782039000';
    const signature = createHmac('sha256', 'previous-hmac-key')
      .update(`task-rotating.${timestamp}`)
      .digest('base64');

    expect(verifyKieWebhookAuthorization({
      taskId: 'task-rotating',
      timestamp,
      signature,
      hmacKey: 'current-hmac-key',
      previousHmacKey: 'previous-hmac-key',
      legacySecret: null,
      requestSecret: null,
      nowSeconds: 1782039000,
    })).toBe(true);
  });

  it('rejects signed callbacks outside the replay window', async () => {
    const { verifyKieWebhookAuthorization } = await import('@/lib/kie-webhook');
    const timestamp = '1782038000';
    const signature = createHmac('sha256', 'hmac-key')
      .update(`task-stale.${timestamp}`)
      .digest('base64');

    expect(verifyKieWebhookAuthorization({
      taskId: 'task-stale',
      timestamp,
      signature,
      hmacKey: 'hmac-key',
      legacySecret: null,
      requestSecret: null,
      nowSeconds: 1782039000,
    })).toBe(false);
  });

  it('accepts a legacy callback secret when HMAC is not configured', async () => {
    const { verifyKieWebhookAuthorization } = await import('@/lib/kie-webhook');

    expect(verifyKieWebhookAuthorization({
      taskId: 'task-legacy-secret',
      timestamp: null,
      signature: null,
      hmacKey: null,
      legacySecret: 'webhook-secret',
      requestSecret: 'webhook-secret',
      nowSeconds: 1782039000,
    })).toBe(true);
  });

  it('accepts a legacy callback secret when signed headers are absent during HMAC rollout', async () => {
    const { verifyKieWebhookAuthorization } = await import('@/lib/kie-webhook');

    expect(verifyKieWebhookAuthorization({
      taskId: 'task-rollout-secret',
      timestamp: null,
      signature: null,
      hmacKey: 'hmac-key',
      legacySecret: 'webhook-secret',
      requestSecret: 'webhook-secret',
      nowSeconds: 1782039000,
    })).toBe(true);
  });

  it('builds a secret-protected provider ingress URL when HMAC forwarding is configured', async () => {
    const previousSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
    const previousSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const previousHmacKey = process.env.KIE_WEBHOOK_HMAC_KEY;
    const previousProviderSecret = process.env.KIE_PROVIDER_WEBHOOK_SECRET;
    const previousSecret = process.env.WEBHOOK_SECRET;
    process.env.NEXT_PUBLIC_SITE_URL = 'https://magicbooklet.com/';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
    process.env.KIE_WEBHOOK_HMAC_KEY = 'hmac-key';
    process.env.KIE_PROVIDER_WEBHOOK_SECRET = 'provider-secret';
    delete process.env.WEBHOOK_SECRET;

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
      restoreEnv('WEBHOOK_SECRET', previousSecret);
    }
  });

  it('includes a local generation id in callback URLs when provided', async () => {
    const previousSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
    const previousSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const previousHmacKey = process.env.KIE_WEBHOOK_HMAC_KEY;
    const previousProviderSecret = process.env.KIE_PROVIDER_WEBHOOK_SECRET;
    const previousSecret = process.env.WEBHOOK_SECRET;
    process.env.NEXT_PUBLIC_SITE_URL = 'https://magicbooklet.com/';
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.KIE_WEBHOOK_HMAC_KEY;
    delete process.env.KIE_PROVIDER_WEBHOOK_SECRET;
    process.env.WEBHOOK_SECRET = 'webhook-secret';

    try {
      const { buildKieWebhookCallbackUrl } = await import('@/lib/kie-webhook');

      expect(buildKieWebhookCallbackUrl({ generationId: 'gen-1' })).toBe(
        'https://magicbooklet.com/api/webhooks/kie?generationId=gen-1&secret=webhook-secret',
      );
    } finally {
      restoreEnv('NEXT_PUBLIC_SITE_URL', previousSiteUrl);
      restoreEnv('NEXT_PUBLIC_SUPABASE_URL', previousSupabaseUrl);
      restoreEnv('KIE_WEBHOOK_HMAC_KEY', previousHmacKey);
      restoreEnv('KIE_PROVIDER_WEBHOOK_SECRET', previousProviderSecret);
      restoreEnv('WEBHOOK_SECRET', previousSecret);
    }
  });
});
