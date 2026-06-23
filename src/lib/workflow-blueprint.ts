import {
  clampVideoDuration,
  type ImageModelId,
  type MotionModelId,
  type VideoModelId,
} from '@/lib/models';
import {
  buildWorkflowPromptFieldGuidance,
  type EnhancerContext,
} from '@/lib/prompt-enhancer';
import {
  createCanvasEdge,
  createWorkflowNode,
  DEFAULT_VIEWPORT,
  normalizeNodeData,
  normalizeWorkflowGraph,
  type ImageGenerateNodeData,
  type MotionGenerateNodeData,
  type NoteNodeData,
  type TextInputNodeData,
  type VideoGenerateNodeData,
  type VoiceoverGenerateNodeData,
  type WorkflowCanvasEdge,
  type WorkflowCanvasGraph,
  type WorkflowCanvasNode,
} from '@/lib/workflow-canvas';
export { WORKFLOW_BLUEPRINT_COST } from '@/lib/workflow-costs';

export type WorkflowAspectRatio = '9:16' | '16:9' | '1:1';
type WorkflowObjective = 'ugc-ad' | 'product-video' | 'social-campaign';

export interface WorkflowPlannerInput {
  brandName: string;
  productName: string;
  audience: string;
  objective: WorkflowObjective;
  primaryMessage: string;
  offer: string;
  callToAction: string;
  visualStyle: string;
  tone: string;
  aspectRatio: WorkflowAspectRatio;
  durationSeconds: number;
  platform: string;
  notes?: string;
}

interface WorkflowShot {
  id: string;
  title: string;
  purpose: string;
  beat: string;
  visualPrompt: string;
  videoPrompt: string;
  motionPrompt: string;
  duration: number;
}

export interface WorkflowBlueprint {
  title: string;
  creativeStrategy: string;
  hook: string;
  narrative: string;
  voiceover: string;
  editingNotes: string[];
  assetChecklist: string[];
  shots: WorkflowShot[];
  deliveryPlan: {
    primaryModel: VideoModelId;
    stillImageModel: ImageModelId;
    motionModel: MotionModelId;
    recommendedSequence: string[];
  };
}

export const DEFAULT_BLUEPRINT: WorkflowBlueprint = {
  title: 'High-converting ad workflow',
  creativeStrategy: 'Lead with a sharp pain point, prove the product fast, and close with a specific CTA.',
  hook: 'Open with the viewer recognizing the problem in the first 2 seconds.',
  narrative: 'Problem → product reveal → proof → transformation → CTA.',
  voiceover: 'Hook the viewer, explain the benefit in one sentence, and end with a direct CTA.',
  editingNotes: [
    'Use captions for every key benefit.',
    'Keep cuts energetic and front-load the strongest visual proof.',
    'Frame every shot around the single promise of the ad.',
  ],
  assetChecklist: [
    'Hero product still',
    'Lifestyle environment plate',
    'Motion reference clip for creator gestures',
    'Brand CTA end card',
  ],
  shots: [
    {
      id: 'shot-1',
      title: 'Pattern interrupt hook',
      purpose: 'Stop the scroll and make the audience feel the problem.',
      beat: 'A creator reacts to the pain point and tees up the solution.',
      visualPrompt: 'A creator-style close-up reacting to a frustrating everyday problem, cinematic natural light, social-first framing.',
      videoPrompt: 'Close-up UGC style shot of a creator reacting to a frustrating everyday problem, subtle handheld motion, fast-paced social ad energy.',
      motionPrompt: 'Maintain creator identity, preserve realism, confident expressive delivery, clean lifestyle background.',
      duration: 5,
    },
  ],
  deliveryPlan: {
    primaryModel: 'kling-3.0-video',
    stillImageModel: 'nano-banana-pro',
    motionModel: 'kling-3.0',
    recommendedSequence: [
      'Generate hero stills and product plates.',
      'Create the main cinematic text-to-video shots.',
      'Use motion control for creator-led variations and iterations.',
    ],
  },
};

export function sanitizeBlueprint(candidate: Partial<WorkflowBlueprint> | null | undefined): WorkflowBlueprint {
  const safeShots = Array.isArray(candidate?.shots) && candidate?.shots.length > 0
    ? candidate.shots.slice(0, 8).map((shot, index) => ({
      id: typeof shot?.id === 'string' && shot.id.trim() ? shot.id : `shot-${index + 1}`,
      title: typeof shot?.title === 'string' && shot.title.trim() ? shot.title : `Shot ${index + 1}`,
      purpose: typeof shot?.purpose === 'string' && shot.purpose.trim() ? shot.purpose : DEFAULT_BLUEPRINT.shots[0].purpose,
      beat: typeof shot?.beat === 'string' && shot.beat.trim() ? shot.beat : DEFAULT_BLUEPRINT.shots[0].beat,
      visualPrompt: typeof shot?.visualPrompt === 'string' && shot.visualPrompt.trim() ? shot.visualPrompt : DEFAULT_BLUEPRINT.shots[0].visualPrompt,
      videoPrompt: typeof shot?.videoPrompt === 'string' && shot.videoPrompt.trim() ? shot.videoPrompt : DEFAULT_BLUEPRINT.shots[0].videoPrompt,
      motionPrompt: typeof shot?.motionPrompt === 'string' && shot.motionPrompt.trim() ? shot.motionPrompt : DEFAULT_BLUEPRINT.shots[0].motionPrompt,
      duration: typeof shot?.duration === 'number' && shot.duration > 0 ? Math.min(Math.round(shot.duration), 12) : DEFAULT_BLUEPRINT.shots[0].duration,
    }))
    : DEFAULT_BLUEPRINT.shots;

  return {
    title: typeof candidate?.title === 'string' && candidate.title.trim() ? candidate.title : DEFAULT_BLUEPRINT.title,
    creativeStrategy: typeof candidate?.creativeStrategy === 'string' && candidate.creativeStrategy.trim() ? candidate.creativeStrategy : DEFAULT_BLUEPRINT.creativeStrategy,
    hook: typeof candidate?.hook === 'string' && candidate.hook.trim() ? candidate.hook : DEFAULT_BLUEPRINT.hook,
    narrative: typeof candidate?.narrative === 'string' && candidate.narrative.trim() ? candidate.narrative : DEFAULT_BLUEPRINT.narrative,
    voiceover: typeof candidate?.voiceover === 'string' && candidate.voiceover.trim() ? candidate.voiceover : DEFAULT_BLUEPRINT.voiceover,
    editingNotes: normalizeStringArray(candidate?.editingNotes, DEFAULT_BLUEPRINT.editingNotes),
    assetChecklist: normalizeStringArray(candidate?.assetChecklist, DEFAULT_BLUEPRINT.assetChecklist),
    shots: safeShots,
    deliveryPlan: {
      primaryModel: normalizeBlueprintVideoModel(candidate?.deliveryPlan?.primaryModel),
      stillImageModel: normalizeBlueprintImageModel(candidate?.deliveryPlan?.stillImageModel),
      motionModel: normalizeBlueprintMotionModel(candidate?.deliveryPlan?.motionModel),
      recommendedSequence: normalizeStringArray(candidate?.deliveryPlan?.recommendedSequence, DEFAULT_BLUEPRINT.deliveryPlan.recommendedSequence),
    },
  };
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const next = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 8);
  return next.length > 0 ? next : fallback;
}

function normalizeBlueprintImageModel(value: unknown): ImageModelId {
  if (value === 'nano-banana-pro' || value === 'gpt-image-2' || value === 'grok-imagine-image') {
    return value;
  }

  return 'nano-banana-2';
}

function normalizeBlueprintVideoModel(value: unknown): VideoModelId {
  if (
    value === 'seedance-1.5-pro' ||
    value === 'seedance-2' ||
    value === 'seedance-2-fast' ||
    value === 'veo-3.1' ||
    value === 'grok-imagine-video'
  ) {
    return value;
  }

  return 'kling-3.0-video';
}

function normalizeBlueprintMotionModel(value: unknown): MotionModelId {
  return value === 'kling-2.6' ? 'kling-2.6' : 'kling-3.0';
}

export function extractBlueprintFromResponse(content: string): WorkflowBlueprint {
  const fencedMatch = content.match(/```json\s*([\s\S]*?)```/i);
  const rawJson = fencedMatch?.[1] ?? content;
  const start = rawJson.indexOf('{');
  const end = rawJson.lastIndexOf('}');
  if (start === -1 || end === -1 || start >= end) {
    return DEFAULT_BLUEPRINT;
  }

  try {
    const parsed = JSON.parse(rawJson.slice(start, end + 1)) as Partial<WorkflowBlueprint>;
    return sanitizeBlueprint(parsed);
  } catch {
    return DEFAULT_BLUEPRINT;
  }
}

export function buildWorkflowSystemPrompt(input: WorkflowPlannerInput): string {
  const plannerContext: EnhancerContext = {
    creativeIntent: input.objective,
  };

  return [
    'You are an expert creative strategist building a production-ready AI generation workflow for short-form ads and videos.',
    'Return valid JSON only. No markdown. No commentary.',
    'The JSON schema is: {"title":string,"creativeStrategy":string,"hook":string,"narrative":string,"voiceover":string,"editingNotes":string[],"assetChecklist":string[],"shots":[{"id":string,"title":string,"purpose":string,"beat":string,"visualPrompt":string,"videoPrompt":string,"motionPrompt":string,"duration":number}],"deliveryPlan":{"primaryModel":string,"stillImageModel":string,"motionModel":string,"recommendedSequence":string[]}}.',
    'Use the existing models only: stillImageModel must be nano-banana-2, nano-banana-pro, gpt-image-2, or grok-imagine-image; primaryModel must be kling-3.0-video, seedance-1.5-pro, seedance-2, seedance-2-fast, veo-3.1, or grok-imagine-video; motionModel must be kling-2.6 or kling-3.0.',
    `Plan for a ${input.durationSeconds}-second ${input.objective} in ${input.aspectRatio} for ${input.platform}.`,
    'Generate 3 to 6 shots. Each prompt should be directly usable in an AI generation UI and must stay commercially focused.',
    buildWorkflowPromptFieldGuidance({
      fieldName: 'visualPrompt',
      modelSelector: 'stillImageModel',
      medium: 'image',
      scenario: 'image.text_to_image',
      modelIds: ['nano-banana-2', 'nano-banana-pro', 'gpt-image-2', 'grok-imagine-image'],
      context: plannerContext,
    }),
    buildWorkflowPromptFieldGuidance({
      fieldName: 'videoPrompt',
      modelSelector: 'primaryModel',
      medium: 'video',
      scenario: 'video.image_to_video_start_frame',
      modelIds: ['kling-3.0-video', 'seedance-1.5-pro', 'seedance-2', 'seedance-2-fast', 'veo-3.1', 'grok-imagine-video'],
      context: plannerContext,
      additionalRules: [
        'These prompts should still read clearly as standalone text prompts, but they should stay reference-friendly because the workflow often pairs them with a still frame.',
      ],
    }),
    buildWorkflowPromptFieldGuidance({
      fieldName: 'motionPrompt',
      modelSelector: 'motionModel',
      medium: 'motion',
      scenario: 'motion.transfer',
      modelIds: ['kling-2.6', 'kling-3.0'],
      context: plannerContext,
    }),
    'Keep the strategy concise and practical. Optimize for conversion and creator-style execution.',
  ].join('\n');
}

export function buildWorkflowUserPrompt(input: WorkflowPlannerInput): string {
  return [
    `Brand: ${input.brandName || 'Unknown brand'}`,
    `Product: ${input.productName}`,
    `Audience: ${input.audience}`,
    `Objective: ${input.objective}`,
    `Primary message: ${input.primaryMessage}`,
    `Offer: ${input.offer}`,
    `CTA: ${input.callToAction}`,
    `Tone: ${input.tone}`,
    `Visual style: ${input.visualStyle}`,
    `Aspect ratio: ${input.aspectRatio}`,
    `Target duration: ${input.durationSeconds}s`,
    `Platform: ${input.platform}`,
    `Additional notes: ${input.notes || 'None'}`,
  ].join('\n');
}

export function buildImageLaunchUrl(prompt: string, model = 'nano-banana-pro', aspectRatio = '9:16'): string {
  const params = new URLSearchParams({ prompt, model, aspectRatio });
  return `/create-image?${params.toString()}`;
}

export function buildVideoLaunchUrl(prompt: string, model = 'kling-3.0-video', aspectRatio = '9:16', duration = '5'): string {
  const params = new URLSearchParams({ prompt, model, aspectRatio, duration });
  return `/create-video?${params.toString()}`;
}

export function buildMotionLaunchUrl(prompt: string, model = 'kling-3.0'): string {
  const params = new URLSearchParams({ prompt, model });
  return `/create-motion?${params.toString()}`;
}

export function createWorkflowGraphFromBlueprint(
  blueprint: WorkflowBlueprint,
  aspectRatio: WorkflowAspectRatio = '9:16'
): WorkflowCanvasGraph {
  const nodes: WorkflowCanvasNode[] = [];
  const edges: WorkflowCanvasEdge[] = [];

  const briefNode = createWorkflowNode('note', { x: 80, y: 80 });
  const voiceoverPromptNode = createWorkflowNode('text-input', { x: 80, y: 500 });
  const voiceoverNode = createWorkflowNode('voiceover-generate', { x: 360, y: 500 });

  nodes.push({
    ...briefNode,
    data: normalizeNodeData('note', {
      ...(briefNode.data as NoteNodeData),
      title: 'Creative brief',
      subtitle: 'Blueprint summary',
      text: formatBlueprintBrief(blueprint),
    }),
  });

  nodes.push({
    ...voiceoverPromptNode,
    data: normalizeNodeData('text-input', {
      ...(voiceoverPromptNode.data as TextInputNodeData),
      title: 'Voiceover script',
      subtitle: 'Narration prompt',
      text: blueprint.voiceover,
    }),
  });

  nodes.push({
    ...voiceoverNode,
    data: normalizeNodeData('voiceover-generate', {
      ...(voiceoverNode.data as VoiceoverGenerateNodeData),
      title: 'Voiceover',
      subtitle: 'Narration track',
      model: 'text-to-speech-turbo-2-5',
      voice: 'Rachel',
      languageCode: 'en',
    }),
  });

  edges.push(createCanvasEdge(voiceoverPromptNode.id, 'text', voiceoverNode.id, 'prompt'));

  blueprint.shots.forEach((shot, index) => {
    const baseX = 720 + (index * 540);
    const imagePromptNode = createWorkflowNode('text-input', { x: baseX, y: 100 });
    const imageNode = createWorkflowNode('image-generate', { x: baseX + 270, y: 100 });
    const videoPromptNode = createWorkflowNode('text-input', { x: baseX, y: 360 });
    const videoNode = createWorkflowNode('video-generate', { x: baseX + 270, y: 360 });
    const motionPromptNode = createWorkflowNode('text-input', { x: baseX, y: 620 });
    const motionNode = createWorkflowNode('motion-generate', { x: baseX + 270, y: 620 });

    nodes.push({
      ...imagePromptNode,
      data: normalizeNodeData('text-input', {
        ...(imagePromptNode.data as TextInputNodeData),
        title: `Shot ${index + 1} still prompt`,
        subtitle: shot.title,
        text: formatStillPrompt(shot, index),
      }),
    });

    nodes.push({
      ...imageNode,
      data: normalizeNodeData('image-generate', {
        ...(imageNode.data as ImageGenerateNodeData),
        title: `Shot ${index + 1} still`,
        subtitle: shot.title,
        model: blueprint.deliveryPlan.stillImageModel,
        aspectRatio,
        resolution: '1K',
        outputFormat: 'jpg',
      }),
    });

    nodes.push({
      ...videoPromptNode,
      data: normalizeNodeData('text-input', {
        ...(videoPromptNode.data as TextInputNodeData),
        title: `Shot ${index + 1} video prompt`,
        subtitle: shot.title,
        text: formatVideoPrompt(shot, index),
      }),
    });

    nodes.push({
      ...videoNode,
      data: normalizeNodeData('video-generate', {
        ...(videoNode.data as VideoGenerateNodeData),
        title: `Shot ${index + 1} video`,
        subtitle: shot.title,
        model: blueprint.deliveryPlan.primaryModel,
        aspectRatio,
        duration: clampVideoDuration(blueprint.deliveryPlan.primaryModel, shot.duration),
        mode: getBlueprintVideoMode(blueprint.deliveryPlan.primaryModel),
        sound: false,
        resolution: blueprint.deliveryPlan.primaryModel === 'seedance-1.5-pro' ? '720p' : '720p',
        fixedLens: false,
      }),
    });

    nodes.push({
      ...motionPromptNode,
      data: normalizeNodeData('text-input', {
        ...(motionPromptNode.data as TextInputNodeData),
        title: `Shot ${index + 1} motion prompt`,
        subtitle: shot.title,
        text: formatMotionPrompt(shot, index),
      }),
    });

    nodes.push({
      ...motionNode,
      data: normalizeNodeData('motion-generate', {
        ...(motionNode.data as MotionGenerateNodeData),
        title: `Shot ${index + 1} motion`,
        subtitle: shot.title,
        model: blueprint.deliveryPlan.motionModel,
        mode: '720p',
        characterOrientation: 'video',
      }),
    });

    edges.push(
      createCanvasEdge(imagePromptNode.id, 'text', imageNode.id, 'prompt'),
      createCanvasEdge(videoPromptNode.id, 'text', videoNode.id, 'prompt'),
      createCanvasEdge(imageNode.id, 'image', videoNode.id, 'reference-image'),
      createCanvasEdge(motionPromptNode.id, 'text', motionNode.id, 'prompt'),
      createCanvasEdge(imageNode.id, 'image', motionNode.id, 'reference-image'),
      createCanvasEdge(videoNode.id, 'video', motionNode.id, 'reference-video')
    );
  });

  const zoom = Math.max(0.36, DEFAULT_VIEWPORT.zoom - Math.max(0, blueprint.shots.length - 1) * 0.08);

  return normalizeWorkflowGraph({
    viewport: {
      ...DEFAULT_VIEWPORT,
      zoom,
    },
    nodes,
    edges,
  });
}

function formatBlueprintBrief(blueprint: WorkflowBlueprint): string {
  return [
    `Workflow: ${blueprint.title}`,
    '',
    `Creative strategy: ${blueprint.creativeStrategy}`,
    `Hook: ${blueprint.hook}`,
    `Narrative: ${blueprint.narrative}`,
    '',
    'Editing notes:',
    ...blueprint.editingNotes.map((note) => `- ${note}`),
    '',
    'Asset checklist:',
    ...blueprint.assetChecklist.map((asset) => `- ${asset}`),
    '',
    'Recommended sequence:',
    ...blueprint.deliveryPlan.recommendedSequence.map((step, index) => `${index + 1}. ${step}`),
  ].join('\n');
}

function formatStillPrompt(shot: WorkflowShot, index: number): string {
  return [
    `Build the hero still for shot ${index + 1}: ${shot.title}.`,
    `Purpose: ${shot.purpose}`,
    `Beat: ${shot.beat}`,
    '',
    `Prompt: ${shot.visualPrompt}`,
  ].join('\n');
}

function formatVideoPrompt(shot: WorkflowShot, index: number): string {
  return [
    `Create the main video clip for shot ${index + 1}: ${shot.title}.`,
    `Purpose: ${shot.purpose}`,
    `Beat: ${shot.beat}`,
    `Target duration: ${shot.duration}s`,
    '',
    `Prompt: ${shot.videoPrompt}`,
  ].join('\n');
}

function formatMotionPrompt(shot: WorkflowShot, index: number): string {
  return [
    `Create the motion-transfer pass for shot ${index + 1}: ${shot.title}.`,
    `Purpose: ${shot.purpose}`,
    `Beat: ${shot.beat}`,
    '',
    `Prompt: ${shot.motionPrompt}`,
  ].join('\n');
}

function getBlueprintVideoMode(model: WorkflowBlueprint['deliveryPlan']['primaryModel']): string {
  if (model === 'veo-3.1') {
    return 'veo3_fast';
  }

  if (model === 'grok-imagine-video') {
    return 'normal';
  }

  if (model === 'kling-3.0-video') {
    return 'std';
  }

  return 'std';
}
