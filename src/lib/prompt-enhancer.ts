export type Medium = 'image' | 'video' | 'motion';

export type CreativeIntent = 'general' | 'ugc-ad' | 'product-video' | 'social-campaign';

export type PromptScenario =
  | 'image.text_to_image'
  | 'image.reference_guided'
  | 'video.text_to_video_single'
  | 'video.text_to_video_multi_shot'
  | 'video.image_to_video_start_frame'
  | 'video.image_to_video_start_end'
  | 'motion.transfer';

export interface EnhancerContext {
  modelId?: string;
  aspectRatio?: string;
  resolution?: string;
  googleSearch?: boolean;
  mode?: string;
  duration?: number;
  sound?: boolean;
  shotIndex?: number;
  characterOrientation?: string;
  referenceImageCount?: number;
  isMultiShot?: boolean;
  shotCount?: number;
  hasStartImage?: boolean;
  hasEndImage?: boolean;
  hasReferenceVideo?: boolean;
  creativeIntent?: CreativeIntent;
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

export function getPromptEnhancementCost(): number {
  return 2;
}

const BASE_SYSTEM_PROMPT = `You are a prompt enhancement specialist for AI media generation.

Your job is to take the user's raw prompt and rewrite it into an optimized, production-quality prompt for the specific AI model and generation mode they are using.

Rules:
1. Preserve the user's original intent, subject matter, and any exact wording they explicitly require.
2. Do not add new subjects, themes, props, or story beats the user did not ask for.
3. Write in natural descriptive English, not keyword dumps.
4. Use clear, model-aware detail: subject, setting, composition, lighting, motion, pacing, and finish when relevant.
5. Prefer positive, precise constraints over long negative laundry lists unless the user explicitly asked for exclusions.
6. Output only a single polished prompt string with no commentary.
7. Keep the enhanced prompt concise but rich, usually 1 to 3 sentences.`;

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
    'This prompt belongs to a larger multi-shot sequence, but it should still read as one self-contained shot.',
    'Give the shot a clear visual start, key action, and end state without referencing other shots.',
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

const MODEL_RULES: Record<string, string[]> = {
  'nano-banana-2': [
    'Nano Banana 2 responds best to concise natural-language prompting with subject, context, and style stated cleanly.',
    'Use positive phrasing and aspect-ratio-aware composition cues instead of overstuffed modifier chains.',
  ],
  'nano-banana-pro': [
    'Nano Banana Pro can handle richer material, lighting, composition, and texture detail while staying photorealistic and controlled.',
    'Lean into fidelity, product clarity, and precise photographic language when the user asks for premium or polished output.',
    'If reference images are present, prioritize preservation of anchored identity and product traits over inventing new ones.',
  ],
  'kling-3.0/video': [
    'Kling 3.0 video works best with one grounded clip, explicit camera behavior, believable motion, and a strong atmospheric direction.',
    'Keep the prompt cinematic and coherent rather than turning it into a sequence of disconnected moments.',
  ],
  'seedance-1.5-pro': [
    'Seedance 1.5 Pro benefits from grounded cinematic prompts with clear action, camera intent, and duration-aware pacing.',
    'Only mention sound design or ambience when audio is enabled and it materially helps the scene.',
  ],
  'veo-3.1': [
    'Veo 3.1 benefits from subject, action, context, camera, composition, and ambiance stated clearly in natural language.',
    'When frames or reference images are involved, let the prompt focus on motion and camera evolution rather than restating fixed visuals.',
  ],
  'kling-2.6': [
    'Kling 2.6 motion control expects the reference video to govern the action, so keep the prompt centered on character identity, environment, and visual style.',
    'Use the prompt to reduce distortion and help the transferred performance feel grounded in the scene.',
  ],
  'kling-3.0': [
    'Kling 3.0 motion control handles nuanced identity and scene polish well when the prompt stays focused on realism, environment, and subject integrity.',
    'Do not over-describe motion beats because the reference video already supplies them.',
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
  'nano-banana-2': [
    'If the user requests readable text, keep the exact words in quotes and make the text treatment explicit but brief.',
  ],
  'nano-banana-pro': [
    'If the user requests readable text, keep the exact words in quotes and make the text treatment explicit but brief.',
  ],
};

const GOOGLE_SEARCH_RULES = [
  'Because Google Search grounding is enabled, only lean on real-world specificity the user actually asked for.',
];

const MODEL_ALIASES: Record<string, string> = {
  'kling-3.0-video': 'kling-3.0/video',
};

const MODEL_LABELS: Record<string, string> = {
  'nano-banana-2': 'Nano Banana 2',
  'nano-banana-pro': 'Nano Banana Pro',
  'kling-3.0/video': 'Kling 3.0 Video',
  'kling-3.0-video': 'Kling 3.0 Video',
  'seedance-1.5-pro': 'Seedance 1.5 Pro',
  'veo-3.1': 'Veo 3.1',
  'kling-2.6': 'Kling 2.6 Motion Control',
  'kling-3.0': 'Kling 3.0 Motion Control',
};

function normalizeModelId(selectedModel: string): string {
  return MODEL_ALIASES[selectedModel] ?? selectedModel;
}

function getCreativeIntent(context?: EnhancerContext): CreativeIntent {
  return context?.creativeIntent ?? 'general';
}

function getModelRules(selectedModel: string): string[] {
  return MODEL_RULES[normalizeModelId(selectedModel)] ?? [];
}

function getTextRenderingRules(selectedModel: string): string[] {
  return TEXT_RENDERING_RULES[normalizeModelId(selectedModel)] ?? [];
}

function getModelLabel(selectedModel: string): string {
  return MODEL_LABELS[selectedModel] ?? MODEL_LABELS[normalizeModelId(selectedModel)] ?? selectedModel;
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
  if (typeof context.referenceImageCount === 'number' && context.referenceImageCount > 0) {
    lines.push(`- Reference images attached: ${context.referenceImageCount}`);
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
  const textRules =
    options.medium === 'image' && needsTextRenderingGuidance(options.userPrompt)
      ? getTextRenderingRules(options.selectedModel)
      : [];
  const googleSearchRules =
    options.medium === 'image' && options.context?.googleSearch ? GOOGLE_SEARCH_RULES : [];
  const sections = [
    `Target model: ${getModelLabel(options.selectedModel)}`,
    `Prompt scenario: ${scenario}`,
    buildRuleBlock('Core strategy:', BASE_STRATEGY_RULES),
    buildRuleBlock('Medium guidance:', MEDIUM_RULES[options.medium]),
    buildRuleBlock('Scenario guidance:', SCENARIO_RULES[scenario]),
    buildRuleBlock('Model guidance:', getModelRules(options.selectedModel)),
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
      ...getModelRules(modelId),
    ]);

    return `- If ${options.modelSelector} is ${modelId}, ${summary}`;
  });

  return [
    `${options.fieldName} guidance:`,
    ...sharedRules.map((rule) => `- ${rule}`),
    ...modelSpecificRules,
  ].join('\n');
}

export function buildEnhancerSystemPrompt(
  medium: Medium,
  selectedModel: string,
  context?: EnhancerContext,
  userPrompt?: string
): string {
  return [
    BASE_SYSTEM_PROMPT,
    buildPromptStrategyGuidance({
      medium,
      selectedModel,
      context,
      userPrompt,
      includeExamples: true,
    }),
  ].join('\n\n');
}

export const SUPPORTED_ENHANCEMENT_MODELS = new Set([
  'nano-banana-2',
  'nano-banana-pro',
  'kling-3.0/video',
  'seedance-1.5-pro',
  'veo-3.1',
  'kling-2.6',
  'kling-3.0',
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

  const response = await fetch('https://api.kie.ai/gemini-3-flash/v1/chat/completions', {
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
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error('[PromptEnhancer] Kie API error:', response.status, errorBody);
    throw new Error(`Kie API returned ${response.status}: ${errorBody}`);
  }

  const data = await response.json();

  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    console.error('[PromptEnhancer] Unexpected response shape:', JSON.stringify(data));
    throw new Error('Invalid response from Kie API: no content in choices');
  }

  return { enhancedPrompt: content.trim() };
}
