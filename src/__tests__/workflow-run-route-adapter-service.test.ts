import { NextResponse } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  getWorkflowRunDetailsRouteResponse,
  postWorkflowRunApprovalRouteResponse,
  postWorkflowRunRouteResponse,
} from '@/lib/workflow-run-route-adapter-service';
import { WorkflowRunApprovalError } from '@/lib/workflow-runner';
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

  it('delegates parsed workflow run bodies with a lazy admin client and idempotency key', async () => {
    const supabase = { kind: 'user-client' } as unknown as SupabaseClient;
    const createServiceClient = vi.fn();
    const processWorkflowRunStepJobs = vi.fn(async () => ({
      claimed: 1, advanced: 1, deferred: 0, retried: 0, exhausted: 0, failed: 0, adopted: 0,
    }));
    const scheduleWorker = vi.fn((callback: () => Promise<void>) => { void callback(); });
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
          'Idempotency-Key': 'run-key-adapter-1',
          'x-request-id': 'workflow-run-adapter-success-1',
        },
        body: JSON.stringify(body),
      }),
      canvasId: 'canvas-1',
      dependencies: {
        authenticateRequest: vi.fn(async () => ({ userId: 'user-1', supabase })),
        createServiceClient,
        processWorkflowRunStepJobs,
        scheduleWorker,
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
    expect(scheduleWorker).toHaveBeenCalledTimes(1);
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(processWorkflowRunStepJobs).toHaveBeenCalledWith(expect.objectContaining({
      limit: 1,
      concurrency: 1,
    }));
    expect(startWorkflowRunForRoute).toHaveBeenCalledWith({
      supabase,
      adminSupabase: createServiceClient,
      userId: 'user-1',
      canvasId: 'canvas-1',
      body,
      idempotencyKeyHeader: 'run-key-adapter-1',
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
      start_node_id: 'node-1',
      mode: 'branch' as const,
      status: 'processing' as const,
      created_at: '2026-06-23T10:00:00.000Z',
      finished_at: null,
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
        start_node_id: 'node-1',
        mode: 'branch',
        status: 'processing',
        created_at: '2026-06-23T10:00:00.000Z',
        finished_at: null,
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

  it('never leaks underlying load-failure details through the 404 response', async () => {
    const response = await getWorkflowRunDetailsRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1/runs/run-1'),
      context: { params: Promise.resolve({ id: 'canvas-1', runId: 'run-1' }) },
      dependencies: {
        authenticateRequest: vi.fn(async () => ({
          userId: 'user-1',
          supabase: { kind: 'user-client' } as unknown as SupabaseClient,
        })),
        getWorkflowRunDetails: vi.fn(async () => {
          throw new Error('permission denied for table workflow_canvas_runs');
        }),
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Workflow run not found.' });
  });

  it('approves a workflow checkpoint with rate limiting and private response headers', async () => {
    const supabase = { kind: 'user-client' } as unknown as SupabaseClient;
    const adminSupabase = { kind: 'admin-client' };
    const approveWorkflowRunStep = vi.fn(async () => ({
      id: 'run-1',
      canvas_id: 'canvas-1',
      start_node_id: 'node-1',
      mode: 'branch' as const,
      status: 'processing' as const,
      created_at: '2026-06-23T10:00:00.000Z',
      finished_at: null,
      steps: [],
    }));
    const enforceBackendRateLimit = vi.fn(async () => ({
      allowed: true,
      limit: 60,
      remaining: 59,
      retryAfterSeconds: 0,
      resetAt: '2026-06-23T10:10:00.000Z',
    }));
    const processWorkflowRunStepJobs = vi.fn(async () => ({
      claimed: 1, advanced: 1, deferred: 0, retried: 0, exhausted: 0, failed: 0, adopted: 0,
    }));
    const scheduleWorker = vi.fn((callback: () => Promise<void>) => { void callback(); });

    const response = await postWorkflowRunApprovalRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1/runs/run-1/approval-steps/step-1/approve', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-approval-1' },
      }),
      context: {
        params: Promise.resolve({ id: 'canvas-1', runId: 'run-1', stepId: 'step-1' }),
      },
      dependencies: {
        authenticateRequest: vi.fn(async () => ({ userId: 'user-1', supabase })),
        approveWorkflowRunStep,
        createServiceClient: vi.fn(() => adminSupabase as never),
        enforceBackendRateLimit,
        processWorkflowRunStepJobs,
        scheduleWorker,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-approval-1');
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(adminSupabase, expect.objectContaining({
      key: 'user-1',
    }));
    expect(approveWorkflowRunStep).toHaveBeenCalledWith({
      supabase,
      canvasId: 'canvas-1',
      runId: 'run-1',
      stepId: 'step-1',
    });
    expect(scheduleWorker).toHaveBeenCalledTimes(1);
    expect(processWorkflowRunStepJobs).toHaveBeenCalledWith(expect.objectContaining({
      limit: 1,
      concurrency: 1,
    }));
  });

  it('returns a conflict when a workflow checkpoint is no longer awaiting approval', async () => {
    const response = await postWorkflowRunApprovalRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1/runs/run-1/approval-steps/step-1/approve', {
        method: 'POST',
      }),
      context: {
        params: Promise.resolve({ id: 'canvas-1', runId: 'run-1', stepId: 'step-1' }),
      },
      dependencies: {
        authenticateRequest: vi.fn(async () => ({
          userId: 'user-1',
          supabase: { kind: 'user-client' } as unknown as SupabaseClient,
        })),
        approveWorkflowRunStep: vi.fn(async () => {
          throw new WorkflowRunApprovalError('This approval step is not waiting for review.', 409);
        }),
        createServiceClient: vi.fn(() => ({ kind: 'admin-client' }) as never),
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 60,
          remaining: 59,
          retryAfterSeconds: 0,
          resetAt: '2026-06-23T10:10:00.000Z',
        })),
      },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'This approval step is not waiting for review.',
    });
  });
});
