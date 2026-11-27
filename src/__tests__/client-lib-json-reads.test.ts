import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestWebGenerationQuote, WebCatalogRequestError } from '@/lib/generation-model-client';
import { finalizeSignedUpload } from '@/lib/upload-finalize-client';

// The browser's helpers in src/lib read an answer as JSON before its status (review of the
// 2026-11-27 change), so the platform's HTML 502 put "Unexpected token '<'" where their own words
// belong, and a quote answered 200 with no body came back as a quote with no cost.
const html = (status: number) => new Response('<!DOCTYPE html><p>Bad gateway</p>', { status });

afterEach(() => vi.unstubAllGlobals());

describe('finalizeSignedUpload', () => {
  it('says its own words for an HTML 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => html(502)));
    await expect(finalizeSignedUpload('token', 'upload-1')).rejects.toThrow('Failed to finalize upload.');
  });
});

describe('requestWebGenerationQuote', () => {
  const input = { modelId: 'nano-banana-2', settings: {} } as unknown as Parameters<typeof requestWebGenerationQuote>[0];

  it('says its own words for an HTML 502', async () => {
    await expect(requestWebGenerationQuote(input, null, undefined, vi.fn(async () => html(502))))
      .rejects.toThrow('Could not calculate generation cost.');
  });

  it('refuses a 200 that carries no quote', async () => {
    const quote = requestWebGenerationQuote(input, null, undefined, vi.fn(async () => html(200)));
    await expect(quote).rejects.toBeInstanceOf(WebCatalogRequestError);
    await expect(requestWebGenerationQuote(input, null, undefined, vi.fn(async () => html(200))))
      .rejects.toThrow('Could not calculate generation cost.');
  });
});
