import { NextResponse } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { postWorkflowAssistantProposalDiscardRouteResponse } from '@/lib/workflow-assistant-proposal-discard-route-adapter-service';
import type { WorkflowAssistantProposalDiscardRouteResult } from '@/lib/workflow-assistant-proposal-discard-service';

function createContext(canvasId = 'canvas-1', proposalId = 'proposal-1') {
  return {
    params: Promise.resolve({ id: canvasId, proposalId }),
  };
}

function createSupabase() {
  return { kind: 'workflow-supabase' } as unknown as SupabaseClient;
}

describe('workflow assistant proposal discard route adapter service', () => {
  it('rejects unauthenticated discard requests before rate limiting or service work', async () => {
    const authenticateRequest = vi.fn(async () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const enforceWorkflowCanvasMutationRateLimit = vi.fn();
    const discardWorkflowAssistantProposalForRoute = vi.fn();

    const response = await postWorkflowAssistantProposalDiscardRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1/assistant/proposals/proposal-1/discard', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-discard-auth-1' },
      }),
      context: createContext(),
      dependencies: {
        authenticateRequest,
        discardWorkflowAssistantProposalForRoute,
        enforceWorkflowCanvasMutationRateLimit,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-discard-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(enforceWorkflowCanvasMutationRateLimit).not.toHaveBeenCalled();
    expect(discardWorkflowAssistantProposalForRoute).not.toHaveBeenCalled();
  });

  it('returns mutation rate-limit responses before discarding the proposal', async () => {
    const supabase = createSupabase();
    const rateLimitResponse = NextResponse.json({ code: 'RATE_LIMITED' }, { status: 429 });
    rateLimitResponse.headers.set('Retry-After', '37');
    const discardWorkflowAssistantProposalForRoute = vi.fn();

    const response = await postWorkflowAssistantProposalDiscardRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1/assistant/proposals/proposal-1/discard', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-discard-limit-1' },
      }),
      context: createContext(),
      dependencies: {
        authenticateRequest: vi.fn(async () => ({ supabase, userId: 'user-1' })),
        discardWorkflowAssistantProposalForRoute,
        enforceWorkflowCanvasMutationRateLimit: vi.fn(async () => rateLimitResponse),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('37');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-discard-limit-1');
    await expect(response.json()).resolves.toEqual({ code: 'RATE_LIMITED' });
    expect(discardWorkflowAssistantProposalForRoute).not.toHaveBeenCalled();
  });

  it('delegates valid discard requests with authenticated owner context', async () => {
    const supabase = createSupabase();
    const discardWorkflowAssistantProposalForRoute = vi.fn(
      async (): Promise<WorkflowAssistantProposalDiscardRouteResult> => ({
        ok: true,
        body: {
          proposal: {
            id: 'proposal-1',
            status: 'discarded',
          },
        },
      }),
    );

    const response = await postWorkflowAssistantProposalDiscardRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1/assistant/proposals/proposal-1/discard', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-discard-success-1' },
      }),
      context: createContext(),
      dependencies: {
        authenticateRequest: vi.fn(async () => ({ supabase, userId: 'user-1' })),
        discardWorkflowAssistantProposalForRoute,
        enforceWorkflowCanvasMutationRateLimit: vi.fn(async () => null),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-discard-success-1');
    await expect(response.json()).resolves.toEqual({
      proposal: {
        id: 'proposal-1',
        status: 'discarded',
      },
    });
    expect(discardWorkflowAssistantProposalForRoute).toHaveBeenCalledWith({
      canvasId: 'canvas-1',
      proposalId: 'proposal-1',
      supabase,
      userId: 'user-1',
    });
  });
});
