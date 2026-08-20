import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createWorkflowCanvasRouteHandlers,
  deleteWorkflowCanvasRouteResponse,
  deleteWorkflowCanvasRouteContextResponse,
  getWorkflowCanvasRouteResponse,
  getWorkflowCanvasRouteContextResponse,
  patchWorkflowCanvasRouteResponse,
  patchWorkflowCanvasRouteContextResponse,
} from '@/lib/workflow-canvas-route-adapter-service';

describe('workflow canvas route adapter service', () => {
  const authenticateRequest = vi.fn();
  const enforceWorkflowCanvasMutationRateLimit = vi.fn();
  const getWorkflowCanvasForRoute = vi.fn();
  const patchWorkflowCanvasForRoute = vi.fn();
  const deleteWorkflowCanvasForRoute = vi.fn();
  const supabase = { service: 'user-scoped-supabase' };
  const uploadClient = { service: 'service-role-supabase' } as unknown as SupabaseClient;
  const createServiceClient = vi.fn(() => uploadClient);

  beforeEach(() => {
    authenticateRequest.mockReset();
    authenticateRequest.mockResolvedValue({
      userId: 'user-1',
      supabase,
    });
    enforceWorkflowCanvasMutationRateLimit.mockReset();
    enforceWorkflowCanvasMutationRateLimit.mockResolvedValue(null);
    getWorkflowCanvasForRoute.mockReset();
    getWorkflowCanvasForRoute.mockResolvedValue({
      ok: true,
      body: {
        canvas: {
          id: 'canvas-1',
          title: 'Workflow canvas',
          graph: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
          created_at: '2026-06-22T06:00:00.000Z',
          updated_at: '2026-06-22T06:00:00.000Z',
          revision: 1,
          status: 'draft',
          published_at: null,
        },
      },
    });
    patchWorkflowCanvasForRoute.mockReset();
    patchWorkflowCanvasForRoute.mockResolvedValue({
      ok: true,
      body: {
        canvas: {
          id: 'canvas-1',
          title: 'Updated workflow',
          graph: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
          created_at: '2026-06-22T06:00:00.000Z',
          updated_at: '2026-06-22T06:01:00.000Z',
          revision: 2,
          status: 'draft',
          published_at: null,
        },
      },
    });
    deleteWorkflowCanvasForRoute.mockReset();
    deleteWorkflowCanvasForRoute.mockResolvedValue({
      ok: true,
      body: { success: true },
    });
    createServiceClient.mockClear();
  });

  it('authenticates and loads an owned workflow canvas', async () => {
    const response = await getWorkflowCanvasRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1', {
        headers: { 'x-request-id': 'workflow-canvas-get-1' },
      }),
      canvasId: 'canvas-1',
      dependencies: {
        authenticateRequest,
        getWorkflowCanvasForRoute,
      },
    });

    await expect(response.json()).resolves.toMatchObject({
      canvas: {
        id: 'canvas-1',
        title: 'Workflow canvas',
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-canvas-get-1');
    expect(getWorkflowCanvasForRoute).toHaveBeenCalledWith({
      canvasId: 'canvas-1',
      supabase,
      userId: 'user-1',
    });
  });

  it('unwraps route context params before loading a workflow canvas', async () => {
    const response = await getWorkflowCanvasRouteContextResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-from-context', {
        headers: { 'x-request-id': 'workflow-canvas-context-1' },
      }),
      context: {
        params: Promise.resolve({ id: 'canvas-from-context' }),
      },
      dependencies: {
        authenticateRequest,
        getWorkflowCanvasForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-canvas-context-1');
    expect(getWorkflowCanvasForRoute).toHaveBeenCalledWith({
      canvasId: 'canvas-from-context',
      supabase,
      userId: 'user-1',
    });
  });

  it('rate limits workflow canvas patches before parsing the body', async () => {
    const json = vi.fn(async () => ({ title: 'Should not parse' }));
    enforceWorkflowCanvasMutationRateLimit.mockResolvedValueOnce(
      NextResponse.json({ error: 'Too many saves.' }, { status: 429 }),
    );

    const response = await patchWorkflowCanvasRouteResponse({
      request: {
        headers: new Headers({ 'x-request-id': 'workflow-canvas-patch-limit-1' }),
        json,
      } as unknown as Request,
      canvasId: 'canvas-1',
      dependencies: {
        authenticateRequest,
        createServiceClient,
        enforceWorkflowCanvasMutationRateLimit,
        patchWorkflowCanvasForRoute,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-canvas-patch-limit-1');
    expect(json).not.toHaveBeenCalled();
    expect(patchWorkflowCanvasForRoute).not.toHaveBeenCalled();
    expect(enforceWorkflowCanvasMutationRateLimit).toHaveBeenCalledWith(
      'user-1',
      'Failed to update workflow canvas.',
    );
  });

  it('parses patch bodies after rate limiting and delegates canvas saves', async () => {
    const response = await patchWorkflowCanvasRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated workflow' }),
      }),
      canvasId: 'canvas-1',
      dependencies: {
        authenticateRequest,
        createServiceClient,
        enforceWorkflowCanvasMutationRateLimit,
        patchWorkflowCanvasForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(patchWorkflowCanvasForRoute).toHaveBeenCalledWith({
      body: { title: 'Updated workflow' },
      canvasId: 'canvas-1',
      supabase,
      uploadClient,
      userId: 'user-1',
    });
  });

  it('skips duplicate rate limiting when an internal caller has already checked capacity', async () => {
    await patchWorkflowCanvasRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Assistant-applied workflow' }),
      }),
      canvasId: 'canvas-1',
      options: { skipRateLimit: true },
      dependencies: {
        authenticateRequest,
        createServiceClient,
        enforceWorkflowCanvasMutationRateLimit,
        patchWorkflowCanvasForRoute,
      },
    });

    expect(enforceWorkflowCanvasMutationRateLimit).not.toHaveBeenCalled();
    expect(patchWorkflowCanvasForRoute).toHaveBeenCalledTimes(1);
  });

  it('unwraps route context params and preserves patch options for internal callers', async () => {
    await patchWorkflowCanvasRouteContextResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-from-context', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Context update' }),
      }),
      context: {
        params: Promise.resolve({ id: 'canvas-from-context' }),
      },
      options: { skipRateLimit: true },
      dependencies: {
        authenticateRequest,
        createServiceClient,
        enforceWorkflowCanvasMutationRateLimit,
        patchWorkflowCanvasForRoute,
      },
    });

    expect(enforceWorkflowCanvasMutationRateLimit).not.toHaveBeenCalled();
    expect(patchWorkflowCanvasForRoute).toHaveBeenCalledWith({
      body: { title: 'Context update' },
      canvasId: 'canvas-from-context',
      supabase,
      uploadClient,
      userId: 'user-1',
    });
  });

  it('rate limits workflow canvas deletion before table mutations', async () => {
    const response = await deleteWorkflowCanvasRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1', {
        method: 'DELETE',
      }),
      canvasId: 'canvas-1',
      dependencies: {
        authenticateRequest,
        enforceWorkflowCanvasMutationRateLimit,
        deleteWorkflowCanvasForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(enforceWorkflowCanvasMutationRateLimit).toHaveBeenCalledWith(
      'user-1',
      'Failed to delete workflow canvas.',
    );
    expect(deleteWorkflowCanvasForRoute).toHaveBeenCalledWith({
      canvasId: 'canvas-1',
      supabase,
      userId: 'user-1',
    });
  });

  it('unwraps route context params before deleting a workflow canvas', async () => {
    const response = await deleteWorkflowCanvasRouteContextResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-from-context', {
        method: 'DELETE',
      }),
      context: {
        params: Promise.resolve({ id: 'canvas-from-context' }),
      },
      dependencies: {
        authenticateRequest,
        enforceWorkflowCanvasMutationRateLimit,
        deleteWorkflowCanvasForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(deleteWorkflowCanvasForRoute).toHaveBeenCalledWith({
      canvasId: 'canvas-from-context',
      supabase,
      userId: 'user-1',
    });
  });

  it('creates compact handlers for the workflow canvas route entrypoint', async () => {
    const { DELETE, GET, PATCH } = createWorkflowCanvasRouteHandlers({
      dependencies: {
        authenticateRequest,
        createServiceClient,
        deleteWorkflowCanvasForRoute,
        enforceWorkflowCanvasMutationRateLimit,
        getWorkflowCanvasForRoute,
        patchWorkflowCanvasForRoute,
      },
    });
    const context = {
      params: Promise.resolve({ id: 'canvas-from-factory' }),
    };

    const getResponse = await GET(new Request('http://localhost/api/workflow-canvases/canvas-from-factory', {
      headers: { 'x-request-id': 'workflow-canvas-factory-get' },
    }), context);
    const patchResponse = await PATCH(new Request('http://localhost/api/workflow-canvases/canvas-from-factory', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Factory update' }),
    }), context, { skipRateLimit: true });
    const deleteResponse = await DELETE(new Request('http://localhost/api/workflow-canvases/canvas-from-factory', {
      method: 'DELETE',
    }), context);

    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getResponse.headers.get('x-request-id')).toBe('workflow-canvas-factory-get');
    expect(patchResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(200);
    expect(enforceWorkflowCanvasMutationRateLimit).toHaveBeenCalledTimes(1);
    expect(enforceWorkflowCanvasMutationRateLimit).toHaveBeenCalledWith(
      'user-1',
      'Failed to delete workflow canvas.',
    );
    expect(getWorkflowCanvasForRoute).toHaveBeenCalledWith({
      canvasId: 'canvas-from-factory',
      supabase,
      userId: 'user-1',
    });
    expect(patchWorkflowCanvasForRoute).toHaveBeenCalledWith({
      body: { title: 'Factory update' },
      canvasId: 'canvas-from-factory',
      supabase,
      uploadClient,
      userId: 'user-1',
    });
    expect(deleteWorkflowCanvasForRoute).toHaveBeenCalledWith({
      canvasId: 'canvas-from-factory',
      supabase,
      userId: 'user-1',
    });
  });
});
