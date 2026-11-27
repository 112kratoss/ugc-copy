import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useWorkflowCanvasAssistant } from '@/app/create-workflow/useWorkflowCanvasAssistant';
import { createStarterGraph } from '@/lib/workflow-canvas';

// An assistant message costs credits. An unreadable 200 or an unexplained 5xx read "Workflow
// assistant request failed.", so the person could send again and pay twice (review of the
// 2026-11-27 change): the outcome is unknown, and the hook says so.
const html = (status: number) => new Response('<!DOCTYPE html><p>Bad gateway</p>', { status });

afterEach(() => vi.unstubAllGlobals());

async function sendOnce(messageAnswer: Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (
    String(input).endsWith('/assistant/messages')
      ? messageAnswer
      : new Response(JSON.stringify({ messages: [], proposal: null, availability: 'ready' }), { status: 200 })
  )));
  // One options object for every render: a new authHeaders each render reloads the state forever.
  const options = {
    activeCanvasId: 'canvas-1',
    activeCanvasRevision: 1,
    authHeaders: async () => ({ Authorization: 'Bearer token' }),
    canvasTitle: 'Canvas',
    graph: createStarterGraph(),
    hasUnsavedChanges: false,
    onApplyCanvas: vi.fn(),
    onPersistCanvas: vi.fn(async () => ({ status: 'noop' as const })),
    onUpdateCredits: vi.fn(),
  } as unknown as Parameters<typeof useWorkflowCanvasAssistant>[0];
  const { result } = renderHook(() => useWorkflowCanvasAssistant(options));
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  act(() => result.current.setInput('Add a video step'));
  await act(async () => { await result.current.sendMessage(); });
  return result.current.error;
}

describe('a paid assistant message whose outcome is unknown', () => {
  it('says so after an HTML 502', async () => {
    expect(await sendOnce(html(502))).toMatch(/could not confirm/i);
  });

  it('says so after a 200 whose body cannot be read', async () => {
    expect(await sendOnce(html(200))).toMatch(/could not confirm/i);
  });

  it('keeps the server\'s refusal as it is', async () => {
    const refusal = new Response(JSON.stringify({ error: 'Not enough credits.' }), { status: 402 });
    expect(await sendOnce(refusal)).toBe('Not enough credits.');
  });
});
