import { describe, expect, it } from 'vitest';
import {
  createNodeRunState,
  createStarterGraph,
  createWorkflowGraphHash,
  createWorkflowNode,
  duplicateWorkflowSelection,
  getExecutionOrder,
  getPromptEnhancementTargets,
  inspectWorkflowNodeCapabilities,
  inspectWorkflowNodeDependencies,
  mergeWorkflowCanvasGraph,
  normalizeNodeData,
  normalizeWorkflowGraph,
  resolveNodeInputs,
  serializeWorkflowGraph,
  validateWorkflowConnectionForGraph,
  validateWorkflowConnection,
} from '@/lib/workflow-canvas';

function createImageReferenceGraph(count: number, model: 'nano-banana-2' | 'nano-banana-pro' = 'nano-banana-2') {
  const imageNode = createWorkflowNode('image-generate', { x: 240, y: 0 });
  const imageInputs = Array.from({ length: count }, (_, index) => createWorkflowNode('image-input', { x: 0, y: index * 80 }));

  return normalizeWorkflowGraph({
    nodes: [
      {
        ...imageNode,
        data: normalizeNodeData('image-generate', {
          ...imageNode.data,
          model,
        }),
      },
      ...imageInputs,
    ],
    edges: imageInputs.map((inputNode, index) => ({
      id: `image-ref-${index}`,
      source: inputNode.id,
      target: imageNode.id,
      sourceHandle: 'image',
      targetHandle: 'reference-image',
    })),
  });
}

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
    expect(resolved.startFrameUrl).toBeNull();
  });

  it('treats legacy video reference-image edges as start-frame inputs', () => {
    const promptNode = createWorkflowNode('text-input', { x: 0, y: 0 });
    const imageNode = createWorkflowNode('image-input', { x: 0, y: 140 });
    const videoNode = createWorkflowNode('video-generate', { x: 260, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        promptNode,
        {
          ...imageNode,
          data: {
            ...imageNode.data,
            imageUrl: 'https://example.com/start-frame.jpg',
          },
        },
        videoNode,
      ],
      edges: [
        { id: 'prompt-video', source: promptNode.id, target: videoNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'legacy-frame', source: imageNode.id, target: videoNode.id, sourceHandle: 'image', targetHandle: 'reference-image' },
      ],
    });

    const resolved = resolveNodeInputs(graph, videoNode.id);
    const capabilityValidation = inspectWorkflowNodeCapabilities(graph, videoNode);

    expect(resolved.startFrameUrl).toBe('https://example.com/start-frame.jpg');
    expect(resolved.imageUrls).toEqual([]);
    expect(capabilityValidation.startFrameCount).toBe(1);
  });

  it('derives downstream execution order', () => {
    const graph = createStarterGraph();
    const promptNode = graph.nodes.find((node) => node.type === 'text-input');
    const order = getExecutionOrder(graph, promptNode!.id, 'branch');
    expect(order.length).toBeGreaterThan(1);
  });

  it('resolves supported prompt enhancement targets from downstream media branches', () => {
    const promptNode = createWorkflowNode('text-input', { x: 0, y: 0 });
    const imageNode = createWorkflowNode('image-generate', { x: 240, y: 0 });
    const videoNode = createWorkflowNode('video-generate', { x: 240, y: 180 });

    const graph = normalizeWorkflowGraph({
      nodes: [promptNode, imageNode, videoNode],
      edges: [
        { id: 'prompt-image', source: promptNode.id, target: imageNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'prompt-video', source: promptNode.id, target: videoNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
      ],
    });

    expect(getPromptEnhancementTargets(graph, promptNode.id)).toEqual([
      {
        nodeId: imageNode.id,
        nodeType: 'image-generate',
        medium: 'image',
        depth: 1,
      },
      {
        nodeId: videoNode.id,
        nodeType: 'video-generate',
        medium: 'video',
        depth: 1,
      },
    ]);
  });

  it('returns no prompt enhancement targets for audio-only downstream branches', () => {
    const promptNode = createWorkflowNode('text-input', { x: 0, y: 0 });
    const voiceoverNode = createWorkflowNode('voiceover-generate', { x: 240, y: 0 });
    const musicNode = createWorkflowNode('music-generate', { x: 240, y: 180 });

    const graph = normalizeWorkflowGraph({
      nodes: [promptNode, voiceoverNode, musicNode],
      edges: [
        { id: 'prompt-voice', source: promptNode.id, target: voiceoverNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'prompt-music', source: promptNode.id, target: musicNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
      ],
    });

    expect(getPromptEnhancementTargets(graph, promptNode.id)).toEqual([]);
  });

  it('skips multi-shot video nodes when resolving prompt enhancement targets', () => {
    const promptNode = createWorkflowNode('text-input', { x: 0, y: 0 });
    const videoNode = createWorkflowNode('video-generate', { x: 240, y: 0 });

    const graph = normalizeWorkflowGraph({
      nodes: [
        promptNode,
        {
          ...videoNode,
          data: normalizeNodeData('video-generate', {
            ...videoNode.data,
            isMultiShot: true,
          }),
        },
      ],
      edges: [
        { id: 'prompt-video', source: promptNode.id, target: videoNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
      ],
    });

    expect(getPromptEnhancementTargets(graph, promptNode.id)).toEqual([]);
  });

  it('ignores supported media nodes that are not reachable from the selected prompt node', () => {
    const promptNode = createWorkflowNode('text-input', { x: 0, y: 0 });
    const imageNode = createWorkflowNode('image-generate', { x: 240, y: 0 });
    const disconnectedVideoNode = createWorkflowNode('video-generate', { x: 240, y: 180 });

    const graph = normalizeWorkflowGraph({
      nodes: [promptNode, imageNode, disconnectedVideoNode],
      edges: [
        { id: 'prompt-image', source: promptNode.id, target: imageNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
      ],
    });

    expect(getPromptEnhancementTargets(graph, promptNode.id)).toEqual([
      {
        nodeId: imageNode.id,
        nodeType: 'image-generate',
        medium: 'image',
        depth: 1,
      },
    ]);
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

  it('serializes client-save graphs without run state or view-only decoration', () => {
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...createWorkflowNode('text-input', { x: 10, y: 20 }),
          selected: true,
          width: 320,
          data: {
            ...createWorkflowNode('text-input', { x: 10, y: 20 }).data,
            runState: createNodeRunState({ status: 'succeeded', outputUrl: 'https://example.com/output.jpg' }),
          },
        },
      ],
      edges: [
        {
          id: 'edge-1',
          source: 'a',
          target: 'b',
          sourceHandle: 'text',
          targetHandle: 'prompt',
          selected: true,
          animated: true,
          interactionWidth: 42,
          style: { stroke: '#fff' },
        },
      ],
    });

    const serialized = serializeWorkflowGraph(graph, { mode: 'client-save' });

    expect(serialized.nodes[0].data).not.toHaveProperty('runState');
    expect(serialized.nodes[0]).not.toHaveProperty('selected');
    expect(serialized.nodes[0]).not.toHaveProperty('width');
    expect(serialized.edges[0]).toEqual({
      id: 'edge-1',
      source: 'a',
      target: 'b',
      sourceHandle: 'text',
      targetHandle: 'prompt',
    });
  });

  it('ignores selection-only changes in the client-save graph hash', () => {
    const baseGraph = createStarterGraph();
    const selectedGraph = normalizeWorkflowGraph({
      ...baseGraph,
      nodes: baseGraph.nodes.map((node, index) => ({ ...node, selected: index === 0 })),
      edges: baseGraph.edges.map((edge, index) => ({
        ...edge,
        selected: index === 0,
        animated: true,
        interactionWidth: 48,
        style: { stroke: '#22c55e' },
      })),
    });

    expect(createWorkflowGraphHash(baseGraph, { mode: 'client-save' })).toBe(
      createWorkflowGraphHash(selectedGraph, { mode: 'client-save' })
    );
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

  it('normalizes image-generator settings against the selected model', () => {
    const image = normalizeNodeData('image-generate', {
      model: 'nano-banana-pro',
      aspectRatio: '1:4',
      resolution: '8K',
      outputFormat: 'webp',
      googleSearch: true,
    } as never);

    expect(image.model).toBe('nano-banana-pro');
    expect(image.aspectRatio).toBe('9:16');
    expect(image.resolution).toBe('1K');
    expect(image.outputFormat).toBe('jpg');
    expect(image.googleSearch).toBe(false);
  });

  it('enforces Nano Banana 2 image-reference limits and blocks extra connections', () => {
    const graph = createImageReferenceGraph(14, 'nano-banana-2');
    const imageNode = graph.nodes.find((node) => node.type === 'image-generate');
    const extraInput = createWorkflowNode('image-input', { x: 0, y: 1280 });
    const graphWithExtraInput = normalizeWorkflowGraph({
      nodes: [...graph.nodes, extraInput],
      edges: graph.edges,
    });

    expect(imageNode).toBeDefined();
    expect(inspectWorkflowNodeCapabilities(graph, imageNode!)).toMatchObject({
      isValid: true,
      referenceImageCount: 14,
      referenceImageLimit: 14,
    });

    const validation = validateWorkflowConnectionForGraph({
      graph: graphWithExtraInput,
      sourceNodeId: extraInput.id,
      sourceHandle: 'image',
      targetNodeId: imageNode!.id,
      targetHandle: 'reference-image',
    });

    expect(validation.valid).toBe(false);
    expect(validation.message).toMatch(/up to 14 total named elements and reference images/i);
  });

  it('creates default graph-sourced element bindings and resolves connected element inputs', () => {
    const imageSource = createWorkflowNode('image-input', { x: 0, y: 0 });
    const imageNode = createWorkflowNode('image-generate', { x: 240, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...imageSource,
          data: {
            ...imageSource.data,
            title: 'Hero Product',
            imageUrl: 'https://example.com/hero.png',
          },
        },
        imageNode,
      ],
      edges: [
        {
          id: 'element-edge',
          source: imageSource.id,
          target: imageNode.id,
          sourceHandle: 'image',
          targetHandle: 'element-image',
        },
      ],
    });

    const normalizedImageNode = graph.nodes.find((node) => node.id === imageNode.id);
    const resolved = resolveNodeInputs(graph, imageNode.id);

    expect((normalizedImageNode?.data as { elementBindings?: Array<{ edgeId: string; handle: string }> }).elementBindings).toEqual([
      { edgeId: 'element-edge', handle: '@hero_product' },
    ]);
    expect(resolved.elementImages).toEqual([
      expect.objectContaining({
        edgeId: 'element-edge',
        sourceNodeId: imageSource.id,
        sourceTitle: 'Hero Product',
        url: 'https://example.com/hero.png',
      }),
    ]);
  });

  it('preserves image-reference edges after a model switch but blocks runs when the new limit is exceeded', () => {
    const graph = createImageReferenceGraph(9, 'nano-banana-pro');
    const imageNode = graph.nodes.find((node) => node.type === 'image-generate');

    expect(imageNode).toBeDefined();

    const capabilityValidation = inspectWorkflowNodeCapabilities(graph, imageNode!);
    expect(capabilityValidation.isValid).toBe(false);
    expect(capabilityValidation.referenceImageCount).toBe(9);
    expect(capabilityValidation.referenceImageLimit).toBe(8);
    expect(capabilityValidation.issues[0]?.message).toMatch(/up to 8 total reference images/i);

    const dependencyState = inspectWorkflowNodeDependencies(graph, imageNode!);
    expect(dependencyState.kind).toBe('blocked');
    expect(dependencyState.message).toMatch(/remove extra named elements or image connections/i);
  });

  it('validates prompt handles against connected named-element bindings', () => {
    const promptNode = createWorkflowNode('text-input', { x: 0, y: 0 });
    const sourceImage = createWorkflowNode('image-input', { x: 0, y: 120 });
    const imageNode = createWorkflowNode('image-generate', { x: 240, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...promptNode,
          data: {
            ...promptNode.data,
            text: 'Use @hero in the scene.',
          },
        },
        {
          ...sourceImage,
          data: {
            ...sourceImage.data,
            title: 'Hero',
            imageUrl: 'https://example.com/hero.png',
          },
        },
        imageNode,
      ],
      edges: [
        { id: 'prompt-image', source: promptNode.id, target: imageNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'element-edge', source: sourceImage.id, target: imageNode.id, sourceHandle: 'image', targetHandle: 'element-image' },
      ],
    });

    const capabilityValidation = inspectWorkflowNodeCapabilities(graph, graph.nodes.find((node) => node.id === imageNode.id)!);
    expect(capabilityValidation.isValid).toBe(true);
    expect(capabilityValidation.namedElementCount).toBe(1);
  });

  it('rejects a second reference image on workflow video nodes', () => {
    const videoNode = createWorkflowNode('video-generate', { x: 240, y: 0 });
    const firstImage = createWorkflowNode('image-input', { x: 0, y: 0 });
    const secondImage = createWorkflowNode('image-input', { x: 0, y: 120 });
    const graph = normalizeWorkflowGraph({
      nodes: [videoNode, firstImage, secondImage],
      edges: [
        {
          id: 'video-ref-1',
          source: firstImage.id,
          target: videoNode.id,
          sourceHandle: 'image',
          targetHandle: 'reference-image',
        },
      ],
    });

    const validation = validateWorkflowConnectionForGraph({
      graph,
      sourceNodeId: secondImage.id,
      sourceHandle: 'image',
      targetNodeId: videoNode.id,
      targetHandle: 'reference-image',
    });

    expect(validation.valid).toBe(false);
    expect(validation.message).toMatch(/only 1 start frame/i);
  });

  it('rejects connected named elements on workflow video nodes until named-elements mode is active', () => {
    const videoNode = createWorkflowNode('video-generate', { x: 240, y: 0 });
    const sourceImage = createWorkflowNode('image-input', { x: 0, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [videoNode, sourceImage],
      edges: [],
    });

    const validation = validateWorkflowConnectionForGraph({
      graph,
      sourceNodeId: sourceImage.id,
      sourceHandle: 'image',
      targetNodeId: videoNode.id,
      targetHandle: 'element-image',
    });

    expect(validation.valid).toBe(false);
    expect(validation.message).toMatch(/switch this video node to named elements mode/i);
  });

  it('blocks image runs when a connected named-element source has no output yet', () => {
    const promptNode = createWorkflowNode('text-input', { x: 0, y: 0 });
    const upstreamImage = createWorkflowNode('image-generate', { x: 0, y: 160 });
    const targetImage = createWorkflowNode('image-generate', { x: 260, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...promptNode,
          data: {
            ...promptNode.data,
            text: 'Use @hero in the scene.',
          },
        },
        {
          ...upstreamImage,
          data: {
            ...upstreamImage.data,
            title: 'Hero',
          },
        },
        targetImage,
      ],
      edges: [
        { id: 'prompt-target', source: promptNode.id, target: targetImage.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'element-edge', source: upstreamImage.id, target: targetImage.id, sourceHandle: 'image', targetHandle: 'element-image' },
      ],
    });

    const dependencyState = inspectWorkflowNodeDependencies(graph, graph.nodes.find((node) => node.id === targetImage.id)!);
    expect(dependencyState.kind).toBe('blocked');
    expect(dependencyState.message).toMatch(/does not have an image output yet/i);
  });

  it('rejects extra reference image and video connections on motion nodes', () => {
    const motionNode = createWorkflowNode('motion-generate', { x: 240, y: 0 });
    const firstImage = createWorkflowNode('image-input', { x: 0, y: 0 });
    const secondImage = createWorkflowNode('image-input', { x: 0, y: 120 });
    const firstVideo = createWorkflowNode('video-input', { x: 0, y: 240 });
    const secondVideo = createWorkflowNode('video-input', { x: 0, y: 360 });
    const graph = normalizeWorkflowGraph({
      nodes: [motionNode, firstImage, secondImage, firstVideo, secondVideo],
      edges: [
        {
          id: 'motion-image-1',
          source: firstImage.id,
          target: motionNode.id,
          sourceHandle: 'image',
          targetHandle: 'reference-image',
        },
        {
          id: 'motion-video-1',
          source: firstVideo.id,
          target: motionNode.id,
          sourceHandle: 'video',
          targetHandle: 'reference-video',
        },
      ],
    });

    const imageValidation = validateWorkflowConnectionForGraph({
      graph,
      sourceNodeId: secondImage.id,
      sourceHandle: 'image',
      targetNodeId: motionNode.id,
      targetHandle: 'reference-image',
    });
    const videoValidation = validateWorkflowConnectionForGraph({
      graph,
      sourceNodeId: secondVideo.id,
      sourceHandle: 'video',
      targetNodeId: motionNode.id,
      targetHandle: 'reference-video',
    });

    expect(imageValidation.valid).toBe(false);
    expect(imageValidation.message).toMatch(/exactly 1 reference image/i);
    expect(videoValidation.valid).toBe(false);
    expect(videoValidation.message).toMatch(/exactly 1 reference video/i);
  });

  it('blocks motion runs when a connected reference video exceeds the model duration limit', () => {
    const motionNode = createWorkflowNode('motion-generate', { x: 240, y: 0 });
    const imageNode = createWorkflowNode('image-input', { x: 0, y: 0 });
    const longVideoNode = createWorkflowNode('video-input', { x: 0, y: 160 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        motionNode,
        imageNode,
        {
          ...longVideoNode,
          data: normalizeNodeData('video-input', {
            ...longVideoNode.data,
            durationSeconds: 31,
          }),
        },
      ],
      edges: [
        {
          id: 'motion-image-1',
          source: imageNode.id,
          target: motionNode.id,
          sourceHandle: 'image',
          targetHandle: 'reference-image',
        },
        {
          id: 'motion-video-1',
          source: longVideoNode.id,
          target: motionNode.id,
          sourceHandle: 'video',
          targetHandle: 'reference-video',
        },
      ],
    });
    const resolvedMotionNode = graph.nodes.find((node) => node.id === motionNode.id);

    expect(resolvedMotionNode).toBeDefined();

    const capabilityValidation = inspectWorkflowNodeCapabilities(graph, resolvedMotionNode!);
    expect(capabilityValidation.isValid).toBe(false);
    expect(capabilityValidation.referenceVideoDurationLimitSeconds).toBe(30);
    expect(capabilityValidation.issues[0]?.code).toBe('reference-video-too-long');

    const dependencyState = inspectWorkflowNodeDependencies(graph, resolvedMotionNode!);
    expect(dependencyState.kind).toBe('blocked');
    expect(dependencyState.message).toMatch(/30s motion-control limit/i);
  });

  it('normalizes video-generator settings per model constraints', () => {
    const seedance = normalizeNodeData('video-generate', {
      model: 'seedance-1.5-pro',
      aspectRatio: '1:4',
      duration: 5,
      mode: 'std',
      sound: true,
      resolution: '4K',
      fixedLens: true,
    } as never);
    const kling = normalizeNodeData('video-generate', {
      model: 'kling-3.0-video',
      duration: 20,
      resolution: '1080p',
      fixedLens: true,
    } as never);
    const veo = normalizeNodeData('video-generate', {
      model: 'veo-3.1',
      duration: 12,
      sound: true,
      resolution: '1080p',
      fixedLens: true,
      mode: 'pro',
    } as never);

    expect(seedance.aspectRatio).toBe('9:16');
    expect(seedance.duration).toBe(4);
    expect(seedance.mode).toBe('');
    expect(seedance.resolution).toBe('480p');
    expect(seedance.sound).toBe(true);
    expect(seedance.fixedLens).toBe(true);

    expect(kling.duration).toBe(15);
    expect(kling.resolution).toBe('');
    expect(kling.fixedLens).toBe(false);

    expect(veo.duration).toBe(8);
    expect(veo.mode).toBe('veo3_fast');
    expect(veo.sound).toBe(false);
    expect(veo.resolution).toBe('');
    expect(veo.fixedLens).toBe(false);
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

  it('remaps graph-sourced element bindings when duplicating a selected subgraph', () => {
    const sourceImage = createWorkflowNode('image-input', { x: 0, y: 0 });
    const imageNode = createWorkflowNode('image-generate', { x: 240, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...sourceImage,
          data: {
            ...sourceImage.data,
            title: 'Hero Product',
            imageUrl: 'https://example.com/hero.png',
          },
        },
        imageNode,
      ],
      edges: [
        {
          id: 'element-edge',
          source: sourceImage.id,
          target: imageNode.id,
          sourceHandle: 'image',
          targetHandle: 'element-image',
        },
      ],
    });

    const result = duplicateWorkflowSelection(graph, [sourceImage.id, imageNode.id]);
    const duplicatedImageNode = result.duplicatedNodes.find((node) => node.type === 'image-generate');

    expect(duplicatedImageNode?.data).toMatchObject({
      elementBindings: [
        {
          edgeId: result.duplicatedEdges[0]?.id,
          handle: '@hero_product',
        },
      ],
    });
    expect(duplicatedImageNode?.data).not.toMatchObject({
      elementBindings: [
        {
          edgeId: 'element-edge',
        },
      ],
    });
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

  it('merges stored run state into incoming graph saves', () => {
    const existingStart = createWorkflowNode('text-input', { x: 0, y: 0 });
    const existingOutput = createWorkflowNode('image-generate', { x: 240, y: 0 });
    const existingGraph = normalizeWorkflowGraph({
      nodes: [
        existingStart,
        {
          ...existingOutput,
          data: {
            ...existingOutput.data,
            title: 'Existing output',
            runState: createNodeRunState({
              status: 'succeeded',
              generationId: 'gen-123',
              outputUrl: 'https://example.com/existing.jpg',
            }),
          },
        },
      ],
      edges: [],
    });

    const newNode = createWorkflowNode('video-generate', { x: 480, y: 0 });
    const incomingGraph = normalizeWorkflowGraph({
      nodes: [
        {
          ...existingOutput,
          data: {
            ...existingOutput.data,
            title: 'Updated title',
            runState: createNodeRunState({ status: 'failed' }),
          },
        },
        newNode,
      ],
      edges: [],
    });

    const mergedGraph = normalizeWorkflowGraph(mergeWorkflowCanvasGraph(existingGraph, incomingGraph));
    const preservedNode = mergedGraph.nodes.find((node) => node.id === existingOutput.id);
    const insertedNode = mergedGraph.nodes.find((node) => node.id === newNode.id);

    expect(mergedGraph.nodes.find((node) => node.id === existingStart.id)).toBeUndefined();
    expect(preservedNode?.data.title).toBe('Updated title');
    expect(preservedNode?.data.runState).toMatchObject({
      status: 'succeeded',
      generationId: 'gen-123',
      outputUrl: 'https://example.com/existing.jpg',
    });
    expect(insertedNode?.data.runState).toEqual(createNodeRunState());
  });
});
