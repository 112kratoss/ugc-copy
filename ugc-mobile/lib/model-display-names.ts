/**
 * Every generation model's name, as the web's static catalog names it
 * (`src/lib/client-generation-models.ts`, which `getPostModelDisplayName`
 * reads for the posts and Made with rows the server stores). The app's own
 * tables (`media-creation-view-model.ts`) hold only the models its first
 * creators offered, so a newer model went unnamed on feed cards, in Details
 * and in the composer's Made with. `src/__tests__/app-model-display-names.test.ts`
 * holds this list to the web's: a model added there is added here, one entry
 * per line.
 */
export const MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  'kling-2.6': 'Kling 2.6',
  'kling-3.0': 'Kling 3.0',
  'nano-banana-2-lite': 'Nano Banana 2 Lite',
  'nano-banana-2': 'Nano Banana 2.0',
  'nano-banana-pro': 'Nano Banana Pro',
  'gpt-image-2': 'GPT Image 2',
  'seedream-5-pro': 'Seedream 5 Pro',
  'seedream-5-lite': 'Seedream 5 Lite',
  'wan-2.7-image': 'Wan 2.7 Image',
  'wan-2.7-image-pro': 'Wan 2.7 Image Pro',
  'imagen-4-fast': 'Imagen 4 Fast',
  'imagen-4': 'Imagen 4',
  'imagen-4-ultra': 'Imagen 4 Ultra',
  'ideogram-v3': 'Ideogram V3',
  'flux-2-pro': 'FLUX.2 Pro',
  'z-image': 'Z-Image',
  'grok-imagine-image': 'Grok Imagine',
  'grok-imagine-image-2': 'Grok Imagine 2.0',
  'qwen3': 'Qwen Image 3.0',
  'qwen3-pro': 'Qwen Image 3.0 Pro',
  'ideogram-character': 'Ideogram Character',
  'gpt-image-2.5-flare': 'GPT Image 2.5 Flare',
  'gpt-image-2.5-sunburst': 'GPT Image 2.5 Sunburst',
  'seedream-5-flash': 'Seedream 5 Flash',
  'qwen-image-2.1': 'Qwen Image 2.1',
  'kling-3.0-video': 'Kling 3.0 Cinematic',
  'kling-3.0-turbo': 'Kling 3 Turbo',
  'seedance-1.5-pro': 'Seedance 1.5 Pro',
  'seedance-2': 'Seedance 2',
  'seedance-2-fast': 'Seedance 2 Fast',
  'seedance-2-mini': 'Seedance 2 Mini',
  'wan-2.7': 'Wan 2.7',
  'happyhorse-1.1': 'HappyHorse 1.1',
  'gemini-omni-video': 'Gemini Omni Video',
  'hailuo-2.3': 'Hailuo 2.3',
  'veo-3.1': 'Veo 3.1',
  'grok-imagine-video': 'Grok Imagine Video',
  'seedance-2-5': 'Seedance 2.5',
  'kling-o3': 'Kling O3',
  'minimax-h3': 'MiniMax H3',
  'gemini-omni-1.1-flash': 'Gemini Omni 1.1 Flash',
  'wan-3.0': 'Wan 3.0',
  'wan-3.0-prime': 'Wan 3.0 Prime',
  'grok-imagine-video-1.5': 'Grok Imagine Video 1.5',
  'pixverse-v6': 'PixVerse V6',
};
