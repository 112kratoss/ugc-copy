import { isAudioModel } from '@/lib/models';

export const SHARE_SOURCE_SURFACES = [
  'create-image',
  'create-video',
  'create-motion',
  'my-creations',
  'creator-profile',
  'showcase',
  'detail-page',
] as const;

export const SHARE_CHANNELS = ['native-share', 'copy-link'] as const;

export type GenerationShareSourceSurface = (typeof SHARE_SOURCE_SURFACES)[number];
export type GenerationShareChannel = (typeof SHARE_CHANNELS)[number];
export type GenerationShareEventType = 'share_click' | 'share_visit';

export function isGenerationShareSourceSurface(value: string): value is GenerationShareSourceSurface {
  return (SHARE_SOURCE_SURFACES as readonly string[]).includes(value);
}

export function isGenerationShareChannel(value: string): value is GenerationShareChannel {
  return (SHARE_CHANNELS as readonly string[]).includes(value);
}

export function buildShowcaseDetailPath(generationId: string): string {
  return `/showcase/${generationId}`;
}

export function buildShowcaseDetailUrl(generationId: string, origin: string): string {
  return new URL(buildShowcaseDetailPath(generationId), origin).toString();
}

export function supportsPublicCreationSharing({
  category,
  model,
}: {
  category?: string | null;
  model?: string | null;
}): boolean {
  if (category === 'audio') {
    return false;
  }

  if (model && isAudioModel(model)) {
    return false;
  }

  return true;
}
