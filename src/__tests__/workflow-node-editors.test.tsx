import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FloatingNodeEditor } from '@/app/create-workflow/WorkflowNodeEditors';
import { createStarterGraph } from '@/lib/workflow-canvas';

describe('WorkflowNodeEditors', () => {
  it('renders the floating node editor and forwards title edits and close actions', () => {
    const graph = createStarterGraph();
    const node = graph.nodes[0];
    const onUpdateNode = vi.fn();
    const onClose = vi.fn();

    render(
      <FloatingNodeEditor
        node={node}
        selectedKind={node.type}
        position={{ left: 24, top: 24, width: 380 }}
        onUpdateNode={onUpdateNode}
        onUploadAsset={vi.fn(async () => ({
          signedUrl: 'https://example.com/test.jpg',
          storagePath: 'generated_images/user-1/test.jpg',
        }))}
        onDeleteNode={vi.fn()}
        onOpenPreview={vi.fn()}
        onClose={onClose}
        onSetError={vi.fn()}
      />
    );

    expect(screen.getByTestId('floating-node-editor')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue(node.data.title), {
      target: { value: 'Updated prompt title' },
    });

    expect(onUpdateNode).toHaveBeenCalledWith(
      node.id,
      expect.objectContaining({ title: 'Updated prompt title' })
    );

    fireEvent.click(screen.getByRole('button', { name: /close node editor/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
