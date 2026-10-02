import type { GenerationListItem } from '@/lib/types';

export type GenerationMediaKind = 'image' | 'video' | 'motion' | 'text' | 'audio';
export type GenerationRenderableMediaKind = 'image' | 'video' | null;
/**
 * What an audio creation is, as the owner route names it (`audioKind`). The
 * server tells a voiceover from a sound effect by its model table; the app has
 * no such table and must not grow one.
 */
export type GenerationAudioKind = 'voiceover' | 'sound-effect' | 'audio';

export function getGenerationKind(item: Pick<GenerationListItem, 'category' | 'creationMode'>): GenerationMediaKind {
  if (item.creationMode === 'motion') return 'motion';
  const category = item.category?.trim().toLowerCase();
  if (category === 'video' || category === 'ugc-ad') return 'video';
  if (category === 'motion') return 'motion';
  if (category === 'text') return 'text';
  // Sound is named before the fall-through. An audio creation that reached
  // `image` was drawn as a picture that could never load, and offered Publish
  // and Recreate, both of which the server refuses for it.
  if (category === 'audio') return 'audio';
  return 'image';
}

/** What a picture or video component can be handed. Words and sound are neither. */
export function getGenerationRenderableMediaKind(kind: GenerationMediaKind): GenerationRenderableMediaKind {
  if (kind === 'text' || kind === 'audio') return null;
  if (kind === 'image') return 'image';
  return 'video';
}

/** A kind this build does not know, or a server that sends none, is plain audio. */
export function normalizeGenerationAudioKind(value: unknown): GenerationAudioKind {
  return value === 'voiceover' || value === 'sound-effect' ? value : 'audio';
}

export function getGenerationLabel(kind: GenerationMediaKind, audioKind?: GenerationListItem['audioKind']) {
  if (kind === 'motion') return 'Motion';
  if (kind === 'video') return 'Video';
  if (kind === 'text') return 'Text';
  if (kind === 'audio') {
    const named = normalizeGenerationAudioKind(audioKind);
    return named === 'voiceover' ? 'Voiceover' : named === 'sound-effect' ? 'Sound effect' : 'Audio';
  }
  return 'Image';
}
