import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkflowCanvasOverlays } from '@/app/create-workflow/WorkflowCanvasOverlays';
import ComposerMediaLightbox from '@/app/post/new/ComposerMediaLightbox';
import { createStarterGraph } from '@/lib/workflow-canvas';

// Two overlays let the keyboard out (audit 2026-11-27): the canvas's media preview was no dialog at
// all (no role, no aria-modal, Tab walked on to the canvas under it) and the selection's close
// button had no name; the composer's lightbox kept Escape and gave the focus back, but Tab left it.
// Both keep Tab among their own controls as the studio's preview does (`keepTabInside`).

afterEach(cleanup);

function overlays(props: Partial<Parameters<typeof WorkflowCanvasOverlays>[0]> = {}) {
  const graph = createStarterGraph();
  return (
    <>
      <button type="button">Canvas control</button>
      <WorkflowCanvasOverlays
        contextMenu={null}
        edges={graph.edges}
        nodes={graph.nodes}
        nodeRunStateById={{}}
        onAddNote={vi.fn()}
        onClearSelection={vi.fn()}
        onCloseContextMenu={vi.fn()}
        onClosePreview={vi.fn()}
        onDeleteSelection={vi.fn()}
        onEditNode={vi.fn()}
        onFitView={vi.fn()}
        onRunBranch={vi.fn()}
        onRunNode={vi.fn()}
        onSelectAll={vi.fn()}
        preview={null}
        selection={{ nodeIds: [], edgeIds: [] }}
        showSelectionHud={false}
        {...props}
      />
    </>
  );
}

describe('the workflow canvas overlays', () => {
  it('names the selection HUD\'s close button', () => {
    const graph = createStarterGraph();
    render(overlays({ selection: { nodeIds: [graph.nodes[0].id], edgeIds: [] }, showSelectionHud: true }));
    expect(screen.getByRole('button', { name: 'Clear selection' })).toBeInTheDocument();
  });

  it('draws the media preview as a modal dialog that keeps Tab inside it', () => {
    render(overlays({ preview: { kind: 'image', url: 'https://example.com/a.png', title: 'Output' } }));
    const dialog = screen.getByRole('dialog', { name: 'Output' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();
    // The close button is the dialog's only control: Tab and Shift+Tab stay on it.
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    screen.getByRole('button', { name: 'Canvas control' }).focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(close).toHaveFocus();
  });
});

describe('the composer\'s media lightbox', () => {
  it('keeps Tab among its own controls', () => {
    const items = [
      { id: 'a', previewUrl: 'https://example.com/a.png', mediaKind: 'image' as const, originalName: 'a.png' },
      { id: 'b', previewUrl: 'https://example.com/b.png', mediaKind: 'image' as const, originalName: 'b.png' },
    ];
    render(
      <>
        <button type="button">Composer control</button>
        <ComposerMediaLightbox items={items} activeIndex={0} onClose={vi.fn()} onNavigate={vi.fn()} />
      </>,
    );
    const dialog = screen.getByRole('dialog');
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled])'));
    expect(controls.length).toBeGreaterThan(0);
    const last = controls[controls.length - 1];
    last.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(controls[0]).toHaveFocus();

    controls[0].focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });
});
