import { recipeCopyCreationId } from '@/lib/recipe-copy-access';

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
    const creationId = recipeCopyCreationId(path);
    const creation = creationId ? creations.find((candidate) => candidate.id === creationId) : undefined;
    return Boolean(creation && (creation.archived_at || creation.moderation_removed_at));
  });
}
