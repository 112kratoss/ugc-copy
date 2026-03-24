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
    expectedIncludes: ['Target model: Nano Banana 2', 'Prompt scenario: image.text_to_image', 'Aspect ratio: 9:16'],
  },
  {
    name: 'image reference guided',
    medium: 'image',
    selectedModel: 'nano-banana-pro',
    context: { referenceImageCount: 2, resolution: '2K' },
    expectedScenario: 'image.reference_guided',
    expectedIncludes: [
      'Prompt scenario: image.reference_guided',
      'Reference images attached: 2',
      'Nano Banana Pro can handle richer material, lighting, composition, and texture detail while staying photorealistic and controlled',
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
      'Veo 3.1 benefits from subject, action, context, camera, composition, and ambiance stated clearly in natural language',
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
      'Focus on how the scene should move: subject action, camera movement, timing, and environmental change while preserving the referenced look',
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
      'Seedance 1.5 Pro benefits from grounded cinematic prompts with clear action, camera intent, and duration-aware pacing',
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
      'Kling 3.0 video works best with one grounded clip, explicit camera behavior, believable motion, and a strong atmospheric direction',
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
      'Reference video is attached',
      'Do not invent or override the motion choreography that comes from the reference video',
      'Kling 3.0 motion control handles nuanced identity and scene polish well when the prompt stays focused on realism, environment, and subject integrity',
    ],
    expectedExcludes: ['describe the movement the character should perform'],
  },
];
