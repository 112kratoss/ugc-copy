import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

import {
  getWorkflowCanvasHistoryRouteResponse,
  publishWorkflowCanvasRouteResponse,
  restoreWorkflowCanvasHistoryRouteResponse,
} from '@/lib/workflow-canvas-lifecycle-route-adapter-service';

describe('workflow canvas lifecycle route adapter service', () => {
  const authenticateRequest = vi.fn();
  const enforceWorkflowCanvasMutationRateLimit = vi.fn();
  const listWorkflowCanvasHistoryForRoute = vi.fn();
  const publishWorkflowCanvasForRoute = vi.fn();
  const restoreWorkflowCanvasHistoryForRoute = vi.fn();
  const supabase = { service: 'user-scoped-supabase' };

  beforeEach(() => {
    authenticateRequest.mockReset();
    authenticateRequest.mockResolvedValue({
      userId: 'user-1',
      supabase,
    });
    enforceWorkflowCanvasMutationRateLimit.mockReset();
    enforceWorkflowCanvasMutationRateLimit.mockResolvedValue(null);
    listWorkflowCanvasHistoryForRoute.mockReset();
    listWorkflowCanvasHistoryForRoute.mockResolvedValue({
      ok: true,
      body: { history: [{ id: 'history-1' }] },
    });
    publishWorkflowCanvasForRoute.mockReset();
    publishWorkflowCanvasForRoute.mockResolvedValue({
      ok: true,
      body: { canvas: { id: 'canvas-1', status: 'published' } },
    });
    restoreWorkflowCanvasHistoryForRoute.mockReset();
    restoreWorkflowCanvasHistoryForRoute.mockResolvedValue({
      ok: true,
      body: { canvas: { id: 'canvas-1', status: 'draft' } },
    });
  });

  it('authenticates and loads workflow history with private trace headers', async () => {
    const response = await getWorkflowCanvasHistoryRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1/history', {
        headers: { 'x-request-id': 'workflow-history-adapter-1' },
      }),
      canvasId: 'canvas-1',
      dependencies: {
        authenticateRequest,
        listWorkflowCanvasHistoryForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-history-adapter-1');
    await expect(response.json()).resolves.toEqual({ history: [{ id: 'history-1' }] });
    expect(listWorkflowCanvasHistoryForRoute).toHaveBeenCalledWith({
      canvasId: 'canvas-1',
      supabase,
      userId: 'user-1',
    });
  });

  it('rate limits workflow publishes before lifecycle service delegation', async () => {
    enforceWorkflowCanvasMutationRateLimit.mockResolvedValueOnce(
      NextResponse.json({ error: 'Too many publishes.' }, { status: 429 }),
    );

    const response = await publishWorkflowCanvasRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1/publish', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-publish-limit-1' },
      }),
      canvasId: 'canvas-1',
      dependencies: {
        authenticateRequest,
        enforceWorkflowCanvasMutationRateLimit,
        publishWorkflowCanvasForRoute,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-publish-limit-1');
    expect(enforceWorkflowCanvasMutationRateLimit).toHaveBeenCalledWith(
      'user-1',
      'Failed to publish workflow canvas.',
    );
    expect(publishWorkflowCanvasForRoute).not.toHaveBeenCalled();
  });

  it('restores workflow history only after mutation throttling', async () => {
    const response = await restoreWorkflowCanvasHistoryRouteResponse({
      request: new Request(
        'http://localhost/api/workflow-canvases/canvas-1/history/history-1/restore',
        {
          method: 'POST',
          headers: { 'x-request-id': 'workflow-history-restore-adapter-1' },
        },
      ),
      canvasId: 'canvas-1',
      entryId: 'history-1',
      dependencies: {
        authenticateRequest,
        enforceWorkflowCanvasMutationRateLimit,
        restoreWorkflowCanvasHistoryForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-history-restore-adapter-1');
    expect(enforceWorkflowCanvasMutationRateLimit).toHaveBeenCalledWith(
      'user-1',
      'Failed to restore workflow history.',
    );
    expect(restoreWorkflowCanvasHistoryForRoute).toHaveBeenCalledWith({
      canvasId: 'canvas-1',
      entryId: 'history-1',
      supabase,
      userId: 'user-1',
    });
  });
});
