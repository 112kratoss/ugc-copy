'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { WorkflowCanvasRunRecord } from '@/lib/workflow-canvas';

interface UseWorkflowRunPollingOptions {
  activeCanvasId: string | null;
  activeRunId: string | null;
  authHeaders: () => Promise<Record<string, string>>;
  onRunUpdate: (run: WorkflowCanvasRunRecord) => void;
  onRunComplete: () => void;
}

export function useWorkflowRunPolling({
  activeCanvasId,
  activeRunId,
  authHeaders,
  onRunUpdate,
  onRunComplete,
}: UseWorkflowRunPollingOptions) {
  const requestInFlightRef = useRef(false);
  const intervalRef = useRef<number | null>(null);

  const clearPollingInterval = useCallback(() => {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const refreshRun = useCallback(async () => {
    if (!activeCanvasId || !activeRunId || requestInFlightRef.current) {
      return;
    }

    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return;
    }

    requestInFlightRef.current = true;

    try {
      const response = await fetch(`/api/workflow-canvases/${activeCanvasId}/runs/${activeRunId}`, {
        headers: await authHeaders(),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to refresh workflow run');
      }

      const run = data.run as WorkflowCanvasRunRecord;
      onRunUpdate(run);
      if (run.status !== 'processing') {
        clearPollingInterval();
        onRunComplete();
      }
    } catch (pollError) {
      console.error(pollError);
    } finally {
      requestInFlightRef.current = false;
    }
  }, [activeCanvasId, activeRunId, authHeaders, clearPollingInterval, onRunComplete, onRunUpdate]);

  useEffect(() => {
    if (!activeCanvasId || !activeRunId) {
      clearPollingInterval();
      return;
    }

    const startPolling = () => {
      clearPollingInterval();
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }

      intervalRef.current = window.setInterval(() => {
        void refreshRun();
      }, 4000);
    };

    void refreshRun();
    startPolling();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        clearPollingInterval();
        return;
      }

      if (document.visibilityState === 'visible') {
        void refreshRun();
        startPolling();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearPollingInterval();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      requestInFlightRef.current = false;
    };
  }, [activeCanvasId, activeRunId, clearPollingInterval, refreshRun]);
}
