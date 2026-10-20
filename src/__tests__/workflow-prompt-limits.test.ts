import { describe, expect, it } from 'vitest';

import {
  tightestWorkflowPromptLimit,
  workflowGeneratorPromptLimits,
  workflowPromptNodeLimits,
} from '@/app/create-workflow/workflowPromptLimits';
import {
  createWorkflowNode,
  normalizeNodeData,
  normalizeWorkflowGraph,
  type WorkflowCanvasEdge,
  type WorkflowCanvasNode,
  type WorkflowNodeData,
} from '@/lib/workflow-canvas';

/** A node of this kind at the origin, with these fields over its defaults. */
function node(kind: Parameters<typeof createWorkflowNode>[0], id: string, data: Record<string, unknown> = {}): WorkflowCanvasNode {
  const created = createWorkflowNode(kind, { x: 0, y: 0 });
  return { ...created, id, data: normalizeNodeData(kind, { ...created.data, ...data } as Partial<WorkflowNodeData>) };
}

function textEdge(source: string, target: string): WorkflowCanvasEdge {
  return { id: `${source}->${target}`, source, target, sourceHandle: 'text', targetHandle: 'prompt' };
}

function graphOf(nodes: WorkflowCanvasNode[], edges: WorkflowCanvasEdge[]) {
  return normalizeWorkflowGraph({ nodes, edges });
}

describe('workflow prompt limits', () => {
  it('holds a prompt node to the model of the generator it feeds, in the start’s own words', () => {
    const graph = graphOf(
      [node('text-input', 'prompt', { text: 'x'.repeat(1001) }), node('image-generate', 'image', { model: 'z-image' })],
      [textEdge('prompt', 'image')],
    );

    const [state] = workflowPromptNodeLimits(graph, 'prompt');
    expect(state).toMatchObject({
      nodeId: 'image',
      modelName: 'Z-Image',
      meter: { length: 1001, limit: 1000, state: 'over', label: '1,001 / 1,000' },
      violation: 'Z-Image prompts support up to 1,000 characters.',
    });
  });

  it('reads the generator with the least room when the text feeds several, and counts every prompt joined', () => {
    const graph = graphOf(
      [
        node('text-input', 'scene', { text: 'x'.repeat(900) }),
        node('text-input', 'style', { text: 'y'.repeat(50) }),
        node('image-generate', 'roomy', { model: 'nano-banana-2' }),
        node('image-generate', 'tight', { model: 'z-image' }),
      ],
      [textEdge('scene', 'roomy'), textEdge('scene', 'tight'), textEdge('style', 'tight')],
    );

    const states = workflowPromptNodeLimits(graph, 'scene');
    expect(states.map((state) => [state.nodeId, state.meter.label])).toEqual([
      ['roomy', '900 / 10,000'],
      // Both prompt nodes' text, joined as the step sends it.
      ['tight', '952 / 1,000'],
    ]);
    expect(tightestWorkflowPromptLimit(states)?.nodeId).toBe('tight');
    expect(tightestWorkflowPromptLimit(states)?.meter.state).toBe('near');
    expect(tightestWorkflowPromptLimit([])).toBeNull();
  });

  it('holds each shot of a multi-shot video to its model’s shot limit, and leaves its connected prompt out', () => {
    const shots = [
      { id: 's1', prompt: 'A door opens', duration: 5 },
      { id: 's2', prompt: 'z'.repeat(501), duration: 5 },
    ];
    const graph = graphOf(
      [
        node('text-input', 'prompt', { text: 'x'.repeat(4000) }),
        node('video-generate', 'video', { model: 'kling-3.0-video', isMultiShot: true, multiPrompts: shots }),
      ],
      [textEdge('prompt', 'video')],
    );

    // The step sends the shots, so the prompt node's text is not held to the video's limit.
    expect(workflowPromptNodeLimits(graph, 'prompt')).toEqual([]);
    const state = workflowGeneratorPromptLimits(graph, graph.nodes.find((candidate) => candidate.id === 'video')!);
    expect(state?.shotMeters.map((meter) => [meter.label, meter.state])).toEqual([
      ['12 / 500', 'within'],
      ['501 / 500', 'over'],
    ]);
    expect(state?.violation).toBe('Shot 2: Kling 3.0 Cinematic shot prompts support up to 500 characters.');
  });

  it('counts each mention of a connected Kling clip as 37 characters', () => {
    const typed = `${'a'.repeat(500 - 37 - 1)} @motion_ref`;
    const graph = graphOf(
      [
        node('video-input', 'clip', { title: 'Motion ref', videoUrl: 'https://example.com/clip.mp4', storagePath: 'uploads/user-1/clip.mp4' }),
        node('video-generate', 'video', { model: 'kling-3.0-video', isMultiShot: true, multiPrompts: [{ id: 's1', prompt: typed, duration: 5 }] }),
      ],
      [{ id: 'clip->video', source: 'clip', target: 'video', sourceHandle: 'video', targetHandle: 'reference-video' }],
    );

    const state = workflowGeneratorPromptLimits(graph, graph.nodes.find((candidate) => candidate.id === 'video')!);
    expect(state?.shotMeters[0]).toMatchObject({ length: 500, state: 'near' });
    expect(state?.violation).toBeNull();
  });

  it('says the route’s own limit where the model sets none, since a prompt node’s box takes any length', () => {
    const graph = graphOf(
      [node('text-input', 'prompt', { text: 'x'.repeat(2501) }), node('motion-generate', 'motion', { model: 'kling-3.0' })],
      [textEdge('prompt', 'motion')],
    );

    expect(workflowPromptNodeLimits(graph, 'prompt')[0]).toMatchObject({
      meter: { label: '2,501 / 2,500', state: 'over' },
      violation: 'Kling 3.0 prompts support up to 2,500 characters.',
    });
  });

  it('says nothing for an empty prompt, or for a node that generates nothing', () => {
    const graph = graphOf(
      [node('text-input', 'prompt', { text: '' }), node('image-generate', 'image', { model: 'seedream-5-lite' })],
      [textEdge('prompt', 'image')],
    );

    expect(workflowPromptNodeLimits(graph, 'prompt')[0]).toMatchObject({ meter: { length: 0, state: 'within' }, violation: null });
    expect(workflowGeneratorPromptLimits(graph, graph.nodes.find((candidate) => candidate.id === 'prompt')!)).toBeNull();
  });
});
