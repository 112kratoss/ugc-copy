/**
 * The wording of the row that hides a creator. One answer for a feed card's
 * menu, the reel's, their fallback sheets and the web's menu
 * (`src/lib/hide-creator-label.ts`). The two rules share no module; each
 * suite holds its own to `contracts/hide-creator-label-v1.json`.
 *
 * It names the creator the way a card does: by handle, or by the display name
 * of an account that has none. Until 2026-10-09 the same row read "Hide fluffy"
 * on Home, "Hide @fluffy" on Explore, "Hide this creator" in the reel and
 * "Hide Fluffy" on the web.
 */
export function hideCreatorLabel(creator: { username?: string | null; name?: string | null }): string {
  const username = creator.username?.trim().replace(/^@+/, '');
  if (username) return `Hide @${username}`;
  const name = creator.name?.trim();
  return name ? `Hide ${name}` : 'Hide this creator';
}

/** What a post shows for a creator it knows neither the handle nor the name of. */
export const UNKNOWN_CREATOR_LABEL = '@creator';

/**
 * The same row for a post that carries its creator as the label a card shows:
 * "@handle", a display name, or the placeholder (the reel's items do).
 */
export function hideCreatorLabelFromCardLabel(label: string): string {
  const clean = label.trim();
  if (!clean || clean === UNKNOWN_CREATOR_LABEL) return hideCreatorLabel({});
  return clean.startsWith('@') ? hideCreatorLabel({ username: clean }) : hideCreatorLabel({ name: clean });
}
