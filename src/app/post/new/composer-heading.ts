/**
 * What the post composer's heading says, which its tab says too (`/post/new` and
 * `/post/[id]/edit` name their tab by it): one place, so the two never drift.
 * A new post is "Create post"; an edit is "Update post", unless it was opened to add
 * a recipe (`recipe=add`) or, from Studio, to price the post's recipe
 * (`from=creations&focus=price`).
 */
export function composerHeading({ editing, recipe = null, from = null, focus = null }: {
  editing: boolean;
  recipe?: string | null;
  from?: string | null;
  focus?: string | null;
}): string {
  if (!editing) return 'Create post';
  if (recipe === 'add') return 'Add a recipe to this post';
  if (from === 'creations' && focus === 'price') return 'Manage the recipe behind this post';
  return 'Update post';
}
