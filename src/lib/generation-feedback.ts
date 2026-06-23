import { isAudioModel, isImageModel, isMotionModel } from '@/lib/client-generation-models';
import { formatDurationShort } from '@/lib/generation-timing';

export const BACKGROUND_PROCESSING_ERROR = '__BACKGROUND_PROCESSING__';

export type GenerationKind = 'image' | 'video' | 'motion' | 'audio';

export interface GenerationDescriptor {
  category?: string | null;
  model?: string | null;
}

export function getGenerationKind(descriptor: GenerationDescriptor): GenerationKind {
  if (descriptor.category === 'image') {
    return 'image';
  }

  if (descriptor.category === 'motion') {
    return 'motion';
  }

  if (descriptor.category === 'audio') {
    return 'audio';
  }

  if (descriptor.model) {
    if (isImageModel(descriptor.model)) {
      return 'image';
    }

    if (isMotionModel(descriptor.model)) {
      return 'motion';
    }

    if (isAudioModel(descriptor.model)) {
      return 'audio';
    }
  }

  return 'video';
}

function getGenerationLabel(kind: GenerationKind): string {
  switch (kind) {
    case 'image':
      return 'image';
    case 'motion':
      return 'motion render';
    case 'audio':
      return 'audio';
    default:
      return 'video';
  }
}

export function getBackgroundProcessingCopy(kind: Exclude<GenerationKind, 'audio'>) {
  const label = getGenerationLabel(kind);

  return {
    title: `${label.charAt(0).toUpperCase()}${label.slice(1)} still processing`,
    description:
      'This run is taking longer than usual, but it is still active in the background. You can keep working and check Studio any time.',
    status:
      kind === 'image'
        ? 'Still processing in background'
        : 'Still rendering in background',
  };
}

export function getGenerationNotificationCopy(
  kind: GenerationKind,
  status: 'succeeded' | 'failed',
  completedInMs?: number | null
) {
  const label = getGenerationLabel(kind);

  if (status === 'succeeded') {
    const completionSuffix = completedInMs ? ` in ${formatDurationShort(completedInMs)}` : '';
    return {
      title: `${label.charAt(0).toUpperCase()}${label.slice(1)} ready`,
      description: `Your latest ${label} finished${completionSuffix} and is ready in Studio.`,
    };
  }

  return {
    title: `${label.charAt(0).toUpperCase()}${label.slice(1)} failed`,
    description: `Your latest ${label} did not finish successfully. Open Studio to review it or try another run.`,
  };
}
