import { describe, expect, it, vi } from 'vitest';

import { readBoundedJsonBody } from '@/lib/bounded-json-request';

function streamingRequest(stream: ReadableStream<Uint8Array>, headers?: HeadersInit) {
  return new Request('http://localhost/api/test', {
    method: 'POST',
    headers,
    // `duplex` is required by Node for streamed requests but is not part of the
    // browser RequestInit type used by application code.
    ...({ body: stream, duplex: 'half' } as unknown as RequestInit),
  });
}

describe('bounded JSON request bodies', () => {
  it('parses valid multibyte JSON split across stream chunks', async () => {
    const encoded = new TextEncoder().encode('{"message":"✓"}');
    const splitAt = encoded.indexOf(0xe2) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, splitAt));
        controller.enqueue(encoded.slice(splitAt));
        controller.close();
      },
    });

    await expect(readBoundedJsonBody(streamingRequest(stream), 64)).resolves.toEqual({
      ok: true,
      value: { message: '✓' },
    });
  });

  it('counts bytes, cancels the stream, and never pulls the remaining body after the limit', async () => {
    const cancel = vi.fn();
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(new Uint8Array(5));
          return;
        }
        if (pullCount === 2) {
          controller.enqueue(new Uint8Array(6));
          return;
        }
        controller.enqueue(new Uint8Array(100));
      },
      cancel,
    });

    await expect(readBoundedJsonBody(streamingRequest(stream), 10)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(cancel).toHaveBeenCalledWith('JSON request body is too large');
    expect(pullCount).toBe(2);
  });

  it('rejects an understated Content-Length from bytes actually read', async () => {
    const request = new Request('http://localhost/api/test', {
      method: 'POST',
      headers: { 'content-length': '2' },
      body: '{"message":"too large"}',
    });

    await expect(readBoundedJsonBody(request, 8)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('distinguishes malformed JSON from an oversized body', async () => {
    const request = new Request('http://localhost/api/test', {
      method: 'POST',
      body: '{invalid',
    });

    await expect(readBoundedJsonBody(request, 64)).resolves.toEqual({
      ok: false,
      reason: 'invalid_json',
    });
  });
});
