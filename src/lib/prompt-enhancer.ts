import { logBackendError } from '@/lib/backend-logger';

import {
  inspectPromptQuality,
  type PromptEnhancementWarning,
} from '@/lib/prompt-quality';
import {
  fetchWithProviderTimeout,
  PROVIDER_INTERACTIVE_REQUEST_TIMEOUT_MS,
} from '@/lib/provider-fetch';

export type Medium = 'image' | 'video' | 'motion';

type CreativeIntent = 'general' | 'ugc-ad' | 'product-video' | 'social-campaign';

export type PromptScenario =
  | 'image.text_to_image'
  | 'image.reference_guided'
  | 'video.text_to_video_single'
  | 'video.text_to_video_multi_shot'
  | 'video.image_to_video_start_frame'
  | 'video.image_to_video_start_end'
  | 'motion.transfer';

type PromptPlannerMode = 'legacy-text' | 'structured-image' | 'structured-video';

export interface EnhancerContext {
  modelId?: string;
  aspectRatio?: string;
  resolution?: string;
  googleSearch?: boolean;
  mode?: string;
  duration?: number;
  sound?: boolean;
  fixedLens?: boolean;
  shotIndex?: number;
  characterOrientation?: string;
  referenceImageCount?: number;
  isMultiShot?: boolean;
  shotCount?: number;
  hasStartImage?: boolean;
  hasEndImage?: boolean;
  hasReferenceVideo?: boolean;
  creativeIntent?: CreativeIntent;
  elementEnhancementMode?: 'append-only';
  elementReferences?: Array<{
    handle: string;
    displayName: string;
  }>;
}

interface ImagePromptSpec {
  subject: string;
  setting: string;
  composition: string;
  cameraFraming: string;
  lighting: string;
  materialDetail: string;
  readableText: {
    exactText: string;
    placement: string;
    treatment: string;
  } | null;
  referenceAnchors: string[];
  constraints: string[];
  finish: string;
}

interface VideoShotPlan {
  index: number;
  title: string;
  startState: string;
  actionBeat: string;
  endState: string;
  camera: string;
  transition: string;
}

interface VideoScenePlan {
  sceneGoal: string;
  subjectAction: string;
  environment: string;
  cameraMovement: string;
  continuityAnchors: string[];
  ambience: string;
  audioCue: string;
  pacing: string;
  dialogue: string;
  durationBudget: string;
  shots: VideoShotPlan[];
}

export interface PromptEnhancementArtifacts {
  playbookId: string;
  agentId: string;
  plannerMode: PromptPlannerMode;
  scenario: PromptScenario;
  plannerOutput: ImagePromptSpec | VideoScenePlan | string;
  compiledPrompt: string;
  warnings: PromptEnhancementWarning[];
  qualityScore: number;
  appliedSafeguards: AppliedPromptEnhancementSafeguard[];
}

export interface AppliedPromptEnhancementSafeguard {
  code: string;
  message: string;
}

export interface PromptEnhancementAgent {
  id: string;
  label: string;
  modelIds: string[];
  providerModel: string;
  strategyRules: string[];
  defaultSafeguards: AppliedPromptEnhancementSafeguard[];
}

interface PromptStrategyOptions {
  medium: Medium;
  selectedModel: string;
  context?: EnhancerContext;
  scenario?: PromptScenario;
  includeExamples?: boolean;
  userPrompt?: string;
}

interface WorkflowFieldGuidanceOptions {
  fieldName: 'visualPrompt' | 'videoPrompt' | 'motionPrompt';
  modelSelector: 'stillImageModel' | 'primaryModel' | 'motionModel';
  medium: Medium;
  scenario: PromptScenario;
  modelIds: string[];
  context?: EnhancerContext;
  additionalRules?: string[];
}

interface PromptExample {
  raw: string;
  enhanced: string;
}

interface EnhancerPlaybook {
  modelId: string;
  label: string;
  medium: Medium;
  plannerMode: PromptPlannerMode;
  strategyRules: string[];
  workflowRules: string[];
  plannerNotes: string[];
}

export const PROMPT_ENHANCER_PROVIDER_MODEL = 'gemini-3-flash';

const PROMPT_ENHANCER_ENDPOINT = `https://api.kie.ai/${PROMPT_ENHANCER_PROVIDER_MODEL}/v1/chat/completions`;

export function getPromptEnhancementCost(): number {
  return 2;
}

const BASE_REWRITE_SYSTEM_PROMPT = `You are a prompt enhancement specialist for AI media generation.

Your job is to take the user's raw prompt and rewrite it into an optimized, production-quality prompt for the specific AI model and generation mode they are using.

Rules:
1. Preserve the user's original intent, subject matter, and any exact wording they explicitly require.
2. Do not add new subjects, themes, props, or story beats the user did not ask for.
3. Write in natural descriptive English, not keyword dumps.
4. Use clear, model-aware detail: subject, setting, composition, lighting, motion, pacing, and finish when relevant.
5. Prefer positive, precise constraints over long negative laundry lists unless the user explicitly asked for exclusions.
6. Output only a single polished prompt string with no commentary.
7. Keep the enhanced prompt concise but rich, usually 1 to 3 sentences.`;

const BASE_PLANNER_SYSTEM_PROMPT = `You are a prompt planning specialist for AI media generation.

Your job is to translate the user's request into a structured, model-specific plan that this app will compile into the final generation prompt.

Rules:
1. Preserve the user's original intent, subject matter, and exact requested text.
2. Do not add new subjects, props, scenes, or story beats the user did not ask for.
3. Stay model-aware: choose structure and detail that fit the target model and scenario.
4. Return valid JSON only using the exact schema provided. Do not wrap it in markdown.
5. If a detail is unknown, use an empty string, null, or an empty array instead of inventing it.
6. For readable text, preserve the exact requested words.
7. For short videos, keep each clip focused on one clear scene unless multi-shot guidance explicitly asks for a sequence.`;

const BASE_STRATEGY_RULES = [
  'Preserve the user intent exactly while making the prompt clearer, more specific, and easier for the target model to follow.',
  'Favor concrete nouns, observable actions, and precise visual or cinematic detail over vague adjectives.',
  'Keep the output directly usable in a generation UI without bullets, labels, or analysis.',
];

const MEDIUM_RULES: Record<Medium, string[]> = {
  image: [
    'Write for a still image, so describe subject, setting, composition, lighting, texture, and finish.',
    'Match framing and composition to the requested aspect ratio when relevant.',
  ],
  video: [
    'Write for a single coherent clip unless the scenario explicitly says multi-shot.',
    'Describe action, camera behavior, pacing, and atmosphere in a way that fits the available duration.',
  ],
  motion: [
    'Write for motion transfer, where a character image and reference video already provide the base performance inputs.',
    'Use the text prompt to guide identity preservation, realism, environment fit, and visual polish instead of inventing choreography.',
  ],
};

const SCENARIO_RULES: Record<PromptScenario, string[]> = {
  'image.text_to_image': [
    'Build the prompt around subject, context, composition, lighting, and finish in a natural sentence flow.',
  ],
  'image.reference_guided': [
    'Assume one or more reference images are attached and preserve identity, product design, palette, and other anchored visual traits.',
    'Use the prompt to steer pose, framing, environment, mood, and finish rather than re-describing every static trait from the references.',
  ],
  'video.text_to_video_single': [
    'Describe one self-contained clip with a clear start state, core action, camera behavior, and end beat.',
    'Avoid shot-list phrasing and keep the clip grounded in one scene.',
  ],
  'video.text_to_video_multi_shot': [
    'This prompt belongs to a larger multi-shot sequence, but each shot should still read as one self-contained scene.',
    'Give each shot a clear visual start, key action, and end state without relying on references to unseen shots.',
  ],
  'video.image_to_video_start_frame': [
    'Assume a starting reference frame is attached and do not re-describe every static detail from it.',
    'Focus on how the scene should move: subject action, camera movement, timing, and environmental change while preserving the referenced look.',
  ],
  'video.image_to_video_start_end': [
    'Assume starting and ending reference frames are attached and do not restate their fixed contents in detail.',
    'Focus on the motion path, transformation, continuity, and camera movement between those frames.',
  ],
  'motion.transfer': [
    'Assume a character image and a reference video drive the motion transfer.',
    'Do not invent or override the motion choreography that comes from the reference video.',
    'Use the prompt to reinforce identity preservation, environment fit, style, realism, and deformation avoidance.',
  ],
};

const INTENT_RULES: Record<CreativeIntent, string[]> = {
  general: [],
  'ugc-ad': [
    'Favor creator-led commercial realism, product clarity, believable environments, and a direct benefit or proof moment.',
    'Keep the result conversion-oriented without hype, spammy claims, or abstract art direction.',
  ],
  'product-video': [
    'Favor product clarity, tactile detail, practical use, and clean commercial framing.',
    'Make the subject and value proposition easy to understand at a glance.',
  ],
  'social-campaign': [
    'Favor scroll-stopping clarity, platform-native framing, and strong visual energy without losing realism.',
    'Keep the concept easy to parse quickly and friendly to short-form distribution.',
  ],
};

const SCENARIO_EXAMPLES: Record<PromptScenario, PromptExample> = {
  'image.text_to_image': {
    raw: 'founder holding a skincare bottle in a bright studio',
    enhanced:
      'A clean editorial still of a skincare founder holding a glass serum bottle in a bright daylight studio, framed at eye level with soft diffused window light, natural skin texture, crisp product visibility, and a polished commercial finish.',
  },
  'image.reference_guided': {
    raw: 'same creator outdoors with the product',
    enhanced:
      'Using the attached reference images to preserve the same creator identity and product details, place her outdoors on a sunlit city sidewalk holding the product at chest height, with natural movement in her pose, warm afternoon light, and premium lifestyle-ad realism.',
  },
  'video.text_to_video_single': {
    raw: 'creator notices the coffee frother and smiles',
    enhanced:
      'A creator in a modern kitchen notices the coffee frother on the counter, reaches for it with a genuine smile, and lifts it into frame as the camera makes a gentle push-in, with natural daylight, grounded movement, and upbeat social-ad energy.',
  },
  'video.text_to_video_multi_shot': {
    raw: 'unboxing shot',
    enhanced:
      'A tight tabletop unboxing shot where hands slide open the product box, reveal the hero item cleanly, and pause for a beat as the camera holds a steady premium close-up with crisp detail and polished commercial lighting.',
  },
  'video.image_to_video_start_frame': {
    raw: 'she lifts the serum and the camera slowly pushes in',
    enhanced:
      'Starting from the supplied frame, she lifts the serum toward camera with a natural smile while the camera slowly pushes in, keeping the existing identity and composition intact as the scene gains subtle motion, soft ambient life, and premium lifestyle-ad polish.',
  },
  'video.image_to_video_start_end': {
    raw: 'move from messy desk to clean finished setup',
    enhanced:
      'Transition smoothly from the supplied starting frame to the supplied ending frame as the desk is cleared and styled into a clean finished setup, with continuous camera motion, believable hand movement, and polished commercial continuity throughout.',
  },
  'motion.transfer': {
    raw: 'keep the astronaut realistic on mars',
    enhanced:
      'A hyperrealistic astronaut on the dusty red surface of Mars, with grounded body proportions, clean suit detail, dramatic low-angle sunlight, subtle airborne dust, and strong identity preservation with minimal distortion.',
  },
};

const TEXT_RENDERING_RULES: Record<string, string[]> = {
  'nano-banana-2-lite': [
    'If the user requests readable text, keep the exact words in quotes and avoid complex multi-block layouts.',
  ],
  'nano-banana-2': [
    'If the user requests readable text, keep the exact words in quotes and make the text treatment explicit but brief.',
  ],
  'nano-banana-pro': [
    'If the user requests readable text, keep the exact words in quotes and make the text treatment explicit but brief.',
  ],
  'gpt-image-2': [
    'If the user requests readable text, keep the exact words in quotes and describe the placement and hierarchy plainly.',
  ],
  'seedream-5-pro': [
    'If the user requests readable text, preserve the exact copy, language, placement, and visual hierarchy.',
  ],
  'flux-2-pro': [
    'If the user requests readable text, keep the exact words in quotes with direct placement and material guidance.',
  ],
  'z-image': [
    'If the user requests readable text, keep it short, exact, and limited to one clear placement.',
  ],
  'grok-imagine-image': [
    'If the user requests readable text, keep the exact words in quotes and keep the layout instruction direct.',
  ],
};

const GOOGLE_SEARCH_RULES = [
  'Because Google Search grounding is enabled, only lean on real-world specificity the user actually asked for.',
];

// Aliases double as the enhance endpoint's allowlist: SUPPORTED_ENHANCEMENT_MODELS is
// built from these keys, and prompt-enhancement-service rejects anything missing from it.
// Newer models borrow the closest existing playbook until they earn their own.
const MODEL_ALIASES: Record<string, string> = {
  'kling-3.0-video': 'kling-3.0/video',
  'grok-imagine-image-2': 'grok-imagine-image',
  'qwen3': 'seedream-5-pro',
  'qwen3-pro': 'seedream-5-pro',
  'ideogram-character': 'seedream-5-pro',
  'seedance-2-5': 'seedance-2',
  'kling-o3': 'kling-3.0/video',
  'minimax-h3': 'kling-3.0/video',
  // Registration audit 2026-08-16: these thirteen live models were absent from
  // every enhancer registry, so the enhance endpoint returned HTTP 400 for them.
  'seedream-5-lite': 'seedream-5-pro',
  'wan-2.7-image': 'seedream-5-pro',
  'wan-2.7-image-pro': 'seedream-5-pro',
  'imagen-4-fast': 'nano-banana-2',
  'imagen-4': 'nano-banana-2',
  'imagen-4-ultra': 'nano-banana-2',
  'ideogram-v3': 'seedream-5-pro',
  'kling-3.0-turbo': 'kling-3.0/video',
  'seedance-2-mini': 'seedance-2',
  'wan-2.7': 'seedance-2',
  'happyhorse-1.1': 'kling-3.0/video',
  'gemini-omni-video': 'seedance-2',
  'hailuo-2.3': 'kling-3.0/video',
};

const SEEDANCE_PLAYBOOK_MODEL_IDS = new Set([
  'seedance-1.5-pro',
  'seedance-2',
  'seedance-2-fast',
]);

const ENHANCER_PLAYBOOKS: Record<string, EnhancerPlaybook> = {
  'nano-banana-2-lite': {
    modelId: 'nano-banana-2-lite',
    label: 'Nano Banana 2 Lite',
    medium: 'image',
    plannerMode: 'structured-image',
    strategyRules: [
      'Treat Nano Banana 2 Lite as a fast draft and iteration model: center the prompt on one decisive visual idea.',
      'Keep composition, subject, and lighting explicit while avoiding dense modifier stacks.',
      'When references are attached, state only the traits that must remain consistent.',
    ],
    workflowRules: [
      'If stillImageModel is nano-banana-2-lite, use a concise prompt with one clear subject, composition, and finish.',
    ],
    plannerNotes: [
      'Optimize for fast visual exploration and clean 1K output.',
    ],
  },
  'nano-banana-2': {
    modelId: 'nano-banana-2',
    label: 'Nano Banana 2',
    medium: 'image',
    plannerMode: 'structured-image',
    strategyRules: [
      'Treat Nano Banana 2 like a clarity-first image model: keep the plan simple, concrete, and centered on one primary image idea.',
      'Favor short, high-signal visual direction over long modifier chains or abstract styling language.',
      'Use readable text only when the user asked for it, and keep the exact words explicit and brief.',
      'If reference images are present, list only the anchored traits that must stay fixed instead of re-describing the whole frame.',
    ],
    workflowRules: [
      'If stillImageModel is nano-banana-2, keep the prompt direct, visually clear, and centered on one strong image idea.',
      'If stillImageModel is nano-banana-2 and text is required, state the exact words plainly and keep the typography note brief.',
    ],
    plannerNotes: [
      'Use the plan to capture subject, setting, framing, lighting, and only the most important material or finish cues.',
      'Prefer one or two strong visual sentences once the app compiles the plan.',
    ],
  },
  'nano-banana-pro': {
    modelId: 'nano-banana-pro',
    label: 'Nano Banana Pro',
    medium: 'image',
    plannerMode: 'structured-image',
    strategyRules: [
      'Treat Nano Banana Pro like a higher-fidelity commercial image model with stronger layout, branding, and text rendering capability.',
      'Capture composition, materials, finish, and brand-safe reference anchors with more precision than Nano Banana 2.',
      'When readable text matters, preserve the exact copy and include placement and treatment so the final layout stays legible.',
      'If references are attached, prioritize identity, product design, packaging, and brand consistency over novel invention.',
    ],
    workflowRules: [
      'If stillImageModel is nano-banana-pro, write a richer prompt with precise composition, materials, finish, and commercial polish.',
      'If stillImageModel is nano-banana-pro and text matters, include the exact copy plus layout treatment so the image stays legible and brand-safe.',
    ],
    plannerNotes: [
      'Use the plan to structure premium layouts, poster-style compositions, and reference-led product work.',
      'The compiled prompt can be denser here, but it should still stay readable and directly usable.',
    ],
  },
  'gpt-image-2': {
    modelId: 'gpt-image-2',
    label: 'GPT Image 2',
    medium: 'image',
    plannerMode: 'structured-image',
    strategyRules: [
      'Treat GPT Image 2 like a high-instruction-following ChatGPT image model for polished stills and reference-led edits.',
      'Use clear natural language with specific subject, composition, lighting, and commercial intent.',
      'When references are attached, state what should be preserved and what should change instead of over-describing unrelated details.',
      'When readable text matters, include the exact copy plus placement and visual hierarchy.',
    ],
    workflowRules: [
      'If stillImageModel is gpt-image-2, write a clear ChatGPT-style image prompt with precise composition, reference preservation, and commercial polish.',
      'If stillImageModel is gpt-image-2 and text matters, include the exact copy plus placement and hierarchy so the result stays legible.',
    ],
    plannerNotes: [
      'Use the plan to capture the intended edit or generated still in direct, natural language.',
      'Favor concrete instructions over long modifier chains.',
    ],
  },
  'seedream-5-pro': {
    modelId: 'seedream-5-pro',
    label: 'Seedream 5 Pro',
    medium: 'image',
    plannerMode: 'structured-image',
    strategyRules: [
      'Treat Seedream 5 Pro as a production image model for realistic people, products, multilingual layouts, and precise edits.',
      'Specify composition, material behavior, lighting, skin or product texture, and information hierarchy when relevant.',
      'For edits, separate what must stay fixed from the exact local or material change requested.',
    ],
    workflowRules: [
      'If stillImageModel is seedream-5-pro, write a production-ready prompt with precise structure, realism, and reference preservation.',
    ],
    plannerNotes: [
      'Use richer structure for campaign assets, product graphics, portraits, and text-heavy layouts.',
    ],
  },
  'flux-2-pro': {
    modelId: 'flux-2-pro',
    label: 'FLUX.2 Pro',
    medium: 'image',
    plannerMode: 'structured-image',
    strategyRules: [
      'Treat FLUX.2 Pro as a photoreal commercial model with strong material detail and multi-reference consistency.',
      'Describe camera framing, lighting, surface behavior, and product identity with concrete language.',
      'For reference-led work, assign each reference a clear role and avoid contradictory transformations.',
    ],
    workflowRules: [
      'If stillImageModel is flux-2-pro, emphasize photoreal detail, controlled composition, and clear reference roles.',
    ],
    plannerNotes: [
      'Favor product photography, polished campaign stills, and consistent reference combinations.',
    ],
  },
  'z-image': {
    modelId: 'z-image',
    label: 'Z-Image',
    medium: 'image',
    plannerMode: 'structured-image',
    strategyRules: [
      'Treat Z-Image as a prompt-only economy model for rapid photoreal concepts and drafts.',
      'Keep the prompt self-contained because reference images are not available.',
      'Use one clear subject, setting, camera treatment, and lighting direction.',
    ],
    workflowRules: [
      'If stillImageModel is z-image, write a self-contained prompt with no dependency on reference images.',
    ],
    plannerNotes: [
      'Optimize for inexpensive exploration before moving a chosen concept to a reference-capable model.',
    ],
  },
  'grok-imagine-image': {
    modelId: 'grok-imagine-image',
    label: 'Grok Imagine',
    medium: 'image',
    plannerMode: 'structured-image',
    strategyRules: [
      'Treat Grok Imagine like a fast, multi-output image model: keep the core idea clear and visually decisive.',
      'For prompt-only runs, emphasize subject, frame, style, and one strong commercial hook.',
      'For edits, preserve the supplied reference identity and state the intended change plainly.',
      'When readable text matters, include the exact copy and simple placement guidance.',
    ],
    workflowRules: [
      'If stillImageModel is grok-imagine-image, write a direct image prompt with one strong visual idea and clear reference preservation.',
      'If stillImageModel is grok-imagine-image and text matters, include the exact copy plus simple placement guidance.',
    ],
    plannerNotes: [
      'Use the plan to keep the prompt vivid without overloading it.',
      'Prefer concrete scene direction over dense modifier stacks.',
    ],
  },
  'kling-3.0/video': {
    modelId: 'kling-3.0/video',
    label: 'Kling 3.0 Video',
    medium: 'video',
    plannerMode: 'structured-video',
    strategyRules: [
      'Treat Kling 3.0 like a cinematic shot engine: each clip should feel deliberate, atmospheric, and visually coherent.',
      'When multi-shot is active, maintain continuity anchors across the sequence while keeping the current shot self-contained.',
      'Use explicit shot design, camera behavior, and continuity instead of vague cinematic filler.',
      'If frames are attached, focus the plan on motion and scene evolution rather than repeating static frame content.',
    ],
    workflowRules: [
      'If primaryModel is kling-3.0-video, write cinematic shot prompts with clear camera direction, atmosphere, and continuity.',
      'If primaryModel is kling-3.0-video in multi-shot mode, make every shot stand on its own while preserving recurring subject and style anchors.',
    ],
    plannerNotes: [
      'For single-shot, keep the plan focused on one premium scene.',
      'For multi-shot with a current shot index, plan the sequence lightly but go deepest on the current shot.',
    ],
  },
  'seedance-1.5-pro': {
    modelId: 'seedance-1.5-pro',
    label: 'Seedance 1.5 Pro',
    medium: 'video',
    plannerMode: 'structured-video',
    strategyRules: [
      'Treat Seedance 1.5 Pro like a layered video prompt model: action, environment, camera, pacing, and optional audio should each be explicit.',
      'Use fixed-lens guidance when the camera must stay static and stable; otherwise describe camera motion deliberately.',
      'When audio is enabled, include only sound that materially supports the scene.',
      'If images are attached, use the plan to describe how the scene evolves from those references instead of restating them.',
    ],
    workflowRules: [
      'If primaryModel is seedance-1.5-pro, layer action, environment, camera intent, pacing, and optional audio explicitly.',
      'If primaryModel is seedance-1.5-pro and the camera should stay static, say so clearly instead of leaving camera behavior ambiguous.',
    ],
    plannerNotes: [
      'The final compiled prompt can be slightly more descriptive because Seedance responds well to layered scene instructions.',
      'Audio cues should only appear when sound is enabled.',
    ],
  },
  'seedance-2': {
    modelId: 'seedance-2',
    label: 'Seedance 2',
    medium: 'video',
    plannerMode: 'structured-video',
    strategyRules: [
      'Treat Seedance 2 like a reference-driven video model: keep the plan grounded in the attached image, video, and audio inputs instead of inventing new scene details.',
      'When reference videos are present, focus on motion continuity, pacing, and scene evolution rather than frame-by-frame narration.',
      'Use audio cues only when sound is enabled, and keep them tightly tied to the action.',
      'If the camera should feel locked, say so explicitly so the compiled prompt does not drift into unnecessary motion language.',
    ],
    workflowRules: [
      'If primaryModel is seedance-2, describe the reference-aware scene with explicit action, environment, camera intent, pacing, and optional audio.',
      'If primaryModel is seedance-2 and the scene should stay visually anchored, call out the locked camera or reference continuity directly.',
    ],
    plannerNotes: [
      'Seedance 2 works best when the plan stays tied to the connected reference assets and the final action beat remains easy to follow.',
      'Mention audio cues only when the workflow has sound enabled.',
    ],
  },
  'seedance-2-fast': {
    modelId: 'seedance-2-fast',
    label: 'Seedance 2 Fast',
    medium: 'video',
    plannerMode: 'structured-video',
    strategyRules: [
      'Treat Seedance 2 Fast like a speed-oriented reference-driven model: keep the plan concise, concrete, and anchored to the connected media.',
      'Favor one clean scene with strong motion continuity over dense camera language or layered scene concepts.',
      'When reference videos are present, preserve the motion beat and timing instead of re-describing the same visuals in long form.',
      'Keep sound cues short and functional when audio is enabled.',
    ],
    workflowRules: [
      'If primaryModel is seedance-2-fast, keep the prompt short, reference-aware, and focused on one clear action beat.',
      'If primaryModel is seedance-2-fast and the scene should not drift, state the camera intent and continuity anchor plainly.',
    ],
    plannerNotes: [
      'Seedance 2 Fast prefers compact instructions with just enough detail to preserve the reference assets and the intended motion.',
      'Do not over-explain the scene when a few strong references already establish the look.',
    ],
  },
  'veo-3.1': {
    modelId: 'veo-3.1',
    label: 'Veo 3.1',
    medium: 'video',
    plannerMode: 'structured-video',
    strategyRules: [
      'Treat Veo 3.1 like a one-scene-per-clip model: do not chain multiple distinct events into one short prompt.',
      'Bias toward a clean subject-action-context-camera-ambience structure for every clip.',
      'Avoid quotation marks for dialogue in the final prompt. If speech is needed, structure it as Character says: line.',
      'If continuity matters across shots, repeat only the necessary recurring character or product anchors.',
    ],
    workflowRules: [
      'If primaryModel is veo-3.1, keep every clip focused on one scene with explicit subject, action, context, camera, and ambience.',
      'If primaryModel is veo-3.1 and dialogue matters, describe it without quoted speech so the model does not try to render on-screen text.',
    ],
    plannerNotes: [
      'For multi-shot, the planner may produce a shot list, but the final compiled prompt should only emit the current shot unless no shot index is available.',
      'For image-to-video, emphasize motion between frames, not static frame redescription.',
    ],
  },
  'grok-imagine-video': {
    modelId: 'grok-imagine-video',
    label: 'Grok Imagine Video',
    medium: 'video',
    plannerMode: 'structured-video',
    strategyRules: [
      'Treat Grok Imagine Video like a concise single-clip model with fun, normal, and spicy modes.',
      'Use one clean action beat, clear subject continuity, camera movement, and atmosphere.',
      'For image-to-video, let the image define appearance and focus on motion, expression, camera path, and environmental life.',
      'Avoid multi-shot structure because Grok video runs as one clip.',
    ],
    workflowRules: [
      'If primaryModel is grok-imagine-video, write one concise video prompt with subject, action, camera, mood, and continuity.',
      'If primaryModel is grok-imagine-video with an image reference, focus on how the still should animate instead of re-describing the whole image.',
    ],
    plannerNotes: [
      'Use the plan to keep motion achievable for the selected 6-30 second duration.',
      'Prefer one memorable beat over layered scene changes.',
    ],
  },
  'kling-2.6': {
    modelId: 'kling-2.6',
    label: 'Kling 2.6 Motion Control',
    medium: 'motion',
    plannerMode: 'legacy-text',
    strategyRules: [
      'Kling 2.6 motion control expects the reference video to govern the action, so keep the prompt centered on character identity, environment, and visual style.',
      'Use the prompt to reduce distortion and help the transferred performance feel grounded in the scene.',
    ],
    workflowRules: [
      'If motionModel is kling-2.6, keep the prompt focused on identity, environment fit, and deformation avoidance rather than new choreography.',
    ],
    plannerNotes: [],
  },
  'kling-3.0': {
    modelId: 'kling-3.0',
    label: 'Kling 3.0 Motion Control',
    medium: 'motion',
    plannerMode: 'legacy-text',
    strategyRules: [
      'Kling 3.0 motion control handles nuanced identity and scene polish well when the prompt stays focused on realism, environment, and subject integrity.',
      'Do not over-describe motion beats because the reference video already supplies them.',
    ],
    workflowRules: [
      'If motionModel is kling-3.0, keep the prompt focused on realism, subject integrity, and polished scene integration rather than new motion instructions.',
    ],
    plannerNotes: [],
  },
};

const DEFAULT_PROMPT_ENHANCEMENT_AGENT: PromptEnhancementAgent = {
  id: 'generic-media-enhancer',
  label: 'Generic media enhancer',
  modelIds: [],
  providerModel: PROMPT_ENHANCER_PROVIDER_MODEL,
  strategyRules: [
    'Rewrite only what improves clarity for the selected medium and model.',
    'Prefer positive, concrete direction over long negative prompt lists.',
    'Keep the final prompt editable and directly usable in the generation UI.',
  ],
  defaultSafeguards: [
    {
      code: 'preserve_user_intent',
      message: 'Preserve the user intent and exact required wording.',
    },
  ],
};

const PROMPT_ENHANCEMENT_AGENTS: Record<string, PromptEnhancementAgent> = {
  'kling-3.0/video': {
    id: 'kling-video-director',
    label: 'Kling video director',
    modelIds: ['kling-3.0/video', 'kling-3.0-video'],
    providerModel: PROMPT_ENHANCER_PROVIDER_MODEL,
    strategyRules: [
      'Build prompts as filmable shot directions: subject, precise motion, scene, camera/framing, lighting/atmosphere, and audio when sound is enabled.',
      'For image-to-video, let the frame carry appearance and focus the prompt on movement, camera path, and environmental motion.',
      'For multi-shot, keep each shot self-contained, duration-aware, and continuity-safe; avoid overloading short shots with multiple story beats.',
      'When sound is enabled, include speaker labels, tone, ambience, or effects only when they materially support the scene.',
    ],
    defaultSafeguards: [
      {
        code: 'duration_aware_motion',
        message: 'Keep Kling motion simple enough for the selected duration.',
      },
      {
        code: 'shot_continuity',
        message: 'Preserve recurring subject and scene anchors across Kling shots.',
      },
    ],
  },
  'seedance-1.5-pro': {
    id: 'seedance-15-layered-director',
    label: 'Seedance 1.5 layered director',
    modelIds: ['seedance-1.5-pro'],
    providerModel: PROMPT_ENHANCER_PROVIDER_MODEL,
    strategyRules: [
      'Layer action, environment, camera intent, pacing, and optional audio explicitly.',
      'If fixed lens is enabled, compile camera language as static or locked rather than drifting or handheld.',
      'For image-to-video, describe how the attached frame evolves instead of restating every visible trait.',
      'Use concise audio cues only when sound is enabled.',
    ],
    defaultSafeguards: [
      {
        code: 'fixed_lens_respected',
        message: 'Respect fixed-lens mode when it is enabled.',
      },
    ],
  },
  'seedance-2': {
    id: 'seedance-2-reference-director',
    label: 'Seedance 2 reference director',
    modelIds: ['seedance-2'],
    providerModel: PROMPT_ENHANCER_PROVIDER_MODEL,
    strategyRules: [
      'Treat attached image, video, and audio references as first-class generation controls.',
      'State how references should guide identity, product details, camera continuity, motion timing, or audio style.',
      'Avoid inventing unrelated visual details when references already establish the scene.',
      'Keep the final action beat easy to follow across 4 to 15 seconds.',
    ],
    defaultSafeguards: [
      {
        code: 'reference_grounding',
        message: 'Ground Seedance 2 prompts in the attached reference assets.',
      },
    ],
  },
  'seedance-2-fast': {
    id: 'seedance-2-fast-reference-director',
    label: 'Seedance 2 Fast reference director',
    modelIds: ['seedance-2-fast'],
    providerModel: PROMPT_ENHANCER_PROVIDER_MODEL,
    strategyRules: [
      'Keep prompts compact, concrete, and anchored to the attached references.',
      'Favor one clean action beat over dense camera language or layered story events.',
      'Preserve reference motion and timing when a reference video is attached.',
      'Use short functional audio cues when sound is enabled.',
    ],
    defaultSafeguards: [
      {
        code: 'compact_reference_prompt',
        message: 'Keep Seedance 2 Fast prompts compact and reference-aware.',
      },
    ],
  },
  'veo-3.1': {
    id: 'veo-31-director',
    label: 'Veo 3.1 director',
    modelIds: ['veo-3.1'],
    providerModel: PROMPT_ENHANCER_PROVIDER_MODEL,
    strategyRules: [
      'Use a director-style structure: cinematography, subject, action, context, style/ambience, and audio.',
      'Keep every short clip focused on one moment; split complex sequences instead of chaining many events.',
      'For first/last frames, describe the transition mechanics, continuity, and camera path between frames.',
      'Write dialogue as speaker-attributed lines without quotation marks to reduce accidental rendered text.',
    ],
    defaultSafeguards: [
      {
        code: 'one_scene_per_clip',
        message: 'Keep Veo prompts focused on one clear scene or transition.',
      },
      {
        code: 'dialogue_without_quotes',
        message: 'Avoid quoted dialogue in Veo prompts.',
      },
    ],
  },
  'grok-imagine-video': {
    id: 'grok-imagine-video-director',
    label: 'Grok Imagine video director',
    modelIds: ['grok-imagine-video'],
    providerModel: PROMPT_ENHANCER_PROVIDER_MODEL,
    strategyRules: [
      'Build prompts as one clear clip direction: subject, action, camera/framing, mood, and continuity.',
      'For image-to-video, let the attached image carry appearance and focus on motion, expression, camera path, and environmental movement.',
      'Keep the action achievable within the selected duration and avoid multi-shot sequencing.',
      'Respect the selected mode tone without adding unsafe or unrelated content.',
    ],
    defaultSafeguards: [
      {
        code: 'single_clip_focus',
        message: 'Keep Grok video prompts focused on one filmable clip.',
      },
    ],
  },
};

function normalizeModelId(selectedModel: string): string {
  return MODEL_ALIASES[selectedModel] ?? selectedModel;
}

export function resolvePromptEnhancementAgent(selectedModel: string): PromptEnhancementAgent {
  return PROMPT_ENHANCEMENT_AGENTS[normalizeModelId(selectedModel)]
    ?? DEFAULT_PROMPT_ENHANCEMENT_AGENT;
}

function getEnhancerPlaybook(selectedModel: string): EnhancerPlaybook | null {
  return ENHANCER_PLAYBOOKS[normalizeModelId(selectedModel)] ?? null;
}

function getCreativeIntent(context?: EnhancerContext): CreativeIntent {
  return context?.creativeIntent ?? 'general';
}

function getModelLabel(selectedModel: string): string {
  return getEnhancerPlaybook(selectedModel)?.label ?? selectedModel;
}

function getPlaybookStrategyRules(selectedModel: string): string[] {
  return getEnhancerPlaybook(selectedModel)?.strategyRules ?? [];
}

function getPlaybookWorkflowRules(selectedModel: string): string[] {
  return getEnhancerPlaybook(selectedModel)?.workflowRules ?? [];
}

function getPlaybookPlannerMode(selectedModel: string): PromptPlannerMode {
  return getEnhancerPlaybook(selectedModel)?.plannerMode ?? 'legacy-text';
}

function getAgentStrategyRules(selectedModel: string): string[] {
  return resolvePromptEnhancementAgent(selectedModel).strategyRules;
}

function buildRuleBlock(title: string, rules: string[]): string | null {
  if (rules.length === 0) {
    return null;
  }

  return [title, ...rules.map((rule) => `- ${rule}`)].join('\n');
}

function buildContextBlock(context?: EnhancerContext): string | null {
  if (!context) {
    return null;
  }

  const lines: string[] = ['Current generation settings:'];

  if (context.aspectRatio) lines.push(`- Aspect ratio: ${context.aspectRatio}`);
  if (context.resolution) lines.push(`- Resolution: ${context.resolution}`);
  if (context.mode) lines.push(`- Mode: ${context.mode}`);
  if (typeof context.duration === 'number') lines.push(`- Duration: ${context.duration}s`);
  if (typeof context.sound === 'boolean') lines.push(`- Sound: ${context.sound ? 'enabled' : 'disabled'}`);
  if (typeof context.fixedLens === 'boolean') lines.push(`- Fixed lens: ${context.fixedLens ? 'enabled' : 'disabled'}`);
  if (typeof context.referenceImageCount === 'number' && context.referenceImageCount > 0) {
    lines.push(`- Reference images attached: ${context.referenceImageCount}`);
  }
  if (Array.isArray(context.elementReferences) && context.elementReferences.length > 0) {
    lines.push(
      `- Named reference elements: ${context.elementReferences
        .map((element) => `${element.handle} (${element.displayName})`)
        .join(', ')}`
    );
    lines.push('- If the user prompt uses any @handles, preserve those exact @handles verbatim in the enhanced prompt');
    lines.push('- Do not rename, remove, paraphrase, or invent @handles');
  }
  if (context.elementEnhancementMode === 'append-only') {
    lines.push('- Element enhancement mode: append-only');
    lines.push('- Keep the user prompt text exactly intact as the opening sentence of the output');
    lines.push('- Do not paraphrase, reorder, shorten, or replace the original sentence');
    lines.push('- You may append at most one short extra sentence for visual polish such as framing, lighting, texture, or finish');
  }
  if (typeof context.isMultiShot === 'boolean') {
    lines.push(`- Multi-shot sequence: ${context.isMultiShot ? 'yes' : 'no'}`);
  }
  if (typeof context.shotCount === 'number' && context.shotCount > 0) {
    lines.push(`- Total shots in sequence: ${context.shotCount}`);
  }
  if (typeof context.shotIndex === 'number') {
    lines.push(`- Current shot index: ${context.shotIndex + 1}`);
  }
  if (context.hasStartImage) lines.push('- Starting frame or reference image is attached');
  if (context.hasEndImage) lines.push('- Ending frame is attached');
  if (context.hasReferenceVideo) lines.push('- Reference video is attached');
  if (context.characterOrientation) lines.push(`- Character orientation: ${context.characterOrientation}`);
  if (context.googleSearch) lines.push('- Google Search grounding is enabled');
  if (getCreativeIntent(context) !== 'general') {
    lines.push(`- Creative intent: ${getCreativeIntent(context)}`);
  }

  return lines.length > 1 ? lines.join('\n') : null;
}

function buildExampleBlock(scenario: PromptScenario): string {
  const example = SCENARIO_EXAMPLES[scenario];

  return [
    'Reference transformation example:',
    `Raw prompt: ${example.raw}`,
    `Enhanced prompt: ${example.enhanced}`,
    'Follow the same transformation pattern while preserving the user request.',
  ].join('\n');
}

function needsTextRenderingGuidance(userPrompt?: string): boolean {
  if (!userPrompt) {
    return false;
  }

  return /\b(text|caption|quote|sign|title|headline|label|logo|poster|banner|reads?)\b/i.test(userPrompt);
}

function cleanRule(rule: string): string {
  return rule.replace(/\.$/, '');
}

function summarizeRules(rules: string[], limit = 3): string {
  const summary = rules
    .slice(0, limit)
    .map(cleanRule)
    .join('; ');

  return summary ? `${summary}.` : 'Keep the prompt aligned with the chosen model.';
}

function formatPlannerMode(mode: PromptPlannerMode): string {
  if (mode === 'structured-image') {
    return 'structured-image';
  }
  if (mode === 'structured-video') {
    return 'structured-video';
  }
  return 'legacy-text';
}

export function resolvePromptScenario(
  medium: Medium,
  _selectedModel: string,
  context?: EnhancerContext
): PromptScenario {
  if (medium === 'image') {
    return (context?.referenceImageCount ?? 0) > 0 ? 'image.reference_guided' : 'image.text_to_image';
  }

  if (medium === 'video') {
    if (context?.isMultiShot) return 'video.text_to_video_multi_shot';
    if (context?.hasStartImage && context?.hasEndImage) return 'video.image_to_video_start_end';
    if (context?.hasStartImage) return 'video.image_to_video_start_frame';
    return 'video.text_to_video_single';
  }

  return 'motion.transfer';
}

export function buildPromptStrategyGuidance(options: PromptStrategyOptions): string {
  const scenario = options.scenario ?? resolvePromptScenario(options.medium, options.selectedModel, options.context);
  const intent = getCreativeIntent(options.context);
  const agent = resolvePromptEnhancementAgent(options.selectedModel);
  const textRules =
    options.medium === 'image' && needsTextRenderingGuidance(options.userPrompt)
      ? TEXT_RENDERING_RULES[normalizeModelId(options.selectedModel)] ?? []
      : [];
  const googleSearchRules =
    options.medium === 'image' && options.context?.googleSearch ? GOOGLE_SEARCH_RULES : [];
  const sections = [
    `Target model: ${getModelLabel(options.selectedModel)}`,
    `Enhancement agent: ${agent.label} (${agent.id})`,
    `Prompt scenario: ${scenario}`,
    `Planner mode: ${formatPlannerMode(getPlaybookPlannerMode(options.selectedModel))}`,
    buildRuleBlock('Core strategy:', BASE_STRATEGY_RULES),
    buildRuleBlock('Medium guidance:', MEDIUM_RULES[options.medium]),
    buildRuleBlock('Scenario guidance:', SCENARIO_RULES[scenario]),
    buildRuleBlock('Model playbook guidance:', getPlaybookStrategyRules(options.selectedModel)),
    buildRuleBlock('Agent guidance:', getAgentStrategyRules(options.selectedModel)),
    buildRuleBlock('Text rendering guidance:', textRules),
    buildRuleBlock('Google Search guidance:', googleSearchRules),
    buildRuleBlock('Intent guidance:', INTENT_RULES[intent]),
    buildContextBlock(options.context),
    options.includeExamples ? buildExampleBlock(scenario) : null,
  ].filter((section): section is string => Boolean(section));

  return sections.join('\n\n');
}

export function buildWorkflowPromptFieldGuidance(options: WorkflowFieldGuidanceOptions): string {
  const intent = getCreativeIntent(options.context);
  const sharedRules = [
    options.fieldName === 'visualPrompt'
      ? 'Write visualPrompt as a directly usable still-image prompt string.'
      : options.fieldName === 'videoPrompt'
        ? 'Write videoPrompt as a directly usable video prompt string.'
        : 'Write motionPrompt as a directly usable motion-transfer prompt string.',
    'Keep each prompt concise, natural-language, and directly usable in a generation UI.',
    ...(options.additionalRules ?? []),
    ...INTENT_RULES[intent],
  ];

  const modelSpecificRules = options.modelIds.map((modelId) => {
    const summary = summarizeRules([
      ...SCENARIO_RULES[options.scenario],
      ...getPlaybookWorkflowRules(modelId),
    ]);

    return `- If ${options.modelSelector} is ${modelId}, ${summary}`;
  });

  return [
    `${options.fieldName} guidance:`,
    ...sharedRules.map((rule) => `- ${rule}`),
    ...modelSpecificRules,
  ].join('\n');
}

function buildImagePlannerSchemaBlock(): string {
  return [
    'Return JSON only using this ImagePromptSpec schema:',
    '{"subject":"","setting":"","composition":"","cameraFraming":"","lighting":"","materialDetail":"","readableText":null,"referenceAnchors":[],"constraints":[],"finish":""}',
    'Set readableText to null when the user did not request readable text. Otherwise use {"exactText":"","placement":"","treatment":""}.',
  ].join('\n');
}

function buildVideoPlannerSchemaBlock(context?: EnhancerContext): string {
  const sequenceGuidance = context?.isMultiShot
    ? typeof context.shotIndex === 'number'
      ? `Multi-shot is active. Build the sequence context lightly, but make shot ${context.shotIndex + 1} the most detailed shot in the shots array.`
      : 'Multi-shot is active. Return an ordered shots array that can map to the full sequence.'
    : 'Single-shot is active. Keep the plan focused on one clip and use at most one detailed shot entry.';

  return [
    'Return JSON only using this VideoScenePlan schema:',
    '{"sceneGoal":"","subjectAction":"","environment":"","cameraMovement":"","continuityAnchors":[],"ambience":"","audioCue":"","pacing":"","dialogue":"","durationBudget":"","shots":[{"index":1,"title":"","startState":"","actionBeat":"","endState":"","camera":"","transition":""}]}',
    sequenceGuidance,
    'Use 1-based shot indexes when you fill the shots array.',
  ].join('\n');
}

function buildPlannerTaskBlock(playbook: EnhancerPlaybook, scenario: PromptScenario, context?: EnhancerContext): string {
  if (playbook.plannerMode === 'structured-image') {
    return [
      `Planner task: Build an ImagePromptSpec for ${playbook.label} in the ${scenario} scenario.`,
      'The app will compile your JSON into the final prompt, so do not write the final prompt yourself.',
      ...playbook.plannerNotes.map((note) => `- ${note}`),
      buildImagePlannerSchemaBlock(),
    ].join('\n');
  }

  if (playbook.plannerMode === 'structured-video') {
    return [
      `Planner task: Build a VideoScenePlan for ${playbook.label} in the ${scenario} scenario.`,
      'The app will compile your JSON into the final prompt, so do not write the final prompt yourself.',
      ...playbook.plannerNotes.map((note) => `- ${note}`),
      buildVideoPlannerSchemaBlock(context),
    ].join('\n');
  }

  return 'Write the final prompt string directly.';
}

export function buildEnhancerSystemPrompt(
  medium: Medium,
  selectedModel: string,
  context?: EnhancerContext,
  userPrompt?: string
): string {
  const playbook = getEnhancerPlaybook(selectedModel);
  const scenario = resolvePromptScenario(medium, selectedModel, context);

  if (!playbook) {
    return [
      BASE_REWRITE_SYSTEM_PROMPT,
      buildPromptStrategyGuidance({
        medium,
        selectedModel,
        context,
        userPrompt,
        includeExamples: true,
      }),
    ].join('\n\n');
  }

  if (playbook.plannerMode === 'legacy-text') {
    return [
      BASE_REWRITE_SYSTEM_PROMPT,
      buildPromptStrategyGuidance({
        medium,
        selectedModel,
        context,
        userPrompt,
        includeExamples: true,
      }),
    ].join('\n\n');
  }

  return [
    BASE_PLANNER_SYSTEM_PROMPT,
    buildPromptStrategyGuidance({
      medium,
      selectedModel,
      context,
      userPrompt,
      includeExamples: true,
    }),
    buildPlannerTaskBlock(playbook, scenario, context),
  ].join('\n\n');
}

export function applyPromptEnhancementSafeguards(
  originalPrompt: string,
  enhancedPrompt: string,
  context?: EnhancerContext
): string {
  return applyPromptEnhancementSafeguardsWithMetadata(
    originalPrompt,
    enhancedPrompt,
    context
  ).enhancedPrompt;
}

export function applyPromptEnhancementSafeguardsWithMetadata(
  originalPrompt: string,
  enhancedPrompt: string,
  context?: EnhancerContext
): { enhancedPrompt: string; appliedSafeguards: AppliedPromptEnhancementSafeguard[] } {
  const trimmedOriginal = originalPrompt.trim();
  const trimmedEnhanced = enhancedPrompt.trim();

  if (!trimmedOriginal) {
    return { enhancedPrompt: trimmedEnhanced, appliedSafeguards: [] };
  }

  if (context?.elementEnhancementMode !== 'append-only') {
    const preservedPrompt = preserveNamedHandles(originalPrompt, enhancedPrompt, context);
    return {
      enhancedPrompt: preservedPrompt,
      appliedSafeguards: preservedPrompt === enhancedPrompt
        ? []
        : [{
          code: 'restored_named_handles',
          message: 'Restored missing named reference handles after enhancement.',
        }],
    };
  }

  const declaredHandles = new Set(
    (context?.elementReferences ?? [])
      .map((element) => element.handle)
      .filter((handle): handle is string => typeof handle === 'string' && handle.length > 0)
  );
  const originalHandles = extractPromptHandles(trimmedOriginal).filter((handle) => declaredHandles.has(handle));
  const enhancedHandles = new Set(extractPromptHandles(trimmedEnhanced));

  if (originalHandles.some((handle) => !enhancedHandles.has(handle))) {
    return {
      enhancedPrompt: trimmedOriginal,
      appliedSafeguards: [{
        code: 'append_only_handle_preserved',
        message: 'Reverted enhancement because it removed a locked named reference handle.',
      }],
    };
  }

  const normalizedOriginal = normalizeWhitespace(trimmedOriginal);
  const normalizedEnhanced = normalizeWhitespace(trimmedEnhanced);

  if (!normalizedEnhanced.startsWith(normalizedOriginal)) {
    return {
      enhancedPrompt: trimmedOriginal,
      appliedSafeguards: [{
        code: 'append_only_opening_preserved',
        message: 'Reverted enhancement because it changed the locked prompt opening.',
      }],
    };
  }

  return { enhancedPrompt: trimmedEnhanced, appliedSafeguards: [] };
}

function preserveNamedHandles(
  originalPrompt: string,
  enhancedPrompt: string,
  context?: EnhancerContext
): string {
  const declaredHandles = new Set(
    (context?.elementReferences ?? [])
      .map((element) => element.handle)
      .filter((handle): handle is string => typeof handle === 'string' && handle.length > 0)
  );

  if (declaredHandles.size === 0) {
    return enhancedPrompt;
  }

  const originalHandles = extractPromptHandles(originalPrompt).filter((handle) => declaredHandles.has(handle));
  if (originalHandles.length === 0) {
    return enhancedPrompt;
  }

  const enhancedHandles = new Set(extractPromptHandles(enhancedPrompt));
  const missingHandles = originalHandles.filter((handle) => !enhancedHandles.has(handle));

  if (missingHandles.length === 0) {
    return enhancedPrompt;
  }

  const restoredHandles = missingHandles.join(', ');
  return `${enhancedPrompt.trim()} Preserve the named reference elements ${restoredHandles} exactly as referenced.`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeText(value: string): string {
  return normalizeWhitespace(value).replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, '');
}

function ensureSentence(value: string): string {
  const trimmed = normalizeText(value);
  if (!trimmed) {
    return '';
  }

  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function sentenceFromParts(parts: Array<string | null | undefined>, separator = ', '): string {
  const cleaned = parts
    .map((part) => normalizeText(part ?? ''))
    .filter((part) => part.length > 0);

  return ensureSentence(cleaned.join(separator));
}

function joinPromptSentences(sentences: Array<string | null | undefined>): string {
  return sentences
    .map((sentence) => normalizeWhitespace(sentence ?? ''))
    .filter((sentence) => sentence.length > 0)
    .join(' ');
}

function quoteExactText(text: string): string {
  const trimmed = normalizeText(text);
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed;
  }

  return `"${trimmed.replace(/^"+|"+$/g, '')}"`;
}

function listWithAnd(values: string[]): string {
  const cleaned = values.map((value) => normalizeText(value)).filter((value) => value.length > 0);

  if (cleaned.length === 0) {
    return '';
  }

  if (cleaned.length === 1) {
    return cleaned[0];
  }

  if (cleaned.length === 2) {
    return `${cleaned[0]} and ${cleaned[1]}`;
  }

  return `${cleaned.slice(0, -1).join(', ')}, and ${cleaned.at(-1)}`;
}

function buildReferenceSentence(referenceAnchors: string[]): string {
  if (referenceAnchors.length === 0) {
    return '';
  }

  return ensureSentence(`Preserve ${listWithAnd(referenceAnchors)}`);
}

function buildReadableTextSentence(
  readableText: ImagePromptSpec['readableText'],
  detailLevel: 'brief' | 'rich'
): string {
  if (!readableText || !normalizeText(readableText.exactText)) {
    return '';
  }

  const exactText = quoteExactText(readableText.exactText);
  const placement = normalizeText(readableText.placement);
  const treatment = normalizeText(readableText.treatment);

  if (detailLevel === 'brief') {
    return sentenceFromParts([
      `Include readable text ${exactText}`,
      placement ? `placed ${placement}` : '',
      treatment ? treatment : '',
    ]);
  }

  return sentenceFromParts([
    `Include readable text ${exactText}`,
    placement ? `placed ${placement}` : '',
    treatment ? `with ${treatment}` : '',
  ]);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? normalizeWhitespace(value) : '';
}

function normalizeStringArray(value: unknown, limit = 8): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of value) {
    const normalized = normalizeString(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractJsonString(rawOutput: string): string | null {
  const fencedMatch = rawOutput.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1] ?? rawOutput;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');

  if (start === -1 || end === -1 || start >= end) {
    return null;
  }

  return candidate.slice(start, end + 1);
}

function parseStructuredOutput(rawOutput: string): Record<string, unknown> | null {
  const jsonString = extractJsonString(rawOutput);
  if (!jsonString) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonString) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeImagePromptSpec(
  plannerOutput: Record<string, unknown>,
  userPrompt: string
): ImagePromptSpec {
  const readableTextCandidate = plannerOutput.readableText;
  const readableText = isRecord(readableTextCandidate)
    ? {
      exactText: normalizeString(readableTextCandidate.exactText),
      placement: normalizeString(readableTextCandidate.placement),
      treatment: normalizeString(readableTextCandidate.treatment),
    }
    : null;

  const normalizedReadableText = readableText
    && (readableText.exactText || readableText.placement || readableText.treatment)
    ? readableText
    : null;

  return {
    subject: normalizeString(plannerOutput.subject) || normalizeWhitespace(userPrompt),
    setting: normalizeString(plannerOutput.setting),
    composition: normalizeString(plannerOutput.composition),
    cameraFraming: normalizeString(plannerOutput.cameraFraming),
    lighting: normalizeString(plannerOutput.lighting),
    materialDetail: normalizeString(plannerOutput.materialDetail),
    readableText: normalizedReadableText,
    referenceAnchors: normalizeStringArray(plannerOutput.referenceAnchors),
    constraints: normalizeStringArray(plannerOutput.constraints),
    finish: normalizeString(plannerOutput.finish),
  };
}

function normalizeVideoScenePlan(
  plannerOutput: Record<string, unknown>,
  userPrompt: string
): VideoScenePlan {
  const rawShots = Array.isArray(plannerOutput.shots) ? plannerOutput.shots : [];
  const shots = rawShots
    .map((shot, index) => {
      if (!isRecord(shot)) {
        return null;
      }

      const parsedIndex = typeof shot.index === 'number' && Number.isFinite(shot.index)
        ? Math.max(1, Math.round(shot.index))
        : index + 1;

      return {
        index: parsedIndex,
        title: normalizeString(shot.title),
        startState: normalizeString(shot.startState),
        actionBeat: normalizeString(shot.actionBeat),
        endState: normalizeString(shot.endState),
        camera: normalizeString(shot.camera),
        transition: normalizeString(shot.transition),
      } satisfies VideoShotPlan;
    })
    .filter((shot): shot is VideoShotPlan => Boolean(shot));

  const normalizedPlan: VideoScenePlan = {
    sceneGoal: normalizeString(plannerOutput.sceneGoal),
    subjectAction: normalizeString(plannerOutput.subjectAction) || normalizeWhitespace(userPrompt),
    environment: normalizeString(plannerOutput.environment),
    cameraMovement: normalizeString(plannerOutput.cameraMovement),
    continuityAnchors: normalizeStringArray(plannerOutput.continuityAnchors),
    ambience: normalizeString(plannerOutput.ambience),
    audioCue: normalizeString(plannerOutput.audioCue),
    pacing: normalizeString(plannerOutput.pacing),
    dialogue: normalizeString(plannerOutput.dialogue),
    durationBudget: normalizeString(plannerOutput.durationBudget),
    shots,
  };

  if (normalizedPlan.shots.length === 0) {
    normalizedPlan.shots = [{
      index: 1,
      title: '',
      startState: '',
      actionBeat: normalizedPlan.subjectAction,
      endState: '',
      camera: normalizedPlan.cameraMovement,
      transition: '',
    }];
  }

  return normalizedPlan;
}

function resolveVideoShot(plan: VideoScenePlan, context?: EnhancerContext): VideoShotPlan | null {
  if (plan.shots.length === 0) {
    return null;
  }

  if (typeof context?.shotIndex === 'number') {
    const oneBasedIndex = context.shotIndex + 1;
    return (
      plan.shots.find((shot) => shot.index === oneBasedIndex)
      ?? plan.shots[context.shotIndex]
      ?? plan.shots[0]
    );
  }

  return plan.shots[0];
}

function buildConstraintSentence(constraints: string[]): string {
  if (constraints.length === 0) {
    return '';
  }

  return ensureSentence(`Keep ${listWithAnd(constraints)}`);
}

function compileNanoBanana2Prompt(spec: ImagePromptSpec): string {
  const primarySentence = sentenceFromParts([
    spec.subject,
    spec.setting ? `in ${spec.setting}` : '',
    spec.composition,
    spec.cameraFraming,
    spec.lighting,
  ]);

  const detailSentence = sentenceFromParts([
    spec.materialDetail,
    spec.finish,
  ]);

  return joinPromptSentences([
    primarySentence,
    detailSentence,
    buildReferenceSentence(spec.referenceAnchors),
    buildReadableTextSentence(spec.readableText, 'brief'),
    buildConstraintSentence(spec.constraints),
  ]);
}

function compileNanoBananaProPrompt(spec: ImagePromptSpec): string {
  const compositionSentence = sentenceFromParts([
    spec.subject,
    spec.setting ? `in ${spec.setting}` : '',
    spec.composition,
    spec.cameraFraming,
  ]);

  const craftSentence = sentenceFromParts([
    spec.lighting,
    spec.materialDetail,
    spec.finish,
  ]);

  return joinPromptSentences([
    compositionSentence,
    craftSentence,
    buildReferenceSentence(spec.referenceAnchors),
    buildReadableTextSentence(spec.readableText, 'rich'),
    buildConstraintSentence(spec.constraints),
  ]);
}

function buildShotNarrative(plan: VideoScenePlan, shot: VideoShotPlan | null): string {
  if (shot) {
    return sentenceFromParts([
      shot.startState,
      shot.actionBeat || plan.subjectAction,
      shot.endState,
      plan.environment,
    ]);
  }

  return sentenceFromParts([
    plan.sceneGoal,
    plan.subjectAction,
    plan.environment,
  ]);
}

function stripQuotedDialogue(dialogue: string): string {
  return normalizeWhitespace(dialogue.replace(/["“”]/g, ''));
}

function compileVeoPrompt(plan: VideoScenePlan, context?: EnhancerContext): string {
  const shot = resolveVideoShot(plan, context);
  const cameraSentence = sentenceFromParts([
    shot?.camera || plan.cameraMovement,
    plan.ambience,
    plan.pacing,
    plan.durationBudget,
  ]);
  const continuitySentence = plan.continuityAnchors.length > 0
    ? ensureSentence(`Maintain continuity with ${listWithAnd(plan.continuityAnchors)}`)
    : '';
  const dialogueSentence = normalizeText(plan.dialogue)
    ? ensureSentence(stripQuotedDialogue(plan.dialogue))
    : '';

  return joinPromptSentences([
    buildShotNarrative(plan, shot),
    cameraSentence,
    continuitySentence,
    dialogueSentence,
  ]);
}

function compileSeedancePrompt(plan: VideoScenePlan, context?: EnhancerContext): string {
  const shot = resolveVideoShot(plan, context);
  const cameraIntent = context?.fixedLens
    ? 'static locked camera'
    : (shot?.camera || plan.cameraMovement);
  const audioSentence = context?.sound && normalizeText(plan.audioCue)
    ? ensureSentence(`Audio cues: ${normalizeText(plan.audioCue)}`)
    : '';

  return joinPromptSentences([
    buildShotNarrative(plan, shot),
    sentenceFromParts([
      cameraIntent,
      plan.ambience,
      plan.pacing,
      plan.durationBudget,
    ]),
    normalizeText(plan.dialogue) ? ensureSentence(plan.dialogue) : '',
    audioSentence,
    plan.continuityAnchors.length > 0
      ? ensureSentence(`Preserve ${listWithAnd(plan.continuityAnchors)}`)
      : '',
  ]);
}

function compileKlingShotPrompt(plan: VideoScenePlan, shot: VideoShotPlan): string {
  return joinPromptSentences([
    sentenceFromParts([
      shot.title,
      shot.startState,
      shot.actionBeat || plan.subjectAction,
      shot.endState,
      plan.environment,
    ]),
    sentenceFromParts([
      shot.camera || plan.cameraMovement,
      plan.ambience,
      plan.pacing,
      plan.durationBudget,
    ]),
    plan.continuityAnchors.length > 0
      ? ensureSentence(`Maintain continuity with ${listWithAnd(plan.continuityAnchors)}`)
      : '',
    normalizeText(shot.transition)
      ? ensureSentence(shot.transition)
      : '',
  ]);
}

function compileKlingPrompt(plan: VideoScenePlan, context?: EnhancerContext): string {
  if (context?.isMultiShot && typeof context.shotIndex !== 'number' && plan.shots.length > 1) {
    return plan.shots
      .map((shot) => `Shot ${shot.index}: ${compileKlingShotPrompt(plan, shot)}`)
      .join('\n');
  }

  const shot = resolveVideoShot(plan, context);
  if (shot) {
    return compileKlingShotPrompt(plan, shot);
  }

  return joinPromptSentences([
    sentenceFromParts([
      plan.sceneGoal,
      plan.subjectAction,
      plan.environment,
    ]),
    sentenceFromParts([
      plan.cameraMovement,
      plan.ambience,
      plan.pacing,
      plan.durationBudget,
    ]),
    plan.continuityAnchors.length > 0
      ? ensureSentence(`Maintain continuity with ${listWithAnd(plan.continuityAnchors)}`)
      : '',
  ]);
}

function buildPromptEnhancementMetadata(
  medium: Medium,
  selectedModel: string,
  compiledPrompt: string,
  context?: EnhancerContext
): Pick<PromptEnhancementArtifacts, 'agentId' | 'warnings' | 'qualityScore' | 'appliedSafeguards'> {
  const agent = resolvePromptEnhancementAgent(selectedModel);
  const inspection = inspectPromptQuality({
    medium,
    selectedModel,
    prompt: compiledPrompt,
    context,
  });

  return {
    agentId: agent.id,
    warnings: inspection.warnings,
    qualityScore: inspection.qualityScore,
    appliedSafeguards: agent.defaultSafeguards,
  };
}

export function buildPromptEnhancementArtifacts(
  medium: Medium,
  selectedModel: string,
  rawEnhancerOutput: string,
  context?: EnhancerContext,
  userPrompt = ''
): PromptEnhancementArtifacts {
  const playbook = getEnhancerPlaybook(selectedModel);
  const scenario = resolvePromptScenario(medium, selectedModel, context);
  const trimmedOutput = normalizeWhitespace(rawEnhancerOutput);

  if (!playbook || playbook.plannerMode === 'legacy-text') {
    return {
      playbookId: normalizeModelId(selectedModel),
      plannerMode: playbook?.plannerMode ?? 'legacy-text',
      scenario,
      plannerOutput: trimmedOutput,
      compiledPrompt: trimmedOutput,
      ...buildPromptEnhancementMetadata(medium, selectedModel, trimmedOutput, context),
    };
  }

  const parsedOutput = parseStructuredOutput(rawEnhancerOutput);
  if (!parsedOutput) {
    return {
      playbookId: playbook.modelId,
      plannerMode: playbook.plannerMode,
      scenario,
      plannerOutput: trimmedOutput,
      compiledPrompt: trimmedOutput,
      ...buildPromptEnhancementMetadata(medium, selectedModel, trimmedOutput, context),
    };
  }

  if (playbook.plannerMode === 'structured-image') {
    const spec = normalizeImagePromptSpec(parsedOutput, userPrompt);
    const compiledPrompt = playbook.modelId === 'nano-banana-2'
      ? compileNanoBanana2Prompt(spec)
      : compileNanoBananaProPrompt(spec);

    return {
      playbookId: playbook.modelId,
      plannerMode: playbook.plannerMode,
      scenario,
      plannerOutput: spec,
      compiledPrompt: compiledPrompt || normalizeWhitespace(userPrompt),
      ...buildPromptEnhancementMetadata(
        medium,
        selectedModel,
        compiledPrompt || normalizeWhitespace(userPrompt),
        context
      ),
    };
  }

  const plan = normalizeVideoScenePlan(parsedOutput, userPrompt);
  const compiledPrompt = (() => {
    if (SEEDANCE_PLAYBOOK_MODEL_IDS.has(playbook.modelId)) {
      return compileSeedancePrompt(plan, context);
    }
    if (playbook.modelId === 'veo-3.1') {
      return compileVeoPrompt(plan, context);
    }
    return compileKlingPrompt(plan, context);
  })();

  return {
    playbookId: playbook.modelId,
    plannerMode: playbook.plannerMode,
    scenario,
    plannerOutput: plan,
    compiledPrompt: compiledPrompt || normalizeWhitespace(userPrompt),
    ...buildPromptEnhancementMetadata(
      medium,
      selectedModel,
      compiledPrompt || normalizeWhitespace(userPrompt),
      context
    ),
  };
}

export const SUPPORTED_ENHANCEMENT_MODELS = new Set([
  ...Object.keys(ENHANCER_PLAYBOOKS),
  ...Object.keys(PROMPT_ENHANCEMENT_AGENTS),
  ...Object.keys(MODEL_ALIASES),
]);

interface KieEnhancementResponse {
  enhancedPrompt: string;
}

export async function callPromptEnhancer(
  systemPrompt: string,
  userPrompt: string
): Promise<KieEnhancementResponse> {
  const apiKey = process.env.KIE_AI_API_KEY;
  if (!apiKey) {
    throw new Error('KIE_AI_API_KEY is not configured');
  }

  const response = await fetchWithProviderTimeout(PROMPT_ENHANCER_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      messages: [
        {
          role: 'system',
          content: [{ type: 'text', text: systemPrompt }],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: userPrompt }],
        },
      ],
      stream: false,
      include_thoughts: false,
      reasoning_effort: 'low',
    }),
  }, PROVIDER_INTERACTIVE_REQUEST_TIMEOUT_MS, fetch, 'KIE prompt enhancer');

  if (!response.ok) {
    const errorBody = await response.text();
    logBackendError('promptenhancer_kie_api_error', { error: response.status, errorBody });
    throw new Error(`Kie API returned ${response.status}: ${errorBody}`);
  }

  const data = await response.json();

  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    logBackendError('promptenhancer_unexpected_response_shape', { error: JSON.stringify(data) });
    throw new Error('Invalid response from Kie API: no content in choices');
  }

  return { enhancedPrompt: content.trim() };
}

function extractPromptHandles(prompt: string): string[] {
  const matches = prompt.match(/@[\p{L}\p{N}_-]+/gu);
  return matches ?? [];
}
