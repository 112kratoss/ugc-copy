import { NextResponse } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { postWorkflowAssistantProposalApplyRouteResponse } from '@/lib/workflow-assistant-proposal-apply-route-adapter-service';

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
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-apply-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(enforceWorkflowCanvasMutationRateLimit).not.toHaveBeenCalled();
    expect(applyWorkflowAssistantProposalForRoute).not.toHaveBeenCalled();
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
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-apply-limit-1');
    await expect(response.json()).resolves.toEqual({ code: 'RATE_LIMITED' });
    expect(applyWorkflowAssistantProposalForRoute).not.toHaveBeenCalled();
  });

  it('delegates valid apply requests to the atomic proposal application service', async () => {
    const supabase = createSupabase();
    const applyWorkflowAssistantProposalForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        canvas: { id: 'canvas-1', revision: 5 },
        proposal: { id: 'proposal-1', status: 'applied' },
      },
    }));

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
  });
});
