/**
 * What a text post's tile says, wherever a tile stands in for a picture: the
 * search results, a creator's grid, the profile grid. Each of those used to
 * draw the post its own way (an empty frame with a magnifier, the body in bold
 * under a badge, the body run under the state mark), so one post read as five
 * different things. The words are decided here and drawn by `TextPostPlate`.
 */
export interface TextPostPlateSource {
  title?: string | null;
  body?: string | null;
  /** A text creation carries its writing as the prompt. */
  prompt?: string | null;
}

export interface TextPostPlateContent {
  /** The post's name, in the stronger weight; null when the tile has only writing to show. */
  title: string | null;
  /** The writing under it; null when there is none, or it only repeats the title. */
  body: string | null;
}

export const TEXT_POST_PLATE_FALLBACK = 'Community post';

/** A tile clamps to a few lines, so a blank line would spend one of them on nothing. */
function foldWhitespace(value: string | null | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

export function buildTextPostPlate(source: TextPostPlateSource): TextPostPlateContent {
  const title = foldWhitespace(source.title);
  const writing = foldWhitespace(source.body) || foldWhitespace(source.prompt);
  // A post titled from its own first words would say them twice.
  const repeatsTitle = Boolean(title) && writing.toLowerCase() === title.toLowerCase();
  const body = writing && !repeatsTitle ? writing : null;
  if (!title && !body) return { title: TEXT_POST_PLATE_FALLBACK, body: null };
  return { title: title || null, body };
}

/**
 * For a tile whose caption already names the post under the frame (search
 * results, a creator's grid): the frame holds the writing alone, and the title
 * only when there is no writing to show.
 */
export function textPostPlateUnderCaption(content: TextPostPlateContent): TextPostPlateContent {
  return content.body ? { title: null, body: content.body } : content;
}

/**
 * How many lines of writing fit under a one-line title in a plate of this
 * height, so the last line is never cut through or run under a corner mark.
 */
export function textPostPlateBodyLines({
  height,
  paddingTop,
  paddingBottom,
  titleHeight,
  lineHeight,
}: {
  height: number;
  paddingTop: number;
  paddingBottom: number;
  /** The title's line and the gap under it; 0 when the plate shows no title. */
  titleHeight: number;
  lineHeight: number;
}) {
  const room = height - paddingTop - paddingBottom - titleHeight;
  return Math.max(1, Math.floor(room / lineHeight));
}
