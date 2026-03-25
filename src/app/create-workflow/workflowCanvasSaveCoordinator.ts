import { createWorkflowGraphHash, type WorkflowCanvasGraph, type WorkflowCanvasRecord } from '@/lib/workflow-canvas';

export interface CanvasSaveRequest {
  canvasId: string;
  baseRevision: number;
  title: string;
  graph: WorkflowCanvasGraph;
}

export type CanvasSaveResult =
  | { status: 'saved'; canvas: WorkflowCanvasRecord; revision: number }
  | { status: 'noop'; canvasId: string; revision: number }
  | { status: 'conflict'; canvas: WorkflowCanvasRecord }
  | { status: 'failed'; canvasId: string; error: string };

export function hasCanvasSaveChanges(
  request: CanvasSaveRequest,
  lastPersistedTitle: string,
  lastPersistedGraphHash: string
) {
  return (
    request.title !== lastPersistedTitle ||
    createWorkflowGraphHash(request.graph) !== lastPersistedGraphHash
  );
}

export async function drainQueuedCanvasSaves({
  initialRequest,
  executeSaveRequest,
  takePendingSave,
  clearPendingSave,
}: {
  initialRequest: CanvasSaveRequest;
  executeSaveRequest: (request: CanvasSaveRequest) => Promise<CanvasSaveResult>;
  takePendingSave: () => CanvasSaveRequest | null;
  clearPendingSave?: () => void;
}): Promise<CanvasSaveResult> {
  let request: CanvasSaveRequest | null = initialRequest;
  let lastResult: CanvasSaveResult = {
    status: 'noop',
    canvasId: initialRequest.canvasId,
    revision: initialRequest.baseRevision,
  };

  while (request) {
    lastResult = await executeSaveRequest(request);

    if (lastResult.status === 'failed' || lastResult.status === 'conflict') {
      clearPendingSave?.();
      break;
    }

    const pendingSave = takePendingSave();
    if (!pendingSave) {
      break;
    }

    if (pendingSave.canvasId === request.canvasId) {
      request = {
        ...pendingSave,
        baseRevision: lastResult.revision,
      };
      continue;
    }

    request = pendingSave;
  }

  return lastResult;
}

export async function flushCanvasSaveBeforeTransition({
  request,
  lastPersistedTitle,
  lastPersistedGraphHash,
  currentSavePromise,
  clearAutosaveTimer,
  persistRequest,
}: {
  request: CanvasSaveRequest | null;
  lastPersistedTitle: string;
  lastPersistedGraphHash: string;
  currentSavePromise: Promise<CanvasSaveResult> | null;
  clearAutosaveTimer: () => void;
  persistRequest: (request: CanvasSaveRequest) => Promise<CanvasSaveResult>;
}) {
  if (!request) {
    return true;
  }

  const hasUnsavedChanges = hasCanvasSaveChanges(
    request,
    lastPersistedTitle,
    lastPersistedGraphHash
  );

  if (!hasUnsavedChanges && !currentSavePromise) {
    return true;
  }

  clearAutosaveTimer();

  const result = hasUnsavedChanges
    ? await persistRequest(request)
    : await currentSavePromise;

  return result.status === 'saved' || result.status === 'noop';
}
