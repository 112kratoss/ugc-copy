import { beforeEach, describe, expect, it, vi } from 'vitest';

import { postPromptEnhancementRouteResponse } from '@/lib/prompt-enhancement-route-adapter-service';

describe('prompt enhancement route adapter service', () => {
  const createUserClient = vi.fn();
  const createServiceClient = vi.fn();
  const enhancePromptForUser = vi.fn();
  const adminSupabase = { service: 'supabase-admin' };

  beforeEach(() => {
    createUserClient.mockReset();
    createUserClient.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
          error: null,
        })),
      },
    });
    createServiceClient.mockReset();
    createServiceClient.mockReturnValue(adminSupabase);
    enhancePromptForUser.mockReset();
    enhancePromptForUser.mockResolvedValue({
      ok: true,
      response: {
        enhancedPrompt: 'cinematic product poster prompt',
        remainingCredits: 98,
        agentId: 'generic-media-enhancer',
        qualityScore: 91,
        warnings: [],
        appliedSafeguards: [],
      },
    });
  });

  it('authenticates, parses JSON, and delegates prompt enhancement with no-store headers', async () => {
    const request = new Request('http://localhost/api/enhance-prompt', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'enhance-adapter-success',
      },
      body: JSON.stringify({
        medium: 'image',
        selectedModel: 'nano-banana-pro',
        prompt: 'Create a product poster',
      }),
    });

    const response = await postPromptEnhancementRouteResponse({
      request,
      dependencies: {
        createUserClient,
        createServiceClient,
        enhancePromptForUser,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('enhance-adapter-success');
    await expect(response.json()).resolves.toMatchObject({
      enhancedPrompt: 'cinematic product poster prompt',
      remainingCredits: 98,
    });
    expect(enhancePromptForUser).toHaveBeenCalledWith({
      body: {
        medium: 'image',
        selectedModel: 'nano-banana-pro',
        prompt: 'Create a product poster',
      },
      userId: 'user-1',
      request,
      client: createServiceClient,
    });
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests before parsing JSON or creating privileged clients', async () => {
    const json = vi.fn(async () => ({ prompt: 'Should not parse' }));
    createUserClient.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: { message: 'missing session' },
        })),
      },
    });

    const response = await postPromptEnhancementRouteResponse({
      request: {
        headers: new Headers({ 'x-request-id': 'enhance-adapter-auth' }),
        json,
      } as unknown as Request,
      dependencies: {
        createUserClient,
        createServiceClient,
        enhancePromptForUser,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('enhance-adapter-auth');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(json).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(enhancePromptForUser).not.toHaveBeenCalled();
  });

  it('maps invalid JSON to the stable prompt-required response', async () => {
    const response = await postPromptEnhancementRouteResponse({
      request: {
        headers: new Headers(),
        json: vi.fn(async () => {
          throw new Error('bad json');
        }),
      } as unknown as Request,
      dependencies: {
        createUserClient,
        createServiceClient,
        enhancePromptForUser,
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Prompt is required' });
    expect(enhancePromptForUser).not.toHaveBeenCalled();
  });

  it('maps rate-limit failures into body and headers', async () => {
    enhancePromptForUser.mockResolvedValueOnce({
      ok: false,
      status: 429,
      error: 'Too many prompt enhancements.',
      code: 'RATE_LIMITED',
      retryAfterSeconds: 42,
      limit: 60,
      remaining: 0,
      resetAt: '2026-06-22T06:30:00.000Z',
    });

    const response = await postPromptEnhancementRouteResponse({
      request: new Request('http://localhost/api/enhance-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          medium: 'image',
          selectedModel: 'nano-banana-pro',
          prompt: 'Create a product poster',
        }),
      }),
      dependencies: {
        createUserClient,
        createServiceClient,
        enhancePromptForUser,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    expect(response.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('X-RateLimit-Reset')).toBe('2026-06-22T06:30:00.000Z');
    await expect(response.json()).resolves.toEqual({
      error: 'Too many prompt enhancements.',
      code: 'RATE_LIMITED',
      retryAfterSeconds: 42,
      limit: 60,
      resetAt: '2026-06-22T06:30:00.000Z',
    });
  });
});
