'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createWorkflowGraphHash, type WorkflowCanvasGraph, type WorkflowCanvasRecord } from '@/lib/workflow-canvas';
import {
  drainQueuedCanvasSaves,
  flushCanvasSaveBeforeTransition,
  hasCanvasSaveChanges,
  type CanvasSaveRequest,
  type CanvasSaveResult,
} from './workflowCanvasSaveCoordinator';

export type CanvasSaveState = 'saved' | 'dirty' | 'saving';

interface UseWorkflowCanvasPersistenceOptions {
  activeCanvasId: string | null;
  canvasTitle: string;
  graph: WorkflowCanvasGraph;
  autosaveKey: number;
  isLoading: boolean;
  authHeaders: () => Promise<Record<string, string>>;
  onSavedCanvas: (canvas: WorkflowCanvasRecord) => void;
  onConflictCanvas: (canvas: WorkflowCanvasRecord) => void;
  onError: (message: string | null) => void;
}

export function useWorkflowCanvasPersistence({
  activeCanvasId,
  canvasTitle,
  graph,
  autosaveKey,
  isLoading,
  authHeaders,
  onSavedCanvas,
  onConflictCanvas,
  onError,
}: UseWorkflowCanvasPersistenceOptions) {
  const autosaveTimer = useRef<NodeJS.Timeout | null>(null);
  const activeCanvasIdRef = useRef<string | null>(activeCanvasId);
  const activeCanvasRevisionRef = useRef(0);
  const canvasTitleRef = useRef(canvasTitle);
  const graphRef = useRef(graph);
  const lastPersistedTitleRef = useRef(canvasTitle);
  const lastPersistedGraphHashRef = useRef(createWorkflowGraphHash(graph, { mode: 'client-save' }));
  const saveInFlightRef = useRef(false);
  const savePromiseRef = useRef<Promise<CanvasSaveResult> | null>(null);
  const pendingSaveRef = useRef<CanvasSaveRequest | null>(null);
  const [saveState, setSaveState] = useState<CanvasSaveState>('saved');
  const [activeCanvasRevision, setActiveCanvasRevision] = useState(0);

  useEffect(() => {
    activeCanvasIdRef.current = activeCanvasId;
  }, [activeCanvasId]);

  useEffect(() => {
    canvasTitleRef.current = canvasTitle;
  }, [canvasTitle]);

  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);

  const clearAutosaveTimer = useCallback(() => {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
  }, []);

  const syncPersistedCanvas = useCallback((canvas: WorkflowCanvasRecord) => {
    activeCanvasIdRef.current = canvas.id;
    activeCanvasRevisionRef.current = canvas.revision ?? 0;
    canvasTitleRef.current = canvas.title;
    graphRef.current = canvas.graph;
    lastPersistedTitleRef.current = canvas.title;
    lastPersistedGraphHashRef.current = createWorkflowGraphHash(canvas.graph, { mode: 'client-save' });
    pendingSaveRef.current = null;
    setActiveCanvasRevision(canvas.revision ?? 0);
    setSaveState('saved');
    onError(null);
  }, [onError]);

  const buildSaveRequest = useCallback((overrides?: Partial<Pick<CanvasSaveRequest, 'title' | 'graph'>>) => {
    const canvasId = activeCanvasIdRef.current;
    if (!canvasId) {
      return null;
    }

    return {
      canvasId,
      baseRevision: activeCanvasRevisionRef.current,
      title: overrides?.title ?? canvasTitleRef.current,
      graph: overrides?.graph ?? graphRef.current,
    } satisfies CanvasSaveRequest;
  }, []);

  const executeSaveRequest = useCallback(async (request: CanvasSaveRequest): Promise<CanvasSaveResult> => {
    const nextGraphHash = createWorkflowGraphHash(request.graph, { mode: 'client-save' });

    if (
      request.canvasId === activeCanvasIdRef.current &&
      request.title === lastPersistedTitleRef.current &&
      nextGraphHash === lastPersistedGraphHashRef.current
    ) {
      setSaveState(saveInFlightRef.current ? 'saving' : 'saved');
      return {
        status: 'noop',
        canvasId: request.canvasId,
        revision: activeCanvasRevisionRef.current,
      };
    }

    try {
      const response = await fetch(`/api/workflow-canvases/${request.canvasId}`, {
        method: 'PATCH',
        headers: await authHeaders(),
        body: JSON.stringify({
          title: request.title,
          graph: request.graph,
          baseRevision: request.baseRevision,
          graphHash: nextGraphHash,
        }),
      });
      const data = await response.json();

      if (response.status === 409 && data.canvas) {
        const conflictedCanvas = data.canvas as WorkflowCanvasRecord;
        onConflictCanvas(conflictedCanvas);
        onError('A newer canvas revision was detected. The latest saved version has been reloaded.');
        return {
          status: 'conflict',
          canvas: conflictedCanvas,
        };
      }

      if (!response.ok) {
        throw new Error(data.error || 'Failed to save canvas');
      }

      const savedCanvas = data.canvas as WorkflowCanvasRecord;
      onSavedCanvas(savedCanvas);

      if (activeCanvasIdRef.current === request.canvasId) {
        activeCanvasRevisionRef.current = savedCanvas.revision ?? request.baseRevision;
        lastPersistedTitleRef.current = savedCanvas.title;
        lastPersistedGraphHashRef.current = createWorkflowGraphHash(savedCanvas.graph, { mode: 'client-save' });
        setActiveCanvasRevision(savedCanvas.revision ?? request.baseRevision);
        setSaveState('saved');
        onError(null);
      }

      return {
        status: 'saved',
        canvas: savedCanvas,
        revision: savedCanvas.revision ?? request.baseRevision,
      };
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Failed to save canvas';
      if (activeCanvasIdRef.current === request.canvasId) {
        setSaveState('dirty');
      }
      onError(message);
      return {
        status: 'failed',
        canvasId: request.canvasId,
        error: message,
      };
    }
  }, [authHeaders, onConflictCanvas, onError, onSavedCanvas]);

  const drainSaveQueue = useCallback(async (initialRequest: CanvasSaveRequest): Promise<CanvasSaveResult> => {
    return drainQueuedCanvasSaves({
      initialRequest,
      executeSaveRequest,
      takePendingSave: () => {
        const pendingSave = pendingSaveRef.current;
        pendingSaveRef.current = null;
        return pendingSave;
      },
      clearPendingSave: () => {
        pendingSaveRef.current = null;
      },
    });
  }, [executeSaveRequest]);

  const persistCanvas = useCallback((nextTitle?: string, nextGraph?: WorkflowCanvasGraph) => {
    const request = buildSaveRequest({
      ...(nextTitle !== undefined ? { title: nextTitle } : {}),
      ...(nextGraph !== undefined ? { graph: nextGraph } : {}),
    });

    if (!request) {
      return Promise.resolve<CanvasSaveResult>({
        status: 'failed',
        canvasId: '',
        error: 'No active canvas to save.',
      });
    }

    const nextGraphHash = createWorkflowGraphHash(request.graph, { mode: 'client-save' });
    if (
      request.title === lastPersistedTitleRef.current &&
      nextGraphHash === lastPersistedGraphHashRef.current
    ) {
      setSaveState(saveInFlightRef.current ? 'saving' : 'saved');
      return savePromiseRef.current ?? Promise.resolve<CanvasSaveResult>({
        status: 'noop',
        canvasId: request.canvasId,
        revision: activeCanvasRevisionRef.current,
      });
    }

    if (savePromiseRef.current) {
      pendingSaveRef.current = request;
      setSaveState('saving');
      return savePromiseRef.current;
    }

    saveInFlightRef.current = true;
    setSaveState('saving');
    const savePromise = drainSaveQueue(request).finally(() => {
      saveInFlightRef.current = false;
      savePromiseRef.current = null;
    });
    savePromiseRef.current = savePromise;
    return savePromise;
  }, [buildSaveRequest, drainSaveQueue]);

  const flushActiveCanvasBeforeTransition = useCallback(async () => {
    const request = buildSaveRequest();

    return flushCanvasSaveBeforeTransition({
      request,
      lastPersistedTitle: lastPersistedTitleRef.current,
      lastPersistedGraphHash: lastPersistedGraphHashRef.current,
      currentSavePromise: savePromiseRef.current,
      clearAutosaveTimer,
      persistRequest: (pendingRequest) => persistCanvas(pendingRequest.title, pendingRequest.graph),
    });
  }, [buildSaveRequest, clearAutosaveTimer, persistCanvas]);

  useEffect(() => {
    if (!activeCanvasId || isLoading) return;
    const request = buildSaveRequest();
    if (!request) return;

    const hasUnsavedChanges = hasCanvasSaveChanges(
      request,
      lastPersistedTitleRef.current,
      lastPersistedGraphHashRef.current
    );

    if (!hasUnsavedChanges) {
      setSaveState(saveInFlightRef.current ? 'saving' : 'saved');
      return;
    }

    setSaveState('dirty');
    clearAutosaveTimer();
    autosaveTimer.current = setTimeout(() => {
      void persistCanvas();
    }, 900);

    return () => {
      clearAutosaveTimer();
    };
  }, [activeCanvasId, autosaveKey, buildSaveRequest, canvasTitle, clearAutosaveTimer, isLoading, persistCanvas]);

  useEffect(() => {
    return () => {
      clearAutosaveTimer();
    };
  }, [clearAutosaveTimer]);

  return {
    activeCanvasRevision,
    flushActiveCanvasBeforeTransition,
    persistCanvas,
    saveState,
    syncPersistedCanvas,
  };
}
