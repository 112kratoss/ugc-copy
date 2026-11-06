import { recipeCopyCreationId } from '@/lib/recipe-copy-access';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A creation's two marks, as `recipe_copies_withheld` reads them. */
export type CreationMarks = { id: string; archived_at?: string | null; moderation_removed_at?: string | null };

/**
 * What `recipe_copies_withheld` (20261105150428) answers over these creations, for a test's stand-in
 * client: the copies among `paths` whose creation an operator removed or its creator archived, as
 * given. A copy a remix's recipe passed on is also held to where it came from; the database proves
 * that (recipe_copies_pass_on.test.sql), so a stand-in names those in `passedOnWithheld`.
 */
export function recipeCopiesWithheldOver(
  creations: readonly CreationMarks[],
  passedOnWithheld: readonly string[] = [],
): (paths: readonly string[]) => string[] {
  return (paths) => paths.filter((path) => {
    if (passedOnWithheld.includes(path)) return true;
    // As the SQL: a copy spelled with a percent sign is withheld, and a creation is looked up only by
    // a segment that reads as a uuid (#708's max review: the stand-in withheld 'gen-1' ids the
    // database never would).
    if (path.includes('/generation-references/') && path.includes('%')) return true;
    const creationId = recipeCopyCreationId(path);
    if (!creationId || !UUID_PATTERN.test(creationId)) return false;
    const creation = creations.find((candidate) => candidate.id === creationId);
    return Boolean(creation && (creation.archived_at || creation.moderation_removed_at));
  });
}
