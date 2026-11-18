import { APP_SHELL_AUTH_HINT_SIGNED_IN, APP_SHELL_AUTH_USER_ATTRIBUTE } from '@/lib/app-shell-account-restore';

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
 *   recipe. A visitor's alone before the first paint: a signed-in reader is not offered it either.
 * - `data-post-recipe-checking`: a signed-in reader's recipe while their own read of it is out,
 *   neither offered nor called theirs ("Recipe · View" in the rail, "Checking…" on the panel's badge
 *   and "Checking your recipes…" under it), shown to a browser holding a session (`data-auth-hint`)
 *   that is not the creator's, which also gets the open Remix inert in place of one the recipe locks
 *   (`data-post-remix-checking`; owner, 2026-11-18: "Yes, hold it": a buyer was offered their own
 *   recipe until their read landed).
 */
export function ownerFirstPaintRules(creatorId: string): string {
  const creatorsBrowser = `html[${APP_SHELL_AUTH_USER_ATTRIBUTE}="${creatorId}"]`;
  const readersBrowser = `html[data-auth-hint="${APP_SHELL_AUTH_HINT_SIGNED_IN}"]:not([${APP_SHELL_AUTH_USER_ATTRIBUTE}="${creatorId}"])`;
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
    `[data-post-recipe-checking="${creatorId}"]{display:none}`,
    `${readersBrowser} span[data-post-recipe-checking="${creatorId}"]{display:inline}`,
    `${readersBrowser} div[data-post-recipe-checking="${creatorId}"]{display:block}`,
    `${readersBrowser} [data-post-recipe-pitch="${creatorId}"]{display:none}`,
    `${readersBrowser} [data-post-remix-checking="${creatorId}"]{display:inline-flex}`,
  ].join('');
}
