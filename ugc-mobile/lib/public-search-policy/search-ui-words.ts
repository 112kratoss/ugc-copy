/**
 * The words of the search screens' new parts (2026-11-15): related searches,
 * Follow on a creator row, and a catalog model nobody has posted with yet. Both
 * search clients draw them from here, the app's screen and the web's page, by
 * relative import.
 * The starter's headings, the typeahead's and the rest of search's words are
 * already shared (`public-search-policy.ts`, `search-starter.ts`,
 * `search-typeahead.ts`).
 *
 * Metro, Next.js and Vitest all compile this file, so it stays free of React
 * Native, Expo and Node imports (see this folder's tsconfig.json).
 */
import type { SearchCatalogModelKind } from './public-search-policy';

/** The heading over a Top or Posts answer's related searches. Each chip is named "Search for {text}". */
export const SEARCH_RELATED_SEARCHES_HEADING = 'Related searches';

/** A creator row's button, before and once the viewer follows them: the creator page's own words. */
export const SEARCH_FOLLOW_LABEL = 'Follow';
export const SEARCH_FOLLOWING_LABEL = 'Following';

/** Said when a follow or an unfollow is refused, and the button is put back: the creator page's sentence. */
export const SEARCH_FOLLOW_FAILED = 'Could not update follow. Your previous state was restored.';

const MODEL_KIND_WORDS: Readonly<Record<SearchCatalogModelKind, string>> = Object.freeze({
  image: 'Image',
  video: 'Video',
  motion: 'Motion',
});

/**
 * A catalog model's second line where nobody has posted with it: "Video model ·
 * Generate with it". Its row opens the creator with the model chosen, never an
 * empty Posts page, so it never says "0 posts".
 */
export function searchCatalogModelLine(kind: SearchCatalogModelKind): string {
  return `${MODEL_KIND_WORDS[kind]} model · Generate with it`;
}

/** That row's name to a screen reader: "Seedance 1.5 Pro, video model, no posts yet. Open the video creator with it". */
export function searchCatalogModelActionLabel(label: string, kind: SearchCatalogModelKind): string {
  const kindWord = MODEL_KIND_WORDS[kind].toLowerCase();
  return `${label}, ${kindWord} model, no posts yet. Open the ${kindWord} creator with it`;
}

/** What a creator is called on their Follow button: the display name, or `@handle` when the name is only the handle. */
function followName(creator: { displayName: string; username: string }): string {
  const name = creator.displayName.trim();
  return name.replace(/^@+/, '').toLowerCase() === creator.username.toLowerCase() ? `@${creator.username}` : name;
}

/** A Follow button's name to a screen reader: "Follow Luna Studio", once followed "Following Luna Studio". */
export function searchFollowButtonLabel(creator: { displayName: string; username: string }, following: boolean): string {
  return `${following ? SEARCH_FOLLOWING_LABEL : SEARCH_FOLLOW_LABEL} ${followName(creator)}`;
}
