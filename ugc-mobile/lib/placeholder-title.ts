/**
 * The names a post arrives with when nobody named it: the feed's "Untitled
 * Creation" and "Untitled Note" (src/lib/showcase-feed.ts) and the app's own
 * "Community post" (lib/showcase-display.ts). The web's feed mirrors this rule
 * on purpose (`PLACEHOLDER_TITLE` in src/lib/post-feed-presentation.ts): change
 * one, change the other.
 */
const PLACEHOLDER_TITLE = /^(untitled(?: creation| note)?|community post)$/i;

export function isPlaceholderTitle(value: string) {
  return PLACEHOLDER_TITLE.test(value.trim());
}

/** What kind of creation a post is, for naming one that has no words of its own. */
export type PostNameKind = 'motion' | 'video' | 'text' | 'image';

const KIND_NAMES: Record<PostNameKind, string> = {
  motion: 'Motion creation',
  video: 'Video creation',
  text: 'Creator note',
  image: 'Image creation',
};

/**
 * What a post is called wherever it is named (Home's cards, the showcase grid,
 * a remix's source row): the first of its words, title first, that is no
 * placeholder, or the kind of creation it is. Each surface passes its own words
 * in its own order.
 */
export function postName(words: ReadonlyArray<string | null | undefined>, kind: PostNameKind) {
  for (const candidate of words) {
    const clean = candidate?.trim();
    if (clean && !isPlaceholderTitle(clean)) return clean;
  }
  return KIND_NAMES[kind];
}
