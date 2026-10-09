/**
 * The wording of the row that hides a creator. One answer for the web's card
 * and reel menus and for the app's (`ugc-mobile/lib/hide-creator-label.ts`,
 * held to this one by `src/__tests__/hide-creator-label-parity.test.ts`).
 *
 * It names the creator the way a card does: by handle, or by the display name
 * of an account that has none. Until 2026-10-09 the web's row carried the
 * display name ("Hide Fluffy") under a card that showed "@fluffy".
 */
export function hideCreatorLabel(creator: { username?: string | null; name?: string | null }): string {
    const username = creator.username?.trim().replace(/^@+/, '');
    if (username) return `Hide @${username}`;
    const name = creator.name?.trim();
    return name ? `Hide ${name}` : 'Hide this creator';
}
