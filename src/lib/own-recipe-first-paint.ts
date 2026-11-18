import { APP_SHELL_AUTH_USER_ATTRIBUTE } from '@/lib/app-shell-account-restore';

/**
 * A page drawn once for every viewer, where no cookie can be read, cannot know whose a recipe tile is:
 * its chip reads "Your recipe" to the recipe's creator and the price or "Free recipe" to everyone else
 * (a creator's own page; the Marketplace, whose tiles are many sellers'). The server's HTML draws both,
 * and these rules, drawn ahead of the tiles, show the creator theirs and everyone else theirs before the
 * first paint: the root element names the account the session cookie holds (`data-auth-user`,
 * app-shell-account-restore.ts). The page's script then draws one, as it knows who is looking
 * (`useCreatorOwnership`, `useCreatorOwnershipResolver`), as the post page does
 * (`ownerFirstPaintRules`). `creatorId` is one a style rule can name as it stands
 * (`canStyleRuleNameAuthUser`).
 *
 * - `data-creator-recipe-owner`: the creator's words for their own recipe, "Your recipe".
 * - `data-creator-recipe-pitch`: everyone else's, the price or "Free recipe".
 */
export function ownRecipeFirstPaintRules(creatorId: string): string {
  const creatorsBrowser = `html[${APP_SHELL_AUTH_USER_ATTRIBUTE}="${creatorId}"]`;
  return [
    `[data-creator-recipe-owner="${creatorId}"]{display:none}`,
    `${creatorsBrowser} [data-creator-recipe-owner="${creatorId}"]{display:inline}`,
    `${creatorsBrowser} [data-creator-recipe-pitch="${creatorId}"]{display:none}`,
  ].join('');
}
