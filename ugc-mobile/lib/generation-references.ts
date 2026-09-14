import type { GenerationInputMediaItem } from './types';

const ROLE_LABELS: Record<string, string> = {
  reference_image: 'Reference image', start_frame: 'Start frame', end_frame: 'End frame',
  reference_video: 'Reference video', reference_audio: 'Reference audio',
  character_image: 'Character image', motion_reference_video: 'Motion reference video',
};

export function generationReferences(media: GenerationInputMediaItem[] = []) {
  return [...media].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((item, index) => {
    const kind = item.mediaType ?? item.kind;
    const mediaKind: 'image' | 'video' | 'audio' = kind === 'video' || kind === 'audio' ? kind : 'image';
    const roleLabel = ROLE_LABELS[item.role ?? ''] ?? `Reference ${mediaKind}`;
    const handle = typeof item.metadata?.handle === 'string' ? item.metadata.handle.trim() : '';
    const label = handle || item.label?.trim() || roleLabel;
    return { id: item.id ?? item.storagePath ?? `reference-${index}`, url: item.url ?? null,
      mediaKind, label, caption: roleLabel };
  });
}
