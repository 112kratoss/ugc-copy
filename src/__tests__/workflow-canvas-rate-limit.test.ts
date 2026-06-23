import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const authenticateRequestMock = vi.fn();
const createServiceClientMock = vi.fn();
const rateLimitRpcMock = vi.fn();
const userTableCalls: string[] = [];
const serviceTableCalls: string[] = [];

vi.mock('@/lib/server-helpers', () => ({
  authenticateRequest: (request: Request) => authenticateRequestMock(request),
  createServiceClient: () => createServiceClientMock(),
}));

function createQuery(result: { data: unknown; error: { message: string } | null }) {
  const query = {
    select() {
      return query;
    },
    eq() {
      return query;
    },
    order() {
      return Promise.resolve(result);
    },
    single: vi.fn(async () => result),
    maybeSingle: vi.fn(async () => result),
    insert() {
      return query;
    },
    update() {
      return query;
    },
    delete() {
      return query;
    },
  };
  return query;
}

function createUserSupabaseMock() {
  return {
    from(table: string) {
      userTableCalls.push(table);
      return {
        select() {
          return createQuery({
            data: {
              id: 'canvas-1',
              user_id: 'user-1',
              title: 'Workflow canvas',
              graph: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
              created_at: '2026-06-22T06:00:00.000Z',
              updated_at: '2026-06-22T06:00:00.000Z',
              revision: 1,
              status: 'draft',
              published_at: null,
            },
            error: null,
          });
        },
        insert() {
          return createQuery({
            data: {
              id: 'canvas-1',
              title: 'Workflow canvas',
              graph: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
              created_at: '2026-06-22T06:00:00.000Z',
              updated_at: '2026-06-22T06:00:00.000Z',
              revision: 0,
              status: 'draft',
              published_at: null,
            },
            error: null,
          });
        },
        update() {
          return createQuery({
            data: {
              id: 'canvas-1',
              title: 'Workflow canvas',
              graph: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
              created_at: '2026-06-22T06:00:00.000Z',
              updated_at: '2026-06-22T06:01:00.000Z',
              revision: 2,
              status: 'draft',
              published_at: null,
            },
            error: null,
          });
        },
        delete() {
          return createQuery({ data: null, error: null });
        },
      };
    },
  };
}

function createServiceSupabaseMock() {
  return {
    rpc: rateLimitRpcMock,
    from(table: string) {
      serviceTableCalls.push(table);
      return createQuery({ data: null, error: null });
    },
  };
}

function denyWorkflowCanvasLimit(retryAfterSeconds = 26) {
  rateLimitRpcMock.mockResolvedValue({
    data: {
      allowed: false,
      limit: 240,
      remaining: 0,
      retryAfterSeconds,
      resetAt: '2026-06-22T06:30:00.000Z',
    },
    error: null,
  });
}

function expectWorkflowCanvasRateLimitCall() {
  expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
    p_scope: 'workflow-canvas:mutate',
    p_subject_key: 'user-1',
    p_limit: 240,
    p_window_seconds: 600,
  });
}

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('workflow canvas mutation route rate limits', () => {
  beforeEach(() => {
    vi.resetModules();
    authenticateRequestMock.mockReset();
    createServiceClientMock.mockReset();
    rateLimitRpcMock.mockReset();
    userTableCalls.length = 0;
    serviceTableCalls.length = 0;
    authenticateRequestMock.mockResolvedValue({
      userId: 'user-1',
      supabase: createUserSupabaseMock(),
    });
    createServiceClientMock.mockReturnValue(createServiceSupabaseMock());
    denyWorkflowCanvasLimit();
  });

  it('returns 429 before parsing a new workflow canvas body', async () => {
    const jsonMock = vi.fn(async () => ({ title: 'New canvas' }));
    const { POST } = await import('@/app/api/workflow-canvases/route');
    const response = await POST({
      headers: new Headers({
        Authorization: 'Bearer token',
        'x-request-id': 'workflow-canvas-create-rate-limit-1',
      }),
      json: jsonMock,
    } as unknown as NextRequest);

    expect(response.status).toBe(429);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-canvas-create-rate-limit-1');
    expectWorkflowCanvasRateLimitCall();
    expect(jsonMock).not.toHaveBeenCalled();
    expect(userTableCalls).toEqual([]);
  });

  it('returns 429 before parsing a workflow canvas patch body', async () => {
    const jsonMock = vi.fn(async () => ({ title: 'Edited canvas' }));
    const { PATCH } = await import('@/app/api/workflow-canvases/[id]/route');
    const response = await PATCH({
      headers: new Headers({
        Authorization: 'Bearer token',
        'x-request-id': 'workflow-canvas-patch-rate-limit-1',
      }),
      json: jsonMock,
    } as unknown as NextRequest, {
      params: Promise.resolve({ id: 'canvas-1' }),
    });

    expect(response.status).toBe(429);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-canvas-patch-rate-limit-1');
    expectWorkflowCanvasRateLimitCall();
    expect(jsonMock).not.toHaveBeenCalled();
    expect(userTableCalls).toEqual([]);
  });

  it('returns 429 before deleting a workflow canvas', async () => {
    const { DELETE } = await import('@/app/api/workflow-canvases/[id]/route');
    const response = await DELETE(
      new Request('http://localhost/api/workflow-canvases/canvas-1', {
        method: 'DELETE',
        headers: { 'x-request-id': 'workflow-canvas-delete-rate-limit-1' },
      }) as NextRequest,
      { params: Promise.resolve({ id: 'canvas-1' }) },
    );

    expect(response.status).toBe(429);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-canvas-delete-rate-limit-1');
    expectWorkflowCanvasRateLimitCall();
    expect(userTableCalls).toEqual([]);
  });

  it('returns 429 before publishing a workflow canvas', async () => {
    const { POST } = await import('@/app/api/workflow-canvases/[id]/publish/route');
    const response = await POST(
      new Request('http://localhost/api/workflow-canvases/canvas-1/publish', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-canvas-publish-rate-limit-1' },
      }) as NextRequest,
      { params: Promise.resolve({ id: 'canvas-1' }) },
    );

    expect(response.status).toBe(429);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-canvas-publish-rate-limit-1');
    expectWorkflowCanvasRateLimitCall();
    expect(userTableCalls).toEqual([]);
  });

  it('returns 429 before creating a workflow share snapshot', async () => {
    const { POST } = await import('@/app/api/workflow-canvases/[id]/share/route');
    const response = await POST(
      new Request('http://localhost/api/workflow-canvases/canvas-1/share', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-canvas-share-rate-limit-1' },
      }) as NextRequest,
      { params: Promise.resolve({ id: 'canvas-1' }) },
    );

    expect(response.status).toBe(429);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-canvas-share-rate-limit-1');
    expectWorkflowCanvasRateLimitCall();
    expect(userTableCalls).toEqual([]);
  });

  it('returns 429 before restoring a workflow history entry', async () => {
    const { POST } = await import('@/app/api/workflow-canvases/[id]/history/[entryId]/restore/route');
    const response = await POST(
      new Request('http://localhost/api/workflow-canvases/canvas-1/history/history-1/restore', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-history-restore-rate-limit-1' },
      }) as NextRequest,
      { params: Promise.resolve({ id: 'canvas-1', entryId: 'history-1' }) },
    );

    expect(response.status).toBe(429);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-history-restore-rate-limit-1');
    expectWorkflowCanvasRateLimitCall();
    expect(userTableCalls).toEqual([]);
  });

  it('returns 429 before importing a shared workflow', async () => {
    const { POST } = await import('@/app/api/workflow-shares/[shareId]/import/route');
    const response = await POST(
      new Request(
        'http://localhost/api/workflow-shares/11111111-1111-4111-8111-111111111111/import',
        {
          method: 'POST',
          headers: { 'x-request-id': 'workflow-share-import-rate-limit-1' },
        },
      ) as NextRequest,
      { params: Promise.resolve({ shareId: '11111111-1111-4111-8111-111111111111' }) },
    );

    expect(response.status).toBe(429);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-share-import-rate-limit-1');
    expectWorkflowCanvasRateLimitCall();
    expect(userTableCalls).toEqual([]);
    expect(serviceTableCalls).toEqual([]);
  });

  it('returns 429 before discarding an assistant proposal', async () => {
    const { POST } = await import('@/app/api/workflow-canvases/[id]/assistant/proposals/[proposalId]/discard/route');
    const response = await POST(
      new Request(
        'http://localhost/api/workflow-canvases/canvas-1/assistant/proposals/proposal-1/discard',
        {
          method: 'POST',
          headers: { 'x-request-id': 'workflow-proposal-discard-rate-limit-1' },
        },
      ) as NextRequest,
      { params: Promise.resolve({ id: 'canvas-1', proposalId: 'proposal-1' }) },
    );

    expect(response.status).toBe(429);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-proposal-discard-rate-limit-1');
    expectWorkflowCanvasRateLimitCall();
    expect(userTableCalls).toEqual([]);
  });

  it('returns 429 before applying an assistant proposal', async () => {
    const { POST } = await import('@/app/api/workflow-canvases/[id]/assistant/proposals/[proposalId]/apply/route');
    const response = await POST(
      new Request(
        'http://localhost/api/workflow-canvases/canvas-1/assistant/proposals/proposal-1/apply',
        {
          method: 'POST',
          headers: { 'x-request-id': 'workflow-proposal-apply-rate-limit-1' },
        },
      ) as NextRequest,
      { params: Promise.resolve({ id: 'canvas-1', proposalId: 'proposal-1' }) },
    );

    expect(response.status).toBe(429);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-proposal-apply-rate-limit-1');
    expectWorkflowCanvasRateLimitCall();
    expect(userTableCalls).toEqual([]);
  });
});
