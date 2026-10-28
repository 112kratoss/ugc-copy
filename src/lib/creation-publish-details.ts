import { readCreationTitleSource, type CreationTitleSource } from '@/lib/creation-post-title';
import type { GenerationPaywallPrefill } from '@/lib/generation-paywall';

/**
 * What publishing a creation starts from, read from the owner's library entry as Studio reads
 * it: its own title, its recipe's prefill, and what a title is suggested from when it has none.
 * The three creators read it in three copies before; published without it, a post went out
 * as the media alone while the same creation from Studio offered its recipe.
 */
export type CreationPublishDetails = {
  generationId: string;
  title: string;
  paywallPrefill: GenerationPaywallPrefill | null;
  creation: CreationTitleSource | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The details of `generationId` in an `/api/generations` answer, or null where it is not there. */
export function readCreationPublishDetails(generationId: string, payload: unknown): CreationPublishDetails | null {
  const generations = isRecord(payload) && Array.isArray(payload.generations) ? payload.generations : [];
  const generation = generations.find((item): item is Record<string, unknown> => isRecord(item) && item.id === generationId);
  if (!generation) return null;
  const prefill = generation.paywallPrefill;
  return {
    generationId,
    title: typeof generation.title === 'string' ? generation.title : '',
    paywallPrefill: isRecord(prefill) && Array.isArray(prefill.resourceKinds) && typeof prefill.allowRemix === 'boolean'
      ? prefill as unknown as GenerationPaywallPrefill
      : null,
    creation: readCreationTitleSource(generation),
  };
}

/** How long a read waits before the publish goes on without it. */
export const CREATION_PUBLISH_DETAILS_TIMEOUT_MS = 5_000;

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
