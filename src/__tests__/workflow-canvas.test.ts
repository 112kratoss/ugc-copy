import { describe, expect, it } from 'vitest';
import {
  createStarterGraph,
  createWorkflowNode,
  duplicateWorkflowSelection,
  getExecutionOrder,
  normalizeNodeData,
  normalizeWorkflowGraph,
  resolveNodeInputs,
  validateWorkflowConnection,
} from '@/lib/workflow-canvas';

describe('workflow canvas helpers', () => {
  it('validates supported handle pairings', () => {
    expect(validateWorkflowConnection('text', 'prompt')).toBe(true);
    expect(validateWorkflowConnection('image', 'reference-image')).toBe(true);
    expect(validateWorkflowConnection('video', 'reference-video')).toBe(true);
    expect(validateWorkflowConnection('audio', 'reference-audio')).toBe(false);
    expect(validateWorkflowConnection('video', 'prompt')).toBe(false);
  });

  it('resolves prompt and media inputs from incoming edges', () => {
    const graph = createStarterGraph();
    const videoNode = graph.nodes.find((node) => node.type === 'video-generate');
    expect(videoNode).toBeDefined();
    const resolved = resolveNodeInputs(graph, videoNode!.id);
    expect(resolved.prompt).toContain('UGC creator');
    expect(resolved.imageUrls).toEqual([]);
  });

  it('derives downstream execution order', () => {
    const graph = createStarterGraph();
    const promptNode = graph.nodes.find((node) => node.type === 'text-input');
    const order = getExecutionOrder(graph, promptNode!.id, 'branch');
    expect(order.length).toBeGreaterThan(1);
  });

  it('keeps join nodes after every reachable upstream branch', () => {
    const start = createWorkflowNode('text-input', { x: 0, y: 0 });
    const left = createWorkflowNode('image-generate', { x: 0, y: 120 });
    const right = createWorkflowNode('video-generate', { x: 0, y: 240 });
    const join = createWorkflowNode('motion-generate', { x: 260, y: 180 });

    const graph = normalizeWorkflowGraph({
      nodes: [start, left, right, join],
      edges: [
        { id: 's-l', source: start.id, target: left.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 's-r', source: start.id, target: right.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'l-j', source: left.id, target: join.id, sourceHandle: 'image', targetHandle: 'reference-image' },
        { id: 'r-j', source: right.id, target: join.id, sourceHandle: 'video', targetHandle: 'reference-video' },
      ],
    });

    const order = getExecutionOrder(graph, start.id, 'branch');
    expect(order.indexOf(join.id)).toBeGreaterThan(order.indexOf(left.id));
    expect(order.indexOf(join.id)).toBeGreaterThan(order.indexOf(right.id));
  });

  it('normalizes malformed graph payloads', () => {
    const orphanNode = createWorkflowNode('note', { x: 10, y: 20 });
    const graph = normalizeWorkflowGraph({
      nodes: [{ ...orphanNode, type: 'note', position: { x: 12, y: 24 } }],
      edges: [{ id: 'bad', source: 'a', target: '' }],
    });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
  });

  it('resolves audio inputs from incoming edges', () => {
    const promptNode = createWorkflowNode('text-input', { x: 0, y: 0 });
    const audioNode = createWorkflowNode('audio-input', { x: 0, y: 120 });
    const videoNode = createWorkflowNode('video-generate', { x: 260, y: 0 });

    const graph = normalizeWorkflowGraph({
      nodes: [
        promptNode,
        { ...audioNode, data: { ...audioNode.data, audioUrl: 'https://example.com/track.mp3' } },
        videoNode,
      ],
      edges: [
        { id: 'p', source: promptNode.id, target: videoNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'a', source: audioNode.id, target: videoNode.id, sourceHandle: 'audio', targetHandle: 'reference-audio' },
      ],
    });

    const resolved = resolveNodeInputs(graph, videoNode.id);
    expect(resolved.audioUrls).toEqual(['https://example.com/track.mp3']);
  });

  it('migrates legacy audio models to current workflow defaults', () => {
    const voiceover = normalizeNodeData('voiceover-generate', {
      model: 'voiceover-v1',
      voice: 'Narrator',
      language: 'en',
    } as never);
    const soundFx = normalizeNodeData('sound-effects-generate', {
      model: 'sfx-v1',
      duration: 7,
      loop: true,
    } as never);

    expect(voiceover.model).toBe('text-to-speech-turbo-2-5');
    expect((voiceover as typeof voiceover & { languageCode: string }).languageCode).toBe('en');
    expect(soundFx.model).toBe('sound-effect-v2');
  });

  it('preserves dialogue turns on voiceover nodes', () => {
    const node = normalizeNodeData('voiceover-generate', {
      model: 'text-to-dialogue-v3',
      dialogueTurns: [
        { id: '1', voice: 'Rachel', text: 'First line' },
        { id: '2', voice: 'Adam', text: 'Second line' },
      ],
    } as never);

    expect(node.model).toBe('text-to-dialogue-v3');
    expect((node as typeof node & { dialogueTurns: Array<{ text: string }> }).dialogueTurns).toHaveLength(2);
    expect((node as typeof node & { dialogueTurns: Array<{ text: string }> }).dialogueTurns[1].text).toBe('Second line');
  });

  it('duplicates a selected subgraph with fresh ids and offset positions', () => {
    const start = createWorkflowNode('text-input', { x: 100, y: 120 });
    const image = createWorkflowNode('image-generate', { x: 340, y: 120 });
    const graph = normalizeWorkflowGraph({
      nodes: [start, image],
      edges: [
        { id: 'start-image', source: start.id, target: image.id, sourceHandle: 'text', targetHandle: 'prompt' },
      ],
    });

    const result = duplicateWorkflowSelection(graph, [start.id, image.id], { x: 48, y: 64 });

    expect(result.duplicatedNodes).toHaveLength(2);
    expect(result.duplicatedEdges).toHaveLength(1);
    expect(result.nodeIdMap[start.id]).not.toBe(start.id);
    expect(result.nodeIdMap[image.id]).not.toBe(image.id);
    expect(result.duplicatedNodes[0].position).toEqual({
      x: graph.nodes[0].position.x + 48,
      y: graph.nodes[0].position.y + 64,
    });
    expect(result.duplicatedEdges[0].source).toBe(result.nodeIdMap[start.id]);
    expect(result.duplicatedEdges[0].target).toBe(result.nodeIdMap[image.id]);
  });

  it('duplicates only edges fully contained in the selected node set', () => {
    const start = createWorkflowNode('text-input', { x: 0, y: 0 });
    const image = createWorkflowNode('image-generate', { x: 240, y: 0 });
    const video = createWorkflowNode('video-generate', { x: 480, y: 0 });

    const graph = normalizeWorkflowGraph({
      nodes: [start, image, video],
      edges: [
        { id: 'start-image', source: start.id, target: image.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'image-video', source: image.id, target: video.id, sourceHandle: 'image', targetHandle: 'reference-image' },
      ],
    });

    const result = duplicateWorkflowSelection(graph, [start.id, image.id]);

    expect(result.duplicatedNodes).toHaveLength(2);
    expect(result.duplicatedEdges).toHaveLength(1);
    expect(result.duplicatedEdges[0].source).toBe(result.nodeIdMap[start.id]);
    expect(result.duplicatedEdges[0].target).toBe(result.nodeIdMap[image.id]);
  });

  it('resets transient run state while preserving uploaded asset references on duplicates', () => {
    const imageInput = createWorkflowNode('image-input', { x: 0, y: 0 });
    const imageOutput = createWorkflowNode('image-generate', { x: 240, y: 0 });

    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...imageInput,
          data: {
            ...imageInput.data,
            imageUrl: 'https://example.com/reference.jpg',
            storagePath: 'generated_images/user/reference.jpg',
            runState: {
              ...imageInput.data.runState,
              status: 'succeeded',
              outputUrl: 'https://example.com/preview.jpg',
            },
          },
        },
        {
          ...imageOutput,
          data: {
            ...imageOutput.data,
            runState: {
              ...imageOutput.data.runState,
              status: 'succeeded',
              generationId: 'gen-123',
              outputUrl: 'https://example.com/output.jpg',
              error: 'Old error',
              cost: 42,
              updatedAt: '2026-03-22T12:00:00.000Z',
            },
          },
        },
      ],
      edges: [],
    });

    const result = duplicateWorkflowSelection(graph, [imageInput.id, imageOutput.id]);
    const duplicatedInput = result.duplicatedNodes.find((node) => node.type === 'image-input');
    const duplicatedOutput = result.duplicatedNodes.find((node) => node.type === 'image-generate');

    expect(duplicatedInput?.data).toMatchObject({
      imageUrl: 'https://example.com/reference.jpg',
      storagePath: 'generated_images/user/reference.jpg',
      runState: {
        status: 'idle',
        outputUrl: null,
      },
    });
    expect(duplicatedOutput?.data.runState).toEqual({
      status: 'idle',
      generationId: null,
      outputUrl: null,
      error: null,
      cost: null,
      updatedAt: null,
    });
  });
});
