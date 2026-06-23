import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { createWorkflowAssistantStateRouteHandlers } from '@/lib/workflow-assistant-state-route-adapter-service';

function createContext(canvasId = 'canvas-1') {
  return {
    params: Promise.resolve({ id: canvasId }),
  };
}

function createSupabase() {
  return { kind: 'workflow-supabase' } as unknown as SupabaseClient;
}

describe('workflow assistant state route adapter service', () => {
  it('rejects unauthenticated state requests before loading assistant state', async () => {
    const getWorkflowAssistantStateForRoute = vi.fn();
    const { GET } = createWorkflowAssistantStateRouteHandlers({
      dependencies: {
        authenticateRequest: vi.fn(async () => NextResponse.json(
          { error: 'Unauthorized' },
          { status: 401 },
        )),
        getWorkflowAssistantStateForRoute,
      },
    });

    const response = await GET(
      new Request('http://localhost/api/workflow-canvases/canvas-1/assistant', {
        headers: { 'x-request-id': 'workflow-state-auth-1' },
      }),
      createContext(),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-state-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(getWorkflowAssistantStateForRoute).not.toHaveBeenCalled();
  });

  it('delegates authenticated state requests with the canvas id, Supabase client, and user id', async () => {
    const supabase = createSupabase();
    const getWorkflowAssistantStateForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        availability: 'ready',
        messages: [],
        proposal: null,
        setupMessage: null,
      },
    }));
    const { GET } = createWorkflowAssistantStateRouteHandlers({
      dependencies: {
        authenticateRequest: vi.fn(async () => ({ supabase, userId: 'user-1' })),
        getWorkflowAssistantStateForRoute,
      },
    });
    const request = new Request('http://localhost/api/workflow-canvases/canvas-2/assistant', {
      headers: { 'x-request-id': 'workflow-state-success-1' },
    });

    const response = await GET(request, createContext('canvas-2'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-state-success-1');
    await expect(response.json()).resolves.toEqual({
      availability: 'ready',
      messages: [],
      proposal: null,
      setupMessage: null,
    });
    expect(getWorkflowAssistantStateForRoute).toHaveBeenCalledWith({
      canvasId: 'canvas-2',
      supabase,
      userId: 'user-1',
    });
  });

  it('maps service failure status and body onto private state responses', async () => {
    const getWorkflowAssistantStateForRoute = vi.fn(async () => ({
      ok: false as const,
      status: 404 as const,
      body: { error: 'Workflow canvas not found.' },
    }));
    const { GET } = createWorkflowAssistantStateRouteHandlers({
      dependencies: {
        authenticateRequest: vi.fn(async () => ({
          supabase: createSupabase(),
          userId: 'user-1',
        })),
        getWorkflowAssistantStateForRoute,
      },
    });

    const response = await GET(
      new Request('http://localhost/api/workflow-canvases/missing-canvas/assistant', {
        headers: { 'x-request-id': 'workflow-state-missing-1' },
      }),
      createContext('missing-canvas'),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-state-missing-1');
    await expect(response.json()).resolves.toEqual({ error: 'Workflow canvas not found.' });
  });
});
