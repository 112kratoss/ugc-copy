import { readCreationTitleSource, type CreationTitleSource } from '@/lib/creation-post-title';
import type { GenerationPaywallPrefill } from '@/lib/generation-paywall';
import { isPostResourceKind } from '@/lib/post-resource-bundles';

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
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a generations answer's `paywallPrefill` is one: every kind a recipe's, the texts text
 * or none, the remix switch a boolean. The composer and the creators' form take it alike, so a
 * recipe one offers the other never drops. (Here, not in `generation-paywall.ts`, whose imports
 * reach the server's catalog: both callers are browser code.)
 */
export function isGenerationPaywallPrefill(value: unknown): value is GenerationPaywallPrefill {
  if (!isRecord(value)) {
    return false;
  }
  const typed = value as Partial<GenerationPaywallPrefill>;
  return Array.isArray(typed.resourceKinds)
    && typed.resourceKinds.every((kind) => isPostResourceKind(kind))
    && (typeof typed.promptText === 'string' || typed.promptText === null || typed.promptText === undefined)
    && (typeof typed.notesMarkdown === 'string' || typed.notesMarkdown === null || typed.notesMarkdown === undefined)
    && typeof typed.allowRemix === 'boolean';
}

/** The details of `generationId` in an `/api/generations` answer, or null where it is not there. */
function readCreationPublishDetails(generationId: string, payload: unknown): CreationPublishDetails | null {
  const generations = isRecord(payload) && Array.isArray(payload.generations) ? payload.generations : [];
  const generation = generations.find((item): item is Record<string, unknown> => isRecord(item) && item.id === generationId);
  if (!generation) return null;
  return {
    title: typeof generation.title === 'string' ? generation.title : '',
    // Checked as the composer checks it, which "More options" opens on the same creation.
    paywallPrefill: isGenerationPaywallPrefill(generation.paywallPrefill) ? generation.paywallPrefill : null,
    creation: readCreationTitleSource(generation),
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
