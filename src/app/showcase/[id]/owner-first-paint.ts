import { APP_SHELL_AUTH_USER_ATTRIBUTE } from '@/lib/app-shell-account-restore';

/**
 * The post page's HTML is drawn once for every viewer, where no cookie can be read. Where the
 * post's creator gets something other than everyone else, the server's HTML draws both, and these
 * rules, drawn ahead of them, show the creator theirs and everyone else the others before the
 * first paint: the root element names the account the session cookie holds (`data-auth-user`,
 * app-shell-account-restore.ts). The page's script then draws one, as it knows who is looking
 * (`ownership` in useShowcasePostViewer). `creatorId` is one a style rule can name as it stands
 * (`canStyleRuleNameAuthUser`).
 *
 * - `data-post-owner-tools`: their Owner tools (ShowcaseDetailActions).
 * - `data-post-report-rows`: everyone else's "Report post or recipe" (ReportPostButton).
 * - `data-post-recipe-owner`: their words for their own recipe, "Your recipe · View" in the rail
 *   and "Your recipe" on the recipe panel's badge (PostResourceBundlePanel).
 * - `data-post-recipe-held`: their own recipe's body in the recipe panel, held ("Opening your
 *   recipe…") until their own read of it brings the recipe.
 * - `data-post-remix-owner`: the open Remix of their own creation (ShowcaseDetailEngagementRow).
 * - `data-post-recipe-pitch`: everyone else's pitch of the recipe, which the creator never gets:
 *   the rail's price or "Free recipe", the panel's (its badge, what an unlock gives and the ways to
 *   get it), the bar along the bottom edge and the room kept for it, and Remix locked behind the
 *   recipe.
 */
export function ownerFirstPaintRules(creatorId: string): string {
  const creatorsBrowser = `html[${APP_SHELL_AUTH_USER_ATTRIBUTE}="${creatorId}"]`;
  return [
    `[data-post-owner-tools="${creatorId}"]{display:none}`,
    `${creatorsBrowser} [data-post-owner-tools="${creatorId}"]{display:block}`,
    `${creatorsBrowser} [data-post-report-rows="${creatorId}"]{display:none}`,
    `[data-post-recipe-owner="${creatorId}"]{display:none}`,
    `${creatorsBrowser} [data-post-recipe-owner="${creatorId}"]{display:inline}`,
    `[data-post-recipe-held="${creatorId}"]{display:none}`,
    `${creatorsBrowser} [data-post-recipe-held="${creatorId}"]{display:block}`,
    `[data-post-remix-owner="${creatorId}"]{display:none}`,
    `${creatorsBrowser} [data-post-remix-owner="${creatorId}"]{display:inline-flex}`,
    `${creatorsBrowser} [data-post-recipe-pitch="${creatorId}"]{display:none}`,
  ].join('');
}
