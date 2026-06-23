import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authenticateRequestMock = vi.fn();
const createServiceClientMock = vi.fn();
const listHistoryMock = vi.fn();
const publishCanvasMock = vi.fn();
const restoreHistoryMock = vi.fn();
const rateLimitRpcMock = vi.fn();

vi.mock('@/lib/server-helpers', () => ({
  authenticateRequest: (request: Request) => authenticateRequestMock(request),
  createServiceClient: () => createServiceClientMock(),
}));

vi.mock('@/lib/workflow-canvas-lifecycle-service', () => ({
  listWorkflowCanvasHistoryForRoute: (...args: unknown[]) => listHistoryMock(...args),
  publishWorkflowCanvasForRoute: (...args: unknown[]) => publishCanvasMock(...args),
  restoreWorkflowCanvasHistoryForRoute: (...args: unknown[]) => restoreHistoryMock(...args),
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('workflow canvas lifecycle routes', () => {
  beforeEach(() => {
    vi.resetModules();
    authenticateRequestMock.mockReset();
    createServiceClientMock.mockReset();
    listHistoryMock.mockReset();
    publishCanvasMock.mockReset();
    restoreHistoryMock.mockReset();
    rateLimitRpcMock.mockReset();

    authenticateRequestMock.mockResolvedValue({
      supabase: { name: 'user-supabase' },
      userId: 'user-1',
    });
    createServiceClientMock.mockReturnValue({ rpc: rateLimitRpcMock });
    rateLimitRpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 240,
        remaining: 239,
        retryAfterSeconds: 0,
        resetAt: '2026-06-23T00:10:00.000Z',
      },
      error: null,
    });
    listHistoryMock.mockResolvedValue({
      ok: true,
      body: { history: [{ id: 'history-1' }] },
    });
    publishCanvasMock.mockResolvedValue({
      ok: true,
      body: { canvas: { id: 'canvas-1', status: 'published' } },
    });
    restoreHistoryMock.mockResolvedValue({
      ok: true,
      body: { canvas: { id: 'canvas-1', status: 'draft' } },
    });
  });

  it('delegates owner history loading and returns private trace headers', async () => {
    const { GET } = await import('@/app/api/workflow-canvases/[id]/history/route');
    const request = new NextRequest('http://localhost/api/workflow-canvases/canvas-1/history', {
      headers: { 'x-request-id': 'workflow-history-list-1' },
    });
    const response = await GET(request, {
      params: Promise.resolve({ id: 'canvas-1' }),
    });

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-history-list-1');
    await expect(response.json()).resolves.toEqual({ history: [{ id: 'history-1' }] });
    expect(listHistoryMock).toHaveBeenCalledWith({
      canvasId: 'canvas-1',
      supabase: { name: 'user-supabase' },
      userId: 'user-1',
    });
  });

  it('keeps publish throttling in front of lifecycle service delegation', async () => {
    const { POST } = await import('@/app/api/workflow-canvases/[id]/publish/route');
    const request = new NextRequest('http://localhost/api/workflow-canvases/canvas-1/publish', {
      method: 'POST',
      headers: { 'x-request-id': 'workflow-publish-1' },
    });
    const response = await POST(request, {
      params: Promise.resolve({ id: 'canvas-1' }),
    });

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-publish-1');
    expect(rateLimitRpcMock).toHaveBeenCalledTimes(1);
    expect(publishCanvasMock).toHaveBeenCalledWith({
      canvasId: 'canvas-1',
      supabase: { name: 'user-supabase' },
      userId: 'user-1',
    });
  });

  it('delegates history restoration only after mutation throttling', async () => {
    const { POST } = await import('@/app/api/workflow-canvases/[id]/history/[entryId]/restore/route');
    const request = new NextRequest(
      'http://localhost/api/workflow-canvases/canvas-1/history/history-1/restore',
      {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-history-restore-1' },
      },
    );
    const response = await POST(request, {
      params: Promise.resolve({ id: 'canvas-1', entryId: 'history-1' }),
    });

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-history-restore-1');
    expect(rateLimitRpcMock).toHaveBeenCalledTimes(1);
    expect(restoreHistoryMock).toHaveBeenCalledWith({
      canvasId: 'canvas-1',
      entryId: 'history-1',
      supabase: { name: 'user-supabase' },
      userId: 'user-1',
    });
  });
});
