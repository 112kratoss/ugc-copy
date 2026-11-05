import { readCreationTitleSource, type CreationTitleSource } from '@/lib/creation-post-title';
import type { GenerationPaywallPrefill } from '@/lib/generation-paywall';
import { isPostResourceKind } from '@/lib/post-resource-bundles';
// Which saved inputs the recipe takes, and a remix's terms, as both composers read them.
import {
  isRemixRecipeMode,
  recipeCopyableInputs,
  type CreationInputLike,
  type GenerationReference,
  type RemixRecipeMode,
} from '../../ugc-mobile/lib/creation-recipe/creation-recipe';

/**
 * What publishing a creation starts from, read from the owner's library entry as Studio reads
 * it: its own title, its recipe's prefill, and what a title is suggested from when it has none.
 * The three creators read it in three copies before; published without it, a post went out
 * as the media alone while the same creation from Studio offered its recipe.
 */
export type CreationPublishDetails = {
  title: string;
  paywallPrefill: GenerationPaywallPrefill | null;
  creation: CreationTitleSource | null;
  /** The saved inputs the recipe takes (`recipeCopyable`), each of which the form can remove. */
  inputs: GenerationReference[];
  /** The terms the run carries as a remix (`remix_recipe_mode`); null for none. */
  remixRecipeMode: RemixRecipeMode | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A generations answer's `paywallPrefill`, or null where it is none: every kind a recipe's, the
 * prompt text or none, the remix switch a boolean. The composer and the creators' form both read
 * it here, so a recipe one offers the other never drops, and neither takes in notes: an answer
 * from before 2026-11-03 named the creation's "Saved generation setup" as its `notes`, which no
 * recipe holds now that the post shows the settings to everyone (owner's decision), so its notes
 * are left out here, the kind and the text. (Here, not in `generation-paywall.ts`, which is the
 * server's: both callers are browser code.)
 */
export function readGenerationPaywallPrefill(value: unknown): GenerationPaywallPrefill | null {
  if (!isRecord(value)) {
    return null;
  }
  const typed = value as Partial<GenerationPaywallPrefill>;
  const valid = Array.isArray(typed.resourceKinds)
    && typed.resourceKinds.every((kind) => isPostResourceKind(kind))
    && (typeof typed.promptText === 'string' || typed.promptText === null || typed.promptText === undefined)
    && typeof typed.allowRemix === 'boolean';
  if (!valid) return null;
  const prefill: GenerationPaywallPrefill & { notesMarkdown?: unknown } = {
    ...(typed as GenerationPaywallPrefill),
    resourceKinds: (typed.resourceKinds as GenerationPaywallPrefill['resourceKinds']).filter((kind) => kind !== 'notes'),
  };
  delete prefill.notesMarkdown;
  return prefill;
}

/** The details of `generationId` in an `/api/generations` answer, or null where it is not there. */
function readCreationPublishDetails(generationId: string, payload: unknown): CreationPublishDetails | null {
  const generations = isRecord(payload) && Array.isArray(payload.generations) ? payload.generations : [];
  const generation = generations.find((item): item is Record<string, unknown> => isRecord(item) && item.id === generationId);
  if (!generation) return null;
  return {
    title: typeof generation.title === 'string' ? generation.title : '',
    // Read as the composer reads it, which "More options" opens on the same creation.
    paywallPrefill: readGenerationPaywallPrefill(generation.paywallPrefill),
    creation: readCreationTitleSource(generation),
    inputs: recipeCopyableInputs(Array.isArray(generation.input_media)
      ? (generation.input_media as unknown[]).filter((item): item is CreationInputLike => isRecord(item))
      : []),
    remixRecipeMode: isRemixRecipeMode(generation.remix_recipe_mode) ? generation.remix_recipe_mode : null,
  };
}

/** How long a read waits before the publish goes on without it. */
const CREATION_PUBLISH_DETAILS_TIMEOUT_MS = 5_000;

/**
 * Reads the details, or null when they cannot be read (no session, an error, a slow answer):
 * then the creation still publishes, only without the prefill.
 */
export async function fetchCreationPublishDetails(
  generationId: string,
  accessToken: string | null | undefined,
  signal?: AbortSignal,
): Promise<CreationPublishDetails | null> {
  if (!accessToken) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort);
  const timeout = setTimeout(abort, CREATION_PUBLISH_DETAILS_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/generations?${new URLSearchParams({ id: generationId, includeArchived: 'true', limit: '1' })}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return readCreationPublishDetails(generationId, await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
