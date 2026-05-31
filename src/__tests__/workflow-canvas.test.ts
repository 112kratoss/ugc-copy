import { describe, expect, it } from 'vitest';
import {
  createNodeRunState,
  createStarterGraph,
  createWorkflowGraphHash,
  createWorkflowNode,
  duplicateWorkflowSelection,
  getExecutionOrder,
  getResolvedWorkflowImageReferences,
  getWorkflowPromptMentionCandidates,
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
  type ImageInputNodeData,
} from '@/lib/workflow-canvas';

function createImageReferenceGraph(count: number, model: 'nano-banana-2' | 'nano-banana-pro' | 'gpt-image-2' = 'nano-banana-2') {
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
      ...imageInputs.map((inputNode, index) => ({
        ...inputNode,
        data: {
          ...inputNode.data,
          imageUrl: `https://example.com/ref-${index}.png`,
        },
      })),
    ],
    edges: imageInputs.map((inputNode, index) => ({
      id: `image-ref-${index}`,
      source: inputNode.id,
      target: imageNode.id,
      sourceHandle: 'image',
      targetHandle: 'image-reference',
    })),
  });
}

describe('workflow canvas helpers', () => {
  it('validates supported handle pairings', () => {
    expect(validateWorkflowConnection('text', 'prompt')).toBe(true);
    expect(validateWorkflowConnection('image', 'image-reference')).toBe(true);
    expect(validateWorkflowConnection('image', 'reference-image')).toBe(true);
    expect(validateWorkflowConnection('video', 'reference-video')).toBe(true);
    expect(validateWorkflowConnection('audio', 'reference-audio')).toBe(true);
    expect(validateWorkflowConnection('video', 'prompt')).toBe(false);
  });

  it('resolves prompt and media inputs from incoming edges', () => {
    const graph = createStarterGraph();
    const videoNode = graph.nodes.find((node) => node.type === 'video-generate');
    expect(videoNode).toBeDefined();
    const resolved = resolveNodeInputs(graph, videoNode!.id);
    expect(resolved.prompt).toContain('UGC creator');
    expect(resolved.imageReferences).toEqual([]);
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
    expect(resolved.imageReferences).toEqual([]);
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

  it('returns handled prompt-mention candidates from reachable image branches', () => {
    const promptNode = createWorkflowNode('text-input', { x: 0, y: 0 });
    const imageSource = createWorkflowNode('image-input', { x: 0, y: 120 });
    const videoSource = createWorkflowNode('image-input', { x: 0, y: 240 });
    const imageNode = createWorkflowNode('image-generate', { x: 260, y: 0 });
    const videoNode = createWorkflowNode('video-generate', { x: 260, y: 220 });

    const graph = normalizeWorkflowGraph({
      nodes: [
        promptNode,
        {
          ...imageSource,
          data: {
            ...imageSource.data,
            title: 'Hero Bottle',
            imageUrl: 'https://example.com/image-ref.png',
            referenceHandle: '@hero',
          },
        },
        {
          ...videoSource,
          data: {
            ...videoSource.data,
            title: 'Hero Performer',
            imageUrl: 'https://example.com/video-ref.png',
            referenceHandle: '@hero',
          },
        },
        {
          ...imageNode,
          data: normalizeNodeData('image-generate', {
            ...imageNode.data,
            title: 'Poster Still',
          }),
        },
        {
          ...videoNode,
          data: normalizeNodeData('video-generate', {
            ...videoNode.data,
            title: 'Launch Video',
            model: 'seedance-1.5-pro',
          }),
        },
      ],
      edges: [
        { id: 'prompt-image', source: promptNode.id, target: imageNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'prompt-video', source: promptNode.id, target: videoNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'image-ref', source: imageSource.id, target: imageNode.id, sourceHandle: 'image', targetHandle: 'image-reference' },
        { id: 'video-ref', source: videoSource.id, target: videoNode.id, sourceHandle: 'image', targetHandle: 'image-reference' },
      ],
    });

    expect(getWorkflowPromptMentionCandidates(graph, promptNode.id)).toEqual([
      {
        handle: '@hero',
        displayName: 'Hero Bottle',
        branchLabels: ['Poster Still (Nano Banana 2.0)'],
        sourceCount: 1,
      },
    ]);
  });

  it('excludes frame-mode and multi-shot video branches from prompt mention candidates', () => {
    const promptNode = createWorkflowNode('text-input', { x: 0, y: 0 });
    const imageSource = createWorkflowNode('image-input', { x: 0, y: 120 });
    const startFrameSource = createWorkflowNode('image-input', { x: 0, y: 240 });
    const multiShotSource = createWorkflowNode('image-input', { x: 0, y: 360 });
    const frameVideoNode = createWorkflowNode('video-generate', { x: 260, y: 0 });
    const multiShotVideoNode = createWorkflowNode('video-generate', { x: 260, y: 220 });

    const graph = normalizeWorkflowGraph({
      nodes: [
        promptNode,
        {
          ...imageSource,
          data: {
            ...imageSource.data,
            title: 'Ignored Performer',
            imageUrl: 'https://example.com/ignored-ref.png',
            referenceHandle: '@frame_actor',
          },
        },
        {
          ...startFrameSource,
          data: {
            ...startFrameSource.data,
            title: 'Opening Frame',
            imageUrl: 'https://example.com/frame.png',
          },
        },
        {
          ...multiShotSource,
          data: {
            ...multiShotSource.data,
            title: 'Multi Shot Talent',
            imageUrl: 'https://example.com/multi-shot.png',
            referenceHandle: '@multi_actor',
          },
        },
        {
          ...frameVideoNode,
          data: normalizeNodeData('video-generate', {
            ...frameVideoNode.data,
            title: 'Frame Video',
          }),
        },
        {
          ...multiShotVideoNode,
          data: normalizeNodeData('video-generate', {
            ...multiShotVideoNode.data,
            title: 'Multi Shot Video',
            isMultiShot: true,
          }),
        },
      ],
      edges: [
        { id: 'prompt-frame-video', source: promptNode.id, target: frameVideoNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'prompt-multi-video', source: promptNode.id, target: multiShotVideoNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'frame-video-ref', source: imageSource.id, target: frameVideoNode.id, sourceHandle: 'image', targetHandle: 'image-reference' },
        { id: 'frame-video-start', source: startFrameSource.id, target: frameVideoNode.id, sourceHandle: 'image', targetHandle: 'start-frame' },
        { id: 'multi-shot-ref', source: multiShotSource.id, target: multiShotVideoNode.id, sourceHandle: 'image', targetHandle: 'image-reference' },
      ],
    });

    expect(getWorkflowPromptMentionCandidates(graph, promptNode.id)).toEqual([]);
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

  it('preserves Seedance asset metadata in storage saves and strips source urls from share exports', () => {
    const imageInput = createWorkflowNode('image-input', { x: 0, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...imageInput,
          data: {
            ...imageInput.data,
            imageUrl: 'https://example.com/image.jpg',
            storagePath: 'generated_images/user/image.jpg',
            seedanceAsset: {
              assetId: 'asset-123',
              assetType: 'Image',
              status: 'active',
              sourceUrl: 'https://example.com/image.jpg',
              error: null,
              lastCheckedAt: '2026-04-01T00:00:00.000Z',
            },
          },
        },
      ],
      edges: [],
    });

    const storageSerialized = serializeWorkflowGraph(graph);
    const shareSerialized = serializeWorkflowGraph(graph, { mode: 'share-export' });

    expect(storageSerialized.nodes[0].data).toMatchObject({
      seedanceAsset: expect.objectContaining({
        assetId: 'asset-123',
        status: 'active',
        sourceUrl: 'https://example.com/image.jpg',
      }),
    });
    expect(shareSerialized.nodes[0].data).toMatchObject({
      seedanceAsset: expect.objectContaining({
        assetId: 'asset-123',
        status: 'active',
        sourceUrl: null,
      }),
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

  it('keeps Seedance 2 reference media as references instead of frames', () => {
    const promptNode = createWorkflowNode('text-input', { x: 0, y: 0 });
    const imageNode = createWorkflowNode('image-input', { x: 0, y: 120 });
    const videoNode = createWorkflowNode('video-input', { x: 0, y: 240 });
    const audioNode = createWorkflowNode('audio-input', { x: 0, y: 360 });
    const seedanceNode = createWorkflowNode('video-generate', { x: 260, y: 0 });

    const graph = normalizeWorkflowGraph({
      nodes: [
        promptNode,
        {
          ...imageNode,
          data: {
            ...imageNode.data,
            imageUrl: 'https://example.com/reference.jpg',
            seedanceAsset: {
              ...(imageNode.data as ImageInputNodeData).seedanceAsset,
              assetId: 'asset-image',
              status: 'active',
              sourceUrl: 'https://example.com/reference.jpg',
              lastCheckedAt: '2026-04-01T00:00:00.000Z',
            },
          },
        },
        {
          ...videoNode,
          data: {
            ...videoNode.data,
            videoUrl: 'https://example.com/reference.mp4',
            durationSeconds: 6,
          },
        },
        {
          ...audioNode,
          data: {
            ...audioNode.data,
            audioUrl: 'https://example.com/reference.mp3',
          },
        },
        {
          ...seedanceNode,
          data: normalizeNodeData('video-generate', {
            ...seedanceNode.data,
            model: 'seedance-2',
          }),
        },
      ],
      edges: [
        { id: 'prompt-video', source: promptNode.id, target: seedanceNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'image-ref', source: imageNode.id, target: seedanceNode.id, sourceHandle: 'image', targetHandle: 'reference-image' },
        { id: 'video-ref', source: videoNode.id, target: seedanceNode.id, sourceHandle: 'video', targetHandle: 'reference-video' },
        { id: 'audio-ref', source: audioNode.id, target: seedanceNode.id, sourceHandle: 'audio', targetHandle: 'reference-audio' },
      ],
    });

    const resolved = resolveNodeInputs(graph, seedanceNode.id);
    const capabilityValidation = inspectWorkflowNodeCapabilities(graph, seedanceNode);

    expect(resolved.imageReferences).toHaveLength(1);
    expect(resolved.startFrameUrl).toBeNull();
    expect(resolved.videoUrls).toEqual(['https://example.com/reference.mp4']);
    expect(resolved.audioUrls).toEqual(['https://example.com/reference.mp3']);
    expect(capabilityValidation.referenceImageCount).toBe(1);
    expect(capabilityValidation.referenceVideoCount).toBe(1);
    expect(capabilityValidation.referenceAudioCount).toBe(1);
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

  it('normalizes GPT Image 2 resolution constraints against aspect ratio', () => {
    const autoImage = normalizeNodeData('image-generate', {
      model: 'gpt-image-2',
      aspectRatio: 'auto',
      resolution: '4K',
      outputFormat: 'png',
      googleSearch: true,
    } as never);
    const squareImage = normalizeNodeData('image-generate', {
      model: 'gpt-image-2',
      aspectRatio: '1:1',
      resolution: '4K',
    } as never);
    const portraitImage = normalizeNodeData('image-generate', {
      model: 'gpt-image-2',
      aspectRatio: '4:5',
      resolution: '4K',
    } as never);

    expect(autoImage.resolution).toBe('1K');
    expect(autoImage.outputFormat).toBe('jpg');
    expect(autoImage.googleSearch).toBe(false);
    expect(squareImage.resolution).toBe('1K');
    expect(portraitImage.resolution).toBe('4K');
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
      targetHandle: 'image-reference',
    });

    expect(validation.valid).toBe(false);
    expect(validation.message).toMatch(/up to 14 total image references/i);
  });

  it('enforces GPT Image 2 image-reference limits', () => {
    const graph = createImageReferenceGraph(16, 'gpt-image-2');
    const imageNode = graph.nodes.find((node) => node.type === 'image-generate');
    const extraInput = createWorkflowNode('image-input', { x: 0, y: 1360 });
    const graphWithExtraInput = normalizeWorkflowGraph({
      nodes: [...graph.nodes, extraInput],
      edges: graph.edges,
    });

    expect(imageNode).toBeDefined();
    expect(inspectWorkflowNodeCapabilities(graph, imageNode!)).toMatchObject({
      isValid: true,
      referenceImageCount: 16,
      referenceImageLimit: 16,
    });

    const validation = validateWorkflowConnectionForGraph({
      graph: graphWithExtraInput,
      sourceNodeId: extraInput.id,
      sourceHandle: 'image',
      targetNodeId: imageNode!.id,
      targetHandle: 'image-reference',
    });
    expect(validation.valid).toBe(false);
    expect(validation.message).toMatch(/up to 16 total image references/i);
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

    expect((normalizedImageNode?.data as { referenceBindings?: Array<{ edgeId: string; handle: string | null }> }).referenceBindings).toEqual([
      { edgeId: 'element-edge', handle: '@hero_product' },
    ]);
    expect(resolved.imageReferences).toEqual([
      expect.objectContaining({
        edgeId: 'element-edge',
        sourceNodeId: imageSource.id,
        sourceTitle: 'Hero Product',
        url: 'https://example.com/hero.png',
      }),
    ]);
  });

  it('prefers source-owned handles over legacy target-owned bindings for connected refs', () => {
    const imageSource = createWorkflowNode('image-input', { x: 0, y: 0 });
    const imageNode = createWorkflowNode('image-generate', { x: 240, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...imageSource,
          data: normalizeNodeData('image-input', {
            ...imageSource.data,
            title: 'Hero Bottle',
            imageUrl: 'https://example.com/hero.png',
            referenceHandle: '@hero',
          }),
        },
        {
          ...imageNode,
          data: normalizeNodeData('image-generate', {
            ...imageNode.data,
            referenceBindings: [{ edgeId: 'image-ref', handle: '@legacy_hero' }],
          }),
        },
      ],
      edges: [
        {
          id: 'image-ref',
          source: imageSource.id,
          target: imageNode.id,
          sourceHandle: 'image',
          targetHandle: 'image-reference',
        },
      ],
    });

    expect(getResolvedWorkflowImageReferences(graph, imageNode.id)).toEqual([
      expect.objectContaining({
        edgeId: 'image-ref',
        handle: '@hero',
        handleSource: 'source',
      }),
    ]);
  });

  it('falls back to legacy target-owned bindings when the source has no handle yet', () => {
    const imageSource = createWorkflowNode('image-input', { x: 0, y: 0 });
    const imageNode = createWorkflowNode('image-generate', { x: 240, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...imageSource,
          data: normalizeNodeData('image-input', {
            ...imageSource.data,
            title: 'Hero Bottle',
            imageUrl: 'https://example.com/hero.png',
          }),
        },
        {
          ...imageNode,
          data: normalizeNodeData('image-generate', {
            ...imageNode.data,
            referenceBindings: [{ edgeId: 'image-ref', handle: '@legacy_hero' }],
          }),
        },
      ],
      edges: [
        {
          id: 'image-ref',
          source: imageSource.id,
          target: imageNode.id,
          sourceHandle: 'image',
          targetHandle: 'image-reference',
        },
      ],
    });

    expect(getResolvedWorkflowImageReferences(graph, imageNode.id)).toEqual([
      expect.objectContaining({
        edgeId: 'image-ref',
        handle: '@legacy_hero',
        handleSource: 'legacy-binding',
      }),
    ]);
  });

  it('uses source-owned handles from upstream image-generator outputs too', () => {
    const upstreamImageNode = createWorkflowNode('image-generate', { x: 0, y: 0 });
    const downstreamImageNode = createWorkflowNode('image-generate', { x: 260, y: 0 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...upstreamImageNode,
          data: normalizeNodeData('image-generate', {
            ...upstreamImageNode.data,
            title: 'Styled Bottle',
            referenceHandle: '@styled_bottle',
            runState: createNodeRunState({
              status: 'succeeded',
              outputUrl: 'https://example.com/styled-bottle.png',
            }),
          }),
        },
        downstreamImageNode,
      ],
      edges: [
        {
          id: 'upstream-ref',
          source: upstreamImageNode.id,
          target: downstreamImageNode.id,
          sourceHandle: 'image',
          targetHandle: 'image-reference',
        },
      ],
    });

    expect(getResolvedWorkflowImageReferences(graph, downstreamImageNode.id)).toEqual([
      expect.objectContaining({
        edgeId: 'upstream-ref',
        handle: '@styled_bottle',
        handleSource: 'source',
        displayName: 'Styled Bottle',
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
    expect(capabilityValidation.issues[0]?.message).toMatch(/up to 8 total image references/i);

    const dependencyState = inspectWorkflowNodeDependencies(graph, imageNode!);
    expect(dependencyState.kind).toBe('blocked');
    expect(dependencyState.message).toMatch(/remove extra references/i);
  });

  it('validates prompt handles against connected source-owned reference handles', () => {
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
            referenceHandle: '@hero',
          },
        },
        imageNode,
      ],
      edges: [
        { id: 'prompt-image', source: promptNode.id, target: imageNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'image-ref', source: sourceImage.id, target: imageNode.id, sourceHandle: 'image', targetHandle: 'image-reference' },
      ],
    });

    const capabilityValidation = inspectWorkflowNodeCapabilities(graph, graph.nodes.find((node) => node.id === imageNode.id)!);
    expect(capabilityValidation.isValid).toBe(true);
    expect(capabilityValidation.namedElementCount).toBe(1);
  });

  it('flags duplicate source-owned handles only on the affected generator node', () => {
    const firstImage = createWorkflowNode('image-input', { x: 0, y: 0 });
    const secondImage = createWorkflowNode('image-input', { x: 0, y: 140 });
    const imageNode = createWorkflowNode('image-generate', { x: 260, y: 0 });
    const unrelatedImageNode = createWorkflowNode('image-generate', { x: 260, y: 220 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...firstImage,
          data: normalizeNodeData('image-input', {
            ...firstImage.data,
            imageUrl: 'https://example.com/hero-a.png',
            referenceHandle: '@hero',
          }),
        },
        {
          ...secondImage,
          data: normalizeNodeData('image-input', {
            ...secondImage.data,
            imageUrl: 'https://example.com/hero-b.png',
            referenceHandle: '@hero',
          }),
        },
        imageNode,
        unrelatedImageNode,
      ],
      edges: [
        { id: 'image-ref-1', source: firstImage.id, target: imageNode.id, sourceHandle: 'image', targetHandle: 'image-reference' },
        { id: 'image-ref-2', source: secondImage.id, target: imageNode.id, sourceHandle: 'image', targetHandle: 'image-reference' },
        { id: 'image-ref-3', source: firstImage.id, target: unrelatedImageNode.id, sourceHandle: 'image', targetHandle: 'image-reference' },
      ],
    });

    expect(inspectWorkflowNodeCapabilities(graph, imageNode).issues.map((issue) => issue.code)).toContain('duplicate-element-handles');
    expect(inspectWorkflowNodeCapabilities(graph, unrelatedImageNode).issues.map((issue) => issue.code)).not.toContain('duplicate-element-handles');
  });

  it('rejects new general image-reference connections on workflow video nodes', () => {
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
      targetHandle: 'image-reference',
    });

    expect(validation.valid).toBe(false);
    expect(validation.message).toMatch(/use Start frame and optional End frame/i);
  });

  it('still allows start and end frame connections on workflow video nodes', () => {
    const videoNode = createWorkflowNode('video-generate', { x: 240, y: 0 });
    const startImage = createWorkflowNode('image-input', { x: 0, y: 0 });
    const endImage = createWorkflowNode('image-input', { x: 0, y: 120 });
    const graph = normalizeWorkflowGraph({
      nodes: [videoNode, startImage, endImage],
      edges: [
        {
          id: 'video-start',
          source: startImage.id,
          target: videoNode.id,
          sourceHandle: 'image',
          targetHandle: 'start-frame',
        },
      ],
    });

    const endFrameValidation = validateWorkflowConnectionForGraph({
      graph,
      sourceNodeId: endImage.id,
      sourceHandle: 'image',
      targetNodeId: videoNode.id,
      targetHandle: 'end-frame',
    });

    expect(endFrameValidation.valid).toBe(true);
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

  it('allows Kling 3.0 video nodes to connect named reference videos', () => {
    const klingNode = createWorkflowNode('video-generate', { x: 240, y: 0 });
    const firstVideo = createWorkflowNode('video-input', { x: 0, y: 0 });
    const secondVideo = createWorkflowNode('video-input', { x: 0, y: 120 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...klingNode,
          data: normalizeNodeData('video-generate', {
            ...klingNode.data,
            model: 'kling-3.0-video',
          }),
        },
        {
          ...firstVideo,
          data: normalizeNodeData('video-input', {
            ...firstVideo.data,
            videoUrl: 'https://cdn.example.com/reference-1.mp4',
          }),
        },
        secondVideo,
      ],
      edges: [
        {
          id: 'kling-video-1',
          source: firstVideo.id,
          target: klingNode.id,
          sourceHandle: 'video',
          targetHandle: 'reference-video',
        },
      ],
    });

    const validation = validateWorkflowConnectionForGraph({
      graph,
      sourceNodeId: secondVideo.id,
      sourceHandle: 'video',
      targetNodeId: klingNode.id,
      targetHandle: 'reference-video',
    });
    const resolvedKlingNode = graph.nodes.find((node) => node.id === klingNode.id)!;
    const capabilityValidation = inspectWorkflowNodeCapabilities(graph, resolvedKlingNode);

    expect(validation.valid).toBe(true);
    expect(capabilityValidation.isValid).toBe(true);
    expect(capabilityValidation.referenceVideoLimit).toBe(3);
    expect(capabilityValidation.referenceVideoCount).toBe(1);
  });

  it('enforces the Kling 3.0 video reference cap and blocks reference audio', () => {
    const klingNode = createWorkflowNode('video-generate', { x: 240, y: 0 });
    const videoInputs = Array.from({ length: 4 }, (_, index) => createWorkflowNode('video-input', { x: 0, y: index * 120 }));
    const audioInput = createWorkflowNode('audio-input', { x: 0, y: 520 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...klingNode,
          data: normalizeNodeData('video-generate', {
            ...klingNode.data,
            model: 'kling-3.0-video',
          }),
        },
        ...videoInputs,
        audioInput,
      ],
      edges: videoInputs.slice(0, 3).map((videoInput, index) => ({
        id: `kling-video-${index + 1}`,
        source: videoInput.id,
        target: klingNode.id,
        sourceHandle: 'video',
        targetHandle: 'reference-video',
      })),
    });

    const extraVideoValidation = validateWorkflowConnectionForGraph({
      graph,
      sourceNodeId: videoInputs[3]!.id,
      sourceHandle: 'video',
      targetNodeId: klingNode.id,
      targetHandle: 'reference-video',
    });
    const audioValidation = validateWorkflowConnectionForGraph({
      graph,
      sourceNodeId: audioInput.id,
      sourceHandle: 'audio',
      targetNodeId: klingNode.id,
      targetHandle: 'reference-audio',
    });
    const overLimitGraph = normalizeWorkflowGraph({
      ...graph,
      edges: [
        ...graph.edges,
        {
          id: 'kling-video-4',
          source: videoInputs[3]!.id,
          target: klingNode.id,
          sourceHandle: 'video',
          targetHandle: 'reference-video',
        },
      ],
    });
    const overLimitNode = overLimitGraph.nodes.find((node) => node.id === klingNode.id)!;
    const capabilityValidation = inspectWorkflowNodeCapabilities(overLimitGraph, overLimitNode);

    expect(extraVideoValidation.valid).toBe(false);
    expect(extraVideoValidation.message).toMatch(/up to 3 reference videos/i);
    expect(audioValidation.valid).toBe(false);
    expect(audioValidation.message).toMatch(/audio/i);
    expect(capabilityValidation.isValid).toBe(false);
    expect(capabilityValidation.issues[0]?.code).toBe('too-many-reference-videos');
  });

  it('accepts Kling multi-shot prompts that mention connected video handles', () => {
    const promptNode = createWorkflowNode('text-input', { x: 0, y: 0 });
    const klingNode = createWorkflowNode('video-generate', { x: 240, y: 0 });
    const videoInput = createWorkflowNode('video-input', { x: 0, y: 160 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        promptNode,
        {
          ...klingNode,
          data: normalizeNodeData('video-generate', {
            ...klingNode.data,
            model: 'kling-3.0-video',
            isMultiShot: true,
            multiPrompts: [
              { id: 'shot-1', prompt: 'Start with @motion_ref crossing frame.', duration: 3 },
              { id: 'shot-2', prompt: 'Follow @motion_ref into a close-up.', duration: 4 },
            ],
          }),
        },
        {
          ...videoInput,
          data: normalizeNodeData('video-input', {
            ...videoInput.data,
            title: 'Motion ref',
            videoUrl: 'https://cdn.example.com/motion-ref.mp4',
          }),
        },
      ],
      edges: [
        { id: 'prompt-kling', source: promptNode.id, target: klingNode.id, sourceHandle: 'text', targetHandle: 'prompt' },
        { id: 'kling-video-1', source: videoInput.id, target: klingNode.id, sourceHandle: 'video', targetHandle: 'reference-video' },
      ],
    });
    const resolvedKlingNode = graph.nodes.find((node) => node.id === klingNode.id)!;
    const capabilityValidation = inspectWorkflowNodeCapabilities(graph, resolvedKlingNode);

    expect(capabilityValidation.isValid).toBe(true);
    expect(capabilityValidation.issues).toEqual([]);
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
    const seedance2 = normalizeNodeData('video-generate', {
      model: 'seedance-2',
      aspectRatio: '1:4',
      duration: 2,
      sound: true,
      resolution: '1080p',
      fixedLens: true,
    } as never);
    const seedance2Fast = normalizeNodeData('video-generate', {
      model: 'seedance-2-fast',
      aspectRatio: '2:3',
      duration: 30,
      sound: true,
      resolution: '1080p',
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

    expect(seedance2.aspectRatio).toBe('9:16');
    expect(seedance2.duration).toBe(4);
    expect(seedance2.resolution).toBe('480p');
    expect(seedance2.sound).toBe(true);
    expect(seedance2.fixedLens).toBe(false);

    expect(seedance2Fast.aspectRatio).toBe('9:16');
    expect(seedance2Fast.duration).toBe(15);
    expect(seedance2Fast.resolution).toBe('480p');
    expect(seedance2Fast.sound).toBe(true);
    expect(seedance2Fast.fixedLens).toBe(false);

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
      referenceBindings: [
        {
          edgeId: result.duplicatedEdges[0]?.id,
          handle: '@hero_product',
        },
      ],
    });
    expect(duplicatedImageNode?.data).not.toMatchObject({
      referenceBindings: [
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

    const mergedGraph = normalizeWorkflowGraph(mergeWorkflowCanvasGraph(existingGraph, incomingGraph) as never);
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
