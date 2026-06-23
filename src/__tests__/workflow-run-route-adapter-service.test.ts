import { NextResponse } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  getWorkflowRunDetailsRouteResponse,
  postWorkflowRunRouteResponse,
} from '@/lib/workflow-run-route-adapter-service';
import type { WorkflowRunRouteResult } from '@/lib/workflow-run-route-service';

describe('workflow run route adapter service', () => {
  it('applies private headers to auth failures before parsing JSON or creating service clients', async () => {
    const json = vi.fn(async () => ({ startNodeId: 'node-1' }));
    const createServiceClient = vi.fn();
    const startWorkflowRunForRoute = vi.fn();

    const response = await postWorkflowRunRouteResponse({
      request: {
        headers: new Headers({ 'x-request-id': 'workflow-run-adapter-auth-1' }),
        json,
      } as unknown as Request,
      canvasId: 'canvas-1',
      dependencies: {
        authenticateRequest: vi.fn(async () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 })),
        createServiceClient,
        startWorkflowRunForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-run-adapter-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(json).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(startWorkflowRunForRoute).not.toHaveBeenCalled();
  });

  it('delegates parsed workflow run bodies with lazy admin-client and monitor scheduling handoffs', async () => {
    const supabase = { kind: 'user-client' } as unknown as SupabaseClient;
    const createServiceClient = vi.fn();
    const scheduleMonitor = vi.fn();
    const body = {
      startNodeId: 'node-1',
      mode: 'branch',
      catalogRevision: 'catalog-rev-1',
    };
    const startWorkflowRunForRoute = vi.fn(async (): Promise<WorkflowRunRouteResult> => ({
      ok: true,
      body: {
        runId: 'run-1',
        status: 'processing',
      },
    }));

    const response = await postWorkflowRunRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'workflow-run-adapter-success-1',
        },
        body: JSON.stringify(body),
      }),
      canvasId: 'canvas-1',
      dependencies: {
        authenticateRequest: vi.fn(async () => ({ userId: 'user-1', supabase })),
        createServiceClient,
        scheduleMonitor,
        startWorkflowRunForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-run-adapter-success-1');
    await expect(response.json()).resolves.toEqual({
      runId: 'run-1',
      status: 'processing',
    });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(startWorkflowRunForRoute).toHaveBeenCalledWith({
      supabase,
      adminSupabase: createServiceClient,
      userId: 'user-1',
      canvasId: 'canvas-1',
      body,
      scheduleMonitor,
    });
  });

  it('falls back to an empty body when JSON parsing fails and maps validation errors', async () => {
    const startWorkflowRunForRoute = vi.fn(async (): Promise<WorkflowRunRouteResult> => ({
      ok: false,
      status: 400,
      body: { error: 'A start node is required.' },
    }));

    const response = await postWorkflowRunRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1/run', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-run-adapter-json-1' },
        body: '{',
      }),
      canvasId: 'canvas-1',
      dependencies: {
        authenticateRequest: vi.fn(async () => ({
          userId: 'user-1',
          supabase: { kind: 'user-client' } as unknown as SupabaseClient,
        })),
        createServiceClient: vi.fn(),
        startWorkflowRunForRoute,
      },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'A start node is required.' });
    expect(startWorkflowRunForRoute).toHaveBeenCalledWith(expect.objectContaining({
      body: {},
    }));
  });

  it('maps workflow run rate-limit results to standard private responses', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 20,
      remaining: 0,
      retryAfterSeconds: 42,
      resetAt: '2026-06-23T11:00:00.000Z',
    });
    const startWorkflowRunForRoute = vi.fn(async (): Promise<WorkflowRunRouteResult> => ({
      ok: false,
      status: 429,
      rateLimitError,
      body: {
        error: 'Too many workflow run requests.',
        code: 'RATE_LIMITED',
        retryAfterSeconds: 42,
        limit: 20,
        resetAt: '2026-06-23T11:00:00.000Z',
      },
    }));

    const response = await postWorkflowRunRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1/run', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-run-adapter-limit-1' },
        body: JSON.stringify({ startNodeId: 'node-1' }),
      }),
      canvasId: 'canvas-1',
      dependencies: {
        authenticateRequest: vi.fn(async () => ({
          userId: 'user-1',
          supabase: { kind: 'user-client' } as unknown as SupabaseClient,
        })),
        createServiceClient: vi.fn(),
        startWorkflowRunForRoute,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-run-adapter-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 42,
      limit: 20,
    });
  });

  it('loads workflow run details after authentication and applies private headers', async () => {
    const supabase = { kind: 'user-client' } as unknown as SupabaseClient;
    const getWorkflowRunDetails = vi.fn(async () => ({
      id: 'run-1',
      canvas_id: 'canvas-1',
      status: 'processing',
      steps: [],
    }));

    const response = await getWorkflowRunDetailsRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1/runs/run-1', {
        headers: { 'x-request-id': 'workflow-run-detail-adapter-1' },
      }),
      context: { params: Promise.resolve({ id: 'canvas-1', runId: 'run-1' }) },
      dependencies: {
        authenticateRequest: vi.fn(async () => ({ userId: 'user-1', supabase })),
        getWorkflowRunDetails,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-run-detail-adapter-1');
    await expect(response.json()).resolves.toEqual({
      run: {
        id: 'run-1',
        canvas_id: 'canvas-1',
        status: 'processing',
        steps: [],
      },
    });
    expect(getWorkflowRunDetails).toHaveBeenCalledWith({
      supabase,
      canvasId: 'canvas-1',
      runId: 'run-1',
    });
  });

  it('maps workflow run detail failures to stable private 404 responses', async () => {
    const response = await getWorkflowRunDetailsRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1/runs/missing-run', {
        headers: { 'x-request-id': 'workflow-run-detail-miss-1' },
      }),
      context: { params: Promise.resolve({ id: 'canvas-1', runId: 'missing-run' }) },
      dependencies: {
        authenticateRequest: vi.fn(async () => ({
          userId: 'user-1',
          supabase: { kind: 'user-client' } as unknown as SupabaseClient,
        })),
        getWorkflowRunDetails: vi.fn(async () => {
          throw new Error('Workflow run not found.');
        }),
      },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-run-detail-miss-1');
    await expect(response.json()).resolves.toEqual({ error: 'Workflow run not found.' });
  });
});
