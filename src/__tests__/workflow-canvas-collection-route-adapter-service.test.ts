import { describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  createWorkflowCanvasCollectionRouteHandlers,
  getWorkflowCanvasCollectionRouteResponse,
  postWorkflowCanvasCollectionRouteResponse,
} from '@/lib/workflow-canvas-collection-route-adapter-service';
import type { WorkflowCanvasCollectionRouteResult } from '@/lib/workflow-canvas-collection-service';

describe('workflow canvas collection route adapter service', () => {
  it('authenticates and delegates canvas listing with the user-scoped Supabase client', async () => {
    const supabase = { kind: 'user-scoped' } as unknown as SupabaseClient;
    const listWorkflowCanvasesForRoute = vi.fn(
      async (): Promise<WorkflowCanvasCollectionRouteResult> => ({
        ok: true,
        body: {
          canvases: [{
            id: 'canvas-1',
            title: 'Workflow canvas',
            updated_at: '2026-06-23T08:00:00.000Z',
            revision: 1,
            status: 'draft',
            published_at: null,
          }],
        },
      }),
    );

    const response = await getWorkflowCanvasCollectionRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases'),
      dependencies: {
        authenticateRequest: vi.fn(async () => ({ supabase, userId: 'user-1' })),
        listWorkflowCanvasesForRoute,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      canvases: [{ id: 'canvas-1', title: 'Workflow canvas' }],
    });
    expect(listWorkflowCanvasesForRoute).toHaveBeenCalledWith({
      supabase,
      userId: 'user-1',
    });
  });

  it('rejects unauthenticated create requests before parsing the body or creating a rate-limit client', async () => {
    const createServiceClient = vi.fn();
    const createWorkflowCanvasForRoute = vi.fn();
    const unauthorized = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const response = await postWorkflowCanvasCollectionRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'workflow-collection-adapter-auth-1',
        },
        body: '{',
      }),
      dependencies: {
        authenticateRequest: vi.fn(async () => unauthorized),
        createServiceClient,
        createWorkflowCanvasForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-collection-adapter-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createWorkflowCanvasForRoute).not.toHaveBeenCalled();
  });

  it('delegates canvas creation with a rate-limit client and lazy JSON body fallback', async () => {
    const supabase = { kind: 'user-scoped' } as unknown as SupabaseClient;
    const rateLimitClient = { rpc: vi.fn() } as unknown as SupabaseClient;
    const createWorkflowCanvasForRoute = vi.fn(
      async ({ readBody }): Promise<WorkflowCanvasCollectionRouteResult> => {
        await expect(readBody()).resolves.toEqual({});
        return {
          ok: true,
          body: {
            canvas: {
              id: 'canvas-1',
              title: 'New workflow canvas',
              revision: 0,
              status: 'draft',
              published_at: null,
            },
          },
        };
      },
    );

    const response = await postWorkflowCanvasCollectionRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'workflow-collection-adapter-create-1',
        },
        body: '{',
      }),
      dependencies: {
        authenticateRequest: vi.fn(async () => ({ supabase, userId: 'user-1' })),
        createServiceClient: vi.fn(() => rateLimitClient),
        createWorkflowCanvasForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-collection-adapter-create-1');
    await expect(response.json()).resolves.toMatchObject({
      canvas: { id: 'canvas-1', title: 'New workflow canvas' },
    });
    expect(createWorkflowCanvasForRoute).toHaveBeenCalledWith({
      supabase,
      rateLimitClient,
      userId: 'user-1',
      readBody: expect.any(Function),
    });
  });

  it('maps create rate limits to standard private backend rate-limit responses before body parsing', async () => {
    const json = vi.fn(async () => ({ title: 'Should not parse' }));
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 240,
      remaining: 0,
      retryAfterSeconds: 42,
      resetAt: '2026-06-23T12:00:00.000Z',
    });

    const response = await postWorkflowCanvasCollectionRouteResponse({
      request: {
        headers: new Headers({ 'x-request-id': 'workflow-collection-adapter-limit-1' }),
        json,
      } as unknown as Request,
      dependencies: {
        authenticateRequest: vi.fn(async () => ({
          supabase: { kind: 'user-scoped' } as unknown as SupabaseClient,
          userId: 'user-1',
        })),
        createServiceClient: vi.fn(() => ({ rpc: vi.fn() }) as unknown as SupabaseClient),
        createWorkflowCanvasForRoute: vi.fn(async () => ({
          ok: false,
          status: 429,
          rateLimitError,
          body: { code: 'RATE_LIMITED' },
        })),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-collection-adapter-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 42,
      limit: 240,
    });
    expect(json).not.toHaveBeenCalled();
  });

  it('creates route handlers that forward collection GET and POST requests through the adapter', async () => {
    const supabase = { kind: 'user-scoped' } as unknown as SupabaseClient;
    const rateLimitClient = { rpc: vi.fn() } as unknown as SupabaseClient;
    const listWorkflowCanvasesForRoute = vi.fn(
      async (): Promise<WorkflowCanvasCollectionRouteResult> => ({
        ok: true,
        body: { canvases: [{ id: 'canvas-1', title: 'Workflow canvas' }] },
      }),
    );
    const createWorkflowCanvasForRoute = vi.fn(
      async (): Promise<WorkflowCanvasCollectionRouteResult> => ({
        ok: true,
        body: { canvas: { id: 'canvas-2', title: 'New canvas' } },
      }),
    );
    const { GET, POST } = createWorkflowCanvasCollectionRouteHandlers({
      dependencies: {
        authenticateRequest: vi.fn(async () => ({ supabase, userId: 'user-1' })),
        createServiceClient: vi.fn(() => rateLimitClient),
        createWorkflowCanvasForRoute,
        listWorkflowCanvasesForRoute,
      },
    });

    const getResponse = await GET(new Request('http://localhost/api/workflow-canvases', {
      headers: { 'x-request-id': 'workflow-collection-factory-get-1' },
    }));
    const postResponse = await POST(new Request('http://localhost/api/workflow-canvases', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'workflow-collection-factory-post-1',
      },
      body: JSON.stringify({ title: 'New canvas' }),
    }));

    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getResponse.headers.get('x-request-id')).toBe('workflow-collection-factory-get-1');
    expect(postResponse.status).toBe(200);
    expect(postResponse.headers.get('Cache-Control')).toBe('private, no-store');
    expect(postResponse.headers.get('x-request-id')).toBe('workflow-collection-factory-post-1');
    await expect(getResponse.json()).resolves.toMatchObject({
      canvases: [{ id: 'canvas-1' }],
    });
    await expect(postResponse.json()).resolves.toMatchObject({
      canvas: { id: 'canvas-2' },
    });
    expect(listWorkflowCanvasesForRoute).toHaveBeenCalledWith({
      supabase,
      userId: 'user-1',
    });
    expect(createWorkflowCanvasForRoute).toHaveBeenCalledWith({
      supabase,
      rateLimitClient,
      userId: 'user-1',
      readBody: expect.any(Function),
    });
  });
});
