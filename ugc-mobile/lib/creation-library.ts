import { getGenerationKind } from './generation-media';
import type { GenerationListItem } from './types';

/**
 * Why a creation can or cannot be drawn.
 *
 * Every surface that reaches a creation with nothing to play has to say which
 * of these it is. Dropping such an item instead is how a tap on the grid's
 * "File no longer available" tile opened an unrelated creation: the card feed
 * filtered the tapped item away and fell back to the first one (2026-09-16
 * Creations reliability audit, C1).
 */
export type CreationAvailability =
  | 'available'
  | 'source-unavailable'
  | 'rendering'
  | 'failed'
  | 'no-output';

type CreationFields = Pick<
  GenerationListItem,
  'status' | 'archived_at' | 'source_unavailable_at' | 'output_url' | 'output_urls' | 'media' | 'category' | 'creationMode'
>;

const IN_FLIGHT_STATUSES = new Set(['pending', 'waiting', 'processing']);

export function getCreationAvailability(item: CreationFields): CreationAvailability {
  if (item.status === 'succeeded') {
    // The owner route withholds every address for a source that is gone and
    // keeps `source_unavailable_at` as the signal, so the flag outranks the
    // missing output rather than reading as a run that produced nothing.
    if (item.source_unavailable_at) return 'source-unavailable';
    if (getGenerationKind(item) === 'text') return 'available';
    return item.media?.url || item.output_urls?.length || item.output_url ? 'available' : 'no-output';
  }
  if (IN_FLIGHT_STATUSES.has(item.status)) return 'rendering';
  return 'failed';
}

/**
 * The one rule for which creations make up the reader's library.
 *
 * The Creations grid, the card feed a tile opens and the reel behind a card all
 * apply it, so the three cannot disagree about what a tap opened or what sits
 * next to it. The grid used to ask for unarchived runs and keep the ones with
 * something to draw, while the viewers asked for archived runs too and kept
 * anything with media: an archived creation could turn up in a feed its grid
 * never showed, and an unavailable one vanished from it (audit C1, C3).
 *
 * In: finished, unarchived creations with a file, and finished creations whose
 * only file is gone, drawn as that state because hiding them reads as deletion.
 * Out: archived creations, which have their own restore path, and unfinished or
 * failed runs, whose notifications deep-link straight to them.
 */
export function isCreationLibraryMember(item: CreationFields): boolean {
  if (item.archived_at) return false;
  const availability = getCreationAvailability(item);
  return availability === 'available' || availability === 'source-unavailable';
}

/**
 * Library members in their original order, plus the one item a route named on
 * purpose — a failed run's notification, an archived creation opened from its
 * own screen — so that item can explain itself instead of being replaced.
 */
export function selectCreationLibraryItems<T extends CreationFields & { id: string }>(
  items: T[],
  selectedId?: string | null
): T[] {
  return items.filter((item) => (Boolean(selectedId) && item.id === selectedId) || isCreationLibraryMember(item));
}
