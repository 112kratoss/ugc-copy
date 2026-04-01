import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WorkflowCanvasChrome } from '@/app/create-workflow/WorkflowCanvasChrome';

describe('WorkflowCanvasChrome', () => {
  it('shows the simplified save state and only enables save when dirty', () => {
    const onSave = vi.fn();
    const onNavigateBack = vi.fn();

    const { rerender } = render(
      <WorkflowCanvasChrome
        canvasTitle="Workflow canvas"
        canvasOverlay={<div>Overlay</div>}
        leftRail={<div>Left rail</div>}
        onCanvasTitleChange={vi.fn()}
        onNavigateBack={onNavigateBack}
        onSave={onSave}
        saveState="saved"
      >
        <div>Canvas</div>
      </WorkflowCanvasChrome>
    );

    expect(screen.getByText(/^saved$/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /history/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /command/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /back to create/i }));
    expect(onNavigateBack).toHaveBeenCalledTimes(1);

    rerender(
      <WorkflowCanvasChrome
        canvasTitle="Workflow canvas"
        canvasOverlay={<div>Overlay</div>}
        leftRail={<div>Left rail</div>}
        onCanvasTitleChange={vi.fn()}
        onNavigateBack={onNavigateBack}
        onSave={onSave}
        saveState="dirty"
      >
        <div>Canvas</div>
      </WorkflowCanvasChrome>
    );

    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
