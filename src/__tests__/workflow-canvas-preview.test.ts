import { describe, expect, it } from 'vitest';

import { createStarterGraph, createWorkflowNode } from '@/lib/workflow-canvas';
import {
  createWorkflowCanvasLibrarySummary,
  WORKFLOW_CANVAS_PREVIEW_NODE_LIMIT,
} from '@/lib/workflow-canvas-preview';

describe('workflow canvas library previews', () => {
  it('returns layout and type metadata without node data, prompts, or media', () => {
    const graph = createStarterGraph();
    const firstImageInput = graph.nodes.find((node) => node.type === 'image-input');
    if (firstImageInput) {
      firstImageInput.data = {
        ...firstImageInput.data,
        imageUrl: 'https://private.example/media.png',
        storagePath: 'private/user/media.png',
      };
    }

    const summary = createWorkflowCanvasLibrarySummary(graph);
    const serialized = JSON.stringify(summary);

    expect(summary).toMatchObject({
      node_count: 6,
      connection_count: 5,
      output_kinds: ['video', 'image'],
      preview: { truncated: false },
    });
    expect(summary.preview.nodes[0].id).toBe('n0');
    expect(serialized).not.toContain('UGC creator in a warmly lit room');
    expect(serialized).not.toContain('private.example');
    expect(serialized).not.toContain('storagePath');
    expect(serialized).not.toContain(graph.nodes[0].id);
  });

  it('caps oversized previews while retaining total counts', () => {
    const graph = createStarterGraph();
    graph.nodes.push(...Array.from({ length: 60 }, (_, index) => ({
      ...createWorkflowNode('note', { x: index * 20, y: index * 10 }),
      id: `extra-${index}`,
    })));

    const summary = createWorkflowCanvasLibrarySummary(graph);

    expect(summary.node_count).toBe(66);
    expect(summary.preview.nodes).toHaveLength(WORKFLOW_CANVAS_PREVIEW_NODE_LIMIT);
    expect(summary.preview.truncated).toBe(true);
  });
});
