import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  createGenerationRouteHandlers,
  getGenerationRouteResponse,
  postGenerationRouteResponse,
} from '@/lib/generation-route-adapter-service';
import { getActiveRequestTrace } from '@/lib/request-trace';

const afterMock = vi.hoisted(() => vi.fn());

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');

  return {
    ...actual,
    after: afterMock,
  };
});

describe('generation route adapter service', () => {
  const createServiceClient = vi.fn();
  const createUserClient = vi.fn();
  const withProviderFetchRequestId = vi.fn();
  const adminSupabase = { service: 'admin' };
  const userSupabase = { service: 'user' };

  beforeEach(() => {
    afterMock.mockReset();
    createServiceClient.mockReset();
    createServiceClient.mockReturnValue(adminSupabase);
    createUserClient.mockReset();
    createUserClient.mockReturnValue(userSupabase);
    withProviderFetchRequestId.mockReset();
    withProviderFetchRequestId.mockImplementation((_: string, operation: () => Promise<Response>) => operation());
  });

  it('wraps POST generation routes with provider request tracing and private response headers', async () => {
    const request = new Request('http://localhost/api/generate-image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'generation-post-1',
      },
      body: JSON.stringify({ prompt: 'A cinematic product shot' }),
    });
    const postGenerationForRoute = vi.fn(async (input) => {
      expect(input.request).toBe(request);
      expect(input.kieApiKey).toBe('kie-key');
      expect(input.createAdminSupabase()).toBe(adminSupabase);
      expect(input.createUserSupabase()).toBe(userSupabase);
      await expect(input.readRequestBody?.()).resolves.toEqual({
        prompt: 'A cinematic product shot',
      });

      return {
        ok: true as const,
        body: {
          success: true,
          predictionId: 'task-image-1',
        },
      };
    });

    const response = await postGenerationRouteResponse({
      kieApiKey: 'kie-key',
      postGenerationForRoute,
      request,
      dependencies: {
        createServiceClient,
        createUserClient,
        withProviderFetchRequestId,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('generation-post-1');
    await expect(response.json()).resolves.toEqual({
      success: true,
      predictionId: 'task-image-1',
    });
    expect(withProviderFetchRequestId).toHaveBeenCalledWith('generation-post-1', expect.any(Function));
    expect(postGenerationForRoute).toHaveBeenCalledTimes(1);
  });

  it('wraps GET generation status routes without adding body readers', async () => {
    const request = new Request('http://localhost/api/generate-video?id=task-video-1', {
      headers: { 'x-request-id': 'generation-get-1' },
    });
    const getGenerationForRoute = vi.fn(async (input) => {
      expect(input.request).toBe(request);
      expect(input.kieApiKey).toBe('kie-key');
      expect(input.readRequestBody).toBeUndefined();
      expect(input.createAdminSupabase()).toBe(adminSupabase);
      expect(input.createUserSupabase()).toBe(userSupabase);

      return {
        ok: false,
        status: 404,
        body: { error: 'Generation not found' },
      };
    });

    const response = await getGenerationRouteResponse({
      getGenerationForRoute,
      kieApiKey: 'kie-key',
      request,
      dependencies: {
        createServiceClient,
        createUserClient,
        withProviderFetchRequestId,
      },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('generation-get-1');
    await expect(response.json()).resolves.toEqual({ error: 'Generation not found' });
    expect(withProviderFetchRequestId).toHaveBeenCalledWith('generation-get-1', expect.any(Function));
  });

  it('maps generation rate-limit errors into standard headers while keeping private no-store headers', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 30,
      remaining: 0,
      retryAfterSeconds: 42,
      resetAt: '2026-06-23T02:00:00.000Z',
    });
    const postGenerationForRoute = vi.fn(async () => ({
      ok: false,
      status: 429,
      body: { error: rateLimitError.message },
      rateLimitError,
    }));

    const response = await postGenerationRouteResponse({
      kieApiKey: 'kie-key',
      postGenerationForRoute,
      request: new Request('http://localhost/api/generate', {
        method: 'POST',
        headers: { 'x-request-id': 'generation-rate-limit-1' },
        body: JSON.stringify({ prompt: 'Motion prompt' }),
      }),
      dependencies: {
        createServiceClient,
        createUserClient,
        withProviderFetchRequestId,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    expect(response.headers.get('X-RateLimit-Limit')).toBe('30');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('generation-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 42,
      limit: 30,
    });
  });

  it('creates compact GET and POST handlers for media generation route entrypoints', async () => {
    const postGenerationForRoute = vi.fn(async (input) => {
      expect(input.kieApiKey).toBe('kie-key');
      expect(input.createAdminSupabase()).toBe(adminSupabase);
      expect(input.createUserSupabase()).toBe(userSupabase);
      await expect(input.readRequestBody?.()).resolves.toEqual({
        prompt: 'Factory generated image',
      });

      return {
        ok: true as const,
        body: { predictionId: 'task-factory-post' },
      };
    });
    const getGenerationForRoute = vi.fn(async (input) => {
      expect(input.kieApiKey).toBe('kie-key');
      expect(input.readRequestBody).toBeUndefined();

      return {
        ok: true as const,
        body: { status: 'completed' },
      };
    });

    const { GET, POST } = createGenerationRouteHandlers({
      getGenerationForRoute,
      kieApiKey: 'kie-key',
      postGenerationForRoute,
      dependencies: {
        createServiceClient,
        createUserClient,
        withProviderFetchRequestId,
      },
    });

    const postResponse = await POST(new Request('http://localhost/api/generate-image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'generation-factory-post',
      },
      body: JSON.stringify({ prompt: 'Factory generated image' }),
    }));
    const getResponse = await GET(new Request('http://localhost/api/generate-image?id=task-factory-post', {
      headers: { 'x-request-id': 'generation-factory-get' },
    }));

    expect(postResponse.status).toBe(200);
    expect(postResponse.headers.get('Cache-Control')).toBe('private, no-store');
    expect(postResponse.headers.get('x-request-id')).toBe('generation-factory-post');
    await expect(postResponse.json()).resolves.toEqual({ predictionId: 'task-factory-post' });
    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getResponse.headers.get('x-request-id')).toBe('generation-factory-get');
    await expect(getResponse.json()).resolves.toEqual({ status: 'completed' });
    expect(withProviderFetchRequestId).toHaveBeenCalledWith('generation-factory-post', expect.any(Function));
    expect(withProviderFetchRequestId).toHaveBeenCalledWith('generation-factory-get', expect.any(Function));
  });

  describe('work a status check leaves for after the response', () => {
    // A status check that finds a provider failure tells the creator's devices.
    // The app is waiting on that check, so it is given somewhere to run the
    // notification once it has answered.
    const notifyCreator = async () => null;
    const statusCheckThatDefers = vi.fn(async (input) => {
      input.runAfterResponse?.(notifyCreator);

      return {
        ok: true as const,
        body: { status: 'failed' },
      };
    });

    beforeEach(() => {
      statusCheckThatDefers.mockClear();
    });

    it('runs through Next after() on the routes', async () => {
      const { GET } = createGenerationRouteHandlers({
        getGenerationForRoute: statusCheckThatDefers,
        kieApiKey: 'kie-key',
        postGenerationForRoute: vi.fn(),
        dependencies: {
          createServiceClient,
          createUserClient,
          withProviderFetchRequestId,
        },
      });

      const response = await GET(new Request('http://localhost/api/generate-image?id=task-image-1'));

      await expect(response.json()).resolves.toEqual({ status: 'failed' });
      expect(afterMock).toHaveBeenCalledTimes(1);
      expect(afterMock).toHaveBeenCalledWith(notifyCreator);
    });

    it('runs through the scheduler a caller supplies instead', async () => {
      const runAfterResponse = vi.fn();

      await getGenerationRouteResponse({
        getGenerationForRoute: statusCheckThatDefers,
        kieApiKey: 'kie-key',
        request: new Request('http://localhost/api/generate-image?id=task-image-1'),
        dependencies: {
          createServiceClient,
          createUserClient,
          withProviderFetchRequestId,
          runAfterResponse,
        },
      });

      expect(runAfterResponse).toHaveBeenCalledTimes(1);
      expect(runAfterResponse).toHaveBeenCalledWith(notifyCreator);
      expect(afterMock).not.toHaveBeenCalled();
    });

    it('is queued inside the request trace, so what runs later is still logged under the poll that caused it', async () => {
      // Next's after() runs a task in the async context it was queued from.
      let queuedUnder: string | undefined;
      const runAfterResponse = vi.fn(() => {
        queuedUnder = getActiveRequestTrace()?.requestId;
      });

      await getGenerationRouteResponse({
        getGenerationForRoute: statusCheckThatDefers,
        kieApiKey: 'kie-key',
        request: new Request('http://localhost/api/generate-image?id=task-image-1', {
          headers: { 'x-request-id': 'generation-get-deferred-1' },
        }),
        dependencies: {
          createServiceClient,
          createUserClient,
          runAfterResponse,
        },
      });

      expect(queuedUnder).toBe('generation-get-deferred-1');
    });

    it('is not offered to a generation start, which has nothing to send', async () => {
      const postGenerationForRoute = vi.fn(async (input) => {
        expect(input.runAfterResponse).toBeUndefined();

        return {
          ok: true as const,
          body: { predictionId: 'task-image-1' },
        };
      });

      const response = await postGenerationRouteResponse({
        kieApiKey: 'kie-key',
        postGenerationForRoute,
        request: new Request('http://localhost/api/generate-image', {
          method: 'POST',
          body: JSON.stringify({ prompt: 'A cinematic product shot' }),
        }),
        dependencies: {
          createServiceClient,
          createUserClient,
          withProviderFetchRequestId,
        },
      });

      expect(response.status).toBe(200);
      expect(postGenerationForRoute).toHaveBeenCalledTimes(1);
      expect(afterMock).not.toHaveBeenCalled();
    });
  });
});
