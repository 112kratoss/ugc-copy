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

function toCanvasListItem(
  canvas: Pick<WorkflowCanvasRecord, 'id' | 'title' | 'updated_at' | 'revision'>
): WorkflowCanvasListItem {
  return {
    id: canvas.id,
    title: canvas.title,
    updated_at: canvas.updated_at,
    revision: canvas.revision,
  };
}

function sortCanvasList(canvases: WorkflowCanvasListItem[]) {
  return [...canvases].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

interface UseWorkflowCanvasCanvasesOptions {
  authHeaders: () => Promise<Record<string, string>>;
  beforeCanvasTransitionRef: MutableRefObject<() => Promise<boolean>>;
  onActivateCanvas: (canvas: WorkflowCanvasRecord) => void;
  onError: (message: string | null) => void;
  sessionToken: string | null | undefined;
}

export function useWorkflowCanvasCanvases({
  authHeaders,
  beforeCanvasTransitionRef,
  onActivateCanvas,
  onError,
  sessionToken,
}: UseWorkflowCanvasCanvasesOptions) {
  const [activeCanvasId, setActiveCanvasId] = useState<string | null>(null);
  const [canvasTitle, setCanvasTitle] = useState('Workflow canvas');
  const [canvases, setCanvases] = useState<WorkflowCanvasListItem[]>([]);
  const [isCanvasTransitionPending, setIsCanvasTransitionPending] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const activeCanvasIdRef = useRef<string | null>(null);
  const canvasesCountRef = useRef(0);

  useEffect(() => {
    activeCanvasIdRef.current = activeCanvasId;
  }, [activeCanvasId]);

  useEffect(() => {
    canvasesCountRef.current = canvases.length;
  }, [canvases.length]);

  const activateCanvas = useCallback((canvas: WorkflowCanvasRecord) => {
    setActiveCanvasId(canvas.id);
    setCanvasTitle(canvas.title);
    onActivateCanvas(canvas);
    onError(null);
  }, [onActivateCanvas, onError]);

  const fetchCanvasDetails = useCallback(async (canvasId: string) => {
    if (!sessionToken) {
      throw new Error('Please log in to load workflow canvases.');
    }

    const response = await fetch(`/api/workflow-canvases/${canvasId}`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to load workflow canvas');
    }

    return data.canvas as WorkflowCanvasRecord;
  }, [sessionToken]);

  const syncSavedCanvasMetadata = useCallback((canvas: WorkflowCanvasRecord) => {
    startTransition(() => {
      setCanvases((current) => sortCanvasList([
        toCanvasListItem(canvas),
        ...current.filter((item) => item.id !== canvas.id),
      ]));
      if (activeCanvasIdRef.current === canvas.id) {
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

    const canvas = await fetchCanvasDetails(activeCanvasIdRef.current);
    syncSavedCanvasMetadata(canvas);
    return canvas;
  }, [fetchCanvasDetails, syncSavedCanvasMetadata]);

  const deleteCanvas = useCallback(async (canvasId: string) => {
    try {
      setIsCanvasTransitionPending(true);
      try {
        if (canvasId === activeCanvasIdRef.current) {
          const canTransition = await beforeCanvasTransitionRef.current();
          if (!canTransition) {
            return;
          }
        }

        const response = await fetch(`/api/workflow-canvases/${canvasId}`, {
          method: 'DELETE',
          headers: await authHeaders(),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Failed to delete canvas');
        }

        const remaining = canvases.filter((canvas) => canvas.id !== canvasId);
        startTransition(() => {
          setCanvases(remaining);
        });

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
  }, [activateCanvas, authHeaders, beforeCanvasTransitionRef, canvases, createCanvas, fetchCanvasDetails, onError]);

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
    startTransition(() => {
      setCanvases((current) => current.map((canvas) => (
        canvas.id === activeCanvasIdRef.current
          ? { ...canvas, title }
          : canvas
      )));
    });
  }, []);

  useEffect(() => {
    if (!sessionToken) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    async function loadCanvases() {
      try {
        const response = await fetch('/api/workflow-canvases', {
          headers: { Authorization: `Bearer ${sessionToken}` },
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

        if (nextCanvases.length === 0) {
          await createCanvas({
            title: 'UGC workflow canvas',
            graph: createStarterGraph(),
            skipFlush: true,
          });
        } else {
          const firstCanvas = await fetchCanvasDetails(nextCanvases[0].id);
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

    void loadCanvases();

    return () => {
      cancelled = true;
    };
  }, [activateCanvas, createCanvas, fetchCanvasDetails, onError, sessionToken]);

  return {
    activeCanvasId,
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
