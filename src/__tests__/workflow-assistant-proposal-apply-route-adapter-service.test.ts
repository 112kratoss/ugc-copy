import { NextResponse } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { postWorkflowAssistantProposalApplyRouteResponse } from '@/lib/workflow-assistant-proposal-apply-route-adapter-service';
import type { WorkflowCanvasGraph } from '@/lib/workflow-canvas';

function createContext(canvasId = 'canvas-1', proposalId = 'proposal-1') {
  return {
    params: Promise.resolve({ id: canvasId, proposalId }),
  };
}

function createSupabase() {
  return { kind: 'workflow-supabase' } as unknown as SupabaseClient;
}

describe('workflow assistant proposal apply route adapter service', () => {
  it('rejects unauthenticated apply requests before rate limiting or service work', async () => {
    const authenticateRequest = vi.fn(async () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const enforceWorkflowCanvasMutationRateLimit = vi.fn();
    const applyWorkflowAssistantProposalForRoute = vi.fn();
    const patchWorkflowCanvas = vi.fn();

    const response = await postWorkflowAssistantProposalApplyRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1/assistant/proposals/proposal-1/apply', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-apply-auth-1' },
      }),
      context: createContext(),
      dependencies: {
        applyWorkflowAssistantProposalForRoute,
        authenticateRequest,
        enforceWorkflowCanvasMutationRateLimit,
        patchWorkflowCanvas,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-apply-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(enforceWorkflowCanvasMutationRateLimit).not.toHaveBeenCalled();
    expect(applyWorkflowAssistantProposalForRoute).not.toHaveBeenCalled();
    expect(patchWorkflowCanvas).not.toHaveBeenCalled();
  });

  it('returns mutation rate-limit responses before applying the proposal', async () => {
    const supabase = createSupabase();
    const rateLimitResponse = NextResponse.json({ code: 'RATE_LIMITED' }, { status: 429 });
    rateLimitResponse.headers.set('Retry-After', '42');
    const applyWorkflowAssistantProposalForRoute = vi.fn();

    const response = await postWorkflowAssistantProposalApplyRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1/assistant/proposals/proposal-1/apply', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-apply-limit-1' },
      }),
      context: createContext(),
      dependencies: {
        applyWorkflowAssistantProposalForRoute,
        authenticateRequest: vi.fn(async () => ({ supabase, userId: 'user-1' })),
        enforceWorkflowCanvasMutationRateLimit: vi.fn(async () => rateLimitResponse),
        patchWorkflowCanvas: vi.fn(),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-apply-limit-1');
    await expect(response.json()).resolves.toEqual({ code: 'RATE_LIMITED' });
    expect(applyWorkflowAssistantProposalForRoute).not.toHaveBeenCalled();
  });

  it('delegates valid apply requests through the canvas PATCH bridge with rate-limit skipped', async () => {
    const supabase = createSupabase();
    const patchWorkflowCanvas = vi.fn(async () => NextResponse.json({
      canvas: {
        id: 'canvas-1',
        revision: 5,
      },
    }));
    const proposedGraph = {
      version: 1,
      nodes: [],
      edges: [],
    } as unknown as WorkflowCanvasGraph;
    const applyWorkflowAssistantProposalForRoute = vi.fn(async ({
      applyCanvasPatch,
    }: {
      applyCanvasPatch: (input: {
        canvasId: string;
        graph: WorkflowCanvasGraph;
        baseRevision: number;
      }) => Promise<{ ok: boolean; status: number; body: Record<string, unknown> }>;
    }) => {
      const patchResult = await applyCanvasPatch({
        canvasId: 'canvas-1',
        graph: proposedGraph,
        baseRevision: 4,
      });

      return {
        ok: true as const,
        body: {
          canvas: patchResult.body.canvas,
          proposal: { id: 'proposal-1', status: 'applied' },
        },
      };
    });

    const response = await postWorkflowAssistantProposalApplyRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1/assistant/proposals/proposal-1/apply', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer user-token',
          'x-request-id': 'workflow-apply-success-1',
        },
      }),
      context: createContext(),
      dependencies: {
        applyWorkflowAssistantProposalForRoute,
        authenticateRequest: vi.fn(async () => ({ supabase, userId: 'user-1' })),
        enforceWorkflowCanvasMutationRateLimit: vi.fn(async () => null),
        patchWorkflowCanvas,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-apply-success-1');
    await expect(response.json()).resolves.toMatchObject({
      proposal: { id: 'proposal-1', status: 'applied' },
      canvas: { id: 'canvas-1', revision: 5 },
    });
    expect(applyWorkflowAssistantProposalForRoute).toHaveBeenCalledWith(expect.objectContaining({
      canvasId: 'canvas-1',
      proposalId: 'proposal-1',
      supabase,
      userId: 'user-1',
    }));
    expect(patchWorkflowCanvas).toHaveBeenCalledTimes(1);
    const [patchRequest, patchContext, patchOptions] = patchWorkflowCanvas.mock.calls[0];
    expect((patchRequest as Request).url).toBe('http://localhost/api/workflow-canvases/canvas-1');
    expect((patchRequest as Request).headers.get('Authorization')).toBe('Bearer user-token');
    await expect((patchRequest as Request).json()).resolves.toEqual({
      graph: proposedGraph,
      baseRevision: 4,
    });
    await expect((patchContext as { params: Promise<{ id: string }> }).params).resolves.toEqual({ id: 'canvas-1' });
    expect(patchOptions).toEqual({ skipRateLimit: true });
  });
});
