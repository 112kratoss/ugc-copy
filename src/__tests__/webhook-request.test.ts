import { describe, expect, it } from 'vitest';

import {
  isWebhookPayloadTooLarge,
  readBoundedWebhookBody,
  WEBHOOK_MAX_BODY_BYTES,
} from '@/lib/webhook-request';

describe('bounded webhook request bodies', () => {
  it('rejects a body over the limit even when Content-Length is absent', async () => {
    const request = new Request('http://localhost/webhook', {
      method: 'POST',
      body: 'x'.repeat(WEBHOOK_MAX_BODY_BYTES + 1),
    });

    expect(request.headers.has('content-length')).toBe(false);
    await expect(readBoundedWebhookBody(request)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('enforces bytes read when a sender understates Content-Length', async () => {
    const request = new Request('http://localhost/webhook', {
      method: 'POST',
      headers: { 'content-length': '2' },
      body: 'x'.repeat(WEBHOOK_MAX_BODY_BYTES + 1),
    });

    expect(isWebhookPayloadTooLarge(request)).toBe(false);
    await expect(readBoundedWebhookBody(request)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('decodes multibyte UTF-8 content split across stream chunks', async () => {
    const encoded = new TextEncoder().encode('{"message":"✓"}');
    const splitAt = encoded.indexOf(0xe2) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, splitAt));
        controller.enqueue(encoded.slice(splitAt));
        controller.close();
      },
    });
    const request = new Request('http://localhost/webhook', {
      method: 'POST',
      // Node requires duplex for a streaming request body. The web Request type
      // used by the application does not expose this Node-only extension.
      ...({ body: stream, duplex: 'half' } as unknown as RequestInit),
    });

    await expect(readBoundedWebhookBody(request)).resolves.toEqual({
      ok: true,
      text: '{"message":"✓"}',
    });
  });
});
