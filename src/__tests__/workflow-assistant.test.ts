import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKFLOW_ASSISTANT_BLUEPRINT,
  createWorkflowAssistantGraphProposal,
  extractWorkflowAssistantBlueprintFromResponse,
  getWorkflowAssistantPreviewNodeStates,
  sanitizeWorkflowAssistantBlueprint,
} from '@/lib/workflow-assistant';
import {
  createWorkflowNode,
  normalizeWorkflowGraph,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';

function createEmptyGraph(): WorkflowCanvasGraph {
  return normalizeWorkflowGraph({
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
}

describe('workflow assistant helpers', () => {
  it('falls back to transformation-aware defaults when the model response is invalid', () => {
    const blueprint = extractWorkflowAssistantBlueprintFromResponse('not valid json', {
      latestUserMessage: 'Use a girl reference image, create a before and after transformation with lightning and audio.',
    });

    expect(blueprint.deliveryPlan.primaryModel).toBe('seedance-1.5-pro');
    expect(blueprint.assetSlots.map((slot) => slot.slotKey)).toEqual([
      'hero-reference',
      'before-frame',
      'after-frame',
      'audio-cue',
    ]);
    expect(blueprint.assetSlots.find((slot) => slot.slotKey === 'audio-cue')?.kind).toBe('audio');
  });

  it('maps assistant model aliases like Seedance 2.0 to supported ids', () => {
    const blueprint = extractWorkflowAssistantBlueprintFromResponse(`{
      "title": "Seedance alias test",
      "assistantReply": "Using Seedance 2.0",
      "changeSummary": "Alias handling",
      "creativeStrategy": "Keep it simple",
      "narrative": "Reference-led transformation",
      "voiceover": "",
      "assetSlots": [{"slotKey":"hero-reference","kind":"image","label":"Hero reference","purpose":"Identity","required":true}],
      "shots": [{"shotKey":"transform","title":"Transform","purpose":"Main beat","beat":"Reveal","visualPrompt":"Still prompt","videoPrompt":"Video prompt","motionPrompt":"Motion prompt","duration":6,"startSlotKey":null,"endSlotKey":null,"referenceImageSlotKeys":["hero-reference"],"referenceVideoSlotKeys":[],"referenceAudioSlotKeys":[]}],
      "deliveryPlan": {"primaryModel":"Seedance 2.0","stillImageModel":"Nano Banana Pro","motionModel":"Kling 3.0","aspectRatio":"9:16"}
    }`, {
      latestUserMessage: 'Create a transformation workflow.',
    });

    expect(blueprint.deliveryPlan.primaryModel).toBe('seedance-2');
    expect(blueprint.deliveryPlan.stillImageModel).toBe('nano-banana-pro');
    expect(blueprint.deliveryPlan.motionModel).toBe('kling-3.0');
  });

  it('maps ChatGPT image requests to GPT Image 2 without changing defaults', () => {
    const blueprint = extractWorkflowAssistantBlueprintFromResponse(`{
      "title": "ChatGPT image alias test",
      "assistantReply": "Using ChatGPT image",
      "changeSummary": "Alias handling",
      "creativeStrategy": "Keep it crisp",
      "narrative": "Prompt-led image workflow",
      "voiceover": "",
      "assetSlots": [],
      "shots": [{"shotKey":"still","title":"Still","purpose":"Main visual","beat":"Hero frame","visualPrompt":"Still prompt","videoPrompt":"Video prompt","motionPrompt":"Motion prompt","duration":5,"startSlotKey":null,"endSlotKey":null,"referenceImageSlotKeys":[],"referenceVideoSlotKeys":[],"referenceAudioSlotKeys":[]}],
      "deliveryPlan": {"primaryModel":"kling-3.0-video","stillImageModel":"ChatGPT Image","motionModel":"Kling 3.0","aspectRatio":"9:16"}
    }`, {
      latestUserMessage: 'Use ChatGPT image for the stills.',
    });

    expect(blueprint.deliveryPlan.stillImageModel).toBe('gpt-image-2');
    expect(DEFAULT_WORKFLOW_ASSISTANT_BLUEPRINT.deliveryPlan.stillImageModel).toBe('nano-banana-pro');
  });

  it('sanitizes partial assistant output and keeps only valid referenced slots', () => {
    const blueprint = sanitizeWorkflowAssistantBlueprint({
      assetSlots: [
        { slotKey: 'hero', kind: 'image', label: 'Hero', purpose: 'Identity', required: true },
        { slotKey: 'hero', kind: 'image', label: 'Duplicate', purpose: 'Ignored', required: true },
        { slotKey: 'beat-audio', kind: 'audio', label: 'Beat audio', purpose: 'Timing', required: false },
      ],
      shots: [
        {
          shotKey: 'reveal',
          title: 'Reveal',
          purpose: 'Transformation beat',
          beat: 'Lightning strike',
          visualPrompt: 'Before image',
          videoPrompt: 'Transformation video',
          motionPrompt: 'Energy surge',
          duration: 20,
          startSlotKey: 'hero',
          endSlotKey: 'missing-slot',
          referenceImageSlotKeys: ['hero', 'missing-slot'],
          referenceVideoSlotKeys: ['missing-video'],
          referenceAudioSlotKeys: ['beat-audio'],
        },
      ],
      deliveryPlan: {
        primaryModel: 'not-a-model' as never,
        stillImageModel: 'nope' as never,
        motionModel: 'bad' as never,
        aspectRatio: 'widescreen' as never,
      },
    }, {
      latestUserMessage: 'Create a before and after morph.',
    });

    expect(blueprint.assetSlots).toHaveLength(2);
    expect(blueprint.assetSlots.map((slot) => slot.slotKey)).toEqual(['hero', 'beat-audio']);
    expect(blueprint.shots[0].duration).toBe(12);
    expect(blueprint.shots[0].startSlotKey).toBe('hero');
    expect(blueprint.shots[0].endSlotKey).toBeNull();
    expect(blueprint.shots[0].referenceImageSlotKeys).toEqual(['hero']);
    expect(blueprint.shots[0].referenceVideoSlotKeys).toEqual([]);
    expect(blueprint.shots[0].referenceAudioSlotKeys).toEqual(['beat-audio']);
    expect(blueprint.deliveryPlan.primaryModel).toBe('seedance-1.5-pro');
    expect(blueprint.deliveryPlan.stillImageModel).toBe('nano-banana-pro');
    expect(blueprint.deliveryPlan.motionModel).toBe('kling-3.0');
    expect(blueprint.deliveryPlan.aspectRatio).toBe('9:16');
  });

  it('prefers an explicit user Seedance 2.0 request over the transformation fallback heuristic', () => {
    const blueprint = sanitizeWorkflowAssistantBlueprint({
      deliveryPlan: {
        primaryModel: 'not-a-model' as never,
        stillImageModel: 'nano-banana-pro',
        motionModel: 'kling-3.0',
        aspectRatio: '9:16',
      },
    }, {
      latestUserMessage: 'I want a before and after transformation using Seedance 2.0 for the video model.',
    });

    expect(blueprint.deliveryPlan.primaryModel).toBe('seedance-2');
  });

  it('compiles a new assistant-managed graph with slot placeholders and start/end frame wiring', () => {
    const blueprint = sanitizeWorkflowAssistantBlueprint({
      title: 'Lightning transformation',
      changeSummary: 'Draft the before/after transformation workflow.',
      voiceover: 'She takes the hit and becomes electric.',
      assetSlots: [
        { slotKey: 'hero-reference', kind: 'image', label: 'Hero reference', purpose: 'Identity anchor', required: true },
        { slotKey: 'before-frame', kind: 'image', label: 'Before frame', purpose: 'Starting look', required: true },
        { slotKey: 'after-frame', kind: 'image', label: 'After frame', purpose: 'Final suit reveal', required: true },
        { slotKey: 'audio-cue', kind: 'audio', label: 'Audio cue', purpose: 'Lightning impact timing', required: false },
      ],
      shots: [
        {
          shotKey: 'transform',
          title: 'Transformation shot',
          purpose: 'Bridge the before and after states',
          beat: 'Lightning strike and suit reveal',
          visualPrompt: 'Hero still before the strike',
          videoPrompt: 'Lightning hits the girl and she transforms into her electric suit',
          motionPrompt: 'Carry the same hero through an energetic motion pass',
          duration: 6,
          startSlotKey: 'before-frame',
          endSlotKey: 'after-frame',
          referenceImageSlotKeys: ['hero-reference'],
          referenceVideoSlotKeys: [],
          referenceAudioSlotKeys: ['audio-cue'],
        },
      ],
      deliveryPlan: {
        primaryModel: 'seedance-1.5-pro',
        stillImageModel: 'nano-banana-pro',
        motionModel: 'kling-3.0',
        aspectRatio: '9:16',
      },
    }, {
      latestUserMessage: 'Build a transformation workflow.',
    });

    const proposal = createWorkflowAssistantGraphProposal({
      currentGraph: createEmptyGraph(),
      blueprint,
    });

    const groupNode = proposal.proposedGraph.nodes.find((node) => node.type === 'group');
    const voiceoverNode = proposal.proposedGraph.nodes.find((node) => node.type === 'voiceover-generate');
    const videoNode = proposal.proposedGraph.nodes.find((node) => node.type === 'video-generate');
    const slotNodes = proposal.proposedGraph.nodes.filter((node) => node.data.managed && node.data.slotKey);
    const startEdge = proposal.proposedGraph.edges.find((edge) => edge.target === videoNode?.id && edge.targetHandle === 'start-frame');
    const endEdge = proposal.proposedGraph.edges.find((edge) => edge.target === videoNode?.id && edge.targetHandle === 'end-frame');

    expect(groupNode?.data.managed).toBe(true);
    expect(groupNode?.data.roleKey).toBe('region-group');
    expect(slotNodes.map((node) => node.data.slotKey)).toEqual([
      'hero-reference',
      'before-frame',
      'after-frame',
      'audio-cue',
    ]);
    expect(videoNode?.data).toMatchObject({
      model: 'seedance-1.5-pro',
      aspectRatio: '9:16',
    });
    expect(voiceoverNode?.type).toBe('voiceover-generate');
    expect(startEdge).toBeTruthy();
    expect(endEdge).toBeTruthy();
    expect(proposal.diff.nodes.added.length).toBe(proposal.proposedGraph.nodes.length);
  });

  it('replaces only the assistant region on follow-up edits while preserving manual nodes and stable ids', () => {
    const manualNote = createWorkflowNode('note', { x: 24, y: 48 });
    const graphWithManual = normalizeWorkflowGraph({
      nodes: [
        {
          ...manualNote,
          data: {
            ...manualNote.data,
            title: 'Manual node',
            subtitle: 'Keep me',
          },
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    const initialBlueprint = sanitizeWorkflowAssistantBlueprint({
      ...DEFAULT_WORKFLOW_ASSISTANT_BLUEPRINT,
      voiceover: 'Old voiceover',
      assetSlots: [
        { slotKey: 'hero-reference', kind: 'image', label: 'Hero reference', purpose: 'Identity', required: true },
        { slotKey: 'after-frame', kind: 'image', label: 'After frame', purpose: 'Reveal', required: true },
      ],
    }, {
      latestUserMessage: 'Build the first draft.',
    });

    const initialProposal = createWorkflowAssistantGraphProposal({
      currentGraph: graphWithManual,
      blueprint: initialBlueprint,
    });

    const initialGroupNode = initialProposal.proposedGraph.nodes.find((node) => node.data.roleKey === 'region-group');
    const followUpBlueprint = sanitizeWorkflowAssistantBlueprint({
      ...initialBlueprint,
      changeSummary: 'Revise the workflow without the extra reveal slot.',
      voiceover: '',
      assetSlots: [
        { slotKey: 'hero-reference', kind: 'image', label: 'Hero reference', purpose: 'Identity', required: true },
      ],
    }, {
      latestUserMessage: 'Keep the same flow but remove the after frame.',
    });

    const followUpProposal = createWorkflowAssistantGraphProposal({
      currentGraph: initialProposal.proposedGraph,
      blueprint: followUpBlueprint,
    });

    const followUpGroupNode = followUpProposal.proposedGraph.nodes.find((node) => node.data.roleKey === 'region-group');
    const previewStates = getWorkflowAssistantPreviewNodeStates(followUpProposal.diff);

    expect(followUpProposal.regionId).toBe(initialProposal.regionId);
    expect(followUpGroupNode?.id).toBe(initialGroupNode?.id);
    expect(followUpProposal.proposedGraph.nodes.some((node) => node.id === manualNote.id)).toBe(true);
    expect(followUpProposal.diff.nodes.removed.some((node) => node.roleKey === 'slot-after-frame')).toBe(true);
    expect(followUpProposal.diff.nodes.removed.some((node) => node.roleKey === 'voiceover-node')).toBe(true);
    expect(followUpProposal.diff.nodes.changed.some((node) => node.roleKey === 'region-brief')).toBe(true);
    expect(Object.values(previewStates)).toContain('changed');
    expect(Object.values(previewStates)).not.toContain('removed');
  });
});
