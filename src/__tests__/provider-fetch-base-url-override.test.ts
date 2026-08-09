import { afterEach, describe, expect, it } from 'vitest';

import { fetchWithProviderTimeout } from '@/lib/provider-fetch';
import { setBackendLogSink } from '@/lib/backend-logger';

/**
 * The certification seam (`KIE_API_BASE_URL`) redirects provider traffic at a
 * stub so the Phase 1 load test can exercise generation start, webhook bursts
 * and completion draining without billing real generations.
 *
 * The property that matters most here is the *negative* one: with the variable
 * unset — which is every real environment — provider requests must reach
 * api.kie.ai byte-for-byte as before.
 */

const ORIGINAL_BASE_URL = process.env.KIE_API_BASE_URL;
const ORIGINAL_VERCEL_ENV = process.env.VERCEL_ENV;

function restoreEnvironment() {
  if (ORIGINAL_BASE_URL === undefined) delete process.env.KIE_API_BASE_URL;
  else process.env.KIE_API_BASE_URL = ORIGINAL_BASE_URL;

  if (ORIGINAL_VERCEL_ENV === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = ORIGINAL_VERCEL_ENV;
}

/** Captures the URL the fetcher was actually handed. */
function createRecordingFetcher() {
  const urls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { urls, fetcher };
}

async function callProvider(url: string, fetcher: typeof fetch) {
  await fetchWithProviderTimeout(url, { method: 'POST' }, 1_000, fetcher, 'Kie');
}

describe('provider base-URL certification seam', () => {
  afterEach(() => {
    restoreEnvironment();
  });

  it('is inert when KIE_API_BASE_URL is unset', async () => {
    delete process.env.KIE_API_BASE_URL;
    const { urls, fetcher } = createRecordingFetcher();

    await callProvider('https://api.kie.ai/api/v1/jobs/createTask', fetcher);

    expect(urls).toEqual(['https://api.kie.ai/api/v1/jobs/createTask']);
  });

  it('redirects the provider host while preserving path and query', async () => {
    process.env.KIE_API_BASE_URL = 'https://stub.internal:8787';
    process.env.VERCEL_ENV = 'preview';
    const { urls, fetcher } = createRecordingFetcher();

    await callProvider('https://api.kie.ai/api/v1/jobs/recordInfo?taskId=abc123', fetcher);

    expect(urls).toEqual(['https://stub.internal:8787/api/v1/jobs/recordInfo?taskId=abc123']);
  });

  it('leaves other external hosts alone', async () => {
    process.env.KIE_API_BASE_URL = 'https://stub.internal:8787';
    process.env.VERCEL_ENV = 'preview';
    const { urls, fetcher } = createRecordingFetcher();

    await callProvider('https://api.razorpay.com/v1/orders', fetcher);

    expect(urls).toEqual(['https://api.razorpay.com/v1/orders']);
  });

  // The seam must be incapable of routing real users' paid generations at a
  // stub, even if the variable leaks into the production environment.
  it('ignores the override in a production runtime', async () => {
    const restoreLogs = setBackendLogSink(() => {});
    process.env.KIE_API_BASE_URL = 'https://stub.internal:8787';
    process.env.VERCEL_ENV = 'production';
    const { urls, fetcher } = createRecordingFetcher();

    await callProvider('https://api.kie.ai/api/v1/jobs/createTask', fetcher);

    expect(urls).toEqual(['https://api.kie.ai/api/v1/jobs/createTask']);
    restoreLogs();
  });

  // Preview deployments build with NODE_ENV=production, so gating on NODE_ENV
  // would leave the certification environment unable to use the seam at all.
  it('stays active when NODE_ENV is production but VERCEL_ENV is preview', async () => {
    process.env.KIE_API_BASE_URL = 'https://stub.internal:8787';
    process.env.VERCEL_ENV = 'preview';
    const { urls, fetcher } = createRecordingFetcher();

    await callProvider('https://api.kie.ai/api/v1/veo/generate', fetcher);

    expect(urls).toEqual(['https://stub.internal:8787/api/v1/veo/generate']);
  });

  it('falls back to the provider host when the override is unusable', async () => {
    const restoreLogs = setBackendLogSink(() => {});
    process.env.VERCEL_ENV = 'preview';

    for (const unusable of ['not-a-url', 'file:///etc/passwd']) {
      process.env.KIE_API_BASE_URL = unusable;
      const { urls, fetcher } = createRecordingFetcher();

      await callProvider('https://api.kie.ai/api/v1/jobs/createTask', fetcher);

      expect(urls).toEqual(['https://api.kie.ai/api/v1/jobs/createTask']);
    }

    restoreLogs();
  });

  it('redirects Request inputs as well as string inputs', async () => {
    process.env.KIE_API_BASE_URL = 'https://stub.internal:8787';
    process.env.VERCEL_ENV = 'preview';
    const { urls, fetcher } = createRecordingFetcher();

    const request = new Request('https://api.kie.ai/api/v1/jobs/createTask', { method: 'POST' });
    await fetchWithProviderTimeout(request, {}, 1_000, fetcher, 'Kie');

    expect(urls).toEqual(['https://stub.internal:8787/api/v1/jobs/createTask']);
  });
});
