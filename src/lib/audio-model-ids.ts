/**
 * The audio models, by the ids the app gives them and the ids their provider does. A module of its
 * own so that a page asking only whether a model makes sound (a share: `supportsPublicCreationSharing`
 * in share.ts, which every post page loads) does not load the browser's model tables with the
 * answer; `client-generation-models.ts` re-exports `isAudioModel` for everything else.
 */
const AUDIO_MODEL_IDS = [
  'text-to-speech-turbo-2-5',
  'text-to-speech-multilingual-v2',
  'text-to-dialogue-v3',
  'sound-effect-v2',
] as const;

const AUDIO_PROVIDER_MODEL_IDS = [
  'elevenlabs/text-to-speech-turbo-2-5',
  'elevenlabs/text-to-speech-multilingual-v2',
  'elevenlabs/text-to-dialogue-v3',
  'elevenlabs/sound-effect-v2',
] as const;

export function isAudioModel(modelId: string): boolean {
  return (AUDIO_MODEL_IDS as readonly string[]).includes(modelId)
    || (AUDIO_PROVIDER_MODEL_IDS as readonly string[]).includes(modelId);
}
