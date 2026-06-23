import { NextResponse } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  getWorkflowSharePreviewRouteResponse,
  postWorkflowShareCreateRouteResponse,
  postWorkflowShareImportRouteResponse,
} from '@/lib/workflow-share-route-adapter-service';
import { WORKFLOW_SHARE_SELECT } from '@/lib/workflow-share';

function createCanvasContext(canvasId = 'canvas-1') {
  return {
    params: Promise.resolve({ id: canvasId }),
  };
}

function createShareContext(shareId = '11111111-1111-4111-8111-111111111111') {
  return {
    params: Promise.resolve({ shareId }),
  };
}

function createSupabase(label: string) {
  return { label } as unknown as SupabaseClient;
}

describe('workflow share route adapter service', () => {
  it('rejects unauthenticated share creation before creating service clients or snapshots', async () => {
    const authenticateRequest = vi.fn(async () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const createServiceClient = vi.fn();
    const createWorkflowShareForRoute = vi.fn();

    const response = await postWorkflowShareCreateRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1/share', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-share-auth-1' },
      }),
      context: createCanvasContext(),
      dependencies: {
        authenticateRequest,
        createServiceClient,
        createWorkflowShareForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-share-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createWorkflowShareForRoute).not.toHaveBeenCalled();
  });

  it('delegates authenticated share creation with origin and private headers', async () => {
    const userSupabase = createSupabase('user');
    const serviceSupabase = createSupabase('service');
    const createServiceClient = vi.fn(() => serviceSupabase);
    const createWorkflowShareForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        share: {
          id: 'share-1',
          importUrl: 'https://app.example/create-workflow?import=share-1',
        },
      },
    }));

    const response = await postWorkflowShareCreateRouteResponse({
      request: new Request('https://app.example/api/workflow-canvases/canvas-1/share', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-share-create-1' },
      }),
      context: createCanvasContext('canvas-1'),
      dependencies: {
        authenticateRequest: vi.fn(async () => ({ supabase: userSupabase, userId: 'user-1' })),
        createServiceClient,
        createWorkflowShareForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-share-create-1');
    await expect(response.json()).resolves.toMatchObject({
      share: { id: 'share-1' },
    });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(createWorkflowShareForRoute).toHaveBeenCalledWith({
      canvasId: 'canvas-1',
      origin: 'https://app.example',
      serviceSupabase,
      userId: 'user-1',
      userSupabase,
    });
  });

  it('maps workflow share import rate-limit results into standard private responses', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 240,
      remaining: 0,
      retryAfterSeconds: 41,
      resetAt: '2026-06-23T06:30:00.000Z',
    });
    const importWorkflowShareForRoute = vi.fn(async () => ({
      ok: false as const,
      status: 429 as const,
      rateLimitError,
      body: { code: 'RATE_LIMITED' },
    }));

    const response = await postWorkflowShareImportRouteResponse({
      request: new Request('https://app.example/api/workflow-shares/11111111-1111-4111-8111-111111111111/import', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-share-import-limit-1' },
      }),
      context: createShareContext(),
      dependencies: {
        authenticateRequest: vi.fn(async () => ({ supabase: createSupabase('user'), userId: 'user-2' })),
        createServiceClient: vi.fn(() => createSupabase('service')),
        importWorkflowShareForRoute,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('41');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-share-import-limit-1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(importWorkflowShareForRoute).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'https://app.example',
      shareId: '11111111-1111-4111-8111-111111111111',
      userId: 'user-2',
    }));
  });

  it('rejects unauthenticated share previews before loading the share snapshot', async () => {
    const authenticateRequest = vi.fn(async () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const supabase = {
      from: vi.fn(),
    };

    const response = await getWorkflowSharePreviewRouteResponse({
      request: new Request('https://app.example/api/workflow-shares/11111111-1111-4111-8111-111111111111', {
        headers: { 'x-request-id': 'workflow-share-preview-auth-1' },
      }),
      context: createShareContext(),
      dependencies: {
        authenticateRequest,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-share-preview-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('rejects invalid share preview ids before querying workflow shares', async () => {
    const supabase = {
      from: vi.fn(),
    };

    const response = await getWorkflowSharePreviewRouteResponse({
      request: new Request('https://app.example/api/workflow-shares/not-a-share-id', {
        headers: { 'x-request-id': 'workflow-share-preview-invalid-1' },
      }),
      context: createShareContext('not-a-share-id'),
      dependencies: {
        authenticateRequest: vi.fn(async () => ({ supabase: supabase as unknown as SupabaseClient, userId: 'user-2' })),
      },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-share-preview-invalid-1');
    await expect(response.json()).resolves.toEqual({ error: 'Workflow share not found.' });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('loads authenticated share previews with origin-aware import URLs', async () => {
    const shareRow = {
      id: '11111111-1111-4111-8111-111111111111',
      owner_user_id: 'owner-1',
      source_canvas_id: 'canvas-1',
      source_revision: 4,
      title: 'Launch workflow',
      graph: { nodes: [], edges: [] },
      node_count: 0,
      edge_count: 0,
      import_count: 3,
      created_at: '2026-06-23T00:00:00.000Z',
    };
    const maybeSingle = vi.fn(async () => ({ data: shareRow, error: null }));
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const supabase = { from } as unknown as SupabaseClient;

    const response = await getWorkflowSharePreviewRouteResponse({
      request: new Request('https://app.example/api/workflow-shares/11111111-1111-4111-8111-111111111111', {
        headers: { 'x-request-id': 'workflow-share-preview-success-1' },
      }),
      context: createShareContext(),
      dependencies: {
        authenticateRequest: vi.fn(async () => ({ supabase, userId: 'user-2' })),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-share-preview-success-1');
    await expect(response.json()).resolves.toMatchObject({
      share: {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Launch workflow',
        sourceCanvasId: 'canvas-1',
        sourceRevision: 4,
        importUrl: 'https://app.example/create-workflow?import=11111111-1111-4111-8111-111111111111',
      },
    });
    expect(from).toHaveBeenCalledWith('workflow_shares');
    expect(select).toHaveBeenCalledWith(WORKFLOW_SHARE_SELECT);
    expect(eq).toHaveBeenCalledWith('id', '11111111-1111-4111-8111-111111111111');
  });
});
