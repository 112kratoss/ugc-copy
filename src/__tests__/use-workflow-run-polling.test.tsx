import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkflowRunPolling } from '@/app/create-workflow/useWorkflowRunPolling';
import type { WorkflowCanvasRunRecord } from '@/lib/workflow-canvas';

function RunPollingHarness({
  activeCanvasId,
  activeRunId,
  authHeaders,
  onRunComplete,
  onRunUpdate,
}: {
  activeCanvasId: string | null;
  activeRunId: string | null;
  authHeaders: () => Promise<Record<string, string>>;
  onRunComplete: () => void;
  onRunUpdate: (run: WorkflowCanvasRunRecord) => void;
}) {
  useWorkflowRunPolling({
    activeCanvasId,
    activeRunId,
    authHeaders,
    onRunComplete,
    onRunUpdate,
  });

  return null;
}

describe('useWorkflowRunPolling', () => {
  async function flushAsyncWork() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
  });

  afterEach(async () => {
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('pauses interval polling while the tab is hidden and refreshes again when visible', async () => {
    let runPollCount = 0;
    const onRunUpdate = vi.fn();
    const onRunComplete = vi.fn();

    vi.stubGlobal('fetch', vi.fn(async () => {
      runPollCount += 1;
      return {
        ok: true,
        json: async () => ({
          run: {
            id: 'run-1',
            status: 'processing',
            steps: [],
          },
        }),
      } as Response;
    }));

    const view = render(
      <RunPollingHarness
        activeCanvasId="canvas-1"
        activeRunId="run-1"
        authHeaders={async () => ({ Authorization: 'Bearer test-token' })}
        onRunComplete={onRunComplete}
        onRunUpdate={onRunUpdate}
      />
    );

    await flushAsyncWork();
    expect(runPollCount).toBe(1);
    expect(onRunUpdate).toHaveBeenCalledTimes(1);
    expect(onRunComplete).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(runPollCount).toBe(1);

    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await flushAsyncWork();
    expect(runPollCount).toBe(2);
    expect(onRunUpdate).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(runPollCount).toBe(3);

    view.unmount();
  });

  it('stops polling after the run completes', async () => {
    let runPollCount = 0;
    const onRunUpdate = vi.fn();
    const onRunComplete = vi.fn();

    vi.stubGlobal('fetch', vi.fn(async () => {
      runPollCount += 1;
      return {
        ok: true,
        json: async () => ({
          run: {
            id: 'run-1',
            status: 'succeeded',
            steps: [],
          },
        }),
      } as Response;
    }));

    render(
      <RunPollingHarness
        activeCanvasId="canvas-1"
        activeRunId="run-1"
        authHeaders={async () => ({ Authorization: 'Bearer test-token' })}
        onRunComplete={onRunComplete}
        onRunUpdate={onRunUpdate}
      />
    );

    await flushAsyncWork();
    expect(runPollCount).toBe(1);
    expect(onRunComplete).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });

    expect(runPollCount).toBe(1);
  });
});
