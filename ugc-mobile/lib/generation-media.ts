import type { GenerationListItem } from '@/lib/types';

export type GenerationMediaKind = 'image' | 'video' | 'motion' | 'text';
export type GenerationRenderableMediaKind = 'image' | 'video' | null;

export function getGenerationKind(item: Pick<GenerationListItem, 'category' | 'creationMode'>): GenerationMediaKind {
  if (item.creationMode === 'motion') return 'motion';
  const category = item.category?.trim().toLowerCase();
  if (category === 'video' || category === 'ugc-ad') return 'video';
  if (category === 'motion') return 'motion';
  if (category === 'text') return 'text';
  return 'image';
}

export function getGenerationRenderableMediaKind(kind: GenerationMediaKind): GenerationRenderableMediaKind {
  if (kind === 'text') return null;
  if (kind === 'image') return 'image';
  return 'video';
}

export function getGenerationLabel(kind: GenerationMediaKind) {
  if (kind === 'motion') return 'Motion';
  if (kind === 'video') return 'Video';
  if (kind === 'text') return 'Text';
  return 'Image';
}
