import type {
  EnhancerContext,
  Medium,
  PromptScenario,
} from '@/lib/prompt-enhancer';

export interface PromptEnhancerFixture {
  name: string;
  medium: Medium;
  selectedModel: string;
  context?: EnhancerContext;
  expectedScenario: PromptScenario;
  expectedIncludes: string[];
  expectedExcludes?: string[];
}

export const PROMPT_ENHANCER_FIXTURES: PromptEnhancerFixture[] = [
  {
    name: 'image text to image',
    medium: 'image',
    selectedModel: 'nano-banana-2',
    context: { aspectRatio: '9:16' },
    expectedScenario: 'image.text_to_image',
    expectedIncludes: [
      'Target model: Nano Banana 2',
      'Prompt scenario: image.text_to_image',
      'Planner mode: structured-image',
      'Aspect ratio: 9:16',
    ],
  },
  {
    name: 'image reference guided',
    medium: 'image',
    selectedModel: 'nano-banana-pro',
    context: { referenceImageCount: 2, resolution: '2K' },
    expectedScenario: 'image.reference_guided',
    expectedIncludes: [
      'Prompt scenario: image.reference_guided',
      'Planner mode: structured-image',
      'Reference images attached: 2',
      'Treat Nano Banana Pro like a higher-fidelity commercial image model with stronger layout, branding, and text rendering capability',
    ],
  },
  {
    name: 'video text to video single',
    medium: 'video',
    selectedModel: 'veo-3.1',
    context: { duration: 8, aspectRatio: '16:9' },
    expectedScenario: 'video.text_to_video_single',
    expectedIncludes: [
      'Prompt scenario: video.text_to_video_single',
      'Planner mode: structured-video',
      'Treat Veo 3.1 like a one-scene-per-clip model',
      'Duration: 8s',
    ],
  },
  {
    name: 'video start frame',
    medium: 'video',
    selectedModel: 'veo-3.1',
    context: { hasStartImage: true, duration: 8 },
    expectedScenario: 'video.image_to_video_start_frame',
    expectedIncludes: [
      'Prompt scenario: video.image_to_video_start_frame',
      'Starting frame or reference image is attached',
      'Planner mode: structured-video',
      'describe only the dynamics — subject motion, camera movement, timing, and environmental change',
      'Remove every static description the frame already provides',
    ],
  },
  {
    name: 'video start and end frame',
    medium: 'video',
    selectedModel: 'seedance-1.5-pro',
    context: { hasStartImage: true, hasEndImage: true, sound: true, duration: 4 },
    expectedScenario: 'video.image_to_video_start_end',
    expectedIncludes: [
      'Prompt scenario: video.image_to_video_start_end',
      'Ending frame is attached',
      'Sound: enabled',
      'Planner mode: structured-video',
      'Treat Seedance 1.5 Pro like a layered video prompt model',
    ],
  },
  {
    name: 'video seedance 2 references',
    medium: 'video',
    selectedModel: 'seedance-2',
    context: { referenceImageCount: 1, hasReferenceVideo: true, sound: true, duration: 12 },
    expectedScenario: 'video.text_to_video_single',
    expectedIncludes: [
      'Target model: Seedance 2',
      'Prompt scenario: video.text_to_video_single',
      'Planner mode: structured-video',
      'Reference images attached: 1',
      'Reference video is attached',
      'Treat Seedance 2 like a reference-driven video model',
    ],
  },
  {
    name: 'video seedance 2 fast references',
    medium: 'video',
    selectedModel: 'seedance-2-fast',
    context: { referenceImageCount: 2, duration: 8 },
    expectedScenario: 'video.text_to_video_single',
    expectedIncludes: [
      'Target model: Seedance 2 Fast',
      'Prompt scenario: video.text_to_video_single',
      'Planner mode: structured-video',
      'Reference images attached: 2',
      'Treat Seedance 2 Fast like a speed-oriented reference-driven model',
    ],
  },
  {
    name: 'video multi shot',
    medium: 'video',
    selectedModel: 'kling-3.0/video',
    context: { isMultiShot: true, shotCount: 3, shotIndex: 1, duration: 4 },
    expectedScenario: 'video.text_to_video_multi_shot',
    expectedIncludes: [
      'Prompt scenario: video.text_to_video_multi_shot',
      'Total shots in sequence: 3',
      'Current shot index: 2',
      'Planner mode: structured-video',
      'Treat Kling 3.0 like a cinematic shot engine',
    ],
  },
  {
    name: 'motion transfer',
    medium: 'motion',
    selectedModel: 'kling-3.0',
    context: { hasReferenceVideo: true, characterOrientation: 'video' },
    expectedScenario: 'motion.transfer',
    expectedIncludes: [
      'Prompt scenario: motion.transfer',
      'Planner mode: legacy-text',
      'Reference video is attached',
      'Do not invent or override the motion choreography that comes from the reference video',
      'Kling 3.0 motion control handles nuanced identity and scene polish well when the prompt stays focused on realism, environment, and subject integrity',
    ],
    expectedExcludes: ['describe the movement the character should perform'],
  },
];
