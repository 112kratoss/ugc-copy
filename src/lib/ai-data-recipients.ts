import type {
  ImageModelId,
  MotionModelId,
  SoundEffectModelId,
  VideoModelId,
  VoiceoverModelId,
} from '@/lib/models';

/**
 * Who receives a person's prompts and media when they create.
 *
 * Every request goes to Kie.ai, which runs the models, and on to the company
 * that made the model chosen. App Review requires the app to name them before
 * it sends anything, and the privacy policy to name them too (guidelines
 * 5.1.1(i) and 5.1.2(i); 0.1.6 was rejected without it). The policy reads the
 * list below (`src/app/privacy/page.tsx`), and the mobile app names the makers
 * in its own words (`ugc-mobile/lib/ai-data-consent.ts`).
 *
 * `AI_MODEL_MAKER_BY_MODEL_ID` must cover every model in `src/lib/models.ts`,
 * which the typecheck enforces: registering a model without its maker fails
 * the build. `src/__tests__/ai-data-recipients.test.ts` then checks that the
 * policy and the app name every maker.
 */

export type AiModelMaker =
  | 'Google'
  | 'OpenAI'
  | 'ByteDance'
  | 'Kuaishou'
  | 'Alibaba'
  | 'MiniMax'
  | 'xAI'
  | 'Ideogram'
  | 'Black Forest Labs'
  | 'ElevenLabs';

type CatalogModelId = MotionModelId | ImageModelId | VideoModelId | VoiceoverModelId | SoundEffectModelId;

export const AI_MODEL_MAKER_BY_MODEL_ID = {
  // Motion transfer
  'kling-2.6': 'Kuaishou',
  'kling-3.0': 'Kuaishou',
  // Images
  'nano-banana-2-lite': 'Google',
  'nano-banana-2': 'Google',
  'nano-banana-pro': 'Google',
  'imagen-4-fast': 'Google',
  'imagen-4': 'Google',
  'imagen-4-ultra': 'Google',
  'gpt-image-2': 'OpenAI',
  'gpt-image-2.5-flare': 'OpenAI',
  'gpt-image-2.5-sunburst': 'OpenAI',
  'seedream-5-pro': 'ByteDance',
  'seedream-5-lite': 'ByteDance',
  'wan-2.7-image': 'Alibaba',
  'wan-2.7-image-pro': 'Alibaba',
  'qwen3': 'Alibaba',
  'qwen3-pro': 'Alibaba',
  'z-image': 'Alibaba',
  'ideogram-v3': 'Ideogram',
  'ideogram-character': 'Ideogram',
  'flux-2-pro': 'Black Forest Labs',
  'grok-imagine-image': 'xAI',
  'grok-imagine-image-2': 'xAI',
  // Video
  'kling-3.0-video': 'Kuaishou',
  'kling-3.0-turbo': 'Kuaishou',
  'kling-o3': 'Kuaishou',
  'seedance-1.5-pro': 'ByteDance',
  'seedance-2': 'ByteDance',
  'seedance-2-fast': 'ByteDance',
  'seedance-2-mini': 'ByteDance',
  'seedance-2-5': 'ByteDance',
  'wan-2.7': 'Alibaba',
  // Alibaba's ATH unit, revealed as the maker in April 2026.
  'happyhorse-1.1': 'Alibaba',
  'veo-3.1': 'Google',
  'gemini-omni-video': 'Google',
  'hailuo-2.3': 'MiniMax',
  'minimax-h3': 'MiniMax',
  'grok-imagine-video': 'xAI',
  // Voice and sound effects, in web workflows only
  'text-to-speech-turbo-2-5': 'ElevenLabs',
  'text-to-speech-multilingual-v2': 'ElevenLabs',
  'text-to-dialogue-v3': 'ElevenLabs',
  'sound-effect-v2': 'ElevenLabs',
} as const satisfies Record<CatalogModelId, AiModelMaker>;

/** "Enhance prompt" rewrites the prompt with Gemini (`PROMPT_ENHANCER_PROVIDER_MODEL`). */
export const PROMPT_ENHANCER_MAKER: AiModelMaker = 'Google';

/** The policy's list: each maker once, with the model families people will recognise. */
export const AI_MODEL_MAKERS: ReadonlyArray<{ maker: AiModelMaker; models: string }> = [
  { maker: 'Google', models: 'Veo, Gemini Omni Video, Nano Banana and Imagen, and Gemini for Enhance prompt' },
  { maker: 'OpenAI', models: 'GPT Image' },
  { maker: 'ByteDance', models: 'Seedance and Seedream' },
  { maker: 'Kuaishou', models: 'Kling' },
  { maker: 'Alibaba', models: 'Wan, Qwen Image, Z-Image and HappyHorse' },
  { maker: 'MiniMax', models: 'Hailuo and MiniMax H3' },
  { maker: 'xAI', models: 'Grok Imagine' },
  { maker: 'Ideogram', models: 'Ideogram' },
  { maker: 'Black Forest Labs', models: 'FLUX' },
  { maker: 'ElevenLabs', models: 'voice and sound effects in web workflows' },
];
