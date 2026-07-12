'use client';

import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';

import {
  createStarterGraph,
  type WorkflowCanvasGraph,
  type WorkflowCanvasListItem,
  type WorkflowCanvasRecord,
} from '@/lib/workflow-canvas';
import { createWorkflowCanvasLibrarySummary } from '@/lib/workflow-canvas-preview';

function toCanvasListItem(
  canvas: Pick<WorkflowCanvasRecord, 'id' | 'title' | 'graph' | 'updated_at' | 'revision' | 'status' | 'published_at'>
): WorkflowCanvasListItem {
  return {
    id: canvas.id,
    title: canvas.title,
    updated_at: canvas.updated_at,
    revision: canvas.revision,
    status: canvas.status,
    published_at: canvas.published_at,
    ...createWorkflowCanvasLibrarySummary(canvas.graph),
  };
}

function sortCanvasList(canvases: WorkflowCanvasListItem[]) {
  return [...canvases].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

interface UseWorkflowCanvasCanvasesOptions {
  autoCreateWhenEmpty?: boolean;
  authHeaders: () => Promise<Record<string, string>>;
  beforeCanvasTransitionRef: MutableRefObject<() => Promise<boolean>>;
  hasUnsavedChangesRef: MutableRefObject<boolean>;
  onActivateCanvas: (canvas: WorkflowCanvasRecord) => void;
  onError: (message: string | null) => void;
  initialCanvasId?: string | null;
  sessionUserId: string | null | undefined;
}

export function useWorkflowCanvasCanvases({
  autoCreateWhenEmpty = true,
  authHeaders,
  beforeCanvasTransitionRef,
  hasUnsavedChangesRef,
  onActivateCanvas,
  onError,
  initialCanvasId = null,
  sessionUserId,
}: UseWorkflowCanvasCanvasesOptions) {
  const [activeCanvasId, setActiveCanvasId] = useState<string | null>(null);
  const [activeCanvasRecord, setActiveCanvasRecord] = useState<WorkflowCanvasRecord | null>(null);
  const [canvasTitle, setCanvasTitle] = useState('Workflow canvas');
  const [canvases, setCanvases] = useState<WorkflowCanvasListItem[]>([]);
  const [isCanvasTransitionPending, setIsCanvasTransitionPending] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const activeCanvasIdRef = useRef<string | null>(null);
  const activeCanvasRecordRef = useRef<WorkflowCanvasRecord | null>(null);
  const authHeadersRef = useRef(authHeaders);
  const sessionUserIdRef = useRef(sessionUserId);
  const canvasesRef = useRef<WorkflowCanvasListItem[]>([]);
  const canvasesCountRef = useRef(0);
  const initialCanvasIdRef = useRef(initialCanvasId);
  const autoCreateWhenEmptyRef = useRef(autoCreateWhenEmpty);

  useEffect(() => {
    activeCanvasIdRef.current = activeCanvasId;
  }, [activeCanvasId]);

  useEffect(() => {
    activeCanvasRecordRef.current = activeCanvasRecord;
  }, [activeCanvasRecord]);

  useEffect(() => {
    canvasesRef.current = canvases;
    canvasesCountRef.current = canvases.length;
  }, [canvases]);

  useEffect(() => {
    authHeadersRef.current = authHeaders;
  }, [authHeaders]);

  useEffect(() => {
    sessionUserIdRef.current = sessionUserId;
  }, [sessionUserId]);

  const activateCanvas = useCallback((canvas: WorkflowCanvasRecord) => {
    setActiveCanvasId(canvas.id);
    setActiveCanvasRecord(canvas);
    setCanvasTitle(canvas.title);
    onActivateCanvas(canvas);
    onError(null);
  }, [onActivateCanvas, onError]);

  const fetchCanvasDetails = useCallback(async (canvasId: string) => {
    if (!sessionUserIdRef.current) {
      throw new Error('Please log in to load workflow canvases.');
    }

    const response = await fetch(`/api/workflow-canvases/${canvasId}`, {
      headers: await authHeadersRef.current(),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to load workflow canvas');
    }

    return data.canvas as WorkflowCanvasRecord;
  }, []);

  const syncSavedCanvasMetadata = useCallback((canvas: WorkflowCanvasRecord) => {
    startTransition(() => {
      setCanvases((current) => sortCanvasList([
        toCanvasListItem(canvas),
        ...current.filter((item) => item.id !== canvas.id),
      ]));
      if (activeCanvasIdRef.current === canvas.id) {
        setActiveCanvasRecord(canvas);
        setCanvasTitle(canvas.title);
      }
    });
  }, []);

  const replaceActiveCanvas = useCallback((canvas: WorkflowCanvasRecord) => {
    startTransition(() => {
      setCanvases((current) => sortCanvasList([
        toCanvasListItem(canvas),
        ...current.filter((item) => item.id !== canvas.id),
      ]));
      activateCanvas(canvas);
    });
  }, [activateCanvas]);

  const createCanvas = useCallback(async (options?: { title?: string; graph?: WorkflowCanvasGraph; skipFlush?: boolean }) => {
    try {
      setIsCanvasTransitionPending(true);
      try {
        if (!options?.skipFlush) {
          const canTransition = await beforeCanvasTransitionRef.current();
          if (!canTransition) {
            return null;
          }
        }

        const response = await fetch('/api/workflow-canvases', {
          method: 'POST',
          headers: await authHeaders(),
          body: JSON.stringify({
            title: options?.title ?? `Workflow ${canvasesCountRef.current + 1}`,
            graph: options?.graph ?? createStarterGraph(),
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Failed to create canvas');
        }

        const canvas = data.canvas as WorkflowCanvasRecord;
        startTransition(() => {
          setCanvases((current) => sortCanvasList([
            toCanvasListItem(canvas),
            ...current.filter((item) => item.id !== canvas.id),
          ]));
          activateCanvas(canvas);
        });

        return canvas;
      } finally {
        setIsCanvasTransitionPending(false);
      }
    } catch (createError) {
      onError(createError instanceof Error ? createError.message : 'Failed to create canvas');
      return null;
    }
  }, [activateCanvas, authHeaders, beforeCanvasTransitionRef, onError]);

  const refreshActiveCanvasRecord = useCallback(async () => {
    if (!activeCanvasIdRef.current) {
      return null;
    }

    if (hasUnsavedChangesRef.current) {
      return activeCanvasRecordRef.current;
    }

    const canvas = await fetchCanvasDetails(activeCanvasIdRef.current);
    syncSavedCanvasMetadata(canvas);
    return canvas;
  }, [fetchCanvasDetails, hasUnsavedChangesRef, syncSavedCanvasMetadata]);

  const deleteCanvas = useCallback(async (canvasId: string) => {
    try {
      setIsCanvasTransitionPending(true);
      try {
        const response = await fetch(`/api/workflow-canvases/${canvasId}`, {
          method: 'DELETE',
          headers: await authHeaders(),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Failed to delete canvas');
        }

        const remaining = canvasesRef.current.filter((canvas) => canvas.id !== canvasId);
        setCanvases((current) => current.filter((canvas) => canvas.id !== canvasId));

        if (canvasId === activeCanvasIdRef.current) {
          if (remaining[0]) {
            const nextCanvas = await fetchCanvasDetails(remaining[0].id);
            startTransition(() => {
              activateCanvas(nextCanvas);
            });
          } else {
            await createCanvas({ skipFlush: true });
          }
        }
      } finally {
        setIsCanvasTransitionPending(false);
      }
    } catch (deleteError) {
      onError(deleteError instanceof Error ? deleteError.message : 'Failed to delete canvas');
    }
  }, [activateCanvas, authHeaders, createCanvas, fetchCanvasDetails, onError]);

  const selectCanvas = useCallback(async (canvas: WorkflowCanvasListItem) => {
    if (canvas.id === activeCanvasIdRef.current) {
      return;
    }

    setIsCanvasTransitionPending(true);
    try {
      const canTransition = await beforeCanvasTransitionRef.current();
      if (!canTransition) {
        return;
      }

      const nextCanvas = await fetchCanvasDetails(canvas.id);
      startTransition(() => {
        activateCanvas(nextCanvas);
      });
    } catch (selectError) {
      onError(selectError instanceof Error ? selectError.message : 'Failed to load canvas');
    } finally {
      setIsCanvasTransitionPending(false);
    }
  }, [activateCanvas, beforeCanvasTransitionRef, fetchCanvasDetails, onError]);

  const updateCanvasTitleLocally = useCallback((title: string) => {
    setCanvasTitle(title);
    setActiveCanvasRecord((current) => (current ? { ...current, title } : current));
    startTransition(() => {
      setCanvases((current) => current.map((canvas) => (
        canvas.id === activeCanvasIdRef.current
          ? { ...canvas, title }
          : canvas
      )));
    });
  }, []);

  useEffect(() => {
    if (!sessionUserId) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
      return () => {
        cancelled = true;
      };
    }

    let cancelled = false;

    async function loadCanvases() {
      setIsLoading(true);
      try {
        const response = await fetch('/api/workflow-canvases', {
          headers: await authHeadersRef.current(),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Failed to load workflow canvases');
        }

        const nextCanvases = data.canvases as WorkflowCanvasListItem[];
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setCanvases(nextCanvases);
        });

        if (nextCanvases.length === 0 && autoCreateWhenEmptyRef.current) {
          const createResponse = await fetch('/api/workflow-canvases', {
            method: 'POST',
            headers: await authHeadersRef.current(),
            body: JSON.stringify({
              title: 'magicbooklet workflow canvas',
              graph: createStarterGraph(),
            }),
          });
          const createData = await createResponse.json();
          if (!createResponse.ok) {
            throw new Error(createData.error || 'Failed to create canvas');
          }

          const createdCanvas = createData.canvas as WorkflowCanvasRecord;
          if (!cancelled) {
            startTransition(() => {
              setCanvases([toCanvasListItem(createdCanvas)]);
              activateCanvas(createdCanvas);
            });
          }
        } else if (nextCanvases.length > 0) {
          const requestedCanvasId = initialCanvasIdRef.current;
          if (requestedCanvasId && !nextCanvases.some((canvas) => canvas.id === requestedCanvasId)) {
            onError('That workflow could not be found. Return to all workflows and choose another canvas.');
            return;
          }
          const nextCanvasId = requestedCanvasId
            ?? (activeCanvasIdRef.current && nextCanvases.some((canvas) => canvas.id === activeCanvasIdRef.current)
              ? activeCanvasIdRef.current
              : nextCanvases[0].id);
          const firstCanvas = await fetchCanvasDetails(nextCanvasId);
          if (!cancelled) {
            startTransition(() => {
              activateCanvas(firstCanvas);
            });
          }
        }
      } catch (loadError) {
        if (!cancelled) {
          onError(loadError instanceof Error ? loadError.message : 'Failed to load canvas');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    const frameId = window.requestAnimationFrame(() => {
      void loadCanvases();
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
    };
  }, [activateCanvas, fetchCanvasDetails, onError, sessionUserId]);

  return {
    activeCanvasId,
    activeCanvasRecord,
    canvasTitle,
    canvases,
    createCanvas,
    deleteCanvas,
    fetchCanvasDetails,
    isCanvasTransitionPending,
    isLoading,
    refreshActiveCanvasRecord,
    replaceActiveCanvas,
    selectCanvas,
    setCanvasTitle: updateCanvasTitleLocally,
    syncSavedCanvasMetadata,
  };
}
