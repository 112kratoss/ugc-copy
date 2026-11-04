import { parseGenerationReferenceCopyPath } from '@/lib/recipe-file-paths';

/**
 * Which of a creation's saved-input copies a save must make, when the composer
 * sends the recipe's items back (owner, 2026-11-04 review of the recipe copy sweep).
 *
 * A composer keeps the items the server put into a recipe in its draft and sends
 * them again on every save (the app's composer adopts them). Taking a sent copy
 * for one the recipe holds meant no copy was made for it, so a recipe saved again
 * from a draft after its copies were gone (the recipe turned off, which deletes it
 * and its revisions, and the recipe-copy-sweep job removing the copies nothing
 * named any more) named files that were not there. A copy is held only where the
 * recipe as stored names it; a sent one is copied again, and a copy already at its
 * path stands (the copy answers "present").
 */

type ItemLike = { id?: string | null; storagePath?: string | null };

function isCopyOfCreation(item: ItemLike, ownerUserId: string, generationId: string): boolean {
  const copy = item.storagePath ? parseGenerationReferenceCopyPath(item.storagePath) : null;
  return Boolean(copy && copy.ownerUserId === ownerUserId && copy.generationId === generationId);
}

/**
 * The items a plan of the copies takes as held: the recipe's items as stored, and
 * the sent items that are not this creation's copies (a file of the creator's own
 * kept in an input's place). A sent copy the recipe does not hold is not held.
 */
export function heldItemsForReferenceCopies<T extends ItemLike>(params: {
  sentItems: readonly T[];
  storedItems?: readonly T[] | null;
  ownerUserId: string;
  generationId: string;
}): T[] {
  const stored = params.storedItems ?? [];
  const storedPaths = new Set(stored.flatMap((item) => (item.storagePath ? [item.storagePath] : [])));
  return [
    ...params.sentItems.filter((item) => (
      !isCopyOfCreation(item, params.ownerUserId, params.generationId)
      || storedPaths.has(item.storagePath as string)
    )),
    ...stored,
  ];
}

/**
 * The copies to make: those of the references the save adds, and those of the
 * references whose copy the composer sent and the recipe does not hold yet. Only a
 * reference planned with a source has anything to copy.
 */
export function referenceCopiesToMake<R extends { item: ItemLike; source: unknown }>(params: {
  references: readonly R[];
  added: readonly R[];
  sentItems: readonly ItemLike[];
}): R[] {
  const added = new Set(params.added);
  const sentPaths = new Set(params.sentItems.flatMap((item) => (item.storagePath ? [item.storagePath] : [])));
  return params.references.filter((reference) => (
    Boolean(reference.source)
    && (added.has(reference) || (Boolean(reference.item.storagePath) && sentPaths.has(reference.item.storagePath as string)))
  ));
}
