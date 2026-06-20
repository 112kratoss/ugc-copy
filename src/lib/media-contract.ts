export type VisualCategory = 'image' | 'video' | 'text';
export type VisualMediaKind = Exclude<VisualCategory, 'text'>;

export interface VisualMediaClassification {
  category: VisualCategory;
  kind: VisualMediaKind | null;
  creationMode: 'motion' | null;
}

type VisualMediaInput = {
  category: string | null | undefined;
  contentType: string | null | undefined;
};

export function classifyVisualMedia(input: VisualMediaInput): VisualMediaClassification | null {
  const category = input.category?.trim().toLowerCase() ?? '';
  const contentType = input.contentType?.trim().toLowerCase() ?? '';

  if (contentType.startsWith('audio/') || category === 'audio') return null;
  if (category === 'text') return { category: 'text', kind: null, creationMode: null };

  if (contentType.startsWith('video/') || category === 'video' || category === 'motion') {
    return {
      category: 'video',
      kind: 'video',
      creationMode: category === 'motion' ? 'motion' : null,
    };
  }

  if (contentType.startsWith('image/') || category === 'image' || category === 'ugc-ad') {
    return { category: 'image', kind: 'image', creationMode: null };
  }

  return { category: 'image', kind: 'image', creationMode: null };
}

export function normalizeVisualCategory(input: VisualMediaInput): VisualCategory | null {
  return classifyVisualMedia(input)?.category ?? null;
}
