import { describe, expect, it, vi } from 'vitest';

import { fetchGenerationStatus } from '@/lib/generation-status-client';

describe('fetchGenerationStatus', () => {
  it('throws the API error immediately for a non-success response', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: 'Your session has expired.' }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    ));

    await expect(fetchGenerationStatus({
      url: '/api/generate-image?id=prediction-1',
      accessToken: 'expired-token',
      fetchImpl,
    })).rejects.toThrow('Your session has expired.');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses a deterministic fallback for a non-JSON error response', async () => {
    const fetchImpl = vi.fn(async () => new Response('gateway unavailable', { status: 503 }));

    await expect(fetchGenerationStatus({
      url: '/api/generate-video?id=prediction-2',
      accessToken: 'token',
      fetchImpl,
    })).rejects.toThrow('Generation status request failed (503).');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a successful response with an invalid status payload', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ status: 'unknown-provider-state' }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    ));

    await expect(fetchGenerationStatus({
      url: '/api/generate?id=prediction-3',
      accessToken: 'token',
      fetchImpl,
    })).rejects.toThrow('Invalid generation status response.');
  });

  it('returns valid processing and successful payloads unchanged', async () => {
    const processing = {
      status: 'processing' as const,
      timing: null,
    };
    const succeeded = {
      status: 'succeeded' as const,
      output: 'https://example.com/result.png',
      outputs: ['https://example.com/result.png'],
      timing: null,
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(processing), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(succeeded), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    await expect(fetchGenerationStatus({
      url: '/api/generate-image?id=prediction-4',
      accessToken: 'token',
      fetchImpl,
    })).resolves.toEqual(processing);
    await expect(fetchGenerationStatus({
      url: '/api/generate-image?id=prediction-4',
      accessToken: 'token',
      fetchImpl,
    })).resolves.toEqual(succeeded);
    expect(fetchImpl).toHaveBeenCalledWith('/api/generate-image?id=prediction-4', {
      headers: { Authorization: 'Bearer token' },
    });
  });
});
