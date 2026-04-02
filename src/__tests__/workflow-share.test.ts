import { describe, expect, it } from 'vitest';

import {
  createNodeRunState,
  createStarterGraph,
  createWorkflowShareSnapshotGraph,
  type ImageGenerateNodeData,
  type ImageInputNodeData,
  type TextInputNodeData,
} from '@/lib/workflow-canvas';

describe('createWorkflowShareSnapshotGraph', () => {
  it('removes run state and private media bindings while preserving editable workflow structure', () => {
    const graph = createStarterGraph();
    const promptNode = graph.nodes.find((node) => node.type === 'text-input');
    const imageInputNode = graph.nodes.find((node) => node.type === 'image-input');
    const imageGenerateNode = graph.nodes.find((node) => node.type === 'image-generate');

    expect(promptNode).toBeTruthy();
    expect(imageInputNode).toBeTruthy();
    expect(imageGenerateNode).toBeTruthy();

    (promptNode!.data as TextInputNodeData).runState = createNodeRunState({
      status: 'succeeded',
      generationId: 'gen-1',
      outputUrl: 'generated_images/user-1/result.jpg',
      cost: 4,
      updatedAt: '2026-04-02T10:00:00.000Z',
    });
    Object.assign(imageInputNode!.data as ImageInputNodeData, {
      imageUrl: 'https://cdn.example.com/private-image.jpg',
      storagePath: 'generated_images/user-1/private-image.jpg',
    });
    Object.assign(imageGenerateNode!.data as ImageGenerateNodeData, {
      elements: [
        {
          id: 'element-1',
          displayName: 'Bottle',
          handle: '@bottle',
          url: 'https://cdn.example.com/private-reference.jpg',
          storagePath: 'generated_images/user-1/private-reference.jpg',
          sourceGenerationId: 'gen-99',
        },
      ],
    });

    const snapshot = createWorkflowShareSnapshotGraph(graph);
    const sharedPromptNode = snapshot.nodes.find((node) => node.id === promptNode!.id);
    const sharedImageInputNode = snapshot.nodes.find((node) => node.id === imageInputNode!.id);
    const sharedImageGenerateNode = snapshot.nodes.find((node) => node.id === imageGenerateNode!.id);

    expect(sharedPromptNode?.data).not.toHaveProperty('runState');
    expect(sharedPromptNode?.data).toHaveProperty('text', (promptNode!.data as TextInputNodeData).text);
    expect(sharedImageInputNode?.data).toMatchObject({
      imageUrl: null,
      storagePath: null,
    });
    expect(sharedImageGenerateNode?.data).toMatchObject({
      elements: [
        {
          id: 'element-1',
          displayName: 'Bottle',
          handle: '@bottle',
        },
      ],
    });
    expect((sharedImageGenerateNode?.data as { elements?: Array<Record<string, unknown>> }).elements?.[0]).not.toHaveProperty('url');
    expect((sharedImageGenerateNode?.data as { elements?: Array<Record<string, unknown>> }).elements?.[0]).not.toHaveProperty('storagePath');
    expect((sharedImageGenerateNode?.data as { elements?: Array<Record<string, unknown>> }).elements?.[0]).not.toHaveProperty('sourceGenerationId');
  });
});
