import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { GET } from '@/app/api/generation-models/route';
import { POST } from '@/app/api/generation-models/quote/route';

describe('GET /api/generation-models', () => {
  it('returns a cacheable compatible catalog with an ETag', async () => {
    const response = await GET(new NextRequest(
      'http://localhost/api/generation-models?platform=mobile&schemaVersion=1'
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300, stale-while-revalidate=3600');
    expect(response.headers.get('ETag')).toBe(`"${body.revision}"`);
    expect(body.models.some((model: { id: string }) => model.id === 'nano-banana-2')).toBe(true);
  });

  it('returns 304 when the client already has the current revision', async () => {
    const initial = await GET(new NextRequest(
      'http://localhost/api/generation-models?platform=web&schemaVersion=1'
    ));
    const etag = initial.headers.get('ETag')!;
    const response = await GET(new NextRequest(
      'http://localhost/api/generation-models?platform=web&schemaVersion=1',
      { headers: { 'If-None-Match': etag } }
    ));

    expect(response.status).toBe(304);
    expect(response.headers.get('ETag')).toBe(etag);
  });
});

describe('POST /api/generation-models/quote', () => {
  it('returns a no-store authoritative quote', async () => {
    const response = await POST(new NextRequest(
      'http://localhost/api/generation-models/quote',
      {
        method: 'POST',
        body: JSON.stringify({
          kind: 'motion',
          modelId: 'kling-2.6',
          settings: { resolution: '1080p', duration: 10, characterOrientation: 'video' },
          inputCounts: { images: 1, videos: 1, audios: 0 },
        }),
      }
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(body.costCredits).toBe(90);
  });

  it('returns structured validation errors', async () => {
    const response = await POST(new NextRequest(
      'http://localhost/api/generation-models/quote',
      {
        method: 'POST',
        body: JSON.stringify({
          kind: 'image',
          modelId: 'grok-imagine-image',
          settings: { aspectRatio: '21:9', resolution: '1K' },
        }),
      }
    ));
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toMatchObject({
      code: 'INVALID_MODEL_SETTINGS',
      fieldErrors: { aspectRatio: expect.any(String) },
    });
  });
});
