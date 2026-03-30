import { describe, expect, it, vi } from 'vitest';

import {
  drainQueuedCanvasSaves,
  flushCanvasSaveBeforeTransition,
  type CanvasSaveRequest,
  type CanvasSaveResult,
} from '@/app/create-workflow/workflowCanvasSaveCoordinator';
import { createStarterGraph, createWorkflowGraphHash, type WorkflowCanvasRecord } from '@/lib/workflow-canvas';

function createCanvasRecord(
  id: string,
  title: string,
  revision = 0,
): WorkflowCanvasRecord {
  return {
    id,
    title,
    graph: createStarterGraph(),
    created_at: '2026-03-22T00:00:00.000Z',
    updated_at: '2026-03-22T00:00:00.000Z',
    revision,
  };
}

describe('workflowCanvasSaveCoordinator', () => {
  it('replays queued saves for the same canvas with the new revision', async () => {
    const initialRequest: CanvasSaveRequest = {
      canvasId: 'canvas-a',
      baseRevision: 0,
      title: 'Draft one',
      graph: createStarterGraph(),
    };
    let pendingSave: CanvasSaveRequest | null = {
      ...initialRequest,
      title: 'Draft two',
    };
    const executedRequests: CanvasSaveRequest[] = [];

    const result = await drainQueuedCanvasSaves({
      initialRequest,
      executeSaveRequest: vi.fn(async (request) => {
        executedRequests.push(request);
        return {
          status: 'saved',
          canvas: createCanvasRecord(request.canvasId, request.title, request.baseRevision + 1),
          revision: request.baseRevision + 1,
        } satisfies CanvasSaveResult;
      }),
      takePendingSave: () => {
        const nextPendingSave = pendingSave;
        pendingSave = null;
        return nextPendingSave;
      },
    });

    expect(executedRequests).toHaveLength(2);
    expect(executedRequests[0]).toMatchObject({
      canvasId: 'canvas-a',
      baseRevision: 0,
      title: 'Draft one',
    });
    expect(executedRequests[1]).toMatchObject({
      canvasId: 'canvas-a',
      baseRevision: 1,
      title: 'Draft two',
    });
    expect(result).toMatchObject({
      status: 'saved',
      revision: 2,
    });
  });

  it('keeps queued saves attached to their own canvas identity', async () => {
    const initialRequest: CanvasSaveRequest = {
      canvasId: 'canvas-a',
      baseRevision: 4,
      title: 'Canvas A',
      graph: createStarterGraph(),
    };
    let pendingSave: CanvasSaveRequest | null = {
      canvasId: 'canvas-b',
      baseRevision: 2,
      title: 'Canvas B',
      graph: createStarterGraph(),
    };
    const executedRequests: CanvasSaveRequest[] = [];

    await drainQueuedCanvasSaves({
      initialRequest,
      executeSaveRequest: vi.fn(async (request) => {
        executedRequests.push(request);
        return {
          status: 'saved',
          canvas: createCanvasRecord(request.canvasId, request.title, request.baseRevision + 1),
          revision: request.baseRevision + 1,
        } satisfies CanvasSaveResult;
      }),
      takePendingSave: () => {
        const nextPendingSave = pendingSave;
        pendingSave = null;
        return nextPendingSave;
      },
    });

    expect(executedRequests).toHaveLength(2);
    expect(executedRequests[1]).toMatchObject({
      canvasId: 'canvas-b',
      baseRevision: 2,
      title: 'Canvas B',
    });
  });

  it('flushes a dirty canvas before allowing a transition', async () => {
    const graph = createStarterGraph();
    const request: CanvasSaveRequest = {
      canvasId: 'canvas-a',
      baseRevision: 0,
      title: 'Draft one',
      graph,
    };
    const clearAutosaveTimer = vi.fn();
    const persistRequest = vi.fn(async () => ({
      status: 'saved',
      canvas: createCanvasRecord('canvas-a', 'Draft one', 1),
      revision: 1,
    } satisfies CanvasSaveResult));

    const canTransition = await flushCanvasSaveBeforeTransition({
      request,
      lastPersistedTitle: 'Workflow canvas',
      lastPersistedGraphHash: createWorkflowGraphHash(graph, { mode: 'client-save' }),
      currentSavePromise: null,
      clearAutosaveTimer,
      persistRequest,
    });

    expect(canTransition).toBe(true);
    expect(clearAutosaveTimer).toHaveBeenCalledTimes(1);
    expect(persistRequest).toHaveBeenCalledWith(request);
  });

  it('waits for an in-flight save when there are no new local changes', async () => {
    const graph = createStarterGraph();
    const request: CanvasSaveRequest = {
      canvasId: 'canvas-a',
      baseRevision: 1,
      title: 'Workflow canvas',
      graph,
    };
    const clearAutosaveTimer = vi.fn();
    const persistRequest = vi.fn();

    const canTransition = await flushCanvasSaveBeforeTransition({
      request,
      lastPersistedTitle: 'Workflow canvas',
      lastPersistedGraphHash: createWorkflowGraphHash(graph, { mode: 'client-save' }),
      currentSavePromise: Promise.resolve({
        status: 'saved',
        canvas: createCanvasRecord('canvas-a', 'Workflow canvas', 2),
        revision: 2,
      } satisfies CanvasSaveResult),
      clearAutosaveTimer,
      persistRequest,
    });

    expect(canTransition).toBe(true);
    expect(clearAutosaveTimer).toHaveBeenCalledTimes(1);
    expect(persistRequest).not.toHaveBeenCalled();
  });
});
