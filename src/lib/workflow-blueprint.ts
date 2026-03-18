export type WorkflowAspectRatio = '9:16' | '16:9' | '1:1';
export type WorkflowObjective = 'ugc-ad' | 'product-video' | 'social-campaign';

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

export interface WorkflowShot {
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
    primaryModel: string;
    stillImageModel: string;
    motionModel: string;
    recommendedSequence: string[];
  };
}

export const WORKFLOW_BLUEPRINT_COST = 6;

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
      primaryModel: typeof candidate?.deliveryPlan?.primaryModel === 'string' && candidate.deliveryPlan.primaryModel.trim() ? candidate.deliveryPlan.primaryModel : DEFAULT_BLUEPRINT.deliveryPlan.primaryModel,
      stillImageModel: typeof candidate?.deliveryPlan?.stillImageModel === 'string' && candidate.deliveryPlan.stillImageModel.trim() ? candidate.deliveryPlan.stillImageModel : DEFAULT_BLUEPRINT.deliveryPlan.stillImageModel,
      motionModel: typeof candidate?.deliveryPlan?.motionModel === 'string' && candidate.deliveryPlan.motionModel.trim() ? candidate.deliveryPlan.motionModel : DEFAULT_BLUEPRINT.deliveryPlan.motionModel,
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
  return [
    'You are an expert creative strategist building a production-ready AI generation workflow for short-form ads and videos.',
    'Return valid JSON only. No markdown. No commentary.',
    'The JSON schema is: {"title":string,"creativeStrategy":string,"hook":string,"narrative":string,"voiceover":string,"editingNotes":string[],"assetChecklist":string[],"shots":[{"id":string,"title":string,"purpose":string,"beat":string,"visualPrompt":string,"videoPrompt":string,"motionPrompt":string,"duration":number}],"deliveryPlan":{"primaryModel":string,"stillImageModel":string,"motionModel":string,"recommendedSequence":string[]}}.',
    'Use the existing models only: stillImageModel must be nano-banana-2 or nano-banana-pro; primaryModel must be kling-3.0-video, seedance-1.5-pro, or veo-3.1; motionModel must be kling-2.6 or kling-3.0.',
    `Plan for a ${input.durationSeconds}-second ${input.objective} in ${input.aspectRatio} for ${input.platform}.`,
    'Generate 3 to 6 shots. Each prompt should be directly usable in an AI generation UI and must stay commercially focused.',
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
