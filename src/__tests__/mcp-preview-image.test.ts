import { describe, expect, it, vi } from 'vitest';

import { MCP_IMAGE_BLOCK_MAX_BYTES, fetchImageContentBlock } from '@/lib/mcp-preview-image';

function answer(body: Uint8Array | Uint8Array[] | null, init: { status?: number; type?: string | null; length?: number | null } = {}) {
  const chunks = body === null ? [] : Array.isArray(body) ? body : [body];
  const headers = new Headers();
  if (init.type !== null) headers.set('content-type', init.type ?? 'image/webp');
  if (init.length !== null && init.length !== undefined) headers.set('content-length', String(init.length));
  const stream = body === null ? null : new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: init.status ?? 200, headers });
}

describe('the inline preview of a finished picture', () => {
  it('returns an image block for a picture under a megabyte, base64 with its type', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = vi.fn(async () => answer(bytes, { length: 4 }));
    const block = await fetchImageContentBlock('https://cdn.example.test/preview.webp', { fetchImpl });
    expect(block).toEqual({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/webp' });
    expect(fetchImpl).toHaveBeenCalledWith('https://cdn.example.test/preview.webp', expect.objectContaining({ redirect: 'follow' }));
    expect(MCP_IMAGE_BLOCK_MAX_BYTES).toBe(1024 * 1024);
  });

  it('skips silently: too large by header or by stream, not a picture, an error, a failed fetch, an empty body', async () => {
    const bytes = new Uint8Array(10);
    expect(await fetchImageContentBlock('u', { fetchImpl: async () => answer(bytes, { length: 5_000 }), maxBytes: 1_000 })).toBeNull();
    // No length header: the stream is cut the moment it passes the cap, without reading the rest.
    const chunks = [new Uint8Array(600), new Uint8Array(600), new Uint8Array(600)];
    expect(await fetchImageContentBlock('u', { fetchImpl: async () => answer(chunks), maxBytes: 1_000 })).toBeNull();
    expect(await fetchImageContentBlock('u', { fetchImpl: async () => answer(bytes, { type: 'video/mp4' }) })).toBeNull();
    expect(await fetchImageContentBlock('u', { fetchImpl: async () => answer(bytes, { type: null }) })).toBeNull();
    expect(await fetchImageContentBlock('u', { fetchImpl: async () => answer(bytes, { status: 404 }) })).toBeNull();
    expect(await fetchImageContentBlock('u', { fetchImpl: async () => { throw new Error('offline'); } })).toBeNull();
    expect(await fetchImageContentBlock('u', { fetchImpl: async () => answer(null) })).toBeNull();
    expect(await fetchImageContentBlock('u', { fetchImpl: async () => answer([]) })).toBeNull();
    // Exactly the cap is fine.
    expect(await fetchImageContentBlock('u', { fetchImpl: async () => answer(new Uint8Array(1_000)), maxBytes: 1_000 })).toMatchObject({ type: 'image' });
  });
});
