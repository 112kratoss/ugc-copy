import type { ImageElementDescriptor } from '@/lib/image-elements';
import type { GenerationInputMediaItem } from '@/lib/generation-input-media';
import type { ShowcaseItemCategory } from '@/lib/showcase';

type RemixResultMediaType = 'image' | 'video';
export type RemixAssetKind = 'image' | 'video' | 'audio';

export interface RemixMediaAssetDescriptor {
  kind: RemixAssetKind;
  label?: string | null;
  storagePath?: string | null;
  sourceGenerationId?: string | null;
}

export interface RemixResolvedAsset extends RemixMediaAssetDescriptor {
  url: string | null;
}

interface RemixImageElementDescriptor extends ImageElementDescriptor {
  sourceGenerationId?: string | null;
}

export interface RemixResolvedImageElement extends RemixImageElementDescriptor {
  url: string | null;
}

interface RemixSourceGeneration {
  id: string;
  title: string;
  prompt: string;
  category: ShowcaseItemCategory;
  model: string;
}

export interface RemixSourceResult {
  mediaType: RemixResultMediaType;
  url: string | null;
}

export interface RemixSourceBundle {
  generation: RemixSourceGeneration;
  result: RemixSourceResult | null;
  inputs: {
    image?: {
      elements: RemixResolvedImageElement[];
    };
    video?: {
      referenceMode: 'frames' | 'elements';
      startFrame: RemixResolvedAsset | null;
      endFrame: RemixResolvedAsset | null;
      elements: RemixResolvedImageElement[];
      referenceVideos?: RemixResolvedAsset[];
      referenceAudios?: RemixResolvedAsset[];
    };
    motion?: {
      characterImage: RemixResolvedAsset | null;
      referenceVideo: RemixResolvedAsset | null;
    };
  };
  inputMedia?: GenerationInputMediaItem[];
  workflowSettings: Record<string, unknown>;
  restoreIssues: string[];
}

/**
 * Whether the creator typed a prompt of their own while a remix restore was
 * still in flight.
 *
 * Restoring a remix is fire-and-forget: the studio paints an interactive form
 * immediately and the bundle lands whenever /api/remix-source answers, so an
 * unconditional write silently discards anything typed in between. Their words
 * win over the restore.
 *
 * Both halves matter. A tool whose prompt has a non-empty default (motion) must
 * not read that default as creator input, so the value also has to have changed
 * since the restore began.
 */
/**
 * Motion is a creation mode, not a category. The legacy motion start marks it
 * in workflow_settings; the catalog path stores a 'video' generation and marks
 * only the creation_mode column.
 */
export function isMotionGeneration(source: {
  category?: string | null;
  creationMode?: string | null;
  workflowSettings?: Record<string, unknown> | null;
}): boolean {
  return source.category === 'motion'
    || source.creationMode === 'motion'
    || source.workflowSettings?.creationMode === 'motion';
}

/**
 * An input a catalog-path generation recorded under one of its model's slots.
 * Legacy starts wrote named keys (characterImage, referenceVideo) into
 * workflow_settings, and the catalog path writes an `inputs` list of slots
 * instead, so a reader that only knows the named keys finds nothing.
 */
function catalogInputSlotDescriptor(
  workflowSettings: Record<string, unknown>,
  slot: string,
  expectedKind: RemixAssetKind,
): RemixMediaAssetDescriptor | null {
  const inputs: unknown[] = Array.isArray(workflowSettings.inputs) ? workflowSettings.inputs : [];
  const input = inputs.find((candidate) => (
    typeof candidate === 'object' && candidate !== null && (candidate as { slot?: unknown }).slot === slot
  ));
  return input ? normalizeRemixMediaAssetDescriptor(input, expectedKind) : null;
}

/** A motion generation's two inputs, from the legacy named keys or the catalog's slots. */
export function motionInputDescriptors(workflowSettings: Record<string, unknown>): {
  characterImage: RemixMediaAssetDescriptor | null;
  referenceVideo: RemixMediaAssetDescriptor | null;
} {
  return {
    characterImage: normalizeRemixMediaAssetDescriptor(workflowSettings.characterImage, 'image')
      ?? catalogInputSlotDescriptor(workflowSettings, 'characterImage', 'image'),
    referenceVideo: normalizeRemixMediaAssetDescriptor(workflowSettings.referenceVideo, 'video')
      ?? catalogInputSlotDescriptor(workflowSettings, 'referenceVideo', 'video'),
  };
}

export function hasCreatorEditedPromptDuringRemix(
  currentPrompt: string,
  promptWhenRemixStarted: string
): boolean {
  return currentPrompt.trim().length > 0 && currentPrompt !== promptWhenRemixStarted;
}

export function normalizeRemixMediaAssetDescriptor(
  value: unknown,
  expectedKind?: RemixAssetKind
): RemixMediaAssetDescriptor | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const typedValue = value as Partial<RemixMediaAssetDescriptor>;
  const kind = typedValue.kind === 'audio'
    ? 'audio'
    : typedValue.kind === 'video'
      ? 'video'
      : typedValue.kind === 'image'
        ? 'image'
        : null;
  if (!kind || (expectedKind && kind !== expectedKind)) {
    return null;
  }

  return {
    kind,
    label: typeof typedValue.label === 'string' ? typedValue.label : null,
    storagePath: typeof typedValue.storagePath === 'string' ? typedValue.storagePath : null,
    sourceGenerationId:
      typeof typedValue.sourceGenerationId === 'string' ? typedValue.sourceGenerationId : null,
  };
}
