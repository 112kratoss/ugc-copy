import { NextResponse } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { mockRequestIdPassthrough } from '@/__tests__/fixtures/request-id-passthrough';
import type { SupabaseClient } from '@supabase/supabase-js';

import { postWorkflowAssistantMessageRouteResponse } from '@/lib/workflow-assistant-message-route-adapter-service';

function createContext(canvasId = 'canvas-1') {
  return {
    params: Promise.resolve({ id: canvasId }),
  };
}

function createSupabase() {
  return { kind: 'workflow-supabase' } as unknown as SupabaseClient;
}

describe('workflow assistant message route adapter service', () => {
  it('rejects unauthenticated messages before creating privileged clients or service work', async () => {
    const authenticateRequest = vi.fn(async () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const createServiceClient = vi.fn();
    const createWorkflowAssistantMessageForRoute = vi.fn();
    const withProviderFetchRequestId = mockRequestIdPassthrough();

    const response = await postWorkflowAssistantMessageRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-1/assistant/messages', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-message-auth-1' },
      }),
      context: createContext(),
      dependencies: {
        authenticateRequest,
        createServiceClient,
        createWorkflowAssistantMessageForRoute,
        withProviderFetchRequestId,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-message-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(withProviderFetchRequestId).toHaveBeenCalledWith('workflow-message-auth-1', expect.any(Function));
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createWorkflowAssistantMessageForRoute).not.toHaveBeenCalled();
  });

  it('delegates authenticated messages with parsed body, admin client, request, and private headers', async () => {
    const supabase = createSupabase();
    const adminSupabase = { kind: 'admin-supabase' } as unknown as SupabaseClient;
    const createServiceClient = vi.fn(() => adminSupabase);
    const createWorkflowAssistantMessageForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        messages: [{ id: 'msg-1', role: 'assistant' }],
        remainingCredits: 94,
      },
    }));

    const request = new Request('http://localhost/api/workflow-canvases/canvas-1/assistant/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'workflow-message-success-1',
      },
      body: JSON.stringify({ content: 'Create a launch workflow.' }),
    });
    const response = await postWorkflowAssistantMessageRouteResponse({
      request,
      context: createContext(),
      dependencies: {
        authenticateRequest: vi.fn(async () => ({ supabase, userId: 'user-1' })),
        createServiceClient,
        createWorkflowAssistantMessageForRoute,
        withProviderFetchRequestId: mockRequestIdPassthrough(),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-message-success-1');
    await expect(response.json()).resolves.toMatchObject({
      remainingCredits: 94,
      messages: [{ id: 'msg-1' }],
    });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(createWorkflowAssistantMessageForRoute).toHaveBeenCalledWith({
      adminSupabase,
      body: { content: 'Create a launch workflow.' },
      canvasId: 'canvas-1',
      request,
      supabase,
      userId: 'user-1',
    });
  });

  it('tolerates malformed JSON and maps service headers onto private error responses', async () => {
    const createWorkflowAssistantMessageForRoute = vi.fn(async () => ({
      ok: false as const,
      status: 429 as const,
      headers: { 'Retry-After': '30' },
      body: { code: 'RATE_LIMITED' },
    }));

    const response = await postWorkflowAssistantMessageRouteResponse({
      request: new Request('http://localhost/api/workflow-canvases/canvas-2/assistant/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'workflow-message-rate-limit-1',
        },
        body: '{"content":',
      }),
      context: createContext('canvas-2'),
      dependencies: {
        authenticateRequest: vi.fn(async () => ({ supabase: createSupabase(), userId: 'user-1' })),
        createServiceClient: vi.fn(() => ({ kind: 'admin-supabase' }) as unknown as SupabaseClient),
        createWorkflowAssistantMessageForRoute,
        withProviderFetchRequestId: mockRequestIdPassthrough(),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-message-rate-limit-1');
    await expect(response.json()).resolves.toEqual({ code: 'RATE_LIMITED' });
    expect(createWorkflowAssistantMessageForRoute).toHaveBeenCalledWith(expect.objectContaining({
      body: {},
      canvasId: 'canvas-2',
    }));
  });
});
